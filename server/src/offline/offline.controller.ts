import {
  Body,
  CanActivate,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { fail } from '../shared/errors';
import { CreateOrderDto } from '../shared/order';
import { HandoverDto, OfflineLoginDto, OfflineNumberDto } from './offline.dto';
import { OfflineKassaService, type OfflineCashier } from './offline-kassa.service';
import { OfflineSyncService } from './offline-sync.service';

type OfflineRequest = Request & { offlineCashier?: OfflineCashier };

/** Offline kassaga kirgan kassir: `Authorization: Bearer <token>` (handover yoki PIN bilan olingan). */
@Injectable()
export class OfflineAuthGuard implements CanActivate {
  constructor(private readonly kassa: OfflineKassaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OfflineRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    request.offlineCashier = (token && (await this.kassa.verify(token))) || fail('unauthorized');
    return true;
  }
}

const Cashier = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OfflineCashier =>
    context.switchToHttp().getRequest<OfflineRequest>().offlineCashier ?? fail('unauthorized'),
);

/** Electron ishga tushganini shu bilan tekshiradi. */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

/** Offline kassa API (`/api/offline/*`) — faqat shu kompyuterdan (server `127.0.0.1` da tinglaydi). */
@Controller('offline')
export class OfflineController {
  constructor(
    private readonly kassa: OfflineKassaService,
    private readonly sync: OfflineSyncService,
  ) {}

  @Get('data')
  data() {
    return this.kassa.data();
  }

  /** Offline kassa sahifasi (har 3 s) — sahifa ochiqligi ham shundan bilinadi (internet qaytganini tekshirish uchun). */
  @Get('state')
  state() {
    return this.kassa.state();
  }

  /** Tray uchun: faqat sinxronlash holati — sahifa ochiq deb hisoblanmaydi, markazga so'rov qo'zg'atmaydi. */
  @Get('status')
  status() {
    return this.sync.currentStatus();
  }

  @Post('handover')
  @HttpCode(200)
  handover(@Body() dto: HandoverDto) {
    return this.kassa.handover(dto);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: OfflineLoginDto) {
    return this.kassa.login(dto.cashierId, dto.pin);
  }

  @UseGuards(OfflineAuthGuard)
  @Post('number')
  @HttpCode(204)
  async number(@Body() dto: OfflineNumberDto) {
    await this.kassa.setNumber(dto.last);
  }

  @UseGuards(OfflineAuthGuard)
  @Post('leave')
  @HttpCode(204)
  async leave() {
    await this.kassa.leave();
  }

  @UseGuards(OfflineAuthGuard)
  @Get('orders')
  orders() {
    return this.kassa.orders();
  }

  @UseGuards(OfflineAuthGuard)
  @Post('orders')
  create(@Cashier() cashier: OfflineCashier, @Body() dto: CreateOrderDto) {
    return this.kassa.create(cashier, dto);
  }

  @UseGuards(OfflineAuthGuard)
  @Post('orders/:id/ready')
  @HttpCode(200)
  ready(@Param('id') id: string) {
    return this.kassa.markReady(id);
  }

  @UseGuards(OfflineAuthGuard)
  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Cashier() cashier: OfflineCashier) {
    return this.kassa.cancel(id, cashier);
  }
}
