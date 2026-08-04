import { describe, expect, it, vi } from "vitest";
import type { AdminOrder } from "@medusajs/types";
import {
  TILLTAP_PROVIDER_ID,
  canIssueReceipt,
  canRecordPayment,
  canReleaseGoods,
  finalizeOrderIfPaid,
  findTilltapPaymentSession,
  getPaymentStrategy,
  hasTilltapPaymentSession,
  processPaymentWithStrategy,
  requireAuthoritativeGoodsRelease,
  requireAuthoritativeReceipt,
  type PaymentProcessingDependencies,
} from "./strategies";

const checkoutToken = "A".repeat(43);

const order = (paymentStatus: AdminOrder["payment_status"] = "not_paid") =>
  ({
    id: "order_1",
    total: 1250,
    payment_status: paymentStatus,
    payment_collections: [{ id: "paycol_1" }],
  }) as AdminOrder;

const dependencies = (): PaymentProcessingDependencies => ({
  createCollection: vi.fn(),
  createPaymentSession: vi.fn().mockResolvedValue({
    id: "paycol_1",
    payment_sessions: [
      {
        id: "payses_1",
        amount: 1250,
        currency_code: "kes",
        provider_id: TILLTAP_PROVIDER_ID,
        status: "pending_authorization",
        data: {
          checkout_url: `https://pay.tilltap.example/checkout/${checkoutToken}`,
          status_url: `https://pay.tilltap.example/api/checkouts/${checkoutToken}/status`,
          expires_at: 1_786_367_400_000,
          checkout_id: "01K1CHECKOUT00000000000000",
          simulation: false,
        },
      },
    ],
  }),
  capturePayment: vi.fn(),
  markAsPaid: vi.fn(),
  persistAsyncAttempt: vi.fn(),
});

describe("payment strategy selection", () => {
  it("selects the async strategy only for the Tilltap provider", () => {
    expect(getPaymentStrategy(TILLTAP_PROVIDER_ID)).toBe("asynchronous");
    expect(getPaymentStrategy("pp_manual_pos")).toBe("synchronous");
  });

  it("returns Tilltap session status and data without marking or capturing", async () => {
    const deps = dependencies();
    const result = await processPaymentWithStrategy(
      order(),
      TILLTAP_PROVIDER_ID,
      deps
    );

    expect(result).toMatchObject({
      strategy: "asynchronous",
      session: {
        id: "payses_1",
        status: "pending_authorization",
        data: {
          checkout_url: `https://pay.tilltap.example/checkout/${checkoutToken}`,
          checkout_id: "01K1CHECKOUT00000000000000",
          simulation: false,
        },
      },
    });
    expect(deps.createPaymentSession).toHaveBeenCalledTimes(1);
    expect(deps.persistAsyncAttempt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: "order_1",
    }));
    expect(deps.persistAsyncAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "order_1" }),
      "payses_1"
    );
    expect(
      vi.mocked(deps.persistAsyncAttempt).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(deps.createPaymentSession).mock.invocationCallOrder[0]
    );
    expect(deps.capturePayment).not.toHaveBeenCalled();
    expect(deps.markAsPaid).not.toHaveBeenCalled();
  });

  it("recovers the server-side Tilltap session without creating a replacement", async () => {
    const deps = dependencies();
    const existingOrder = {
      ...order(),
      payment_collections: [
        {
          id: "paycol_1",
          payment_sessions: [
            {
              id: "payses_existing",
              amount: 1250,
              currency_code: "kes",
              provider_id: TILLTAP_PROVIDER_ID,
              status: "pending_authorization",
              data: {},
            },
          ],
        },
      ],
    } as unknown as AdminOrder;

    await expect(
      processPaymentWithStrategy(existingOrder, TILLTAP_PROVIDER_ID, deps)
    ).resolves.toMatchObject({
      strategy: "asynchronous",
      session: { id: "payses_existing" },
    });
    expect(deps.createPaymentSession).not.toHaveBeenCalled();
    expect(deps.persistAsyncAttempt).not.toHaveBeenCalled();
  });

  it("propagates synchronous capture errors instead of treating authorization as capture", async () => {
    const deps = dependencies();
    vi.mocked(deps.capturePayment).mockRejectedValue(new Error("capture failed"));
    const authorizedOrder = {
      ...order("authorized"),
      payment_collections: [
        { id: "paycol_1", payments: [{ id: "pay_1", captured_at: null }] },
      ],
    } as unknown as AdminOrder;

    await expect(
      processPaymentWithStrategy(authorizedOrder, "pp_manual_pos", deps)
    ).rejects.toThrow("capture failed");
    expect(deps.createPaymentSession).not.toHaveBeenCalled();
  });
});

