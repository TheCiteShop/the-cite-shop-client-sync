import { csLog } from "../utils/logger";

const PREF_LICENSE_KEY = "extensions.theciteshop.licenseKey";
const PREF_EMAIL = "extensions.theciteshop.email";
const PREF_ZOTERO_USER_ID = "extensions.theciteshop.zoteroUserId";
const PREF_CACHE_VALID = "extensions.theciteshop.cacheValid";
const PREF_CACHE_EXPIRY = "extensions.theciteshop.cacheExpiry";

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const WARN_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 15_000;

export interface LicenseCredentials {
  email: string;
  licenseKey: string;
  zoteroUserId: string;
}

export interface LicenseStatus {
  valid: boolean;
  reason?: string;
  styles?: string[];
  fromGrace?: boolean;
}

export class LicenseManager {
  // ─── Zotero User ID ───────────────────────────────────────────

  getZoteroUserId(): string | null {
    try {
      const zotero = ztoolkit.getGlobal("Zotero");
      const id = zotero.Users.getCurrentUserID();
      return id ? String(id) : null;
    } catch (e) {
      csLog("ERROR", "getZoteroUserId error:", e);
      return null;
    }
  }

  // ─── Credential Storage ───────────────────────────────────────

  saveCredentials(email: string, licenseKey: string) {
    Zotero.Prefs.set(PREF_EMAIL, email);
    Zotero.Prefs.set(PREF_LICENSE_KEY, licenseKey);
  }

  loadCredentials(): { email: string; licenseKey: string } | null {
    const email = Zotero.Prefs.get(PREF_EMAIL) as string;
    const licenseKey = Zotero.Prefs.get(PREF_LICENSE_KEY) as string;
    if (!email || !licenseKey) return null;
    return { email, licenseKey };
  }

  clearCredentials() {
    Zotero.Prefs.clear(PREF_EMAIL);
    Zotero.Prefs.clear(PREF_LICENSE_KEY);
    Zotero.Prefs.clear(PREF_CACHE_VALID);
    Zotero.Prefs.clear(PREF_CACHE_EXPIRY);
  }

  // ─── Cache ────────────────────────────────────────────────────

  private setCacheValid(styles: string[]) {
    Zotero.Prefs.set(PREF_CACHE_VALID, JSON.stringify(styles));
    Zotero.Prefs.set(PREF_CACHE_EXPIRY, String(Date.now() + CACHE_TTL_MS));
  }

  private getCachedStatus(): LicenseStatus | null {
    try {
      const expiry = Number(Zotero.Prefs.get(PREF_CACHE_EXPIRY));
      const cached = Zotero.Prefs.get(PREF_CACHE_VALID) as string;
      if (!expiry || !cached) return null;
      if (Date.now() > expiry) return null;
      return { valid: true, styles: JSON.parse(cached) };
    } catch (e) {
      return null;
    }
  }

  private getCachedStatusWithGrace(): LicenseStatus | null {
    try {
      const expiry = Number(Zotero.Prefs.get(PREF_CACHE_EXPIRY));
      const cached = Zotero.Prefs.get(PREF_CACHE_VALID) as string;
      if (!expiry || !cached) return null;
      if (Date.now() > expiry + GRACE_PERIOD_MS) return null;
      const isInGrace = Date.now() > expiry;
      return { valid: true, styles: JSON.parse(cached), fromGrace: isInGrace };
    } catch (e) {
      return null;
    }
  }

  isCacheExpiringSoon(): boolean {
    const expiry = Number(Zotero.Prefs.get(PREF_CACHE_EXPIRY));
    if (!expiry) return true;
    return Date.now() > expiry - WARN_BEFORE_MS;
  }

  isCacheInGrace(): boolean {
    const expiry = Number(Zotero.Prefs.get(PREF_CACHE_EXPIRY));
    if (!expiry) return false;
    const now = Date.now();
    return now > expiry && now <= expiry + GRACE_PERIOD_MS;
  }

  getCacheExpiryDate(): Date | null {
    const expiry = Number(Zotero.Prefs.get(PREF_CACHE_EXPIRY));
    return expiry ? new Date(expiry) : null;
  }

  // ─── Validation ───────────────────────────────────────────────

  async validate(
    credentials: LicenseCredentials,
    forceRefresh = false,
  ): Promise<LicenseStatus> {
    csLog(
      "INFO",
      `License validation requested — forceRefresh: ${forceRefresh}`,
    );

    if (!forceRefresh) {
      const cached = this.getCachedStatus();
      if (cached) {
        csLog("INFO", "License validation served from cache");
        return cached;
      }
    }

    if (!credentials.zoteroUserId) {
      return {
        valid: false,
        reason:
          "Please log in to your Zotero account at zotero.org to use purchased styles.",
      };
    }

    try {
      const zotero = ztoolkit.getGlobal("Zotero");
      const timeout = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Request timed out")),
          REQUEST_TIMEOUT,
        ),
      );

      const response = (await Promise.race([
        zotero.HTTP.request("POST", `${API_BASE}/license/validate`, {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: credentials.email,
            license_key: credentials.licenseKey,
            zotero_user_id: credentials.zoteroUserId,
          }),
          responseType: "json",
        }),
        timeout,
      ])) as any;

      const data = response.response as unknown as {
        valid: boolean;
        reason?: string;
        styles?: string[];
      };

      if (data.valid) {
        csLog(
          "INFO",
          `License validated via API — styles count: ${data.styles?.length ?? 0}`,
        );
        this.setCacheValid(data.styles ?? []);
        return { valid: true, styles: data.styles ?? [] };
      } else {
        Zotero.Prefs.clear(PREF_CACHE_VALID);
        Zotero.Prefs.clear(PREF_CACHE_EXPIRY);
        return {
          valid: false,
          reason: data.reason ?? "License validation failed.",
        };
      }
    } catch (e: any) {
      // Zotero.HTTP.request throws on non-2xx; check for a 429 with a reason
      if (e?.status === 429 || e?.xmlhttp?.status === 429) {
        const xhr = e?.xmlhttp ?? e;
        let reason: string | undefined;
        try {
          const body =
            typeof xhr.response === "string"
              ? JSON.parse(xhr.response)
              : xhr.response;
          reason = body?.reason;
        } catch {
          /* ignore parse errors */
        }
        csLog("WARN", "License validation rejected with 429:", reason ?? e);
        return {
          valid: false,
          reason: reason ?? "Too many requests. Please try again later.",
        };
      }

      csLog(
        "ERROR",
        "License validation error — attempting grace period fallback:",
        e,
      );

      const grace = this.getCachedStatusWithGrace();
      if (grace) {
        csLog(
          "WARN",
          grace.fromGrace
            ? "Server unreachable — serving from grace period (cache expired)"
            : "Server unreachable — serving from valid cache",
        );
        return grace;
      }

      return {
        valid: false,
        reason:
          "Could not reach the license server. Please check your connection.",
      };
    }
  }
}

export const licenseManager = new LicenseManager();

export const API_BASE = "https://theciteshop.com/wp-json/theciteshop/v1";
