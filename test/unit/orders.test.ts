import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CropsterClient, clearTokenCache } from "../../functions/lib/cropster";
import {
  ORDER_EXPAND,
  buildCropsterOrder,
  cropsterDate,
  customerType,
  isOrderReady,
  orderItems,
  pollOrderStates,
  syncOrderById,
  syncOrders,
} from "../../functions/lib/orders";
import { batchUpdates, bulkFailed, makeOrder, makeProduct, mockCropster, mockSwell, ok, rpcCalls, settings } from "../helpers/cropster-fixtures";

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("order mapping", () => {
  it("formats dates without milliseconds", () => {
    expect(cropsterDate("2026-09-01T10:20:30.456Z")).toBe("2026-09-01T10:20:30Z");
  });

  it("builds a production order from the Swell order", () => {
    expect(buildCropsterOrder(makeOrder(), settings as any)).toEqual({
      order: {
        externalId: "100001",
        orderDate: "2026-09-01T10:20:30Z",
        customer: "Jane Doe",
        customerType: "RETAIL",
        orderItems: [
          { sku: "ETH-250-WB", quantity: 2 },
          { sku: "ETH-1K-ESP", quantity: 1 },
        ],
      },
    });
  });

  it("prefers the company name for the customer", () => {
    const order = makeOrder({ billing: { name: "Jane Doe", company: "Café Uno" } });
    expect(buildCropsterOrder(order, settings as any).order?.customer).toBe("Café Uno");
  });

  it("adds up quantities of the same SKU and skips items without SKU or of excluded products", () => {
    const order = makeOrder({
      items: [
        { product: makeProduct(), variant: { sku: "ETH-250-WB" }, quantity: 1 },
        { product: makeProduct(), variant: { sku: "ETH-250-WB" }, quantity: 3 },
        { product: { sku: "MUG", $app: {} }, quantity: 1 },
        { product: { sku: "" }, quantity: 1 },
        { product: makeProduct(), variant: { sku: "ETH-1K-ESP" }, quantity: 0 },
      ],
    });

    expect(orderItems(order, settings as any)).toEqual([
      { sku: "ETH-250-WB", quantity: 4 },
      { sku: "MUG", quantity: 1 },
    ]);
    expect(orderItems(order, { ...settings, products: "marked" } as any)).toEqual([]);
  });

  it("skips orders without Cropster items", () => {
    expect(buildCropsterOrder(makeOrder({ items: [] }), settings as any)).toEqual({
      skip: "No items with Cropster products and SKUs",
    });
  });

  it("sends orders of the wholesale group as wholesale", () => {
    const wholesale = makeOrder({ account: { name: "Café", group: "wholesale" } });
    expect(customerType(wholesale, { ...settings, wholesale_group: "wholesale" } as any)).toBe("WHOLESALE");
    expect(customerType(makeOrder(), { ...settings, wholesale_group: "wholesale" } as any)).toBe("RETAIL");
    expect(customerType(makeOrder(), { customer_type: "WHOLESALE" })).toBe("WHOLESALE");
  });

  it("is ready when paid, or when submitted under that setting, and never when canceled or draft", () => {
    expect(isOrderReady(makeOrder(), settings as any)).toBe(true);
    expect(isOrderReady(makeOrder({ paid: false }), settings as any)).toBe(false);
    expect(isOrderReady(makeOrder({ paid: false }), { send_orders_on: "submitted" })).toBe(true);
    expect(isOrderReady(makeOrder({ canceled: true }), { send_orders_on: "submitted" })).toBe(false);
    expect(isOrderReady(makeOrder({ status: "canceled" }), settings as any)).toBe(false);
    expect(isOrderReady(makeOrder({ draft: true }), { send_orders_on: "submitted" })).toBe(false);
    expect(isOrderReady(null, settings as any)).toBe(false);
  });
});

