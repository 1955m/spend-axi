import { encode } from "@toon-format/toon";
import {
  getHealth,
  getProviderBudgets,
  getGlobalSpendToday,
  type GatewayRequestOptions,
} from "../gateway.js";
import {
  getBifrostHealth,
  getBifrostModelUsage,
  getBifrostProviderBudgets,
  type BifrostRequestOptions,
} from "../bifrost.js";
import { AxiError } from "../errors.js";
import {
  gatewayModelsPlain,
  gatewayPlain,
  gatewayProvidersPlain,
  pctUsed,
  type GatewaySource,
  type GatewayView,
} from "../views.js";
import { renderHelp, renderOutput } from "../toon.js";
import { rejectUnknownFlags, requireBifrostKey, type SpendContext } from "../context.js";

export const GATEWAY_HELP = `usage: spend-axi gateway [flags]
Gateway spend posture: today's total spend + per-provider spend vs the live
provider_budget_config (read from the gateway, never hardcoded). Defaults to
the Bifrost source (live gateway at :8090); the LiteLLM source is kept as a
stopped-not-deleted fallback while LiteLLM is down (audit 7).

flags[3]:
  --gateway-source <bifrost|litellm> (default bifrost), --gateway <url>, --json, --help
bifrost source:
  GET /health, GET /api/governance/model-configs (per-provider daily budget window),
  GET /metrics (per-model cumulative token+cost since process start). Management
  API is unauthenticated on this host; set SPEND_AXI_BIFROST_KEY only if
  auth_config.is_enabled is ever flipped on.
litellm source (fallback):
  GET /health/readiness (no key) + /provider/budgets + /global/spend/logs (master key)
auth (litellm only):
  SPEND_AXI_GATEWAY_KEY env > LITELLM_MASTER_KEY env > ~/.config/spend-axi/gateway-key
examples:
  spend-axi gateway
  spend-axi gateway --json
  spend-axi gateway --gateway-source litellm --gateway http://127.0.0.1:4000
`;

/**
 * Gather the gateway view, routing to the Bifrost source (default, audit 7) or
 * the LiteLLM source (--gateway-source litellm). Never throws — failures land
 * in view.error so the snapshot stays complete. The two sources share the
 * GatewayView shape; the Bifrost source additionally fills view.models with a
 * per-model cumulative token+cost breakdown from /metrics.
 */
export async function gatherGateway(
  ctx: SpendContext,
  opts: GatewayRequestOptions & BifrostRequestOptions = {},
): Promise<GatewayView> {
  if (ctx.gatewaySource === "litellm") {
    return gatherLitellmGateway(ctx, opts);
  }
  return gatherBifrostGateway(ctx, opts);
}

/** LiteLLM gateway view (the legacy /provider/budgets + /global/spend/logs source). */
async function gatherLitellmGateway(
  ctx: SpendContext,
  opts: GatewayRequestOptions,
): Promise<GatewayView> {
  const base = ctx.gatewayBase;
  const health = await getHealth(base, opts);
  if (!ctx.gatewayKey) {
    return {
      source: "litellm",
      base,
      reachable: health.reachable,
      auth: false,
      window: "today UTC",
      todayTotalUsd: null,
      providers: [],
      models: [],
      error: { code: "AUTH_REQUIRED", message: "gateway key not found" },
    };
  }
  try {
    const [budgets, todayTotal] = await Promise.all([
      getProviderBudgets(base, ctx.gatewayKey, opts),
      getGlobalSpendToday(base, ctx.gatewayKey, opts),
    ]);
    const providers = Object.entries(budgets)
      .map(([name, b]) => ({
        name,
        spendUsd: Number(b.spend),
        budgetUsd: Number(b.budget_limit),
        pctUsed: pctUsed(Number(b.spend), Number(b.budget_limit)),
        reset: b.budget_reset_at,
      }))
      .sort((a, b) => b.pctUsed - a.pctUsed);
    return {
      source: "litellm",
      base,
      reachable: health.reachable,
      auth: true,
      window: "today UTC",
      todayTotalUsd: todayTotal,
      providers,
      models: [],
    };
  } catch (error) {
    const code = error instanceof AxiError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: "litellm",
      base,
      reachable: health.reachable,
      auth: true,
      window: "today UTC",
      todayTotalUsd: null,
      providers: [],
      models: [],
      error: { code, message },
    };
  }
}

