import { getString } from "../utils/locale";
import { getColors } from "../utils/theme";
import { csLog } from "../utils/logger";
import { getApiBase } from "./license";
import { styleLedger } from "./styleLedger";

interface StyleData {
  id: string;
  name: string;
  remoteDate: Date | null;
  hash: string;
}

/**
 * Sent with every style request. The backend applies the same binding checks
 * it applies at validation — the email must match the order, and the Zotero
 * account must be the one the license is registered to.
 *
 * Passed explicitly rather than read from prefs so the caller controls which
 * credentials are in play, and so a request can never silently use stale
 * stored values.
 */
export interface StyleCredentials {
  licenseKey: string;
  email: string;
  zoteroUserId: string;
}

function styleQuery(creds: StyleCredentials): string {
  return (
    `license_key=${encodeURIComponent(creds.licenseKey)}` +
    `&email=${encodeURIComponent(creds.email)}` +
    `&zotero_user_id=${encodeURIComponent(creds.zoteroUserId)}`
  );
}

class CustomStylesManager {
  // ─── Crypto ───────────────────────────────────────────────────

  private async computeSHA256(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const buffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ─── Remote API ───────────────────────────────────────────────

  private async fetchWithTimeout(url: string, timeoutMs = 10000): Promise<any> {
    const zotero = ztoolkit.getGlobal("Zotero");
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timed out")), timeoutMs),
    );
    return Promise.race([
      zotero.HTTP.request("GET", url, { responseType: "json" }),
      timeout,
    ]);
  }

  /**
   * Throws on failure rather than returning []. Swallowing the error made
   * "you are offline" indistinguishable from "you own nothing", so an offline
   * customer was told to contact support.
   */
  private async fetchRemoteStyles(
    creds: StyleCredentials,
  ): Promise<StyleData[]> {
    csLog("INFO", "Fetching remote styles list");
    const response = await this.fetchWithTimeout(
      `${getApiBase()}/styles?${styleQuery(creds)}`,
    );
    const styles = response.response as unknown as any[];
    if (!Array.isArray(styles)) {
      throw new Error("Style list response was not an array");
    }
    csLog("INFO", `Remote styles fetched: ${styles.length} styles`);
    return styles.map((s: any) => ({
      id: s.id,
      name: s.name,
      remoteDate: s.updated ? new Date(s.updated) : null,
      hash: s.hash ?? "",
    }));
  }

  private async fetchRemoteStyleContent(
    styleId: string,
    creds: StyleCredentials,
    expectedHash: string,
  ): Promise<string> {
    const response = await this.fetchWithTimeout(
      `${getApiBase()}/styles/${styleId}?${styleQuery(creds)}`,
    );
    const data = response.response as unknown as { content: string };
    if (!data.content) throw new Error("No content in response");

    const actualHash = await this.computeSHA256(data.content);
    if (actualHash !== expectedHash) {
      csLog(
        "ERROR",
        `Hash mismatch for ${styleId}: expected ${expectedHash}, got ${actualHash}`,
      );
      throw new Error(
        "File integrity check failed. Please try again or contact support.",
      );
    }

    return data.content;
  }

  // ─── Zotero Style Helpers ─────────────────────────────────────

  /**
   * Resolve the CSL id Zotero keys this style under. Prefer the id we recorded
   * at install time; fall back to the conventional guess for styles we have
   * not installed yet. The guess is only a guess — the CSL's own <id> element
   * is authoritative, and the shop slug need not match it.
   */
  private resolveStyleID(shopId: string): string {
    const known = styleLedger.read().find((e) => e.shopId === shopId);
    return known?.styleID ?? `http://www.zotero.org/styles/${shopId}`;
  }

