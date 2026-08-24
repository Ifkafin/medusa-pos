import { describe, expect, it } from "vitest";
import type { PaymentSessionSnapshot } from "./strategies";
import {
  getTilltapPresentation,
  parseTrustedOrigin,
  parseTilltapCapabilityStatus,
  validateTilltapAttemptPrerequisites,
} from "./tilltap";

const trustedOrigin = "https://pay.tilltap.example";
const checkoutToken = "A".repeat(43);
const otherToken = "B".repeat(43);
const checkoutId = "01K1CHECKOUT00000000000000";
const expiresAt = 1_800_000_000_000;

const session = (
  data: Record<string, unknown> = {}
): PaymentSessionSnapshot => ({
  id: "payses_1",
  amount: 1250,
  currency_code: "kes",
  provider_id: "pp_tilltap_default",
  status: "pending_authorization",
  data: {
    checkout_url: `${trustedOrigin}/checkout/${checkoutToken}`,
    status_url: `${trustedOrigin}/api/checkouts/${checkoutToken}/status`,
    expires_at: expiresAt,
    checkout_id: checkoutId,
    simulation: false,
    ...data,
  },
});

const presentation = () => getTilltapPresentation(session(), trustedOrigin);

describe("Tilltap payment-session parsing", () => {
  it("accepts correlated URLs and retains epoch expiry for decisions", () => {
    expect(presentation()).toEqual({
      checkoutUrl: `${trustedOrigin}/checkout/${checkoutToken}`,
      statusUrl: `${trustedOrigin}/api/checkouts/${checkoutToken}/status`,
      checkoutId,
      expiresAt,
      simulation: false,
    });
  });

  it("requires an explicitly trusted origin", () => {
    expect(() => getTilltapPresentation(session(), undefined)).toThrow(
      "trusted origin is not configured"
    );
    expect(() =>
      getTilltapPresentation(session(), "https://other.example")
    ).toThrow("untrusted checkout_url");
  });

  it("accepts only the loopback hostname allowed by the Tauri scope", () => {
    expect(parseTrustedOrigin("http://localhost:3001")).toBe(
      "http://localhost:3001"
    );
    expect(() => parseTrustedOrigin("http://127.0.0.1:3001")).toThrow(
      "trusted origin is invalid"
    );
    expect(() => parseTrustedOrigin("http://[::1]:3001")).toThrow(
      "trusted origin is invalid"
    );
  });

  it("validates KES and a positive integer amount before an attempt", () => {
    expect(
      validateTilltapAttemptPrerequisites("KES", 1250, trustedOrigin)
    ).toBe(trustedOrigin);
    expect(() =>
      validateTilltapAttemptPrerequisites("usd", 1250, trustedOrigin)
    ).toThrow("requires a KES order");
    expect(() =>
      validateTilltapAttemptPrerequisites("kes", 12.5, trustedOrigin)
    ).toThrow("positive integer amount");
  });

  it("requires the Tilltap provider and exact expected amount", () => {
    expect(() =>
      getTilltapPresentation(
        { ...session(), provider_id: "pp_other" },
        trustedOrigin
      )
    ).toThrow("invalid provider_id");
    expect(() =>
      getTilltapPresentation(session(), trustedOrigin, 1251)
    ).toThrow("does not match the order amount");
  });

  it.each([
    {
      checkout_url: `https://other.example/checkout/${checkoutToken}`,
    },
    {
      status_url: `https://other.example/api/checkouts/${checkoutToken}/status`,
    },
    {
      checkout_url: `${trustedOrigin}/c/${checkoutToken}`,
    },
    {
      status_url: `${trustedOrigin}/api/checkouts/${checkoutToken}`,
    },
    {
      status_url: `${trustedOrigin}/api/checkouts/${otherToken}/status`,
    },
    {
      checkout_url: `${trustedOrigin}/checkout/${checkoutToken}?next=elsewhere`,
    },
    {
      status_url: `${trustedOrigin}/api/checkouts/short/status`,
    },
  ])("rejects untrusted or malformed URL data %#", (data) => {
    expect(() => getTilltapPresentation(session(data), trustedOrigin)).toThrow();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER])(
    "rejects invalid epoch expiry %s",
    (invalidExpiry) => {
      expect(() =>
        getTilltapPresentation(
          session({ expires_at: invalidExpiry }),
          trustedOrigin
        )
      ).toThrow("invalid expires_at");
    }
  );

  it("requires checkout_id and simulation with their exact types", () => {
    expect(() =>
      getTilltapPresentation(session({ checkout_id: "" }), trustedOrigin)
    ).toThrow("invalid checkout_id");
    expect(() =>
      getTilltapPresentation(session({ simulation: "false" }), trustedOrigin)
    ).toThrow("invalid simulation");
  });
});

describe("Tilltap status correlation and mapping", () => {
  const statusView = (overrides: Record<string, unknown> = {}) => ({
    id: checkoutId,
    status: "OPEN",
    expiresAt,
    simulation: false,
    ...overrides,
  });

  it.each(["OPEN", "PAYMENT_PENDING"])("maps %s to pending", (status) => {
    expect(
      parseTilltapCapabilityStatus(statusView({ status }), presentation())
    ).toBe("pending");
  });

  it("maps REVIEW to review", () => {
    expect(
      parseTilltapCapabilityStatus(statusView({ status: "REVIEW" }), presentation())
    ).toBe("review");
  });

  it.each(["NOT_PAID", "CANCELLED", "EXPIRED"])(
    "maps terminal non-success %s to failed",
    (status) => {
      expect(
        parseTilltapCapabilityStatus(statusView({ status }), presentation())
      ).toBe("failed");
    }
  );

  it("maps only real PAID with a nonempty receipt to confirmed", () => {
    expect(
      parseTilltapCapabilityStatus(
        statusView({ status: "PAID", receipt: "RCP123" }),
        presentation()
      )
    ).toBe("confirmed");
    expect(
      parseTilltapCapabilityStatus(
        statusView({ status: "PAID", simulation: true, receipt: "FIXTURE" }),
        getTilltapPresentation(session({ simulation: true }), trustedOrigin)
      )
    ).toBe("review");
  });

  it.each([undefined, "", "   "])(
    "maps real PAID without a nonempty receipt to review",
    (receipt) => {
      expect(
        parseTilltapCapabilityStatus(
          statusView({ status: "PAID", receipt }),
          presentation()
        )
      ).toBe("review");
    }
  );

  it("rejects status for another checkout", () => {
    expect(() =>
      parseTilltapCapabilityStatus(
        statusView({ id: "01K1OTHER00000000000000000" }),
        presentation()
      )
    ).toThrow("does not match checkout_id");
  });

  it("rejects changed expiry or simulation evidence", () => {
    expect(() =>
      parseTilltapCapabilityStatus(
        statusView({ expiresAt: expiresAt + 1 }),
        presentation()
      )
    ).toThrow("does not match the payment session");
    expect(() =>
      parseTilltapCapabilityStatus(
        statusView({ simulation: true }),
        presentation()
      )
    ).toThrow("does not match the payment session");
  });

  it("rejects unknown status and malformed receipt", () => {
    expect(() =>
      parseTilltapCapabilityStatus(
        statusView({ status: "SUCCESS" }),
        presentation()
      )
    ).toThrow("unknown status");
    expect(() =>
      parseTilltapCapabilityStatus(
        statusView({ status: "PAID", receipt: 123 }),
        presentation()
      )
    ).toThrow("invalid receipt");
  });
});
