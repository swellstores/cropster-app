import { errorMessage } from './lib/cropster';
import { ORDER_EXPAND, syncOrders } from './lib/orders';
import { PRODUCT_INCLUDE, syncProducts, type SyncSummary } from './lib/products';
import { MAX_SELECTION, SyncError, syncClient } from './lib/sync';

export const config: SwellConfig = {
  description: 'Send selected products or orders to Cropster',
  action: true,
};

const RECORD_ID = /^[0-9a-f]{24}$/i;

// Record or bulk action on products and orders: send them to Cropster now
export default async function (req: SwellRequest) {
  const action = req.data.$action;
  const collection = action?.collection;
  if (collection !== 'products' && collection !== 'orders') {
    throw new SwellError('Run this action from products or orders', { status: 400 });
  }

  let query: Record<string, any>;
  if (action?.source === 'record') {
    if (!action.record_id || !RECORD_ID.test(action.record_id)) {
      throw new SwellError('Invalid record', { status: 400 });
    }
    query = { id: action.record_id };
  } else if (action?.source === 'bulk' && action.selection?.query) {
    query = action.selection.query;
  } else {
    throw new SwellError('Select products or orders to send', { status: 400 });
  }

  let summary: SyncSummary;
  try {
    const { settings, client } = await syncClient(req.swell);
    const found = await req.swell.get(`/${collection}`, {
      ...query,
      limit: MAX_SELECTION + 1,
      ...(collection === 'products' ? { include: PRODUCT_INCLUDE } : { expand: ORDER_EXPAND }),
    });
    const records: any[] = found?.results ?? [];
    if (!records.length) {
      throw new SyncError(`No ${collection} found`, 404);
    }
    if (records.length > MAX_SELECTION) {
      throw new SyncError(`Select up to ${MAX_SELECTION} ${collection}, or use Cropster sync in the sidebar`, 400);
    }
    summary = collection === 'products'
      ? await syncProducts(req.swell, client, settings, records)
      : await syncOrders(req.swell, client, settings, records);
  } catch (err) {
    throw new SwellError(err instanceof SyncError ? err.message : `Cropster: ${errorMessage(err)}`, {
      status: err instanceof SyncError ? err.status : 502,
    });
  }

  return { message: summaryMessage(collection, summary) };
}

// e.g. "Sent 2 products to Cropster. 1 skipped. Ethiopia: unknown package size"
export function summaryMessage(collection: string, { synced, skipped, failed, errors }: SyncSummary) {
  const noun = (count: number) => `${count} ${count === 1 ? collection.replace(/s$/, '') : collection}`;
  const parts = [synced ? `Sent ${noun(synced)} to Cropster.` : `No ${collection} sent to Cropster.`];
  if (failed) parts.push(`${failed} failed.`);
  if (skipped) parts.push(`${skipped} skipped${collection === 'orders' ? ' (not ready, canceled, already in production or without Cropster products)' : ''}.`);
  if (errors.length) parts.push(errors.slice(0, 3).map((e) => `${e.name}: ${e.error}`).join(' · '));
  return parts.join(' ');
}
