import { randomBytes } from 'node:crypto';
import type { ValueTransformer } from 'typeorm';

/**
 * Markaz (`NestJS_NYFF`) bilan bir xil bo'lishi shart bo'lgan kichik qismlar: id shakli, ro'yxatlar, turlar, sana kaliti,
 * to'lov qoidalari. Markazda o'zgarsa — shu yerda ham.
 */

/** Noyob id: `ord_3f2a9c1b7e4d8a05`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Kassa o'zi bergan buyurtma id'si — qayta yuborilgani ikki marta yozilmaydi. */
export const ORDER_ID_PATTERN = /^ord_[0-9a-f]{16}$/;

/** id ustunlari uzunligi. */
export const ID_LENGTH = 40;

/** Postgres `bigint` → JS `number` (summalar so'mda, `Number.MAX_SAFE_INTEGER` dan ancha kichik). */
export const bigintNumber: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

export const LANGS = ['uz', 'ru', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export type LocalizedText = Record<Lang, string>;

export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const PAYMENT_METHODS = ['cash', 'card', 'click'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Aralash to'lov: tur bo'yicha summalar (yig'indisi = buyurtma summasi). */
export type PaymentSplit = Partial<Record<PaymentMethod, number>>;

export interface OrderItem {
  productId: string;
  /** sotilgan paytdagi nom va narx */
  name: LocalizedText;
  price: number;
  qty: number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Mahalliy vaqt bo'yicha sana: `2026-10-23` (`TZ=Asia/Tashkent`). Buyurtma raqami har kuni shu kalit bo'yicha 1 dan. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Aralash to'lovni tekshiradi: musbat butun qismlar, kamida ikkita tur, yig'indisi — aynan buyurtma summasi. */
function cleanSplit(split: PaymentSplit, total: number, fail: () => never): PaymentSplit {
  const parts = PAYMENT_METHODS.filter((method) => (split[method] ?? 0) !== 0).map(
    (method) => [method, split[method] ?? 0] as const,
  );
  if (parts.length < 2 || parts.some(([, amount]) => !Number.isInteger(amount) || amount < 0)) fail();
  if (parts.reduce((sum, [, amount]) => sum + amount, 0) !== total) fail();
  return Object.fromEntries(parts);
}

/** To'lov turi va aralash qismlari; aralashda asosiy tur — eng katta qism. Noto'g'ri bo'lsa — [fail]. */
export function resolvePayment(
  payment: PaymentMethod,
  split: PaymentSplit | null | undefined,
  total: number,
  fail: () => never,
): { payment: PaymentMethod; split: PaymentSplit | null } {
  if (!split) return { payment, split: null };
  const clean = cleanSplit(split, total, fail);
  return {
    payment: PAYMENT_METHODS.reduce((best, method) => ((clean[method] ?? 0) > (clean[best] ?? 0) ? method : best)),
    split: clean,
  };
}
