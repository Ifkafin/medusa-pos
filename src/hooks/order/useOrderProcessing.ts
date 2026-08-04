import { useCallback } from "react";
import { getSdk } from "@/config/medusa";
import { logger, safeStringify } from "@/utils/logger";
import { AdminOrder } from "@medusajs/types";
import storage from "@/utils/storage";
import { handleErrorToast } from "@/utils/helpers";

const TILLTAP_PROVIDER_ID = "pp_tilltap_default";

export type TilltapPaymentPresentation = {
  orderId: string;
  collectionId: string;
  sessionId: string;
  checkoutUrl: string;
  statusUrl: string;
  expiresAt: number;
  tilltapStatus: string;
  captureBlockedReason?: string;
};

export type PaymentProcessingResult =
  | { kind: "settled" }
  | { kind: "pending"; presentation: TilltapPaymentPresentation };

export type TilltapRefreshResult = {
  presentation: TilltapPaymentPresentation;
  isAuthorized: boolean;
  paymentStatus: string;
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tilltap did not return ${field}`);
  }
  return value;
};

export const tilltapPresentation = (
  orderId: string,
  collectionId: string,
  session: { id: string; data: Record<string, unknown> }
): TilltapPaymentPresentation => {
  const checkoutUrl = requiredString(session.data.checkout_url, "a checkout URL");
  const statusUrl = requiredString(session.data.status_url, "a status URL");
  const parsedCheckoutUrl = new URL(checkoutUrl);
  const parsedStatusUrl = new URL(statusUrl);
  if (parsedCheckoutUrl.protocol !== "https:" || parsedStatusUrl.protocol !== "https:") {
    throw new Error("Tilltap checkout presentation must use HTTPS");
  }
  const expiresAt = Number(session.data.expires_at);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Tilltap returned an invalid or expired checkout");
  }
  return {
    orderId,
    collectionId,
    sessionId: session.id,
    checkoutUrl,
    statusUrl,
    expiresAt,
    tilltapStatus: requiredString(session.data.tilltap_status, "a checkout status"),
    ...(typeof session.data.capture_blocked_reason === "string"
      ? { captureBlockedReason: session.data.capture_blocked_reason }
      : {}),
  };
};

/**
 * Shared order-processing primitives used by both the checkout payment flow
 * and the order-detail "record payment" flow.
 *
 * - processPaymentCollection: ensures the order's payment is captured. Reuses an
 *   existing payment collection or creates one, opens a payment session for the
 *   chosen provider, then captures the pending payment. Falls back to markAsPaid
 *   when the provider does not auto-authorize (see project memory
 *   project_payment_provider_flow).
 * - processFulfillment: fulfills + marks delivered (this is what decrements
 *   inventory at the stock location). Errors are non-fatal (surface a toast).
 */
const useOrderProcessing = () => {
  const processPaymentCollection = useCallback(
    async (order: AdminOrder, providerId: string): Promise<PaymentProcessingResult> => {
      const sdk = getSdk();

      if (
        order.payment_status === "captured" ||
        order.payment_status === "authorized"
      ) {
        return { kind: "settled" };
      }

      let collectionId: string;

      if (order.payment_collections && order.payment_collections.length > 0) {
        collectionId = order.payment_collections[0].id;
      } else {
        const paymentAmount = order.summary?.accounting_total || order.total || 0;
        const { payment_collection } = await sdk.admin.paymentCollection.create({
          order_id: order.id,
          amount: paymentAmount,
        });
        collectionId = payment_collection.id;
      }

      const { payment_collection: updatedCollection } =
        await sdk.admin.paymentCollection.createPaymentSession(
          collectionId,
          {
            provider_id: providerId,
            data: {
              order_id: order.id,
              order_display_id: order.display_id,
            },
          },
          { fields: "*payment_sessions,*payments" }
        );

      if (providerId === TILLTAP_PROVIDER_ID) {
        const session = updatedCollection.payment_sessions?.find(
          (candidate) => candidate.provider_id === TILLTAP_PROVIDER_ID
        );
        if (!session) {
          throw new Error("Medusa did not return the Tilltap payment session");
        }
        return {
          kind: "pending",
          presentation: tilltapPresentation(order.id, collectionId, session),
        };
      }

      const alreadyCaptured = updatedCollection.payments?.find(
        (p) => !!p.captured_at
      );
      if (alreadyCaptured) {
        return { kind: "settled" };
      }

      const pendingPayment = updatedCollection.payments?.find(
        (p) => !p.captured_at
      );

      if (pendingPayment?.id) {
        await sdk.admin.payment.capture(pendingPayment.id, {});
        return { kind: "settled" };
      }

      // Provider didn't auto-authorize — mark as paid. Try the real provider
      // first; if it can't authorize (HTTP 422), retry under the system default.
      // markAsPaid returns an empty body and only throws on a genuine rejection,
      // so the retry can't double-pay. The real provider is still recoverable from
      // the payment session via getOrderPaymentProviderId.
      try {
        await sdk.admin.paymentCollection.markAsPaid(collectionId, {
          order_id: order.id,
          provider_id: providerId,
        });
      } catch (markPaidError) {
        void logger.error(
          `markAsPaid with provider_id failed; retrying with system default: ${safeStringify(markPaidError)}`
        );
        await sdk.admin.paymentCollection.markAsPaid(collectionId, {
          order_id: order.id,
        });
      }
      return { kind: "settled" };
    },
    []
  );

  const processFulfillment = useCallback(
    async (order: AdminOrder): Promise<void> => {
      const sdk = getSdk();

      if (
        order.fulfillment_status === "fulfilled" ||
        order.fulfillment_status === "shipped" ||
        order.fulfillment_status === "delivered"
      ) {
        return;
      }

      try {
        if (order.fulfillments && order.fulfillments.length > 0) {
          const existingFulfillment = order.fulfillments[0];
          await sdk.admin.order.markAsDelivered(
            order.id,
            existingFulfillment.id
          );
          return;
        }

        const itemsToFulfill =
          order.items?.map((item) => ({
            id: item.id,
            quantity: item.quantity || 1,
          })) || [];

        if (itemsToFulfill.length === 0) {
          return;
        }

        const locationId = await storage.getItem("stock_location_id");

        const response = await sdk.admin.order.createFulfillment(order.id, {
          items: itemsToFulfill,
          no_notification: true,
          ...(locationId ? { location_id: locationId } : {}),
        });

        let fulfillmentId = response.order?.fulfillments?.[0]?.id;

        if (!fulfillmentId) {
          const { order: refreshedOrder } = await sdk.admin.order.retrieve(
            order.id,
            { fields: "*fulfillments" }
          );
          fulfillmentId = refreshedOrder.fulfillments?.[0]?.id;
        }

        if (!fulfillmentId) {
          throw new Error("Failed to get fulfillment ID");
        }

        await sdk.admin.order.markAsDelivered(order.id, fulfillmentId);
      } catch (error) {
        handleErrorToast(
          `Fulfillment failed (${error instanceof Error ? error.message : "Unknown"}), but order created`
        );
      }
    },
    []
  );

  const refreshTilltapPayment = useCallback(
    async (current: TilltapPaymentPresentation): Promise<TilltapRefreshResult> => {
      const sdk = getSdk();
      const { order, is_authorized: isAuthorized } =
        await sdk.admin.order.authorizePaymentSession(
          current.orderId,
          current.sessionId,
          {
            fields:
              "payment_status,*payment_collections.payment_sessions,*payment_collections.payments",
          }
        );
      const session = order.payment_collections
        ?.flatMap((collection) => collection.payment_sessions ?? [])
        .find((candidate) => candidate.id === current.sessionId);
      if (!session) {
        throw new Error("Medusa did not return the Tilltap payment session");
      }
      const data = session.data ?? {};
      return {
        presentation: {
          ...current,
          tilltapStatus:
            typeof data.tilltap_status === "string"
              ? data.tilltap_status
              : current.tilltapStatus,
          captureBlockedReason:
            typeof data.capture_blocked_reason === "string"
              ? data.capture_blocked_reason
              : undefined,
        },
        isAuthorized,
        paymentStatus: order.payment_status,
      };
    },
    []
  );

  return { processPaymentCollection, processFulfillment, refreshTilltapPayment };
};

export { useOrderProcessing };
