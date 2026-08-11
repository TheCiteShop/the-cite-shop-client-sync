import { getString } from "../utils/locale";
import { csLog } from "../utils/logger";
import { LicenseOutcome, ValidationResult, licenseManager } from "./license";
import { RemovalReason, RemovalReport, styleLedger } from "./styleLedger";

/** No successful sync for this long ⇒ treat the subscription as lapsed. */
const TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000;
const DAILY_CHECK_MS = 24 * 60 * 60 * 1000;
/**
 * Keeps the first check clear of Zotero's own startup network contention and
 * of the first-install prefs pane, which opens ~1s in while the user is still
 * typing their license key.
 */
const STARTUP_CHECK_DELAY_MS = 15_000;

export type EnforcementAction = "keep" | "keep-and-warn" | "uninstall";
export type EnforcementTrigger = "startup" | "timer" | "prefs";

export interface Decision {
  action: EnforcementAction;
  daysElapsed: number;
  daysRemaining: number;
}

export interface EnforcementResult {
  outcome: LicenseOutcome;
  decision: Decision;
  validation?: ValidationResult;
  report?: RemovalReport;
}

function toleranceMs(): number {
  if (__env__ === "development") {
    const override = Number(
      Zotero.Prefs.get("extensions.theciteshop.debug.toleranceMs"),
    );
    if (override > 0) return override;
  }
  return TOLERANCE_MS;
}

function checkIntervalMs(): number {
  if (__env__ === "development") {
    const override = Number(
      Zotero.Prefs.get("extensions.theciteshop.debug.checkIntervalMs"),
    );
    if (override > 0) return override;
  }
  return DAILY_CHECK_MS;
}

/**
 * Pure policy: outcome + tolerance clock ⇒ what to do. No I/O, so it can be
 * exhaustively unit-tested. Every path that deletes a customer's files runs
 * through here.
 */
export function decideAction(
  outcome: LicenseOutcome,
  lastSyncOk: number | null,
  now: number,
  ledgerCount: number,
  tolerance: number = TOLERANCE_MS,
): Decision {
  const none = { daysElapsed: 0, daysRemaining: Math.ceil(tolerance / 864e5) };

  if (outcome === "active") return { action: "keep", ...none };

  // Authoritative verdicts act immediately, regardless of the clock.
  if (outcome === "expired" || outcome === "invalid-credentials") {
    return { action: "uninstall", ...none };
  }

  // Everything else carries no entitlement information: unreachable, 5xx,
  // 429, or not signed in to Zotero. The tolerance clock decides.
  if (lastSyncOk === null) {
    // Never synced, or state was cleared. Nothing to measure against, so do
    // not delete on the strength of a missing timestamp.
    return {
      action: ledgerCount > 0 ? "keep-and-warn" : "keep",
      ...none,
    };
  }

  const elapsed = Math.max(0, now - lastSyncOk);
  const daysElapsed = Math.floor(elapsed / 864e5);
  const daysRemaining = Math.max(0, Math.ceil((tolerance - elapsed) / 864e5));

  if (elapsed > tolerance) {
    return { action: "uninstall", daysElapsed, daysRemaining: 0 };
  }
  return { action: "keep-and-warn", daysElapsed, daysRemaining };
}

function removalReasonFor(outcome: LicenseOutcome): RemovalReason {
  switch (outcome) {
    case "expired":
      return "expired";
    case "invalid-credentials":
      return "invalid-credentials";
    default:
      return "tolerance-exceeded";
  }
}

/** Sticky popup. Never fires for keep-and-warn — a daily nag gets us uninstalled. */
export function notifyStylesRemoved(
  reason: RemovalReason,
  report: RemovalReport,
  days?: number,
) {
  if (!report.removed.length) return;

  const win = Zotero.getMainWindows()[0];
  if (!win) {
    csLog("WARN", "No main window — removal notice suppressed");
    return;
  }

  const body =
    reason === "tolerance-exceeded"
      ? getString("notify-removed-offline", {
          args: { count: report.removed.length, days: days ?? 0 },
        })
      : getString("notify-removed-expired", {
          args: { count: report.removed.length },
        });

  try {
    new ztoolkit.ProgressWindow(getString("notify-removed-title"), {
      window: win as unknown as Window,
      closeOnClick: true,
      closeTime: -1,
    })
      .createLine({ text: body, type: "default" })
      .createLine({ text: getString("notify-removed-hint"), type: "default" })
      .show(-1);
  } catch (e) {
    csLog("ERROR", "Could not show removal notification:", e);
  }
}

