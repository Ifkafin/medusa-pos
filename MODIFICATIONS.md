# Tilltap Modifications

This fork is based on Medusa POS v0.4.1 (`50f1dea`) and preserves the
project's Apache License 2.0 in `LICENSE`.

Copyright 2026 Tilltap. Tilltap owns the modifications listed below and
licenses them under the Apache License 2.0. No ownership claim is made over
the original Medusa POS work or other contributors' work.

## Changed Files

- `MODIFICATIONS.md`: records Tilltap ownership and the modified-file list.
- `.env.example`: documents the required trusted Tilltap origin.
- `.github/dependabot.yml`: removes updater/process dependencies that this fork does not ship.
- `package.json`: assigns the Tilltap package identity/version, pins Medusa SDK packages, adds QR dependencies, and removes updater/process plugins.
- `README.md`: records attribution, the Medusa 2.18 contract, captured-only release rule, HTTP-scope tradeoff, and controlled distribution policy.
- `yarn.lock`: locks the pinned SDK and QR dependency graph.
- `vite.config.ts`: uses the fork version and rejects production builds without a valid HTTPS Tilltap origin.
- `src/App.tsx`: removes the inherited update check.
- `src/components/base/backdrop/index.tsx`: uses the Tilltap product name.
- `src/components/checkout/hooks.ts`: reopens unresolved Tilltap orders instead of creating another checkout.
- `src/components/checkout/payment-dialog/hooks.ts`: validates prerequisites, manages one durable Tilltap attempt, recovers server sessions, separately captures authorization, performs final expiry checks, and gates paid-order effects.
- `src/components/checkout/payment-dialog/index.tsx`: selects the Tilltap payment presentation.
- `src/components/checkout/payment-dialog/tilltap-payment/index.tsx`: displays pilot-safe QR/link, amount, expiry, pending, review, and failure states.
- `src/components/order/hooks.ts`: gates fulfillment, pickup, and shipment UI and mutations for Tilltap orders.
- `src/components/order/index.tsx`: passes the release gate to order items.
- `src/components/order/items/index.tsx`: hides fulfillment UI until a Tilltap payment is captured.
- `src/components/order/fulfillment-dialog/hooks.ts`: re-reads Medusa before a Tilltap fulfillment mutation.
- `src/components/order/record-payment-dialog/hooks.ts`: blocks every Record Payment provider when any Tilltap attempt exists and requires capture for other providers.
- `src/hooks/order/useOrderProcessing.ts`: persists the server attempt marker, gates release, and propagates fulfillment failure.
- `src/i18n/locales/en.json`: provides pilot-safe fallback labels for Tilltap states and recovery.
- `src/types/utils.ts`: persists narrowly scoped async-payment recovery identifiers.
- `src/vite-env.d.ts`: types the trusted Tilltap origin build setting.
- `src/utils/pos/payment/strategies.ts`: defines session detection, captured-only finalization/release, durable one-attempt recovery, and Record Payment safety predicates.
- `src/utils/pos/payment/strategies.test.ts`: tests session detection, no replacement attempts, capture failure, Record Payment blocking, authoritative release checks, and non-Tilltap pay-later behavior.
- `src/utils/pos/payment/tilltap.ts`: validates origin, KES, amount, session presentation, and status capabilities with Tauri HTTP.
- `src/utils/pos/payment/tilltap.test.ts`: tests early prerequisites, URL/token trust, session validation, status correlation, simulation handling, and receipt-gated confirmation.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, and `src-tauri/src/appimage_integrate.rs`: assign the Tilltap desktop identity/version and remove inherited updater/process plugins.
- `src-tauri/capabilities/default.json` and `src-tauri/build.rs`: remove updater/process permissions and keep HTTP fetch scoped to configured HTTPS origins plus development `localhost`.
- `src/hooks/update/useUpdateCheck.ts`: removed with the inherited Nari updater.

The fork is versioned independently as Tilltap POS 0.1.0. The inherited Nari
updater endpoint and key are intentionally not trusted or used by this fork.
