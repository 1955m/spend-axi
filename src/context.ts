import { AxiError, noGatewayKeyError } from "./errors.js";
import {
  resolveGatewayBase,
  resolveGatewayKey,
  resolveCursorCapUsd,
  resolveJson,
} from "./config.js";

/**
 * Resolved context passed to every spend-axi command handler. spend-axi has no
 * vendor "project/host" concept (unlike glab-axi); the context is the gateway
 * base URL + the resolved master key + the cursor daily cap + the json flag.
 * `gatewayKey` may be undefined here; commands that must call admin spend
 * endpoints resolve it with requireGatewayKey().
 */
export interface SpendContext {
  gatewayBase: string;
  gatewayKey: string | undefined;
  cursorCapUsd: number;
  json: boolean;
}

/** Build a SpendContext from the resolved context flags + runtime config. */
export function resolveSpendContext(flags: ContextFlags): SpendContext {
  return {
    gatewayBase: resolveGatewayBase(flags.gatewayFlag),
    gatewayKey: resolveGatewayKey(),
    cursorCapUsd: resolveCursorCapUsd(flags.cursorCapFlag),
    json: resolveJson(flags.jsonFlag),
  };
}

/**
 * Return a validated { gatewayBase, gatewayKey } for admin spend endpoints, or
 * throw AUTH_REQUIRED when no key is resolvable. gateway/commands all funnel
 * here; the home digest reports `auth: no` without throwing.
 */
export function requireGatewayKey(ctx: SpendContext): {
  gatewayBase: string;
  gatewayKey: string;
} {
  if (!ctx.gatewayKey) throw noGatewayKeyError();
  return { gatewayBase: ctx.gatewayBase, gatewayKey: ctx.gatewayKey };
}

export interface ContextFlags {
  gatewayFlag: string | undefined;
  cursorCapFlag: string | undefined;
  jsonFlag: boolean;
  strippedArgs: string[];
}

/** Strip --gateway / --cursor-cap / --json (space or equals form) from args. */
export function parseContextArgs(args: string[]): ContextFlags {
  const stripped: string[] = [];
  let gatewayFlag: string | undefined;
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

    if (arg === "--cursor-cap" && index + 1 < args.length) {
      cursorCapFlag = args[index + 1];
      index++;
      continue;
    }
    if (
      arg.startsWith("--cursor-cap=") &&
      arg.length > "--cursor-cap=".length
    ) {
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

  return { gatewayFlag, cursorCapFlag, jsonFlag, strippedArgs: stripped };
}
