import { CropsterClient, errorMessage, getSettings, hasCredentials } from './lib/cropster';

export const config: SwellConfig = {
  description: 'Check the Cropster credentials',
  action: true,
};

// Settings action: request a token with the app's scopes and read one order
export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());
  if (!hasCredentials(settings)) {
    throw new SwellError('Enter the Cropster Client ID and Client Secret, save, then test again.', { status: 400 });
  }

  try {
    const client = new CropsterClient(settings);
    await client.call('mrp.order.listOrders', { params: { pagination: { limit: 1 } } });
  } catch (err) {
    throw new SwellError(`Cropster connection failed: ${errorMessage(err)}`, { status: 400 });
  }

  return {
    message: settings.enabled
      ? 'Connected to Cropster.'
      : 'Connected to Cropster. Turn on Enable Integration to start syncing.',
  };
}
