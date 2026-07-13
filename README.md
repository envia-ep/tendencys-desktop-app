# Tendencys Desktop App

Multi-service desktop shell for Tendencys platforms. Switch between Envia Shipping, Envia Cargo, Envia Fulfillment, Envia Returns, Ecart Pay, Ecart Banking, Ecart API, and Tendencys Partners from a single app with shared SSO via Accounts.

Inspired by the Slack desktop layout: a collapsible service rail on the left and, to the right, each product rendered as its own **native OS webview** (not an iframe) that overlays the content area.

## How It Works (Plain-English Overview)

1. **You sign in once** to the shell (Accounts login), either interactively or silently via a device key saved from a previous session.
2. **Every product opens in its own native webview**, positioned to the right of the service rail. Switching services just shows/hides the right native webview — it doesn't reload the page.
3. **All product webviews share one cookie jar** with the login webview, so once you're signed into the shell, every product silently signs you in too (Accounts `/login-sites` SSO) — no repeated logins.
4. **Products pre-warm in the background** right after login, so clicking a service in the rail is instant instead of waiting for a fresh page load.
5. **Back/forward/refresh** in the top rail walk a single shared history across every product you've visited in the session — like browser tabs, but for the whole shell.
6. **The app updates itself** — it checks a hosted manifest on launch and offers a one-click install + relaunch when a new version is available.

The rest of this document explains each of these pieces in more detail.

## Tech Stack

- **Tauri 2** — cross-platform desktop shell (macOS + Windows), using the experimental **multiwebview** API
- **React 19 + TypeScript + Vite**
- **Tailwind CSS + Radix UI**
- **Zustand** — state management (`auth-store`, `service-store`)
- **Tendencys SSO** via Accounts (`/login`, `/login-sites`, device keys)

## Architecture

```
┌────┬──────────────────────────────────────────────────────┐
│Rail│                                                      │
│ /  │           Native product webview                    │
│Menu│     (svc-<serviceId>, shares cookie jar with auth)   │
│    │                                                      │
│icon│     One webview per product, shown/hidden on         │
│ or │     rail click — never destroyed, so state and       │
│icon│     in-app navigation survive switching services     │
│+   │                                                      │
│label│                                                     │
└────┴──────────────────────────────────────────────────────┘
```

- The **shell chrome** (service rail) is a normal React view rendered by the main Tauri webview.
- Every **product** and the **Accounts login screen** are separate native child webviews (Tauri `unstable` multiwebview), positioned and resized to fill everything right of the rail (`src-tauri/src/webview_manager.rs`).
- Product webviews are **never destroyed** when you switch services — they're hidden/shown, so navigation state, scroll position, and in-flight requests are preserved.
- A new product webview stays hidden until its first page finishes loading (load-gating), so switching services shows the shell's own loading/error overlay instead of a flash of blank native content.
- The rail's width is collapsible (icon-only vs. icon+label); the native webview's left inset is kept in sync in real time (`set_content_left_inset`) so it's never covered by or leaves a gap next to the rail.

## SSO / Authentication

Three layers, all backed by Accounts:

### 1. Shell login (native, in-app)

- The rail's "Sign in" flow opens Accounts `/login` in a dedicated native `auth` webview (left-inset so a recovery rail stays visible if it hangs).
- On success, Accounts redirects to `tendencys://authentication?authorization=<jwt>`. The Rust side intercepts that navigation (never leaves the app or touches the system browser) and emits the JWT back to the frontend.
- The shell exchanges that handoff JWT for a session token via Accounts' authorization-validation API and persists it (`src/lib/token-store.ts`).

### 2. Device-key silent re-auth

