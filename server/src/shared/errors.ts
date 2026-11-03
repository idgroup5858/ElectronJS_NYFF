import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Offline serverda paydo bo'ladigan xato kodlari — `NestJS_NYFF/src/common/errors.ts` va web ilovaning
 * `src/domain/errors.ts` dagilar bilan bir xil (web matnni shu kod bo'yicha ko'rsatadi). `number_required` — faqat shu yerda.
 */
export type ErrorCode =
  | 'not_found'
  | 'wrong_pin'
  | 'empty_order'
  | 'product_unavailable'
  | 'dine_in_only'
  | 'invalid_qty'
  | 'invalid_status'
  | 'invalid_amount'
  | 'forbidden'
  | 'unauthorized'
  | 'invalid_input'
  | 'too_many_attempts'
  | 'number_required';

const STATUS: Partial<Record<ErrorCode, HttpStatus>> = {
  unauthorized: HttpStatus.UNAUTHORIZED,
  wrong_pin: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  invalid_status: HttpStatus.CONFLICT,
  number_required: HttpStatus.CONFLICT,
  too_many_attempts: HttpStatus.TOO_MANY_REQUESTS,
};

const MESSAGES: Record<ErrorCode, string> = {
  not_found: 'Topilmadi',
  wrong_pin: "PIN noto'g'ri",
  empty_order: "Ro'yxat bo'sh",
  product_unavailable: "Bu taom hozir sotuvda yo'q",
  dine_in_only: "Bu taom faqat zalda beriladi — olib ketish va dostavkaga yo'q",
  invalid_qty: "Miqdor noto'g'ri",
  invalid_status: "Holat allaqachon o'zgargan",
  invalid_amount: "Summa noto'g'ri",
  forbidden: 'Bu amal sizning rolingiz uchun emas',
  unauthorized: 'Avval tizimga kiring',
  invalid_input: "So'rov ma'lumotlari noto'g'ri",
  too_many_attempts: "Ko'p marta xato kiritildi — birozdan keyin urinib ko'ring",
  number_required: 'Oxirgi buyurtma raqamini kiriting',
};

/** Javob tanasi: `{ statusCode, code, message, detail? }` — markaz bilan bir xil. */
export function appError(code: ErrorCode, detail?: string): HttpException {
  const status = STATUS[code] ?? HttpStatus.BAD_REQUEST;
  return new HttpException({ statusCode: status, code, message: MESSAGES[code], ...(detail && { detail }) }, status);
}

export function fail(code: ErrorCode, detail?: string): never {
  throw appError(code, detail);
}
