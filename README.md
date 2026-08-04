<p align="center">
  <img src="public/logo.svg" alt="Tilltap POS Logo" width="220" />
</p>

# Tilltap POS

Tilltap's controlled-pilot POS app for Medusa, built with React + Tauri 2.

This is a fork of Medusa POS v0.4.1 by Nari Solutions and contributors. The
original work and this fork's modifications remain licensed under Apache
License 2.0; see `LICENSE` and `MODIFICATIONS.md` for attribution and scope.

> This project is under active development. APIs, behavior, and UX may change.

Tilltap POS is independent and is not officially affiliated with Medusa.

<p align="center">
  <img src=".github/assets/dark-checkout.png" alt="Tilltap POS Checkout" width="900" />
</p>

## Compatibility

| Capability | Vanilla Medusa (`admin.product.list`) | Medusa + POS plugin/custom `/pos` endpoints |
|---|---|---|
| Add product to cart | ✅ | ✅ |
| Reliable inventory check before adding | ❌ (variant `inventory_quantity` may be missing) | ✅ |
| Context-aware computed variant price | ❌ (raw prices array) | ✅ |
| Inventory kit availability checks | ❌ | ✅ |

## Medusa Version Tested

- Frontend SDK/types in this project: `@medusajs/js-sdk@2.18.0`, `@medusajs/types@2.18.0`
- Tilltap async checkout requires the Medusa 2.18 order payment-session authorization API.

If your backend is older/newer, behavior can differ (especially pricing and inventory fields).

## Tilltap Runtime Contract

- `VITE_TILLTAP_ORIGIN` must be the exact trusted Tilltap origin. Production requires HTTPS; localhost HTTP is accepted for development.
- `pp_tilltap_default` payment-session data must contain `checkout_url`, `status_url`, integer epoch-millisecond `expires_at`, `checkout_id`, and boolean `simulation`.
- The checkout URL must be `/checkout/{token}` and the status URL must be `/api/checkouts/{same-token}/status` on the trusted origin. The current token is a 43-character base64url capability.
- Status responses must match `checkout_id`, expiry, and simulation mode. Only real `PAID` with a nonempty receipt triggers Medusa payment-session reauthorization.
- Before provider initialization, the POS writes an attempt marker to Medusa order metadata. The payment session attached to the server-side payment collection is the authoritative recovery journal; local cart metadata is only a shortcut.
- Tilltap status, Medusa authorization, and Medusa capture are reconciliation evidence only in this fixture/sandbox pilot. Automatic fulfillment, completion, paid receipts, drawer actions, success UX, and cart cleanup remain disabled because signed outbox evidence and merchant re-verification are not implemented.
- Same-terminal recovery can use the local order pointer, but the server-side order marker and payment session remain the journal. Cross-terminal server-journal recovery UI is not implemented and is a blocker for leaving the pilot; do not add a local-cart overwrite recovery shortcut.

## Quick Start

### Prerequisites

- Node.js 20.19+, 22.13+, or 24+ (see `engines` in `package.json`)
- Rust (stable)
- Yarn
- Tauri prerequisites for your OS: [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)

### Install

```bash
yarn install
```

### Run

```bash
# Browser (UI-only)
yarn dev

# Desktop (recommended)
yarn tauri dev
```

Important: full app flow requires Tauri runtime. This project stores backend configuration in
Tauri storage/config files on first setup, so `yarn dev` is only for limited UI work. Use
`yarn tauri dev` for real usage and testing.

### Build / Lint

```bash
VITE_TILLTAP_ORIGIN=https://pay.example.com yarn build
yarn lint
yarn typecheck
```

Production builds fail if `VITE_TILLTAP_ORIGIN` is absent, malformed, or not
HTTPS. Development accepts `http://localhost:<port>` only.

## Core Features

- Checkout UI with barcode scanning, cart, payment dialog
- Draft order creation and updates through Medusa Admin APIs
- Receipt printing (network / USB / Bluetooth), cash drawer trigger
- Order list and order detail views
- Settings for API/store, printers, branding, preferences
- Multi-store backend configuration

## Environment

Use `.env`, `.env.staging`, or `.env.production`:

```env
VITE_BACKEND_URL=https://your-medusa-instance.example.com/
VITE_TILLTAP_ORIGIN=https://pay.example.com
```

The backend URL can also be configured at runtime via Store Setup.

### Desktop HTTP Scope

Medusa endpoints are runtime-configurable, so the default release capability
must allow arbitrary HTTPS origins (`https://**`). This is broader than a fixed
deployment allowlist and means a compromised renderer could make requests to
other HTTPS hosts. Release packaging should set `TAURI_HTTP_ALLOWLIST` to the
known Medusa and Tilltap origins when deployment configuration is fixed. Local
HTTP is limited to `localhost` in development; `127.0.0.1` and `[::1]` are not
accepted by the Tilltap origin validator.

## Medusa API Support Notes

| Topic | Support in Medusa (current observed behavior) |
|---|---|
| Draft order discount totals from Sale Price Lists (`original_amount - calculated_amount`) | ❌ Not automatically reflected in draft-order discount totals unless Promotions are applied separately |
| Creating admin payment collections with `payments[]`, `provider_id`, `provider_data` in one call | ❌ Not supported by current `AdminCreatePaymentCollection` typing/API shape |

These are tracked as known limitations for now and can affect POS discount/payment reporting workflows.

## Distribution

The inherited Nari auto-updater is disabled: its endpoint, signing key,
frontend update check, updater artifacts, permissions, and plugin registration
are not part of this fork. Pilot builds must be distributed through Tilltap's
controlled release process.

### Code signing notice

**Windows** — The MSI installer is **not code-signed** with a trusted certificate. Windows SmartScreen will show an "Unknown Publisher" warning on first install. You can bypass it by clicking *More info* → *Run anyway*.

**macOS** — The DMG is ad-hoc signed but **not notarized** with an Apple Developer ID. macOS Gatekeeper will block it by default. To open it, right-click the app → *Open*, or run `xattr -cr /Applications/Tilltap\ POS.app` after dragging it to Applications.

**Linux** — No code signing is required. The AppImage runs directly after making it executable (`chmod +x`).

## Upstream Components

The fork retains upstream cash reconciliation and optional integration with the
[`@narisolutions/medusa-plugin-pos`](https://github.com/narisolutions/medusa-plugins)
package. Those components remain work of their respective upstream authors.

## Useful Links

- [Upstream Medusa POS Plugin](https://github.com/narisolutions/medusa-plugins) — `@narisolutions/medusa-plugin-pos` on npm
- [Contributing](CONTRIBUTING.md)
- [Discussions](https://github.com/narisolutions/medusa-pos/discussions)
- [Issues](https://github.com/narisolutions/medusa-pos/issues)
- [Security](SECURITY.md)
- [License](LICENSE)
