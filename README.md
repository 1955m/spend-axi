# spend-axi

AXI-compliant spend-posture CLI — one compact, scannable snapshot of subscription windows + gateway daily spend + Cursor on-demand daily spend. Token-efficient TOON output, a one-line headline firstmate can relay, and graceful degradation when any single source is unavailable. Mirrors the `tg-axi` / `glab-axi` UX.

```sh
spend-axi                       # full snapshot: headline + subscriptions + gateway + cursor
spend-axi gateway               # gateway-only: today's total + per-provider spend vs budget + per-model tokens/cost
spend-axi cursor --json         # cursor-only, machine-readable
spend-axi --cursor-cap 60       # adjust the cursor daily cap for the headline
spend-axi gateway --gateway-source litellm --gateway http://127.0.0.1:4000
spend-axi setup hooks           # install Claude Code / Codex / OpenCode session hooks
```

## Why

The captain needs one compact read of spend posture: are the subscription quota windows healthy, is the gateway approaching a per-provider daily budget, and is cursor's on-demand spend approaching its weekday cap. This composes three sources into one TOON snapshot rather than polling each separately. `spend-axi` is READ-only (no mutations), built on `axi-sdk-js` + `@toon-format/toon`, and degrades gracefully — a missing `quota-axi`, a down gateway, or a missing key never aborts the other sections.

## Data sources

1. **Subscription windows** — reuses `quota-axi --json` (the external local-first subscription-window tracker). spend-axi does NOT reinvent provider-window polling; it shells out and normalizes.
2. **Gateway daily spend** — `--gateway-source` selects the API surface (default `bifrost`, since LiteLLM stopped on 2026-07-19 / audit 7):
   - **Bifrost** (default) — `http://127.0.0.1:8090`: `GET /health` (no auth) → reachability; `GET /api/governance/model-configs` (management API, unauthenticated on this host) → per-provider daily budget window (`current_usage`/`max_limit`/`last_reset`/`reset_duration`), the authoritative per-provider daily dollar source; `GET /metrics` (Prometheus) → per-model **cumulative since process start** token+cost counters (`bifrost_cost_total`, `bifrost_input_tokens_total`, `bifrost_output_tokens_total`), since Bifrost v1.6.4 has no native per-model-per-day surface. No governance budgets configured at all reports `error_code: NO_BUDGETS` + `today_total_usd: null` rather than a fabricated `$0.00`.
   - **LiteLLM** (fallback, `--gateway-source litellm`) — `http://127.0.0.1:4000`, kept while the LiteLLM container is stopped-not-deleted: `/health/readiness` (no auth) → reachability; `/provider/budgets` (master key) → per-provider rolling-`1d` spend vs `budget_limit`; `/global/spend/logs` (master key) → today's total calendar-day spend across all providers. No per-model breakdown on this source.
3. **Cursor on-demand daily spend** (captain 2026-07-17, REQUIRED) — DOLLAR spend is **not yet readable** via any programmatic source (investigated live): `cursor-agent` has no usage/billing/spend subcommand; the local `ai-code-tracking.db` tracks AI-code activity (no cost column, editor-only); Cursor's server usage API needs a keychain-locked OAuth token (quota-axi also reports cursor `auth_required`). spend-axi surfaces today's request **ACTIVITY** from the local DB (clearly labeled, not spend) and flags dollar spend as `not wired` with a live `--cursor-cap` (default USD 50) so headroom math activates the moment a usage-$ source is wired in `src/cursor.ts`. It is NOT silently omitted.

## Install

```sh
npm install -g spend-axi        # when published
# or run on demand:
npx -y spend-axi <command>
```

The Bifrost management API is unauthenticated on this host by default, so no key is needed for the default source; set `SPEND_AXI_BIFROST_KEY` only if `auth_config.is_enabled` is ever flipped on.
The LiteLLM fallback's gateway key (proxy-admin master key) resolves at runtime, never committed:
`SPEND_AXI_GATEWAY_KEY` env > `LITELLM_MASTER_KEY` env > `~/.config/spend-axi/gateway-key`.
The limited `LITELLM_MCP_KEY` virtual key is read-only and cannot read admin spend endpoints.

## Commands

```
commands[4]:
  (none)=snapshot, gateway, cursor, setup
```

