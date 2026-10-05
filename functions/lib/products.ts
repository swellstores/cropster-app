import {
  CropsterClient,
  CropsterError,
  errorMessage,
  sendInBatches,
  type CropsterSettings,
  type SwellClient,
} from './cropster';

// Package sizes Cropster accepts (coffeeOptions.packageSize), without the PACKAGE prefix
const PACKAGE_SIZES = new Set(`0G 1G 5G 6G 10G 12G 13_2G 14_2G 15G 20G 30G 40G 50G 60G 65G 70G 71G 75G 80G 85G 90G 95G
96G 100G 105G 110G 120G 121G 125G 140G 142G 150G 156_25G 164G 170G 175G 180G 200G 225G 227G 230G 250G 265G 285G 300G
310G 312_5G 333G 340G 350G 380G 400G 450G 454G 500G 600G 750G 676G 900G 950G 1KG 1_135KG 1_2KG 1_25KG 1_5KG 2KG 2_27KG
2_5KG 2_72KG 2_8KG 3KG 3_5KG 3_6KG 4KG 4_29KG 5KG 5_6KG 6KG 6_25KG 7KG 7_5KG 8KG 9KG 10KG 12KG 14KG 15KG 20KG 25KG 30KG
35KG 50KG 69KG 70KG 920KG 0_5LBS 1LBS 1_1LBS 1_5LBS 1_75LBS 2LBS 2_5LBS 3LBS 3_5LBS 3_75LBS 3_85LBS 4LBS 4_5LBS 5LBS 6LBS
7LBS 7_5LBS 8_5LBS 9LBS 10LBS 10_5LBS 11LBS 12LBS 12_5LBS 15LBS 16LBS 20LBS 21LBS 22_5LBS 24LBS 25LBS 30LBS 40LBS 50LBS
125LBS 800LBS 1OZ 2OZ 2_5OZ 3OZ 4OZ 5OZ 6OZ 7OZ 8OZ 9OZ 10OZ 10_5OZ 10_9OZ 11OZ 12OZ 12_07OZ 14OZ 16OZ 18OZ 22OZ 24OZ
35OZ 36OZ 45OZ 48OZ 72OZ 90OZ 120OZ 144OZ 6912OZ`.split(/\s+/));

const UNITS: Record<string, 'G' | 'KG' | 'LBS' | 'OZ'> = {
  g: 'G', gr: 'G', gram: 'G', grams: 'G',
  kg: 'KG', kgs: 'KG', kilo: 'KG', kilos: 'KG', kilogram: 'KG', kilograms: 'KG',
  lb: 'LBS', lbs: 'LBS', pound: 'LBS', pounds: 'LBS',
  oz: 'OZ', ounce: 'OZ', ounces: 'OZ',
};

const DEFAULT_SIZE_OPTION = 'Size, Weight';
const DEFAULT_GRIND_OPTION = 'Grind';
const DEFAULT_GRIND = 'Whole Bean';

// Includes all variants of each product in /products queries
export const PRODUCT_INCLUDE = {
  variants: {
    url: '/products:variants',
    params: {
      parent_id: 'id',
      limit: 1000,
    },
  },
};

export interface CropsterVariant {
  sku: string;
  coffeeOptions: { packageSize: string; grindStyle: string };
}

export interface CropsterProduct {
  externalId: string;
  name: string;
  variants: CropsterVariant[];
}

export interface SyncSummary {
  synced: number;
  skipped: number;
  failed: number;
  // per-record problems, shown to the merchant
  errors: { id: string; name: string; error: string }[];
}

const enumKey = (amount: number, unit: string) => `${String(Number(amount.toFixed(3))).replace('.', '_')}${unit}`;