/** Bifrost gateway view (the live source since 2026-07-19, audit 7). */
async function gatherBifrostGateway(
  ctx: SpendContext,
  opts: BifrostRequestOptions,
): Promise<GatewayView> {
  const base = ctx.gatewayBase;
  const health = await getBifrostHealth(base, opts);
  if (!health.reachable) {
    return {
      source: "bifrost",
      base,
      reachable: false,
      auth: false,
      window: "1d",
      todayTotalUsd: null,
      providers: [],
      models: [],
      error: { code: "NETWORK_ERROR", message: "bifrost gateway unreachable" },
    };
  }
  try {
    const bifrostKey = requireBifrostKey(ctx);
    const [providerBudgets, models] = await Promise.all([
      getBifrostProviderBudgets(base, bifrostKey, opts),
      getBifrostModelUsage(base, bifrostKey, opts),
    ]);
    if (providerBudgets.length === 0) {
      // Definitive empty state (AXI P5): no governance budgets configured at
      // all is distinct from "$0 spent against a configured budget". Surface
      // it explicitly instead of fabricating a zero total.
      return {
        source: "bifrost",
        base,
        reachable: true,
        auth: true,
        window: "1d",
        todayTotalUsd: null,
        providers: [],
        models,
        error: {
          code: "NO_BUDGETS",
          message: "no governance model-config budgets configured on this gateway",
        },
      };
    }
    const providers = providerBudgets
      .map((b) => ({
        name: b.provider,
        spendUsd: b.spendUsd,
        budgetUsd: b.budgetUsd,
        pctUsed: pctUsed(b.spendUsd, b.budgetUsd),
        reset: b.lastReset,
      }))
      .sort((a, b) => b.pctUsed - a.pctUsed);
    const todayTotal = providerBudgets.reduce((sum, b) => sum + b.spendUsd, 0);
    return {
      source: "bifrost",
      base,
      reachable: true,
      auth: true,
      window: providerBudgets[0]?.resetDuration ?? "1d",
      todayTotalUsd: todayTotal,
      providers,
      models,
    };
  } catch (error) {
    const code = error instanceof AxiError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: "bifrost",
      base,
      reachable: true,
      auth: true,
      window: "1d",
      todayTotalUsd: null,
      providers: [],
      models: [],
      error: { code, message },
    };
  }
}

/** Render the gateway view as a TOON string. */
export function renderGateway(view: GatewayView): string {
  const blocks: string[] = [encode({ gateway: gatewayPlain(view) })];
  if (view.providers.length > 0) {
    blocks.push(encode({ gateway_providers: gatewayProvidersPlain(view) }));
  }
  if (view.models.length > 0) {
    blocks.push(encode({ gateway_models: gatewayModelsPlain(view) }));
  }
  return blocks.join("\n");
}

export async function gatewayCommand(args: string[], ctx: SpendContext): Promise<string> {
  if (args[0] === "--help") return GATEWAY_HELP;
  rejectUnknownFlags(args, [], "gateway");
  const view = await gatherGateway(ctx);
  if (ctx.json) {
    return JSON.stringify(view, null, 2);
  }
  return renderOutput([renderGateway(view), renderHelp(gatewayHints(view))]);
}

function gatewayHints(view: GatewayView): string[] {
  const hints: string[] = [];
  if (!view.reachable) {
    hints.push(`Check the ${view.source} gateway is running at ` + view.base);
  } else if (view.error && view.error.code === "AUTH_REQUIRED") {
    if (view.source === "litellm") {
      hints.push(
        "Set SPEND_AXI_GATEWAY_KEY (or LITELLM_MASTER_KEY), or write ~/.config/spend-axi/gateway-key",
      );
    } else {
      hints.push(
        "Set SPEND_AXI_BIFROST_KEY to authenticate with the locked-down Bifrost management API",
      );
    }
  } else if (view.error && view.error.code === "NO_BUDGETS") {
    hints.push(
      "No governance budgets configured — POST to /api/governance/model-configs on the Bifrost gateway",
    );
  }
  hints.push("Run `spend-axi` for the full snapshot (subscriptions + gateway + cursor)");
  hints.push("Run `spend-axi gateway --json` for machine-readable output");
  if (view.source === "bifrost") {
    hints.push(
      "Run `spend-axi gateway --gateway-source litellm --gateway http://127.0.0.1:4000` for the stopped LiteLLM fallback",
    );
  }
  return hints;
}

// Re-export so callers (home.ts) can branch on the resolved source if needed.
export type { GatewaySource };
