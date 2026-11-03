import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { dateKey, newId, resolvePayment, type OrderItem } from '../shared/common';
import { fail } from '../shared/errors';
import { comparePin, MAX_PIN_ATTEMPTS, PIN_LOCK_MS } from '../shared/infra';
import type { CreateOrderDto, OrderView } from '../shared/order';
import type { SyncMenu } from '../shared/sync.types';
import { OFFLINE_CONFIG, type OfflineConfig } from './offline-config';
import { isMenu, type HandoverDto } from './offline.dto';
import { OfflineOrder } from './offline.entities';
import { OfflineStore, type StoredCounter, type StoredHandover, type StoredSnapshot } from './offline-store';
import { OfflineSyncService, type SyncStatus } from './offline-sync.service';

/** Offline kassaga kirgan kassir. */
export interface OfflineCashier {
  id: string;
  name: string;
  surname: string;
}

/** Sahifa bir marta oladi: filial, kassirlar (PIN'siz), menyu, online kassa manzili ("Online rejimga qaytish"). */
export interface OfflineData {
  branch: { id: string; name: string };
  /** PIN bilan kira oladiganlar (markazdan olingan ro'yxat) */
  cashiers: OfflineCashier[];
  menu: SyncMenu | null;
  /**
   * online kassa ochiladigan sayt: online kassadan o'tilgan bo'lsa — o'sha sahifaniki, aks holda markaz manzili va
   * xodimlar tizimi yo'li (nusxadagi `uiBase`, `https://newyork24.uz/shorva/`)
   */
  kassaUrl: string;
}

/** Sahifa har bir necha soniyada so'raydi. */
export interface OfflineState {
  /** menyu bor (markazdan nusxa olingan yoki online kassa uzatgan) — savdo qilsa bo'ladi */
  ready: boolean;
  /** `confirmed: false` — savdodan oldin kassir oxirgi raqamni kiritadi; `last` — ma'lum bo'lgan eng kattasi */
  number: { confirmed: boolean; last: number };
  sync: SyncStatus;
}

/** Kirish sessiyasi shuncha davom etadi (smena uzunligi). */
const SESSION_MS = 16 * 3_600_000;
/** Offline kassa shuncha vaqt ishlatilmasa — raqam yana so'raladi (online kassa shu orada raqam bergan bo'lishi mumkin). */
export const NUMBER_IDLE_MS = 30 * 60_000;
/** Ishlatilganini yozish oralig'i — har so'rovda bazaga yozilmasin. */
const ACTIVE_WRITE_MS = 60_000;

const STATUS_FLOW: Record<'ready' | 'cancel', OfflineOrder['status'][]> = {
  ready: ['preparing'],
  cancel: ['preparing', 'ready'],
};

/**
 * Offline kassa: kassir kirishi (online kassadan o'tganda — PIN'siz, aks holda markazdan olingan PIN xeshi bilan),
 * bugungi raqam hisoblagichi, buyurtma (narx — menyudan, to'lov qoidalari markazdagidek), "Tayyor" va bekor qilish.
 * Buyurtmalar markazga [OfflineSyncService] orqali ketadi.
 */
