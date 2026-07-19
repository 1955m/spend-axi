import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getBifrostHealth,
  getBifrostModelUsage,
  getBifrostProviderBudgets,
  parseBifrostMetrics,
  setFetchImpl,
} from "./bifrost.js";

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
  MockResponse | ((url: string, init: RequestInit) => MockResponse | Promise<MockResponse>);

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

beforeAll(() => {
  globalThis.fetch = realFetch;
});

describe("parseBifrostMetrics", () => {
  it("aggregates cost + token counters by {provider, model}", () => {
    const text = [
      "# HELP bifrost_cost_total Total cost in USD for requests to upstream providers.",
      "# TYPE bifrost_cost_total counter",
      'bifrost_cost_total{alias="glm-5.2-xhigh",method="chat_completion_stream",model="glm-5.2",provider="dashscope",virtual_key_name="opencode-worker"} 4.98147948',
      'bifrost_cost_total{alias="glm-5.2-xhigh",method="chat_completion",model="glm-5.2",provider="dashscope",virtual_key_name="opencode-worker"} 0.0014938',
      'bifrost_cost_total{alias="gpt-5.4-high",method="chat_completion_stream",model="gpt-5.4",provider="azure",virtual_key_name="opencode-worker"} 1.7356615',
      "# HELP bifrost_input_tokens_total Total input tokens.",
      "# TYPE bifrost_input_tokens_total counter",
      'bifrost_input_tokens_total{alias="glm-5.2-xhigh",method="chat_completion_stream",model="glm-5.2",provider="dashscope"} 1000',
      'bifrost_input_tokens_total{alias="glm-5.2-xhigh",method="chat_completion",model="glm-5.2",provider="dashscope"} 50',
      "# HELP bifrost_output_tokens_total Total output tokens.",
      "# TYPE bifrost_output_tokens_total counter",
      'bifrost_output_tokens_total{alias="glm-5.2-xhigh",method="chat_completion_stream",model="glm-5.2",provider="dashscope"} 200',
      "# HELP bifrost_cache_read_input_tokens_total cached input tokens.",
      "# TYPE bifrost_cache_read_input_tokens_total counter",
      'bifrost_cache_read_input_tokens_total{alias="glm-5.2-xhigh",method="chat_completion_stream",model="glm-5.2",provider="dashscope"} 100',
      "# HELP bifrost_active_requests in-flight.",
      "# TYPE bifrost_active_requests gauge",
      'bifrost_active_requests{method="chat_completion"} 0',
    ].join("\n");
    const rows = parseBifrostMetrics(text);
    expect(rows).toHaveLength(2);
    const glm = rows.find((r) => r.model === "glm-5.2");
    expect(glm).toMatchObject({
      provider: "dashscope",
      model: "glm-5.2",
      // 4.98147948 + 0.0014938
      costUsd: expect.closeTo(4.98297328, 5),
      inputTokens: 1050,
      outputTokens: 200,
      cacheReadTokens: 100,
    });
    const gpt = rows.find((r) => r.model === "gpt-5.4");
    expect(gpt?.costUsd).toBeCloseTo(1.7356615, 5);
  });

  it("ignores non-spend bifrost_* series (active_requests, latency)", () => {
    const text = [
      'bifrost_active_requests{method="chat_completion"} 0',
      'bifrost_upstream_latency_seconds_sum{provider="azure"} 0.5',
      'bifrost_provider_key_up{provider="azure",selected_key_name="k"} 1',
    ].join("\n");
    expect(parseBifrostMetrics(text)).toEqual([]);
  });

  it("handles scientific-notation values", () => {
    const text = 'bifrost_cost_total{model="gpt-5.4",provider="azure"} 1.7356615000000002e+00\n';
    const rows = parseBifrostMetrics(text);
    expect(rows[0]?.costUsd).toBeCloseTo(1.7356615, 5);
  });

  it("handles escaped quotes inside label values", () => {
    const text = 'bifrost_cost_total{model="my\\"model",provider="azure"} 0.5\n';
    const rows = parseBifrostMetrics(text);
    expect(rows[0]?.model).toBe('my"model');
    expect(rows[0]?.costUsd).toBeCloseTo(0.5, 5);
  });

  it("empty input -> empty array (definitive empty state)", () => {
    expect(parseBifrostMetrics("")).toEqual([]);
    expect(parseBifrostMetrics("# just a comment\n")).toEqual([]);
  });

  it("skips rows missing provider or model labels", () => {
    const text = [
      'bifrost_cost_total{alias="",model="gpt-5.4",provider=""} 0.5',
      'bifrost_cost_total{alias="",model="",provider="azure"} 0.5',
    ].join("\n");
    expect(parseBifrostMetrics(text)).toEqual([]);
  });
});

describe("getBifrostHealth", () => {
  it("parses /health {status, components.db_pings}", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: JSON.stringify({ status: "ok", components: { db_pings: "ok" } }),
    });
    const h = await getBifrostHealth("http://b:8090");
    expect(h).toEqual({ reachable: true, status: "ok", db: "ok" });
  });

  it("returns unreachable on fetch throw", async () => {
    globalThis.fetch = ((_url: string) =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const h = await getBifrostHealth("http://127.0.0.1:1");
    expect(h.reachable).toBe(false);
    expect(h.status).toBe("unreachable");
  });

  it("returns unreachable on non-2xx", async () => {
    globalThis.fetch = mockFetch({ status: 502, body: "bad gateway" });
    const h = await getBifrostHealth("http://b");
    expect(h.reachable).toBe(false);
  });

  it("does NOT send an Authorization header (management API unauthenticated)", async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      captured = init;
      return Promise.resolve(makeResponse({ status: 200, body: JSON.stringify({ status: "ok" }) }));
    }) as unknown as typeof fetch;
    await getBifrostHealth("http://b:8090");
    expect((captured!.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });
});

