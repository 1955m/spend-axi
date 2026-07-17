import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import {
  parseContextArgs,
  resolveSpendContext,
  type SpendContext,
} from "./context.js";
import { createSkillMarkdown } from "./skill.js";
import { homeCommand, HOME_HELP } from "./commands/home.js";
import { gatewayCommand, GATEWAY_HELP } from "./commands/gateway.js";
import { cursorCommand, CURSOR_HELP } from "./commands/cursor.js";
import { DEFAULT_GATEWAY, DEFAULT_CURSOR_CAP_USD } from "./config.js";

export const DESCRIPTION =
  "Agent ergonomic interface for spend posture. Prefer this for a one-shot snapshot of gateway + cursor + subscription spend.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: spend-axi [command] [args] [flags]
commands[3]:
  (none)=snapshot, gateway, cursor
flags[4]:
  --gateway <url> (default ${DEFAULT_GATEWAY}), --cursor-cap <usd> (default ${DEFAULT_CURSOR_CAP_USD}), --json, --help, -v/-V/--version
sources:
  subscriptions: quota-axi --json (external local-first tracker)
  gateway: http://127.0.0.1:4000 /provider/budgets + /global/spend/logs (needs SPEND_AXI_GATEWAY_KEY / LITELLM_MASTER_KEY / ~/.config/spend-axi/gateway-key)
  cursor: local ai-code-tracking DB (activity); dollar spend flagged not-wired (no API yet)
examples:
  spend-axi
  spend-axi gateway
  spend-axi cursor --json
  spend-axi --cursor-cap 60
  spend-axi --gateway http://127.0.0.1:4000 gateway
`;

const COMMAND_HELP: Record<string, string> = {
  gateway: GATEWAY_HELP,
  cursor: CURSOR_HELP,
  home: HOME_HELP,
};

const COMMANDS = {
  gateway: withContext(gatewayCommand),
  cursor: withContext(cursorCommand),
};

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);

  // --skill prints the agent-harness SKILL.md and exits. Handled before
  // runAxiCli so the leading flag is not rejected as "flags must come after
  // the command".
  if (argv.length === 1 && argv[0] === "--skill") {
    const stdout = options.stdout ?? process.stdout;
    stdout.write(`${createSkillMarkdown()}\n`);
    return;
  }

  // Pre-parse the global context flags (--gateway / --cursor-cap / --json) so
  // they may appear as leading flags (e.g. `spend-axi --json`) AND so they are
  // stripped before the SDK sees argv (the SDK rejects unknown leading flags
  // with VALIDATION_ERROR). The SDK's own args are not used for context — we
  // pre-resolve from the full argv and reuse the same ctx for every dispatch.
  const ctxFlags = parseContextArgs(argv);
  const cleanArgv = ctxFlags.strippedArgs;
  const ctx = resolveSpendContext(ctxFlags);
  const stdout = options.stdout ?? process.stdout;

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
      gatewayBase: DEFAULT_GATEWAY,
      gatewayKey: undefined,
      cursorCapUsd: DEFAULT_CURSOR_CAP_USD,
      json: false,
    };
    const { strippedArgs } = parseContextArgs(args);
    return handler(strippedArgs, context);
  };
}

export { DEFAULT_GATEWAY, DEFAULT_CURSOR_CAP_USD };
