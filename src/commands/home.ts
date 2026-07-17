import { encode } from "@toon-format/toon";
import { runQuotaAxi, type QuotaSnapshot } from "../quota.js";
import { gatherCursor, renderCursor } from "./cursor.js";
import { gatherGateway, renderGateway } from "./gateway.js";
import {
  formatUsd,
  subscriptionsPlain,
  type GatewayView,
} from "../views.js";
import { renderHelp, renderOutput } from "../toon.js";
import type { SpendContext } from "../context.js";
import type { CursorSnapshot } from "../cursor.js";

export const HOME_HELP = "";

type SubscriptionsResult = QuotaSnapshot | { error: string };

export const HOME_HELP_PLACEHOLDER = HOME_HELP;

/**
 * Full spend snapshot (no-args dashboard). The SDK prepends `bin:` + `description:`.
 * spend-axi composes: subscriptions (quota-axi) + gateway (LiteLLM) + cursor,
 * with a one-line headline firstmate can relay. Never aborts on a single
 * source failing — each section degrades gracefully.
 */
export async function homeCommand(
  _args: string[],
  ctx: SpendContext,
): Promise<string> {
  const [subsResult, gatewayView, cursorSnapshot] = await Promise.all([
    gatherSubscriptions(),
    gatherGateway(ctx),
    Promise.resolve(gatherCursor(ctx)),
  ]);
  const headline = buildHeadline(subsResult, gatewayView, cursorSnapshot);

  if (ctx.json) {
    return JSON.stringify(
      {
        headline,
        subscriptions: subsResult,
        gateway: gatewayView,
        cursor: cursorSnapshot,
      },
      null,
      2,
    );
  }

  return renderOutput([
    encode({ headline }),
    encode({ subscriptions: subscriptionsPlain(subsResult) }),
    renderGateway(gatewayView),
    renderCursor(cursorSnapshot),
    renderHelp(homeHints(subsResult, gatewayView, cursorSnapshot)),
  ]);
}

async function gatherSubscriptions(): Promise<SubscriptionsResult> {
  try {
    return await runQuotaAxi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

function buildHeadline(
  subs: SubscriptionsResult,
  gw: GatewayView,
  cursor: CursorSnapshot,
): string {
  const gwPart = gatewayHeadline(gw);
  const cursorPart =
    cursor.spendUsd === "not wired"
      ? "cursor not-wired"
      : `cursor $${cursor.spendUsd}`;
  const subsPart = subscriptionsHeadline(subs);
  return `${gwPart} | ${cursorPart} | ${subsPart}`;
}

function gatewayHeadline(gw: GatewayView): string {
  if (!gw.reachable) return "gateway down";
  if (gw.error) {
    if (gw.error.code === "AUTH_REQUIRED") return "gateway no-key";
    return `gateway err:${gw.error.code}`;
  }
  const today = formatUsd(gw.todayTotalUsd);
  const top = gw.providers[0];
  if (top && top.budgetUsd > 0) {
    return `gateway $${today} today (${top.name} ${top.pctUsed}% of $${top.budgetUsd})`;
  }
  return `gateway $${today} today`;
}

function subscriptionsHeadline(subs: SubscriptionsResult): string {
  if ("error" in subs) return "subs n/a";
  const claude = subs.providers.find((p) => p.provider === "claude");
  if (claude && claude.windows.length > 0) {
    const session =
      claude.windows.find((w) => w.kind === "session") ?? claude.windows[0];
    const rem = session.percentRemaining ?? 0;
    return `claude ${rem}% remaining`;
  }
  const codex = subs.providers.find((p) => p.provider === "codex");
  if (codex && codex.credits) {
    return `codex ${codex.credits.remaining ?? 0} credits`;
  }
  return "subs ok";
}

function homeHints(
  subs: SubscriptionsResult,
  gw: GatewayView,
  cursor: CursorSnapshot,
): string[] {
  const hints: string[] = [];
  if ("error" in subs) {
    hints.push("Subscriptions unavailable — run `quota-axi` to diagnose");
  }
  if (!gw.reachable) {
    hints.push("Gateway unreachable at " + gw.base + " — check the LiteLLM proxy is running");
  } else if (!gw.auth) {
    hints.push("Set SPEND_AXI_GATEWAY_KEY (or LITELLM_MASTER_KEY) to read gateway spend/budgets");
  }
  if (!cursor.activity.dbPresent) {
    hints.push("No cursor usage DB at ~/.cursor/ai-tracking — activity signal unavailable");
  }
  hints.push("Run `spend-axi gateway --json` or `spend-axi cursor --json` for focused machine-readable output");
  hints.push("Run `spend-axi --cursor-cap 60` to adjust the cursor daily cap for the headline");
  return hints;
}
