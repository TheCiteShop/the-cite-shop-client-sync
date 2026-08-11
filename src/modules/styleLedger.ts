import { csLog } from "../utils/logger";

/**
 * Record of which citation styles THIS plugin installed into Zotero.
 *
 * Zotero itself keeps no provenance: a style the customer installed from the
 * public repository is indistinguishable from a purchased one. Without this
 * ledger, uninstalling on license lapse would delete files we never installed.
 *
 * Deliberately a separate pref from the entitlement snapshot
 * (`extensions.theciteshop.cacheValid`), which is cleared the moment a license
 * goes invalid — precisely when we need to know what to remove.
 */
const PREF_LEDGER = "extensions.theciteshop.managedStyles";
const LEDGER_VERSION = 1;

export interface LedgerEntry {
  /** Style id as the shop API knows it (`StyleData.id`). */
  shopId: string;
  /** The CSL `<id>` URI — what Zotero keys the style under. Parsed, never constructed. */
  styleID: string;
  /** CSL `<title>`, kept so the removal notification can name the style. */
  title: string;
  installedAt: number;
  /** A style with this CSL id was already present when we first installed ours. */
  preexisting: boolean;
}

export type RemovalReason =
  | "expired"
  | "invalid-credentials"
  | "tolerance-exceeded"
  | "no-credentials"
  | "logout"
  | "plugin-uninstall"
  | "entitlement-revoked";

export interface RemovalReport {
  /** Successfully removed from Zotero; entry dropped. */
  removed: string[];
  /** Not present in Zotero; treated as success, entry dropped. */
  alreadyGone: string[];
  /** Threw during removal; entry KEPT for retry. */
  failed: string[];
  /** A guard tripped; entry KEPT. */
  skipped: string[];
  /** Set when the run bailed before touching anything. */
  aborted?: string;
}

/**
 * Prefer the bare `Zotero` global over ztoolkit.
 *
 * `ztoolkit` is created by the plugin's own entry point, so it is absent in
 * the test bundle's scope and can be torn down by unregisterAll(). Reaching
 * for it first meant removal could abort with "no-styles-api" and silently
 * delete nothing — a licensing control that quietly no-ops is the worst
 * possible failure. The bare global is present wherever this code can run.
 */
function getStylesApi(): any | null {
  try {
    if (typeof Zotero !== "undefined" && (Zotero as any)?.Styles) {
      return (Zotero as any).Styles;
    }
  } catch {
    // fall through to ztoolkit
  }
  try {
    const zotero = ztoolkit.getGlobal("Zotero") as any;
    return zotero?.Styles ?? null;
  } catch (e) {
    csLog("ERROR", "Could not reach Zotero.Styles:", e);
    return null;
  }
}

/**
 * Zotero.Styles.get() throws UnloadedDataException until styles are loaded.
 * Probe once up front rather than per entry — see prune().
 */
function stylesLoaded(styles: any): boolean {
  try {
    styles.getAll();
    return true;
  } catch {
    return false;
  }
}

class StyleLedger {
  /** Never throws. A throw here would take down the startup enforcement check. */
  read(): LedgerEntry[] {
    let raw: unknown;
    try {
      raw = Zotero.Prefs.get(PREF_LEDGER);
    } catch (e) {
      csLog("ERROR", "Ledger pref read failed:", e);
      return [];
    }
    if (typeof raw !== "string" || !raw) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      csLog("ERROR", "Ledger JSON is corrupt — treating as empty:", e);
      return [];
    }

    if (
      !parsed ||
      parsed.v !== LEDGER_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      csLog("WARN", "Ledger envelope unrecognized — treating as empty");
      return [];
    }

