import { CropsterClient, getSettings, hasCredentials, type SwellClient } from './cropster';
import { PRODUCT_INCLUDE, syncProducts, type SyncSummary } from './products';
import { ORDER_EXPAND, syncOrders } from './orders';

// Records the initial sync sends to Cropster, in the required order: orders reference product SKUs
export const SYNC_ENTITIES = ['products', 'orders'] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

// Cropster accepts at most 50 records per request, so a page is one request
export const PAGE_SIZES = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 50;

// Most records a dashboard action sends at once, so it finishes within the function timeout
export const MAX_SELECTION = 50;

// Invalid sync request or app configuration, with the HTTP status to return
export class SyncError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface SyncPageResult extends SyncSummary {
  entity: SyncEntity;
  page: number;
  limit: number;
  count: number;
  done: boolean;
}

export interface SyncOptions {
  // ISO date; only records with date_created >= this date are synced
  createdAfter?: string;
  // records per page, one of PAGE_SIZES
  limit?: number;
}

export function parseEntity(value: unknown): SyncEntity {
  if (!(SYNC_ENTITIES as readonly unknown[]).includes(value)) {
    throw new SyncError(`Invalid entity, use one of ${SYNC_ENTITIES.join(', ')}`, 400);
  }
  return value as SyncEntity;
}

// Validate an optional page size, defaulting to DEFAULT_PAGE_SIZE
export function parsePageSize(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_PAGE_SIZE;
  }
  const size = Number(value);
  if (!(PAGE_SIZES as readonly number[]).includes(size)) {
    throw new SyncError(`Invalid page size, use one of ${PAGE_SIZES.join(', ')}`, 400);
  }
  return size;
}

// Normalize an optional date filter to ISO, rejecting anything Date can't parse
export function parseCreatedAfter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new SyncError('Invalid created_after date', 400);
  }
  return date.toISOString();
}

// Settings and client for a sync, or a SyncError explaining what to configure
export async function syncClient(swell: SwellClient) {
  const settings = getSettings(await swell.settings());
  if (!hasCredentials(settings)) {
    throw new SyncError('Cropster Client ID and Client Secret are not set in app settings', 400);
  }
  if (!settings.enabled) {
    throw new SyncError('Cropster integration is disabled in app settings', 400);
  }
  return { settings, client: new CropsterClient(settings) };
}

// Send one page of products or orders to Cropster.
// Called page by page from the app frontend so each call stays short.
export async function syncEntityPage(
  swell: SwellClient,
  entity: SyncEntity,
  page: number,
  { createdAfter, limit = DEFAULT_PAGE_SIZE }: SyncOptions = {},
): Promise<SyncPageResult> {
  entity = parseEntity(entity);
  if (!Number.isInteger(page) || page < 1) {
    throw new SyncError('Invalid page', 400);
  }
  limit = parsePageSize(limit);
  const { settings, client } = await syncClient(swell);

  const query = {
    ...(createdAfter ? { date_created: { $gte: createdAfter } } : {}),
    // stable order so pages don't shift while the sync walks them
    sort: 'date_created asc',
    limit,
    page,
  };

  let result: any;
  let summary: SyncSummary;
  if (entity === 'products') {
    result = await swell.get('/products', { ...query, include: PRODUCT_INCLUDE });
    summary = await syncProducts(swell, client, settings, result?.results ?? []);
  } else {
    result = await swell.get('/orders', { ...query, expand: ORDER_EXPAND });
    summary = await syncOrders(swell, client, settings, result?.results ?? []);
  }

  const done = (result?.results?.length ?? 0) < limit;
  if (done) {
    console.log(`Cropster: ${entity} sync finished on page ${page}`);
  }

  return {
    entity,
    page,
    limit,
    count: result?.count || 0,
    ...summary,
    done,
  };
}