| Command       | Flags                                                                                    | Notes                                                                             |
| ------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `(none)`      | `--gateway-source <bifrost\|litellm>`, `--gateway <url>`, `--cursor-cap <usd>`, `--json` | full snapshot + headline                                                          |
| `gateway`     | `--gateway-source <bifrost\|litellm>`, `--gateway <url>`, `--json`                       | today's total + per-provider spend vs budget (+ per-model tokens/cost on Bifrost) |
| `cursor`      | `--cursor-cap <usd>`, `--json`                                                           | cursor daily cap + today's activity (or not-wired)                                |
| `setup hooks` | —                                                                                        | install/repair Claude Code, Codex, OpenCode `SessionStart` hooks                  |

Plus the SDK built-in `update` / `update --check`.

Context flags (`--gateway-source`/`--gateway`/`--cursor-cap`/`--json`) may appear as leading flags (e.g. `spend-axi --json`) or after the command. Unknown leading flags are rejected as `VALIDATION_ERROR`.

## Output

All output is [TOON](https://www.npmjs.com/package/@toon-format/toon)-encoded: a `headline:` one-liner, then `subscriptions` / `gateway` / `gateway_providers` / `gateway_models` (Bifrost only) / `cursor` blocks, plus a trailing `help[N]:` block. `--json` emits pure parseable JSON (the home `--json` path bypasses the SDK header so `jq` works). Errors render as `{ error, code, help[] }` with codes `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `NO_BUDGETS`, `VALIDATION_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `UNKNOWN`.

## Develop

```sh
pnpm install
pnpm build            # tsc -> dist/
pnpm test             # vitest (154 tests; unit + in-process integration; fully offline)
pnpm lint             # eslint --max-warnings=0
pnpm format           # prettier --write .
pnpm format:check     # prettier --check .
pnpm build:skill      # regenerate skills/spend-axi/SKILL.md from source
pnpm docs:check       # build:skill + git diff --exit-code -- skills/ (generated-skill staleness guard)
pnpm dev <args>       # run via tsx without building
```

> The root workspace gates `pnpm -r` on a deps-status check. To run a single package's scripts directly, use the local bins: `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/vitest run`, `node_modules/.bin/eslint . --max-warnings=0` from the package dir.

## Architecture

Built on the published [`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) (`runAxiCli` routing/help, `AxiError`/`exitCodeForError`, the `update` built-in, SessionStart hooks) and [`@toon-format/toon`](https://www.npmjs.com/package/@toon-format/toon). The layout mirrors `tg-axi`/`figma-axi`:

```
bin/spend-axi.ts          entrypoint
src/cli.ts               runAxiCli wiring, TOP_HELP, --skill, context (gateway-source+gateway+key+cap+json) resolution, home+json bypass
src/config.ts            DEFAULT_GATEWAY_SOURCE, DEFAULT_GATEWAY, DEFAULT_CURSOR_CAP_USD, gateway source+base+key resolution, cursor DB + quota-axi binary paths
src/context.ts           SpendContext, parseContextArgs (strip --gateway-source/--gateway/--cursor-cap/--json), rejectUnknownFlags (P6), requireGatewayKey, requireBifrostKey
src/bifrost.ts           Bifrost gateway fetch client (getBifrostHealth/getBifrostProviderBudgets/getBifrostModelUsage; shares gateway.ts's setFetchImpl seam)
src/gateway.ts           LiteLLM gateway fetch client (setFetchImpl seam; getHealth/getProviderBudgets/getGlobalSpendToday; AbortController timeout)
src/quota.ts             quota-axi --json subprocess (execFile wrapper; injectable runner for tests; normalizeQuota)
src/cursor.ts            cursor activity reader (node:sqlite); dollar spend flagged not-wired + config hook
src/errors.ts            mapGatewayError (source-agnostic: bifrost + litellm) -> AxiError codes; noGatewayKeyError; quotaNotAvailableError
src/toon.ts              field extractors + renderList/renderDetail/renderHelp (copied verbatim from tg-axi)
src/args.ts              generic flag parsing (copied verbatim from tg-axi)
src/views.ts             pure format helpers + plain-object view builders (shared by home + subcommands)
src/skill.ts             createSkillMarkdown()
src/commands/*.ts        home (snapshot), gateway (bifrost + litellm), cursor, setup
skills/spend-axi/SKILL.md shipped skill file for agent-harness auto-loading
```

The key structural note: spend-axi has no vendor CLI to wrap. `bifrost.ts` and `gateway.ts` are `fetch` clients (like `figma-axi`/`clickup-axi`), selected at runtime by `--gateway-source`; `quota.ts` is an `execFile` wrapper around `quota-axi`; `cursor.ts` reads the local SQLite DB via the built-in `node:sqlite` (Node ≥22, no binary dependency, testable with temp DBs).

See `NOTES.md` for the build-decision rationale + live validation evidence (real gateway + quota-axi data).

License: MIT.
