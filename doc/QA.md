# QA — Subscription Enforcement

This feature **deletes `.csl` files from the Zotero styles directory**. Read the
safety section before running anything manually.

---

## 0. Safety

### Use a throwaway profile

Manual QA must not run against your real Zotero profile
(`C:\Users\Lenno14\Zotero`). `npm start` and `npm test` both default to
project-local directories under `.scaffold/`, and `.env` deliberately does not
set `ZOTERO_PLUGIN_PROFILE_PATH` or `ZOTERO_PLUGIN_DATA_DIR` **at all** — not
even to an empty value, since an empty string can override the scaffold's own
defaults and route a dev run at the real profile. **Do not set them** — pointing
dev or test runs at real library data means real style files get deleted.

| Command     | Profile                                   | Data dir              |
| ----------- | ----------------------------------------- | --------------------- |
| `npm start` | `.scaffold/profile`                       | `.scaffold/data`      |
| `npm test`  | `.scaffold/test/profile` (wiped each run) | `.scaffold/test/data` |

If you deliberately test against a real profile, back it up first:

```bash
cp -r "$(cygpath "$(node -e 'console.log(process.env.USERPROFILE)')")/Zotero/styles" ~/zotero-styles-backup
```

### Only shop styles are ever removed

Removal has exactly two sources, and nothing else is ever touched:

1. **The ownership ledger** (`extensions.theciteshop.managedStyles`) — written
   only by `installStyleToZotero`.
2. **Hash-verified untracked files** (`extensions.theciteshop.styleHashes`) — a
   file whose id matches a shop style **and** whose contents hash to what the
   server served. This catches a `.csl` copied between machines by hand, which
   the ledger cannot see.

A matching id is never sufficient. Shop styles use the same
`http://www.zotero.org/styles/` namespace as the public repository, so a
customer may hold a different style under one of our ids — it hashes
differently and is skipped.

**Test 6 is the regression test for this** and is the most important test in
the file. If it ever fails, stop and fix before shipping.

### Zotero's Cite pane does not refresh itself

After a removal, Zotero's own **Settings → Cite** list may still show the
style until that window is closed and reopened. The file _is_ gone —
`style.remove()` deletes it and calls `Zotero.Styles.reinit()`. Zotero renders
that list once on open and there is no notifier event for styles, so it cannot
know to redraw. Expected, not a bug. The plugin's own list clears correctly.

---

## 1. Build modes

The debug prefs below are gated on `__env__ === "development"`. A production
build ignores them entirely — that gating is deliberate, because a debug pref
that survives into a release build _is_ a licensing bypass.

| Command                         | `__env__`     | Debug prefs |
| ------------------------------- | ------------- | ----------- |
| `npm start`                     | `development` | **active**  |
| `npx zotero-plugin build --dev` | `development` | **active**  |
| `npm run build`                 | `production`  | ignored     |
| `npm test`                      | `test`        | ignored     |

So: **manual QA of enforcement requires `npm start`.**

---

## 2. Setting prefs

`Zotero.Prefs` resolves names against the `extensions.zotero.` branch unless
`global` is passed, and this plugin never passes it. So the key you write in
code is _not_ the key you see in `about:config`:

| Context                            | Key                                                   |
| ---------------------------------- | ----------------------------------------------------- |
| Tools → Developer → Run JavaScript | `extensions.theciteshop.lastSyncOk`                   |
| `about:config`                     | `extensions.zotero.extensions.theciteshop.lastSyncOk` |

Prefer **Tools → Developer → Run JavaScript**; it uses the same call shape as
the plugin, so there is nothing to get wrong.

### Debug prefs (development builds only)

| Pref                    | Effect                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `debug.forceOutcome`    | Short-circuits validation and returns this `LicenseOutcome` with no network call. Values: `active`, `expired`, `invalid-credentials`, `rate-limited`, `server-error`, `unreachable`, `no-zotero-user`. |
| `debug.toleranceMs`     | Overrides the 3-day tolerance window.                                                                                                                                                                  |
| `debug.checkIntervalMs` | Overrides the 24-hour timer so you can watch it fire.                                                                                                                                                  |
| `debug.apiBase`         | Points at a local stub server.                                                                                                                                                                         |

All are prefixed `extensions.theciteshop.`.

### Useful snippets

