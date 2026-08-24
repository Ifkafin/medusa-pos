import { useState, useMemo, useCallback } from "react";
import { AdminOrder } from "@medusajs/types";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/config/query";
import { getSdk } from "@/config/medusa";
import { useTranslation } from "@/i18n";
import { useQueryStore } from "@/hooks/queries/useQueryStore";
import { useOrderProcessing } from "@/hooks/order/useOrderProcessing";
import { getPaymentMethods } from "@/utils/settings/store/metadata";
import { getOrderPaymentProviderId } from "@/utils/pos/payment";
import { handleErrorToast } from "@/utils/helpers";
import {
  canFinalizeOrder,
  isTilltapOrder,
  TILLTAP_PROVIDER_ID,
} from "@/utils/pos/payment/strategies";

const RECORD_PAYMENT_FIELDS =
  "id,status,payment_status,fulfillment_status,metadata,*payment_collections,*payment_collections.payments,*payment_collections.payment_sessions";

// "Record payment" dialog: captures an outstanding payment on an existing (pay-later)
// order and completes it once both paid and fulfilled.
export const useRecordPayment = (order: AdminOrder, onClose?: () => void) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: store } = useQueryStore();
  const { processPaymentCollection } = useOrderProcessing();

  const [isProcessing, setIsProcessing] = useState(false);

  const methods = useMemo(() => getPaymentMethods(store), [store]);

  // Default to the method the order was rung up with (intended provider), else first enabled.
  const [selectedMethod, setSelectedMethod] = useState<string>(
    () => getOrderPaymentProviderId(order) ?? methods[0]?.id ?? ""
  );

  const total = order.summary?.accounting_total ?? order.total ?? 0;
  const currency = order.currency_code;

  const handleConfirm = useCallback(async () => {
    if (!selectedMethod) {
      handleErrorToast(t("checkout.select_payment_method"));
      return;
    }
    if (selectedMethod === TILLTAP_PROVIDER_ID) {
      handleErrorToast(t("checkout.tilltap.record_payment_blocked"));
      return;
    }

    setIsProcessing(true);
    try {
      const sdk = getSdk();

      const { order: currentOrder } = await sdk.admin.order.retrieve(order.id, {
        fields: RECORD_PAYMENT_FIELDS,
      });
      if (isTilltapOrder(currentOrder)) {
        throw new Error(t("checkout.tilltap.record_payment_blocked"));
      }

      // Capture the outstanding amount with the chosen provider.
      await processPaymentCollection(currentOrder, selectedMethod);
      const { order: refreshedOrder } = await sdk.admin.order.retrieve(order.id, {
        fields: "id,status,payment_status,fulfillment_status",
      });
      if (!canFinalizeOrder(refreshedOrder)) {
        throw new Error(
          "Medusa has not captured this payment. Keep the order unpaid."
        );
      }

      // Delivered + now paid → complete (skip if backend auto-completed; non-fatal).
      const isFulfilled =
        refreshedOrder.fulfillment_status === "fulfilled" ||
        refreshedOrder.fulfillment_status === "shipped" ||
        refreshedOrder.fulfillment_status === "delivered";
      if (isFulfilled && refreshedOrder.status !== "completed") {
        try {
          await sdk.admin.order.complete(order.id, {});
        } catch {
          // non-fatal
        }
      }

      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(order.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });

      toast.success(t("orders.record_payment_success"));
      onClose?.();
    } catch (error) {
      handleErrorToast(
        error instanceof Error ? error.message : t("orders.record_payment_failed")
      );
    } finally {
      setIsProcessing(false);
    }
  }, [selectedMethod, order, processPaymentCollection, queryClient, onClose, t]);

  return {
    methods,
    selectedMethod,
    setSelectedMethod,
    total,
    currency,
    isProcessing,
    handleConfirm,
  };
};
