import { describe, expect, it } from "vitest";
import { normalizeQuota, runQuotaAxi, type ExecResult } from "./quota.js";

const REAL_QUOTA_JSON = JSON.stringify({
  generatedAt: "2026-07-17T02:57:22.432Z",
  schemaVersion: 2,
  providers: [
    {
      provider: "claude",
      label: "Claude",
      source: "oauth",
      plan: "max",
      windows: [
        { id: "five_hour", label: "session", kind: "session", percentUsed: 12, percentRemaining: 88, resetsAt: "2026-07-17T06:20:00.245923+00:00" },
        { id: "seven_day", label: "week", kind: "weekly", percentUsed: 18, percentRemaining: 82, resetsAt: "2026-07-22T00:00:00.245944+00:00" },
      ],
      state: { status: "fresh", stale: false, refreshedAt: "2026-07-17T02:57:21.385Z", sourcesTried: ["oauth"] },
    },
    {
      provider: "codex",
      label: "Codex",
      source: "cli-rpc",
      plan: "prolite",
      windows: [],
      credits: { remaining: 0, unlimited: false, unit: "credits" },
      state: { status: "fresh", stale: false, refreshedAt: "2026-07-17T02:57:22.431Z" },
    },
    {
      provider: "cursor",
      label: "Cursor",
      source: "unavailable",
      windows: [],
      state: { status: "auth_required", error: "Cursor sign-in required", sourcesTried: ["state-vscdb"] },
    },
  ],
});

function runner(result: ExecResult): () => Promise<ExecResult> {
  return () => Promise.resolve(result);
}

describe("normalizeQuota", () => {
  it("normalizes the real schema into providers with windows + credits + state", () => {
    const snap = normalizeQuota(JSON.parse(REAL_QUOTA_JSON));
    expect(snap.generatedAt).toBe("2026-07-17T02:57:22.432Z");
    expect(snap.providers.length).toBe(3);
    const claude = snap.providers[0];
    expect(claude.provider).toBe("claude");
    expect(claude.plan).toBe("max");
    expect(claude.status).toBe("fresh");
    expect(claude.windows.length).toBe(2);
    expect(claude.windows[0].percentRemaining).toBe(88);
    expect(claude.windows[0].resetsAt).toContain("2026-07-17T06:20:00");
    const codex = snap.providers[1];
    expect(codex.credits?.remaining).toBe(0);
    expect(codex.credits?.unlimited).toBe(false);
    const cursor = snap.providers[2];
    expect(cursor.status).toBe("auth_required");
    expect(cursor.error).toBe("Cursor sign-in required");
    expect(cursor.windows).toEqual([]);
  });

  it("handles missing providers gracefully", () => {
    const snap = normalizeQuota({});
    expect(snap.providers).toEqual([]);
    expect(snap.generatedAt).toBeUndefined();
  });
});

describe("runQuotaAxi", () => {
  it("returns the normalized snapshot on ok JSON", async () => {
    const snap = await runQuotaAxi(runner({ stdout: REAL_QUOTA_JSON, stderr: "", exitCode: 0 }));
    expect(snap.providers.length).toBe(3);
    expect(snap.providers[0].provider).toBe("claude");
  });

  it("throws NOT_FOUND when quota-axi is not on PATH (ENOENT)", async () => {
    await expect(
      runQuotaAxi(runner({ stdout: "", stderr: "ENOENT", exitCode: 127 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws UNKNOWN on non-zero exit", async () => {
    await expect(
      runQuotaAxi(runner({ stdout: "", stderr: "quota-axi: error", exitCode: 2 })),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("throws UNKNOWN on non-JSON output", async () => {
    await expect(
      runQuotaAxi(runner({ stdout: "not json", stderr: "", exitCode: 0 })),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });
});
