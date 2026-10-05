import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CropsterClient, clearTokenCache } from "../../functions/lib/cropster";
import {
  PRODUCT_INCLUDE,
  buildCropsterProduct,
  isProductIncluded,
  parsePackageSize,
  syncProductById,
  syncProducts,
} from "../../functions/lib/products";
import { batchUpdates, bulkFailed, makeProduct, mockCropster, mockSwell, ok, rpcCalls, settings } from "../helpers/cropster-fixtures";

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsePackageSize", () => {
  it.each([
    ["250g", "PACKAGE250G"],
    ["250 g", "PACKAGE250G"],
    ["340 grams", "PACKAGE340G"],
    ["1kg", "PACKAGE1KG"],
    ["1.5 kg", "PACKAGE1_5KG"],
    ["2,5 kg", "PACKAGE2_5KG"],
    ["1000g", "PACKAGE1KG"],
    ["0.5 kg", "PACKAGE500G"],
    ["12 oz", "PACKAGE12OZ"],
    ["12oz bag", "PACKAGE12OZ"],
    ["2 lb", "PACKAGE2LBS"],
    ["5 lbs", "PACKAGE5LBS"],
    ["1 pound", "PACKAGE1LBS"],
    ["1/2 lb", "PACKAGE0_5LBS"],
    ["32 oz", "PACKAGE2LBS"],
    ["Bag (250g)", "PACKAGE250G"],
  ])("%s → %s", (text, expected) => {
    expect(parsePackageSize(text)).toBe(expected);
  });

  it.each([["Large"], ["251g"], ["3 cups"], [""], [undefined], [42]])("returns null for %j", (text) => {
    expect(parsePackageSize(text)).toBeNull();
  });
});

describe("buildCropsterProduct", () => {
  it("builds one variant per Swell variant with package size and grind from options", () => {
    expect(buildCropsterProduct(makeProduct(), settings as any)).toEqual({
      product: {
        externalId: "prod_1",
        name: "Ethiopia Natural",
        variants: [
          { sku: "ETH-250-WB", coffeeOptions: { packageSize: "PACKAGE250G", grindStyle: "Whole Bean" } },
          { sku: "ETH-1K-ESP", coffeeOptions: { packageSize: "PACKAGE1KG", grindStyle: "Espresso" } },
        ],
      },
    });
  });

  it("matches option names from the settings, ignoring case", () => {
    const product = makeProduct();
    product.options[0].name = "bag weight";
    product.options[1].name = "Mahlgrad";

    const built = buildCropsterProduct(product, { ...settings, size_option: "Bag Weight", grind_option: "Mahlgrad" } as any);

    expect(built.product?.variants.map((v) => v.coffeeOptions)).toEqual([
      { packageSize: "PACKAGE250G", grindStyle: "Whole Bean" },
      { packageSize: "PACKAGE1KG", grindStyle: "Espresso" },
    ]);
  });

  it("uses the default grind and the product package size when options are missing", () => {
    const product = makeProduct({
      options: [],
      variants: { results: [{ id: "v", name: "Blend", sku: "BLEND", option_value_ids: [] }] },
      $app: { cropster: { cropster_package_size: "12 oz" } },
    });

    expect(buildCropsterProduct(product, { ...settings, default_grind: "Filter" } as any).product?.variants).toEqual([
      { sku: "BLEND", coffeeOptions: { packageSize: "PACKAGE12OZ", grindStyle: "Filter" } },
    ]);
  });

  it("sends a product without variants as one variant with the product SKU", () => {
    const product = makeProduct({ name: "Colombia 500g", options: [], variants: { results: [] }, sku: "COL" });

    expect(buildCropsterProduct(product, {} as any).product?.variants).toEqual([
      { sku: "COL", coffeeOptions: { packageSize: "PACKAGE500G", grindStyle: "Whole Bean" } },
    ]);
  });

  it("skips inactive variants and variants without SKU or package size", () => {
    const product = makeProduct();
    product.variants.results.push(
      { id: "v3", name: "No sku", sku: "", option_value_ids: ["val_250"] } as any,
      { id: "v4", name: "Off", sku: "OFF", option_value_ids: ["val_250"], active: false } as any,
    );
    product.options[0].values[1].name = "Large";
    product.variants.results[1].name = "Ethiopia Large Espresso";

    const built = buildCropsterProduct(product, settings as any);

    expect(built.product?.variants.map((v) => v.sku)).toEqual(["ETH-250-WB"]);
  });

  it("explains why a product has nothing to send", () => {
    const product = makeProduct({ name: "Mug", sku: "MUG", options: [], variants: { results: [] } });

    expect(buildCropsterProduct(product, settings as any)).toEqual({ error: "Mug: unknown package size" });
    expect(buildCropsterProduct({ ...product, sku: "" }, settings as any)).toEqual({ error: "Mug: no SKU" });
  });
});

