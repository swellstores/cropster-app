import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { batchUpdates, makeOrder, makeProduct, mockCropster, mockSwell, ok, rpcCalls, settings } from "../helpers/cropster-fixtures";
import { clearTokenCache } from "../../functions/lib/cropster";
import productEvents, { config as productConfig, isStatusOnlyChange } from "../../functions/product-events";
import orderEvents, { config as orderConfig } from "../../functions/order-events";
import orderStatus, { LOOKBACK_MS, config as statusConfig } from "../../functions/order-status";
import testConnection, { config as testConfig } from "../../functions/test-connection";
import sendToCropster, { config as sendConfig, summaryMessage } from "../../functions/send-to-cropster";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearTokenCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function eventRequest(swell: any, type: string, data: Record<string, any> = {}, changes: Record<string, any> = { id: "rec_1" }) {
  return createMockRequest({ swell, data: { id: "rec_1", ...data, $event: { type, data: changes } } });
}

function actionRequest(swell: any, $action: Record<string, any>) {
  return createMockRequest({ swell, data: { $action: { id: "send_to_cropster", user_id: "u1", ...$action } as any } });
}

const productSynced = ok({ syncedProducts: [{ id: "c1", externalId: "prod_1", reviewState: "REVIEWED" }] });
const orderSynced = ok({ syncedOrders: [{ id: "co1", externalId: "100001" }] });

describe("function configs", () => {
  it("declare the expected triggers", () => {
    expect(productConfig.model?.events).toEqual([
      "product.created",
      "product.updated",
      "product.variant.created",
      "product.variant.updated",
    ]);
    expect(orderConfig.model?.events).toEqual(["order.submitted", "order.paid", "order.updated"]);
    expect(statusConfig.cron?.schedule).toBe("*/30 * * * *");
    expect(testConfig.action).toBe(true);
    expect(sendConfig.action).toBe(true);
  });
});