describe("syncOrders", () => {
  it("sends orders and stores the Cropster ID and OPEN state without triggering events", async () => {
    const fetchMock = mockCropster({
      "mrp.order.setOrders": ok({ syncedOrders: [{ id: "co1", externalId: "100001" }] }),
    });
    const swell = mockSwell();

    const summary = await syncOrders(swell, new CropsterClient(settings as any), settings as any, [makeOrder()]);

    expect(summary).toEqual({ synced: 1, skipped: 0, failed: 0, errors: [] });
    expect(rpcCalls(fetchMock)[0].body.data[0].externalId).toBe("100001");
    expect(batchUpdates(swell)).toEqual([
      {
        url: "/orders/order_1",
        method: "put",
        data: {
          $events: false,
          $app: {
            cropster: {
              cropster_id: "co1",
              cropster_state: "OPEN",
              cropster_synced_at: expect.any(String),
              cropster_error: null,
            },
          },
        },
      },
    ]);
  });

  it("skips orders that are not ready, have no Cropster items or are already in production", async () => {
    const fetchMock = mockCropster();
    const orders = [
      makeOrder({ paid: false }),
      makeOrder({ items: [] }),
      makeOrder({ $app: { cropster: { cropster_state: "ROASTED" } } }),
    ];

    const summary = await syncOrders(mockSwell(), new CropsterClient(settings as any), settings as any, orders);

    expect(summary).toEqual({ synced: 0, skipped: 3, failed: 0, errors: [] });
    expect(rpcCalls(fetchMock)).toHaveLength(0);
  });

  it("updates open orders and keeps their state", async () => {
    mockCropster({ "mrp.order.setOrders": ok({ syncedOrders: [{ id: "co1", externalId: "100001" }] }) });
    const swell = mockSwell();
    const order = makeOrder({ $app: { cropster: { cropster_id: "co1", cropster_state: "OPEN" } } });

    await syncOrders(swell, new CropsterClient(settings as any), settings as any, [order]);

    expect(batchUpdates(swell)[0].data.$app.cropster.cropster_state).toBe("OPEN");
  });

  it("stores the Cropster error on the failed order", async () => {
    mockCropster({ "mrp.order.setOrders": bulkFailed });
    const swell = mockSwell();

    const summary = await syncOrders(swell, new CropsterClient(settings as any), settings as any, [makeOrder()]);

    expect(summary.failed).toBe(1);
    expect(summary.errors[0]).toMatchObject({ id: "order_1", name: "Order 100001" });
    expect(batchUpdates(swell)[0].data.$app.cropster.cropster_error).toContain("Unknown SKU");
  });

  it("loads an order with its items by ID", async () => {
    mockCropster({ "mrp.order.setOrders": ok({ syncedOrders: [] }) });
    const swell = mockSwell({ "/orders/order_1": makeOrder() });

    await syncOrderById(swell, new CropsterClient(settings as any), settings as any, "order_1");

    expect(swell.get).toHaveBeenCalledWith("/orders/order_1", { expand: ORDER_EXPAND });
    await expect(syncOrderById(mockSwell(), new CropsterClient(settings as any), settings as any, "x")).rejects.toThrow("Order x not found");
  });
});

describe("pollOrderStates", () => {
  const cropsterOrder = (externalId: string | null, state: string, status = "SCHEDULED") => ({
    id: `c-${externalId}`,
    externalId,
    state,
    status,
    lastModifiedDate: "2026-09-02T08:00:00Z",
  });

  it("pages through changed Cropster orders and updates matching Swell orders that changed", async () => {
    const fetchMock = mockCropster({
      "mrp.order.listOrders": [
        ok({ orders: [cropsterOrder("100001", "SCHEDULED"), cropsterOrder(null, "OPEN")] }, { pagination: { endCursor: "next" } }),
        ok({ orders: [cropsterOrder("100002", "ROASTED", "ROASTED")] }, { pagination: { endCursor: null } }),
      ],
    });
    const swell = mockSwell({
      "/orders": {
        results: [
          { id: "o1", number: "100001", $app: { cropster: { cropster_state: "OPEN" } } },
          { id: "o2", number: "100002", $app: { cropster: { cropster_state: "ROASTED", cropster_status: "ROASTED" } } },
        ],
      },
    });

    const result = await pollOrderStates(swell, new CropsterClient(settings as any), new Date("2026-09-02T06:00:00.500Z"));

    expect(result).toEqual({ checked: 2, updated: 1 });
    const [first, second] = rpcCalls(fetchMock);
    expect(first.body).toEqual({
      params: { filter: { lastModifiedDate: { from: "2026-09-02T06:00:00Z" } }, pagination: { limit: 100, after: null } },
    });
    expect(second.body.params.pagination.after).toBe("next");
    expect(swell.get).toHaveBeenCalledWith("/orders", { number: { $in: ["100001", "100002"] }, limit: 100 });
    expect(batchUpdates(swell)).toEqual([
      {
        url: "/orders/o1",
        method: "put",
        data: {
          $events: false,
          $app: {
            cropster: {
              cropster_id: "c-100001",
              cropster_state: "SCHEDULED",
              cropster_status: "SCHEDULED",
              cropster_modified_at: "2026-09-02T08:00:00Z",
            },
          },
        },
      },
    ]);
  });

  it("does nothing when no orders changed", async () => {
    mockCropster({ "mrp.order.listOrders": ok({ orders: [] }) });
    const swell = mockSwell();

    expect(await pollOrderStates(swell, new CropsterClient(settings as any), new Date())).toEqual({ checked: 0, updated: 0 });
    expect(swell.get).not.toHaveBeenCalled();
  });

  it("stops after the page limit", async () => {
    const fetchMock = mockCropster({ "mrp.order.listOrders": ok({ orders: [] }, { pagination: { endCursor: "more" } }) });

    await pollOrderStates(mockSwell(), new CropsterClient(settings as any), new Date(), 3);

    expect(rpcCalls(fetchMock)).toHaveLength(3);
  });
});
