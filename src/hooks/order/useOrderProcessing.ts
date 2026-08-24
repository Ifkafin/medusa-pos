import { useCallback } from "react";
import { getSdk } from "@/config/medusa";
import { AdminOrder } from "@medusajs/types";
import storage from "@/utils/storage";
import { handleErrorToast } from "@/utils/helpers";
import {
  processPaymentWithStrategy,
  requireAuthoritativeGoodsRelease,
  TILLTAP_ATTEMPT_METADATA_KEY,
  TILLTAP_PROVIDER_ID,
  type PaymentProcessingResult,
} from "@/utils/pos/payment/strategies";

const GOODS_RELEASE_FIELDS =
  "id,payment_status,metadata,*payment_collections.payment_sessions";

/**
 * Shared order-processing primitives used by both the checkout payment flow
 * and the order-detail "record payment" flow.
 *
 * - processPaymentCollection: delegates provider-specific behavior to the payment
 *   strategy seam. Synchronous providers retain the existing capture/mark-as-paid
 *   behavior; asynchronous providers return their session without either fallback.
 * - processFulfillment: fulfills + marks delivered (this is what decrements
 *   inventory at the stock location). Errors are surfaced and propagated.
 */
const useOrderProcessing = () => {
  const processPaymentCollection = useCallback(
    async (
      order: AdminOrder,
      providerId: string
    ): Promise<PaymentProcessingResult> => {
      const sdk = getSdk();

      return processPaymentWithStrategy(order, providerId, {
        createCollection: async (orderId, amount) => {
          const { payment_collection } =
            await sdk.admin.paymentCollection.create({
              order_id: orderId,
              amount,
            });
          return payment_collection;
        },
        createPaymentSession: async (collectionId, selectedProviderId) => {
          const { payment_collection } =
            await sdk.admin.paymentCollection.createPaymentSession(
              collectionId,
              { provider_id: selectedProviderId },
              { fields: "*payment_sessions,*payments" }
            );
          return payment_collection;
        },
        capturePayment: async (paymentId) => {
          await sdk.admin.payment.capture(paymentId, {});
        },
        markAsPaid: async (collectionId, orderId, selectedProviderId) => {
          await sdk.admin.paymentCollection.markAsPaid(collectionId, {
            order_id: orderId,
            ...(selectedProviderId
              ? { provider_id: selectedProviderId }
              : {}),
          });
        },
        persistAsyncAttempt: async (attemptOrder, sessionId) => {
          await sdk.admin.order.update(attemptOrder.id, {
            metadata: {
              ...(attemptOrder.metadata ?? {}),
              [TILLTAP_ATTEMPT_METADATA_KEY]: {
                provider_id: TILLTAP_PROVIDER_ID,
                state: sessionId ? "created" : "prepared",
                ...(sessionId ? { session_id: sessionId } : {}),
              },
            },
          });
        },
      });
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
        await requireAuthoritativeGoodsRelease(async () => {
          const { order: refreshedOrder } = await sdk.admin.order.retrieve(
            order.id,
            { fields: GOODS_RELEASE_FIELDS }
          );
          return refreshedOrder;
        });

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
          `Fulfillment failed: ${error instanceof Error ? error.message : "Unknown"}`
        );
        throw error;
      }
    },
    []
  );

  return { processPaymentCollection, processFulfillment };
};

export { useOrderProcessing };
