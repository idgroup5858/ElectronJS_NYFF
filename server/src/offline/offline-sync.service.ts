import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { DataSource, IsNull, Not } from 'typeorm';
import { imagesDir } from '../shared/infra';
import { SYNC_BATCH_SIZE, type SyncImage, type SyncOrder } from '../shared/sync.types';
import { CentralClient, CentralError } from './central-client';
import { OFFLINE_CONFIG, syncConfigured, type OfflineConfig } from './offline-config';
import { OfflineOrder } from './offline.entities';
import { OfflineStore, type StoredImages } from './offline-store';

/** Internet qaytganini tekshirish oralig'i — faqat yuboriladigan buyurtma bor yoki offline kassa ochiq paytda. */
export const SYNC_TICK_MS = 10_000;
/** Ishga tushganda nusxa olinmasa (internet yo'q) — shuncha vaqtdan keyin yana urinadi. */
const SNAPSHOT_RETRY_MS = 60_000;
/** Offline kassa sahifasi shuncha vaqt ichida holat so'ragan bo'lsa — "ochiq" (internet qaytganini bilishi kerak). */
const PAGE_ACTIVE_MS = 30_000;
/** Markaz holati shundan eski bo'lsa — noma'lum ("tekshirilmoqda"): internet shu orada uzilgan bo'lishi mumkin. */
const STATUS_FRESH_MS = 2 * SYNC_TICK_MS;

/** Sinxronlash holati — offline kassa sahifasi tepasida va tray'da ko'rsatiladi. */
export interface SyncStatus {
  configured: boolean;
  /** markaz oxirgi tekshiruvda javob berdimi; `null` — hali tekshirilmagan yoki natija eskirgan */
  online: boolean | null;
  /** markazga hali yetib bormagan buyurtmalar */
  pending: number;
  /** markaz rad etgan (qayta yuborilmaydi) */
  rejected: number;
  lastSyncAt: string | null;
  /** oxirgi xato: `network` — internet yo'q, `unauthorized` — kalit noto'g'ri, … */
  error: string | null;
}

const IMAGES_PREFIX = '/images/';

function toSyncOrder(order: OfflineOrder): SyncOrder {
  return {
    id: order.id,
    number: order.number,
    type: order.type,
    items: order.items,
    note: order.note,
    total: order.total,
    payment: order.payment,
    split: order.split,
    status: order.status,
    cashierId: order.cashierId,
    createdAt: order.createdAt.toISOString(),
    readyAt: order.readyAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    cancelledBy: order.cancelledBy,
  };
}

/**
 * Markaz bilan sinxronlash. Internet bor va hamma narsa yuborilgan paytda markazga **hech qanday so'rov ketmaydi**.
 * Nusxa (kassirlar, menyu, rasmlar) — ishga tushganda (har kuni kompyuter yoqilganda, yangilangach) va internet qaytib
 * buyurtmalar yuborilgandan keyin. Har 10 soniyada — faqat yuboriladigan buyurtma bo'lsa yoki offline kassa ochiq
 * bo'lsa: buyurtmalarni yuboradi / markaz javob berayotganini tekshiradi. Markaz qabul qilgan buyurtma darhol o'chiriladi.
 */
