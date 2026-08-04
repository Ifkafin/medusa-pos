import { logger, safeStringify } from "@/utils/logger";
import { t } from "@/i18n";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useChange } from "@/hooks/utils/useChange";
import { toast } from "sonner";
import { queryClient, queryKeys } from "@/config/query";
import { getSdk } from "@/config/medusa";
import { playErrorSound, playSuccessSound } from "@/utils/sounds";
import { usePrinterService } from "@/hooks/printer/usePrinterService";
import { AdminOrder, AdminDraftOrder } from "@medusajs/types";
import { useCartStore } from "@/context/cart";
import { useRegister } from "@/context/register";
import { PaymentMethod } from "@/types/utils";
import { useCheckout } from "../hooks";
import { useQueryStore } from "@/hooks/queries/useQueryStore";
import { useOrderProcessing } from "@/hooks/order/useOrderProcessing";
import { getPaymentMethods, getMethodType } from "@/utils/settings/store/metadata";
import { getCashRounding, roundCashAmount } from "@/utils/settings/preferences";
import constants from "@/utils/constants";
import { CreditCard, Banknote } from "lucide-react";
import {
  cashDrawerIssueStaffHintToast,
  handleErrorToast,
  printerIssueStaffHintToast,
} from "@/utils/helpers";
import {
  canFinalizeOrder,
  findTilltapPaymentSession,
  findUncapturedTilltapPaymentId,
  finalizeOrderIfPaid,
  getPaymentStrategy,
  TILLTAP_PROVIDER_ID,
  type PaymentSessionSnapshot,
} from "@/utils/pos/payment/strategies";
import {
  fetchTilltapCapabilityStatus,
  getTilltapPresentation,
  validateTilltapAttemptPrerequisites,
} from "@/utils/pos/payment/tilltap";

const PAYMENT_ORDER_FIELDS =
  "id,display_id,payment_status,total,currency_code,metadata,*payment_collections,*payment_collections.payments,*payment_collections.payment_sessions,*summary,*fulfillments,*items,*customer,*sales_channel,*shipping_methods";
const TILLTAP_POLL_INTERVAL_MS = 2_000;
const TILLTAP_TRUSTED_ORIGIN = import.meta.env.VITE_TILLTAP_ORIGIN;

export type TilltapPaymentState = {
  phase: "pending" | "review" | "failure";
  checkoutUrl?: string;
  expiresAt?: string;
  orderDisplayId?: number;
  providerConfirmed?: boolean;
};

const waitForTilltapPoll = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, TILLTAP_POLL_INTERVAL_MS);
    signal.addEventListener("abort", handleAbort, { once: true });
  });

const iconByType = {
  cash: Banknote,
  card: CreditCard,
} as const;

const usePaymentMethodDisplay = (selectedPaymentMethod?: PaymentMethod) => {
  const { data: store } = useQueryStore();
  return useMemo(() => {
    if (selectedPaymentMethod === TILLTAP_PROVIDER_ID) {
      return { label: t("checkout.tilltap.pilot_title"), icon: CreditCard };
    }
    const methods = getPaymentMethods(store);
    const found = methods.find((m) => m.id === selectedPaymentMethod);
    if (found) {
      const Icon = iconByType[found.icon ?? "card"];
      return { label: found.label, icon: Icon };
    }
    return { label: "Unknown", icon: CreditCard };
  }, [store, selectedPaymentMethod]);
};

const useDraftOrderState = (draftOrderId?: string | null, isOpen?: boolean) => {
  const [draftOrder, setDraftOrder] = useState<AdminDraftOrder | null>(null);
  // Monotonic sequence so a late-resolving fetch can't overwrite a newer result
  // (fetchDraftOrder is also called directly, outside the effect below).
  const fetchSeqRef = useRef(0);

  const fetchDraftOrder = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    if (!draftOrderId) {
      setDraftOrder(null);
      return null;
    }

    try {
      const sdk = getSdk();
      const { draft_order } = await sdk.admin.draftOrder.retrieve(
        draftOrderId,
        {
          fields:
            "*items,*summary,*region,*sales_channel,subtotal,discount_total,tax_total,total",
        }
      );

      if (seq === fetchSeqRef.current) setDraftOrder(draft_order);
      return draft_order;
    } catch (error) {
      void logger.error(`Failed to fetch draft order: ${safeStringify(error)}`);
      if (seq === fetchSeqRef.current) setDraftOrder(null);
      return null;
    }
  }, [draftOrderId]);

  const shouldLoad = !!draftOrderId && !!isOpen;
  useChange(shouldLoad, () => {
    if (!shouldLoad) setDraftOrder(null);
  });

  useEffect(() => {
    if (!draftOrderId || !isOpen) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) fetchDraftOrder();
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, draftOrderId, fetchDraftOrder]);

  return { draftOrder, fetchDraftOrder };
};