- Right after a successful interactive login, the shell generates an **Ed25519 keypair** (`src-tauri/src/device_key.rs`), stores the private key in the OS keyring (Keychain / Credential Manager), and registers the public key with Accounts as a "device key" login method for that account.
- On every later launch, the shell tries `login_with_device_key` first: it fetches a challenge from Accounts, signs it with the stored private key, and gets back a handoff JWT — **no login form, no browser** — before ever showing the interactive login screen.
- If Accounts requires an extra step (terms acceptance, phone verification), the shell opens that step in the system browser and still receives the JWT back via the `tendencys://` deep link.
- Signing out deletes the device key (keyring + local metadata), so silent re-auth stops immediately on that device.

### 3. Per-product SSO (shared cookie jar)

- Every product webview and the `auth` webview are pinned to the **same WKWebView data store** (`SHARED_DATA_STORE` in `webview_manager.rs`), so Accounts' `_atid` session cookie set during shell login is visible to every product.
- When a product is opened for the first time (or after a failed SSO attempt), the shell first navigates it to Accounts `/login-sites?site_id=<product>&redirect_url=<callback>` — this reads the shared `_atid` and redirects into the product already authenticated, landing on that product's `/authentication` (or similar) callback route.
- On cold app restart, the OS session cookie doesn't survive process exit, so the shell explicitly re-writes `_atid` into the shared cookie jar from the stored shell JWT (`seed_accounts_session`) before doing any product SSO.
- If a product's silent SSO ever fails (missing/expired `_atid`, or the product's own session died), the webview bounces to a login form and the shell surfaces an `auth-required` event so the user can retry via the rail's "Sign in" action.
- Some products use a legacy **server-entry** mode instead (they build their own Accounts redirect from a `/login` route) rather than `/login-sites`; see `authMode` in `src/config/services.ts`.
- "Open in browser" is always available and uses the real system browser with the same `/login-sites` SSO handoff — useful when a product needs full browser features the embedded webview doesn't support.

### Pre-warming

