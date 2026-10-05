import { CropsterClient, errorMessage, getSettings, hasCredentials } from './lib/cropster';
import { pollOrderStates } from './lib/orders';

export const config: SwellConfig = {
  description: 'Copy Cropster production order states to Swell orders',
  cron: {
    schedule: '*/15 * * * *',
  },
};

// Look back further than the schedule so a missed or slow run loses no changes
export const LOOKBACK_MS = 2 * 60 * 60 * 1000;

export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());
  if (!settings.enabled || !hasCredentials(settings)) {
    return;
  }

  try {
    const client = new CropsterClient(settings);
    const { checked, updated } = await pollOrderStates(req.swell, client, new Date(Date.now() - LOOKBACK_MS));
    if (updated) {
      console.log(`Cropster: updated ${updated} of ${checked} changed orders`);
    }
  } catch (err) {
    console.error(`Cropster: order status check failed - ${errorMessage(err)}`);
  }
}