  private getInstalledStyleDate(styleId: string): Date | null {
    try {
      const zotero = ztoolkit.getGlobal("Zotero");
      // skipMappings=true: report on the exact style we track, not whatever
      // Zotero's renamed-style map would redirect this id to.
      const installedStyle = zotero.Styles.get(
        this.resolveStyleID(styleId),
        true,
      );
      if (!installedStyle?.updated) return null;
      const parsed = new Date(installedStyle.updated.replace(" ", "T") + "Z");
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch (e) {
      csLog("ERROR", "getInstalledStyleDate error:", e);
      return null;
    }
  }

  private getStyleStatus(
    style: StyleData,
  ): "not-installed" | "up-to-date" | "update-available" {
    const installedDate = this.getInstalledStyleDate(style.id);
    if (!installedDate) return "not-installed";
    if (style.remoteDate && style.remoteDate > installedDate)
      return "update-available";
    return "up-to-date";
  }

  /**
   * Installs a style and records it in the ownership ledger.
   *
   * @returns false if the user declined to replace an existing style.
   */
  async installStyleToZotero(
    shopId: string,
    styleContent: string,
    win: Window,
  ): Promise<boolean> {
    csLog("INFO", `Installing style: ${shopId}`);

    // Parse the CSL's own identity rather than trusting the shop slug or the
    // install() return value (which is {styleTitle, styleID} — reading .title
    // off it logged `undefined` for every install).
    const cslId = /<id>\s*([^<\s]+)\s*<\/id>/.exec(styleContent)?.[1];
    const cslTitle = /<title>([\s\S]*?)<\/title>/
      .exec(styleContent)?.[1]
      ?.trim();
    if (!cslId) {
      throw new Error("CSL file has no <id> — refusing to install");
    }

    const zotero = ztoolkit.getGlobal("Zotero") as any;
    if (!zotero?.Styles) throw new Error("Zotero.Styles not available");

    // Zotero's install overwrites a style sharing this id, so warn before we
    // replace something the customer installed themselves. Once replaced their
    // original is gone, which is why we take ownership rather than refusing to
    // remove it later.
    const prior = zotero.Styles.get(cslId, true);
    const alreadyOurs = styleLedger.has(cslId);
    const preexisting = !!prior && !alreadyOurs;

    if (preexisting) {
      const proceed = win.confirm(
        getString("status-replace-existing", {
          args: { name: prior.title || cslId },
        }),
      );
      if (!proceed) {
        csLog("INFO", `User declined to replace existing style ${cslId}`);
        return false;
      }
    }

    await zotero.Styles.install(styleContent, null, true);

    // Confirm it actually landed before recording, so we never write a
    // phantom entry pointing at a style that does not exist.
    if (!zotero.Styles.get(cslId, true)) {
      throw new Error(`Style ${cslId} not found in Zotero after install`);
    }

    styleLedger.record({
      shopId,
      styleID: cslId,
      title: cslTitle || shopId,
      installedAt: Date.now(),
      preexisting,
    });
    csLog("INFO", `Style installed and recorded: ${cslTitle ?? cslId}`);
    return true;
  }

  // ─── Check & Install Updates ──────────────────────────────────

  public async checkAndInstallUpdates(
    doc: Document,
    win: Window,
    container: HTMLElement,
    statusEl: HTMLElement,
    creds: StyleCredentials,
  ): Promise<number> {
    csLog("INFO", "Checking for style updates");
    const styles = await this.fetchRemoteStyles(creds);

    const updatable = styles.filter(
      (s) => this.getStyleStatus(s) === "update-available",
    );

    container.innerHTML = "";
    for (const style of styles) {
      const row = this.buildStyleRow(doc, win, style, async (s, btn) => {
        btn.textContent = getString("btn-installing");
        btn.setAttribute("disabled", "true");
        try {
          const content = await this.fetchRemoteStyleContent(
            s.id,
            creds,
            s.hash,
          );
          const installed = await this.installStyleToZotero(s.id, content, win);
          if (!installed) {
            btn.textContent = getString("btn-update");
            btn.removeAttribute("disabled");
            return;
          }
          statusEl.textContent = getString("status-updated-ok", {
            args: { name: s.name },
          });
          statusEl.style.color = getColors(win).success;
          await this.checkAndInstallUpdates(
            doc,
            win,
            container,
            statusEl,
            creds,
          );
        } catch (e) {
          btn.textContent = getString("btn-failed");
          btn.style.borderColor = getColors(win).error;
          btn.removeAttribute("disabled");
          statusEl.textContent = getString("status-install-failed", {
            args: { name: s.name },
          });
          statusEl.style.color = getColors(win).error;
        }
      });
      container.appendChild(row);
    }

    return updatable.length;
  }

  // ─── UI: Row Builder ──────────────────────────────────────────

  private buildStyleRow(
    doc: Document,
    win: Window,
    style: StyleData,
    onInstall: (
      style: StyleData,
      btn: HTMLElement,
      row: HTMLElement,
    ) => Promise<void>,
  ): HTMLElement {
    const status = this.getStyleStatus(style);
    const installedDate = this.getInstalledStyleDate(style.id);
    const fmt = (d: Date | null) =>
      d ? d.toISOString().split("T")[0] : "unknown";
    const c = getColors(win);

    const styleRow = doc.createElement("div");
    Object.assign(styleRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px 8px",
      borderBottom: `1px solid ${c.rowBorder}`,
      backgroundColor:
        status === "not-installed"
          ? c.rowBg
          : status === "update-available"
            ? c.rowBgWarn
            : c.rowBgOk,
    });

    const leftContainer = doc.createElement("div");
    Object.assign(leftContainer.style, {
      display: "flex",
      flexDirection: "column",
      flex: "1",
      minWidth: "0",
    });

    const nameRow = doc.createElement("div");
    Object.assign(nameRow.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      flexWrap: "wrap",
    });

