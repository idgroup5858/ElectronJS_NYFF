import type { LocalizedText, OrderItem, OrderType, PaymentMethod, PaymentSplit } from './common';

/**
 * Markaz (`/api/sync/*`) bilan almashinadigan ma'lumotlar — `NestJS_NYFF/src/sync/sync.types.ts` ning nusxasi
 * (markazda o'zgarsa — shu yerda ham).
 */

export interface SyncCashier {
  id: string;
  name: string;
  surname: string;
  /** PIN offline'da shu bcrypt xesh bilan tekshiriladi */
  pinHash: string;
}

export interface SyncCategory {
  id: string;
  name: LocalizedText;
  image: string;
  icon: string;
  sortOrder: number;
  active: boolean;
}

export interface SyncProduct {
  id: string;
  categoryId: string;
  name: LocalizedText;
  image: string;
  sortOrder: number;
  /** `null` — shu filialda sotilmaydi */
  price: number | null;
  composition: LocalizedText[];
  /** `false` — oshxona chekiga chiqmaydi (tayyor ichimlik). Eski markazda yo'q — chiqadi deb olinadi. */
  kitchen?: boolean;
  /** `true` — truck chekiga chiqadi (`kitchen` dan mustaqil). Eski markazda yo'q — chiqmaydi deb olinadi. */
  truck?: boolean;
  /** `true` — faqat zalda beriladi (choynakdagi choy): olib ketishga yo'q. Eski markazda yo'q — cheklanmaydi. */
  dineInOnly?: boolean;
}

/** Kassa menyusi (`GET /menu?all=true` bilan bir xil). */
export interface SyncMenu {
  branchId: string;
  categories: SyncCategory[];
  products: SyncProduct[];
}

export interface SyncImage {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface SyncCounter {
  date: string;
  value: number;
}

export interface SyncSnapshot {
  version: string;
  unchanged: false;
  /** `address` — chekda chiqadi; markaz yangilanmaguncha olingan eski nusxada yo'q */
  branch: { id: string; name: string; address?: string };
  cashiers: SyncCashier[];
  menu: SyncMenu;
  images: SyncImage[];
  /**
   * Xodimlar tizimi markazning qaysi yo'lida (`/shorva/`) — "Online rejimga qaytish" online kassadan o'tilmagan bo'lsa.
   * Eski markazda yo'q (ildiz).
   */
  uiBase?: string;
  counter: SyncCounter;
}

export type SyncSnapshotResponse = SyncSnapshot | { version: string; unchanged: true; counter: SyncCounter };

export const OFFLINE_ORDER_STATUSES = ['preparing', 'ready', 'cancelled'] as const;
export type OfflineOrderStatus = (typeof OFFLINE_ORDER_STATUSES)[number];

export interface SyncOrder {
  id: string;
  number: number;
  type: OrderType;
  items: OrderItem[];
  note: string;
  total: number;
  payment: PaymentMethod;
  split: PaymentSplit | null;
  status: OfflineOrderStatus;
  cashierId: string;
  createdAt: string;
  readyAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
}

export interface SyncOrdersResult {
  accepted: string[];
  rejected: { id: string; code: string; detail?: string }[];
}

/** Bir so'rovda yuboriladigan buyurtmalar chegarasi (markazdagi `SYNC_BATCH_SIZE`). */
export const SYNC_BATCH_SIZE = 200;

/** Filial kaliti sarlavhasi: `br_….<maxfiy qism>` (admin "Filiallar" → "Offline kalit"). */
export const SYNC_KEY_HEADER = 'x-offline-key';
