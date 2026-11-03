import { Logger, ValidationError, ValidationPipe } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { isAbsolute, resolve } from 'node:path';
import { Client } from 'pg';
import { appError } from './errors';

// ── so'rov tanasini tekshirish (markazdagi `app.setup.ts` dagidek) ──

function flatten(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => `${path}: ${message}`);
    return [...own, ...flatten(error.children ?? [], path)];
  });
}

/** Noma'lum maydonlar jimgina tashlanadi; xato — `invalid_input` + qaysi maydon. */
export function validationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    exceptionFactory: (errors) => appError('invalid_input', flatten(errors).join('; ')),
  });
}

// ── PIN (markazdagi `auth/pin.ts` dagidek; xesh markazdan keladi — bcrypt, `bcryptjs` bilan mos) ──

/** Noto'g'ri PIN shuncha marta ketma-ket kiritilsa — [PIN_LOCK_MS] ga blok. */
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MS = 5 * 60_000;

export function comparePin(pin: string, hash: string): Promise<boolean> {
  return hash ? compare(pin, hash) : Promise.resolve(false);
}

// ── baza va papkalar ──

export interface DbConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Electron `DB_*` ni beradi (`config.json` → `db`, standart `postgres` / `root`, baza `nyff`). */
export function dbConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): DbConnection {
  return {
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD || 'root',
    database: env.DB_NAME || 'nyff',
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Postgres ishga tushishini kutadi (kompyuter yonganda servis keyin ko'tarilishi mumkin) va baza bo'lmasa yaratadi. */
export async function ensureDatabase(db: DbConnection, attempts = 30): Promise<void> {
  const logger = new Logger('Database');
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = new Client({ host: db.host, port: db.port, user: db.user, password: db.password, database: 'postgres' });
    try {
      await client.connect();
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.database]);
      if (exists.rowCount === 0) {
        if (!/^[A-Za-z0-9_]+$/.test(db.database)) throw new Error(`Baza nomi noto'g'ri: ${db.database}`);
        await client.query(`CREATE DATABASE "${db.database}"`);
        logger.log(`"${db.database}" bazasi yaratildi`);
      }
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`Postgres tayyor emas (${attempt}/${attempts}): ${(error as Error).message}`);
      await sleep(2000);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw lastError;
}

/** Markazdan yuklangan taom va kategoriya rasmlari (`IMAGES_DIR` — Electron ma'lumotlar papkasida). */
export function imagesDir(): string {
  const dir = process.env.IMAGES_DIR || 'uploads';
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}
