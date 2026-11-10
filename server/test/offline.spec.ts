import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { OFFLINE_CONFIG, type OfflineConfig } from '../src/offline/offline-config';
import { NUMBER_IDLE_MS, OfflineKassaService } from '../src/offline/offline-kassa.service';
import { OfflineStore } from '../src/offline/offline-store';
import { OfflineSyncService } from '../src/offline/offline-sync.service';
import { dateKey, newId } from '../src/shared/common';
import { imagesDir, validationPipe } from '../src/shared/infra';
import { BRANCH, CASHIER, FakeCentral, IMAGE_PATH, KEY } from './fake-central';

const order = (patch: Record<string, unknown> = {}) => ({
  type: 'dine_in' as const,
  items: [{ productId: 'burger-classic', qty: 2 }],
  payment: 'cash' as const,
  ...patch,
});

/** Xato kodi bo'yicha kutish (servisni to'g'ridan-to'g'ri chaqirganda). */
async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  const response = (caught as { getResponse?: () => { code?: string } } | undefined)?.getResponse?.();
  if (response?.code !== code) throw new Error(`kutilgan xato: ${code}, keldi: ${response?.code ?? String(caught)}`);
}

/**
 * Offline kassa serveri (Electron ichida) — markazning soxtasi bilan, haqiqiy HTTP orqali: nusxa olish, online kassadan
 * o'tish (PIN'siz) va PIN bilan kirish, raqam qoidalari, buyurtma, "Tayyor" / bekor, internet qaytgach yuborish
 * (markaz qabul qilgani o'chadi), rasmlar.
 */
