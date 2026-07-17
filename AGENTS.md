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
- `parseContextArgs` strips `--gateway`/`--cursor-cap`/`--json` (space or `=` form) in BOTH `main()` (leading flags) and `withContext` (trailing flags), so context flags may appear before OR after the command. The resolved `SpendContext` is shared across all dispatches.
- Thrown `AxiError` → SDK renders `{ error, code, help[] }`. `exitCodeForError`: only `VALIDATION_ERROR` exits 2; all else exit 1. `mapGatewayError` in `errors.ts` maps gateway HTTP statuses to `AUTH_REQUIRED`/`FORBIDDEN`/`NOT_FOUND`/`RATE_LIMITED`/`UNKNOWN`.

## Sources (read-only, graceful degradation)

- spend-axi is READ-only; no command mutates state. Each source degrades independently — a missing `quota-axi`, a down gateway, or a missing key never aborts the other sections (errors land in the view, never thrown to the top).
- **Subscriptions:** `quota.ts` shells out to `quota-axi --json` (`SPEND_AXI_QUOTA_BIN`); if the binary is missing, `subscriptions` reports the error and the snapshot still renders.
- **Gateway:** `gateway.ts` is a `fetch` client (`setFetchImpl` test seam) against `http://127.0.0.1:4000`. `/health/readiness` needs no key; `/provider/budgets` + `/global/spend/logs` need the proxy-admin master key (`SPEND_AXI_GATEWAY_KEY` > `LITELLM_MASTER_KEY` > `~/.config/spend-axi/gateway-key`; the limited `LITELLM_MCP_KEY` virtual key is read-only and CANNOT read admin spend endpoints).
- **Cursor:** DOLLAR spend is NOT yet readable via any API/CLI — `cursor.ts` reads today's request ACTIVITY from the local `~/.cursor/ai-tracking` SQLite DB (`node:sqlite`, Node ≥22) and flags dollar spend as `not wired` with a live `--cursor-cap` (default USD 50) so headroom math activates the moment a usage-$ source is wired.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
