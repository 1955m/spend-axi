import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CURSOR_CAP_USD,
  DEFAULT_GATEWAY,
  DEFAULT_BIFROST_GATEWAY,
  DEFAULT_LITELLM_GATEWAY,
  DEFAULT_GATEWAY_SOURCE,
  cursorDbPath,
  gatewayKeyFilePath,
  quotaAxiBin,
  resolveBifrostKey,
  resolveCursorCapUsd,
  resolveGatewayBase,
  resolveGatewayKey,
  resolveGatewaySource,
  resolveJson,
} from "./config.js";

const ENV_VARS = [
  "SPEND_AXI_GATEWAY",
  "SPEND_AXI_GATEWAY_SOURCE",
  "SPEND_AXI_GATEWAY_KEY",
  "SPEND_AXI_BIFROST_KEY",
  "LITELLM_MASTER_KEY",
  "SPEND_AXI_CURSOR_CAP_USD",
  "SPEND_AXI_JSON",
  "SPEND_AXI_CONFIG_DIR",
  "SPEND_AXI_CURSOR_DB",
  "SPEND_AXI_QUOTA_BIN",
];
const saved: Record<string, string | undefined> = {};
const NO_KEY_FILE = join(tmpdir(), "spend-axi-nonexistent-gateway-key");

beforeAll(() => {
  for (const key of ENV_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env["SPEND_AXI_CONFIG_DIR"] = NO_KEY_FILE;
});

afterAll(() => {
  for (const key of ENV_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

beforeEach(() => {
  for (const key of ENV_VARS) delete process.env[key];
  process.env["SPEND_AXI_CONFIG_DIR"] = NO_KEY_FILE;
});

describe("resolveGatewaySource", () => {
  it("flag wins over env and default", () => {
    process.env["SPEND_AXI_GATEWAY_SOURCE"] = "litellm";
    expect(resolveGatewaySource("bifrost")).toBe("bifrost");
  });
  it("env fallback", () => {
    process.env["SPEND_AXI_GATEWAY_SOURCE"] = "litellm";
    expect(resolveGatewaySource()).toBe("litellm");
  });
  it("default bifrost", () => {
    expect(resolveGatewaySource()).toBe(DEFAULT_GATEWAY_SOURCE);
    expect(DEFAULT_GATEWAY_SOURCE).toBe("bifrost");
  });
  it("rejects an invalid env value instead of silently falling back", () => {
    process.env["SPEND_AXI_GATEWAY_SOURCE"] = "gemini";
    expect(() => resolveGatewaySource()).toThrow(/Invalid SPEND_AXI_GATEWAY_SOURCE/);
  });
});

describe("resolveGatewayBase", () => {
  it("flag wins over env and default", () => {
    process.env["SPEND_AXI_GATEWAY"] = "http://env:4000";
    expect(resolveGatewayBase("http://flag:4000", "bifrost")).toBe("http://flag:4000");
  });
  it("env wins over source default", () => {
    process.env["SPEND_AXI_GATEWAY"] = "http://env:4000";
    expect(resolveGatewayBase(undefined, "bifrost")).toBe("http://env:4000");
  });
  it("bifrost source default → :8090", () => {
    expect(resolveGatewayBase(undefined, "bifrost")).toBe(DEFAULT_BIFROST_GATEWAY);
    expect(DEFAULT_BIFROST_GATEWAY).toBe("http://127.0.0.1:8090");
  });
  it("litellm source default → :4000", () => {
    expect(resolveGatewayBase(undefined, "litellm")).toBe(DEFAULT_LITELLM_GATEWAY);
    expect(DEFAULT_LITELLM_GATEWAY).toBe("http://127.0.0.1:4000");
  });
  it("DEFAULT_GATEWAY points at bifrost", () => {
    expect(DEFAULT_GATEWAY).toBe(DEFAULT_BIFROST_GATEWAY);
  });
});

describe("resolveBifrostKey", () => {
  it("returns env value when set", () => {
    process.env["SPEND_AXI_BIFROST_KEY"] = "sk-bf-xyz";
    expect(resolveBifrostKey()).toBe("sk-bf-xyz");
  });
  it("undefined when env absent", () => {
    expect(resolveBifrostKey()).toBeUndefined();
  });
});

describe("resolveCursorCapUsd", () => {
  it("flag wins", () => {
    process.env["SPEND_AXI_CURSOR_CAP_USD"] = "30";
    expect(resolveCursorCapUsd("60")).toBe(60);
  });
  it("env fallback", () => {
    process.env["SPEND_AXI_CURSOR_CAP_USD"] = "75";
    expect(resolveCursorCapUsd()).toBe(75);
  });
  it("default 50", () => {
    expect(resolveCursorCapUsd()).toBe(DEFAULT_CURSOR_CAP_USD);
    expect(DEFAULT_CURSOR_CAP_USD).toBe(50);
  });
  it("rejects non-numeric via config layer (returns NaN guard)", () => {
    // resolveCursorCapUsd throws on non-finite; context validates earlier
    expect(() => resolveCursorCapUsd("not-a-number")).toThrow();
  });
});

describe("resolveJson", () => {
  it("flag true wins", () => {
    expect(resolveJson(true)).toBe(true);
  });
  it("env 1/true/yes", () => {
    for (const v of ["1", "true", "YES", "True"]) {
      process.env["SPEND_AXI_JSON"] = v;
      expect(resolveJson(false)).toBe(true);
      delete process.env["SPEND_AXI_JSON"];
    }
  });
  it("default false", () => {
    expect(resolveJson(false)).toBe(false);
  });
});

describe("resolveGatewayKey", () => {
  it("SPEND_AXI_GATEWAY_KEY wins over LITELLM_MASTER_KEY", () => {
    process.env["LITELLM_MASTER_KEY"] = "sk-master";
    process.env["SPEND_AXI_GATEWAY_KEY"] = "sk-spend";
    expect(resolveGatewayKey()).toBe("sk-spend");
  });
  it("LITELLM_MASTER_KEY fallback", () => {
    process.env["LITELLM_MASTER_KEY"] = "sk-master";
    expect(resolveGatewayKey()).toBe("sk-master");
  });
  it("token file fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-axi-"));
    try {
      writeFileSync(join(dir, "gateway-key"), "sk-from-file\n");
      process.env["SPEND_AXI_CONFIG_DIR"] = dir;
      expect(resolveGatewayKey()).toBe("sk-from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("undefined when nothing present", () => {
    expect(resolveGatewayKey()).toBeUndefined();
  });
});

describe("paths", () => {
  it("gatewayKeyFilePath respects config dir", () => {
    process.env["SPEND_AXI_CONFIG_DIR"] = "/custom/dir";
    expect(gatewayKeyFilePath()).toBe(join("/custom/dir", "gateway-key"));
  });
  it("cursorDbPath defaults to ~/.cursor", () => {
    delete process.env["SPEND_AXI_CURSOR_DB"];
    expect(cursorDbPath()).toContain(".cursor/ai-tracking/ai-code-tracking.db");
  });
  it("cursorDbPath env override", () => {
    process.env["SPEND_AXI_CURSOR_DB"] = "/tmp/custom.db";
    expect(cursorDbPath()).toBe("/tmp/custom.db");
  });
  it("quotaAxiBin default + env override", () => {
    expect(quotaAxiBin()).toBe("quota-axi");
    process.env["SPEND_AXI_QUOTA_BIN"] = "/tmp/fake-quota";
    expect(quotaAxiBin()).toBe("/tmp/fake-quota");
  });
});
