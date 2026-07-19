import { describe, expect, it } from "vitest";
import {
  cursorPlain,
  formatUsd,
  gatewayModelsPlain,
  gatewayPlain,
  gatewayProvidersPlain,
  nearestResetDate,
  pctUsed,
  summarizeRemaining,
  subscriptionsPlain,
  type GatewayView,
} from "./views.js";
import { NOT_WIRED, type CursorSnapshot } from "./cursor.js";
import type { QuotaProvider, QuotaSnapshot } from "./quota.js";

describe("formatUsd", () => {
  it("formats to 2 decimals", () => {
    expect(formatUsd(11.327999)).toBe("11.33");
  });
  it("null/undefined → em dash", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });
});

describe("pctUsed", () => {
  it("rounds spend/budget percent", () => {
    expect(pctUsed(131.21, 200)).toBe(66);
    expect(pctUsed(0.22, 75)).toBe(0);
  });
  it("zero when no budget", () => {
    expect(pctUsed(5, 0)).toBe(0);
  });
});

describe("summarizeRemaining", () => {
  it("joins window percentRemaining by label", () => {
    const p: QuotaProvider = {
      provider: "claude",
      windows: [
        { label: "session", percentRemaining: 88 },
        { label: "week", percentRemaining: 82 },
      ],
    };
    expect(summarizeRemaining(p)).toBe("session:88% week:82%");
  });
  it("credits fallback when no windows", () => {
    const p: QuotaProvider = {
      provider: "codex",
      windows: [],
      credits: { remaining: 0, unlimited: false, unit: "credits" },
    };
    expect(summarizeRemaining(p)).toBe("0 credits");
  });
  it("unlimited credits", () => {
    const p: QuotaProvider = {
      provider: "codex",
      windows: [],
      credits: { remaining: 0, unlimited: true, unit: "credits" },
    };
    expect(summarizeRemaining(p)).toBe("unlimited");
  });
  it("dash when nothing", () => {
    const p: QuotaProvider = { provider: "cursor", windows: [] };
    expect(summarizeRemaining(p)).toBe("—");
  });
});

describe("nearestResetDate", () => {
  it("earliest reset date YYYY-MM-DD", () => {
    const p: QuotaProvider = {
      provider: "claude",
      windows: [{ resetsAt: "2026-07-22T00:00:00Z" }, { resetsAt: "2026-07-17T06:20:00Z" }],
    };
    expect(nearestResetDate(p)).toBe("2026-07-17");
  });
  it("dash when none", () => {
    expect(nearestResetDate({ provider: "x", windows: [] })).toBe("—");
  });
});

describe("gatewayPlain", () => {
  it("renders yes/no + formatted usd + error", () => {
    const view: GatewayView = {
      source: "litellm",
      base: "http://h",
      reachable: true,
      auth: false,
      window: "today UTC",
      todayTotalUsd: 11.33,
      providers: [],
      models: [],
      error: { code: "AUTH_REQUIRED", message: "no key" },
    };
    const out = gatewayPlain(view);
    expect(out).toMatchObject({
      source: "litellm",
      base: "http://h",
      reachable: "yes",
      auth: "no",
      window: "today UTC",
      today_total_usd: "11.33",
      error: "no key",
      error_code: "AUTH_REQUIRED",
    });
  });
  it("omits error fields when none", () => {
    const out = gatewayPlain({
      source: "bifrost",
      base: "http://h",
      reachable: true,
      auth: true,
      window: "1d",
      todayTotalUsd: 5,
      providers: [],
      models: [],
    });
    expect(out).not.toHaveProperty("error");
  });
});

describe("gatewayProvidersPlain", () => {
  it("maps provider rows with formatted spend", () => {
    const out = gatewayProvidersPlain({
      source: "litellm",
      base: "http://h",
      reachable: true,
      auth: true,
      window: "today UTC",
      todayTotalUsd: 1,
      providers: [
        { name: "openai", spendUsd: 131.21, budgetUsd: 200, pctUsed: 66, reset: "2083-01-30" },
        { name: "cohere", spendUsd: 0, budgetUsd: 20, pctUsed: 0, reset: null },
      ],
      models: [],
    });
    expect(out).toEqual([
      {
        provider: "openai",
        spend_usd: "131.21",
        budget_usd: 200,
        pct_used: 66,
        reset: "2083-01-30",
      },
      { provider: "cohere", spend_usd: "0.00", budget_usd: 20, pct_used: 0, reset: "—" },
    ]);
  });
});

describe("gatewayModelsPlain", () => {
  it("maps per-model cumulative usage rows", () => {
    const out = gatewayModelsPlain({
      source: "bifrost",
      base: "http://h",
      reachable: true,
      auth: true,
      window: "1d",
      todayTotalUsd: 5,
      providers: [],
      models: [
        {
          provider: "dashscope",
          model: "glm-5.2",
          costUsd: 4.98,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
        },
      ],
    });
    expect(out).toEqual([
      {
        provider: "dashscope",
        model: "glm-5.2",
        cost_usd: "4.98",
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 200,
      },
    ]);
  });
  it("empty models -> empty array (definitive empty state)", () => {
    const out = gatewayModelsPlain({
      source: "bifrost",
      base: "http://h",
      reachable: true,
      auth: true,
      window: "1d",
      todayTotalUsd: 0,
      providers: [],
      models: [],
    });
    expect(out).toEqual([]);
  });
});

describe("cursorPlain", () => {
  it("renders not-wired + activity", () => {
    const snap: CursorSnapshot = {
      spendUsd: NOT_WIRED,
      headroomUsd: NOT_WIRED,
      pctUsed: NOT_WIRED,
      dailyCapUsd: 50,
      status: "not-wired",
      activity: { dbPresent: true, requestsToday: 3, modelsToday: ["composer-2.5"] },
      note: "note",
    };
    expect(cursorPlain(snap)).toMatchObject({
      spend_usd: "not wired",
      daily_cap_usd: 50,
      requests_today: 3,
      models_today: "composer-2.5",
      status: "not-wired",
    });
  });
  it("models_today none when empty", () => {
    const out = cursorPlain({
      spendUsd: NOT_WIRED,
      headroomUsd: NOT_WIRED,
      pctUsed: NOT_WIRED,
      dailyCapUsd: 50,
      status: "not-wired",
      activity: { dbPresent: false, requestsToday: 0, modelsToday: [] },
      note: "x",
    });
    expect(out["models_today"]).toBe("none");
  });
});

describe("subscriptionsPlain", () => {
  it("compact provider rows", () => {
    const snap: QuotaSnapshot = {
      generatedAt: "2026-07-17T00:00:00Z",
      providers: [
        {
          provider: "claude",
          plan: "max",
          status: "fresh",
          windows: [{ label: "session", percentRemaining: 88, resetsAt: "2026-07-17T06:20:00Z" }],
        },
      ],
    };
    const out = subscriptionsPlain(snap);
    expect(out["generatedAt"]).toBe("2026-07-17T00:00:00Z");
    const providers = out["providers"] as Array<Record<string, unknown>>;
    expect(providers[0]).toMatchObject({
      provider: "claude",
      plan: "max",
      status: "fresh",
      remaining: "session:88%",
      reset: "2026-07-17",
    });
  });
  it("error branch", () => {
    expect(subscriptionsPlain({ error: "boom" })).toEqual({ error: "boom" });
  });
});
