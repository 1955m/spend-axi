import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { parseContextArgs, resolveSpendContext, type SpendContext } from "./context.js";
import { AxiError, exitCodeForError } from "./errors.js";
import { createSkillMarkdown } from "./skill.js";
import { homeCommand, HOME_HELP } from "./commands/home.js";
import { gatewayCommand, GATEWAY_HELP } from "./commands/gateway.js";
import { cursorCommand, CURSOR_HELP } from "./commands/cursor.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";
import { DEFAULT_GATEWAY, DEFAULT_CURSOR_CAP_USD, DEFAULT_GATEWAY_SOURCE } from "./config.js";
import { renderError } from "./toon.js";

export const DESCRIPTION =
  "Agent ergonomic interface for spend posture. Prefer this for a one-shot snapshot of gateway + cursor + subscription spend.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: spend-axi [command] [args] [flags]
commands[4]:
  (none)=snapshot, gateway, cursor, setup
flags[4]:
  --gateway-source <bifrost|litellm> (default ${DEFAULT_GATEWAY_SOURCE}), --gateway <url> (default ${DEFAULT_GATEWAY}), --cursor-cap <usd> (default ${DEFAULT_CURSOR_CAP_USD}), --json, --help, -v/-V/--version
sources:
  subscriptions: quota-axi --json (external local-first tracker)
  gateway (bifrost, default): http://127.0.0.1:8090 /health + /api/governance/model-configs (per-provider daily budget window) + /metrics (per-model cumulative token+cost); management API unauthenticated (SPEND_AXI_BIFROST_KEY only if locked down)
  gateway (litellm, fallback): http://127.0.0.1:4000 /provider/budgets + /global/spend/logs (needs SPEND_AXI_GATEWAY_KEY / LITELLM_MASTER_KEY / ~/.config/spend-axi/gateway-key); LiteLLM is stopped-not-deleted (audit 7)
  cursor: local ai-code-tracking DB (activity); dollar spend flagged not-wired (no API yet)
examples:
  spend-axi
  spend-axi gateway
  spend-axi cursor --json
  spend-axi --cursor-cap 60
  spend-axi gateway --gateway-source litellm --gateway http://127.0.0.1:4000
  spend-axi setup hooks
`;

const COMMAND_HELP: Record<string, string> = {
  gateway: GATEWAY_HELP,
  cursor: CURSOR_HELP,
  setup: SETUP_HELP,
  home: HOME_HELP,
};

const COMMANDS = {
  gateway: withContext(gatewayCommand),
  cursor: withContext(cursorCommand),
  setup: withContext(setupCommand),
};

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;

  // --skill prints the agent-harness SKILL.md and exits. Handled before
  // runAxiCli so the leading flag is not rejected as "flags must come after
  // the command".
  if (argv.length === 1 && argv[0] === "--skill") {
    stdout.write(`${createSkillMarkdown()}\n`);
    return;
  }

  // Pre-parse the global context flags (--gateway / --cursor-cap / --json) so
  // they may appear as leading flags (e.g. `spend-axi --json`) AND so they are
  // stripped before the SDK sees argv (the SDK rejects unknown leading flags
  // with VALIDATION_ERROR). The SDK's own args are not used for context — we
  // pre-resolve from the full argv and reuse the same ctx for every dispatch.
  // This happens before runAxiCli (and its internal try/catch) even starts, so
  // a bad flag/env value (VALIDATION_ERROR from parseContextArgs, or a plain
  // Error from a config resolver) is caught here directly — otherwise it would
  // escape as an unhandled promise rejection (bin/spend-axi.ts calls main()
  // with no .catch()) instead of the tool's structured error/code/help output.
  let cleanArgv: string[];
  let ctx: SpendContext;
  try {
    const ctxFlags = parseContextArgs(argv);
    cleanArgv = ctxFlags.strippedArgs;
    ctx = resolveSpendContext(ctxFlags);
  } catch (error) {
    const { message, code, suggestions } =
      error instanceof AxiError
        ? { message: error.message, code: error.code, suggestions: error.suggestions }
        : {
            message: error instanceof Error ? error.message : String(error),
            code: "VALIDATION_ERROR",
            suggestions: [] as string[],
          };
    stdout.write(`${renderError(message, code, suggestions)}\n`);
    process.exitCode = error instanceof AxiError ? exitCodeForError(error) : 2;
    return;
  }

  // Home + --json: render pure JSON directly so jq/firstmate get parseable
  // output. The SDK prepends a bin:/description: header to the home command,
  // which would corrupt JSON (commands are not headered, so only home needs
  // this bypass).
  if (cleanArgv.length === 0 && ctx.json) {
    const out = await homeCommand([], ctx);
    stdout.write(`${out}\n`);
    return;
  }

  await runAxiCli<SpendContext>({
    argv: cleanArgv,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    stdout,
    home: withContext(homeCommand),
    commands: COMMANDS,
    getCommandHelp: (command: string) => COMMAND_HELP[command] ?? null,
    resolveContext: (): SpendContext => ctx,
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf-8"));
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }
  throw new Error("Could not determine spend-axi package version");
}

/**
 * Strip the context flags (--gateway / --cursor-cap / --json) from args before
 * dispatching to a command, and adapt the SDK's `TContext | undefined` to a
 * guaranteed SpendContext (resolveContext always returns one; the fallback is
 * defensive). Mirrors glab-axi's withProjectContext.
 */
function withContext(
  handler: (args: string[], ctx: SpendContext) => Promise<string>,
): (args: string[], ctx: SpendContext | undefined) => Promise<string> {
  return (args: string[], ctx: SpendContext | undefined): Promise<string> => {
    const context: SpendContext = ctx ?? {
      gatewaySource: DEFAULT_GATEWAY_SOURCE,
      gatewayBase: DEFAULT_GATEWAY,
      gatewayKey: undefined,
      bifrostKey: undefined,
      cursorCapUsd: DEFAULT_CURSOR_CAP_USD,
      json: false,
    };
    const { strippedArgs } = parseContextArgs(args);
    return handler(strippedArgs, context);
  };
}

export { DEFAULT_GATEWAY, DEFAULT_CURSOR_CAP_USD, DEFAULT_GATEWAY_SOURCE };