```js
// Force a lapsed subscription on the next check
Zotero.Prefs.set("extensions.theciteshop.debug.forceOutcome", "expired");

// Backdate the tolerance clock past the 3-day window
Zotero.Prefs.set(
  "extensions.theciteshop.lastSyncOk",
  String(Date.now() - 4 * 864e5),
);

// Make the daily timer fire every 10 seconds
Zotero.Prefs.set("extensions.theciteshop.debug.checkIntervalMs", 10000);

// Inspect current state
JSON.parse(
  Zotero.Prefs.get("extensions.theciteshop.managedStyles") || '{"entries":[]}',
);
Zotero.Prefs.get("extensions.theciteshop.lastSyncOk");

// Inspect the style fingerprint catalog
JSON.parse(Zotero.Prefs.get("extensions.theciteshop.styleHashes") || "{}");

// Reset everything
[
  "licenseKey",
  "email",
  "lastSyncOk",
  "cacheValid",
  "managedStyles",
  "styleHashes",
  "installed",
].forEach((k) => Zotero.Prefs.clear("extensions.theciteshop." + k));
```

Clear `debug.forceOutcome` when finished, or every later check is synthetic:

```js
Zotero.Prefs.clear("extensions.theciteshop.debug.forceOutcome");
```

---

## 3. Backend contract

**Live and verified end to end on 2026-08-11**: cancelling the subscription
deactivates the license, and the plugin removes the style and shows the sticky
popup.

`POST /license/validate` returns `status` (`active`/`expired`/`invalid`) with
`authoritative: true` on HTTP 200 for every entitlement decision. If
`authoritative` is ever missing, `classifyResponse` maps the response to
`server-error` and **nothing is removed** — the deliberate interlock that stops
a WAF or CDN 403 being read as a revocation (see `test/enforcement.test.ts` →
"degrades legacy valid:false to server-error"). If enforcement mysteriously
stops firing, check that field first.

`GET /styles` and `/styles/{id}` 403 lapsed subscriptions, or the prefs pane
would re-download whatever was just removed (**test 9**). They also require
`email` and `zotero_user_id` alongside `license_key`.

> **Ship the plugin and backend together.** An older plugin build does not send
> the style-endpoint parameters and will receive 403s on every style request.

`debug.forceOutcome` remains the fastest way to exercise outcomes the backend
cannot easily produce on demand — 429, 5xx, timeouts.

---

## 4. Unit tests

```bash
npx zotero-plugin test --exit-on-finish
```

`npm test` alone stays in watch mode and will not exit on its own.

Expected: **41 passing.** These cover the two pure functions —
`classifyResponse` and `decideAction` — which encode every decision that can
delete a customer's files, plus the hash sweep, which installs a real CSL into
Zotero and asserts it is removed on a hash match and **spared** on a mismatch.
Extend those tables in preference to adding integration tests.

---

## 5. Manual test matrix

**Verified 2026-08-11** against the live backend (tests 1, 2, 13, 18):

- Cancelling the subscription deactivates the license, the plugin removes the
  style, and the sticky popup appears.
- Deactivating the license and clicking **Verify** removes the style.
- **Uninstalling the plugin** removes the `.csl`. This also settles an open
  question: `uninstall()` in `bootstrap.js` is `async` and bootstrap hooks are
  invoked synchronously, so it was unclear whether the awaited removals would
  be cut short. They are not.

Everything else in the table below is still unexercised. The highest-risk of
those is **test 17 (title clash)** — newest code, never run, and its failure
mode is deleting a style the customer wrote themselves.

Run with `npm start`. Reset state between tests using the snippet above.

| #   | Scenario                         | How to force it                                             | Expected                                                                        |
| --- | -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Active license                   | Normal verify                                               | Styles listed; `lastSyncOk` advances                                            |
| 2   | Subscription expired             | `forceOutcome = expired`                                    | Managed styles removed, **sticky** popup, pane shows "subscription has expired" |
| 3   | Invalid credentials              | `forceOutcome = invalid-credentials`                        | Same as 2, with the invalid-license message                                     |
| 4   | Offline, inside window           | `forceOutcome = unreachable`                                | Styles **kept**; pane shows "removed in N day(s)"; **no popup**                 |
| 5   | Offline, past window             | `forceOutcome = unreachable` + backdate `lastSyncOk` 4 days | Styles removed + popup                                                          |
| 6   | **Unmanaged style is untouched** | See §6                                                      | Style still installed and listed in Zotero                                      |
| 7   | Rate limited                     | `forceOutcome = rate-limited`                               | Styles kept; clock still running (backdate to confirm it eventually removes)    |
| 8   | Server error / timeout           | `forceOutcome = server-error`                               | Styles kept; tolerance applies                                                  |
| 9   | Re-download after lapse          | Let 2 remove styles, then click Verify                      | Backend must 403; pane must not reinstall                                       |
| 10  | Style deleted by hand            | Remove via Zotero's Cite pane, then run a check             | No error; ledger prunes silently                                                |
| 11  | ID collision                     | See §7                                                      | Confirmation dialog before replacing                                            |
| 12  | Logout                           | Clear Credentials with styles installed                     | Confirm dialog naming the count → removal                                       |
| 13  | Plugin uninstall                 | Tools → Plugins → Remove                                    | Managed styles removed (ledger only — no hash sweep, see §9)                    |
| 14  | Unset clock                      | Clear `lastSyncOk`, `forceOutcome = unreachable`            | **Keeps** styles — a missing timestamp is not evidence of a lapse               |
| 15  | Timer fires                      | `debug.checkIntervalMs = 10000`                             | Check repeats; only one timer runs                                              |
| 16  | Untracked copy is swept          | Install, then clear `managedStyles` only, then force expiry | Removed anyway — the hash still identifies it as ours                           |
| 17  | Title clash                      | Install a style titled exactly like a purchased one         | Dialog warns it will be **deleted**; declining aborts the install               |
| 18  | Verify on a dead license         | Deactivate in LMFWC, then click Verify                      | Message **and** removal — Verify enforces when creds match the saved ones       |
| 19  | Verify with a wrong key          | Type a bad key while holding a valid saved one              | Error only — installed styles **untouched**                                     |

