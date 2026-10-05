import {
  CropsterClient,
  CropsterError,
  errorMessage,
  sendInBatches,
  type CropsterSettings,
  type SwellClient,
} from './cropster';
import { appData, isProductIncluded, type SyncSummary } from './products';

export const ORDER_EXPAND = ['account', 'items.product', 'items.variant'];

// Lifecycle states of a Cropster production order
export const ORDER_STATES = ['OPEN', 'SCHEDULED', 'IN_PROGRESS', 'ROASTED', 'COMPLETED'] as const;

export interface CropsterOrder {
  externalId: string;
  orderDate: string;
  customer?: string;
  customerType: 'RETAIL' | 'WHOLESALE';
  orderItems: { sku: string; quantity: number }[];
}

// ISO 8601 without milliseconds, as Cropster expects (YYYY-MM-DDTHH:mm:ssZ)
export function cropsterDate(value: string | number | Date) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Items of products sent to Cropster, by SKU, with quantities of the same SKU added up
export function orderItems(order: any, settings: CropsterSettings) {
  const quantities = new Map<string, number>();
  for (const item of order.items ?? []) {
    if (item.product && !isProductIncluded(item.product, settings)) {
      continue;
    }
    const sku = (item.variant?.sku || item.product?.sku || item.sku)?.trim();
    const quantity = Math.round(Number(item.quantity) || 0);
    if (sku && quantity > 0) {
      quantities.set(sku, (quantities.get(sku) ?? 0) + quantity);
    }
  }
  return [...quantities].map(([sku, quantity]) => ({ sku, quantity }));
}

export function customerType(order: any, settings: CropsterSettings): 'RETAIL' | 'WHOLESALE' {
  const group = settings.wholesale_group?.trim();
  if (group && order.account?.group === group) {
    return 'WHOLESALE';
  }
  return settings.customer_type === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
}

function customerName(order: any): string | undefined {
  const { billing = {}, shipping = {}, account = {} } = order;
  const name = billing.company || shipping.company || account.name || billing.name || shipping.name
    || [account.first_name, account.last_name].filter(Boolean).join(' ');
  return name?.trim() || undefined;
}

// Whether the order is ready for Cropster under the "Send orders when" setting
export function isOrderReady(order: any, settings: CropsterSettings) {
  if (!order || order.canceled || order.status === 'canceled' || order.draft) {
    return false;
  }
  return settings.send_orders_on === 'submitted' || order.paid === true;
}

// Cropster production order for a Swell order, or why it is not sent
export function buildCropsterOrder(order: any, settings: CropsterSettings): { order?: CropsterOrder; skip?: string } {
  const items = orderItems(order, settings);
  if (!items.length) {
    return { skip: 'No items with Cropster products and SKUs' };
  }
  const customer = customerName(order);
  return {
    order: {
      externalId: String(order.number ?? order.id),
      orderDate: cropsterDate(order.date_created ?? Date.now()),
      ...(customer ? { customer } : {}),
      customerType: customerType(order, settings),
      orderItems: items,
    },
  };
}

// Status stored on the Swell order, without triggering order events
function statusUpdate(orderId: string, values: Record<string, unknown>) {
  return {
    url: `/orders/${orderId}`,
    method: 'put',
    data: { $events: false, $app: { cropster: values } },
  };
}

// Send orders to Cropster in batches of 50 and store the result on each order.
// Orders Cropster has started processing can't be changed, so they are skipped.
export async function syncOrders(
  swell: SwellClient,
  client: CropsterClient,
  settings: CropsterSettings,
  orders: any[],
): Promise<SyncSummary> {
  const summary: SyncSummary = { synced: 0, skipped: 0, failed: 0, errors: [] };
  const updates: object[] = [];
  const ready: { swell: any; cropster: CropsterOrder }[] = [];

  for (const order of orders) {
    const state = appData(order).cropster_state;
    if (!isOrderReady(order, settings) || (state && state !== 'OPEN')) {
      summary.skipped++;
      continue;
    }
    const built = buildCropsterOrder(order, settings);
    if (built.order) {
      ready.push({ swell: order, cropster: built.order });
    } else {
      summary.skipped++;
    }
  }

  const byExternalId = new Map(ready.map((item) => [item.cropster.externalId, item.swell]));
  try {
    await sendInBatches(
      client,
      'mrp.order.setOrders',
      'syncedOrders',
      ready.map((item) => item.cropster),
      (cropster, synced) => {
        const order = byExternalId.get(cropster.externalId);
        summary.synced++;
        updates.push(statusUpdate(order.id, {
          cropster_id: synced?.id ?? appData(order).cropster_id ?? null,
          cropster_state: appData(order).cropster_state || 'OPEN',
          cropster_synced_at: new Date().toISOString(),
          cropster_error: null,
        }));
      },
      (cropster, err) => {
        const order = byExternalId.get(cropster.externalId);
        const error = errorMessage(err);
        summary.failed++;
        summary.errors.push({ id: order.id, name: `Order ${cropster.externalId}`, error });
        updates.push(statusUpdate(order.id, { cropster_error: error, cropster_synced_at: new Date().toISOString() }));
      },
    );
  } finally {
    // keep the status of orders already sent, even when a later batch fails
    if (updates.length) {
      await swell.post('/:batch', updates);
    }
  }
  return summary;
}

// Load one order with its items and send it to Cropster
export async function syncOrderById(swell: SwellClient, client: CropsterClient, settings: CropsterSettings, orderId: string) {
  const order = await swell.get(`/orders/${orderId}`, { expand: ORDER_EXPAND });
  if (!order?.id) {
    throw new CropsterError(`Order ${orderId} not found`, 404);
  }
  return syncOrders(swell, client, settings, [order]);
}

export interface PollResult {
  checked: number;
  updated: number;
}

// Copy the state of Cropster orders changed since `since` to their Swell orders
export async function pollOrderStates(swell: SwellClient, client: CropsterClient, since: Date, maxPages = 20): Promise<PollResult> {
  const changed = new Map<string, any>();
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const { result, meta }: { result: any; meta?: any } = await client.call('mrp.order.listOrders', {
      params: {
        filter: { lastModifiedDate: { from: cropsterDate(since) } },
        pagination: { limit: 100, after },
      },
    });
    for (const order of result?.orders ?? []) {
      // orders created in the Cropster UI have no externalId
      if (order.externalId && !changed.has(order.externalId)) {
        changed.set(order.externalId, order);
      }
    }
    after = meta?.pagination?.endCursor ?? null;
    if (!after) {
      break;
    }
  }

  let updated = 0;
  const numbers = [...changed.keys()];
  for (let i = 0; i < numbers.length; i += 100) {
    const chunk = numbers.slice(i, i + 100);
    const found = await swell.get('/orders', { number: { $in: chunk }, limit: 100 });
    const updates = (found?.results ?? []).flatMap((order: any) => {
      const cropster = changed.get(String(order.number));
      const current = appData(order);
      if (!cropster || (current.cropster_state === cropster.state && current.cropster_status === cropster.status)) {
        return [];
      }
      return [statusUpdate(order.id, {
        cropster_id: cropster.id ?? current.cropster_id ?? null,
        cropster_state: cropster.state ?? null,
        cropster_status: cropster.status ?? null,
        cropster_modified_at: cropster.lastModifiedDate ?? null,
      })];
    });
    if (updates.length) {
      await swell.post('/:batch', updates);
      updated += updates.length;
    }
  }

  return { checked: changed.size, updated };
}