const useOrderCalculations = (draftOrder: AdminDraftOrder | null) => {
  if (!draftOrder) {
    return {
      subtotal: 0,
      discount: 0,
      tax: 0,
      total: 0,
      itemCount: 0,
    };
  }

  const subtotal = draftOrder.subtotal || 0;
  const discount = draftOrder.discount_total || 0;
  const tax = draftOrder.tax_total || 0;
  const total = draftOrder.total || 0;
  const itemCount =
    draftOrder.items?.reduce((sum, item) => sum + (item.quantity || 0), 0) || 0;

  return { subtotal, discount, tax, total, itemCount };
};

const useCashPayment = (total: number, isCashType: boolean) => {
  const [customerPaid, setCustomerPaid] = useState<string>("");
  const [billCounts, setBillCounts] = useState<Record<number, number>>({});

  const handleCashValueChange = (value: string) => {
    setCustomerPaid(value);
    // Reset bill counts when manually entering a value
    if (value === "" || value === "0") {
      setBillCounts({});
    }
  };

  const handleQuickAmount = (amount: number, remove: boolean = false) => {
    if (remove) {
      // Remove one bill of this amount
      setCustomerPaid((prev) => {
        const currentPaid = parseFloat(prev) || 0;
        return Math.max(0, currentPaid - amount).toString();
      });

      setBillCounts((prev) => {
        const currentCount = prev[amount] || 0;
        if (currentCount > 0) {
          const newCount = currentCount - 1;
          if (newCount <= 0) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [amount]: _, ...rest } = prev;
            return rest;
          }
          return { ...prev, [amount]: newCount };
        }
        return prev;
      });
    } else {
      // Add the amount to the current total
      setCustomerPaid((prev) => {
        const currentPaid = parseFloat(prev) || 0;
        return (currentPaid + amount).toString();
      });

      // Update bill count
      setBillCounts((prev) => ({
        ...prev,
        [amount]: (prev[amount] || 0) + 1,
      }));
    }
  };

  const handleClearBillCounts = () => {
    setBillCounts({});
    setCustomerPaid("");
  };

  const handleExactAmount = () => {
    setCustomerPaid(total.toString());
    setBillCounts({});
  };

  const change =
    isCashType && customerPaid
      ? (parseFloat(customerPaid) || 0) - total
      : 0;

  const canProcessPayment =
    isCashType
      ? (parseFloat(customerPaid) || 0) >= total
      : true;

  const resetCashState = () => {
    setCustomerPaid("");
    setBillCounts({});
  };

  return {
    customerPaid,
    change,
    canProcessPayment,
    handleCashValueChange,
    handleQuickAmount,
    handleClearBillCounts,
    handleExactAmount,
    resetCashState,
    billCounts,
    quickAmounts: constants.QUICK_CASH_AMOUNTS,
  };
};

