import { SYNC_KEY_HEADER, type SyncOrder, type SyncOrdersResult, type SyncSnapshotResponse } from '../shared/sync.types';
import type { OfflineConfig } from './offline-config';

/** Javob kutish chegarasi — internet sekin yoki "yarim uzilgan" bo'lsa ham sinxronlash osilib qolmasin. */
const TIMEOUT_MS = 15_000;

/** Markaz 413 qaytardi — paket uning so'rov tanasi chegarasidan katta (`OfflineSyncService.push` uni bo'ladi). */
export const PAYLOAD_TOO_LARGE = 'payload_too_large';

/** Markaz javob bermadi (`status: 0` — tarmoq yo'q) yoki xato qaytardi (`code` — server xato kodi). */
export class CentralError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`central ${status} ${code}`);
  }
}

/** Markaziy server bilan HTTP (`/api/sync/*`, `/api/health`, rasmlar) — Node'ning `fetch` i bilan. */
export class CentralClient {
  constructor(private readonly config: OfflineConfig) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.config.centralUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          [SYNC_KEY_HEADER]: this.config.key,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new CentralError(0, 'network');
    }
    // so'rov tanasi markaz chegarasidan katta — javob tanasi JSON bo'lmasligi mumkin, kod holatdan
    if (response.status === 413) throw new CentralError(413, PAYLOAD_TOO_LARGE);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { code?: string } | null;
      throw new CentralError(response.status, body?.code ?? `http_${response.status}`);
    }
    return response;
  }

  async snapshot(since: string | null): Promise<SyncSnapshotResponse> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    return (await this.request(`/api/sync/snapshot${query}`)).json() as Promise<SyncSnapshotResponse>;
  }

  async pushOrders(orders: SyncOrder[]): Promise<SyncOrdersResult> {
    const response = await this.request('/api/sync/orders', { method: 'POST', body: JSON.stringify({ orders }) });
    return response.json() as Promise<SyncOrdersResult>;
  }

  /** Internet va markaz bormi (yuboriladigan buyurtma yo'q paytda tekshirish uchun). */
  async ping(): Promise<void> {
    await this.request('/api/health');
  }

  /** Rasm fayli (`/images/products/cola.png`). */
  async image(path: string): Promise<Buffer> {
    const response = await this.request(path);
    return Buffer.from(await response.arrayBuffer());
  }
}
