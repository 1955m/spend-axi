import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendContext } from "../context.js";

const { installMock } = vi.hoisted(() => ({ installMock: vi.fn() }));

vi.mock("axi-sdk-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axi-sdk-js")>();
  return { ...actual, installSessionStartHooks: installMock };
});

import { setupCommand } from "./setup.js";

const CTX: SpendContext = {
  gatewayBase: "http://127.0.0.1:4000",
  gatewayKey: undefined,
  cursorCapUsd: 50,
  json: false,
};

describe("setup hooks (AXI P7)", () => {
  beforeEach(() => installMock.mockReset());

  it("installs SessionStart hooks and reports installed + integrations", async () => {
    const out = await setupCommand(["hooks"], CTX);
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(out).toContain("installed");
    expect(out).toContain("Claude Code, Codex, OpenCode");
    expect(out).toContain("Restart your agent session");
  });

  it("rejects an unknown flag after `setup hooks` with VALIDATION_ERROR (P6)", async () => {
    await expect(setupCommand(["hooks", "--bogus"], CTX)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(installMock).not.toHaveBeenCalled();
  });

  it("reports an unknown setup action", async () => {
    const out = await setupCommand(["bogus"], CTX);
    expect(out).toContain("Unknown setup action: bogus");
    expect(installMock).not.toHaveBeenCalled();
  });

  it("reports a missing action as (none)", async () => {
    const out = await setupCommand([], CTX);
    expect(out).toContain("Unknown setup action: (none)");
  });
});