export async function runEnforcementCheck(
  trigger: EnforcementTrigger,
): Promise<EnforcementResult | null> {
  if (!addon.data.alive) return null;

  const state = addon.data.license;
  // Startup and the timer can overlap; so can the prefs pane opening mid-check.
  if (state.enforcing) {
    csLog("INFO", `Enforcement check already running — skipping ${trigger}`);
    return null;
  }
  state.enforcing = true;

  try {
    const creds = licenseManager.loadCredentials();

    // Safety net for the two-click bypass: credentials removed by hand while
    // managed styles remain installed.
    if (!creds) {
      if (styleLedger.count() > 0) {
        csLog("WARN", "Managed styles present but no credentials — removing");
        const report = await styleLedger.removeAll("no-credentials");
        notifyStylesRemoved("no-credentials", report);
        return {
          outcome: "invalid-credentials",
          decision: { action: "uninstall", daysElapsed: 0, daysRemaining: 0 },
          report,
        };
      }
      return null;
    }

    const zoteroUserId = licenseManager.getZoteroUserId();
    const validation: ValidationResult = zoteroUserId
      ? await licenseManager.validateAuthoritative({
          email: creds.email,
          licenseKey: creds.licenseKey,
          zoteroUserId,
        })
      : { outcome: "no-zotero-user", reasonKey: "status-no-zotero" };

    const decision = decideAction(
      validation.outcome,
      licenseManager.getLastSyncOk(),
      Date.now(),
      styleLedger.count(),
      toleranceMs(),
    );

    csLog(
      "INFO",
      `Enforcement (${trigger}): ${validation.outcome} → ${decision.action}` +
        (decision.action === "keep-and-warn"
          ? ` (${decision.daysRemaining}d remaining)`
          : ""),
    );

    let report: RemovalReport | undefined;

    if (decision.action === "keep") {
      styleLedger.prune();

      // Reconcile: a style dropped from the entitlement (e.g. one item
      // refunded from a multi-style subscription) is removed even though the
      // license is live.
      //
      // Two guards, both load-bearing. "keep" is also reachable for a
      // transient outcome when the clock is unset, where `styles` is
      // undefined — reconciling then would read as "entitled to nothing" and
      // delete everything. And a malformed `active` response that omits
      // `styles` entirely must be ignored rather than treated as an empty
      // entitlement.
      const entitled = validation.styles;
      if (validation.outcome === "active" && Array.isArray(entitled)) {
        const orphans = styleLedger
          .read()
          .filter((e) => e.shopId && !entitled.includes(e.shopId))
          .map((e) => e.styleID);
        if (orphans.length) {
          csLog("WARN", `${orphans.length} style(s) no longer entitled`);
          report = await styleLedger.removeSome(orphans, "entitlement-revoked");
          notifyStylesRemoved("entitlement-revoked", report);
        }
      }
    } else if (decision.action === "uninstall") {
      const reason = removalReasonFor(validation.outcome);
      report = await styleLedger.removeAll(reason);
      notifyStylesRemoved(reason, report, decision.daysElapsed);
    }

    state.lastOutcome = validation.outcome;
    state.lastCheckAt = Date.now();
    return { outcome: validation.outcome, decision, validation, report };
  } catch (e) {
    csLog("ERROR", `Enforcement check (${trigger}) failed:`, e);
    return null;
  } finally {
    state.enforcing = false;
  }
}

/**
 * Chained setTimeout rather than setInterval: no pile-up if a check outlives
 * its interval, a single handle, and idempotent by construction. Called only
 * from onStartup — never from onMainWindowLoad, which fires per window.
 */
export function startEnforcementTimer(): void {
  stopEnforcementTimer();

  const schedule = () => {
    addon.data.license.timerId = setTimeout(async () => {
      addon.data.license.timerId = undefined;
      if (!addon.data.alive) return;
      try {
        await runEnforcementCheck("timer");
      } catch (e) {
        csLog("ERROR", "Timer check failed:", e);
      } finally {
        if (addon.data.alive) schedule();
      }
    }, checkIntervalMs());
  };

  schedule();
}

export function stopEnforcementTimer(): void {
  const id = addon.data.license?.timerId;
  if (id !== undefined) {
    clearTimeout(id);
    addon.data.license.timerId = undefined;
  }
}

/** Deferred so a network round trip never blocks Zotero's startup. */
export function scheduleStartupCheck(): void {
  setTimeout(() => {
    if (!addon.data.alive) return;
    void runEnforcementCheck("startup").catch((e) =>
      csLog("ERROR", "Startup check failed:", e),
    );
  }, STARTUP_CHECK_DELAY_MS);
}