describe("event and cron functions", () => {
  it.each([
    ["product-events", productEvents, "product.created"],
    ["order-events", orderEvents, "order.paid"],
    ["order-status", orderStatus, undefined],
  ])("%s does nothing when the integration is disabled or has no credentials", async (_name, handler, type) => {
    const fetchMock = mockCropster();
    for (const cropster of [{ ...settings, enabled: false }, { ...settings, client_secret: "" }, null]) {
      const swell = mockSwell({}, cropster);
      await handler(eventRequest(swell, type as any));
      expect(swell.get).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("product-events", () => {
  it("sends the created or updated product", async () => {
    const fetchMock = mockCropster({ "mrp.product.syncProducts": productSynced });
    const swell = mockSwell({ "/products/rec_1": makeProduct({ id: "rec_1" }) });

    await productEvents(eventRequest(swell, "product.updated", {}, { name: "New name" }));

    expect(rpcCalls(fetchMock)).toHaveLength(1);
    expect(batchUpdates(swell)).toHaveLength(1);
  });

  it("sends the parent product of a changed variant", async () => {
    mockCropster({ "mrp.product.syncProducts": productSynced });
    const swell = mockSwell({
      "/products:variants/rec_1": { id: "rec_1", parent_id: "prod_1" },
      "/products/prod_1": makeProduct(),
    });

    await productEvents(eventRequest(swell, "product.variant.updated"));

    expect(swell.get).toHaveBeenCalledWith("/products/prod_1", expect.anything());
  });

  it("uses the parent ID from the variant event when present", async () => {
    mockCropster({ "mrp.product.syncProducts": productSynced });
    const swell = mockSwell({ "/products/prod_1": makeProduct() });

    await productEvents(eventRequest(swell, "product.variant.created", { parent_id: "prod_1" }));

    expect(swell.get).not.toHaveBeenCalledWith("/products:variants/rec_1");
    expect(swell.get).toHaveBeenCalledWith("/products/prod_1", expect.anything());
  });

  it("ignores updates of the Cropster status this app writes", async () => {
    const fetchMock = mockCropster();
    const swell = mockSwell();

    await productEvents(eventRequest(swell, "product.updated", {}, {
      id: "rec_1",
      date_updated: "x",
      $app: { cropster: { cropster_id: "c1", cropster_synced_at: "x" } },
    }));

    expect(swell.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detects status-only changes", () => {
    expect(isStatusOnlyChange({ $app: { cropster: { cropster_error: "x" } } })).toBe(true);
    expect(isStatusOnlyChange({ $app: { cropster: { cropster_enabled: true } } })).toBe(false);
    expect(isStatusOnlyChange({ $app: { other: {} } })).toBe(false);
    expect(isStatusOnlyChange({ name: "x", $app: { cropster: {} } })).toBe(false);
    expect(isStatusOnlyChange(undefined)).toBe(false);
  });

  it("does not retry products Cropster rejects", async () => {
    mockCropster({ "mrp.product.syncProducts": { status: 400, body: { ok: false, error: { code: "invalid_parameter" } } } });
    const swell = mockSwell({ "/products/rec_1": makeProduct({ id: "rec_1" }) });

    await expect(productEvents(eventRequest(swell, "product.created"))).resolves.toBeUndefined();
  });

  it("does not retry when credentials are rejected", async () => {
    mockCropster({ token: { status: 401, body: { error: "invalid_client" } } });
    const swell = mockSwell({ "/products/rec_1": makeProduct({ id: "rec_1" }) });

    await expect(productEvents(eventRequest(swell, "product.created"))).resolves.toBeUndefined();
  });

  it("throws server errors so the event is retried", async () => {
    mockCropster({ "mrp.product.syncProducts": { status: 503, body: { ok: false, error: { code: "server_error" } } } });
    const swell = mockSwell({ "/products/rec_1": makeProduct({ id: "rec_1" }) });

    await expect(productEvents(eventRequest(swell, "product.created"))).rejects.toMatchObject({ status: 503 });
  });
});

describe("order-events", () => {
  it("sends a paid order", async () => {
    const fetchMock = mockCropster({ "mrp.order.setOrders": orderSynced });
    const swell = mockSwell({ "/orders/rec_1": makeOrder({ id: "rec_1" }) });

    await orderEvents(eventRequest(swell, "order.paid"));

    expect(rpcCalls(fetchMock)[0].operation).toBe("mrp.order.setOrders");
    expect(batchUpdates(swell)[0].url).toBe("/orders/rec_1");
  });

  it("waits for payment by default and sends on submit when set to", async () => {
    const fetchMock = mockCropster({ "mrp.order.setOrders": orderSynced });

    const paidSwell = mockSwell({ "/orders/rec_1": makeOrder({ id: "rec_1" }) });
    await orderEvents(eventRequest(paidSwell, "order.submitted"));
    expect(paidSwell.get).not.toHaveBeenCalled();

    const submitSwell = mockSwell({ "/orders/rec_1": makeOrder({ id: "rec_1", paid: false }) }, { ...settings, send_orders_on: "submitted" });
    await orderEvents(eventRequest(submitSwell, "order.submitted"));
    await orderEvents(eventRequest(submitSwell, "order.paid"));

    expect(rpcCalls(fetchMock)).toHaveLength(1);
  });

  it("does not send an order twice", async () => {
    const fetchMock = mockCropster();
    const swell = mockSwell({ "/orders/rec_1": makeOrder({ id: "rec_1", $app: { cropster: { cropster_id: "co1" } } }) });

    await orderEvents(eventRequest(swell, "order.paid"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send unpaid orders", async () => {
    const fetchMock = mockCropster();
    const swell = mockSwell({ "/orders/rec_1": makeOrder({ id: "rec_1", paid: false }) });

    await orderEvents(eventRequest(swell, "order.paid"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resends an order when its items change and ignores other updates", async () => {
    const fetchMock = mockCropster({ "mrp.order.setOrders": orderSynced });
    const order = makeOrder({ id: "rec_1", $app: { cropster: { cropster_id: "co1", cropster_state: "OPEN" } } });
    const swell = mockSwell({ "/orders/rec_1": order });

    await orderEvents(eventRequest(swell, "order.updated", {}, { id: "rec_1", $app: { cropster: { cropster_state: "OPEN" } } }));
    expect(swell.get).not.toHaveBeenCalled();

    await orderEvents(eventRequest(swell, "order.updated", {}, { id: "rec_1", items: [] }));
    expect(rpcCalls(fetchMock)).toHaveLength(1);
  });

  it("throws server errors so the event is retried", async () => {
    mockCropster({ "mrp.order.setOrders": { status: 502, body: {} } });
    const swell = mockSwell({ "/orders/rec_1": makeOrder({ id: "rec_1" }) });

    await expect(orderEvents(eventRequest(swell, "order.paid"))).rejects.toMatchObject({ status: 502 });
  });

  it("does not retry orders Cropster rejects", async () => {
    mockCropster({ "mrp.order.setOrders": { status: 400, body: { ok: false, error: { code: "invalid_parameter" } } } });
    const swell = mockSwell({ "/orders/rec_1": makeOrder({ id: "rec_1" }) });

    await expect(orderEvents(eventRequest(swell, "order.paid"))).resolves.toBeUndefined();
  });
});

describe("order-status", () => {
  it("checks orders changed in Cropster during the lookback window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T10:00:00Z"));
    const fetchMock = mockCropster({ "mrp.order.listOrders": ok({ orders: [] }) });

    await orderStatus(createMockRequest({ swell: mockSwell() }));
    vi.useRealTimers();

    expect(LOOKBACK_MS).toBe(2 * 60 * 60 * 1000);
    expect(rpcCalls(fetchMock)[0].body.params.filter.lastModifiedDate.from).toBe("2026-09-02T08:00:00Z");
  });

  it("logs failures instead of throwing", async () => {
    mockCropster({ "mrp.order.listOrders": { status: 500, body: {} } });

    await expect(orderStatus(createMockRequest({ swell: mockSwell() }))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("test-connection", () => {
  it("asks for credentials first", async () => {
    await expect(testConnection(createMockRequest({ swell: mockSwell({}, {}) }))).rejects.toThrow(
      "Enter the Cropster Client ID and Client Secret, save, then test again.",
    );
  });

  it("reports a working connection", async () => {
    const fetchMock = mockCropster({ "mrp.order.listOrders": ok({ orders: [] }) });

    expect(await testConnection(createMockRequest({ swell: mockSwell() }))).toEqual({ message: "Connected to Cropster." });
    expect(rpcCalls(fetchMock)[0].body).toEqual({ params: { pagination: { limit: 1 } } });
    expect(await testConnection(createMockRequest({ swell: mockSwell({}, { ...settings, enabled: false }) }))).toEqual({
      message: "Connected to Cropster. Turn on Enable Integration to start syncing.",
    });
  });

  it("reports why the connection failed", async () => {
    mockCropster({ token: { status: 400, body: { error: "invalid_scope" } } });

    const err: any = await testConnection(createMockRequest({ swell: mockSwell() })).catch((e) => e);

    expect(err.message).toBe("Cropster connection failed: Cropster authentication failed: invalid_scope");
    expect(err.status).toBe(400);
  });
});

describe("send-to-cropster", () => {
  it("sends the product of a record action", async () => {
    mockCropster({ "mrp.product.syncProducts": productSynced });
    const swell = mockSwell({ "/products": { results: [makeProduct()] } });

    const result = await sendToCropster(actionRequest(swell, {
      source: "record",
      collection: "products",
      record_id: "0123456789abcdef01234567",
    }));

    expect(result).toEqual({ message: "Sent 1 product to Cropster." });
    expect(swell.get).toHaveBeenCalledWith("/products", expect.objectContaining({ id: "0123456789abcdef01234567", limit: 51 }));
  });

  it("sends the orders of a bulk action selection", async () => {
    mockCropster({ "mrp.order.setOrders": orderSynced });
    const query = { $and: [{ id: { $in: ["a"] } }] };
    const swell = mockSwell({ "/orders": { results: [makeOrder(), makeOrder({ id: "o2", number: "100002", paid: false })] } });

    const result = await sendToCropster(actionRequest(swell, {
      source: "bulk",
      collection: "orders",
      selection: { all: false, count: 2, query },
    }));

    expect(result.message).toContain("Sent 1 order to Cropster. 1 skipped");
    expect(swell.get).toHaveBeenCalledWith("/orders", expect.objectContaining({ ...query, limit: 51 }));
  });

  it.each([
    [{ source: "record", collection: "accounts", record_id: "0123456789abcdef01234567" }, "Run this action from products or orders"],
    [{ source: "record", collection: "products", record_id: "../x" }, "Invalid record"],
    [{ source: "bulk", collection: "products" }, "Select products or orders to send"],
  ])("rejects invalid actions: %j", async (action, message) => {
    await expect(sendToCropster(actionRequest(mockSwell(), action))).rejects.toThrow(message);
  });

  it("limits the selection to 50 records", async () => {
    mockCropster();
    const swell = mockSwell({ "/products": { results: Array.from({ length: 51 }, () => makeProduct()) } });

    const err: any = await sendToCropster(actionRequest(swell, {
      source: "bulk",
      collection: "products",
      selection: { all: true, count: 51, query: {} },
    })).catch((e) => e);

    expect(err.message).toBe("Select up to 50 products, or use Cropster sync in the sidebar");
    expect(err.status).toBe(400);
  });

  it("requires the integration to be enabled", async () => {
    const swell = mockSwell({}, { ...settings, enabled: false });

    await expect(sendToCropster(actionRequest(swell, {
      source: "record",
      collection: "orders",
      record_id: "0123456789abcdef01234567",
    }))).rejects.toThrow("Cropster integration is disabled in app settings");
  });

  it("reports Cropster failures", async () => {
    mockCropster({ "mrp.order.setOrders": { status: 503, body: { ok: false, error: { message: "down" } } } });
    const swell = mockSwell({ "/orders": { results: [makeOrder()] } });

    const err: any = await sendToCropster(actionRequest(swell, {
      source: "record",
      collection: "orders",
      record_id: "0123456789abcdef01234567",
    })).catch((e) => e);

    expect(err.message).toBe("Cropster: Cropster mrp.order.setOrders failed (503): down");
    expect(err.status).toBe(502);
  });

  it("summarizes results", () => {
    expect(summaryMessage("products", { synced: 2, skipped: 1, failed: 1, errors: [{ id: "p", name: "Mug", error: "no SKU" }] }))
      .toBe("Sent 2 products to Cropster. 1 failed. 1 skipped. Mug: no SKU");
    expect(summaryMessage("orders", { synced: 0, skipped: 0, failed: 0, errors: [] })).toBe("No orders sent to Cropster.");
  });
});
