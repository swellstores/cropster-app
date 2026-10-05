import { CropsterClient, errorMessage, getSettings, hasCredentials, isRecordError } from './lib/cropster';
import { syncProductById } from './lib/products';

export const config: SwellConfig = {
  description: 'Send product changes to Cropster',
  model: {
    events: ['product.created', 'product.updated', 'product.variant.created', 'product.variant.updated'],
  },
};

// Fields this app writes on products; changes to them alone don't need a sync
const STATUS_FIELDS = ['cropster_id', 'cropster_review_state', 'cropster_synced_at', 'cropster_error'];

// True when an update only changed the Cropster status this app stored
export function isStatusOnlyChange(changes: any): boolean {
  const keys = Object.keys(changes ?? {}).filter((key) => !['id', 'date_updated'].includes(key));
  if (keys.length !== 1 || keys[0] !== '$app') {
    return false;
  }
  const apps = Object.keys(changes.$app ?? {});
  if (apps.length !== 1 || apps[0] !== 'cropster') {
    return false;
  }
  return Object.keys(changes.$app.cropster ?? {}).every((key) => STATUS_FIELDS.includes(key));
}

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const event = data.$event?.type;

  const settings = getSettings(await swell.settings());
  if (!settings.enabled || !hasCredentials(settings)) {
    return;
  }
  if (event === 'product.updated' && isStatusOnlyChange(data.$event?.data)) {
    return;
  }

  let productId: string | undefined = data.id;
  if (event?.startsWith('product.variant.')) {
    productId = data.parent_id ?? (await swell.get(`/products:variants/${data.id}`))?.parent_id;
  }
  if (!productId) {
    console.error(`Cropster: no product for ${event} ${data.id}`);
    return;
  }

  try {
    const client = new CropsterClient(settings);
    const summary = await syncProductById(swell, client, settings, productId);
    if (summary.synced) {
      console.log(`Cropster: sent product ${productId}`);
    } else if (summary.errors.length) {
      console.log(`Cropster: product ${productId} not sent - ${summary.errors[0].error}`);
    }
  } catch (err) {
    console.error(`Cropster: failed to send product ${productId} - ${errorMessage(err)}`);
    // 4xx means the product data or credentials are wrong; retrying won't help
    if (isRecordError(err) || (err as any)?.status === 401 || (err as any)?.status === 403) {
      return;
    }
    throw err;
  }
}
