import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { SyncMenu } from '../shared/sync.types';

export class HandoverCashierDto {
  @IsString()
  @MaxLength(40)
  id: string;

  @IsString()
  @MaxLength(100)
  name: string;

  @IsString()
  @MaxLength(100)
  surname: string;
}

/** Online kassa offline'ga o'tishda beradi: kim ishlayotgan edi, oxirgi raqam, o'sha paytdagi menyu. */
export class HandoverDto {
  @IsString()
  @MaxLength(40)
  branchId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  branchName?: string;

  /** filial manzili — chekda chiqadi */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  branchAddress?: string;

  /** online kassa sahifasi (`https://newyork24.uz/shorva/kassa`) — "Online rejimga qaytish" shu yerga */
  @IsOptional()
  @Matches(/^https?:\/\/[^\s]+$/)
  @MaxLength(300)
  returnUrl?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => HandoverCashierDto)
  cashier: HandoverCashierDto;

  /** online kassa ko'rgan bugungi eng katta buyurtma raqami (0 — bugun hali yo'q) */
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  lastNumber: number;

  /** kassa menyusi (`GET /menu?all=true` javobi) — tekshirilmaydi, faqat narx manbai */
  @IsOptional()
  @IsObject()
  menu?: SyncMenu;
}

export class OfflineLoginDto {
  @IsString()
  @MaxLength(40)
  cashierId: string;

  @IsString()
  @MaxLength(8)
  pin: string;
}

/** Kassir oxirgi chekdagi raqamni kiritadi (online kassadan o'tilmagan bo'lsa). */
export class OfflineNumberDto {
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  last: number;
}

/** Faqat `handover.menu` ichini shakl bo'yicha tekshirish uchun. */
export function isMenu(value: unknown): value is SyncMenu {
  const menu = value as SyncMenu | undefined;
  return !!menu && Array.isArray(menu.categories) && Array.isArray(menu.products);
}
