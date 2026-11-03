import type { DataSourceOptions } from 'typeorm';
import type { DbConnection } from '../shared/infra';
import { OfflineInit1793720000100 } from './migrations/1793720000100-OfflineInit';
import { OFFLINE_ENTITIES } from './offline.entities';

/**
 * Sozlamalar — Electron beradi (`config.json` → muhit o'zgaruvchilari):
 *  - `CENTRAL_URL` — markaziy server (`https://newyork24.uz`; Apache `/api`, `/images` ni backendga uzatadi);
 *  - `OFFLINE_KEY` — filial kaliti `br_….<maxfiy qism>` (admin "Filiallar" → "Offline kalit"); filial — undan;
 *  - `OFFLINE_PORT` (standart 3100) — faqat shu kompyuterdan (`127.0.0.1`);
 *  - `DB_*`, `UI_DIST`, `IMAGES_DIR`, `TZ`.
 */
export interface OfflineConfig {
  centralUrl: string;
  /** butun kalit (`br_….<maxfiy qism>`) — markazga shu holicha yuboriladi */
  key: string;
  /** kalitdagi filial id'si */
  branchId: string;
  port: number;
}

export function offlineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OfflineConfig {
  const key = (env.OFFLINE_KEY ?? '').trim();
  const dot = key.indexOf('.');
  return {
    centralUrl: (env.CENTRAL_URL ?? '').trim().replace(/\/+$/, ''),
    key,
    branchId: dot > 0 ? key.slice(0, dot) : '',
    port: Number(env.OFFLINE_PORT || 3100),
  };
}

/** Markaz bilan sinxronlash uchun manzil va kalit kerak. */
export const syncConfigured = (config: OfflineConfig): boolean => Boolean(config.centralUrl && config.branchId);

export const OFFLINE_MIGRATIONS: Function[] = [OfflineInit1793720000100];

export function offlineDataSourceOptions(db: DbConnection): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.user,
    password: db.password,
    database: db.database,
    entities: OFFLINE_ENTITIES,
    migrations: OFFLINE_MIGRATIONS,
    // markaziy bazaning `migrations` jadvali bilan aralashmasin (adashib bir bazaga ulansa ham)
    migrationsTableName: 'offline_migrations',
    synchronize: false,
  };
}

/** Nest DI kaliti. */
export const OFFLINE_CONFIG = 'OFFLINE_CONFIG';
