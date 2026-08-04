import { describe, expect, it } from "vitest";
import { tilltapPresentation } from "./useOrderProcessing";

const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

describe("Tilltap payment presentation", () => {
  it("accepts the public HTTPS checkout contract", () => {
    const result = tilltapPresentation("order_1", "paycol_1", {
      id: "payses_1",
      data: {
        checkout_url: `https://checkout.example.test/checkout/${token}`,
        status_url: `https://checkout.example.test/api/checkouts/${token}/status`,
        expires_at: Date.now() + 60_000,
        tilltap_status: "OPEN",
      },
    });

    expect(result).toMatchObject({
      orderId: "order_1",
      collectionId: "paycol_1",
      sessionId: "payses_1",
      tilltapStatus: "OPEN",
    });
  });

  it("rejects insecure or expired checkout presentation", () => {
    expect(() =>
      tilltapPresentation("order_1", "paycol_1", {
        id: "payses_1",
        data: {
          checkout_url: `http://checkout.example.test/checkout/${token}`,
          status_url: `https://checkout.example.test/api/checkouts/${token}/status`,
          expires_at: Date.now() + 60_000,
          tilltap_status: "OPEN",
        },
      })
    ).toThrow("must use HTTPS");

    expect(() =>
      tilltapPresentation("order_1", "paycol_1", {
        id: "payses_1",
        data: {
          checkout_url: `https://checkout.example.test/checkout/${token}`,
          status_url: `https://checkout.example.test/api/checkouts/${token}/status`,
          expires_at: Date.now() - 1,
          tilltap_status: "EXPIRED",
        },
      })
    ).toThrow("invalid or expired");
  });
});