describe('offline kassa serveri', () => {
  const central = new FakeCentral();
  let app: INestApplication;
  let db: DataSource;
  let kassa: OfflineKassaService;
  let sync: OfflineSyncService;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const handover = (lastNumber: number, extra: Record<string, unknown> = {}) =>
    http().post('/api/offline/handover').send({ branchId: BRANCH, branchName: 'Chilonzor', cashier: CASHIER, lastNumber, ...extra });

  beforeAll(async () => {
    await central.start();
    process.env.CENTRAL_URL = central.url;
    process.env.OFFLINE_KEY = KEY;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error'] });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(validationPipe());
    await app.init();
    db = app.get(DataSource);
    kassa = app.get(OfflineKassaService);
    sync = app.get(OfflineSyncService);
  });

  beforeEach(async () => {
    await db.query('TRUNCATE offline_orders, offline_kv');
    rmSync(imagesDir(), { recursive: true, force: true });
    central.orders.clear();
    central.counter = 0;
    central.burgerPrice = 32000;
    central.maxBody = 0;
    central.tooLarge = 0;
  });

  afterAll(async () => {
    await app.close();
    await central.stop();
  });

  it("ishga tushdi; nusxa olinmaguncha va online kassadan o'tilmaguncha — tayyor emas", async () => {
    await http().get('/api/health').expect(200);
    const state = (await http().get('/api/offline/state').expect(200)).body;
    expect(state).toMatchObject({ ready: false, number: { confirmed: false, last: 0 } });
    expect(state.sync).toMatchObject({ configured: true, pending: 0, rejected: 0 });
    const data = (await http().get('/api/offline/data').expect(200)).body;
    expect(data).toMatchObject({ branch: { id: BRANCH }, cashiers: [], menu: null });
    // online kassadan hali o'tilmagan — "Online rejimga qaytish" markaz manziliga
    expect(data.kassaUrl).toBe(central.url);
  });

  it('nusxa: kassirlar (PIN xeshisiz), menyu, rasmlar; PIN bilan kirish, 5 marta xato — blok', async () => {
    await sync.refreshSnapshot();
    const data = (await http().get('/api/offline/data').expect(200)).body;
    expect(data.branch).toEqual({ id: BRANCH, name: 'Chilonzor', address: 'Bunyodkor 12' });
    expect(data.cashiers).toEqual(expect.arrayContaining([CASHIER]));
    expect(JSON.stringify(data)).not.toContain('pinHash');
    expect(data.menu.products).toHaveLength(4);
    // online kassadan o'tilmagan — "Online rejimga qaytish" markazdagi xodimlar tizimi yo'liga (nusxadagi `uiBase`)
    expect(data.kassaUrl).toBe(`${central.url}/shorva/`);
    expect((await http().get('/api/offline/state').expect(200)).body).toMatchObject({ ready: true, sync: { online: true } });
    // rasm markazdagidek yo'lda
    const image = join(imagesDir(), IMAGE_PATH.slice('/images/'.length));
    expect(readFileSync(image, 'utf8')).toBe('PNG!');

    const login = await http().post('/api/offline/login').send({ cashierId: CASHIER.id, pin: '1234' }).expect(200);
    expect(login.body.cashier).toEqual(CASHIER);
    await http().get('/api/offline/orders').set(bearer(login.body.token)).expect(200);
    await http().get('/api/offline/orders').set(bearer(`${login.body.token}x`)).expect(401);

    const other = 'usr_cashier_2';
    // `detail` — qolgan urinishlar (kassa 4-xatodan keyin "1 ta urinish qoldi" deydi)
    for (let i = 0; i < 4; i++) {
      const wrong = await http().post('/api/offline/login').send({ cashierId: other, pin: '0000' }).expect(401);
      expect(wrong.body).toMatchObject({ code: 'wrong_pin', detail: String(4 - i) });
    }
    // blok: `detail` — qolgan soniyalar (kassa sanaydi)
    const locked = await http().post('/api/offline/login').send({ cashierId: other, pin: '0000' }).expect(429);
    expect(locked.body).toMatchObject({ code: 'too_many_attempts', detail: '300s' });
    const again = await http().post('/api/offline/login').send({ cashierId: other, pin: '4321' }).expect(429);
    expect(again.body.detail).toMatch(/^\d+s$/);
  });

  it('bir vaqtda 10 ta xato PIN — faqat 5 tasi tekshiriladi, keyin blok', async () => {
    await sync.refreshSnapshot();
    // oldingi testdagi blok (xotirada) tugagan payt
    const at = new Date(Date.now() + 10 * 60_000);
    const codeOf = (error: { getResponse(): { code: string } }) => error.getResponse().code;
    const codes = await Promise.all(Array.from({ length: 10 }, () => kassa.login('usr_cashier_2', '0000', at).then(() => 'ok', codeOf)));
    expect(codes.filter((code) => code === 'wrong_pin')).toHaveLength(4);
    expect(codes.filter((code) => code === 'too_many_attempts')).toHaveLength(6);
    await expectCode('too_many_attempts', () => kassa.login('usr_cashier_2', '4321', at));
  });

  it("online kassadan o'tish: PIN'siz, raqam davom etadi; narx menyudan; qayta yuborilgani takrorlanmaydi", async () => {
    await sync.refreshSnapshot();
    const { token } = (await handover(57, { returnUrl: 'https://newyork24.uz/shorva/kassa' }).expect(200)).body;
    expect((await http().get('/api/offline/state').expect(200)).body.number).toEqual({ confirmed: true, last: 57 });
    // qaytish — online kassa ochilgan sahifaga (markaz manzilidan boshqa bo'lishi mumkin)
    expect((await http().get('/api/offline/data').expect(200)).body.kassaUrl).toBe('https://newyork24.uz/shorva/kassa');
    await handover(57, { returnUrl: 'javascript:alert(1)' }).expect(400);
    // boshqa filial nomidan — yo'q
    await http().post('/api/offline/handover').send({ branchId: 'br_boshqa', cashier: CASHIER, lastNumber: 1 }).expect(403);

    const first = (await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201)).body;
    expect(first).toMatchObject({ number: 58, branchId: BRANCH, source: 'cashier', status: 'preparing', total: 64000, cashierId: CASHIER.id });
    expect(first.items[0]).toMatchObject({ productId: 'burger-classic', price: 32000, qty: 2, name: { uz: 'Klassik burger' } });

    const id = newId('ord');
    const second = (await http().post('/api/offline/orders').set(bearer(token)).send(order({ id, payment: 'card' })).expect(201)).body;
    const retried = (await http().post('/api/offline/orders').set(bearer(token)).send(order({ id, payment: 'card' })).expect(201)).body;
    expect([second.number, retried.number, retried.id]).toEqual([59, 59, id]);

    for (const productId of ['yoq-taom', 'hotdog-kimchi']) {
      const unavailable = await http()
        .post('/api/offline/orders')
        .set(bearer(token))
        .send(order({ items: [{ productId, qty: 1 }] }))
        .expect(400);
      expect(unavailable.body.code).toBe('product_unavailable');
    }
    // choynakdagi choy — faqat zalda: olib ketishda rad, zalda o'tadi (raqam 60)
    const teaPot = { items: [{ productId: 'tea-pot', qty: 1 }] };
    const takeaway = await http().post('/api/offline/orders').set(bearer(token)).send(order({ ...teaPot, type: 'takeaway' })).expect(400);
    expect(takeaway.body.code).toBe('dine_in_only');
    const dineIn = (await http().post('/api/offline/orders').set(bearer(token)).send(order(teaPot)).expect(201)).body;
    expect(dineIn.number).toBe(60);
    const badSplit = await http().post('/api/offline/orders').set(bearer(token)).send(order({ split: { cash: 1 } })).expect(400);
    expect(badSplit.body.code).toBe('invalid_amount');

    const list = (await http().get('/api/offline/orders').set(bearer(token)).expect(200)).body;
    expect(list.map((o: { number: number }) => o.number)).toEqual([60, 59, 58]);
  });

  it("nusxasiz ham ishlaydi — online kassa uzatgan menyu bilan; u nusxadan yangi bo'lsa — narx undan", async () => {
    const menu = {
      branchId: BRANCH,
      categories: [{ id: 'burgers', name: { uz: 'Burgerlar', ru: '', en: '' }, image: '', icon: '', sortOrder: 1, active: true }],
      products: [
        { id: 'burger-classic', categoryId: 'burgers', name: { uz: 'Klassik', ru: '', en: '' }, image: '', sortOrder: 1, price: 30000, composition: [] },
      ],
    };
    const { token } = (await handover(0, { menu }).expect(200)).body;
    expect((await http().get('/api/offline/state').expect(200)).body.ready).toBe(true);
    const created = (await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201)).body;
    expect(created).toMatchObject({ number: 1, total: 60000 });
  });

  it("raqam: o'tilmagan bo'lsa — kassir kiritadi; \"Online'ga qaytish\", uzoq ishlatilmaslik va yangi kun — yana so'raladi", async () => {
    await sync.refreshSnapshot();
    const { token } = (await http().post('/api/offline/login').send({ cashierId: CASHIER.id, pin: '1234' }).expect(200)).body;
    const blocked = await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(409);
    expect(blocked.body.code).toBe('number_required');

    await http().post('/api/offline/number').set(bearer(token)).send({ last: 80 }).expect(204);
    expect((await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201)).body.number).toBe(81);

    await http().post('/api/offline/leave').set(bearer(token)).expect(204);
    expect((await http().get('/api/offline/state').expect(200)).body.number).toEqual({ confirmed: false, last: 81 });
    // kichikroq kiritilsa ham ma'lum bo'lgan eng kattasidan davom etadi
    await http().post('/api/offline/number').set(bearer(token)).send({ last: 10 }).expect(204);
    expect((await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201)).body.number).toBe(82);

    const later = new Date(Date.now() + NUMBER_IDLE_MS + 60_000);
    await expectCode('number_required', () => kassa.create(CASHIER, order(), later));
    const counter = await app.get(OfflineStore).get('counter');
    const tomorrow = new Date(`${counter?.date}T12:00:00`);
    tomorrow.setDate(tomorrow.getDate() + 1);
    await expectCode('number_required', () => kassa.create(CASHIER, order(), tomorrow));
    expect(dateKey(tomorrow)).not.toBe(counter?.date);
  });

  it('"Tayyor" va bekor: faqat oldinga', async () => {
    await sync.refreshSnapshot();
    const { token } = (await handover(0).expect(200)).body;
    const created = (await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201)).body;
    const ready = (await http().post(`/api/offline/orders/${created.id}/ready`).set(bearer(token)).expect(200)).body;
    expect(ready).toMatchObject({ status: 'ready', readyAt: expect.any(String) });
    const again = await http().post(`/api/offline/orders/${created.id}/ready`).set(bearer(token)).expect(409);
    expect(again.body.code).toBe('invalid_status');
    const cancelled = (await http().post(`/api/offline/orders/${created.id}/cancel`).set(bearer(token)).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledBy: CASHIER.id });
    await http().post(`/api/offline/orders/${created.id}/cancel`).set(bearer(token)).expect(409);
    await http().post('/api/offline/orders/ord_0000000000000000/ready').set(bearer(token)).expect(404);
  });

  it("internet qaytdi: buyurtmalar markazga yetadi va offline bazadan o'chadi; nusxa yangilanadi", async () => {
    await sync.refreshSnapshot();
    const { token } = (await handover(4).expect(200)).body;
    const a = (await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201)).body;
    const b = (await http().post('/api/offline/orders').set(bearer(token)).send(order({ type: 'takeaway' })).expect(201)).body;
    await http().post(`/api/offline/orders/${a.id}/ready`).set(bearer(token)).expect(200);
    await http().post(`/api/offline/orders/${b.id}/cancel`).set(bearer(token)).expect(200);
    const status = (await http().get('/api/offline/status').expect(200)).body;
    expect(status).toMatchObject({ configured: true, pending: 2, rejected: 0 });

    // markazda shu orada narx o'zgardi — yuborilgandan keyin nusxa yangilanadi
    central.burgerPrice = 35000;
    await sync.push();

    const saved = [...central.orders.values()].map((o) => [o.number, o.status, o.cashierId]).sort();
    expect(saved).toEqual([
      [5, 'ready', CASHIER.id],
      [6, 'cancelled', CASHIER.id],
    ]);
    expect(await db.query('SELECT id FROM offline_orders')).toEqual([]);
    const state = (await http().get('/api/offline/state').expect(200)).body;
    expect(state.sync).toMatchObject({ online: true, pending: 0, lastSyncAt: expect.any(String) });
    const data = (await http().get('/api/offline/data').expect(200)).body;
    // online kassa uzatgan menyu yo'q — yangi nusxadagi narx
    expect(data.menu.products.find((p: { id: string }) => p.id === 'burger-classic').price).toBe(35000);
  });

  it("paket markaz chegarasidan katta (413) — yarmiga bo'linib darhol qayta yuboriladi, hammasi yetadi", async () => {
    await sync.refreshSnapshot();
    const { token } = (await handover(0).expect(200)).body;
    for (let i = 0; i < 7; i++) await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201);
    // bitta buyurtma ~0,4 KB: 7 tasi bitta paketda sig'maydi, 2 tasi sig'adi
    central.maxBody = 1200;
    await sync.push();

    expect(central.tooLarge).toBeGreaterThan(0);
    expect([...central.orders.values()].map((o) => o.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await db.query('SELECT id FROM offline_orders')).toEqual([]);
    expect((await http().get('/api/offline/state').expect(200)).body.sync).toMatchObject({
      online: true,
      error: null,
      pending: 0,
      rejected: 0,
    });
  });

  it("markaz yo'q — buyurtma kutadi, holatda xato; markaz rad etgani qayta yuborilmaydi; kalit noto'g'ri — unauthorized", async () => {
    await sync.refreshSnapshot();
    const { token } = (await handover(0).expect(200)).body;
    await http().post('/api/offline/orders').set(bearer(token)).send(order()).expect(201);

    // markaz javob bermaydi — internet yo'qdek
    const config = app.get<OfflineConfig>(OFFLINE_CONFIG);
    const url = config.centralUrl;
    config.centralUrl = 'http://127.0.0.1:1';
    await sync.push();
    config.centralUrl = url;
    expect((await http().get('/api/offline/state').expect(200)).body.sync).toMatchObject({ online: false, error: 'network', pending: 1 });

    // kalit admin panelda yangilangan — eskisi rad etiladi
    const key = config.key;
    config.key = `${BRANCH}.eski-kalit`;
    await sync.push();
    config.key = key;
    expect((await http().get('/api/offline/state').expect(200)).body.sync).toMatchObject({ online: false, error: 'unauthorized', pending: 1 });

    // buzilgan buyurtma (aralash to'lov yig'indisi noto'g'ri) — markaz rad etadi, bazada qoladi, qayta ketmaydi
    await db.query(`UPDATE offline_orders SET split = '{"cash": 1}'`);
    await sync.push();
    expect((await http().get('/api/offline/state').expect(200)).body.sync).toMatchObject({ online: true, pending: 0, rejected: 1 });
    const [row] = await db.query('SELECT "rejectedCode" FROM offline_orders');
    expect(row.rejectedCode).toBe('invalid_amount');
    expect(central.orders.size).toBe(0);
    expect(existsSync(imagesDir())).toBe(true);
  });
});
