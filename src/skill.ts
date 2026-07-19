import { DESCRIPTION, TOP_HELP } from "./cli.js";

/** Trigger string agents match against to auto-load the skill. */
export const SKILL_DESCRIPTION =
  "Read spend posture through the spend-axi CLI - one compact snapshot of Bifrost gateway daily spend + per-model token usage, subscription windows, and Cursor on-demand daily spend. " +
  "Use whenever a task needs a spend/gateway/quota snapshot: checking the daily gateway budget headroom, per-model token+cost breakdown, whether cursor is approaching its daily cap, " +
  "or what subscription quota windows remain. Read-only; no mutations.";

export const SKILL_AUTHOR = "AXI Suite";

export const HERMES_TAGS = ["spend", "bifrost", "litellm", "cursor", "quota", "budget"];

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

spend-axi is READ-only. It composes three sources into one snapshot: subscription windows (from \`quota-axi --json\`), Bifrost gateway daily spend + per-provider budgets + per-model token/cost breakdown (from the local gateway at http://127.0.0.1:8090, the live gateway since the 2026-07-19 LiteLLM→Bifrost cutover — LiteLLM is kept as a stopped-not-deleted fallback via \`--gateway-source litellm\`), and Cursor on-demand daily spend (currently flagged "not wired" - see Cursor below).

## When to use

Use spend-axi whenever a task needs a spend/quota/gateway snapshot: the daily gateway budget headroom, whether a provider is near its daily cap, per-model token+cost usage, what subscription quota windows remain, or cursor's daily spend posture.

## Workflow

1. Run \`npx -y spend-axi\` with no arguments for the full snapshot - headline + subscriptions + gateway + cursor.
2. Focus on the gateway: \`npx -y spend-axi gateway\` shows today's total + per-provider spend vs the live governance model-config budgets, plus a per-model cumulative token+cost breakdown (Bifrost only).
3. Focus on cursor: \`npx -y spend-axi cursor\` shows the daily cap + today's request activity (and flags dollar spend as not-wired until a source is wired).
4. Machine-readable output: append \`--json\` to any command.
5. Adjust the cursor daily cap for the headline: \`npx -y spend-axi --cursor-cap 60\`.
6. Point at the stopped LiteLLM fallback: \`npx -y spend-axi gateway --gateway-source litellm --gateway http://127.0.0.1:4000\`.
7. Every response ends with contextual next-step hints under \`help:\` - follow them.

### Session hooks (ambient context)
8. Install SessionStart hooks so every agent session boots with the spend-axi snapshot: \`npx -y spend-axi setup hooks\` (installs Claude Code, Codex, and OpenCode ambient context; idempotent, explicit opt-in only).

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
- **Gateway (Bifrost, default source):** the live gateway moved to http://127.0.0.1:8090 on 2026-07-19 (LiteLLM stopped-not-deleted, audit 7). \`GET /health\` checks reachability (no key); \`GET /api/governance/model-configs\` returns per-provider daily budget window (\`current_usage\` vs \`max_limit\`, \`last_reset\`, \`reset_duration\`) — the authoritative per-provider daily dollar source; \`GET /metrics\` (Prometheus) returns per-model cumulative token+cost counters (\`bifrost_cost_total\`, \`bifrost_input_tokens_total\`, \`bifrost_output_tokens_total\`) labeled "cumulative since process start" — there is no native per-model-per-day surface in Bifrost v1.6.4, so the per-model view is cumulative and labeled as such. Management API is unauthenticated on this host (\`auth_config.is_enabled=false\`); set \`SPEND_AXI_BIFROST_KEY\` only if that flag is ever flipped on. Empty state: when no governance budgets are configured at all, the view reports \`error_code: NO_BUDGETS\` and \`today_total_usd: null\` rather than fabricating a zero — distinct from \`$0.00\` spent against a configured budget.
- **Gateway (LiteLLM, fallback source via \`--gateway-source litellm\`):** kept while the LiteLLM container is stopped-not-deleted. \`/health/readiness\` works without a key; \`/provider/budgets\` + \`/global/spend/logs\` need the proxy-admin master key. Resolve it from \`SPEND_AXI_GATEWAY_KEY\` env, \`LITELLM_MASTER_KEY\` env, or \`~/.config/spend-axi/gateway-key\`. The limited \`LITELLM_MCP_KEY\` virtual key is read-only and cannot read admin spend endpoints.
- **Cursor:** DOLLAR spend is not yet readable via any API/CLI (cursor-agent has no usage subcommand; the local \`ai-code-tracking.db\` tracks code activity not dollars; the server usage API needs a keychain-locked OAuth token). spend-axi surfaces today's request ACTIVITY from the local DB and flags dollar spend as "not wired" with a live daily-cap config (\`--cursor-cap\`, default 50) so headroom math activates the moment a usage-$ source is wired in \`src/cursor.ts\`.

## Tips

- Output is TOON-encoded and token-efficient; the \`headline:\` line is the one-liner firstmate relays.
- The cursor daily cap defaults to USD 50 (captain 2026-07-17); override with \`--cursor-cap\` or \`SPEND_AXI_CURSOR_CAP_USD\`.
- Gateway budgets are read live from the gateway's \`provider_budget_config\` - never hardcoded.
- The snapshot degrades gracefully: a missing quota-axi, a down gateway, or a missing key never aborts the other sections.
`;
}
