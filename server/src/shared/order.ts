import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import {
  ORDER_ID_PATTERN,
  ORDER_TYPES,
  PAYMENT_METHODS,
  type OrderItem,
  type OrderType,
  type PaymentMethod,
  type PaymentSplit,
} from './common';
import type { OfflineOrderStatus } from './sync.types';

/**
 * Buyurtma — web kassa komponentlari (savat, chek, buyurtmalar ro'yxati) markazdagi `Order` ko'rinishini kutadi
 * (`NestJS_NYFF/src/orders/order.views.ts`): offline buyurtma ham shu shaklda qaytadi.
 */
export interface OrderView {
  id: string;
  branchId: string;
  number: number;
  type: OrderType;
  source: 'cashier';
  items: OrderItem[];
  note: string;
  total: number;
  payment: PaymentMethod;
  split: PaymentSplit | null;
  online: null;
  status: OfflineOrderStatus;
  cashierId: string;
  shiftId: null;
  createdAt: Date;
  preparingAt: Date;
  readyAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancelReason: null;
  routedAt: Date;
  transferCount: 0;
  fromBranchId: null;
  deliveryFee: null;
  courierId: null;
  takenAt: null;
  departedAt: null;
  deliveredAt: null;
  returnedAt: null;
  returnReason: null;
  returnNote: '';
  courierSeq: null;
  courierLegKm: null;
  syncedAt: null;
}

// ── so'rov shakli — markazdagi `CreateOrderDto` bilan bir xil (`NestJS_NYFF/src/orders/order.dto.ts`) ──

export class OrderLineDto {
  @IsString()
  @MaxLength(40)
  productId: string;

  @IsNumber()
  qty: number;
}

export class PaymentSplitDto {
  @IsOptional()
  @IsNumber()
  cash?: number;

  @IsOptional()
  @IsNumber()
  card?: number;

  @IsOptional()
  @IsNumber()
  click?: number;
}

/** Kassir buyurtmasi; `id` — kassa o'zi beradi (javob kelmasa qayta yuborilgani ikki marta yozilmaydi). */
export class CreateOrderDto {
  @IsOptional()
  @Matches(ORDER_ID_PATTERN)
  id?: string;

  @IsIn(ORDER_TYPES)
  type: OrderType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items: OrderLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  payment: PaymentMethod | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentSplitDto)
  split?: PaymentSplitDto | null;
}