    const entries: LedgerEntry[] = [];
    for (const e of parsed.entries) {
      if (!e || typeof e.styleID !== "string" || !e.styleID) {
        csLog("WARN", "Dropping malformed ledger entry");
        continue;
      }
      entries.push({
        shopId: typeof e.shopId === "string" ? e.shopId : "",
        styleID: e.styleID,
        title: typeof e.title === "string" ? e.title : e.styleID,
        installedAt: typeof e.installedAt === "number" ? e.installedAt : 0,
        preexisting: e.preexisting === true,
      });
    }
    return entries;
  }

  write(entries: LedgerEntry[]): void {
    try {
      Zotero.Prefs.set(
        PREF_LEDGER,
        JSON.stringify({ v: LEDGER_VERSION, entries }),
      );
    } catch (e) {
      csLog("ERROR", "Ledger write failed:", e);
    }
  }

  count(): number {
    return this.read().length;
  }

  has(styleID: string): boolean {
    return this.read().some((e) => e.styleID === styleID);
  }

  /** Upsert by styleID. */
  record(entry: LedgerEntry): void {
    const entries = this.read();
    const at = entries.findIndex((e) => e.styleID === entry.styleID);
    if (at >= 0) {
      // An update must never flip a style from "we own it" to "pre-existing".
      entries[at] = { ...entry, preexisting: entries[at].preexisting };
    } else {
      entries.push(entry);
    }
    this.write(entries);
    csLog("INFO", `Ledger now tracks ${entries.length} managed style(s)`);
  }

  /**
   * Drop entries for styles the user removed by hand. Lazy, because Zotero has
   * no notifier event for styles.
   */
  prune(): void {
    const styles = getStylesApi();
    if (!styles) return;

    // The probe MUST gate the whole prune, not each entry: if the unloaded-data
    // exception fired inside the filter, every entry would evaluate falsy and
    // the entire ledger would be silently wiped — after which a lapse would
    // remove nothing, forever.
    if (!stylesLoaded(styles)) {
      csLog("WARN", "Styles not loaded — skipping ledger prune");
      return;
    }

    const entries = this.read();
    if (!entries.length) return;

    const kept = entries.filter((e) => !!styles.get(e.styleID, true));
    if (kept.length !== entries.length) {
      csLog(
        "INFO",
        `Pruned ${entries.length - kept.length} stale ledger entry(ies)`,
      );
      this.write(kept);
    }
  }

  async removeAll(reason: RemovalReason): Promise<RemovalReport> {
    return this.removeEntries(this.read(), reason);
  }

  async removeSome(
    styleIDs: string[],
    reason: RemovalReason,
  ): Promise<RemovalReport> {
    const targets = this.read().filter((e) => styleIDs.includes(e.styleID));
    return this.removeEntries(targets, reason);
  }

  private async removeEntries(
    targets: LedgerEntry[],
    reason: RemovalReason,
  ): Promise<RemovalReport> {
    const report: RemovalReport = {
      removed: [],
      alreadyGone: [],
      failed: [],
      skipped: [],
    };

    const styles = getStylesApi();
    if (!styles) {
      report.aborted = "no-styles-api";
      csLog("ERROR", "Zotero.Styles unavailable — aborting, ledger untouched");
      return report;
    }

    if (!stylesLoaded(styles)) {
      try {
        await styles.init();
      } catch (e) {
        csLog("WARN", "Zotero.Styles.init() failed:", e);
      }
      if (!stylesLoaded(styles)) {
        report.aborted = "styles-not-loaded";
        csLog("ERROR", "Styles not loaded — aborting, ledger untouched");
        return report;
      }
    }

    if (!targets.length) return report;

    csLog(
      "WARN",
      `Removing ${targets.length} managed style(s) — reason: ${reason}`,
    );

    for (const entry of targets) {
      try {
        // Re-fetch inside the loop: style.remove() ends with Styles.reinit(),
        // so anything captured before this iteration is stale. For the same
        // reason removals must stay serialized — never Promise.all.
        //
        // skipMappings=true is mandatory. Without it Zotero applies its
        // renamed-style map and can hand back a DIFFERENT style than the one
        // we installed, and we would delete something we do not own.
        const style = styles.get(entry.styleID, true);

        // get() returns false — not null/undefined — on a miss.
        if (!style) {
          report.alreadyGone.push(entry.styleID);
          continue;
        }
        if (style.styleID !== entry.styleID) {
          csLog("WARN", `Identity mismatch on ${entry.styleID} — skipping`);
          report.skipped.push(entry.styleID);
          continue;
        }
        if (!style.path) {
          // Zotero throws "Cannot delete a style with no associated file".
          csLog("WARN", `No file backs ${entry.styleID} — skipping`);
          report.skipped.push(entry.styleID);
          continue;
        }
        if (typeof style.remove !== "function") {
          csLog("ERROR", `${entry.styleID} has no remove() — skipping`);
          report.skipped.push(entry.styleID);
          continue;
        }

        await style.remove();
        csLog("INFO", `Removed style: ${entry.title} (${entry.styleID})`);
        report.removed.push(entry.styleID);
      } catch (e) {
        csLog("ERROR", `Failed to remove ${entry.styleID}:`, e);
        report.failed.push(entry.styleID);
      }
    }

    // Retain anything that failed or was skipped so the next check retries it,
    // plus anything that was never targeted. Never clear the pref wholesale: a
    // partial failure followed by a wholesale clear would leave the surviving
    // files permanently unremovable.
    const retain = new Set([...report.failed, ...report.skipped]);
    const targeted = new Set(targets.map((t) => t.styleID));
    this.write(
      this.read().filter(
        (e) => retain.has(e.styleID) || !targeted.has(e.styleID),
      ),
    );

    csLog(
      "INFO",
      `Removal complete — removed:${report.removed.length} ` +
        `alreadyGone:${report.alreadyGone.length} ` +
        `failed:${report.failed.length} skipped:${report.skipped.length}`,
    );
    return report;
  }
}

export const styleLedger = new StyleLedger();