@Injectable()
export class OfflineSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OfflineSync');
  private readonly central: CentralClient;
  private timer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private busy = false;
  private snapshotDone = false;
  private pageSeenAt = 0;
  private checkedAt = 0;
  private readonly status = { online: null as boolean | null, lastSyncAt: null as string | null, error: null as string | null };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OFFLINE_CONFIG) private readonly config: OfflineConfig,
    private readonly store: OfflineStore,
  ) {
    this.central = new CentralClient(config);
  }

  onApplicationBootstrap(): void {
    if (!syncConfigured(this.config)) {
      this.logger.warn("Markaz manzili yoki filial kaliti yo'q — markaz bilan sinxronlash o'chiq");
      return;
    }
    if (process.env.OFFLINE_SYNC === 'off') return;
    void this.refreshUntilDone();
    this.timer = setInterval(() => void this.tick(), SYNC_TICK_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
  }

  /**
   * Offline kassa sahifasi holat so'radi — internet qaytganini bilishi uchun tekshiruv yoqiladi. Sahifa endi ochilgan
   * bo'lsa (online kassadan o'tildi) — darhol tekshiradi: ishga tushgandagi "internet bor" eskirgan bo'ladi.
   */
  pageSeen(): void {
    const opened = Date.now() - this.pageSeenAt >= PAGE_ACTIVE_MS;
    this.pageSeenAt = Date.now();
    if (opened && process.env.OFFLINE_SYNC !== 'off') void this.tick();
  }

  async currentStatus(): Promise<SyncStatus> {
    const [pending, rejected] = await Promise.all([
      this.dataSource.manager.countBy(OfflineOrder, { rejectedCode: IsNull() }),
      this.dataSource.manager.countBy(OfflineOrder, { rejectedCode: Not(IsNull()) }),
    ]);
    // eski natija — noma'lum: aks holda internet uzilgan zahoti "internet bor" ko'rinib turardi
    const online = Date.now() - this.checkedAt < STATUS_FRESH_MS ? this.status.online : null;
    return { configured: syncConfigured(this.config), ...this.status, online, pending, rejected };
  }

  /** Bir qadam: yuboriladigan buyurtma bo'lsa — yuboradi; offline kassa ochiq bo'lsa — markazni tekshiradi. */
  async tick(): Promise<void> {
    if (this.busy || !syncConfigured(this.config)) return;
    this.busy = true;
    try {
      const pending = await this.dataSource.manager.countBy(OfflineOrder, { rejectedCode: IsNull() });
      if (pending > 0) await this.push();
      else if (Date.now() - this.pageSeenAt < PAGE_ACTIVE_MS) await this.check(() => this.central.ping());
    } finally {
      this.busy = false;
    }
  }

  /** Yuborilmagan buyurtmalarni (eskisi birinchi) bo'lib-bo'lib yuboradi; hammasi yetib borgach — yangi nusxa. */
  async push(): Promise<void> {
    let sent = 0;
    // har qadamda buyurtmalar o'chadi yoki rad etiladi; chegara — kutilmagan javobda aylanib qolmaslik uchun
    for (let round = 0; round < 100; round++) {
      const batch = await this.dataSource.manager.find(OfflineOrder, {
        where: { rejectedCode: IsNull() },
        order: { createdAt: 'ASC' },
        take: SYNC_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      const result = await this.check(() => this.central.pushOrders(batch.map(toSyncOrder)));
      if (!result) return;
      const revs = new Map(batch.map((order) => [order.id, order.rev]));
      // yuborilgan nusxa bilan bir xilini o'chiradi — shu orada o'zgargani (masalan "Tayyor") keyingi safar qayta ketadi
      for (const id of result.accepted) {
        await this.dataSource.manager.delete(OfflineOrder, { id, rev: revs.get(id) });
      }
      for (const { id, code } of result.rejected) {
        await this.dataSource.manager.update(OfflineOrder, { id }, { rejectedCode: code.slice(0, 40) });
        this.logger.error(`Buyurtma ${id} markaz tomonidan rad etildi: ${code}`);
      }
      sent += result.accepted.length;
      if (result.accepted.length + result.rejected.length === 0) break;
    }
    if (sent > 0) {
      this.status.lastSyncAt = new Date().toISOString();
      this.logger.log(`${sent} ta buyurtma markazga yuborildi`);
      // menyu va kassirlar internet yo'q paytda o'zgargan bo'lishi mumkin
      await this.refreshSnapshot().catch((error: unknown) => this.logger.warn(`Nusxa olinmadi: ${String(error)}`));
    }
  }

  /** Markazdan nusxa: o'zgargan bo'lsa — kassirlar, menyu, rasmlar; har doim — bugungi raqam. */
  async refreshSnapshot(): Promise<void> {
    const current = await this.store.get('snapshot');
    const response = await this.check(() => this.central.snapshot(current?.version ?? null));
    if (!response) throw new Error(this.status.error ?? 'snapshot');
    await this.store.set('centralCounter', response.counter);
    if (!response.unchanged) {
      const { counter: _counter, unchanged: _unchanged, ...snapshot } = response;
      await this.store.set('snapshot', { ...snapshot, takenAt: new Date().toISOString() });
      await this.downloadImages(snapshot.images);
      this.logger.log(`Nusxa yangilandi: ${snapshot.cashiers.length} kassir, ${snapshot.menu.products.length} taom`);
    }
    this.snapshotDone = true;
  }

  /** Ishga tushganda nusxa — internet bo'lmasa har daqiqada qayta (olinguncha). */
  private async refreshUntilDone(): Promise<void> {
    try {
      await this.refreshSnapshot();
    } catch {
      if (!this.snapshotDone) this.retryTimer = setTimeout(() => void this.refreshUntilDone(), SNAPSHOT_RETRY_MS);
    }
  }

  /** Markazga so'rov: natija yoki `null` (internet yo'q / xato) — holat yangilanadi. */
  private async check<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      const result = await call();
      this.status.online = true;
      this.status.error = null;
      return result;
    } catch (error) {
      const code = error instanceof CentralError ? error.code : 'unknown';
      if (code !== this.status.error) this.logger.warn(`Markaz bilan aloqa yo'q: ${code}`);
      this.status.online = false;
      this.status.error = code;
      return null;
    } finally {
      this.checkedAt = Date.now();
    }
  }

  /** Yangi yoki o'zgargan rasmlarni yuklaydi (markazdagi bilan bir xil yo'lda). */
  private async downloadImages(images: SyncImage[]): Promise<void> {
    const root = imagesDir();
    const known: StoredImages = (await this.store.get('images')) ?? {};
    let changed = false;
    for (const image of images) {
      const file = resolve(root, image.path.slice(IMAGES_PREFIX.length));
      if (!image.path.startsWith(IMAGES_PREFIX) || relative(root, file).startsWith('..')) continue;
      const saved = known[image.path];
      if (saved && saved.size === image.size && saved.modifiedAt === image.modifiedAt && exists(file)) continue;
      try {
        const bytes = await this.central.image(image.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        known[image.path] = { size: image.size, modifiedAt: image.modifiedAt };
        changed = true;
      } catch (error) {
        this.logger.warn(`Rasm yuklanmadi: ${image.path} (${String(error)})`);
      }
    }
    if (changed) await this.store.set('images', known);
  }
}

function exists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