    const statusIndicator = doc.createElement("span");
    statusIndicator.textContent =
      status === "not-installed"
        ? "○"
        : status === "update-available"
          ? "⬆"
          : "✓";
    Object.assign(statusIndicator.style, {
      fontSize: "16px",
      flexShrink: "0",
      color:
        status === "not-installed"
          ? c.mutedText
          : status === "update-available"
            ? c.warning
            : c.success,
    });

    const styleName = doc.createElement("span");
    styleName.textContent = style.name;
    Object.assign(styleName.style, { fontSize: "14px", fontWeight: "600" });

    nameRow.appendChild(statusIndicator);
    nameRow.appendChild(styleName);

    if (status === "up-to-date") {
      const badge = doc.createElement("span");
      badge.textContent = getString("badge-latest");
      Object.assign(badge.style, {
        fontSize: "11px",
        color: c.success,
        backgroundColor: c.badgeOkBg,
        border: `1px solid ${c.badgeOkBdr}`,
        borderRadius: "10px",
        padding: "1px 8px",
        fontWeight: "500",
        alignSelf: "center",
        whiteSpace: "nowrap",
      });
      nameRow.appendChild(badge);
    }

    if (status === "update-available") {
      const badge = doc.createElement("span");
      badge.textContent = getString("badge-update");
      Object.assign(badge.style, {
        fontSize: "11px",
        color: c.warning,
        backgroundColor: c.badgeUpdBg,
        border: `1px solid ${c.badgeUpdBdr}`,
        borderRadius: "10px",
        padding: "1px 8px",
        fontWeight: "500",
        alignSelf: "center",
        whiteSpace: "nowrap",
      });
      nameRow.appendChild(badge);
    }

    leftContainer.appendChild(nameRow);

    const dateInfo = doc.createElement("div");
    Object.assign(dateInfo.style, {
      fontSize: "11px",
      marginTop: "3px",
      paddingLeft: "24px",
    });

    if (status === "not-installed") {
      dateInfo.textContent = getString("date-available", {
        args: { date: fmt(style.remoteDate) },
      });
      dateInfo.style.color = c.mutedText;
    } else if (status === "update-available") {
      dateInfo.textContent = getString("date-update", {
        args: {
          installedDate: fmt(installedDate),
          newDate: fmt(style.remoteDate),
        },
      });
      dateInfo.style.color = c.warning;
    } else {
      dateInfo.textContent = getString("date-installed", {
        args: { date: fmt(installedDate) },
      });
      dateInfo.style.color = c.mutedText;
    }
    leftContainer.appendChild(dateInfo);

