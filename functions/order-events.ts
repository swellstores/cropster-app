import { CropsterClient, errorMessage, getSettings, hasCredentials, isRecordError } from './lib/cropster';
import { ORDER_EXPAND, isOrderReady, syncOrders } from './lib/orders';
import { appData } from './lib/products';

export const config: SwellConfig = {
  description: 'Send orders to Cropster as production orders',
  model: {
    events: ['order.submitted', 'order.paid', 'order.updated'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const event = data.$event?.type;

  const settings = getSettings(await swell.settings());
  if (!settings.enabled || !hasCredentials(settings)) {
    return;
  }

  // the order's own event under "Send orders when"; updates only matter when items change
  const sendEvent = settings.send_orders_on === 'submitted' ? 'order.submitted' : 'order.paid';
  if (event === 'order.updated' ? !('items' in (data.$event?.data ?? {})) : event !== sendEvent) {
    return;
  }

  const order = await swell.get(`/orders/${data.id}`, { expand: ORDER_EXPAND });
  if (!order?.id || !isOrderReady(order, settings)) {
    return;
  }
  // already sent; item changes are resent by order.updated
  if (event !== 'order.updated' && appData(order).cropster_id) {
    return;
  }

  try {
    const client = new CropsterClient(settings);
    const summary = await syncOrders(swell, client, settings, [order]);
    if (summary.synced) {
      console.log(`Cropster: sent order ${order.number}`);
    } else if (summary.errors.length) {
      console.log(`Cropster: order ${order.number} not sent - ${summary.errors[0].error}`);
    }
  } catch (err) {
    console.error(`Cropster: failed to send order ${order.number} - ${errorMessage(err)}`);
    // 4xx means the order data or credentials are wrong; retrying won't help
    if (isRecordError(err) || (err as any)?.status === 401 || (err as any)?.status === 403) {
      return;
    }
    throw err;
  }
}