describe("isProductIncluded", () => {
  it("includes all products, or only marked ones", () => {
    const marked = { $app: { cropster: { cropster_enabled: true } } };
    expect(isProductIncluded({}, settings as any)).toBe(true);
    expect(isProductIncluded({}, { products: "marked" })).toBe(false);
    expect(isProductIncluded(marked, { products: "marked" })).toBe(true);
  });
});

describe("syncProducts", () => {
  it("sends products and stores the Cropster ID and review state without triggering events", async () => {
    const fetchMock = mockCropster({
      "mrp.product.syncProducts": ok({ syncedProducts: [{ id: "c1", externalId: "prod_1", reviewState: "UNREVIEWED" }] }),
    });
    const swell = mockSwell();

    const summary = await syncProducts(swell, new CropsterClient(settings as any), settings as any, [makeProduct()]);

    expect(summary).toEqual({ synced: 1, skipped: 0, failed: 0, errors: [] });
    expect(rpcCalls(fetchMock)[0].body.data[0].externalId).toBe("prod_1");
    expect(batchUpdates(swell)).toEqual([
      {
        url: "/products/prod_1",
        method: "put",
        data: {
          $events: false,
          $app: {
            cropster: {
              cropster_id: "c1",
              cropster_review_state: "UNREVIEWED",
              cropster_error: null,
              cropster_synced_at: expect.any(String),
            },
          },
        },
      },
    ]);
  });

  it("records why products were skipped and does not call Cropster for them", async () => {
    const fetchMock = mockCropster();
    const swell = mockSwell();
    const mug = makeProduct({ id: "mug", name: "Mug", options: [], variants: { results: [] } });

    const summary = await syncProducts(swell, new CropsterClient(settings as any), settings as any, [mug]);

    expect(summary).toEqual({ synced: 0, skipped: 1, failed: 0, errors: [{ id: "mug", name: "Mug", error: "Mug: unknown package size" }] });
    expect(rpcCalls(fetchMock)).toHaveLength(0);
    expect(batchUpdates(swell)[0].data.$app.cropster.cropster_error).toBe("Mug: unknown package size");
  });

  it("skips unmarked products quietly in marked mode", async () => {
    const swell = mockSwell();
    mockCropster();

    const summary = await syncProducts(swell, new CropsterClient(settings as any), { ...settings, products: "marked" } as any, [makeProduct()]);

    expect(summary).toEqual({ synced: 0, skipped: 1, failed: 0, errors: [] });
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("stores the Cropster error on the failed product", async () => {
    mockCropster({ "mrp.product.syncProducts": bulkFailed });
    const swell = mockSwell();

    const summary = await syncProducts(swell, new CropsterClient(settings as any), settings as any, [makeProduct()]);

    expect(summary.failed).toBe(1);
    expect(summary.errors[0].error).toContain("Unknown SKU");
    expect(batchUpdates(swell)[0].data.$app.cropster.cropster_error).toContain("Unknown SKU");
  });

  it("saves the status of products already sent before rethrowing a server error", async () => {
    mockCropster({
      "mrp.product.syncProducts": [
        ok({ syncedProducts: [] }),
        { status: 500, body: { ok: false, error: { code: "server_error" } } },
      ],
    });
    const swell = mockSwell();
    const products = Array.from({ length: 51 }, (_, i) => makeProduct({ id: `p${i}` }));

    await expect(syncProducts(swell, new CropsterClient(settings as any), settings as any, products)).rejects.toMatchObject({ status: 500 });
    expect(batchUpdates(swell)).toHaveLength(50);
  });

  it("loads a product with its variants by ID", async () => {
    mockCropster({ "mrp.product.syncProducts": ok({ syncedProducts: [] }) });
    const swell = mockSwell({ "/products/prod_1": makeProduct() });

    await syncProductById(swell, new CropsterClient(settings as any), settings as any, "prod_1");

    expect(swell.get).toHaveBeenCalledWith("/products/prod_1", { include: PRODUCT_INCLUDE });
    await expect(syncProductById(mockSwell(), new CropsterClient(settings as any), settings as any, "x")).rejects.toThrow("Product x not found");
  });
});
