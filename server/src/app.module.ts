import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { OFFLINE_CONFIG, offlineConfigFromEnv, offlineDataSourceOptions } from './offline/offline-config';
import { HealthController, OfflineAuthGuard, OfflineController } from './offline/offline.controller';
import { OfflineKassaService } from './offline/offline-kassa.service';
import { OfflineStore } from './offline/offline-store';
import { OfflineSyncService } from './offline/offline-sync.service';
import { dbConnectionFromEnv, ensureDatabase, imagesDir } from './shared/infra';

/** Markazdan yuklangan taom va kategoriya rasmlari — markazdagidek `/images/...` (ikonkalar — web ilovada). */
function imagesModule(): DynamicModule[] {
  const rootPath = imagesDir();
  mkdirSync(rootPath, { recursive: true });
  return [ServeStaticModule.forRoot({ rootPath, serveRoot: '/images', exclude: ['/images/{*path}'] })];
}

/** Web ilova (`UI_DIST` — Electron ichidagi `ReactJS_NYFF` build'i): offline kassa — `/offline`. */
function uiModule(): DynamicModule[] {
  const dir = process.env.UI_DIST || '../../ReactJS_NYFF/dist';
  const rootPath = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  if (!existsSync(join(rootPath, 'index.html'))) {
    new Logger('UI').warn(`Web ilova topilmadi (${rootPath}) — offline kassa sahifasi ochilmaydi`);
    return [];
  }
  return [ServeStaticModule.forRoot({ rootPath, exclude: ['/api/{*path}', '/images/{*path}'] })];
}

/**
 * Offline kassa serveri (kassa kompyuterida, Electron'ning fon jarayonida): offline kassa API, markaz bilan
 * sinxronlash, web ilova va rasmlar. Bazasi — o'sha kompyuterdagi PostgreSQL.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: async () => {
        const db = dbConnectionFromEnv();
        await ensureDatabase(db);
        return { ...offlineDataSourceOptions(db), migrationsRun: true };
      },
    }),
    ...imagesModule(),
    ...uiModule(),
  ],
  controllers: [HealthController, OfflineController],
  providers: [
    { provide: OFFLINE_CONFIG, useFactory: () => offlineConfigFromEnv() },
    OfflineStore,
    OfflineSyncService,
    OfflineKassaService,
    OfflineAuthGuard,
  ],
})
export class AppModule {}
