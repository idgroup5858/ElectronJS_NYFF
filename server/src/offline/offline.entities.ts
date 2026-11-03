import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintNumber, ID_LENGTH, type OrderItem, type OrderType, type PaymentMethod, type PaymentSplit } from '../shared/common';
import type { OfflineOrderStatus } from '../shared/sync.types';

/**
 * Offline kassa bazasi (kassa kompyuteridagi PostgreSQL, standart `nyff`) — markaziy baza jadvallari yo'q, faqat shu ikkitasi:
 *  - `offline_kv` — markazdan olingan nusxa (kassirlar, menyu), online kassadan o'tgan ma'lumot, raqam hisoblagichi;
 *  - `offline_orders` — internet yo'q paytda olingan, markazga hali yetib bormagan buyurtmalar (yetib borgach o'chadi).
 */
@Entity('offline_kv')
export class OfflineKv {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @Column({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('offline_orders')
@Index('IDX_offline_orders_createdAt', ['createdAt'])
export class OfflineOrder {
  @PrimaryColumn({ type: 'varchar', length: ID_LENGTH })
  id: string;

  @Column({ type: 'int' })
  number: number;

  @Column({ type: 'varchar', length: 10 })
  type: OrderType;

  /** sotilgan paytdagi nom va narx */
  @Column({ type: 'jsonb' })
  items: OrderItem[];

  @Column({ type: 'text', default: '' })
  note: string;

  @Column('bigint', { transformer: bigintNumber })
  total: number;

  @Column({ type: 'varchar', length: 10 })
  payment: PaymentMethod;

  @Column({ type: 'jsonb', nullable: true })
  split: PaymentSplit | null;

  @Column({ type: 'varchar', length: 10 })
  status: OfflineOrderStatus;

  @Column({ type: 'varchar', length: ID_LENGTH })
  cashierId: string;

  @Column({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  readyAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'varchar', length: ID_LENGTH, nullable: true })
  cancelledBy: string | null;

  /**
   * Har o'zgarishda +1. Markaz qabul qilgach faqat yuborilgan nusxa bilan bir xil bo'lsa o'chiriladi — yuborish paytida
   * "Tayyor" bosilgan bo'lsa, keyingi safar yangi holati bilan qayta yuboriladi.
   */
  @Column({ type: 'int', default: 0 })
  rev: number;

  /** markaz rad etgan (ma'lumot xatosi) — qayta yuborilmaydi, bazada qoladi; xato kodi */
  @Column({ type: 'varchar', length: 40, nullable: true })
  rejectedCode: string | null;
}

export const OFFLINE_ENTITIES = [OfflineKv, OfflineOrder];
