import { vi } from "vitest";

export const settings = {
  client_id: "client_1",
  client_secret: "secret_1",
  enabled: true,
  products: "all",
  size_option: "Size, Weight",
  grind_option: "Grind",
  default_grind: "Whole Bean",
  send_orders_on: "paid",
  customer_type: "RETAIL",
  wholesale_group: "",
};

type Route = { status?: number; body?: unknown };
type Routes = Record<string, Route | Route[]>;

const TOKEN = { access_token: "token_1", expires_in: 28799, token_type: "bearer" };

// Mocks global fetch for Cropster. Keys are "token" for the OAuth endpoint or the RPC
// operation, e.g. "mrp.order.setOrders". An array is consumed in order, repeating the last entry.
export function mockCropster(routes: Routes = {}) {
  const queues = new Map(
    Object.entries({ token: { body: TOKEN }, ...routes }).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );

  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = new URL(String(input));
    const key = url.hostname === "auth.cropster.com" ? "token" : url.pathname.replace(/^\/rpc\/v1\//, "");
    const queue = queues.get(key);
    const route = queue ? (queue.length > 1 ? queue.shift()! : queue[0]) : { body: { ok: true, result: {} } };
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
}

// Calls made to Cropster: operation ("token" for OAuth), headers and parsed body
export function calls(fetchMock: ReturnType<typeof mockCropster>) {
  return fetchMock.mock.calls.map(([input, init]: any[]) => {
    const url = new URL(String(input));
    const token = url.hostname === "auth.cropster.com";
    return {
      operation: token ? "token" : url.pathname.replace(/^\/rpc\/v1\//, ""),
      headers: init?.headers,
      body: token ? init?.body : init?.body ? JSON.parse(init.body) : undefined,
    };
  });
}

export function rpcCalls(fetchMock: ReturnType<typeof mockCropster>) {
  return calls(fetchMock).filter((call) => call.operation !== "token");
}

export const ok = (result: unknown, meta?: unknown) => ({ body: { ok: true, result, ...(meta ? { meta } : {}) } });

export const bulkFailed = {
  status: 422,
  body: {
    ok: false,
    error: {
      code: "bulk_operation_failed",
      message: "One or multiple items are invalid. No changes were saved.",
      data: { details: [{ code: "invalid_parameter", message: "Unknown SKU" }] },
    },
  },
};

// Swell client mock: `get` resolves by path (first arg), other methods resolve to {}
export function mockSwell(getByPath: Record<string, any | ((query: any) => any)> = {}, cropster: any = settings) {
  return {
    get: vi.fn(async (path: string, query?: any) => {
      const value = getByPath[path];
      return typeof value === "function" ? value(query) : value;
    }),
    put: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    settings: vi.fn(async () => ({ cropster })),
  } as any;
}

export function makeProduct(overrides: Record<string, any> = {}) {
  return {
    id: "prod_1",
    name: "Ethiopia Natural",
    sku: "ETH",
    options: [
      {
        id: "opt_size",
        name: "Size",
        values: [
          { id: "val_250", name: "250g" },
          { id: "val_1kg", name: "1 kg" },
        ],
      },
      {
        id: "opt_grind",
        name: "Grind",
        values: [
          { id: "val_wb", name: "Whole Bean" },
          { id: "val_esp", name: "Espresso" },
        ],
      },
    ],
    variants: {
      results: [
        { id: "var_1", name: "Ethiopia 250g Whole Bean", sku: "ETH-250-WB", option_value_ids: ["val_250", "val_wb"] },
        { id: "var_2", name: "Ethiopia 1 kg Espresso", sku: "ETH-1K-ESP", option_value_ids: ["val_1kg", "val_esp"] },
      ],
    },
    ...overrides,
  };
}

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "order_1",
    number: "100001",
    date_created: "2026-09-01T10:20:30.456Z",
    paid: true,
    status: "delivery_pending",
    account: { id: "acc_1", name: "Jane Doe", group: null },
    billing: { name: "Jane Doe" },
    items: [
      { id: "item_1", product: makeProduct(), variant: { sku: "ETH-250-WB" }, quantity: 2 },
      { id: "item_2", product: makeProduct(), variant: { sku: "ETH-1K-ESP" }, quantity: 1 },
    ],
    ...overrides,
  };
}

// Data sent to Swell with /:batch, flattened
export function batchUpdates(swell: any) {
  return swell.post.mock.calls.filter(([path]: any[]) => path === "/:batch").flatMap(([, body]: any[]) => body);
}
