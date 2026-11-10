import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { SyncCounter, SyncMenu, SyncSnapshot } from '../shared/sync.types';
import { OfflineKv } from './offline.entities';

/** Markazdan olingan nusxa (hisoblagichsiz) va olingan vaqti. */
export type StoredSnapshot = Omit<SyncSnapshot, 'counter' | 'unchanged'> & { takenAt: string };

/** Online kassa offline'ga o'tganda bergan ma'lumot: kim ishlayotgan edi va o'sha paytdagi menyu. */
export interface StoredHandover {
  cashier: { id: string; name: string; surname: string };
  branchName: string;
  /** filial manzili (chek uchun); eski yozuvda yo'q */
  branchAddress?: string;
  /** online kassa ochilgan sayt — "Online rejimga qaytish" */
  returnUrl: string | null;
  menu: SyncMenu | null;
  at: string;
}

/**
 * Offline kassaning bugungi raqam hisoblagichi. `confirmed` — raqam aniq (online kassa uzatgan yoki kassir kiritgan);
 * aks holda savdodan oldin kassir oxirgi raqamni kiritadi (online kassa shu orada raqam bergan bo'lishi mumkin).
 */
export interface StoredCounter {
  date: string;
  value: number;
  confirmed: boolean;
  /** offline kassa oxirgi marta ishlatilgan payt — uzoq ishlatilmasa raqam yana so'raladi */
  activeAt: string;
}

/** Yuklangan rasmlar: yo'l → hajmi va markazdagi o'zgargan vaqti (o'zgarmaganini qayta yuklamaslik uchun). */
export type StoredImages = Record<string, { size: number; modifiedAt: string }>;

interface Values {
  snapshot: StoredSnapshot;
  centralCounter: SyncCounter;
  handover: StoredHandover;
  counter: StoredCounter;
  images: StoredImages;
  /** sessiya tokenlarini imzolash kaliti (bir marta yaratiladi) */
  secret: string;
}

export type KvKey = keyof Values;

/** `offline_kv` jadvali: kalit → JSON qiymat. */
@Injectable()
export class OfflineStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async get<K extends KvKey>(key: K, em: EntityManager = this.dataSource.manager): Promise<Values[K] | null> {
    const row = await em.findOneBy(OfflineKv, { key });
    return (row?.value as Values[K] | undefined) ?? null;
  }

  /** Qatorni tranzaksiya oxirigacha qulflab o'qiydi (hisoblagich bir vaqtda ikki marta o'smasin). */
  async lock<K extends KvKey>(key: K, em: EntityManager): Promise<Values[K] | null> {
    const row = await em.findOne(OfflineKv, { where: { key }, lock: { mode: 'pessimistic_write' } });
    return (row?.value as Values[K] | undefined) ?? null;
  }

  async set<K extends KvKey>(key: K, value: Values[K], em: EntityManager = this.dataSource.manager): Promise<void> {
    await em.upsert(OfflineKv, { key, value: value as object, updatedAt: new Date() }, ['key']);
  }
}