const usePaymentModal = (
  draftOrderId?: string | null,
  onClose?: () => void,
  isOpen?: boolean
) => {
  const [isProcessing, setIsProcessing] = useState(false);
  // Single-flight guard: a ref (not state) so a double-tap can't convert the draft twice.
  const submissionRef = useRef(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showPayLaterConfirmation, setShowPayLaterConfirmation] =
    useState(false);
  // Total snapshotted at submit — clearing draftOrderId mid-flow would show 0.00 otherwise.
  const [frozenTotal, setFrozenTotal] = useState<number | null>(null);
  const [tilltapPayment, setTilltapPayment] =
    useState<TilltapPaymentState | null>(null);
  const tilltapPollAbortRef = useRef<AbortController | null>(null);

  const { printOrderReceipt, openCashDrawer, getDefaultPrinter } = usePrinterService();
  const clearItems = useCartStore((state) => state.clearItems);
  const setDraftOrderId = useCartStore((state) => state.setDraftOrderId);
  const updateMetadata = useCartStore((state) => state.updateMetadata);
  const pendingAsyncOrderId = useCartStore(
    (state) => state.metadata.async_payment_order_id
  );
  const pendingAsyncSessionId = useCartStore(
    (state) => state.metadata.async_payment_session_id
  );
  const pendingAsyncProviderId = useCartStore(
    (state) => state.metadata.async_payment_provider_id
  );
  const {
    selectedPaymentMethod,
    setPaymentMethod,
    currency: checkoutCurrency,
  } = useCheckout();
  const { isOpen: registerOpen, session: registerSession } = useRegister();
  // Stamp orders with the active register session so cash reconciliation can
  // attribute them exactly (falls back to the created_at window when absent).
  const registerSessionId = registerOpen ? registerSession?.id : undefined;
  const items = useCartStore((state) => state.items);

  const { data: store } = useQueryStore();
  const isCashType = getMethodType(store, selectedPaymentMethod) === "cash";
  const isTilltapPayment =
    (selectedPaymentMethod === TILLTAP_PROVIDER_ID &&
      getPaymentStrategy(selectedPaymentMethod) === "asynchronous") ||
    pendingAsyncProviderId === TILLTAP_PROVIDER_ID;
  const paymentMethodInfo = usePaymentMethodDisplay(
    isTilltapPayment ? TILLTAP_PROVIDER_ID : selectedPaymentMethod
  );

  // Compose sub-hooks
  const { draftOrder, fetchDraftOrder } = useDraftOrderState(
    draftOrderId,
    isOpen
  );
  const calculations = useOrderCalculations(draftOrder);

  useEffect(
    () => () => {
      tilltapPollAbortRef.current?.abort();
    },
    []
  );

  // Swedish rounding: cash tenders round to the configured increment (card stays exact);
  // Medusa's total is untouched — the rounded figure drives change + reconciliation metadata.
  const roundingActive =
    isCashType && getCashRounding().enabled;
  const cashTotal = roundingActive
    ? roundCashAmount(calculations.total)
    : calculations.total;

  const {
    customerPaid,
    change,
    canProcessPayment,
    handleCashValueChange,
    handleQuickAmount,
    handleClearBillCounts,
    handleExactAmount,
    resetCashState,
    billCounts,
    quickAmounts,
  } = useCashPayment(cashTotal, isCashType);
  const { processPaymentCollection, processFulfillment } = useOrderProcessing();

  // While processing, the draft order is cleared (so its total reads 0). Show the
  // frozen snapshot taken at submit time so the amount never flashes to 0.00.
  const displayTotal =
    isProcessing && frozenTotal != null ? frozenTotal : calculations.total;

  // Rounded cash amount to collect (cash + rounding on); card shows exact total.
  const cashDue = roundingActive ? roundCashAmount(displayTotal) : displayTotal;

  // Fire-and-forget: print receipt + open cash drawer after order succeeds.
  // Runs independently so it never blocks the modal from closing.
  const runPostOrderHardware = useCallback(
    (order: AdminOrder, paymentMethod: PaymentMethod | undefined) => {
      const defaultPrinter = getDefaultPrinter();

      printOrderReceipt(order).catch((printError) => {
        void logger.warn(`Auto-print failed: ${safeStringify(printError)}`);
        toast.error(t("orders.receipt_did_not_print"), {
          description: defaultPrinter
            ? printerIssueStaffHintToast(defaultPrinter.name)
            : t("checkout.no_default_printer"),
        });
      });

      if (defaultPrinter?.openCashDrawer) {
        const isCash = getMethodType(store, paymentMethod) === "cash";
        const isCard = !isCash && paymentMethod !== undefined;
        if (
          (isCash && defaultPrinter.openCashDrawerOnCash) ||
          (isCard && defaultPrinter.openCashDrawerOnCard)
        ) {
          openCashDrawer(defaultPrinter).catch((drawerError) => {
            void logger.warn(`Auto cash drawer failed: ${safeStringify(drawerError)}`);
            toast.error(t("checkout.cash_drawer_error_title"), {
              description: cashDrawerIssueStaffHintToast(defaultPrinter.name),
            });
          });
        }
      }
    },
    [store, printOrderReceipt, openCashDrawer, getDefaultPrinter]
  );

  // Clean up after successful order — synchronous-ish: clears cart, resets
  // state, shows success toast. Hardware side effects are fire-and-forget.
  const cleanupAfterOrder = useCallback(
    async (
      order: AdminOrder,
      paymentMethod: PaymentMethod | undefined,
      options?: { successMessage?: string }
    ): Promise<void> => {
      clearItems();
      setDraftOrderId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });

      resetCashState();
      setPaymentMethod(undefined);

      toast.success(
        options?.successMessage ??
          `Order #${order.display_id} created successfully!`
      );
      playSuccessSound();

      runPostOrderHardware(order, paymentMethod);
    },
    [
      clearItems,
      setDraftOrderId,
      resetCashState,
      setPaymentMethod,
      runPostOrderHardware,
    ]
  );

  const finalizePaidOrder = useCallback(
    async (
      order: AdminOrder,
      paymentMethod: PaymentMethod | undefined
    ): Promise<boolean> =>
      finalizeOrderIfPaid(order, async (paidOrder) => {
        await processFulfillment(paidOrder);

        try {
          await getSdk().admin.order.complete(paidOrder.id, {});
        } catch {
          // Completion is non-fatal after payment and fulfillment have succeeded.
        }

        await cleanupAfterOrder(paidOrder, paymentMethod);
      }),
    [cleanupAfterOrder, processFulfillment]
  );

  const monitorTilltapPayment = useCallback(
    async (
      initialOrder: AdminOrder,
      session: PaymentSessionSnapshot
    ): Promise<AdminOrder | null> => {
      let presentation;
      try {
        presentation = getTilltapPresentation(
          session,
          TILLTAP_TRUSTED_ORIGIN,
          initialOrder.total
        );
        validateTilltapAttemptPrerequisites(
          initialOrder.currency_code,
          initialOrder.total,
          TILLTAP_TRUSTED_ORIGIN
        );
      } catch {
        setTilltapPayment({
          phase: "review",
          orderDisplayId: initialOrder.display_id,
        });
        return null;
      }
      const expiresAtIso = new Date(presentation.expiresAt).toISOString();

      setFrozenTotal(initialOrder.total || session.amount);
      setTilltapPayment({
        phase: "pending",
        checkoutUrl: presentation.checkoutUrl,
        expiresAt: expiresAtIso,
        orderDisplayId: initialOrder.display_id,
      });

      tilltapPollAbortRef.current?.abort();
      const controller = new AbortController();
      tilltapPollAbortRef.current = controller;
      let providerConfirmed = false;

      try {
        while (!controller.signal.aborted) {
          const sdk = getSdk();
          const { order: medusaOrder } = await sdk.admin.order.retrieve(
            initialOrder.id,
            { fields: PAYMENT_ORDER_FIELDS }
          );
          if (canFinalizeOrder(medusaOrder)) return medusaOrder;

          const reachedLocalExpiry = Date.now() >= presentation.expiresAt;
          const capabilityStatus = await fetchTilltapCapabilityStatus(
            presentation,
            controller.signal
          );

          if (capabilityStatus === "confirmed") {
            providerConfirmed = true;
            setTilltapPayment({
              phase: "pending",
              checkoutUrl: presentation.checkoutUrl,
              expiresAt: expiresAtIso,
              orderDisplayId: initialOrder.display_id,
              providerConfirmed: true,
            });

            try {
              const authorization =
                await sdk.admin.order.authorizePaymentSession(
                  initialOrder.id,
                  session.id,
                  { fields: PAYMENT_ORDER_FIELDS }
                );
              if (canFinalizeOrder(authorization.order)) {
                return authorization.order;
              }
              if (authorization.is_authorized) {
                const paymentId = findUncapturedTilltapPaymentId(
                  authorization.order,
                  session.id
                );
                if (paymentId) {
                  await sdk.admin.payment.capture(paymentId, {});
                }
              }
            } catch {
              void logger.warn(
                "Tilltap was confirmed but Medusa authorization or capture is still unavailable"
              );
            }
          }

          // Re-read after the provider capability and any authorization/capture
          // mutation. This is also the final Medusa check at local expiry.
          const { order: refreshedOrder } = await sdk.admin.order.retrieve(
            initialOrder.id,
            { fields: PAYMENT_ORDER_FIELDS }
          );
          if (canFinalizeOrder(refreshedOrder)) return refreshedOrder;

          if (reachedLocalExpiry) {
            setTilltapPayment({
              phase:
                providerConfirmed || capabilityStatus === "review"
                  ? "review"
                  : "failure",
              checkoutUrl: presentation.checkoutUrl,
              expiresAt: expiresAtIso,
              orderDisplayId: initialOrder.display_id,
              providerConfirmed,
            });
            return null;
          }

          if (capabilityStatus === "review" || capabilityStatus === "failed") {
            setTilltapPayment({
              phase:
                capabilityStatus === "review" || providerConfirmed
                  ? "review"
                  : "failure",
              checkoutUrl: presentation.checkoutUrl,
              expiresAt: expiresAtIso,
              orderDisplayId: initialOrder.display_id,
              providerConfirmed,
            });
            return null;
          }

          await waitForTilltapPoll(controller.signal);
        }
      } catch {
        if (controller.signal.aborted) {
          return null;
        }
        // A capability request can fail exactly at expiry. It was attempted;
        // perform the required final authoritative Medusa check before review.
        try {
          const { order: refreshedOrder } = await getSdk().admin.order.retrieve(
            initialOrder.id,
            { fields: PAYMENT_ORDER_FIELDS }
          );
          if (canFinalizeOrder(refreshedOrder)) return refreshedOrder;
        } catch {
          // The outcome remains unresolved and must be reviewed.
        }
        void logger.warn(
          "Tilltap status could not be established; leaving the order for review"
        );
        setTilltapPayment({
          phase: "review",
          checkoutUrl: presentation.checkoutUrl,
          expiresAt: expiresAtIso,
          orderDisplayId: initialOrder.display_id,
          providerConfirmed,
        });
      } finally {
        if (tilltapPollAbortRef.current === controller) {
          tilltapPollAbortRef.current = null;
        }
      }

      return null;
    },
    []
  );

  // Main payment processing flow
  const handleProcessPayment =
    useCallback(async (): Promise<AdminOrder | null> => {
      if (submissionRef.current) {
        return null;
      }
      if (!draftOrderId) {
        handleErrorToast("No order prepared. Please create order first.");
        playErrorSound();
        return null;
      }
      if (!selectedPaymentMethod) {
        handleErrorToast("No payment method selected.");
        playErrorSound();
        return null;
      }
      if (!canProcessPayment) {
        playErrorSound();
        handleErrorToast("Insufficient payment amount");
        return null;
      }

      const selectedStrategy = getPaymentStrategy(selectedPaymentMethod);
      if (selectedStrategy === "asynchronous") {
        try {
          validateTilltapAttemptPrerequisites(
            draftOrder?.currency_code ?? checkoutCurrency,
            calculations.total,
            TILLTAP_TRUSTED_ORIGIN
          );
        } catch (error) {
          playErrorSound();
          handleErrorToast(
            error instanceof Error
              ? error.message
              : "Tilltap checkout prerequisites are invalid"
          );
          return null;
        }
      }

      submissionRef.current = true;
      setFrozenTotal(calculations.total);
      setIsProcessing(true);

      // Tracks whether the draft order has already been consumed by convertToOrder.
      // Used in the catch block to decide whether to close the modal on error.
      let orderConversionDone = false;

      try {
        const sdk = getSdk();

        // Step 1: Patch draft metadata — cash_paid (cash only) and register_session_id
        // (whenever a register is open). Single round-trip when either applies.
        const metadataPatch: Record<string, unknown> = {};
        if (isCashType && customerPaid) {
          metadataPatch.cash_paid = parseFloat(customerPaid) || 0;
        }
        // Stamp the rounded cash actually collected so reconciliation and the
        // receipt use the drawer figure, not the exact (un-rounded) order total.
        if (roundingActive) {
          metadataPatch.cash_collected = roundCashAmount(calculations.total);
        }
        if (registerSessionId) {
          metadataPatch.register_session_id = registerSessionId;
        }
        if (Object.keys(metadataPatch).length > 0) {
          const { draft_order } = await sdk.admin.draftOrder.retrieve(draftOrderId!);
          const currentMetadata = (draft_order.metadata || {}) as Record<string, unknown>;
          await sdk.admin.draftOrder.update(draftOrderId!, {
            metadata: { ...currentMetadata, ...metadataPatch },
          });
        }

        // Step 2: Convert draft → order
        const { order: convertedOrder } = await sdk.admin.draftOrder.convertToOrder(draftOrderId!);

        // CRITICAL: draft is now consumed. Clear the ID immediately so that no
        // subsequent error path can leave a stale draft order ID in state.
        setDraftOrderId(null);
        orderConversionDone = true;

        if (selectedStrategy === "asynchronous") {
          // Persist the consumed order before attempting provider initialization.
          // If initialization becomes ambiguous, reopening Payment recovers this
          // order and never creates a replacement payment session.
          updateMetadata({
            async_payment_order_id: convertedOrder.id,
            async_payment_session_id: undefined,
            async_payment_provider_id: selectedPaymentMethod,
          });
        }

        // Step 3: Fetch full order with expanded payment/fulfillment fields
        const { order } = await sdk.admin.order.retrieve(convertedOrder.id, {
          fields: PAYMENT_ORDER_FIELDS,
        });

        if (selectedStrategy === "asynchronous") {
          validateTilltapAttemptPrerequisites(
            order.currency_code,
            order.total,
            TILLTAP_TRUSTED_ORIGIN
          );
        }

        // Step 4: Process payment collection
        let finalOrder = order;
        try {
          const paymentResult = await processPaymentCollection(
            order,
            selectedPaymentMethod
          );

          if ("alreadySettled" in paymentResult) {
            const { order: refreshed } = await sdk.admin.order.retrieve(order.id, {
              fields: PAYMENT_ORDER_FIELDS,
            });
            finalOrder = refreshed;
          } else if (paymentResult.strategy === "asynchronous") {
            updateMetadata({
              async_payment_order_id: order.id,
              async_payment_session_id: paymentResult.session.id,
              async_payment_provider_id: selectedPaymentMethod,
            });
            const settledOrder = await monitorTilltapPayment(
              order,
              paymentResult.session
            );
            if (!settledOrder) return null;
            finalOrder = settledOrder;
          } else {
            const { order: refreshed } = await sdk.admin.order.retrieve(order.id, {
              fields: PAYMENT_ORDER_FIELDS,
            });
            finalOrder = refreshed;
            if (!canFinalizeOrder(finalOrder)) {
              throw new Error("Medusa has not captured the payment");
            }
          }
        } catch (paymentError) {
          if (selectedStrategy === "asynchronous") {
            void logger.warn(
              "Tilltap initialization outcome is unresolved; payment attempt will not be retried"
            );
            setTilltapPayment({
              phase: "review",
              orderDisplayId: order.display_id,
            });
            void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
            return null;
          }

          // Surface the real backend error so capture failures are diagnosable.
          void logger.error(`processPaymentCollection failed: ${safeStringify(paymentError)}`);
          // Re-fetch the order to check whether payment was captured on the backend
          // despite the frontend error (e.g. empty-body response).
          let paymentWasCaptured = false;
          try {
            const { order: refreshed } = await sdk.admin.order.retrieve(order.id, {
              fields: "payment_status",
            });
            paymentWasCaptured = canFinalizeOrder(refreshed);

            if (paymentWasCaptured) {
              const { order: fullRefreshed } = await sdk.admin.order.retrieve(order.id, {
                fields: PAYMENT_ORDER_FIELDS,
              });
              finalOrder = fullRefreshed;
            }
          } catch {
            // ignore — handled below by paymentWasCaptured === false
          }

          if (!paymentWasCaptured) {
            // Medusa guidance: cancelling an order is irreversible, so do NOT
            // cancel on a failed capture. Keep it as a real unpaid/outstanding
            // order — the operator captures payment later from the order's
            // Record Payment flow. Clear the cart since a real order now exists
            // (re-ringing would create a duplicate). Skip fulfillment/complete
            // so the order stays not_fulfilled until it is paid.
            clearItems();
            setDraftOrderId(null);
            resetCashState();
            setPaymentMethod(undefined);
            void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
            playErrorSound();
            toast.warning(
              t("checkout.order_saved_unpaid", { displayId: order.display_id })
            );
            return order;
          }
        }

        // Every fulfillment, completion, receipt, success sound, drawer action,
        // and cart cleanup is inside this Medusa-authoritative payment gate.
        if (
          !(await finalizePaidOrder(finalOrder, selectedPaymentMethod))
        ) {
          if (selectedStrategy === "asynchronous") {
            setTilltapPayment({
              phase: "review",
              orderDisplayId: finalOrder.display_id,
            });
            return null;
          }
          throw new Error("Medusa has not captured the payment");
        }
        return finalOrder;

      } catch (error) {
        if (orderConversionDone && selectedStrategy === "asynchronous") {
          setTilltapPayment((current) =>
            current ?? { phase: "review" }
          );
          void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
          return null;
        }

        playErrorSound();
        handleErrorToast(
          error instanceof Error ? error.message : "Failed to create order. Please try again."
        );

        // If the draft was already converted when the error occurred, close the modal
        // so the user can start a fresh checkout. Cart items are preserved.
        if (orderConversionDone) {
          onClose?.();
        }

        return null;
      } finally {
        submissionRef.current = false;
        setIsProcessing(false);
      }
    }, [
      draftOrderId,
      canProcessPayment,
      isCashType,
      roundingActive,
      selectedPaymentMethod,
      draftOrder,
      checkoutCurrency,
      customerPaid,
      calculations.total,
      processPaymentCollection,
      monitorTilltapPayment,
      finalizePaidOrder,
      clearItems,
      resetCashState,
      setPaymentMethod,
      setDraftOrderId,
      updateMetadata,
      registerSessionId,
      onClose,
    ]);

  useEffect(() => {
    if (
      !isOpen ||
      draftOrderId ||
      !pendingAsyncOrderId ||
      pendingAsyncProviderId !== TILLTAP_PROVIDER_ID ||
      submissionRef.current
    ) {
      return;
    }

    let cancelled = false;
    let finalizingPaidOrder = false;
    submissionRef.current = true;
    setIsProcessing(true);

    queueMicrotask(() => {
      void (async () => {
        try {
          const sdk = getSdk();
          const { order } = await sdk.admin.order.retrieve(
            pendingAsyncOrderId,
            { fields: PAYMENT_ORDER_FIELDS }
          );
          if (cancelled) return;

          setFrozenTotal(order.total || 0);
          let settledOrder: AdminOrder | null = canFinalizeOrder(order)
            ? order
            : null;

          if (!settledOrder) {
            const session = findTilltapPaymentSession(
              order,
              pendingAsyncSessionId
            );
            if (!session) {
              setTilltapPayment({
                phase: "review",
                orderDisplayId: order.display_id,
              });
              return;
            }
            settledOrder = await monitorTilltapPayment(order, session);
          }

          if (settledOrder) {
            finalizingPaidOrder = true;
            if (
              await finalizePaidOrder(
                settledOrder,
                pendingAsyncProviderId
              )
            ) {
              onClose?.();
            }
          }
        } catch {
          if (!cancelled) {
            setTilltapPayment({ phase: "review" });
          }
        } finally {
          if (!cancelled) setIsProcessing(false);
          submissionRef.current = false;
        }
      })();
    });

    return () => {
      if (!finalizingPaidOrder) {
        cancelled = true;
        tilltapPollAbortRef.current?.abort();
        submissionRef.current = false;
      }
    };
  }, [
    isOpen,
    draftOrderId,
    pendingAsyncOrderId,
    pendingAsyncSessionId,
    pendingAsyncProviderId,
    monitorTilltapPayment,
    finalizePaidOrder,
    onClose,
  ]);

  // Pay later: fulfill but skip capture — the uncaptured order IS the "outstanding" signal,
  // so never cancel on failure and never complete.
  const handleDeliverPayLater =
    useCallback(async (): Promise<AdminOrder | null> => {
      if (submissionRef.current) {
        return null;
      }
      if (!draftOrderId) {
        handleErrorToast("No order prepared. Please create order first.");
        playErrorSound();
        return null;
      }

      submissionRef.current = true;
      setFrozenTotal(calculations.total);
      setIsProcessing(true);

      // Tracks whether convertToOrder has consumed the draft (controls modal close on error).
      let orderConversionDone = false;

      try {
        const sdk = getSdk();

        // Step 1: Flag the draft as pay-later so the order, receipt and orders
        // list can detect it. Mirrors the cash_paid metadata patch above.
        const { draft_order } =
          await sdk.admin.draftOrder.retrieve(draftOrderId);
        const currentMetadata = (draft_order.metadata || {}) as Record<
          string,
          unknown
        >;
        await sdk.admin.draftOrder.update(draftOrderId, {
          metadata: {
            ...currentMetadata,
            pay_later: true,
            ...(registerSessionId ? { register_session_id: registerSessionId } : {}),
          },
        });

        // Step 2: Convert draft → order, then clear the id immediately.
        const { order: convertedOrder } =
          await sdk.admin.draftOrder.convertToOrder(draftOrderId);
        setDraftOrderId(null);
        orderConversionDone = true;

        // Step 3: Fetch full order with expanded fields.
        const { order } = await sdk.admin.order.retrieve(convertedOrder.id, {
          fields:
            "*payment_collections,*payment_collections.payments,*summary,*fulfillments,*items,*customer,*sales_channel,*shipping_methods",
        });

        // Step 4: Deliver now (decrements inventory). Skip payment capture and
        // order.complete; do NOT cancel on any failure.
        await processFulfillment(order);

        // Step 5: Clean up and finalize with an "outstanding" toast.
        await cleanupAfterOrder(order, selectedPaymentMethod, {
          successMessage: `Order #${order.display_id} delivered — payment outstanding`,
        });
        return order;
      } catch (error) {
        playErrorSound();
        handleErrorToast(
          error instanceof Error
            ? error.message
            : "Failed to create order. Please try again."
        );

        // Never cancel a pay-later order. If the draft was already converted,
        // close so the cashier can continue; the order is in the orders list.
        if (orderConversionDone) {
          onClose?.();
        }

        return null;
      } finally {
        submissionRef.current = false;
        setIsProcessing(false);
      }
    }, [
      draftOrderId,
      selectedPaymentMethod,
      calculations.total,
      processFulfillment,
      cleanupAfterOrder,
      setDraftOrderId,
      registerSessionId,
      onClose,
    ]);

  // Handle modal close
  const handleClose = useCallback(() => {
    if (isProcessing) return;
    tilltapPollAbortRef.current?.abort();
    resetCashState();
    setFrozenTotal(null);
    setTilltapPayment(null);
    setShowConfirmation(false);
    setShowPayLaterConfirmation(false);
    onClose?.();
  }, [isProcessing, resetCashState, onClose]);

  // Open the pay-later confirmation dialog.
  const handleDeliverPayLaterClick = useCallback(() => {
    setShowPayLaterConfirmation(true);
  }, []);

  // Confirm pay-later from the confirmation dialog.
  const handleConfirmPayLater = useCallback(async (): Promise<void> => {
    const result = await handleDeliverPayLater();
    if (result) {
      setShowPayLaterConfirmation(false);
      handleClose();
    }
  }, [handleDeliverPayLater, handleClose]);

  // Handle complete button click
  const handleCompleteClick = useCallback(() => {
    if (isTilltapPayment) {
      void handleProcessPayment().then((result) => {
        if (result) handleClose();
      });
      return;
    }
    const isCardPayment = !isCashType;

    if (isCardPayment) {
      setShowConfirmation(true);
    } else {
      handleProcessPayment().then((result) => {
        if (result) {
          handleClose();
        }
      });
    }
  }, [isTilltapPayment, isCashType, handleProcessPayment, handleClose]);

  // Handle complete payment with modal close (legacy, kept for backwards compatibility)
  const handleCompletePayment = useCallback(async (): Promise<void> => {
    const result = await handleProcessPayment();
    if (result) {
      handleClose();
    }
  }, [handleProcessPayment, handleClose]);

  // Handle confirmation modal confirm
  const handleConfirmPayment = useCallback(async (): Promise<void> => {
    const result = await handleProcessPayment();
    // Always dismiss the confirmation overlay — on failure handleProcessPayment
    // returns null and closes the parent modal via onClose, which would otherwise
    // leave this sibling dialog orphaned on screen.
    setShowConfirmation(false);
    if (result) {
      handleClose();
    }
  }, [handleProcessPayment, handleClose]);

  return {
    // State
    selectedPaymentMethod,
    customerPaid,
    isProcessing,
    draftOrder,
    showConfirmation,
    showPayLaterConfirmation,
    tilltapPayment,

    // Calculations
    ...calculations,
    // Keep the confirmed amount visible during submission instead of 0.00.
    total: displayTotal,
    // Cash rounding: amount to collect (rounded) vs the exact total.
    cashDue,
    cashRoundingActive: roundingActive,

    // Computed values
    cartItemsCount: calculations.itemCount,
    canProcessPayment,
    change,
    quickAmounts,
    items,
    paymentMethodInfo,
    isCashPayment: isCashType,
    isTilltapPayment,

    // Functions
    handleCashValueChange,
    handleProcessPayment,
    handleClose,
    handleQuickAmount,
    handleClearBillCounts,
    handleExactAmount,
    handleCompletePayment,
    handleCompleteClick,
    handleConfirmPayment,
    setShowConfirmation,
    handleDeliverPayLater,
    handleDeliverPayLaterClick,
    handleConfirmPayLater,
    setShowPayLaterConfirmation,
    fetchDraftOrder,
    billCounts,
  };
};

export { usePaymentModal };
