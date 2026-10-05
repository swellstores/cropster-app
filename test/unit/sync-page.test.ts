import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokenCache } from "../../functions/lib/cropster";
import {
  DEFAULT_PAGE_SIZE,
  SyncError,
  parseCreatedAfter,
  parseEntity,
  parsePageSize,
  syncClient,
  syncEntityPage,
} from "../../functions/lib/sync";
import { PRODUCT_INCLUDE } from "../../functions/lib/products";
import { ORDER_EXPAND } from "../../functions/lib/orders";
import { makeOrder, makeProduct, mockCropster, mockSwell, ok, rpcCalls, settings } from "../helpers/cropster-fixtures";

beforeEach(() => {
  clearTokenCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request parsing", () => {
  it("accepts products and orders only", () => {
    expect(parseEntity("products")).toBe("products");
    expect(parseEntity("orders")).toBe("orders");
    expect(() => parseEntity("contacts")).toThrow("Invalid entity, use one of products, orders");
  });

  it("accepts Cropster page sizes and defaults to 50", () => {
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("")).toBe(50);
    expect(parsePageSize("25")).toBe(25);
    expect(() => parsePageSize(100)).toThrow("Invalid page size, use one of 10, 25, 50");
  });

  it("normalizes the date filter", () => {
    expect(parseCreatedAfter("")).toBeUndefined();
    expect(parseCreatedAfter("2026-09-01T00:00:00+02:00")).toBe("2026-08-31T22:00:00.000Z");
    expect(() => parseCreatedAfter("yesterday")).toThrow(SyncError);
    expect(() => parseCreatedAfter(123)).toThrow("Invalid created_after date");
  });
});

describe("syncClient", () => {
  it.each([
    [{}, "Cropster Client ID and Client Secret are not set in app settings"],
    [{ ...settings, enabled: false }, "Cropster integration is disabled in app settings"],
  ])("explains what to configure: %j", async (cropster, message) => {
    await expect(syncClient(mockSwell({}, cropster))).rejects.toMatchObject({ message, status: 400 });
  });
});

describe("syncEntityPage", () => {
  it("sends one page of products in a stable order", async () => {
    const fetchMock = mockCropster({
      "mrp.product.syncProducts": ok({ syncedProducts: [{ id: "c1", externalId: "prod_1" }] }),
    });
    const swell = mockSwell({ "/products": { count: 120, results: [makeProduct()] } });

    const result = await syncEntityPage(swell, "products", 3, { limit: 25, createdAfter: "2026-01-01T00:00:00.000Z" });

    expect(result).toEqual({
      entity: "products", page: 3, limit: 25, count: 120, synced: 1, skipped: 0, failed: 0, errors: [], done: true,
    });
    expect(swell.get).toHaveBeenCalledWith("/products", {
      date_created: { $gte: "2026-01-01T00:00:00.000Z" },
      sort: "date_created asc",
      limit: 25,
      page: 3,
      include: PRODUCT_INCLUDE,
    });
    expect(rpcCalls(fetchMock)).toHaveLength(1);
  });

  it("sends one page of orders and is not done while pages are full", async () => {
    mockCropster({ "mrp.order.setOrders": ok({ syncedOrders: [] }) });
    const orders = Array.from({ length: 10 }, (_, i) => makeOrder({ id: `o${i}`, number: `${i}` }));
    const swell = mockSwell({ "/orders": { count: 30, results: orders } });

    const result = await syncEntityPage(swell, "orders", 1, { limit: 10 });

    expect(result).toMatchObject({ entity: "orders", count: 30, synced: 10, done: false });
    expect(swell.get).toHaveBeenCalledWith("/orders", { sort: "date_created asc", limit: 10, page: 1, expand: ORDER_EXPAND });
  });

  it("finishes on an empty page without calling Cropster", async () => {
    const fetchMock = mockCropster();

    const result = await syncEntityPage(mockSwell({ "/orders": { count: 0, results: [] } }), "orders", 1);

    expect(result).toMatchObject({ synced: 0, done: true, limit: DEFAULT_PAGE_SIZE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, 1.5])("rejects page %s", async (page) => {
    await expect(syncEntityPage(mockSwell(), "orders", page)).rejects.toThrow("Invalid page");
  });
});
