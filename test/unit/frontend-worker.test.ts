import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSyncPage, publicContext } from "../../frontend/worker/swell-server";
import { DEFAULT_PAGE_SIZE } from "../../functions/lib/sync";
import { clearTokenCache } from "../../functions/lib/cropster";

// The app frontend Worker endpoint that runs the initial sync page by page for staff.

const origin = "https://app.example.invalid";
const headers = {
  "Swell-Store-Id": "example",
  "Swell-Public-Key": "public-fixture-key",
  "Swell-Admin-Url": "https://example.swell.store",
  "Swell-API-Host": "https://api.example.invalid",
  "Swell-Access-Token": "private-fixture-token",
  "Swell-App-Id": "cropster",
};

function request(
  cookie: string | null,
  { body = { entity: "products", page: 1 } as unknown, extra = {} as Record<string, string> } = {},
) {
  return new Request(`${origin}/app-api/admin/sync`, {
    method: "POST",
    headers: {
      ...headers,
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const session = "_swell_admin_session=fixture";
const validSession = () => Response.json({ user_id: "staff", client_id: "example" });
const noPlatformCalls = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Must not contact the platform");
  });

type Override = Response | ((url: URL, init: RequestInit) => Response | Promise<Response>);

const settings = {
  cropster: { client_id: "cropster-client", client_secret: "cropster-fixture-secret", enabled: true },
};

const product = {
  id: "p1", name: "Kenya", sku: "KEN", date_created: "2026-01-01",
  options: [{ id: "s", name: "Size", values: [{ id: "v250", name: "250g" }] }],
  variants: { results: [{ id: "v1", sku: "KEN-250", option_value_ids: ["v250"] }] },
};
const order = {
  id: "o1", number: "1001", paid: true, date_created: "2026-01-02T00:00:00Z",
  items: [{ product, variant: { sku: "KEN-250" }, quantity: 1 }],
};

// Routes mocked platform and Cropster calls by URL; `overrides` replaces a route's response.
function mockPlatform(overrides: Record<string, Override> = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    calls.push(`${method} ${url.hostname}${url.pathname}`);
    const isCropster = url.hostname.endsWith("cropster.com");
    const route = isCropster ? `cropster ${url.hostname === "auth.cropster.com" ? "token" : url.pathname.replace(/^\/rpc\/v1\//, "")}` : `${method} ${url.pathname}`;
    const override = overrides[route];
    if (override) return typeof override === "function" ? override(url, init) : override.clone();
    if (!isCropster) {
      expect(init.redirect).toBe("manual");
    }
    switch (route) {
      case "GET /admin/api/session":
        return validSession();
      case "GET /settings/cropster":
        return Response.json(settings);
      case "GET /products":
        return Response.json({ count: 1, results: [product] });
      case "GET /orders":
        return Response.json({ count: 1, results: [order] });
      case "POST /:batch":
        return Response.json(JSON.parse(String(init.body)).map(() => ({})));
      case "cropster token":
        return Response.json({ access_token: "cropster-token", expires_in: 28799 });
      case "cropster mrp.product.syncProducts":
        return Response.json({ ok: true, result: { syncedProducts: [{ id: "c1", externalId: "p1", reviewState: "REVIEWED" }] } });
      case "cropster mrp.order.setOrders":
        return Response.json({ ok: true, result: { syncedOrders: [{ id: "co1", externalId: "1001" }] } });
      default:
        throw new Error(`Unexpected request ${route}`);
    }
  });
  return calls;
}

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publicContext", () => {
  it("contains public fields only", async () => {
    const result: any = await publicContext(request(null)).json();

    expect(result.storeId).toBe("example");
    expect(result.storefrontApiOrigin).toBe("https://example.swell.store");
    expect(JSON.stringify(result)).not.toContain("private-fixture-token");
    expect(JSON.stringify(result)).not.toContain("api.example.invalid");
  });

  it("explains how to enter through Swell when context is missing", () => {
    expect(publicContext(new Request("http://localhost/")).status).toBe(503);
  });
});

