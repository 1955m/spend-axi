import { AxiError, mapGatewayError } from "./errors.js";

/**
 * fetch-like seam so tests can inject a fake transport without touching the
 * network. Defaults to the global `fetch`. Mirrors clickup-axi/figma-axi.
 */
export type SpendFetch = typeof fetch;

let injectedFetch: SpendFetch | undefined;

/** Inject a fetch implementation (tests). Pass `null` to restore the global. */
export function setFetchImpl(impl: SpendFetch | null): void {
  injectedFetch = impl ?? undefined;
}

function getFetch(): SpendFetch {
  return injectedFetch ?? fetch;
}

/**
 * Read the live fetch implementation (the injected test seam if set, else the
 * global). Shared with bifrost.ts so both gateway sources honor the same
 * `setFetchImpl(null)` test seam (tests stub one transport for both sources).
 */
export { getFetch };

const DEFAULT_TIMEOUT_MS = 15_000;

export interface GatewayRequestOptions {
  timeoutMs?: number;
  /** Test override for "today" (UTC YYYY-MM-DD). Defaults to now. */
  today?: string;
}

/** Per-provider budget row from GET /provider/budgets. */
export interface ProviderBudget {
  budget_limit: number;
  spend: number;
  time_period: string;
  budget_reset_at: string | null;
}

interface ProviderBudgetsResponse {
  providers?: Record<string, ProviderBudget>;
}

interface GlobalSpendEntry {
  date: string;
  spend: number;
}

interface HealthResponse {
  status?: string;
  db?: string;
}

/** Today's UTC date as YYYY-MM-DD (test-overrideable). */
function todayUtc(opts: GatewayRequestOptions): string {
  if (opts.today) return opts.today;
  return new Date().toISOString().slice(0, 10);
}

function toFetchError(error: unknown, timeoutMs: number, label: string): AxiError {
  if (error instanceof Error && (/abort/i.test(error.name) || error.name === "TimeoutError")) {
    return new AxiError(`LiteLLM gateway timed out after ${timeoutMs}ms for ${label}`, "TIMEOUT", [
      "Retry; the gateway was too slow to respond",
    ]);
  }
  return new AxiError(
    `LiteLLM gateway request failed for ${label}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    "NETWORK_ERROR",
    ["Check the gateway is running and reachable at the configured base"],
  );
}

async function gatewayGet<T>(
  base: string,
  path: string,
  label: string,
  key: string | undefined,
  opts: GatewayRequestOptions = {},
): Promise<T> {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await getFetch()(url, {
      method: "GET",
      headers: key !== undefined ? { Authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
  } catch (error) {
    throw toFetchError(error, timeoutMs, label);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw mapGatewayError(response.status, text, label, "litellm");
  }
  if (text.length === 0) {
    throw new AxiError(`LiteLLM gateway returned an empty response for ${label}`, "UNKNOWN");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AxiError(
      `LiteLLM gateway returned non-JSON for ${label}: ${text.slice(0, 200)}`,
      "UNKNOWN",
    );
  }
}

/** Health reachability (GET /health/readiness, no auth). Never throws. */
export async function getHealth(
  base: string,
  opts: GatewayRequestOptions = {},
): Promise<{ reachable: boolean; status: string; db: string }> {
  try {
    const body = await gatewayGet<HealthResponse>(
      base,
      "/health/readiness",
      "health",
      undefined,
      opts,
    );
    return {
      reachable: true,
      status: body.status ?? "unknown",
      db: body.db ?? "unknown",
    };
  } catch {
    return { reachable: false, status: "unreachable", db: "unknown" };
  }
}

/**
 * Per-provider today spend vs budget (GET /provider/budgets, master key).
 * Returns the providers map (e.g. {openai:{...}, azure:{...}, cohere:{...}}).
 * Throws AUTH_REQUIRED when no key / 401.
 */
export async function getProviderBudgets(
  base: string,
  key: string,
  opts: GatewayRequestOptions = {},
): Promise<Record<string, ProviderBudget>> {
  const body = await gatewayGet<ProviderBudgetsResponse>(
    base,
    "/provider/budgets",
    "provider-budgets",
    key,
    opts,
  );
  return body.providers ?? {};
}

/**
 * Today's total gateway spend in USD across all providers
 * (GET /global/spend/logs, master key). Returns the spend for today's UTC
 * date, or null when today has no entry yet. Throws on auth/network error.
 */
export async function getGlobalSpendToday(
  base: string,
  key: string,
  opts: GatewayRequestOptions = {},
): Promise<number | null> {
  const series = await gatewayGet<GlobalSpendEntry[]>(
    base,
    "/global/spend/logs",
    "global-spend",
    key,
    opts,
  );
  const today = todayUtc(opts);
  const entry = series.find((e) => e.date === today);
  return entry ? Number(entry.spend) : null;
}
