import { AxiError, noGatewayKeyError } from "./errors.js";
import {
  resolveGatewayBase,
  resolveGatewaySource,
  resolveBifrostKey,
  resolveGatewayKey,
  resolveCursorCapUsd,
  resolveJson,
  type GatewaySource,
} from "./config.js";

/**
 * Resolved context passed to every spend-axi command handler. spend-axi has no
 * vendor "project/host" concept (unlike glab-axi); the context is the gateway
 * base URL + the resolved gateway source + the per-source key + the cursor
 * daily cap + the json flag. `gatewayKey` (LiteLLM master key) and `bifrostKey`
 * (Bifrost management key, almost always undefined) may both be undefined;
 * commands that must call an authenticated endpoint resolve one with
 * requireGatewayKey() (LiteLLM) or requireBifrostKey() (Bifrost, when the
 * management API is locked down).
 */
export interface SpendContext {
  gatewaySource: GatewaySource;
  gatewayBase: string;
  gatewayKey: string | undefined;
  bifrostKey: string | undefined;
  cursorCapUsd: number;
  json: boolean;
}

/** Build a SpendContext from the resolved context flags + runtime config. */
export function resolveSpendContext(flags: ContextFlags): SpendContext {
  const source = resolveGatewaySource(flags.gatewaySourceFlag);
  return {
    gatewaySource: source,
    gatewayBase: resolveGatewayBase(flags.gatewayFlag, source),
    gatewayKey: resolveGatewayKey(),
    bifrostKey: resolveBifrostKey(),
    cursorCapUsd: resolveCursorCapUsd(flags.cursorCapFlag),
    json: resolveJson(flags.jsonFlag),
  };
}

/**
 * Return a validated { gatewayBase, gatewayKey } for the LiteLLM admin spend
 * endpoints (/provider/budgets, /global/spend/logs), or throw AUTH_REQUIRED
 * when no key is resolvable. gateway/commands all funnel here; the home digest
 * reports `auth: no` without throwing.
 */
export function requireGatewayKey(ctx: SpendContext): {
  gatewayBase: string;
  gatewayKey: string;
} {
  if (!ctx.gatewayKey) throw noGatewayKeyError();
  return { gatewayBase: ctx.gatewayBase, gatewayKey: ctx.gatewayKey };
}

/**
 * Return the resolved Bifrost management API key, or undefined. Unlike
 * requireGatewayKey(), this never throws: whether the management API is
 * locked down is only discoverable from the response itself (a 401 from
 * bifrostGet(), mapped to AUTH_REQUIRED by mapGatewayError()), not knowable
 * ahead of the call. gatherBifrostGateway() routes through this helper (over
 * reading ctx.bifrostKey directly) so all Bifrost key resolution stays in one
 * place.
 */
export function requireBifrostKey(ctx: SpendContext): string | undefined {
  return ctx.bifrostKey;
}

export interface ContextFlags {
  gatewayFlag: string | undefined;
  gatewaySourceFlag: string | undefined;
  cursorCapFlag: string | undefined;
  jsonFlag: boolean;
  strippedArgs: string[];
}

/** Strip --gateway / --gateway-source / --cursor-cap / --json (space or =) from args. */
export function parseContextArgs(args: string[]): ContextFlags {
  const stripped: string[] = [];
  let gatewayFlag: string | undefined;
  let gatewaySourceFlag: string | undefined;
  let cursorCapFlag: string | undefined;
  let jsonFlag = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--gateway" && index + 1 < args.length) {
      gatewayFlag = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("--gateway=") && arg.length > "--gateway=".length) {
      gatewayFlag = arg.slice("--gateway=".length);
      continue;
    }

    if (arg === "--gateway-source" && index + 1 < args.length) {
      gatewaySourceFlag = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("--gateway-source=") && arg.length > "--gateway-source=".length) {
      gatewaySourceFlag = arg.slice("--gateway-source=".length);
      continue;
    }

    if (arg === "--cursor-cap" && index + 1 < args.length) {
      cursorCapFlag = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("--cursor-cap=") && arg.length > "--cursor-cap=".length) {
      cursorCapFlag = arg.slice("--cursor-cap=".length);
      continue;
    }

    if (arg === "--json") {
      jsonFlag = true;
      continue;
    }

    stripped.push(arg);
  }

  // Validate cursor-cap early so a bad value surfaces as VALIDATION_ERROR
  // before any network/subprocess work.
  if (cursorCapFlag !== undefined) {
    const n = Number(cursorCapFlag);
    if (!Number.isFinite(n) || n < 0) {
      throw new AxiError(
        `Invalid --cursor-cap value: ${cursorCapFlag} (expected a non-negative USD number)`,
        "VALIDATION_ERROR",
        ["Example: --cursor-cap 60"],
      );
    }
  }

  // Validate gateway-source early so a bad value surfaces as VALIDATION_ERROR
  // before any dependency call.
  if (gatewaySourceFlag !== undefined) {
    const v = gatewaySourceFlag.trim().toLowerCase();
    if (v !== "bifrost" && v !== "litellm") {
      throw new AxiError(
        `Invalid --gateway-source value: ${gatewaySourceFlag} (expected 'bifrost' or 'litellm')`,
        "VALIDATION_ERROR",
        ["Example: --gateway-source litellm --gateway http://127.0.0.1:4000"],
      );
    }
  }

  return { gatewayFlag, gatewaySourceFlag, cursorCapFlag, jsonFlag, strippedArgs: stripped };
}

// ── per-command flag validation (AXI principle 6: fail loud on unknown flags) ─

/**
 * Flags allowed on every command. --gateway / --gateway-source / --cursor-cap
 * / --json are the global spend selectors (already stripped from args by
 * withContext/ parseContextArgs before a command sees them); --help always
 * passes. All five are never reported as unknown.
 */
const GLOBAL_FLAGS = new Set(["--gateway", "--gateway-source", "--cursor-cap", "--json", "--help"]);

/**
 * Reject unknown flags before any dependency call (exit 2). Globals
 * (--gateway / --gateway-source / --cursor-cap / --json, already stripped,
 * plus --help) are always allowed. Lists the command's valid flags inline so
 * the agent self-corrects in one turn — mirroring cloudflare-axi's /
 * tg-axi's rejectUnknownFlags.
 */
export function rejectUnknownFlags(args: string[], known: string[], commandPath: string): void {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (known.includes(name) || GLOBAL_FLAGS.has(name)) continue;
    throw new AxiError(`unknown flag ${name} for \`${commandPath}\``, "VALIDATION_ERROR", [
      `valid flags for \`${commandPath}\`: ${[...known, "--help"].join(", ")}`,
      "(--help always allowed; --gateway / --gateway-source / --cursor-cap / --json are global selectors placed after the command)",
    ]);
  }
}