// Package size enum for text like "250g", "12 oz", "1.5 kg", "2 lbs" or "Bag 1/2 lb"; null when unknown
export function parsePackageSize(text: unknown): string | null {
  if (typeof text !== 'string') {
    return null;
  }
  const match = text.toLowerCase().replace(',', '.')
    .match(/(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*(kilograms?|kilos?|kgs?|grams?|gr|g|pounds?|lbs?|ounces?|oz)\b/);
  if (!match) {
    return null;
  }
  const [num, den] = match[1].split('/').map((part) => Number(part.trim()));
  const amount = den ? num / den : num;
  const unit = UNITS[match[2]];
  if (!Number.isFinite(amount)) {
    return null;
  }

  const candidates = [enumKey(amount, unit)];
  // the same weight in the neighbouring unit, e.g. 1000g = 1KG, 0.5kg = 500G
  if (unit === 'G') candidates.push(enumKey(amount / 1000, 'KG'));
  if (unit === 'KG') candidates.push(enumKey(amount * 1000, 'G'));
  if (unit === 'LBS') candidates.push(enumKey(amount * 16, 'OZ'));
  if (unit === 'OZ') candidates.push(enumKey(amount / 16, 'LBS'));

  const found = candidates.find((key) => PACKAGE_SIZES.has(key));
  return found ? `PACKAGE${found}` : null;
}

// Option names from a setting like "Size, Weight", lowercased
function optionNames(setting: string | undefined, fallback: string) {
  return (setting?.trim() ? setting : fallback).split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
}

// Name of the variant's value for the first product option matching one of the names
function optionValue(product: any, variant: any, names: string[]): string | undefined {
  const option = (product.options ?? []).find((opt: any) => names.includes(String(opt.name ?? '').trim().toLowerCase()));
  const valueIds: string[] = variant?.option_value_ids ?? [];
  return option?.values?.find((value: any) => valueIds.includes(value.id))?.name;
}

export function appData(record: any) {
  return record?.$app?.cropster ?? {};
}

// Products to send: all, or only those with Send to Cropster on
export function isProductIncluded(product: any, settings: CropsterSettings) {
  return settings.products !== 'marked' || appData(product).cropster_enabled === true;
}

// Cropster product with one variant per active Swell variant (or the product itself) that has a SKU and package size
export function buildCropsterProduct(product: any, settings: CropsterSettings): { product?: CropsterProduct; error?: string } {
  const sizeNames = optionNames(settings.size_option, DEFAULT_SIZE_OPTION);
  const grindNames = optionNames(settings.grind_option, DEFAULT_GRIND_OPTION);
  const defaultGrind = settings.default_grind?.trim() || DEFAULT_GRIND;
  const fallbackSize = appData(product).cropster_package_size;

  const swellVariants: any[] = (product.variants?.results ?? []).filter((variant: any) => variant.active !== false);
  const sources = swellVariants.length ? swellVariants : [null];

  const variants: CropsterVariant[] = [];
  const problems: string[] = [];
  for (const variant of sources) {
    const sku = (variant ? variant.sku : product.sku)?.trim();
    const label = variant?.name || product.name;
    if (!sku) {
      problems.push(`${label}: no SKU`);
      continue;
    }
    const sizeText = variant ? optionValue(product, variant, sizeNames) : undefined;
    const packageSize = parsePackageSize(sizeText) ?? parsePackageSize(fallbackSize)
      ?? parsePackageSize(variant?.name) ?? parsePackageSize(product.name);
    if (!packageSize) {
      problems.push(`${label}: unknown package size${sizeText ? ` "${sizeText}"` : ''}`);
      continue;
    }
    const grindStyle = (variant ? optionValue(product, variant, grindNames) : undefined)?.trim() || defaultGrind;
    variants.push({ sku, coffeeOptions: { packageSize, grindStyle } });
  }

  if (!variants.length) {
    return { error: problems.join('; ') || 'No variants to send' };
  }
  return { product: { externalId: product.id, name: product.name, variants } };
}

// Status stored on the Swell product, without triggering product events
function statusUpdate(productId: string, values: Record<string, unknown>) {
  return {
    url: `/products/${productId}`,
    method: 'put',
    data: { $events: false, $app: { cropster: { ...values, cropster_synced_at: new Date().toISOString() } } },
  };
}

// Send products to Cropster in batches of 50 and store the result on each product
export async function syncProducts(
  swell: SwellClient,
  client: CropsterClient,
  settings: CropsterSettings,
  products: any[],
): Promise<SyncSummary> {
  const summary: SyncSummary = { synced: 0, skipped: 0, failed: 0, errors: [] };
  const updates: object[] = [];
  const ready: { swell: any; cropster: CropsterProduct }[] = [];

  for (const product of products) {
    if (!isProductIncluded(product, settings)) {
      summary.skipped++;
      continue;
    }
    const built = buildCropsterProduct(product, settings);
    if (built.product) {
      ready.push({ swell: product, cropster: built.product });
    } else {
      summary.skipped++;
      summary.errors.push({ id: product.id, name: product.name, error: built.error! });
      updates.push(statusUpdate(product.id, { cropster_error: built.error }));
    }
  }

  const byExternalId = new Map(ready.map((item) => [item.cropster.externalId, item.swell]));
  try {
    await sendInBatches(
      client,
      'mrp.product.syncProducts',
      'syncedProducts',
      ready.map((item) => item.cropster),
      (cropster, synced) => {
        summary.synced++;
        updates.push(statusUpdate(cropster.externalId, {
          cropster_id: synced?.id ?? null,
          cropster_review_state: synced?.reviewState ?? null,
          cropster_error: null,
        }));
      },
      (cropster, err) => {
        const error = errorMessage(err);
        summary.failed++;
        summary.errors.push({ id: cropster.externalId, name: byExternalId.get(cropster.externalId)?.name, error });
        updates.push(statusUpdate(cropster.externalId, { cropster_error: error }));
      },
    );
  } finally {
    // keep the status of products already sent, even when a later batch fails
    if (updates.length) {
      await swell.post('/:batch', updates);
    }
  }
  return summary;
}

// Load one product with its variants and send it to Cropster
export async function syncProductById(swell: SwellClient, client: CropsterClient, settings: CropsterSettings, productId: string) {
  const product = await swell.get(`/products/${productId}`, { include: PRODUCT_INCLUDE });
  if (!product?.id) {
    throw new CropsterError(`Product ${productId} not found`, 404);
  }
  return syncProducts(swell, client, settings, [product]);
}