To trigger a check without restarting Zotero, open the plugin's settings pane —
that runs `runEnforcementCheck("prefs")`.

---

## 6. Test 6 — unmanaged styles are never removed

The single most important test. A style the plugin did not install must survive
every removal path.

1. Confirm a style exists that the plugin did **not** install, and that it is
   absent from the ledger:

   ```js
   Zotero.Styles.get("http://www.zotero.org/styles/carocci-editore", true)
     .title;
   JSON.parse(
     Zotero.Prefs.get("extensions.theciteshop.managedStyles") ||
       '{"entries":[]}',
   ).entries;
   ```

   The first returns a title; the second must not mention that style ID.

2. Install at least one genuine purchased style so the ledger is non-empty.
3. `forceOutcome = expired`, then open the settings pane.
4. **Expected:** the purchased style is gone; the unmanaged style is still
   present and still listed in Zotero's Cite pane.

> Note: The Cite Shop's own styles use the same `http://www.zotero.org/styles/…`
> ID namespace as the public repository, so an ID alone does not tell you who
> installed a style. Provenance comes from the ledger, or from the content hash
> — never from the ID.

For the strongest version of this test, use a style of the customer's that
shares an ID with one you sell. Removal must skip it, because its contents
hash differently:

```js
// after a forced expiry, the report should list it under `skipped`, not `removed`
```

Confirm in the log (**Copy Logs**) that it reports
`Leaving http://www.zotero.org/styles/… alone — content is not one of ours`.

---

## 7. Tests 11 and 17 — install collisions

Zotero's `install()` removes an existing style matched by **id, filename, or
title**, then deletes that file unconditionally (`style.js` ~429 and 515). Both
cases are confirmed before installing, because either one destroys a customer's
file.

### ID collision (test 11)

1. Install a style manually whose `<id>` matches one you sell.
2. Install that style through the plugin.
3. **Expected:** a dialog naming the existing style.
   - **Cancel** → nothing installed, no ledger entry, original intact.
   - **OK** → installed, ledger entry written with `preexisting: true`, and it
     _is_ removed on lapse. Deliberate: by install time the original has already
     been overwritten, so declining to remove it later would not give the
     customer their file back — it would only leave paid content on disk.

### Title collision (test 17)

The subtler one. A style with a **different** id but the **same title** is also
deleted by Zotero, and the id check cannot see it coming.

1. Install a style with a distinct id but titled exactly like one you sell.
2. Install the purchased style through the plugin.
3. **Expected:** a dialog explaining the existing style will be deleted because
   Zotero treats same-named styles as the same style. Cancel aborts the install.

> Practical consequence for the catalog: **style titles are effectively a global
> namespace in Zotero**, not just IDs. A shop style titled "APA 7th edition"
> will delete a customer's own file with that exact title. Distinctive titles
> avoid the dialog ever firing.

---

## 8. Automated smoke test (no GUI, no backend)

The whole removal path can be exercised end to end by seeding the isolated dev
profile before launch, then checking the filesystem. Nothing needs clicking, and
it verifies the dangerous path and the safety property in one run.

**Verified working on 2026-08-10.**

```bash
# 1. Seed two styles into the isolated data dir: one to be removed, one control
mkdir -p .scaffold/data/styles .scaffold/profile
cp /path/to/your-style.csl        .scaffold/data/styles/   # will be in the ledger
cp /path/to/some-other-style.csl  .scaffold/data/styles/   # control, must survive

# 2. Seed prefs. NOTE the doubled physical key names — user.js is not
#    Zotero.Prefs, so the extensions.zotero. prefix must be written out.
node -e '
const fs = require("fs");
const P = "extensions.zotero.extensions.theciteshop.";
const ledger = JSON.stringify({ v: 1, entries: [{
  shopId: "your-style",
  styleID: "http://www.zotero.org/styles/your-style",
  title: "Your Style",
  installedAt: Date.now(),
  preexisting: false
}]});
fs.writeFileSync(".scaffold/profile/user.js", [
  `user_pref(${JSON.stringify(P + "email")}, "qa@theciteshop.com");`,
  `user_pref(${JSON.stringify(P + "licenseKey")}, "QA-TEST-KEY");`,
  `user_pref(${JSON.stringify(P + "managedStyles")}, ${JSON.stringify(ledger)});`,
  `user_pref(${JSON.stringify(P + "lastSyncOk")}, ${JSON.stringify(String(Date.now() - 4 * 864e5))});`,
  `user_pref(${JSON.stringify(P + "installed")}, true);`,
].join("\n") + "\n");
'

# 3. Launch, wait for the deferred startup check, then inspect
npm start          # run in the background; it does not exit
sleep 40
ls .scaffold/data/styles/
```

