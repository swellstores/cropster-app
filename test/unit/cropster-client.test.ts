import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CropsterClient,
  CropsterError,
  clearTokenCache,
  errorMessage,
  getSettings,
  hasCredentials,
  isRecordError,
  sendInBatches,
} from "../../functions/lib/cropster";
import { bulkFailed, calls, mockCropster, ok, rpcCalls, settings } from "../helpers/cropster-fixtures";

const noSleep = { sleep: vi.fn(async () => {}) };

beforeEach(() => {
  clearTokenCache();
  noSleep.sleep.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings helpers", () => {
  it("reads the cropster settings section", () => {
    expect(getSettings({ cropster: { client_id: "a" } })).toEqual({ client_id: "a" });
    expect(getSettings(undefined)).toEqual({});
  });

  it("requires both credentials", () => {
    expect(hasCredentials(settings as any)).toBe(true);
    expect(hasCredentials({ client_id: "a", client_secret: " " })).toBe(false);
    expect(hasCredentials({ client_secret: "b" })).toBe(false);
  });

  it("refuses to build a client without credentials", () => {
    expect(() => new CropsterClient({})).toThrow("Cropster Client ID and Client Secret are not set in app settings");
  });
});

describe("CropsterClient", () => {
  it("requests a client credentials token with the app scopes, then calls the operation", async () => {
    const fetchMock = mockCropster({ "mrp.order.listOrders": ok({ orders: [] }) });

    const response = await new CropsterClient(settings as any).call("mrp.order.listOrders", { params: {} });

    expect(response).toEqual({ result: { orders: [] }, meta: undefined });
    const [token, call] = calls(fetchMock);
    expect(fetchMock.mock.calls[0][0]).toBe("https://auth.cropster.com/oauth2/token");
    expect(token.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(token.body).toBe(
      "grant_type=client_credentials&client_id=client_1&client_secret=secret_1&scope=mrp.product%20mrp.order",
    );
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.cropster.com/rpc/v1/mrp.order.listOrders");
    expect(call.headers.Authorization).toBe("Bearer token_1");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toEqual({ params: {} });
  });

  it("reuses the token until it expires", async () => {
    const fetchMock = mockCropster();
    const client = new CropsterClient(settings as any);

    await client.call("a.b.c", {});
    await new CropsterClient(settings as any).call("a.b.c", {});

    expect(calls(fetchMock).map((c) => c.operation)).toEqual(["token", "a.b.c", "a.b.c"]);
  });

  it("requests a new token after a 401", async () => {
    const fetchMock = mockCropster({
      "a.b.c": [{ status: 401, body: { ok: false, error: { code: "invalid_authentication" } } }, ok({})],
    });
    const client = new CropsterClient(settings as any);

    await expect(client.call("a.b.c", {})).rejects.toMatchObject({ status: 401, code: "invalid_authentication" });
    await client.call("a.b.c", {});

    expect(calls(fetchMock).map((c) => c.operation)).toEqual(["token", "a.b.c", "token", "a.b.c"]);
  });

  it("reports failed authentication", async () => {
    mockCropster({ token: { status: 401, body: { error: "invalid_client" } } });

    const err = await new CropsterClient(settings as any).call("a.b.c", {}).catch((e) => e);

    expect(err).toBeInstanceOf(CropsterError);
    expect(err.message).toBe("Cropster authentication failed: invalid_client");
    expect(err.status).toBe(401);
  });

  it("retries rate limited calls, waiting longer each time", async () => {
    const fetchMock = mockCropster({ "a.b.c": [{ status: 429, body: {} }, { status: 429, body: {} }, ok({ done: true })] });

    const { result } = await new CropsterClient(settings as any, noSleep).call("a.b.c", {});

    expect(result).toEqual({ done: true });
    expect(rpcCalls(fetchMock)).toHaveLength(3);
    expect(noSleep.sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it("gives up after three rate limited attempts", async () => {
    mockCropster({ "a.b.c": { status: 429, body: { ok: false, error: { code: "too_many_requests" } } } });

    await expect(new CropsterClient(settings as any, noSleep).call("a.b.c", {})).rejects.toMatchObject({
      status: 429,
      code: "too_many_requests",
    });
  });

  it("parses error codes and bulk details", async () => {
    mockCropster({ "mrp.order.setOrders": bulkFailed });

    const err = await new CropsterClient(settings as any).call("mrp.order.setOrders", {}).catch((e) => e);

    expect(err.message).toBe(
      "Cropster mrp.order.setOrders failed (422): One or multiple items are invalid. No changes were saved.",
    );
    expect(err.code).toBe("bulk_operation_failed");
    expect(err.details).toEqual([{ code: "invalid_parameter", message: "Unknown SKU" }]);
    expect(errorMessage(err)).toContain(": Unknown SKU");
  });

  it("treats ok: false as a failure", async () => {
    mockCropster({ "a.b.c": { body: { ok: false, error: { message: "nope" } } } });

    await expect(new CropsterClient(settings as any).call("a.b.c", {})).rejects.toThrow("nope");
  });
});

describe("errors", () => {
  it("classifies record errors", () => {
    expect(isRecordError(new CropsterError("x", 422))).toBe(true);
    expect(isRecordError(new CropsterError("x", 400))).toBe(true);
    expect(isRecordError(new CropsterError("x", 401))).toBe(false);
    expect(isRecordError(new CropsterError("x", 500))).toBe(false);
    expect(isRecordError(new Error("x"))).toBe(false);
  });

  it("formats any error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("text")).toBe("text");
  });
});

describe("sendInBatches", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ externalId: `e${i}` }));
  const echo = (body: any) => ({ syncedOrders: body.data.map((item: any) => ({ id: `id-${item.externalId}`, externalId: item.externalId })) });

  it("sends at most 50 records per request and matches results by externalId", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      if (String(input).includes("auth.cropster.com")) return Response.json({ access_token: "t", expires_in: 100 });
      return Response.json({ ok: true, result: echo(JSON.parse(init.body)) });
    });
    const synced: string[] = [];

    await sendInBatches(new CropsterClient(settings as any), "mrp.order.setOrders", "syncedOrders", items(120),
      (item, result) => synced.push(`${item.externalId}:${result.id}`), () => {});

    expect(rpcCalls(fetchMock as any).map((c) => c.body.data.length)).toEqual([50, 50, 20]);
    expect(synced).toHaveLength(120);
    expect(synced[119]).toBe("e119:id-e119");
  });

  it("resends a failed bulk request one record at a time to find the invalid one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      if (String(input).includes("auth.cropster.com")) return Response.json({ access_token: "t", expires_in: 100 });
      const body = JSON.parse(init.body);
      if (body.data.some((item: any) => item.externalId === "e1")) return Response.json(bulkFailed.body, { status: 422 });
      return Response.json({ ok: true, result: echo(body) });
    });
    const synced: string[] = [];
    const failed: string[] = [];

    await sendInBatches(new CropsterClient(settings as any), "mrp.order.setOrders", "syncedOrders", items(3),
      (item) => synced.push(item.externalId), (item) => failed.push(item.externalId));

    expect(synced).toEqual(["e0", "e2"]);
    expect(failed).toEqual(["e1"]);
  });

  it("fails every record of a request rejected for another reason", async () => {
    mockCropster({ "mrp.order.setOrders": { status: 400, body: { ok: false, error: { code: "invalid_json" } } } });
    const failed: string[] = [];

    await sendInBatches(new CropsterClient(settings as any), "mrp.order.setOrders", "syncedOrders", items(2),
      () => {}, (item) => failed.push(item.externalId));

    expect(failed).toEqual(["e0", "e1"]);
  });

  it("throws errors that are not caused by the records", async () => {
    mockCropster({ "mrp.order.setOrders": { status: 500, body: { ok: false, error: { code: "server_error" } } } });

    await expect(sendInBatches(new CropsterClient(settings as any), "mrp.order.setOrders", "syncedOrders", items(2),
      () => {}, () => {})).rejects.toMatchObject({ status: 500 });
  });
});