- ~2.5 seconds after a fresh login (once the shared cookie has settled), the shell walks every other configured product and creates its webview **hidden**, running its SSO handoff in the background (`prewarm_service`). By the time the user clicks a different service in the rail, it's usually already loaded.
- Products marked `ssoReady: false` (their callback route doesn't exist yet) are skipped from pre-warm and from silent SSO entirely — they still work, just without automatic sign-in.

## Navigation

- A single shared **shell history stack** (`src/lib/shell-history.ts`) records every meaningful navigation across all products in the session — SPA route changes are captured via a `pushState`/`replaceState` hook injected into every product webview.
- Auth "noise" (Accounts hosts, `/login`, `/login-sites`, the `?authorization=` handoff) is filtered out of history so back/forward never lands the user on an SSO redirect page.
- Back/forward can jump between different products, not just pages within one product — switching the active service and restoring its URL happens together.
- Each product's last-visited path is persisted per session (`useServiceStore`), so returning to a service you already visited resumes where you left off instead of the homepage.

## Auto-Updater

- On launch, the shell checks the GitHub Releases `latest.json` manifest via the Tauri updater plugin (`src/lib/updater.ts`), served from `https://github.com/envia-ep/tendencys-desktop-app/releases/latest/download/latest.json`.
- If a newer version is available, it is **downloaded and installed silently** — no user action. The shell does not force a relaunch (it holds live product webview sessions); the update applies on the next natural restart, and a non-blocking `UpdateBanner` offers an optional "restart now".
- Release builds are signed (`TAURI_SIGNING_PRIVATE_KEY`) and produce the `latest.json` manifest + `.sig` signatures alongside the installers — all published automatically by CI (see [Releasing](#releasing)).

## Services

Configured in `src/config/services.ts`, override any URL/site ID via `.env.local`:

| Service | Default URL | Auth mode | Notes |
|---------|-------------|-----------|-------|
| Envia Shipping | `https://ship.envia.com` | `login-sites` | Callback is `/authentication`. Use `ship.envia.com` (or `ship-stage.envia.com`), not `shipping.envia.com` — that alias 404s the callback and isn't whitelisted. |
| Envia Cargo | `https://cargo.envia.com` | `login-sites` | |
| Envia Fulfillment | `https://fulfillment.envia.com` | `login-sites` | |
| Envia Returns | `https://returns.envia.com` | `login-sites` | |
| Ecart Pay | `https://app.ecart.com` | `login-sites` | URL must equal live product `HOSTNAME` (JWT aud vs Referer). Do not use marketing `ecartpay.com` — its HOSTNAME is `pay.ecart.com`. |
| Ecart Banking | `https://bank.ecart.com` | `login-sites` | callback is `/api/auth/callback` |
| Ecart API | `https://app.ecartapi.com` | `login-sites` | URL must equal the dashboard's `API_BASE` (JWT aud vs Referer). Do not use marketing `ecartapi.com` — it 404s. Callback is `/authentication`. |
| Tendencys Partners | `https://partners.tendencys.com` | `login-sites` | |

**Auth modes** (`ServiceAuthMode` in `src/config/services.ts`):
- `login-sites` — Accounts `/login-sites` handoff using the shared session (current default for all products with a working callback route).
- `server-entry` — legacy: the product's own server builds the Accounts redirect from a `/login` route.
- `unsupported` — no Accounts SSO integration yet; the shell just opens the product URL and lets it handle its own login.

Adding a service that isn't SSO-ready yet: set `ssoReady: false` so the shell skips pre-warm/silent SSO for it and only opens the plain URL.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install)
- Platform dependencies for [Tauri](https://v2.tauri.app/start/prerequisites/)

## Development

```bash
npm install
npm run tauri:dev
```

**Deep link / login:** quit any installed **Tendencys.app** (release build) before `tauri:dev`. Only one process should own the `tendencys://` scheme — otherwise Accounts "Open app" can spawn a second Welcome window that never receives the auth token. Keep a single `tauri:dev` instance.

For frontend-only development (browser, no Tauri APIs — native webviews, device keys, and the updater are all no-ops outside Tauri):

```bash
npm run dev
```

Open the multi-root workspace from the parent folder:

```bash
# /Users/marcelo/Documents/GitHub/tendencys-desktop.code-workspace
```

## Build

```bash
npm run tauri:build
```

Produces installers for macOS (`.dmg`/`.app`), Windows (`.msi`/`.exe`), and Linux (`.deb`/`.AppImage`), plus the updater archives + `.sig` signatures (enabled by `createUpdaterArtifacts` in `src-tauri/tauri.conf.json`).

For a local signed build, export the signing key first:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/tendencys-desktop.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<private-key-password>" # optional; current key has no password
```

The updater private key lives at `~/.tauri/tendencys-desktop.key`. Never commit it; store it only in local key storage and CI secrets (`*.key` is gitignored). The matching public key is already configured in `src-tauri/tauri.conf.json`.

## Releasing

Releases are fully automated by [`.github/workflows/release-desktop.yml`](.github/workflows/release-desktop.yml). Pushing a `v*` tag builds every platform, code-signs + notarizes, and publishes a **GitHub Release** on `envia-ep/tendencys-desktop-app` containing the installers, `latest.json`, and signatures. Installed apps then auto-update from that release.

```bash
# 1. Bump the version in all three files (package.json, tauri.conf.json, Cargo.toml)
npm run release:version 0.1.1

# 2. Commit, tag, and push — the tag triggers the release workflow
git commit -am "chore: release v0.1.1"
git tag v0.1.1
git push --follow-tags
```

Prerequisites (one-time):

- The repo must be **public** so `latest.json` and the release assets are reachable without auth (used by both the in-app updater and the browser download page).
- Configure the GitHub Actions secrets listed below.

### Browser download page

`docs/index.html` is a self-contained static page (platform detection + direct links to the latest release assets via the public GitHub API — no backend). Enable **GitHub Pages** for this repo with source "Deploy from a branch" → `master` / `/docs`, then share that Pages URL for first-time installs.

### Required GitHub Actions secrets

Set under Settings → Secrets and variables → Actions. `GITHUB_TOKEN` is provided automatically — do not create it.

| Secret | Purpose | Where to get it |
|--------|---------|-----------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Sign updater artifacts | `cat ~/.tauri/tendencys-desktop.key` (must match the pubkey in `tauri.conf.json`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Key password | Empty for the current key |
| `APPLE_CERTIFICATE` | macOS code signing | base64 of a "Developer ID Application" `.p12` (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password | Set when exporting the cert from Keychain |
| `KEYCHAIN_PASSWORD` | Temp CI keychain | Any strong string you choose |
| `APPLE_SIGNING_IDENTITY` | Signing identity | `security find-identity -v -p codesigning` (e.g. `Developer ID Application: … (TEAMID)`) |
| `APPLE_ID` | Notarization account | Apple Developer email |
| `APPLE_PASSWORD` | Notarization | App-specific password (appleid.apple.com → App-Specific Passwords) |
| `APPLE_TEAM_ID` | Notarization | Apple Developer → Membership |
| `VITE_TENDENCYS_BASE_URL` | Prod Accounts URL | `https://accounts.envia.com` (without it the build defaults to **sandbox**) |
| `VITE_SHELL_SITE_ID` | Prod Desktop site id | `ecartdb.sites` document `_id` |
| `VITE_*_URL` / `VITE_*_SITE_ID` | Per-service overrides | Optional — unset falls back to the in-code prod defaults in `src/config/services.ts` |

Windows code signing (to avoid the SmartScreen "unknown publisher" prompt) is optional and not yet wired — it needs an OV/EV cert from a CA.

## Environment Variables

Copy `.env.example` to `.env.local`:

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_TENDENCYS_BASE_URL` | Accounts SSO base URL | `https://accounts-sandbox.envia.com` |
| `VITE_SHELL_SITE_ID` | Tendencys Desktop site ID | must match sandbox Accounts `sites` doc |
| `VITE_ENVIA_SHIPPING_URL` / `VITE_ENVIA_SHIPPING_SITE_ID` | Envia Shipping URL + Accounts site ID | see `.env.example` |
| `VITE_ENVIA_CARGO_URL` / `VITE_ENVIA_CARGO_SITE_ID` | Envia Cargo URL + Accounts site ID | see `.env.example` |
| `VITE_ENVIA_FULFILLMENT_URL` / `VITE_ENVIA_FULFILLMENT_SITE_ID` | Envia Fulfillment URL + Accounts site ID | see `.env.example` |
| `VITE_ENVIA_RETURNS_URL` / `VITE_ENVIA_RETURNS_SITE_ID` | Envia Returns URL + Accounts site ID | see `.env.example` |
| `VITE_ECART_PAY_URL` / `VITE_ECART_PAY_SITE_ID` | Ecart Pay URL + Accounts site ID | see `.env.example` |
| `VITE_ECART_BANKING_URL` / `VITE_ECART_BANKING_SITE_ID` | Ecart Banking URL + Accounts site ID | see `.env.example` |
| `VITE_ECART_API_URL` / `VITE_ECART_API_SITE_ID` | Ecart API URL + Accounts site ID | see `.env.example` |
| `VITE_TENDENCYS_PARTNERS_URL` / `VITE_TENDENCYS_PARTNERS_SITE_ID` | Tendencys Partners URL + Accounts site ID | see `.env.example` |

For local Accounts against `accountsdb`, set `VITE_TENDENCYS_BASE_URL=http://localhost:8080`.

Sandbox Desktop site (Accounts `sites` on sandbox):

- Redirects required: `tendencys://authentication`, `http://localhost:1420/authentication`
- Set `VITE_SHELL_SITE_ID` to that document's `_id` / `site_id`
- Each product's sandbox callback (`/authentication` or its equivalent) must be whitelisted on that product's Accounts site doc

Production still needs the same Desktop site mirrored in `ecartdb.sites` before shipping against `accounts.envia.com`.

## License

Proprietary — Tendencys / Envia
