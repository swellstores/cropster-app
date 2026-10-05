const API_BASE = 'https://api.cropster.com/rpc/v1';
const TOKEN_URL = 'https://auth.cropster.com/oauth2/token';

// OAuth scopes the service account needs: product sync and orders
export const SCOPES = ['mrp.product', 'mrp.order'];

// Cropster accepts at most 50 products or orders per request
export const MAX_BATCH = 50;

export interface CropsterSettings {
  client_id?: string;
  client_secret?: string;
  enabled?: boolean;
  // 'all' products, or only 'marked' ones (Send to Cropster on the product)
  products?: 'all' | 'marked';
  size_option?: string;
  grind_option?: string;
  default_grind?: string;
  // send orders when they are 'submitted' or 'paid'
  send_orders_on?: 'submitted' | 'paid';
  customer_type?: 'RETAIL' | 'WHOLESALE';
  wholesale_group?: string;
}

// The subset of the Swell client this lib needs. Satisfied by the function's req.swell
// and by the app frontend Worker's Backend API client.
export interface SwellClient {
  get(url: string, query?: any): Promise<any>;
  put(url: string, data?: any): Promise<any>;
  post(url: string, data?: any): Promise<any>;
  settings(id?: string): Promise<any>;
}

export interface CropsterErrorDetail {
  code?: string;
  message?: string;
}

// Cropster API failure with its HTTP status, error code and item details
export class CropsterError extends Error {
  status: number;
  code?: string;
  details: CropsterErrorDetail[];
  constructor(message: string, status: number, code?: string, details: CropsterErrorDetail[] = []) {
    super(message);
    this.name = 'CropsterError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getSettings(rawSettings: any): CropsterSettings {
  return (rawSettings?.cropster ?? {}) as CropsterSettings;
}

export function hasCredentials(settings: CropsterSettings) {
  return Boolean(settings.client_id?.trim() && settings.client_secret?.trim());
}

// Message of a Cropster error, with the item details of a failed bulk request
export function errorMessage(err: unknown): string {
  if (err instanceof CropsterError && err.details.length) {
    return `${err.message}: ${err.details.map((detail) => detail.message || detail.code).join('; ')}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// Error caused by the record's data (not by credentials, limits or Cropster itself)
export function isRecordError(err: unknown): err is CropsterError {
  return err instanceof CropsterError && [400, 404, 422].includes(err.status);
}

// Send records with an externalId in batches of 50. One invalid record fails its whole batch
// (bulk_operation_failed), so that batch is resent one record at a time to find it.
// Record errors go to onFailed; other errors (auth, rate limit, server) are thrown.
export async function sendInBatches<T extends { externalId: string }>(
  client: CropsterClient,
  operation: string,
  resultKey: string,
  items: T[],
  onSynced: (item: T, synced: any) => void,
  onFailed: (item: T, err: CropsterError) => void,
) {
  const send = async (chunk: T[]) => {
    const { result } = await client.call(operation, { data: chunk });
    const byId = new Map((result?.[resultKey] ?? []).map((synced: any) => [synced.externalId, synced]));
    chunk.forEach((item) => onSynced(item, byId.get(item.externalId)));
  };

  for (let i = 0; i < items.length; i += MAX_BATCH) {
    const chunk = items.slice(i, i + MAX_BATCH);
    try {
      await send(chunk);
    } catch (err) {
      if (!isRecordError(err)) {
        throw err;
      }
      if (chunk.length === 1 || err.code !== 'bulk_operation_failed') {
        chunk.forEach((item) => onFailed(item, err));
        continue;
      }
      for (const item of chunk) {
        try {
          await send([item]);
        } catch (itemErr) {
          if (!isRecordError(itemErr)) {
            throw itemErr;
          }
          onFailed(item, itemErr);
        }
      }
    }
  }
}

// Access tokens are valid for 8 hours; reuse them while the Worker isolate lives
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearTokenCache() {
  tokenCache.clear();
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CropsterClient {
  private clientId: string;
  private clientSecret: string;
  private sleep: Sleep;

  constructor(settings: CropsterSettings, { sleep = defaultSleep }: { sleep?: Sleep } = {}) {
    if (!hasCredentials(settings)) {
      throw new CropsterError('Cropster Client ID and Client Secret are not set in app settings', 400);
    }
    this.clientId = settings.client_id!.trim();
    this.clientSecret = settings.client_secret!.trim();
    this.sleep = sleep;
  }

  private async token(): Promise<string> {
    const cached = tokenCache.get(this.clientId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    // scopes are separated by a URL-encoded space (%20), not '+'
    const body = [
      ['grant_type', 'client_credentials'],
      ['client_id', this.clientId],
      ['client_secret', this.clientSecret],
      ['scope', SCOPES.join(' ')],
    ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
      const reason = data?.error_description || data?.error || `HTTP ${res.status}`;
      throw new CropsterError(`Cropster authentication failed: ${reason}`, res.ok ? 401 : res.status, 'invalid_authentication');
    }

    // renew a minute before it expires
    const expiresIn = Number(data.expires_in) || 3600;
    tokenCache.set(this.clientId, { token: data.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 });
    return data.access_token;
  }

  // Call an RPC operation, e.g. 'mrp.order.setOrders'. Retries when rate limited.
  async call<T = any>(operation: string, payload: unknown): Promise<{ result: T; meta?: any }> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.token();
      const res = await fetch(`${API_BASE}/${operation}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data: any = await res.json().catch(() => null);

      if (res.status === 429 && attempt < 3) {
        await this.sleep(1000 * attempt);
        continue;
      }
      if (res.status === 401) {
        // the cached token may have been revoked
        tokenCache.delete(this.clientId);
      }
      if (!res.ok || data?.ok === false) {
        const error = data?.error ?? {};
        throw new CropsterError(
          `Cropster ${operation} failed (${res.status}): ${error.message || error.code || res.statusText || 'no details'}`,
          res.status,
          error.code,
          Array.isArray(error.data?.details) ? error.data.details : [],
        );
      }
      return { result: data?.result as T, meta: data?.meta };
    }
  }
}