describe("adminSyncPage request checks", () => {
  it.each([{ Origin: "https://evil.example" }, { "Content-Type": "text/plain" }])(
    "rejects cross-site or non-JSON requests: %j",
    async (extra) => {
      noPlatformCalls();
      expect((await adminSyncPage(request(session, { extra }))).status).toBe(403);
    },
  );

  it.each([
    "not json",
    { entity: "products", page: 0 },
    { entity: "products", page: 1.5 },
    { entity: "products", page: "2" },
  ])("rejects invalid body: %j", async (body) => {
    noPlatformCalls();
    expect((await adminSyncPage(request(session, { body }))).status).toBe(400);
  });

  it.each([undefined, "contacts"])("rejects entity %j before contacting the platform", async (entity) => {
    noPlatformCalls();

    const result = await adminSyncPage(request(session, { body: { entity, page: 1 } }));

    expect(result.status).toBe(400);
    expect(((await result.json()) as any).error).toBe("Invalid entity, use one of products, orders");
  });

  it.each([null, "_swell_admin_session=%ZZ"])("rejects missing or malformed session: %s", async (cookie) => {
    noPlatformCalls();
    expect((await adminSyncPage(request(cookie))).status).toBe(401);
  });

  it.each([{}, { user_id: "user", client_id: "other-store" }])(
    "rejects invalid or other-store session: %j",
    async (sessionBody) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(sessionBody));

      expect((await adminSyncPage(request(session))).status).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([100, 51, "all"])("rejects page size %j before contacting the platform", async (limit) => {
    noPlatformCalls();

    const result = await adminSyncPage(request(session, { body: { entity: "products", page: 1, limit } }));

    expect(result.status).toBe(400);
    expect(((await result.json()) as any).error).toBe("Invalid page size, use one of 10, 25, 50");
  });

  it("rejects an invalid date before contacting the platform", async () => {
    noPlatformCalls();

    const result = await adminSyncPage(
      request(session, { body: { entity: "products", page: 1, created_after: "yesterday" } }),
    );

    expect(result.status).toBe(400);
    expect(((await result.json()) as any).error).toBe("Invalid created_after date");
  });

  it.each(["session", "backend"])("rejects %s redirects without following them", async (redirectAt) => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: RequestInit = {}) => {
      calls++;
      expect(init.redirect).toBe("manual");
      if (redirectAt === "backend" && calls === 1) return validSession();
      return new Response(null, { status: 302, headers: { Location: "https://untrusted.example" } });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request(session));

    expect(result.status).toBe(redirectAt === "session" ? 401 : 502);
    expect(calls).toBe(redirectAt === "session" ? 1 : 2);
    if (redirectAt === "backend") expect(((await result.json()) as any).details.status).toBe(302);
  });
});