    const btnColor =
      status === "not-installed"
        ? c.success
        : status === "update-available"
          ? c.warning
          : c.btnDisabled;
    const btnLabel =
      status === "not-installed"
        ? getString("btn-install")
        : status === "update-available"
          ? getString("btn-update")
          : getString("btn-reinstall");

    const installButton = doc.createElement("button");
    installButton.setAttribute("type", "button");
    installButton.textContent = btnLabel;
    Object.assign(installButton.style, {
      padding: "5px 14px",
      backgroundColor: "transparent",
      color: c.btnText,
      border: `2px solid ${btnColor}`,
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "13px",
      fontWeight: "600",
      flexShrink: "0",
      marginLeft: "12px",
      alignSelf: "center",
      whiteSpace: "nowrap",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      opacity: status === "up-to-date" ? "0.5" : "1",
    });

    installButton.addEventListener("click", async () => {
      await onInstall(style, installButton, styleRow);
    });

    styleRow.appendChild(leftContainer);
    styleRow.appendChild(installButton);
    return styleRow;
  }

  // ─── UI: Prefs Panel ──────────────────────────────────────────

  /**
   * Read-only list of the styles we have installed, drawn from the ownership
   * ledger. Used during the offline tolerance window, when the style list
   * cannot be fetched and nothing can be installed anyway.
   */
  public renderInstalledFromLedger(doc: Document, container: HTMLElement) {
    container.innerHTML = "";
    for (const entry of styleLedger.read()) {
      const row = doc.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "10px 8px",
        fontSize: "14px",
      });
      const mark = doc.createElement("span");
      mark.textContent = "✓";
      const name = doc.createElement("span");
      name.textContent = entry.title;
      name.style.fontWeight = "600";
      row.appendChild(mark);
      row.appendChild(name);
      container.appendChild(row);
    }
  }

  public async renderStylesInPrefs(
    doc: Document,
    win: Window,
    container: HTMLElement,
    statusEl: HTMLElement,
    creds: StyleCredentials,
  ) {
    container.innerHTML = "";
    statusEl.textContent = getString("status-loading-styles");
    statusEl.style.color = getColors(win).neutral;

    const styles = await this.fetchRemoteStyles(creds);

    if (styles.length === 0) {
      statusEl.textContent = getString("status-no-styles");
      statusEl.style.color = getColors(win).error;
      return;
    }

    statusEl.textContent = getString(
      styles.length === 1
        ? "status-styles-found"
        : "status-styles-found-plural",
      { args: { count: styles.length } },
    );
    statusEl.style.color = getColors(win).success;
    container.innerHTML = "";

    const render = () => {
      container.innerHTML = "";
      for (const style of styles) {
        const row = this.buildStyleRow(doc, win, style, async (s, btn) => {
          btn.textContent = getString("btn-installing");
          btn.setAttribute("disabled", "true");
          try {
            const content = await this.fetchRemoteStyleContent(
              s.id,
              creds,
              s.hash,
            );
            const installed = await this.installStyleToZotero(
              s.id,
              content,
              win,
            );
            if (!installed) {
              render();
              return;
            }
            statusEl.textContent = getString("status-installed-ok", {
              args: { name: s.name },
            });
            statusEl.style.color = getColors(win).success;
            render();
          } catch (e) {
            csLog("ERROR", "Install error:", e);
            btn.textContent = getString("btn-failed");
            btn.style.borderColor = getColors(win).error;
            btn.removeAttribute("disabled");
            statusEl.textContent = getString("status-install-failed", {
              args: { name: s.name },
            });
            statusEl.style.color = getColors(win).error;
          }
        });
        container.appendChild(row);
      }
    };

    render();
  }
}

export const customStylesManager = new CustomStylesManager();
