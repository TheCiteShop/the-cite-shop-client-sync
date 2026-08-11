import { version } from "../package.json";
import { StyleCredentials, customStylesManager } from "./modules/customStyles";
import {
  enforceAuthoritativeRefusal,
  removeAllShopStyles,
  runEnforcementCheck,
  scheduleStartupCheck,
  startEnforcementTimer,
  stopEnforcementTimer,
} from "./modules/enforcement";
import { licenseManager } from "./modules/license";
import { styleLedger } from "./modules/styleLedger";
import { getString, initLocale } from "./utils/locale";
import { csLog, getFormattedLogs } from "./utils/logger";
import { getColors, isDarkMode } from "./utils/theme";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  const mainWin = Zotero.getMainWindows()[0] as unknown as Window;
  const dark = mainWin ? isDarkMode(mainWin) : false;
  const icon = dark
    ? "the-cite-shop-client-sync-favicon-96-white.png"
    : "the-cite-shop-client-sync-favicon-96.png";

  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/${icon}`,
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // ── Open prefs pane on first install ──────────────────────────
  const isFirstInstall = !Zotero.Prefs.get("extensions.theciteshop.installed");
  if (isFirstInstall) {
    Zotero.Prefs.set("extensions.theciteshop.installed", true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    Zotero.Utilities.Internal.openPreferences(addon.data.config.addonRef);
  }

  csLog("INFO", `Plugin started — version ${version}`);
  addon.data.initialized = true;

  // Subscription enforcement. Deliberately not awaited: onStartup is awaited
  // by bootstrap.js, so blocking here would stall plugin startup behind a
  // network round trip.
  licenseManager.migrate();
  scheduleStartupCheck();
  startEnforcementTimer();
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  // First: the timer callback dereferences addon.data, which this function
  // goes on to tear down.
  stopEnforcementTimer();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type !== "load") return;

  await new Promise((resolve) => data.window.setTimeout(resolve, 100));

  const win: Window = data.window;
  const doc: Document = win.document;

  // Zotero renders every plugin's preference pane into one shared document, so
  // element IDs are namespaced with the addon ref. Unprefixed IDs collide with
  // other plugins — notably an older build of this one still installed.
  const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
    doc.getElementById(`${addon.data.config.addonRef}-${id}`) as T;

  const versionEl = byId("prefs-version");
  if (versionEl) {
    versionEl.textContent = `v${version}`;
    versionEl.style.color = getColors(win).mutedText;
  }

  const verifyBtn = byId("prefs-verify-btn");
  const emailInput = byId<HTMLInputElement>("prefs-email-input");
  const licenseInput = byId<HTMLInputElement>("prefs-license-input");
  const statusDiv = byId("prefs-status");
  const stylesContainer = byId("prefs-styles-container");
  const logoutBtn = byId("prefs-logout-btn");
  const updateRow = byId("prefs-update-row");
  const updateBtn = byId("prefs-check-updates-btn");
  const updateStatus = byId("prefs-update-status");

  if (
    !verifyBtn ||
    !emailInput ||
    !licenseInput ||
    !statusDiv ||
    !stylesContainer
  ) {
    csLog(
      "ERROR",
      "Prefs elements not found — preferences pane may not have loaded correctly",
    );
    return;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showUpdateRow() {
    if (updateRow) {
      updateRow.style.display = "flex";
      updateRow.style.alignItems = "center";
    }
  }

  function hideUpdateRow() {
    if (updateRow) updateRow.style.display = "none";
    if (updateStatus) updateStatus.textContent = "";
  }

  // ── Set placeholders from locale ──────────────────────────────────────────
  emailInput.placeholder = getString("email-placeholder");
  licenseInput.placeholder = getString("license-placeholder");

  csLog("INFO", "Preferences pane loaded");

  // ── Pre-fill saved credentials ────────────────────────────────────────────
  const saved = licenseManager.loadCredentials();
  if (saved) {
    csLog("INFO", "Saved credentials found — running license check");
    emailInput.value = saved.email;
    licenseInput.value = saved.licenseKey;
  } else {
    csLog("INFO", "No saved credentials");
  }

  // ── Warn if not logged into Zotero (never disable the button) ────────────
  const zoteroUserId = licenseManager.getZoteroUserId();
  if (!zoteroUserId) {
    csLog("WARN", "No Zotero user ID — user may not be logged in");
    statusDiv.textContent = getString("status-no-zotero");
    statusDiv.style.color = getColors(win).error;
  }

  // ── Render the live style list after a successful check ───────────────────
  async function renderActiveStyles(creds: StyleCredentials) {
    try {
      await customStylesManager.renderStylesInPrefs(
        doc,
        win,
        stylesContainer,
        statusDiv,
        creds,
      );
      showUpdateRow();
    } catch (e) {
      // The license is fine but the style list did not load. Show what is
      // installed rather than the misleading "contact support" message.
      csLog("ERROR", "Style list fetch failed:", e);
      statusDiv.textContent = getString("status-server-unreachable");
      statusDiv.style.color = getColors(win).error;
      customStylesManager.renderInstalledFromLedger(doc, stylesContainer);
      hideUpdateRow();
    }
  }

  // ── Translate an enforcement result into the pane's state ─────────────────
  async function applyOutcome(
    result: Awaited<ReturnType<typeof runEnforcementCheck>>,
    creds: StyleCredentials,
  ) {
    const c = getColors(win);
    if (!result) {
      statusDiv.textContent = getString("status-verify-error");
      statusDiv.style.color = c.error;
      return;
    }

    const { outcome, decision, validation } = result;

    if (outcome === "active") {
      statusDiv.textContent = getString("status-verified");
      statusDiv.style.color = c.success;
      await renderActiveStyles(creds);
      return;
    }

    stylesContainer.innerHTML = "";
    hideUpdateRow();

    // Authoritative refusal — the styles have just been removed, so say why.
    if (outcome === "expired" || outcome === "invalid-credentials") {
      statusDiv.textContent =
        validation?.reasonText ??
        getString(validation?.reasonKey ?? "status-validation-failed");
      statusDiv.style.color = c.error;
      return;
    }

    // Transient failure: either the tolerance window just ran out, or it is
    // still running and the customer keeps their styles for now.
    if (decision.action === "uninstall") {
      statusDiv.textContent = getString("status-offline-removed", {
        args: { days: decision.daysElapsed },
      });
      statusDiv.style.color = c.error;
      return;
    }

    statusDiv.textContent = getString("status-offline-tolerance", {
      args: { days: decision.daysRemaining },
    });
    statusDiv.style.color = c.warning;
    customStylesManager.renderInstalledFromLedger(doc, stylesContainer);
  }

  // ── Real license check on pane open ───────────────────────────────────────
  if (saved && zoteroUserId) {
    statusDiv.textContent = getString("status-verifying");
    statusDiv.style.color = getColors(win).neutral;
    await applyOutcome(await runEnforcementCheck("prefs"), {
      licenseKey: saved.licenseKey,
      email: saved.email,
      zoteroUserId,
    });
  }

  // ── Verify button ─────────────────────────────────────────────────────────
  verifyBtn.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const licenseKey = licenseInput.value.trim();
    csLog("INFO", `Verify button clicked — key length: ${licenseKey.length}`);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      statusDiv.textContent = getString("status-invalid-email");
      statusDiv.style.color = getColors(win).error;
      return;
    }
    if (!licenseKey) {
      statusDiv.textContent = getString("status-missing-license");
      statusDiv.style.color = getColors(win).error;
      return;
    }

    const zoteroUserId = licenseManager.getZoteroUserId();
    if (!zoteroUserId) {
      statusDiv.textContent = getString("status-no-zotero");
      statusDiv.style.color = getColors(win).error;
      return;
    }

    statusDiv.textContent = getString("status-verifying");
    statusDiv.style.color = getColors(win).neutral;
    stylesContainer.innerHTML = "";
    hideUpdateRow();

    try {
      // Validate the typed values directly rather than going through
      // enforcement: a mistyped key must not delete the styles a valid
      // saved license installed. Credentials are only persisted on success,
      // so enforcement never runs against an unverified key.
      const result = await licenseManager.validateAuthoritative({
        email,
        licenseKey,
        zoteroUserId,
      });

      if (result.outcome !== "active") {
        csLog("WARN", `Verification failed: ${result.outcome}`);
        statusDiv.textContent =
          result.reasonText ??
          getString(result.reasonKey ?? "status-validation-failed");
        statusDiv.style.color = getColors(win).error;

        // An authoritative refusal about credentials we had already saved and
        // verified is just as binding here as during a background check —
        // otherwise the customer is told their license is dead while the
        // styles stay installed.
        //
        // Gated on the typed values matching the saved ones so the typo
        // protection above still holds: entering a wrong key must never
        // delete the styles a working license installed.
        const savedNow = licenseManager.loadCredentials();
        const isSavedCredentials =
          !!savedNow &&
          savedNow.licenseKey === licenseKey &&
          savedNow.email.toLowerCase() === email.toLowerCase();

        if (isSavedCredentials) {
          await enforceAuthoritativeRefusal(result.outcome);
        }
        return;
      }

      csLog("INFO", "Credentials saved after successful verification");
      licenseManager.saveCredentials(email, licenseKey);

      statusDiv.textContent = getString("status-verified");
      statusDiv.style.color = getColors(win).success;
      await renderActiveStyles({ licenseKey, email, zoteroUserId });
    } catch (e) {
      csLog("ERROR", "Verify error:", e);
      statusDiv.textContent = getString("status-verify-error");
      statusDiv.style.color = getColors(win).error;
    }
  });

  // ── Check for Updates button ──────────────────────────────────────────────
  updateBtn?.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const licenseKey = licenseInput.value.trim();
    // The style endpoints now verify the Zotero account too, so a signed-out
    // Zotero cannot fetch styles even with valid credentials typed in.
    const updateZoteroUserId = licenseManager.getZoteroUserId();

    if (!email || !licenseKey || !updateZoteroUserId) {
      updateStatus.textContent = getString(
        updateZoteroUserId ? "status-missing-credentials" : "status-no-zotero",
      );
      updateStatus.style.color = getColors(win).error;
      return;
    }

    updateStatus.textContent = getString("status-verifying");
    updateStatus.style.color = getColors(win).neutral;

    try {
      const updatedCount = await customStylesManager.checkAndInstallUpdates(
        doc,
        win,
        stylesContainer,
        statusDiv,
        { licenseKey, email, zoteroUserId: updateZoteroUserId },
      );

      csLog(
        "INFO",
        `Update check complete — ${updatedCount} updates available`,
      );
      if (updatedCount === 0) {
        updateStatus.textContent = getString("status-all-uptodate");
        updateStatus.style.color = getColors(win).success;
      } else {
        updateStatus.textContent = getString("status-updates-available", {
          args: { count: updatedCount },
        });
        updateStatus.style.color = getColors(win).warning;
      }
    } catch (e) {
      updateStatus.textContent = getString("status-update-failed");
      updateStatus.style.color = getColors(win).error;
    }
  });

  // ── Clear Credentials button ──────────────────────────────────────────────
  logoutBtn?.addEventListener("click", async () => {
    // Managed styles must go with the credentials. Otherwise clearing them is
    // a two-click bypass: with no credentials stored, no future check can run
    // and the purchased styles stay installed forever.
    const managed = styleLedger.count();
    if (managed > 0) {
      const proceed = win.confirm(
        getString("status-logout-will-remove", { args: { count: managed } }),
      );
      if (!proceed) {
        csLog("INFO", "User cancelled credential clearing");
        return;
      }
      const report = await removeAllShopStyles("logout");
      csLog("INFO", `Logout removed ${report.removed.length} style(s)`);
    }

    csLog("INFO", "Credentials cleared by user");
    licenseManager.clearCredentials();
    emailInput.value = "";
    licenseInput.value = "";
    stylesContainer.innerHTML = "";
    statusDiv.textContent = getString("status-credentials-cleared");
    statusDiv.style.color = getColors(win).neutral;
    hideUpdateRow();
  });

  // ── Copy Logs button ──────────────────────────────────────────────────────
  const copyLogsBtn = byId("prefs-copy-logs-btn");
  const logsStatusDiv = byId("prefs-logs-status");

  copyLogsBtn?.addEventListener("click", async () => {
    const text = getFormattedLogs();
    try {
      await (win as any).navigator.clipboard.writeText(text);
    } catch {
      // Fallback for chrome:// contexts
      const ta = doc.createElement("textarea");
      ta.value = text;
      doc.documentElement!.appendChild(ta);
      (ta as any).select();
      doc.execCommand("copy");
      doc.documentElement!.removeChild(ta);
    }
    csLog("INFO", "Log export copied to clipboard by user");
    if (logsStatusDiv) {
      logsStatusDiv.textContent = getString("status-logs-copied");
      logsStatusDiv.style.color = getColors(win).success;
      win.setTimeout(() => {
        logsStatusDiv.textContent = "";
      }, 3000);
    }
  });
}

function onShortcuts(type: string) {
  // Reserved for future keyboard shortcuts
}

function onDialogEvents(type: string) {
  // Reserved for future dialog events
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
