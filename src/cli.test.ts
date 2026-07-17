import { describe, expect, it } from "vitest";
import { TOP_HELP, DESCRIPTION, DEFAULT_GATEWAY, DEFAULT_CURSOR_CAP_USD } from "./cli.js";

describe("top-level help", () => {
  it("lists all 4 commands", () => {
    expect(TOP_HELP).toMatch(/^commands\[4\]:/m);
    for (const cmd of ["snapshot", "gateway", "cursor", "setup"]) {
      expect(TOP_HELP).toContain(cmd);
    }
  });

  it("documents the context flags + defaults", () => {
    expect(TOP_HELP).toContain("--gateway");
    expect(TOP_HELP).toContain(DEFAULT_GATEWAY);
    expect(TOP_HELP).toContain("--cursor-cap");
    expect(TOP_HELP).toContain(String(DEFAULT_CURSOR_CAP_USD));
    expect(TOP_HELP).toContain("--json");
  });

  it("documents the gateway key resolution path", () => {
    expect(TOP_HELP).toContain("SPEND_AXI_GATEWAY_KEY");
    expect(TOP_HELP).toContain("LITELLM_MASTER_KEY");
  });

  it("documents the cursor not-wired status", () => {
    expect(TOP_HELP).toContain("not-wired");
  });

  it("has a spend-focused description", () => {
    expect(DESCRIPTION).toMatch(/spend/i);
  });
});
