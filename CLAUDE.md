# The Cite Shop Client Sync — Zotero Plugin

## Project Overview

This is a Zotero plugin that enables users to install and manage custom citation styles directly within Zotero. The plugin authenticates users via license keys, validates their credentials, and provides an interface for installing and updating purchased custom styles.

**Repository:** https://github.com/TheCiteShop/theciteshop-client-sync
**Plugin ID:** `theciteshop-sync@theciteshop.com`
**License:** AGPL-3.0-or-later
**Version:** see `package.json` (currently 0.0.1)

## Release Process Notes

- When the user asks to "release" or "prepare a release", always:
  1. Add a new version entry to the **Changelog** section in `README.md`
  2. Bump the version in `package.json`
  3. Run `npm run release`

## Key Features

- **License Validation**: Users enter email and license key; the plugin validates against a backend service
- **Custom Styles Installation**: Browse and install purchased citation styles directly in Zotero
- **Update Management**: Check for and install style updates
- **Zotero Integration**: Fully integrated preferences pane in Zotero settings
- **Multi-device Support**: A licence is tied to a Zotero account and works on unlimited devices — there are no activation slots
- **Subscription Enforcement**: Styles are removed when a subscription lapses (see below)

## Technology Stack

- **Language**: TypeScript
- **Framework**: [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) v5.1.0-beta.13
- **Build Tool**: [zotero-plugin-scaffold](https://www.npmjs.com/package/zotero-plugin-scaffold)
- **Testing**: Mocha + Chai
- **Code Quality**: ESLint + Prettier
- **Target**: Zotero 7+ (supports Firefox 115+)
- **Package Manager**: npm (Node.js 18+)

## Project Structure

```
├── src/
│   ├── addon.ts                 # Main addon class & data management
│   ├── index.ts                 # Plugin initialization entry point
│   ├── hooks.ts                 # Lifecycle hooks (startup, shutdown, prefs events)
│   ├── modules/
│   │   ├── license.ts           # Validation, outcome taxonomy, tolerance clock
│   │   ├── styleLedger.ts       # Ownership record + uninstall routine
│   │   ├── enforcement.ts       # Policy, startup check, daily timer, notification
│   │   └── customStyles.ts      # Style installation & update logic
│   └── utils/
│       ├── ztoolkit.ts          # Zotero toolkit wrapper
│       ├── locale.ts            # i18n localization strings
│       ├── logger.ts            # In-memory log ring (Copy Logs button)
│       ├── theme.ts             # Light/dark colour palette
│       └── window.ts            # Window management utilities
│
├── addon/
│   ├── manifest.json            # Plugin manifest (templated)
│   ├── content/
│   │   ├── preferences.xhtml    # Preferences pane UI
│   │   ├── icons/               # Plugin icons
│   │   └── styles/              # UI stylesheets
│   └── locale/                  # i18n translation files
│
├── test/
│   ├── startup.test.ts          # Smoke test
│   ├── enforcement.test.ts      # classifyResponse + decideAction tables
│   └── ledger.test.ts           # Ledger round-trip, corruption, removal
│
├── zotero-plugin.config.ts      # Build configuration
├── package.json                 # Dependencies & config
├── tsconfig.json                # TypeScript configuration
└── eslint.config.mjs            # ESLint configuration
```

## Core Modules

### License Module (`src/modules/license.ts`)

Handles license validation, credential storage, and Zotero account integration.

**Key Functions:**

- `classifyResponse(status, body)` — **Pure**, exported, unit-tested. Maps an HTTP response to a `LicenseOutcome`. Every decision that can delete a customer's files runs through here.
- `validateAuthoritative(credentials)` — Always hits the network; there is no cache path
- `getEntitlementSnapshot()` — Pure pref read of the last known entitled style list
- `getLastSyncOk()` / `setLastSyncOk()` — The tolerance clock
- `saveCredentials(email, licenseKey)` / `loadCredentials()` / `clearCredentials()`
- `getZoteroUserId()` — Get logged-in Zotero account ID
- `getApiBase()` — API base URL, overridable via a dev-only pref

**Features:**

- Requests use `successCodes: false`, so the promise settling is the discriminator: resolved ⇒ we reached the server; rejected ⇒ we did not
- `errorDelayMax: 0` disables Zotero's default 1-hour 5xx retry loop
- Legacy backend responses without a `status` field degrade to `server-error`, never `expired` — an old backend must not be able to trigger a mass uninstall

### Custom Styles Module (`src/modules/customStyles.ts`)

Manages style installation, rendering, and updates.

**Key Functions:**

- `renderStylesInPrefs(doc, win, container, statusEl, licenseKey)` — Display available styles; throws if the list cannot be fetched
- `renderInstalledFromLedger(doc, container)` — Read-only list used during the offline tolerance window
- `checkAndInstallUpdates(doc, win, container, statusEl, licenseKey)` — Fetch and install style updates
- `installStyleToZotero(shopId, styleContent, win)` — Install a style and record it in the ownership ledger. Parses the CSL `<id>`/`<title>` from the file itself; returns `false` if the user declined to replace an existing style.

### Style Ledger (`src/modules/styleLedger.ts`)

The record of which styles **this plugin** installed. Zotero keeps no provenance, so without it an uninstall would delete styles the customer installed themselves. Stored in `extensions.theciteshop.managedStyles`, deliberately separate from the entitlement snapshot because that snapshot is cleared the moment a licence goes invalid.

- `read()` never throws — a throw would take down the startup check
- `record()` upserts by `styleID` and never flips `preexisting` back to false
- `prune()` is lazy (Zotero has no notifier event for styles) and its styles-loaded probe gates the **whole** prune, not each entry
- `removeAll(reason)` / `removeSome(ids, reason)` — `reason` is mandatory so every deletion is logged with a justification

### Enforcement (`src/modules/enforcement.ts`)

- `decideAction(outcome, lastSyncOk, now, ledgerCount, tolerance)` — **Pure** and unit-tested
- `runEnforcementCheck(trigger)` — re-entrancy guarded via `addon.data.license.enforcing`
- `startEnforcementTimer()` — chained `setTimeout`, called only from `onStartup` (never per-window)

## Lifecycle Hooks (`src/hooks.ts`)

### `onStartup()`

- Waits for Zotero initialization
- Initializes localization
- Registers the preferences pane
- Opens preferences on first install

### `onMainWindowLoad(win)`

- Initializes ZToolkit for each window
- Registers FTL (Fluent) localization strings

### `onMainWindowUnload(win)` / `onShutdown()`

- Cleans up event listeners
- Closes dialog windows
- Unregisters all handlers

### `onPrefsEvent(type, data)`

Handles the preferences pane UI interactions:

- **Email/License Input**: Form fields for credentials
- **Verify Button**: Triggers license validation
- **Styles Container**: Displays installable styles with Install/Update buttons
- **Logout Button**: Clears stored credentials
- **Check for Updates Button**: Fetches updates for installed styles

**Status Colors:**

- Green (#28a745): Verified license
- Orange (#fd7e14): Within the offline tolerance window
- Red (#dc3545): Errors (invalid email, missing credentials, validation failed, styles removed)
- Gray (#888): In-progress or neutral

## Build & Development

### Scripts

```bash
npm start              # Start dev server with hot-reload
npm run build          # Build plugin & run TypeScript check
npm run lint:check     # Check formatting & linting
npm run lint:fix       # Auto-fix formatting & linting
npm run release        # Build release XPI
npm test               # Run Mocha test suite
npm run update-deps    # Update dependencies
```

### Build Output

- **Development**: `.scaffold/build/` directory
- **Release**: XPI file for distribution
- Manifest is templated with package.json values

## Configuration

### package.json Config Section

```json
"config": {
  "addonName": "The Cite Shop Client Sync",
  "addonID": "theciteshop-sync@theciteshop.com",
  "addonRef": "theciteshop-sync",           // Namespace for chrome://
  "addonInstance": "TheCiteShopSync",      // Global Zotero object instance
  "prefsPrefix": "extensions.zotero.theciteshop-sync"  // Prefs storage prefix
}
```

### Environment Variables

- `NODE_ENV`: "development" or "production" (passed to plugin via `__env__`)
- Plugin sets `__env__` in esbuild define

## Important Implementation Details

### First Install Experience

When the plugin is first installed:

1. Checks `extensions.theciteshop.installed` preference
2. If not set, opens the preferences pane automatically
3. User enters email and license key
4. Plugin validates against backend
5. Installed styles are displayed

### Preferences Pane Elements

All elements queried in `onPrefsEvent`:

- `#prefs-verify-btn` — License verification button
- `#prefs-email-input` — Email address input
- `#prefs-license-input` — License key input
- `#prefs-status` — Status messages
- `#prefs-styles-container` — Installed styles list
- `#prefs-logout-btn` — Clear credentials button
- `#prefs-check-updates-btn` — Check for updates button
- `#prefs-update-row` — Update controls container
- `#prefs-update-status` — Update status message

### Zotero Integration

- Uses `Zotero.Prefs` for persistent storage
- Uses `Zotero.getMainWindows()` to iterate windows
- Uses `Zotero.PreferencePanes.register()` to add settings pane
- Uses `Zotero.Utilities.Internal.openPreferences()` to open prefs
- Uses `MozXULElement.insertFTLIfNeeded()` for localization

### Email Validation

Simple regex validation in `onPrefsEvent`:

```typescript
!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
```

## Localization

Localization strings are stored in `addon/locale/` and referenced via `getString(key, options)` from `src/utils/locale.ts`.

**Common Keys:**

- `prefs-title` — Preferences pane title
- `email-placeholder`, `license-placeholder` — Input placeholders
- `status-verifying`, `status-verified`, `status-verification-failed` — Status messages
- `status-no-zotero` — Zotero account not logged in
- `status-offline-tolerance` — Server unreachable, `{$days}` remaining before removal
- `status-offline-removed` — Removed after the tolerance window lapsed
- `status-subscription-expired` — Subscription ended; styles removed
- `notify-removed-*` — Sticky removal popup
- `status-all-uptodate` — No updates available

> New keys read via `getString()` **must** go in `addon.ftl` or `customStyles.ftl` — `src/utils/locale.ts` registers only those two with the `Localization` object. `preferences.ftl` serves `data-l10n-id` attributes only. Keep `en-US` and `de-DE` key-for-key identical, and rebuild to regenerate `typings/i10n.d.ts` before `getString` will accept a new key.

## Error Handling

**Common User-Facing Errors:**

- "Please log in to your Zotero account" → User must sign in at zotero.org
- "Email does not match this license key" → Email/key mismatch
- "Your subscription has expired" → Styles have been removed; renew to restore
- "Your styles will be removed in N day(s)" → No successful licence check within the tolerance window

**Developer Error Handling:**

- Try-catch blocks around validation and update checks
- Errors logged via `ztoolkit.log()` for debugging
- User receives readable error messages in status display

## Release Process

1. Update version in `package.json`
2. Run `npm run build` to verify
3. Run `npm run release` to generate XPI
4. XPI is created from `.scaffold/build/`
5. Upload to GitHub releases
6. Plugin update URL points to release JSON

## Testing

Tests are written in Mocha + Chai in `test/startup.test.ts`.

**Key Test Requirement:**

- Tests wait for plugin initialization via: `Zotero.TheCiteShopSync.data.initialized`

Test files:

- `test/startup.test.ts` — smoke test
- `test/enforcement.test.ts` — table-driven `classifyResponse` and `decideAction`
- `test/ledger.test.ts` — ledger round-trip, corruption handling, and removal

The two pure functions carry the real risk: they decide whether a customer's
files get deleted. Prefer extending those tables over integration tests.

## Subscription Enforcement

Styles are removed when a subscription lapses. The policy:

| Outcome                                                            | Action                                            |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| `active`                                                           | keep, refresh `lastSyncOk`, reconcile entitlement |
| `expired` / `invalid-credentials`                                  | uninstall immediately                             |
| `rate-limited` / `server-error` / `unreachable` / `no-zotero-user` | keep; the 3-day tolerance clock runs              |

Checks run at Zotero startup (deferred 15s, never awaited), on a daily chained
`setTimeout`, and when the prefs pane opens. Removal also happens on logout and
on plugin uninstall — without those, either is a bypass, since no further check
could ever run.

**Backend contract.** `POST /license/validate` must return HTTP 200 for every
entitlement _decision_, with `status` (`active`/`expired`/`invalid`) and
`authoritative: true`. Non-2xx is reserved for infrastructure failures and 429.
`GET /styles` and `/styles/{id}` must 403 lapsed subscriptions, or the pane
would re-download what was just removed.

**Dev-only prefs**, all gated on `__env__ === "development"`:
`extensions.theciteshop.debug.{forceOutcome,checkIntervalMs,toleranceMs,apiBase}`.
The gating is mandatory — a debug pref surviving into a release build _is_ the
bypass.

## Known Limitations & Notes

- Plugin requires active Zotero account (zotero.org login)
- Licence validation requires a periodic internet connection; 3 days without a successful check removes installed styles
- Email validation is basic regex-based
- `Zotero.Styles` is typed `any` in `zotero-types`, so removal code gets **no compile-time checking**. Note in particular that `Zotero.Styles.get()` returns `false` (not `null`) on a miss, and needs `skipMappings=true` or it may return a different style than requested
- Style installation depends on Zotero's style management API

## Author & Support

**Author:** The Cite Shop
**Email:** info@theciteshop.com
**Website:** https://theciteshop.com
**Issues:** https://github.com/TheCiteShop/theciteshop-client-sync/issues
