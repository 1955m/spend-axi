import type { QuotaSnapshot, QuotaProvider } from "./quota.js";
import type { CursorSnapshot } from "./cursor.js";

/** Format a USD number to 2 decimals; null/undefined → "—". */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(2);
}

/** Percentage of budget used, rounded. 0 when no budget. */
export function pctUsed(spend: number, budget: number): number {
  if (!budget || budget <= 0) return 0;
  return Math.round((spend / budget) * 100);
}

/**
 * Summarize a provider's remaining capacity across its windows. Uses
 * percentRemaining per window (labeled) when present; falls back to credits;
 * else "—".
 */
export function summarizeRemaining(provider: QuotaProvider): string {
  if (provider.windows.length > 0) {
    return provider.windows
      .map((w) => {
        const label = w.label ?? w.id ?? "window";
        const rem = w.percentRemaining ?? 0;
        return `${label}:${rem}%`;
      })
      .join(" ");
  }
  const c = provider.credits;
  if (c) {
    if (c.unlimited) return "unlimited";
    return `${c.remaining ?? 0} ${c.unit ?? "credits"}`;
  }
  return "—";
}

/** Earliest window reset date (YYYY-MM-DD), or "—" when none. */
export function nearestResetDate(provider: QuotaProvider): string {
  const dates = provider.windows
    .map((w) => w.resetsAt)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort();
  if (dates.length === 0) return "—";
  return dates[0].slice(0, 10);
}

/** A compact relative-time string (e.g. "3h ago", "2d ago") from an ISO date. */
export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "—";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 0) return "future";
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon}mo ago`;
  return `${Math.floor(diffMon / 12)}y ago`;
}

/** Gateway view: plain serializable data for both TOON rendering and --json. */
export interface GatewayView {
  base: string;
  reachable: boolean;
  auth: boolean;
  todayTotalUsd: number | null;
  providers: Array<{
    name: string;
    spendUsd: number;
    budgetUsd: number;
    pctUsed: number;
    reset: string | null;
  }>;
  error?: { code: string; message: string };
}

/** Plain (serializable) gateway detail block for TOON + --json. */
export function gatewayPlain(view: GatewayView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    base: view.base,
    reachable: view.reachable ? "yes" : "no",
    auth: view.auth ? "yes" : "no",
    today_total_usd: formatUsd(view.todayTotalUsd),
  };
  if (view.error) {
    out["error"] = view.error.message;
    out["error_code"] = view.error.code;
  }
  return out;
}

/** Plain gateway provider-budget rows for TOON + --json. */
export function gatewayProvidersPlain(
  view: GatewayView,
): Array<Record<string, unknown>> {
  return view.providers.map((p) => ({
    provider: p.name,
    spend_usd: formatUsd(p.spendUsd),
    budget_usd: p.budgetUsd,
    pct_used: p.pctUsed,
    reset: p.reset ?? "—",
  }));
}

/** Plain cursor block for TOON + --json. */
export function cursorPlain(snapshot: CursorSnapshot): Record<string, unknown> {
  return {
    spend_usd: snapshot.spendUsd,
    daily_cap_usd: snapshot.dailyCapUsd,
    headroom_usd: snapshot.headroomUsd,
    pct_used: snapshot.pctUsed,
    status: snapshot.status,
    requests_today: snapshot.activity.requestsToday,
    models_today: snapshot.activity.modelsToday.join(",") || "none",
    note: snapshot.note,
  };
}

/**
 * Plain subscriptions block. Compact per-provider rows (provider, plan,
 * status, remaining, reset) for TOON; the full QuotaSnapshot is preserved for
 * --json by the caller. `error` set when quota-axi failed.
 */
export function subscriptionsPlain(
  snapshot: QuotaSnapshot | { error: string },
): Record<string, unknown> {
  if ("error" in snapshot) {
    return { error: snapshot.error };
  }
  return {
    generatedAt: snapshot.generatedAt ?? "—",
    providers: snapshot.providers.map((p: QuotaProvider) => ({
      provider: p.provider,
      plan: p.plan ?? "—",
      status: p.status ?? "—",
      remaining: summarizeRemaining(p),
      reset: nearestResetDate(p),
    })),
  };
}
