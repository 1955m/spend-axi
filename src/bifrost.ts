import { AxiError, mapGatewayError } from "./errors.js";
import { getFetch, setFetchImpl, type SpendFetch } from "./gateway.js";

// Re-export the test seam so bifrost tests import from a single module.
export { setFetchImpl };

/**
 * Bifrost management-API client (audit 7). The live gateway moved here on
 * 2026-07-19 from LiteLLM :4000 → Bifrost :8090; LiteLLM is STOPPED-not-deleted
 * and the LiteLLM source in `gateway.ts` is kept as `--gateway-source litellm`.
 *
 * Empirically verified against Bifrost v1.6.4 (see projects/stack/ai/bifrost/
 * CUTOVER.md section 0). Authoritative spend surfaces:
 *
 *  - Dollar spend per provider per current daily window:
 *    GET /api/governance/model-configs (embeds budgets[]: current_usage /
 *    max_limit / last_reset / reset_duration). This is the analogue of LiteLLM's
 *    /provider/budgets and is the authoritative per-provider daily $ number.
 *  - Per-model token + cost breakdown: GET /metrics (Prometheus exposition).
 *    Counters (bifrost_cost_total / bifrost_input_tokens_total /
 *    bifrost_output_tokens_total / bifrost_cache_read_input_tokens_total) are
 *    CUMULATIVE since the Bifrost process started — there is no native
 *    per-model-per-day surface in Bifrost v1.6.4. We aggregate them by
 *    {provider, model} and label the result "cumulative" so it is never
 *    mistaken for today's spend.
 *
 * Management API is unauthenticated on this host (auth_config.is_enabled=false,
 * CUTOVER.md note 10). The optional `key` here only matters if that flag is
 * ever flipped on; it is sent as `Authorization: Bearer <key>`.
 */

export interface BifrostRequestOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface HealthResponse {
  status?: string;
  components?: { db_pings?: string };
}

interface BifrostBudget {
  id: string;
  max_limit: number;
  reset_duration: string;
  last_reset: string;
  current_usage: number;
  model_config_id: string;
}

interface ModelConfig {
  id: string;
  provider: string;
  model_name: string;
  scope: string;
  budgets: BifrostBudget[];
}

interface ModelConfigsResponse {
  count?: number;
  model_configs?: ModelConfig[];
}

/** Per-provider row aggregated from /api/governance/model-configs. */
export interface BifrostProviderBudget {
  provider: string;
  /** Sum of current_usage across this provider's model-config budgets (USD). */
  spendUsd: number;
  /** Sum of max_limit across this provider's model-config budgets (USD). */
  budgetUsd: number;
  /** ISO timestamp of the most recent reset across the provider's budgets. */
  lastReset: string | null;
  /** Budget window duration, e.g. "1d". */
  resetDuration: string | null;
}