describe("adminSyncPage sync", () => {
  it("validates the session, sends one page of products and returns only progress fields", async () => {
    let statusBody: any;
    const calls = mockPlatform({
      "GET /settings/cropster": (_url, init) => {
        expect((init.headers as Record<string, string>).Authorization).toBe(
          `Basic ${btoa("example:private-fixture-token")}`,
        );
        return Response.json(settings);
      },
      "POST /:batch": (_url, init) => {
        statusBody = JSON.parse(String(init.body));
        return Response.json([{}]);
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await adminSyncPage(request(session));

    expect(await result.json()).toEqual({
      entity: "products", page: 1, limit: DEFAULT_PAGE_SIZE, count: 1,
      synced: 1, skipped: 0, failed: 0, errors: [], done: true,
    });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(calls).toEqual([
      "GET example.swell.store/admin/api/session",
      "GET api.example.invalid/settings/cropster",
      "GET api.example.invalid/products",
      "POST auth.cropster.com/oauth2/token",
      "POST api.cropster.com/rpc/v1/mrp.product.syncProducts",
      "POST api.example.invalid/:batch",
    ]);
    expect(statusBody[0]).toMatchObject({
      url: "/products/p1",
      method: "put",
      data: { $events: false, $app: { cropster: { cropster_id: "c1", cropster_review_state: "REVIEWED" } } },
    });
  });

  it("sends one page of orders", async () => {
    let sent: any;
    const calls = mockPlatform({
      "cropster mrp.order.setOrders": (_url, init) => {
        sent = JSON.parse(String(init.body));
        return Response.json({ ok: true, result: { syncedOrders: [{ id: "co1", externalId: "1001" }] } });
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await adminSyncPage(request(session, { body: { entity: "orders", page: 1 } }));

    expect(await result.json()).toMatchObject({ entity: "orders", synced: 1, done: true });
    expect(calls).toContain("GET api.example.invalid/orders");
    expect(sent.data[0]).toMatchObject({ externalId: "1001", orderItems: [{ sku: "KEN-250", quantity: 1 }] });
  });

  it("requests the given page, size and date filter in a stable order", async () => {
    let productsUrl: URL | undefined;
    mockPlatform({
      "GET /products": (url) => {
        productsUrl = url;
        return Response.json({ count: 101, results: [product] });
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await adminSyncPage(request(session, {
      body: { entity: "products", page: 3, limit: 25, created_after: "2026-09-01T00:00:00+02:00" },
    }));

    expect(await result.json()).toMatchObject({ entity: "products", page: 3, limit: 25, count: 101, synced: 1, done: true });
    expect(productsUrl?.searchParams.get("page")).toBe("3");
    expect(productsUrl?.searchParams.get("limit")).toBe("25");
    expect(productsUrl?.searchParams.get("sort")).toBe("date_created asc");
    expect(productsUrl?.searchParams.get("date_created[$gte]")).toBe("2026-08-31T22:00:00.000Z");
  });

  it("syncs all records without a date filter", async () => {
    let productsUrl: URL | undefined;
    mockPlatform({
      "GET /products": (url) => {
        productsUrl = url;
        return Response.json({ count: 0, results: [] });
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await adminSyncPage(request(session, { body: { entity: "products", page: 1, created_after: "" } }));

    expect(productsUrl?.searchParams.get("date_created[$gte]")).toBeNull();
  });

  it("returns per-record problems with the progress", async () => {
    mockPlatform({
      "GET /products": Response.json({ count: 1, results: [{ id: "mug", name: "Mug", sku: "MUG" }] }),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const body: any = await (await adminSyncPage(request(session))).json();

    expect(body).toMatchObject({ synced: 0, skipped: 1, errors: [{ id: "mug", name: "Mug", error: "Mug: unknown package size" }] });
  });
});

describe("adminSyncPage errors", () => {
  it("reports a disabled integration", async () => {
    mockPlatform({ "GET /settings/cropster": Response.json({ cropster: { client_id: "a", client_secret: "b" } }) });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request(session));
    const body: any = await result.json();

    expect(result.status).toBe(400);
    expect(body.error).toBe("Cropster integration is disabled in app settings");
    expect(body.details).toEqual({ step: "sync", entity: "products", page: 1, limit: DEFAULT_PAGE_SIZE });
  });

  it("reports Cropster errors with their status and code", async () => {
    mockPlatform({
      "cropster mrp.product.syncProducts": Response.json(
        { ok: false, error: { code: "server_error", message: "Try again later" } },
        { status: 500 },
      ),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request(session, { body: { entity: "products", page: 2 } }));
    const body: any = await result.json();

    expect(result.status).toBe(502);
    expect(body.error).toBe("Cropster mrp.product.syncProducts failed (500): Try again later");
    expect(body.details).toEqual({
      step: "cropster", entity: "products", page: 2, status: 500, code: "server_error", errors: [], limit: DEFAULT_PAGE_SIZE,
    });
  });

  it("reports Swell API failures with step, status and body without leaking credentials", async () => {
    mockPlatform({
      "GET /orders": new Response("bad gateway private-fixture-token", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request(session, { body: { entity: "orders", page: 1 } }));
    const body: any = await result.json();

    expect(result.status).toBe(502);
    expect(body.error).toBe("Swell API GET /orders failed with HTTP 503");
    expect(body.details).toMatchObject({
      step: "swell api",
      path: "/orders",
      status: 503,
      response: "bad gateway [redacted]",
      entity: "orders",
    });
  });

  it("passes Swell API error messages through", async () => {
    mockPlatform({
      "GET /settings/cropster": Response.json({ error: { message: "Permission denied" } }, { status: 403 }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const body: any = await (await adminSyncPage(request(session))).json();

    expect(body.error).toBe("Permission denied");
    expect(body.details.status).toBe(403);
  });

  it("does not leak credentials from upstream exceptions", async () => {
    mockPlatform({
      "GET /settings/cropster": () => {
        throw new Error("private-fixture-token");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request(session));
    const body = JSON.stringify(await result.json());

    expect(result.status).toBe(502);
    expect(body).not.toContain("private-fixture-token");
    expect(body).toContain("[redacted]");
  });
});
