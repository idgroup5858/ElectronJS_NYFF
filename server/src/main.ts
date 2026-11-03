import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { offlineConfigFromEnv } from './offline/offline-config';
import { validationPipe } from './shared/infra';

/**
 * Offline kassa serveri — Electron uni fon jarayonida (`utilityProcess`) ishga tushiradi, sozlamalar muhit
 * o'zgaruvchilarida. Faqat shu kompyuterdan ochiladi (`127.0.0.1`), CORS yo'q — boshqa saytlar unga murojaat qila
 * olmaydi. Offline kassa: `http://localhost:3100/offline`.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  app.useGlobalPipes(validationPipe());

  const { port } = offlineConfigFromEnv();
  await app.listen(port, '127.0.0.1');
  new Logger('Bootstrap').log(`NYFF offline kassa: http://localhost:${port}/offline`);
}
void bootstrap();
