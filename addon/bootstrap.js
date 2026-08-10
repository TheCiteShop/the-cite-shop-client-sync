/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  /**
   * Global variables for plugin code.
   * The `_globalThis` is the global root variable of the plugin sandbox environment
   * and all child variables assigned to it is globally accessible.
   * See `src/index.ts` for details.
   */
  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/__addonRef__.js`,
    ctx,
  );
  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

/**
 * Remove purchased styles when the plugin itself is removed.
 *
 * Without this, uninstalling the plugin is a bypass: no check can ever run
 * again, so licensed CSL files would stay on disk permanently.
 *
 * This must be plain JS. `uninstall` runs *after* `shutdown`, which deletes
 * Zotero.__addonInstance__ and destroys the chrome handle, so none of the
 * plugin's TypeScript modules are reachable from here.
 *
 * Best effort throughout — Zotero's uninstall path must never be blocked.
 */
async function uninstall(data, reason) {
  if (reason !== ADDON_UNINSTALL) {
    return;
  }

  try {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) {
      return;
    }

    // Read with the same call shape the plugin uses (no `global` argument), so
    // this resolves to the same pref branch whatever Zotero namespaces it to.
    let entries = [];
    try {
      const raw = Zotero.Prefs.get("extensions.theciteshop.managedStyles");
      if (typeof raw === "string" && raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.entries)) {
          entries = parsed.entries;
        }
      }
    } catch (e) {
      Zotero.debug("[The Cite Shop] Could not read style ledger: " + e);
    }

    let failed = 0;

    if (entries.length && Zotero.Styles) {
      try {
        Zotero.Styles.getAll();
      } catch (e) {
        try {
          await Zotero.Styles.init();
        } catch (e2) {
          Zotero.debug("[The Cite Shop] Styles unavailable: " + e2);
        }
      }

      for (const entry of entries) {
        try {
          // skipMappings=true: without it Zotero's renamed-style map can
          // return a different style than the one we installed.
          const style = Zotero.Styles.get(entry.styleID, true);
          // get() returns false, not null, on a miss.
          if (!style) continue;
          if (style.styleID !== entry.styleID || !style.path) {
            failed++;
            continue;
          }
          await style.remove();
          Zotero.debug("[The Cite Shop] Removed style " + entry.styleID);
        } catch (e) {
          failed++;
          Zotero.debug(
            "[The Cite Shop] Failed to remove " + entry.styleID + ": " + e,
          );
        }
      }
    }

    Zotero.Prefs.clear("extensions.theciteshop.licenseKey");
    Zotero.Prefs.clear("extensions.theciteshop.email");
    Zotero.Prefs.clear("extensions.theciteshop.lastSyncOk");
    Zotero.Prefs.clear("extensions.theciteshop.cacheValid");
    Zotero.Prefs.clear("extensions.theciteshop.installed");

    // Keep the ledger if anything survived, so a later reinstall can finish
    // the job rather than orphaning the files.
    if (!failed) {
      Zotero.Prefs.clear("extensions.theciteshop.managedStyles");
    }
  } catch (e) {
    Zotero.debug("[The Cite Shop] uninstall cleanup failed: " + e);
  }
}
