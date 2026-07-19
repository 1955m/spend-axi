import { describe, expect, it } from "vitest";
import { mapGatewayError, noGatewayKeyError, quotaNotAvailableError } from "./errors.js";

describe("mapGatewayError", () => {
  it("maps 401 to AUTH_REQUIRED", () => {
    const e = mapGatewayError(
      401,
      JSON.stringify({ error: { message: "No api key passed in." } }),
      "provider-budgets",
      "litellm",
    );
    expect(e.code).toBe("AUTH_REQUIRED");
    expect(e.suggestions.length).toBeGreaterThan(0);
  });
  it("maps 403 to FORBIDDEN", () => {
    const e = mapGatewayError(403, '{"error":{"message":"forbidden"}}', "x", "litellm");
    expect(e.code).toBe("FORBIDDEN");
  });
  it("maps 404 to NOT_FOUND", () => {
    const e = mapGatewayError(404, '{"detail":"Not Found"}', "x", "litellm");
    expect(e.code).toBe("NOT_FOUND");
  });
  it("maps 429 to RATE_LIMITED", () => {
    const e = mapGatewayError(429, '{"error":{"message":"slow down"}}', "x", "litellm");
    expect(e.code).toBe("RATE_LIMITED");
  });
  it("maps 5xx to UNKNOWN", () => {
    const e = mapGatewayError(500, '{"error":{"message":"boom"}}', "x", "litellm");
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).toContain("server error");
  });
  it("maps enterprise-only detail to FORBIDDEN", () => {
    const e = mapGatewayError(
      400,
      '{"detail":{"error":"You must be a LiteLLM Enterprise user to use this feature"}}',
      "global-spend-report",
      "litellm",
    );
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message.toLowerCase()).toContain("enterprise");
  });
  it("maps an unknown status to UNKNOWN", () => {
    const e = mapGatewayError(418, '{"error":{"message":"teapot"}}', "x", "litellm");
    expect(e.code).toBe("UNKNOWN");
  });
  it("handles non-JSON body", () => {
    const e = mapGatewayError(500, "Internal Server Error", "x", "litellm");
    expect(e.code).toBe("UNKNOWN");
  });
  it("labels a 401 for the bifrost source distinctly from litellm", () => {
    const e = mapGatewayError(
      401,
      JSON.stringify({ error: { message: "unauthorized" } }),
      "bifrost-provider-budgets",
      "bifrost",
    );
    expect(e.code).toBe("AUTH_REQUIRED");
    expect(e.message).toContain("Bifrost gateway rejected the key");
    expect(e.message).not.toContain("LiteLLM");
    expect(e.suggestions.some((s) => s.includes("SPEND_AXI_BIFROST_KEY"))).toBe(true);
    expect(e.suggestions.some((s) => s.includes("LITELLM_MCP_KEY"))).toBe(false);
  });
});

describe("noGatewayKeyError", () => {
  it("is AUTH_REQUIRED with a setup hint", () => {
    const e = noGatewayKeyError();
    expect(e.code).toBe("AUTH_REQUIRED");
    expect(e.suggestions.some((s) => s.includes("SPEND_AXI_GATEWAY_KEY"))).toBe(true);
  });
});

describe("quotaNotAvailableError", () => {
  it("is NOT_FOUND", () => {
    const e = quotaNotAvailableError("not on PATH");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("quota-axi");
  });
});
