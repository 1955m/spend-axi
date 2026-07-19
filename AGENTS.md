# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build / test / lint

- `pnpm install` then local bins (no workspace gating from this dir): `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/vitest run`, `node_modules/.bin/eslint . --max-warnings=0`, `node_modules/.bin/prettier --check .`.
- `tsc` is `strict` + `noUnusedLocals`/`noUnusedParameters` — every imported symbol must be referenced by name; re-exporting a symbol just to "use" an import is an anti-pattern (import from each symbol's home module instead).
- TS `module: node16` → relative imports MUST use the `.js` extension (e.g. `./context.js`) even for `.ts` files.
- Tests are colocated `*.test.ts`, fully offline: integration tests stub `globalThis.fetch` via `setFetchImpl(null)` (never the network) and point `SPEND_AXI_CONFIG_DIR` at a nonexistent path so the real gateway key is never read.
- CI gate (`.github/workflows/ci.yml`) order on Node 24 mirrors kunchenguid/axi CONTRIBUTING: `pnpm install --frozen-lockfile` → `format:check` → `lint` → `build` → `test` → `build:skill` → `git diff --exit-code -- skills/`. The last two steps are the generated-skill staleness guard (AXI P7).
- `skills/spend-axi/SKILL.md` is GENERATED from `src/skill.ts` (`createSkillMarkdown()`); never hand-edit it. After editing `skill.ts` or `cli.ts` TOP_HELP/DESCRIPTION, run `pnpm run build:skill` (or `pnpm run docs:check`) and commit the regenerated SKILL.md, or the `git diff --exit-code -- skills/` step fails.

## Release

- release-please (`release-please-config.json` + `.release-please-manifest.json` + `.github/workflows/release-please.yml`) drives versioned releases + `CHANGELOG.md` from conventional-commit messages (`feat:`/`fix:`/`chore:`). The manifest pins the root version (currently `0.1.0`); release-please opens a release PR on push to `main` that bumps `package.json` + the manifest. `package.json` stays `private: true` (npm publishing is a separate captain-gated decision), so release-please only cuts tags + changelogs.

## AXI principle compliance

- **P6 (fail loud on unknown flags):** `rejectUnknownFlags(args, known, commandPath)` in `context.ts` runs at the top of each command (after the `--help` short-circuit, before any dependency call). An unrecognized `--flag` throws `VALIDATION_ERROR` naming the flag + listing the command's valid flags; `--gateway`/`--cursor-cap`/`--json`/`--help` are always-allowed globals (the first three are already stripped by `parseContextArgs`/`withContext` before a command sees args).
- **P7 (ambient context):** `spend-axi setup hooks` (`commands/setup.ts`) calls the SDK's `installSessionStartHooks()` to install Claude Code / Codex / OpenCode `SessionStart` hooks (idempotent, explicit opt-in only — never run from an ordinary command). The generated SKILL.md is the secondary discovery path; the staleness gate above keeps it in sync.

## SDK contract (axi-sdk-js)

- `runAxiCli` dispatches command-first; commands return a pre-rendered TOON string (`renderOutput`/`renderHelp` join multiple blocks). `--json` returns a `JSON.stringify` string; the home `--json` path in `cli.ts` bypasses `runAxiCli` entirely (writes straight to stdout) so the SDK `bin:`/`description:` header does not corrupt parseable JSON.
- `parseContextArgs` strips `--gateway`/`--gateway-source`/`--cursor-cap`/`--json` (space or `=` form) in BOTH `main()` (leading flags) and `withContext` (trailing flags), so context flags may appear before OR after the command. The resolved `SpendContext` is shared across all dispatches.
- Thrown `AxiError` → SDK renders `{ error, code, help[] }`. `exitCodeForError`: only `VALIDATION_ERROR` exits 2; all else exit 1. `mapGatewayError` in `errors.ts` maps gateway HTTP statuses to `AUTH_REQUIRED`/`FORBIDDEN`/`NOT_FOUND`/`RATE_LIMITED`/`UNKNOWN` (used by BOTH the LiteLLM and Bifrost sources — the helper is source-agnostic).

## Sources (read-only, graceful degradation)

- spend-axi is READ-only; no command mutates state. Each source degrades independently — a missing `quota-axi`, a down gateway, or a missing key never aborts the other sections (errors land in the view, never thrown to the top).
- **Subscriptions:** `quota.ts` shells out to `quota-axi --json` (`SPEND_AXI_QUOTA_BIN`); if the binary is missing, `subscriptions` reports the error and the snapshot still renders.
- **Gateway (default source = bifrost, audit 7):** the live gateway moved to Bifrost at `http://127.0.0.1:8090` on 2026-07-19 (LiteLLM STOPPED-not-deleted). `bifrost.ts` reads:
  - `GET /health` (no auth) → reachability.
  - `GET /api/governance/model-configs` (management API; unauthenticated on this host because `auth_config.is_enabled=false` — see `projects/stack/ai/bifrost/CUTOVER.md` section 0 note 10) → per-provider daily budget window (`current_usage`/`max_limit`/`last_reset`/`reset_duration`). This is the authoritative per-provider daily dollar source. `SPEND_AXI_BIFROST_KEY` env only matters if `auth_config.is_enabled` ever flips to `true`.
  - `GET /metrics` (Prometheus exposition) → `bifrost_cost_total` / `bifrost_input_tokens_total` / `bifrost_output_tokens_total` / `bifrost_cache_read_input_tokens_total` counters, aggregated by `{provider, model}`. These are CUMULATIVE since the Bifrost process started — Bifrost v1.6.4 has NO native per-model-per-day surface, so the per-model view is labeled cumulative, never mistaken for today's spend.
  - Empty state: no governance budgets configured at all → `error.code=NO_BUDGETS` + `todayTotalUsd=null` (NOT a fake `$0.00`); `$0.00` is reserved for "configured budget, no spend this window".
- **Gateway (fallback source = litellm, via `--gateway-source litellm`):** the legacy `gateway.ts` (`/provider/budgets` + `/global/spend/logs`, needs the proxy-admin master key — `SPEND_AXI_GATEWAY_KEY` > `LITELLM_MASTER_KEY` > `~/.config/spend-axi/gateway-key`; the limited `LITELLM_MCP_KEY` virtual key is read-only and CANNOT read admin spend endpoints). Kept while the LiteLLM container is stopped-not-deleted; the `--gateway-source` flag is the single switch that repoints spend-axi at one or the other API surface.
- **Cursor:** DOLLAR spend is NOT yet readable via any API/CLI — `cursor.ts` reads today's request ACTIVITY from the local `~/.cursor/ai-tracking` SQLite DB (`node:sqlite`, Node ≥22) and flags dollar spend as `not wired` with a live `--cursor-cap` (default USD 50) so headroom math activates the moment a usage-$ source is wired.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
