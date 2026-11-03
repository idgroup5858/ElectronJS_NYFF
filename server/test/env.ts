/**
 * Test muhiti — har bir test faylidan oldin (`AppModule` import qilinishidan oldin: rasmlar va UI papkasi shu paytda
 * o'qiladi). Baza alohida: `nyff_test_offline`. PostgreSQL ulanishi ishlab chiqish kompyuterida `NestJS_NYFF/.env` dan
 * olinadi (bo'lmasa — standart `postgres` / `root`).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TZ = 'Asia/Tashkent';
try {
  for (const line of readFileSync(join(__dirname, '../../../NestJS_NYFF/.env'), 'utf8').split(/\r?\n/)) {
    const match = /^(DB_HOST|DB_PORT|DB_USER|DB_PASSWORD)=(.*)$/.exec(line);
    if (match) process.env[match[1]] = match[2].trim();
  }
} catch {
  // backend loyihasi yonida emas — standart sozlamalar
}
process.env.DB_NAME = process.env.TEST_DB_NAME || 'nyff_test_offline';
// sinxronlash testda qo'lda chaqiriladi
process.env.OFFLINE_SYNC = 'off';
process.env.UI_DIST = 'test/no-ui';
process.env.IMAGES_DIR = join(tmpdir(), 'nyff-offline-test-images');
