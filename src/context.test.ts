import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseContextArgs,
  rejectUnknownFlags,
  requireGatewayKey,
  resolveSpendContext,
  type SpendContext,
} from "./context.js";

const ENV_VARS = [
  "SPEND_AXI_GATEWAY",
  "SPEND_AXI_GATEWAY_SOURCE",
  "SPEND_AXI_GATEWAY_KEY",
  "SPEND_AXI_BIFROST_KEY",
  "LITELLM_MASTER_KEY",
  "SPEND_AXI_CURSOR_CAP_USD",
  "SPEND_AXI_JSON",
  "SPEND_AXI_CONFIG_DIR",
];
// A path that never exists, so resolveGatewayKey never reads the real
// ~/.config/spend-axi/gateway-key during tests (keeps the real key out of test
// state and keeps the no-key tests fully offline).
const NO_CONFIG_DIR = join(tmpdir(), "spend-axi-nonexistent-config");

beforeAll(() => {
  for (const key of ENV_VARS) delete process.env[key];
  process.env["SPEND_AXI_CONFIG_DIR"] = NO_CONFIG_DIR;
});

afterAll(() => {
  for (const key of ENV_VARS) delete process.env[key];
});

describe("parseContextArgs", () => {
  it("strips --gateway in space form", () => {
    const r = parseContextArgs(["gateway", "--gateway", "http://h:1"]);
    expect(r.gatewayFlag).toBe("http://h:1");
    expect(r.strippedArgs).toEqual(["gateway"]);
    expect(r.jsonFlag).toBe(false);
  });
  it("strips --gateway= equals form", () => {
    const r = parseContextArgs(["--gateway=http://h:2", "gateway"]);
    expect(r.gatewayFlag).toBe("http://h:2");
    expect(r.strippedArgs).toEqual(["gateway"]);
  });
  it("strips --cursor-cap in space and equals form", () => {
    expect(parseContextArgs(["cursor", "--cursor-cap", "60"]).cursorCapFlag).toBe("60");
    expect(parseContextArgs(["cursor", "--cursor-cap=75"]).cursorCapFlag).toBe("75");
  });
  it("strips --json boolean flag", () => {
    const r = parseContextArgs(["--json", "gateway"]);
    expect(r.jsonFlag).toBe(true);
    expect(r.strippedArgs).toEqual(["gateway"]);
  });
  it("rejects a non-numeric --cursor-cap with VALIDATION_ERROR", () => {
    expect(() => parseContextArgs(["--cursor-cap", "abc"])).toThrow();
  });
  it("rejects a negative --cursor-cap", () => {
    expect(() => parseContextArgs(["--cursor-cap", "-5"])).toThrow();
  });
  it("strips --gateway-source in space and equals form", () => {
    expect(parseContextArgs(["gateway", "--gateway-source", "litellm"]).gatewaySourceFlag).toBe(
      "litellm",
    );
    expect(parseContextArgs(["gateway", "--gateway-source=bifrost"]).gatewaySourceFlag).toBe(
      "bifrost",
    );
  });
  it("rejects an invalid --gateway-source with VALIDATION_ERROR", () => {
    expect(() => parseContextArgs(["--gateway-source", "gemini"])).toThrow();
  });
  it("leaves unknown flags untouched", () => {
    const r = parseContextArgs(["gateway", "--bogus", "x"]);
    expect(r.strippedArgs).toEqual(["gateway", "--bogus", "x"]);
  });
});

describe("resolveSpendContext", () => {
  it("resolves flags into a SpendContext", () => {
    const ctx = resolveSpendContext(
      parseContextArgs(["--gateway", "http://h:9", "--cursor-cap", "80", "--json"]),
    );
    expect(ctx.gatewayBase).toBe("http://h:9");
    expect(ctx.cursorCapUsd).toBe(80);
    expect(ctx.json).toBe(true);
    expect(ctx.gatewayKey).toBeUndefined();
  });
  it("defaults to the Bifrost source + base when no flags", () => {
    const ctx = resolveSpendContext(parseContextArgs([]));
    expect(ctx.gatewaySource).toBe("bifrost");
    expect(ctx.gatewayBase).toBe("http://127.0.0.1:8090");
    expect(ctx.cursorCapUsd).toBe(50);
    expect(ctx.json).toBe(false);
  });
  it("flips the default base to :4000 when source=litellm", () => {
    const ctx = resolveSpendContext(parseContextArgs(["--gateway-source", "litellm"]));
    expect(ctx.gatewaySource).toBe("litellm");
    expect(ctx.gatewayBase).toBe("http://127.0.0.1:4000");
  });
  it("--gateway overrides the source default base", () => {
    const ctx = resolveSpendContext(
      parseContextArgs(["--gateway-source", "litellm", "--gateway", "http://h:5"]),
    );
    expect(ctx.gatewaySource).toBe("litellm");
    expect(ctx.gatewayBase).toBe("http://h:5");
  });
});

describe("requireGatewayKey", () => {
  it("throws AUTH_REQUIRED when no key", () => {
    const ctx: SpendContext = {
      gatewaySource: "litellm",
      gatewayBase: "http://h",
      gatewayKey: undefined,
      bifrostKey: undefined,
      cursorCapUsd: 50,
      json: false,
    };
    expect(() => requireGatewayKey(ctx)).toThrow(/gateway key/);
  });
  it("returns validated base+key when present", () => {
    const ctx: SpendContext = {
      gatewaySource: "litellm",
      gatewayBase: "http://h",
      gatewayKey: "sk-x",
      bifrostKey: undefined,
      cursorCapUsd: 50,
      json: false,
    };
    expect(requireGatewayKey(ctx)).toEqual({
      gatewayBase: "http://h",
      gatewayKey: "sk-x",
    });
  });
});

describe("rejectUnknownFlags (AXI P6: fail loud on unknown flags)", () => {
  it("passes silently when every flag is known", () => {
    expect(() => rejectUnknownFlags(["--json"], ["--json"], "gateway")).not.toThrow();
  });

  it("allows the --gateway / --gateway-source / --cursor-cap / --json / --help globals even when not declared known", () => {
    expect(() =>
      rejectUnknownFlags(
        [
          "--gateway",
          "http://h",
          "--gateway-source",
          "bifrost",
          "--cursor-cap",
          "60",
          "--json",
          "--help",
        ],
        [],
        "gateway",
      ),
    ).not.toThrow();
  });

  it("rejects an unknown flag by name with VALIDATION_ERROR + the valid-flag list", () => {
    let err: unknown;
    try {
      rejectUnknownFlags(["--bogus"], [], "cursor");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((err as Error).message).toContain("unknown flag --bogus");
    expect((err as Error).message).toContain("`cursor`");
    const suggestions = (err as { suggestions?: string[] }).suggestions ?? [];
    expect(suggestions.some((s) => s.includes("--help"))).toBe(true);
  });

  it("extracts the flag name from --flag=value form before rejecting", () => {
    let err: unknown;
    try {
      rejectUnknownFlags(["--bogus=1"], [], "gateway");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("unknown flag --bogus");
  });

  it("leaves positional (non-dash) args alone", () => {
    expect(() => rejectUnknownFlags(["hooks"], [], "setup hooks")).not.toThrow();
  });
});
