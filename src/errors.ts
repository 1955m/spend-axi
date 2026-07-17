import { AxiError, exitCodeForError } from "axi-sdk-js";

export { AxiError, exitCodeForError };

/**
 * Map a LiteLLM gateway HTTP failure to a structured AxiError.
 *
 * The gateway returns `{"error":{"message","type","code"}}` for auth failures
 * and `{"detail": ...}` for routing errors. We key off the HTTP status and the
 * LiteLLM error message text. Codes mirror the other axi tools:
 * AUTH_REQUIRED, FORBIDDEN, RATE_LIMITED, NOT_FOUND, TIMEOUT, NETWORK_ERROR,
 * UNKNOWN.
 */
export function mapGatewayError(status: number, bodyText: string, contextLabel: string): AxiError {
  const parsed = parseBody(bodyText);
  const message = extractMessage(parsed) ?? bodyText.slice(0, 200) ?? `HTTP ${status}`;
  const lower = message.toLowerCase();

  if (status === 401) {
    return new AxiError(
      `LiteLLM gateway rejected the key (401) for ${contextLabel}: ${message}`,
      "AUTH_REQUIRED",
      [
        "Set SPEND_AXI_GATEWAY_KEY (or LITELLM_MASTER_KEY) env, or write ~/.config/spend-axi/gateway-key",
        "The proxy-admin master key is required — the LITELLM_MCP_KEY virtual key is read-only",
      ],
    );
  }
  if (status === 403) {
    return new AxiError(
      `LiteLLM gateway forbidden (403) for ${contextLabel}: ${message}`,
      "FORBIDDEN",
      ["The resolved key lacks admin scope — use the proxy master key"],
    );
  }
  if (status === 404) {
    return new AxiError(
      `LiteLLM gateway endpoint not found (404) for ${contextLabel}`,
      "NOT_FOUND",
      ["Check that the gateway base is correct and the endpoint exists on this LiteLLM version"],
    );
  }
  if (status === 429) {
    return new AxiError(`LiteLLM gateway rate limit (429) for ${contextLabel}`, "RATE_LIMITED", [
      "Retry shortly — the gateway is throttling admin spend queries",
    ]);
  }
  if (status >= 500) {
    return new AxiError(
      `LiteLLM gateway server error (${status}) for ${contextLabel}: ${message}`,
      "UNKNOWN",
      ["Retry later — the gateway is temporarily unavailable"],
    );
  }
  if (/enterprise/i.test(lower)) {
    return new AxiError(
      `LiteLLM Enterprise-only endpoint for ${contextLabel}: ${message}`,
      "FORBIDDEN",
      [
        "This endpoint needs a LITELLM_LICENSE; spend-axi uses the open-source spend endpoints instead",
      ],
    );
  }
  return new AxiError(
    `LiteLLM gateway error (${status}) for ${contextLabel}: ${message}`,
    "UNKNOWN",
  );
}

/** AxiError thrown when no gateway key is resolvable. */
export function noGatewayKeyError(): AxiError {
  return new AxiError(
    "LiteLLM gateway key not found — spend/budget endpoints need the proxy-admin master key",
    "AUTH_REQUIRED",
    [
      "Set SPEND_AXI_GATEWAY_KEY (or LITELLM_MASTER_KEY) env, or write ~/.config/spend-axi/gateway-key",
      "Run `spend-axi` again — the /health/readiness check still works without a key",
    ],
  );
}

/** AxiError thrown when the quota-axi subprocess is missing. */
export function quotaNotAvailableError(detail: string): AxiError {
  return new AxiError(`quota-axi unavailable: ${detail}`, "NOT_FOUND", [
    "Install quota-axi (the local-first subscription-window tracker) and ensure it is on PATH",
    "Or run `spend-axi gateway` to skip subscriptions and view gateway spend only",
  ]);
}

interface GatewayErrorBody {
  error?: { message?: string; type?: string; code?: string | number };
  detail?: string | { msg?: string }[] | { error?: string; msg?: string };
}

function parseBody(text: string): GatewayErrorBody | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as GatewayErrorBody;
  } catch {
    return null;
  }
}

/** Pull a human-readable message out of the varied gateway error shapes. */
function extractMessage(parsed: GatewayErrorBody | null): string | undefined {
  if (!parsed) return undefined;
  if (parsed.error?.message) return String(parsed.error.message);
  const detail = parsed.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => d?.msg).filter((m): m is string => typeof m === "string");
    return msgs.length > 0 ? msgs.join("; ") : undefined;
  }
  if (detail && typeof detail === "object") {
    const d = detail as { error?: string; msg?: string };
    if (typeof d.error === "string") return d.error;
    if (typeof d.msg === "string") return d.msg;
  }
  return undefined;
}
