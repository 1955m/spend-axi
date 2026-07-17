import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main, DESCRIPTION } from "./cli.js";
import { createSkillMarkdown } from "./skill.js";
import { setFetchImpl } from "./gateway.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_VARS = [
  "SPEND_AXI_GATEWAY",
  "SPEND_AXI_GATEWAY_KEY",
  "LITELLM_MASTER_KEY",
  "SPEND_AXI_CURSOR_CAP_USD",
  "SPEND_AXI_JSON",
  "SPEND_AXI_CONFIG_DIR",
  "SPEND_AXI_CURSOR_DB",
  "SPEND_AXI_QUOTA_BIN",
];
const saved: Record<string, string | undefined> = {};
// A config dir that never exists, so resolveGatewayKey never reads the real
// ~/.config/spend-axi/gateway-key during tests (keeps the real key out of test
// state and keeps the no-key tests fully offline).
const NO_CONFIG_DIR = join(tmpdir(), "spend-axi-nonexistent-config");

beforeAll(() => {
  for (const key of ENV_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Force every source offline: a bad gateway URL (fast ECONNREFUSED), no key,
  // a nonexistent cursor DB, and a nonexistent quota-axi binary.
  process.env["SPEND_AXI_GATEWAY"] = "http://127.0.0.1:1";
  process.env["SPEND_AXI_CONFIG_DIR"] = NO_CONFIG_DIR;
  process.env["SPEND_AXI_CURSOR_DB"] = "/tmp/spend-axi-no-such-cursor-db";
  process.env["SPEND_AXI_QUOTA_BIN"] = "/tmp/spend-axi-no-such-quota-bin";
});

afterAll(() => {
  setFetchImpl(null);
  for (const key of ENV_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

afterEach(() => {
  delete process.env["SPEND_AXI_GATEWAY_KEY"];
  delete process.env["LITELLM_MASTER_KEY"];
  delete process.env["SPEND_AXI_JSON"];
});

function capture(): { chunks: string[]; stdout: { write: (c: string) => unknown } } {
  const chunks: string[] = [];
  return { chunks, stdout: { write: (c: string) => chunks.push(c) } };
}

describe("main (in-process, offline)", () => {
  it("prints version for -v", async () => {
    const out = capture();
    await main({ argv: ["-v"], stdout: out.stdout });
    expect(out.chunks.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints --version for --version", async () => {
    const out = capture();
    await main({ argv: ["--version"], stdout: out.stdout });
    expect(out.chunks.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints top-level help for --help", async () => {
    const out = capture();
    await main({ argv: ["--help"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("usage:");
    expect(text).toContain("commands[3]:");
    expect(text).toContain("--gateway");
    expect(text).toContain("--cursor-cap");
    expect(text).toContain("built-in");
  });

  it("renders the snapshot header offline (gateway down, no key, cursor not-wired)", async () => {
    const out = capture();
    await main({ argv: [], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("bin:");
    expect(text).toContain(DESCRIPTION);
    expect(text).toContain("headline:");
    expect(text).toContain("gateway down");
    expect(text).toContain("cursor not-wired");
    expect(text).toContain("subscriptions:");
    // quota-axi binary missing → subscriptions error surfaces
    expect(text).toMatch(/subs n\/a|quota-axi/);
  });

  it("renders the gateway command offline (reachable no, auth no)", async () => {
    const out = capture();
    await main({ argv: ["gateway"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("gateway:");
    expect(text).toContain("reachable: no");
    expect(text).toContain("auth: no");
  });

  it("renders the cursor command offline (not-wired, no DB)", async () => {
    const out = capture();
    await main({ argv: ["cursor"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("cursor:");
    expect(text).toContain("spend_usd: not wired");
    expect(text).toContain("daily_cap_usd: 50");
    expect(text).toContain("status: not-wired");
  });

  it("emits JSON for the snapshot with --json", async () => {
    const out = capture();
    await main({ argv: ["--json"], stdout: out.stdout });
    const text = out.chunks.join("");
    const parsed = JSON.parse(text);
    expect(parsed["headline"]).toContain("gateway down");
    expect(parsed["gateway"]).toBeDefined();
    expect(parsed["cursor"]).toBeDefined();
    expect(parsed["cursor"]["status"]).toBe("not-wired");
    expect(parsed["subscriptions"]).toBeDefined();
  });

  it("rejects a leading non-context flag with VALIDATION_ERROR", async () => {
    const out = capture();
    await main({ argv: ["--bogus", "x"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("after the command");
  });

  it("accepts a leading context flag for the home snapshot", async () => {
    const out = capture();
    await main({ argv: ["--cursor-cap", "60"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("headline:");
    expect(text).toContain("daily_cap_usd: 60");
  });

  it("reports an unknown command", async () => {
    const out = capture();
    await main({ argv: ["bogus"], stdout: out.stdout });
    expect(out.chunks.join("")).toContain("Unknown command: bogus");
  });

  it("prints SKILL.md for --skill", async () => {
    const out = capture();
    await main({ argv: ["--skill"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("name: spend-axi");
    expect(text).toContain("user-invocable: false");
    expect(text).toContain("## Commands");
  });
});

describe("createSkillMarkdown", () => {
  it("includes frontmatter + the commands block + auth notes", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("---\nname: spend-axi");
    expect(md).toContain("category: ops");
    expect(md).toContain("commands[3]:");
    expect(md).toContain("npx -y spend-axi");
    expect(md).toContain("SPEND_AXI_GATEWAY_KEY");
    expect(md).toContain("not wired");
  });
});