/** Per-model cumulative token+cost row aggregated from /metrics. */
export interface BifrostModelUsage {
  provider: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function getFetchBifrost(): SpendFetch {
  return getFetch();
}

function toFetchError(error: unknown, timeoutMs: number, label: string): AxiError {
  if (error instanceof Error && (/abort/i.test(error.name) || error.name === "TimeoutError")) {
    return new AxiError(`Bifrost gateway timed out after ${timeoutMs}ms for ${label}`, "TIMEOUT", [
      "Retry; the gateway was too slow to respond",
    ]);
  }
  return new AxiError(
    `Bifrost gateway request failed for ${label}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    "NETWORK_ERROR",
    ["Check the gateway is running and reachable at the configured base"],
  );
}

async function bifrostGet<T>(
  base: string,
  path: string,
  label: string,
  key: string | undefined,
  opts: BifrostRequestOptions = {},
): Promise<T> {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await getFetchBifrost()(url, {
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
    throw mapGatewayError(response.status, text, label, "bifrost");
  }
  if (text.length === 0) {
    throw new AxiError(`Bifrost gateway returned an empty response for ${label}`, "UNKNOWN");
  }
  // /metrics returns Prometheus text, not JSON — caller handles parsing.
  if (path === "/metrics") {
    return text as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AxiError(
      `Bifrost gateway returned non-JSON for ${label}: ${text.slice(0, 200)}`,
      "UNKNOWN",
    );
  }
}

/** Health reachability (GET /health, no auth). Never throws. */
export async function getBifrostHealth(
  base: string,
  opts: BifrostRequestOptions = {},
): Promise<{ reachable: boolean; status: string; db: string }> {
  try {
    const body = await bifrostGet<HealthResponse>(base, "/health", "health", undefined, opts);
    return {
      reachable: true,
      status: body.status ?? "unknown",
      db: body.components?.db_pings ?? "unknown",
    };
  } catch {
    return { reachable: false, status: "unreachable", db: "unknown" };
  }
}

/**
 * Per-provider daily spend vs budget (GET /api/governance/model-configs).
 * Aggregates current_usage + max_limit per provider across all its
 * model-config budgets. The management API is unauthenticated on this host;
 * `key` is only sent when set (for the locked-down case). Throws on
 * auth/network error; the caller maps to a view error.
 */
export async function getBifrostProviderBudgets(
  base: string,
  key: string | undefined,
  opts: BifrostRequestOptions = {},
): Promise<BifrostProviderBudget[]> {
  const body = await bifrostGet<ModelConfigsResponse>(
    base,
    "/api/governance/model-configs",
    "bifrost-provider-budgets",
    key,
    opts,
  );
  const configs = body.model_configs ?? [];
  const byProvider = new Map<string, BifrostProviderBudget>();
  for (const cfg of configs) {
    if (!cfg.provider) continue;
    let row = byProvider.get(cfg.provider);
    if (!row) {
      row = {
        provider: cfg.provider,
        spendUsd: 0,
        budgetUsd: 0,
        lastReset: null,
        resetDuration: null,
      };
      byProvider.set(cfg.provider, row);
    }
    for (const b of cfg.budgets ?? []) {
      row.spendUsd += Number(b.current_usage) || 0;
      row.budgetUsd += Number(b.max_limit) || 0;
      // Keep the most recent last_reset (lexicographically max ISO timestamp).
      if (b.last_reset && (!row.lastReset || b.last_reset > row.lastReset)) {
        row.lastReset = b.last_reset;
      }
      if (b.reset_duration && !row.resetDuration) {
        row.resetDuration = b.reset_duration;
      }
    }
  }
  return Array.from(byProvider.values()).sort((a, b) => b.spendUsd - a.spendUsd);
}

/**
 * Per-model cumulative token+cost breakdown (GET /metrics, Prometheus).
 * Aggregates bifrost_cost_total / bifrost_input_tokens_total /
 * bifrost_output_tokens_total / bifrost_cache_read_input_tokens_total by
 * {provider, model}. These are CUMULATIVE since the Bifrost process started —
 * Bifrost v1.6.4 has no native per-model-per-day surface. Never throws: a
 * parse failure or unreachable /metrics yields an empty array (definitive
 * empty state — never fabricated numbers).
 */
export async function getBifrostModelUsage(
  base: string,
  key: string | undefined,
  opts: BifrostRequestOptions = {},
): Promise<BifrostModelUsage[]> {
  let text: string;
  try {
    text = await bifrostGet<string>(base, "/metrics", "bifrost-metrics", key, opts);
  } catch {
    return [];
  }
  return parseBifrostMetrics(text);
}

/**
 * Parse Prometheus exposition text into per-{provider,model} aggregates.
 * Exported for direct unit testing without network I/O.
 */
export function parseBifrostMetrics(text: string): BifrostModelUsage[] {
  const byKey = new Map<string, BifrostModelUsage>();
  const lines = text.split("\n");
  for (const raw of lines) {
    if (!raw.startsWith("bifrost_")) continue;
    // Only aggregate the four spend/token counters. Other bifrost_* series
    // (active_requests, latency, retries, provider_key_up) are not spend data.
    const nameMatch = raw.match(
      /^(bifrost_(?:cost|input_tokens|output_tokens|cache_read_input_tokens)_total)/,
    );
    if (!nameMatch) continue;
    const counter = nameMatch[1];
    const parsed = parsePromLine(raw);
    if (!parsed) continue;
    const provider = parsed.labels.provider ?? "";
    const model = parsed.labels.model ?? "";
    if (!provider || !model) continue;
    const key = `${provider}\u0000${model}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        provider,
        model,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      };
      byKey.set(key, row);
    }
    const value = parsed.value;
    switch (counter) {
      case "bifrost_cost_total":
        row.costUsd += value;
        break;
      case "bifrost_input_tokens_total":
        row.inputTokens += value;
        break;
      case "bifrost_output_tokens_total":
        row.outputTokens += value;
        break;
      case "bifrost_cache_read_input_tokens_total":
        row.cacheReadTokens += value;
        break;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.costUsd - a.costUsd);
}

interface ParsedPromLine {
  labels: Record<string, string>;
  value: number;
}

function parsePromLine(line: string): ParsedPromLine | null {
  // Shape: metric_name{label="v",...} <number>
  const braceOpen = line.indexOf("{");
  const braceClose = line.indexOf("}", braceOpen);
  const space = line.lastIndexOf(" ");
  if (braceOpen < 0 || braceClose < 0 || space < 0 || space < braceClose) return null;
  const labelsText = line.slice(braceOpen + 1, braceClose);
  const labels = parsePromLabels(labelsText);
  const valueText = line.slice(space + 1).trim();
  const value = Number(valueText);
  if (!Number.isFinite(value)) return null;
  return { labels, value };
}

function parsePromLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Walk label="value" pairs honoring escaped quotes/backslashes inside values.
  let i = 0;
  while (i < text.length) {
    const eq = text.indexOf("=", i);
    if (eq < 0) break;
    const name = text.slice(i, eq).trim();
    if (text[eq + 1] !== '"') break;
    let j = eq + 2;
    let value = "";
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\\") {
        value += text[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (ch === '"') break;
      value += ch;
      j += 1;
    }
    out[name] = value;
    i = j + 1;
    // skip trailing comma/whitespace
    while (i < text.length && (text[i] === "," || text[i] === " ")) i += 1;
  }
  return out;
}