@Injectable()
export class OfflineKassaService {
  private readonly attempts = new Map<string, { fails: number; lockedUntil: number }>();
  private secret: string | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OFFLINE_CONFIG) private readonly config: OfflineConfig,
    private readonly store: OfflineStore,
    private readonly sync: OfflineSyncService,
  ) {}

  // ───────────────────────── Ma'lumot va holat ─────────────────────────

  async data(): Promise<OfflineData> {
    const [snapshot, handover] = await Promise.all([this.store.get('snapshot'), this.store.get('handover')]);
    return {
      branch: { id: this.config.branchId, name: snapshot?.branch.name || handover?.branchName || '' },
      cashiers: (snapshot?.cashiers ?? []).map(({ id, name, surname }) => ({ id, name, surname })),
      menu: this.menuOf(snapshot, handover),
      kassaUrl: handover?.returnUrl || `${this.config.centralUrl}${safeUiBase(snapshot?.uiBase)}`,
    };
  }

  async state(now = new Date()): Promise<OfflineState> {
    this.sync.pageSeen();
    const [snapshot, handover, counter, central, sync] = await Promise.all([
      this.store.get('snapshot'),
      this.store.get('handover'),
      this.store.get('counter'),
      this.store.get('centralCounter'),
      this.sync.currentStatus(),
    ]);
    const confirmed = isConfirmed(counter, now);
    // sahifa ochiq — raqam "ishlatilmoqda" (kassir buyurtma bermasa ham)
    if (confirmed && counter && now.getTime() - Date.parse(counter.activeAt) > ACTIVE_WRITE_MS) {
      await this.store.set('counter', { ...counter, activeAt: now.toISOString() });
    }
    const today = dateKey(now);
    const last = Math.max(counter?.date === today ? counter.value : 0, central?.date === today ? central.value : 0);
    return { ready: this.menuOf(snapshot, handover) !== null, number: { confirmed, last }, sync };
  }

  // ───────────────────────── Kirish ─────────────────────────

  /**
   * Online kassa offline'ga o'tdi: ishlayotgan kassir PIN'siz davom etadi, raqam online kassa ko'rgan oxirgisidan
   * davom etadi (offline yoki markazda kattaroq ma'lum bo'lsa — o'shandan).
   */
  async handover(dto: HandoverDto, now = new Date()): Promise<{ token: string; cashier: OfflineCashier }> {
    if (dto.branchId !== this.config.branchId) fail('forbidden', `branch ${dto.branchId}`);
    const cashier = { id: dto.cashier.id, name: dto.cashier.name, surname: dto.cashier.surname };
    const stored: StoredHandover = {
      cashier,
      branchName: dto.branchName ?? '',
      returnUrl: dto.returnUrl ?? null,
      menu: isMenu(dto.menu) ? dto.menu : null,
      at: now.toISOString(),
    };
    await this.dataSource.transaction(async (em) => {
      await this.store.set('handover', stored, em);
      await this.confirmNumber(em, dto.lastNumber, now);
    });
    return { token: await this.sign(cashier.id, now), cashier };
  }

  /** PIN bilan kirish (markazdan olingan xesh bilan); 5 marta xato — 5 daqiqa blok. */
  async login(cashierId: string, pin: string, now = new Date()): Promise<{ token: string; cashier: OfflineCashier }> {
    const entry = this.attempts.get(cashierId);
    if (entry && entry.lockedUntil > now.getTime()) fail('too_many_attempts');
    const snapshot = await this.store.get('snapshot');
    const cashier = snapshot?.cashiers.find((c) => c.id === cashierId) ?? fail('not_found', `cashier ${cashierId}`);
    if (!(await comparePin(pin, cashier.pinHash))) {
      // blok muddati o'tgan bo'lsa — hisob boshidan
      const fails = (entry && entry.lockedUntil === 0 ? entry.fails : 0) + 1;
      this.attempts.set(cashierId, { fails, lockedUntil: fails >= MAX_PIN_ATTEMPTS ? now.getTime() + PIN_LOCK_MS : 0 });
      fail(fails >= MAX_PIN_ATTEMPTS ? 'too_many_attempts' : 'wrong_pin');
    }
    this.attempts.delete(cashierId);
    const { id, name, surname } = cashier;
    return { token: await this.sign(id, now), cashier: { id, name, surname } };
  }

  /** Token → kassir (imzo, muddat va kassir hali ro'yxatda); bo'lmasa `null`. */
  async verify(token: string, now = new Date()): Promise<OfflineCashier | null> {
    const [cashierId, expires, signature] = token.split('.');
    if (!cashierId || !expires || !signature) return null;
    const expected = Buffer.from(await this.signature(`${cashierId}.${expires}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (Number(expires) < now.getTime()) return null;
    const [snapshot, handover] = await Promise.all([this.store.get('snapshot'), this.store.get('handover')]);
    const cashier = this.cashiers(snapshot, handover).find((c) => c.id === cashierId);
    return cashier ? { id: cashier.id, name: cashier.name, surname: cashier.surname } : null;
  }

  /** Kassir oxirgi chekdagi raqamni kiritdi (online kassadan o'tilmagan). */
  async setNumber(last: number, now = new Date()): Promise<void> {
    await this.dataSource.transaction((em) => this.confirmNumber(em, last, now));
  }

  /** "Online rejimga qaytish": endi raqamni online kassa beradi — keyingi offline'da yana aniqlanadi. */
  async leave(): Promise<void> {
    const counter = await this.store.get('counter');
    if (counter?.confirmed) await this.store.set('counter', { ...counter, confirmed: false });
  }

  // ───────────────────────── Buyurtmalar ─────────────────────────

  /** Markazga hali yetib bormagan buyurtmalar — yangisi birinchi. */
  async orders(): Promise<OrderView[]> {
    const orders = await this.dataSource.manager.find(OfflineOrder, { order: { createdAt: 'DESC' } });
    return orders.map((order) => this.view(order));
  }

  async create(cashier: OfflineCashier, dto: CreateOrderDto, now = new Date()): Promise<OrderView> {
    if (dto.items.length === 0) fail('empty_order');
    if (!dto.payment) fail('invalid_amount');
    const [snapshot, handover] = await Promise.all([this.store.get('snapshot'), this.store.get('handover')]);
    const menu = this.menuOf(snapshot, handover) ?? fail('not_found', 'menu');
    const products = new Map(menu.products.map((product) => [product.id, product]));
    const items: OrderItem[] = dto.items.map((line) => {
      if (!Number.isInteger(line.qty) || line.qty < 1) fail('invalid_qty', line.productId);
      const product = products.get(line.productId);
      if (!product || product.price === null) fail('product_unavailable', line.productId);
      if (product.dineInOnly && dto.type !== 'dine_in') fail('dine_in_only', product.id);
      return { productId: product.id, name: product.name, price: product.price, qty: line.qty };
    });
    const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const paid = resolvePayment(dto.payment, dto.split, total, () => fail('invalid_amount'));

    const order = await this.dataSource.transaction(async (em) => {
      // to'lov paytida javob kelmay qolgan va qayta yuborilgan — ikkinchi marta yozilmaydi
      const existing = dto.id ? await em.findOneBy(OfflineOrder, { id: dto.id }) : null;
      if (existing) return existing;
      const created: OfflineOrder = {
        id: dto.id ?? newId('ord'),
        number: await this.nextNumber(em, now),
        type: dto.type,
        items,
        note: dto.note?.trim() ?? '',
        total,
        payment: paid.payment,
        split: paid.split,
        status: 'preparing',
        cashierId: cashier.id,
        createdAt: now,
        readyAt: null,
        cancelledAt: null,
        cancelledBy: null,
        rev: 0,
        rejectedCode: null,
      };
      await em.insert(OfflineOrder, created);
      return created;
    });
    return this.view(order);
  }

  /** "Tayyor" — offline'da oshpaz yordamchisi o'rniga kassir bosadi. */
  markReady(id: string, now = new Date()): Promise<OrderView> {
    return this.change(id, 'ready', () => ({ status: 'ready', readyAt: now }));
  }

  cancel(id: string, cashier: OfflineCashier, now = new Date()): Promise<OrderView> {
    return this.change(id, 'cancel', () => ({ status: 'cancelled', cancelledAt: now, cancelledBy: cashier.id }));
  }

  // ───────────────────────── Yordamchilar ─────────────────────────

  private async change(
    id: string,
    action: keyof typeof STATUS_FLOW,
    patch: () => Partial<OfflineOrder>,
  ): Promise<OrderView> {
    const order = await this.dataSource.transaction(async (em) => {
      // markazga yetib borgani bu yerda yo'q — u endi online kassada
      const order =
        (await em.findOne(OfflineOrder, { where: { id }, lock: { mode: 'pessimistic_write' } })) ??
        fail('not_found', `order ${id}`);
      if (!STATUS_FLOW[action].includes(order.status)) fail('invalid_status', `${order.status} → ${action}`);
      const changes = { ...patch(), rev: order.rev + 1 };
      await em.update(OfflineOrder, { id }, changes);
      return Object.assign(order, changes);
    });
    return this.view(order);
  }

  /** Bugungi navbatdagi raqam. Raqam aniq bo'lmasa (yangi kun, uzoq ishlatilmagan) — `number_required`. */
  private async nextNumber(em: EntityManager, now: Date): Promise<number> {
    const counter = await this.store.lock('counter', em);
    if (!counter || !isConfirmed(counter, now)) fail('number_required');
    const value = counter.value + 1;
    await this.store.set('counter', { ...counter, value, activeAt: now.toISOString() }, em);
    return value;
  }

  /** Raqam aniqlandi: bugun ma'lum bo'lganlarning eng kattasidan davom etadi. */
  private async confirmNumber(em: EntityManager, last: number, now: Date): Promise<void> {
    await em.query(
      `INSERT INTO offline_kv ("key", "value", "updatedAt") VALUES ('counter', $1, now()) ON CONFLICT ("key") DO NOTHING`,
      [JSON.stringify({ date: '', value: 0, confirmed: false, activeAt: now.toISOString() })],
    );
    const counter = await this.store.lock('counter', em);
    const central = await this.store.get('centralCounter', em);
    const today = dateKey(now);
    const value = Math.max(
      last,
      counter?.date === today ? counter.value : 0,
      central?.date === today ? central.value : 0,
    );
    await this.store.set('counter', { date: today, value, confirmed: true, activeAt: now.toISOString() }, em);
  }

  /** Kassirlar: markazdan olingan ro'yxat; online kassa uzatgan kassir unda bo'lmasa (yangi xodim) — u ham. */
  private cashiers(snapshot: StoredSnapshot | null, handover: StoredHandover | null) {
    const list = snapshot?.cashiers ?? [];
    if (handover && !list.some((c) => c.id === handover.cashier.id)) return [...list, { ...handover.cashier, pinHash: '' }];
    return list;
  }

  /** Menyu: online kassa uzatgani (yangiroq bo'lsa), aks holda markazdan olingan nusxa. */
  private menuOf(snapshot: StoredSnapshot | null, handover: StoredHandover | null): SyncMenu | null {
    if (handover?.menu && (!snapshot || handover.at > snapshot.takenAt)) return handover.menu;
    return snapshot?.menu ?? handover?.menu ?? null;
  }

  /** Markaziy buyurtma ko'rinishida (web kassa komponentlari, chek — o'zgarishsiz ishlaydi). */
  private view(order: OfflineOrder): OrderView {
    return {
      id: order.id,
      branchId: this.config.branchId,
      number: order.number,
      type: order.type,
      source: 'cashier',
      items: order.items,
      note: order.note,
      total: order.total,
      payment: order.payment,
      split: order.split,
      online: null,
      status: order.status,
      cashierId: order.cashierId,
      shiftId: null,
      createdAt: order.createdAt,
      preparingAt: order.createdAt,
      readyAt: order.readyAt,
      cancelledAt: order.cancelledAt,
      cancelledBy: order.cancelledBy,
      cancelReason: null,
      routedAt: order.createdAt,
      transferCount: 0,
      fromBranchId: null,
      deliveryFee: null,
      courierId: null,
      takenAt: null,
      departedAt: null,
      deliveredAt: null,
      returnedAt: null,
      returnReason: null,
      returnNote: '',
      courierSeq: null,
      courierLegKm: null,
      syncedAt: null,
    };
  }

  private async sign(cashierId: string, now: Date): Promise<string> {
    const payload = `${cashierId}.${now.getTime() + SESSION_MS}`;
    return `${payload}.${await this.signature(payload)}`;
  }

  private async signature(payload: string): Promise<string> {
    if (!this.secret) {
      const stored = await this.store.get('secret');
      this.secret = stored ?? randomBytes(32).toString('base64url');
      if (!stored) await this.store.set('secret', this.secret);
    }
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

/** Markazdagi xodimlar tizimi yo'li (`/shorva/`): faqat oddiy yo'l bo'laklari, boshqasi — ildiz (bo'sh). */
function safeUiBase(value: string | undefined): string {
  return value && /^(\/[A-Za-z0-9._~-]+)+\/$/.test(value) ? value : '';
}

/** Raqam aniq: kassir tasdiqlagan, bugungi va offline kassa yaqinda ishlatilgan. */
function isConfirmed(counter: StoredCounter | null, now: Date): boolean {
  return (
    !!counter &&
    counter.confirmed &&
    counter.date === dateKey(now) &&
    now.getTime() - Date.parse(counter.activeAt) < NUMBER_IDLE_MS
  );
}
