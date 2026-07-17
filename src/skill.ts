import { DESCRIPTION, TOP_HELP } from "./cli.js";

/** Trigger string agents match against to auto-load the skill. */
export const SKILL_DESCRIPTION =
  "Read spend posture through the spend-axi CLI - one compact snapshot of subscription windows, LiteLLM gateway daily spend, and Cursor on-demand daily spend. " +
  "Use whenever a task needs a spend/gateway/quota snapshot: checking the daily gateway budget headroom, whether cursor is approaching its daily cap, " +
  "or what subscription quota windows remain. Read-only; no mutations.";

export const SKILL_AUTHOR = "AXI Suite";

export const HERMES_TAGS = [
  "spend",
  "litellm",
  "cursor",
  "quota",
  "budget",
];

export const HERMES_CATEGORY = "ops";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/** Extract the `commands[N]:` block from the top-level help. */
export function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find commands block in TOP_HELP");
  }
  return match[1].trimEnd();
}

/** Render the installable SKILL.md for the spend-axi skill. */
export function createSkillMarkdown(): string {
  return `---
name: spend-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# spend-axi

${DESCRIPTION}

You do not need spend-axi installed globally - invoke it with \`npx -y spend-axi <command>\`.
If spend-axi output shows a follow-up command starting with \`spend-axi\`, run it as \`npx -y spend-axi ...\` instead.

spend-axi is READ-only. It composes three sources into one snapshot: subscription windows (from \`quota-axi --json\`), LiteLLM gateway daily spend + per-provider budgets (from the local gateway at http://127.0.0.1:4000), and Cursor on-demand daily spend (currently flagged "not wired" - see Cursor below).

## When to use

Use spend-axi whenever a task needs a spend/quota/gateway snapshot: the daily gateway budget headroom, whether a provider is near its daily cap, what subscription quota windows remain, or cursor's daily spend posture.

## Workflow

1. Run \`npx -y spend-axi\` with no arguments for the full snapshot - headline + subscriptions + gateway + cursor.
2. Focus on the gateway: \`npx -y spend-axi gateway\` shows today's total + per-provider spend vs the live provider_budget_config.
3. Focus on cursor: \`npx -y spend-axi cursor\` shows the daily cap + today's request activity (and flags dollar spend as not-wired until a source is wired).
4. Machine-readable output: append \`--json\` to any command.
5. Adjust the cursor daily cap for the headline: \`npx -y spend-axi --cursor-cap 60\`.
6. Point at another gateway: \`npx -y spend-axi --gateway http://127.0.0.1:4000 gateway\`.
7. Every response ends with contextual next-step hints under \`help:\` - follow them.

## Commands

\`\`\`
${extractCommandsBlock()}
\`\`\`

Installed copies also inherit the SDK built-in \`update\` command.
Run \`spend-axi update --check\` to compare the installed version with npm, or \`spend-axi update\` to upgrade.
When using \`npx -y spend-axi\`, npx already resolves the package on demand.

Run \`npx -y spend-axi --help\` for global flags, or \`npx -y spend-axi <command> --help\` for per-command usage.

## Auth + sources

- **Subscriptions:** reuses \`quota-axi --json\` (the external local-first subscription-window tracker). If quota-axi is not on PATH, the subscriptions section reports the error and the rest of the snapshot still renders.
- **Gateway:** \`/health/readiness\` works without a key; \`/provider/budgets\` + \`/global/spend/logs\` need the proxy-admin master key. Resolve it from \`SPEND_AXI_GATEWAY_KEY\` env, \`LITELLM_MASTER_KEY\` env, or \`~/.config/spend-axi/gateway-key\`. The limited \`LITELLM_MCP_KEY\` virtual key is read-only and cannot read admin spend endpoints.
- **Cursor:** DOLLAR spend is not yet readable via any API/CLI (cursor-agent has no usage subcommand; the local \`ai-code-tracking.db\` tracks code activity not dollars; the server usage API needs a keychain-locked OAuth token). spend-axi surfaces today's request ACTIVITY from the local DB and flags dollar spend as "not wired" with a live daily-cap config (\`--cursor-cap\`, default 50) so headroom math activates the moment a usage-$ source is wired in \`src/cursor.ts\`.

## Tips

- Output is TOON-encoded and token-efficient; the \`headline:\` line is the one-liner firstmate relays.
- The cursor daily cap defaults to USD 50 (captain 2026-07-17); override with \`--cursor-cap\` or \`SPEND_AXI_CURSOR_CAP_USD\`.
- Gateway budgets are read live from the gateway's \`provider_budget_config\` - never hardcoded.
- The snapshot degrades gracefully: a missing quota-axi, a down gateway, or a missing key never aborts the other sections.
`;
}