**Why this works without a Zotero account or a backend:** a fresh profile is not
signed in, so the outcome is `no-zotero-user` — a _transient_ outcome. But
`lastSyncOk` is backdated 4 days, past the 3-day window, so `decideAction`
returns `uninstall` anyway. That exercises the tolerance-exceeded removal path
with no network call at all.

**Expected:** the ledger style is gone; every other style survives; and
`.scaffold/profile/prefs.js` shows `managedStyles` reduced to
`{"v":1,"entries":[]}` — the entry dropped only because removal actually
succeeded. `lastSyncOk` must be **unchanged**, since a transient outcome does
not refresh the clock.

**Clean up afterwards:** delete `.scaffold/profile/user.js`, or every later
`npm start` re-seeds a fake license and a backdated clock.

---

## 8b. Destructive check against a real profile

Only for a throwaway profile, or a style you have a copy of. Prefer §8 — it
proves the same thing at no risk.

To exercise removal without a working backend, inject a ledger entry pointing at
an installed style, then force a lapse:

```js
// 1. Point the ledger at a style you have a copy of
Zotero.Prefs.set(
  "extensions.theciteshop.managedStyles",
  JSON.stringify({
    v: 1,
    entries: [
      {
        shopId: "carocci-editore",
        styleID: "http://www.zotero.org/styles/carocci-editore",
        title: "Carocci Editore (Italiano)",
        installedAt: Date.now(),
        preexisting: false,
      },
    ],
  }),
);

// 2. Force a lapse, then open the settings pane
Zotero.Prefs.set("extensions.theciteshop.debug.forceOutcome", "expired");
```

**Expected:** the file is deleted from the styles directory, a sticky popup
names the count, and the ledger is emptied.

Then verify the failure handling — a ledger entry pointing at a style that is
not installed must be reported as `alreadyGone`, not `failed`, and must not
throw. `Zotero.Styles.get()` returns `false` (not `null`) on a miss, so a
`!= null` check would pass on `false` and then call `.remove()` on a boolean.
This is covered by `test/ledger.test.ts`, but is worth confirming by hand once.

---

## 9. Things that have already bitten us

Keep these in mind when reviewing changes to this area.

- **`Zotero.Styles` is typed `any`** in `zotero-types`. None of the removal code
  is compiler-checked — wrong method names, wrong arity and missing `await` all
  type-check cleanly. Verify against the built bundle, not just the source.
- **`Zotero.Styles.get()` returns `false`** on a miss, and needs
  `skipMappings=true` or Zotero's renamed-style map can hand back a _different_
  style than the one requested. Deleting the wrong style is the worst outcome
  this code can produce.
- **`getStylesApi()` must not depend on `ztoolkit`.** It is absent in the test
  bundle's scope and torn down by `unregisterAll()`; when it was unavailable,
  removal aborted and silently deleted nothing.
- **The styles-loaded probe gates the _whole_ prune**, not each entry. Per-entry,
  an unloaded-data exception makes every entry evaluate falsy and wipes the
  ledger — after which a lapse removes nothing, forever.
- **Never clear the ledger wholesale.** Entries that failed or were skipped are
  retained for retry; clearing regardless would orphan the surviving files
  permanently.
- **Zotero deletes by title, not just id.** `install()` will remove an unrelated
  style that merely shares a name. Anything touching the install path must keep
  the title-clash confirmation, or customers lose their own work silently.
- **The stored hash is the server's, not the file's.** An earlier version of the
  hash test recorded the hash of the file _after_ writing it to disk, which
  proved nothing — production stores what the server sent. The test now hashes
  the original string and asserts the on-disk round trip matches, so if Zotero
  ever stops writing style content verbatim the sweep fails loudly instead of
  silently matching nothing. Beware tests that assert against their own output.
- **`bootstrap.js` uninstall is ledger-only.** It runs after teardown, with no
  access to the plugin's modules, so it cannot do the hash sweep. An untracked
  hand-copied file survives plugin removal. Accepted trade-off; do not "fix" it
  by duplicating crypto into bootstrap without weighing the maintenance cost.
