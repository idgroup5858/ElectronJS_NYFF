import { hashSync } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dateKey } from '../src/shared/common';
import type { SyncCashier, SyncMenu, SyncOrder } from '../src/shared/sync.types';

export const BRANCH = 'br_test';
export const KEY = `${BRANCH}.maxfiy-qism-0123456789abcdef`;
export const CASHIER = { id: 'usr_cashier_1', name: 'Dilnoza', surname: 'Karimova' };
export const IMAGE_PATH = '/images/products/burger-classic.png';

const name = (uz: string) => ({ uz, ru: '', en: '' });

function menu(burgerPrice: number): SyncMenu {
  return {
    branchId: BRANCH,
    categories: [{ id: 'burgers', name: name('Burgerlar'), image: '', icon: '', sortOrder: 1, active: true }],
    products: [
      { id: 'burger-classic', categoryId: 'burgers', name: name('Klassik burger'), image: IMAGE_PATH, sortOrder: 1, price: burgerPrice, composition: [] },
      { id: 'cola', categoryId: 'burgers', name: name('Cola'), image: '', sortOrder: 2, price: 9000, composition: [] },
      // shu filialda sotilmaydi
      { id: 'hotdog-kimchi', categoryId: 'burgers', name: name('Kimchi hot-dog'), image: '', sortOrder: 3, price: null, composition: [] },
      // choynakdagi choy — faqat zalda
      { id: 'tea-pot', categoryId: 'burgers', name: name('Choy (choynakda)'), image: '', sortOrder: 4, price: 8000, composition: [], dineInOnly: true },
    ],
  };
}

/**
 * Markazning soxtasi (`/api/sync/*`, `/api/health`, rasmlar) — offline server bilan haqiqiy HTTP orqali. Markazning
 * o'zi (`NestJS_NYFF/test/sync.db-spec.ts`) alohida tekshirilgan; bu yerda — offline tomonning xulqi.
 */
export class FakeCentral {
  private server: Server | null = null;
  url = '';
  burgerPrice = 32000;
  counter = 0;
  cashiers: SyncCashier[] = [
    { ...CASHIER, pinHash: hashSync('1234', 4) },
    { id: 'usr_cashier_2', name: 'Sardor', surname: 'Aliyev', pinHash: hashSync('4321', 4) },
  ];
  /** qabul qilingan buyurtmalar (oxirgi holati) */
  readonly orders = new Map<string, SyncOrder>();
  /** so'rov tanasi chegarasi, bayt (haqiqiy markazdagi `SYNC_BODY_LIMIT` dek; kattasiga — 413); `0` — chegarasiz */
  maxBody = 0;
  /** 413 bilan qaytarilgan paketlar soni */
  tooLarge = 0;
  /** markaz rad etadigan buyurtma — xato kodi */
  reject: (order: SyncOrder) => string | null = (order) =>
    order.split && Object.values(order.split).reduce((sum, part) => sum + (part ?? 0), 0) !== order.total ? 'invalid_amount' : null;

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((done) => this.server?.close(done));
  }

  private snapshotBody() {
    return {
      branch: { id: BRANCH, name: 'Chilonzor' },
      cashiers: this.cashiers,
      menu: menu(this.burgerPrice),
      images: [{ path: IMAGE_PATH, size: 4, modifiedAt: '2026-11-01T00:00:00.000Z' }],
      uiBase: '/shorva/',
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.url);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/health') return send(200, { ok: true });
    if (url.pathname === IMAGE_PATH) {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      return void response.end(Buffer.from('PNG!'));
    }
    if (request.headers['x-offline-key'] !== KEY) return send(401, { statusCode: 401, code: 'unauthorized' });

    const counter = { date: dateKey(new Date()), value: this.counter };
    if (url.pathname === '/api/sync/snapshot') {
      const body = this.snapshotBody();
      const version = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (url.searchParams.get('since') === version) return send(200, { version, unchanged: true, counter });
      return send(200, { version, unchanged: false, ...body, counter });
    }
    if (url.pathname === '/api/sync/orders' && request.method === 'POST') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (this.maxBody > 0 && Buffer.byteLength(raw) > this.maxBody) {
        this.tooLarge++;
        return send(413, { statusCode: 413, message: 'request entity too large' });
      }
      const { orders } = JSON.parse(raw) as { orders: SyncOrder[] };
      const result = { accepted: [] as string[], rejected: [] as { id: string; code: string }[] };
      for (const order of orders) {
        const code = this.reject(order);
        if (code) {
          result.rejected.push({ id: order.id, code });
          continue;
        }
        this.orders.set(order.id, order);
        this.counter = Math.max(this.counter, order.number);
        result.accepted.push(order.id);
      }
      return send(200, result);
    }
    send(404, { statusCode: 404 });
  }
}