describe("getBifrostProviderBudgets", () => {
  it("aggregates current_usage + max_limit per provider across model-configs", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        makeResponse({
          status: 200,
          body: JSON.stringify({
            count: 2,
            model_configs: [
              {
                id: "a",
                provider: "azure",
                model_name: "*",
                scope: "global",
                budgets: [
                  {
                    id: "b1",
                    max_limit: 250,
                    reset_duration: "1d",
                    last_reset: "2026-07-18T18:24:33Z",
                    current_usage: 6.54,
                    model_config_id: "a",
                  },
                ],
              },
              {
                id: "c",
                provider: "dashscope",
                model_name: "*",
                scope: "global",
                budgets: [
                  {
                    id: "b2",
                    max_limit: 250,
                    reset_duration: "1d",
                    last_reset: "2026-07-18T19:32:04Z",
                    current_usage: 5.05,
                    model_config_id: "c",
                  },
                ],
              },
              {
                id: "d",
                provider: "azure",
                model_name: "gpt-5.4",
                scope: "global",
                budgets: [
                  {
                    id: "b3",
                    max_limit: 20,
                    reset_duration: "1d",
                    last_reset: "2026-07-18T20:00:00Z",
                    current_usage: 0,
                    model_config_id: "d",
                  },
                ],
              },
            ],
          }),
        }),
      );
    }) as unknown as typeof fetch;
    const rows = await getBifrostProviderBudgets("http://b:8090", undefined);
    expect(capturedUrl).toBe("http://b:8090/api/governance/model-configs");
    const azure = rows.find((r) => r.provider === "azure");
    expect(azure).toMatchObject({
      provider: "azure",
      spendUsd: 6.54,
      budgetUsd: 270,
      lastReset: "2026-07-18T20:00:00Z",
      resetDuration: "1d",
    });
    const dash = rows.find((r) => r.provider === "dashscope");
    expect(dash?.spendUsd).toBeCloseTo(5.05, 5);
  });

  it("returns empty array when no model_configs", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: JSON.stringify({ count: 0, model_configs: [] }),
    });
    const rows = await getBifrostProviderBudgets("http://b", undefined);
    expect(rows).toEqual([]);
  });

  it("sends Authorization: Bearer <key> only when a key is set", async () => {
    let withoutKey: RequestInit | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      withoutKey = init;
      return Promise.resolve(
        makeResponse({ status: 200, body: JSON.stringify({ model_configs: [] }) }),
      );
    }) as unknown as typeof fetch;
    await getBifrostProviderBudgets("http://b", undefined);
    expect((withoutKey!.headers as Record<string, string>)["Authorization"]).toBeUndefined();

    let withKey: RequestInit | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      withKey = init;
      return Promise.resolve(
        makeResponse({ status: 200, body: JSON.stringify({ model_configs: [] }) }),
      );
    }) as unknown as typeof fetch;
    await getBifrostProviderBudgets("http://b", "sk-bf-x");
    expect((withKey!.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-bf-x");
  });

  it("throws AUTH_REQUIRED on 401 (locked-down management API)", async () => {
    globalThis.fetch = mockFetch({
      status: 401,
      body: JSON.stringify({ error: { message: "auth required" } }),
    });
    await expect(getBifrostProviderBudgets("http://b", undefined)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("Bifrost gateway rejected the key"),
    });
    await expect(getBifrostProviderBudgets("http://b", undefined)).rejects.toMatchObject({
      suggestions: expect.arrayContaining([expect.stringContaining("SPEND_AXI_BIFROST_KEY")]),
    });
  });
});

describe("getBifrostModelUsage", () => {
  it("parses /metrics into per-model cumulative rows", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        makeResponse({
          status: 200,
          body: [
            'bifrost_cost_total{alias="glm-5.2-xhigh",model="glm-5.2",provider="dashscope"} 4.98',
            'bifrost_input_tokens_total{alias="glm-5.2-xhigh",model="glm-5.2",provider="dashscope"} 1000',
            'bifrost_output_tokens_total{alias="glm-5.2-xhigh",model="glm-5.2",provider="dashscope"} 200',
          ].join("\n"),
        }),
      );
    }) as unknown as typeof fetch;
    const rows = await getBifrostModelUsage("http://b:8090", undefined);
    expect(capturedUrl).toBe("http://b:8090/metrics");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "dashscope",
      model: "glm-5.2",
      costUsd: expect.closeTo(4.98, 2),
      inputTokens: 1000,
      outputTokens: 200,
    });
  });

  it("returns empty array (never throws) when /metrics is unreachable", async () => {
    globalThis.fetch = ((_url: string) =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const rows = await getBifrostModelUsage("http://b:1", undefined);
    expect(rows).toEqual([]);
  });

  it("returns empty array when metrics body has no spend counters", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: 'bifrost_active_requests{method="chat_completion"} 0\n',
    });
    expect(await getBifrostModelUsage("http://b", undefined)).toEqual([]);
  });
});
