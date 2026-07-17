import { encode } from "@toon-format/toon";
import {
  getHealth,
  getProviderBudgets,
  getGlobalSpendToday,
  type GatewayRequestOptions,
} from "../gateway.js";
import { AxiError } from "../errors.js";
import {
  gatewayPlain,
  gatewayProvidersPlain,
  pctUsed,
  type GatewayView,
} from "../views.js";
import { renderHelp, renderOutput } from "../toon.js";
import type { SpendContext } from "../context.js";

export const GATEWAY_HELP = `usage: spend-axi gateway [flags]
LiteLLM gateway spend posture: today's total spend + per-provider spend vs the
live provider_budget_config (read from the gateway, never hardcoded).

flags[3]:
  --gateway <url> (default http://127.0.0.1:4000), --json, --help
auth:
  SPEND_AXI_GATEWAY_KEY env > LITELLM_MASTER_KEY env > ~/.config/spend-axi/gateway-key
  /health/readiness works without a key; /provider/budgets + /global/spend/logs need the proxy-admin master key
examples:
  spend-axi gateway
  spend-axi gateway --json
  spend-axi gateway --gateway http://127.0.0.1:4000
`;

/**
 * Gather the gateway view: reachability (no-auth) + per-provider budgets +
 * today's total (master key). Never throws — failures land in view.error so the
 * snapshot stays complete.
 */
export async function gatherGateway(
  ctx: SpendContext,
  opts: GatewayRequestOptions = {},
): Promise<GatewayView> {
  const base = ctx.gatewayBase;
  const health = await getHealth(base, opts);
  if (!ctx.gatewayKey) {
    return {
      base,
      reachable: health.reachable,
      auth: false,
      todayTotalUsd: null,
      providers: [],
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
      base,
      reachable: health.reachable,
      auth: true,
      todayTotalUsd: todayTotal,
      providers,
    };
  } catch (error) {
    const code = error instanceof AxiError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    return {
      base,
      reachable: health.reachable,
      auth: true,
      todayTotalUsd: null,
      providers: [],
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
  return blocks.join("\n");
}

export async function gatewayCommand(
  args: string[],
  ctx: SpendContext,
): Promise<string> {
  if (args[0] === "--help") return GATEWAY_HELP;
  const view = await gatherGateway(ctx);
  if (ctx.json) {
    return JSON.stringify(view, null, 2);
  }
  return renderOutput([
    renderGateway(view),
    renderHelp(gatewayHints(view)),
  ]);
}

function gatewayHints(view: GatewayView): string[] {
  const hints: string[] = [];
  if (!view.reachable) {
    hints.push("Check the LiteLLM gateway is running at " + view.base);
  } else if (!view.auth) {
    hints.push(
      "Set SPEND_AXI_GATEWAY_KEY (or LITELLM_MASTER_KEY), or write ~/.config/spend-axi/gateway-key",
    );
  }
  hints.push("Run `spend-axi` for the full snapshot (subscriptions + gateway + cursor)");
  hints.push("Run `spend-axi gateway --json` for machine-readable output");
  return hints;
}
