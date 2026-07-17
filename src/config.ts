import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Default LiteLLM gateway base. The local proxy listens on 127.0.0.1:4000.
 * Override with SPEND_AXI_GATEWAY env (or the --gateway flag, which wins).
 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:4000";

/**
 * Cursor on-demand daily spend cap (USD). The captain mandates keeping cursor
 * spend under ~USD 50 per weekday with a claude-subscription fallback when the
 * cap is hit. Override with SPEND_AXI_CURSOR_CAP_USD env (or --cursor-cap).
 */
export const DEFAULT_CURSOR_CAP_USD = 50;

/** Environment variables read for runtime config (kept named for tests). */
export const GATEWAY_ENV = "SPEND_AXI_GATEWAY";
export const GATEWAY_KEY_ENV = "SPEND_AXI_GATEWAY_KEY";
export const GATEWAY_KEY_FALLBACK_ENV = "LITELLM_MASTER_KEY";
export const CURSOR_CAP_ENV = "SPEND_AXI_CURSOR_CAP_USD";
export const JSON_ENV = "SPEND_AXI_JSON";
export const CONFIG_DIR_ENV = "SPEND_AXI_CONFIG_DIR";

/** Resolve the gateway base URL: --gateway flag > SPEND_AXI_GATEWAY env > default. */
export function resolveGatewayBase(flagValue?: string): string {
  const v = (flagValue ?? "").trim();
  if (v) return v;
  const env = (process.env[GATEWAY_ENV] ?? "").trim();
  if (env) return env;
  return DEFAULT_GATEWAY;
}

/**
 * Resolve the LiteLLM master key (proxy-admin) used for the /spend/* and
 * /provider/budgets endpoints. The limited LITELLM_MCP_KEY virtual key cannot
 * read admin spend endpoints (role=unknown, 401).
 *
 * Priority: SPEND_AXI_GATEWAY_KEY env > LITELLM_MASTER_KEY env >
 * ~/.config/spend-axi/gateway-key file. Returns undefined when none is present
 * (commands map this to AUTH_REQUIRED); the gateway reachability check still
 * works unauthenticated via /health/readiness. The key is never logged.
 */
export function resolveGatewayKey(): string | undefined {
  const env1 = (process.env[GATEWAY_KEY_ENV] ?? "").trim();
  if (env1) return env1;
  const env2 = (process.env[GATEWAY_KEY_FALLBACK_ENV] ?? "").trim();
  if (env2) return env2;
  const file = gatewayKeyFilePath();
  if (existsSync(file)) {
    const v = readFileSync(file, "utf8").trim();
    if (v) return v;
  }
  return undefined;
}

/** Resolve the cursor daily cap (USD): --cursor-cap > env > default 50. */
export function resolveCursorCapUsd(flagValue?: string): number {
  const raw = (flagValue ?? "").trim();
  if (raw) return parseUsd(raw, "cursor-cap");
  const env = (process.env[CURSOR_CAP_ENV] ?? "").trim();
  if (env) return parseUsd(env, CURSOR_CAP_ENV);
  return DEFAULT_CURSOR_CAP_USD;
}

/** Resolve the --json output flag: --json flag > SPEND_AXI_JSON env (1/true). */
export function resolveJson(flagPresent: boolean): boolean {
  if (flagPresent) return true;
  const v = (process.env[JSON_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Path to the gateway-key file (~/.config/spend-axi/gateway-key). */
export function gatewayKeyFilePath(): string {
  return join(configDir(), "gateway-key");
}

/** Path to the cursor tracking DB (~/.cursor/ai-tracking/ai-code-tracking.db). */
export function cursorDbPath(): string {
  const env = (process.env["SPEND_AXI_CURSOR_DB"] ?? "").trim();
  if (env) return env;
  return join(homedir(), ".cursor", "ai-tracking", "ai-code-tracking.db");
}

/** Path to the quota-axi binary (PATH lookup; override via SPEND_AXI_QUOTA_BIN). */
export function quotaAxiBin(): string {
  return (process.env["SPEND_AXI_QUOTA_BIN"] ?? "").trim() || "quota-axi";
}

function configDir(): string {
  return process.env[CONFIG_DIR_ENV] ?? join(homedir(), ".config", "spend-axi");
}

function parseUsd(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid USD value for ${label}: ${raw}`);
  }
  return n;
}
