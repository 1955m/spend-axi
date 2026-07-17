import { execFile, type ExecFileException } from "node:child_process";
import { AxiError, quotaNotAvailableError } from "./errors.js";
import { quotaAxiBin } from "./config.js";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

export interface QuotaWindow {
  id?: string;
  label?: string;
  kind?: string;
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: string;
}

export interface QuotaCredits {
  remaining?: number;
  unlimited?: boolean;
  unit?: string;
}

export interface QuotaProvider {
  provider: string;
  label?: string;
  plan?: string;
  source?: string;
  status?: string;
  error?: string;
  windows: QuotaWindow[];
  credits?: QuotaCredits;
}

export interface QuotaSnapshot {
  generatedAt?: string;
  providers: QuotaProvider[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable runner so tests can avoid the real subprocess. */
export type QuotaRunner = (args: string[]) => Promise<ExecResult>;

const defaultRunner: QuotaRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      quotaAxiBin(),
      args,
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8" },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
          return;
        }
        const rawExit = error ? ((error as NodeJS.ErrnoException).code ?? 1) : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof rawExit === "number" ? rawExit : 1,
        });
      },
    );
  });

/**
 * Run `quota-axi --json` and normalize its output into a QuotaSnapshot.
 * quota-axi is the external local-first subscription-window tracker; spend-axi
 * reuses its output rather than reinventing provider-window polling. Throws
 * NOT_FOUND when quota-axi is not on PATH, UNKNOWN on a non-zero exit / bad
 * JSON.
 */
export async function runQuotaAxi(runner: QuotaRunner = defaultRunner): Promise<QuotaSnapshot> {
  const result = await runner(["--json"]);
  if (result.stderr === "ENOENT") throw quotaNotAvailableError("not on PATH");
  if (result.exitCode !== 0) {
    throw new AxiError(
      `quota-axi exited ${result.exitCode}: ${result.stderr.slice(0, 300) || "(no stderr)"}`,
      "UNKNOWN",
      ["Run `quota-axi` directly to diagnose; subscriptions will be skipped"],
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new AxiError(
      `quota-axi returned non-JSON output: ${result.stdout.slice(0, 200)}`,
      "UNKNOWN",
    );
  }
  return normalizeQuota(parsed);
}

/** Normalize the raw quota-axi JSON into the compact QuotaSnapshot shape. */
export function normalizeQuota(raw: unknown): QuotaSnapshot {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const providers = Array.isArray(obj["providers"]) ? obj["providers"] : [];
  return {
    generatedAt: typeof obj["generatedAt"] === "string" ? obj["generatedAt"] : undefined,
    providers: providers.map(normalizeProvider).filter((p) => p !== null) as QuotaProvider[],
  };
}

function normalizeProvider(raw: unknown): QuotaProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const state = (obj["state"] ?? {}) as Record<string, unknown>;
  const windowsRaw = Array.isArray(obj["windows"]) ? obj["windows"] : [];
  const creditsRaw = obj["credits"];
  return {
    provider: String(obj["provider"] ?? "unknown"),
    label: optString(obj["label"]),
    plan: optString(obj["plan"]),
    source: optString(obj["source"]),
    status: optString(state["status"]),
    error: optString(state["error"]),
    windows: windowsRaw.map(normalizeWindow).filter((w) => w !== null) as QuotaWindow[],
    credits:
      creditsRaw && typeof creditsRaw === "object"
        ? normalizeCredits(creditsRaw as Record<string, unknown>)
        : undefined,
  };
}

function normalizeWindow(raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    id: optString(obj["id"]),
    label: optString(obj["label"]),
    kind: optString(obj["kind"]),
    percentUsed: optNumber(obj["percentUsed"]),
    percentRemaining: optNumber(obj["percentRemaining"]),
    resetsAt: optString(obj["resetsAt"]),
  };
}

function normalizeCredits(obj: Record<string, unknown>): QuotaCredits {
  return {
    remaining: optNumber(obj["remaining"]),
    unlimited: typeof obj["unlimited"] === "boolean" ? obj["unlimited"] : undefined,
    unit: optString(obj["unit"]),
  };
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
