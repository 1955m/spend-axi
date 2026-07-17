import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getGlobalSpendToday,
  getHealth,
  getProviderBudgets,
  setFetchImpl,
} from "./gateway.js";

interface MockResponse {
  status: number;
  body: string;
}

function makeResponse(spec: MockResponse): Response {
  return {
    status: spec.status,
    ok: spec.status >= 200 && spec.status < 300,
    text: () => Promise.resolve(spec.body),
  } as Response;
}

type FetchSpec =
  | MockResponse
  | ((url: string, init: RequestInit) => MockResponse | Promise<MockResponse>);

function mockFetch(spec: FetchSpec): typeof fetch {
  const fn = (url: string, init: RequestInit): Promise<Response> => {
    const result = typeof spec === "function" ? spec(url, init) : spec;
    return Promise.resolve(result).then((r) => makeResponse(r));
  };
  return fn as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  setFetchImpl(null);
  globalThis.fetch = realFetch;
});

describe("getHealth", () => {
  it("parses a healthy readiness response (no auth header)", async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = (((_url: string, init: RequestInit) => {
      captured = init;
      return Promise.resolve(makeResponse({ status: 200, body: JSON.stringify({ status: "healthy", db: "connected" }) }));
    }) as unknown) as typeof fetch;
    const h = await getHealth("http://h:4000");
    expect(h).toEqual({ reachable: true, status: "healthy", db: "connected" });
    // health must NOT send an Authorization header
    expect((captured!.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });
  it("returns unreachable on fetch throw", async () => {
    globalThis.fetch = (((_url: string, _init: RequestInit) =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown) as typeof fetch;
    const h = await getHealth("http://127.0.0.1:1");
    expect(h.reachable).toBe(false);
    expect(h.status).toBe("unreachable");
  });
  it("returns unreachable on non-2xx", async () => {
    globalThis.fetch = mockFetch({ status: 502, body: "bad gateway" });
    const h = await getHealth("http://h");
    expect(h.reachable).toBe(false);
  });
});

describe("getProviderBudgets", () => {
  it("sends Bearer key and returns the providers map", async () => {
    let captured: { url: string; auth?: string } | undefined;
    globalThis.fetch = (((url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      captured = { url, auth: headers["Authorization"] };
      return Promise.resolve(
        makeResponse({
          status: 200,
          body: JSON.stringify({
            providers: {
              openai: { budget_limit: 200, spend: 131.21, time_period: "1d", budget_reset_at: "2083-01-30" },
              azure: { budget_limit: 75, spend: 0.22, time_period: "1d", budget_reset_at: null },
            },
          }),
        }),
      );
    }) as unknown) as typeof fetch;
    const providers = await getProviderBudgets("http://h", "sk-master");
    expect(captured!.url).toBe("http://h/provider/budgets");
    expect(captured!.auth).toBe("Bearer sk-master");
    expect(Object.keys(providers)).toEqual(["openai", "azure"]);
    expect(providers.openai.budget_limit).toBe(200);
  });
  it("throws AUTH_REQUIRED on 401", async () => {
    globalThis.fetch = mockFetch({
      status: 401,
      body: JSON.stringify({ error: { message: "Only proxy admin" } }),
    });
    await expect(getProviderBudgets("http://h", "sk-mcp")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });
  it("returns empty providers when response has none", async () => {
    globalThis.fetch = mockFetch({ status: 200, body: JSON.stringify({ providers: {} }) });
    const providers = await getProviderBudgets("http://h", "sk-master");
    expect(Object.keys(providers).length).toBe(0);
  });
});

describe("getGlobalSpendToday", () => {
  it("returns today's spend matching the override date", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: JSON.stringify([
        { date: "2026-07-16", spend: 126.2 },
        { date: "2026-07-17", spend: 11.327999 },
      ]),
    });
    const spend = await getGlobalSpendToday("http://h", "sk-master", {
      today: "2026-07-17",
    });
    expect(spend).toBeCloseTo(11.328, 3);
  });
  it("returns null when today has no entry yet", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: JSON.stringify([{ date: "2026-07-16", spend: 126.2 }]),
    });
    const spend = await getGlobalSpendToday("http://h", "sk-master", {
      today: "2026-07-17",
    });
    expect(spend).toBeNull();
  });
  it("throws on 5xx", async () => {
    globalThis.fetch = mockFetch({
      status: 500,
      body: JSON.stringify({ error: { message: "boom" } }),
    });
    await expect(getGlobalSpendToday("http://h", "sk-master", { today: "2026-07-17" })).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });
});

// Restore fetch at the very end for other test files.
beforeAll(() => {
  globalThis.fetch = realFetch;
});