describe("paid-order finalization gate", () => {
  it("does not run fulfillment or checkout side effects while Medusa is unpaid", async () => {
    const finalize = vi.fn();
    expect(await finalizeOrderIfPaid(order("awaiting"), finalize)).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not allow authorization to stand in for capture", async () => {
    const finalize = vi.fn();
    expect(await finalizeOrderIfPaid(order("authorized"), finalize)).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("allows finalization only when Medusa reports captured", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    expect(await finalizeOrderIfPaid(order("captured"), finalize)).toBe(true);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("propagates finalization failure so success side effects cannot continue", async () => {
    const finalize = vi.fn().mockRejectedValue(new Error("fulfillment failed"));
    await expect(finalizeOrderIfPaid(order("captured"), finalize)).rejects.toThrow(
      "fulfillment failed"
    );
  });
});

describe("Tilltap order safety predicates", () => {
  const tilltapSession = {
    id: "payses_tilltap",
    amount: 1250,
    currency_code: "kes",
    provider_id: TILLTAP_PROVIDER_ID,
    status: "pending_authorization",
    data: {},
  };
  const tilltapOrder = (status: AdminOrder["payment_status"] = "awaiting") =>
    ({
      ...order(status),
      status: "pending",
      metadata: {},
      payment_collections: [
        { id: "paycol_other", payment_sessions: [] },
        { id: "paycol_tilltap", payment_sessions: [tilltapSession] },
      ],
    }) as AdminOrder;

  it("detects a Tilltap session in any payment collection", () => {
    expect(hasTilltapPaymentSession(tilltapOrder())).toBe(true);
    expect(findTilltapPaymentSession(tilltapOrder())?.id).toBe("payses_tilltap");
    expect(findTilltapPaymentSession(tilltapOrder(), "stale-local-id")?.id).toBe(
      "payses_tilltap"
    );
  });

  it("does not automatically finalize a captured Tilltap order", async () => {
    const finalize = vi.fn();
    expect(
      await finalizeOrderIfPaid(tilltapOrder("captured"), finalize)
    ).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("blocks Record Payment for every method once a Tilltap session exists", () => {
    expect(canRecordPayment(tilltapOrder())).toBe(false);
    expect(
      canRecordPayment({ ...order("awaiting"), status: "pending", metadata: {} })
    ).toBe(true);
  });

  it("allows non-Tilltap pay-later release but never auto-releases Tilltap", () => {
    expect(canReleaseGoods({ ...order("awaiting"), metadata: {} })).toBe(true);
    expect(canReleaseGoods(tilltapOrder("authorized"))).toBe(false);
    expect(canReleaseGoods(tilltapOrder("captured"))).toBe(false);
  });

  it("always re-reads and rejects a captured Tilltap order from a stale non-Tilltap snapshot", async () => {
    const staleOrder = { ...order("captured"), metadata: {} } as AdminOrder;
    expect(canReleaseGoods(staleOrder)).toBe(true);

    const refreshCaptured = vi.fn().mockResolvedValue(tilltapOrder("captured"));
    await expect(
      requireAuthoritativeGoodsRelease(refreshCaptured)
    ).rejects.toThrow("Automatic goods release is disabled");
    expect(refreshCaptured).toHaveBeenCalledTimes(1);
  });

  it("re-reads but otherwise leaves non-Tilltap pay-later release unchanged", async () => {
    const refresh = vi.fn().mockResolvedValue({
      ...order("awaiting"),
      metadata: {},
    });
    await expect(
      requireAuthoritativeGoodsRelease(refresh)
    ).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("hides receipts and re-checks before rejecting a stale receipt handler", async () => {
    expect(canIssueReceipt(tilltapOrder("captured"))).toBe(false);
    expect(canIssueReceipt({ ...order("captured"), metadata: {} })).toBe(true);

    const refresh = vi.fn().mockResolvedValue(tilltapOrder("captured"));
    await expect(requireAuthoritativeReceipt(refresh)).rejects.toThrow(
      "Paid receipts are disabled"
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
