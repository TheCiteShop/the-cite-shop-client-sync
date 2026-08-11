import { csLog } from "../utils/logger";
import { FluentMessageId } from "../../typings/i10n";

const PREF_LICENSE_KEY = "extensions.theciteshop.licenseKey";
const PREF_EMAIL = "extensions.theciteshop.email";
/**
 * Last known entitled style list. The pref *string* still says "cacheValid"
 * for continuity, but this is no longer a TTL cache — there is no TTL any
 * more. It exists only so the prefs pane can render during the offline
 * tolerance window. The tolerance clock itself lives in PREF_LAST_SYNC_OK.
 */
const PREF_ENTITLEMENT = "extensions.theciteshop.cacheValid";
/** Epoch ms of the last *authoritative* successful validation. */
const PREF_LAST_SYNC_OK = "extensions.theciteshop.lastSyncOk";
/** Obsolete: the 14-day TTL that the subscription model replaced. */
const PREF_OBSOLETE_CACHE_EXPIRY = "extensions.theciteshop.cacheExpiry";

const REQUEST_TIMEOUT = 15_000;
const DEFAULT_API_BASE = "https://theciteshop.com/wp-json/theciteshop/v1";

/**
 * Dev-only override so tests can point at a local stub server. Gated on
 * __env__ so a production build cannot be coerced into a different backend.
 */
export function getApiBase(): string {
  if (__env__ === "development") {
    const override = Zotero.Prefs.get("extensions.theciteshop.debug.apiBase");
    if (typeof override === "string" && override) return override;
  }
  return DEFAULT_API_BASE;
}

export interface LicenseCredentials {
  email: string;
  licenseKey: string;
  zoteroUserId: string;
}

export type LicenseOutcome =
  | "active"
  | "expired"
  | "invalid-credentials"
  | "rate-limited"
  | "server-error"
  | "unreachable"
  | "no-zotero-user";

export interface ValidationResult {
  outcome: LicenseOutcome;
  /** Entitled style ids, only when outcome is "active". */
  styles?: string[];
  /** Server-supplied human-readable message; preferred when present. */
  reasonText?: string;
  /** Client-side fallback message key. */
  reasonKey?: FluentMessageId;
}

/**
 * Pure, I/O-free mapping from an HTTP response to an outcome.
 *
 * This is the highest-risk logic in the plugin — it decides whether a
 * customer's files get deleted — so it is exported and unit-tested rather
 * than buried in a catch block.
 */
export function classifyResponse(status: number, body: any): LicenseOutcome {
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  if (!body || typeof body !== "object") return "server-error";

  // Current contract: the server explicitly asserts it looked this up. The
  // `authoritative` flag is what distinguishes a real entitlement decision
  // from a WAF/CDN/proxy response we must not act on.
  if (body.authoritative === true) {
    switch (body.status) {
      case "active":
        return "active";
      case "expired":
        return "expired";
      case "invalid":
        return "invalid-credentials";
      default:
        return "server-error";
    }
  }

  // Legacy backend with no `status` field. Deliberately asymmetric: an old
  // server may still grant access, but must never be able to trigger a mass
  // uninstall. `valid: false` therefore degrades to server-error, not expired.
  if (body.status === undefined) {
    return body.valid === true ? "active" : "server-error";
  }

  return "server-error";
}

function reasonKeyFor(outcome: LicenseOutcome): FluentMessageId | undefined {
  switch (outcome) {
    case "expired":
      return "status-subscription-expired";
    case "invalid-credentials":
      return "status-license-invalid";
    case "rate-limited":
      return "status-rate-limited";
    case "server-error":
      return "status-server-error";
    case "unreachable":
      return "status-server-unreachable";
    case "no-zotero-user":
      return "status-no-zotero";
    default:
      return undefined;
  }
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

  /**
   * Clears credentials and all license state. Deliberately does NOT touch the
   * style ledger — that is cleared by styleLedger.removeAll() as a consequence
   * of successful removal, so a partial failure leaves retryable entries.
   */
  clearCredentials() {
    Zotero.Prefs.clear(PREF_EMAIL);
    Zotero.Prefs.clear(PREF_LICENSE_KEY);
    this.clearEntitlement();
    this.clearLastSyncOk();
  }

  // ─── Tolerance clock ──────────────────────────────────────────

  getLastSyncOk(): number | null {
    const raw = Number(Zotero.Prefs.get(PREF_LAST_SYNC_OK));
    if (!raw || Number.isNaN(raw)) return null;
    // A future timestamp (clock skew, timezone edit) would otherwise freeze
    // the tolerance clock indefinitely.
    if (raw > Date.now()) {
      csLog("WARN", "lastSyncOk is in the future — clamping to now");
      this.setLastSyncOk(Date.now());
      return Date.now();
    }
    return raw;
  }

  setLastSyncOk(ms: number) {
    Zotero.Prefs.set(PREF_LAST_SYNC_OK, String(ms));
  }

  clearLastSyncOk() {
    Zotero.Prefs.clear(PREF_LAST_SYNC_OK);
  }

  // ─── Entitlement snapshot ─────────────────────────────────────

  /** Pure pref read — no TTL, no network. Renders the pane during tolerance. */
  getEntitlementSnapshot(): string[] | null {
    try {
      const raw = Zotero.Prefs.get(PREF_ENTITLEMENT);
      if (typeof raw !== "string" || !raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      csLog("ERROR", "Entitlement snapshot unreadable:", e);
      return null;
    }
  }

  setEntitlement(styles: string[]) {
    Zotero.Prefs.set(PREF_ENTITLEMENT, JSON.stringify(styles));
  }

  clearEntitlement() {
    Zotero.Prefs.clear(PREF_ENTITLEMENT);
  }

  /** One-shot cleanup of prefs the subscription model retired. */
  migrate() {
    try {
      if (Zotero.Prefs.get(PREF_OBSOLETE_CACHE_EXPIRY) !== undefined) {
        Zotero.Prefs.clear(PREF_OBSOLETE_CACHE_EXPIRY);
        csLog("INFO", "Cleared obsolete cacheExpiry pref");
      }
    } catch (e) {
      csLog("WARN", "Pref migration skipped:", e);
    }
  }

  // ─── Validation ───────────────────────────────────────────────

  /**
   * Resolves for every HTTP status (successCodes: false), so the promise
   * settling is itself the discriminator:
   *   resolved → we reached the server; read status + body
   *   rejected → we did not reach it (offline, DNS, refused, timeout)
   *
   * This replaces the old `e?.status ?? e?.xmlhttp?.status` sniffing, under
   * which a 401/403 fell into the catch and silently degraded to success.
   */
  private async requestValidation(
    c: LicenseCredentials,
  ): Promise<{ status: number; body: any } | null> {
    try {
      const xhr = await Zotero.HTTP.request(
        "POST",
        `${getApiBase()}/license/validate`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: c.email,
            license_key: c.licenseKey,
            zotero_user_id: c.zoteroUserId,
          }),
          responseType: "json",
          successCodes: false,
          timeout: REQUEST_TIMEOUT,
          // Zotero retries 5xx for up to an hour by default. On the startup
          // path that would leave an orphaned XHR running long after the
          // check returned.
          errorDelayMax: 0,
          noCache: true,
        },
      );
      return { status: xhr.status, body: xhr.response };
    } catch (e) {
      csLog("WARN", "License request did not reach the server:", e);
      return null;
    }
  }

  /** Always hits the network. There is no cache path — no sync, no use. */
  async validateAuthoritative(
    credentials: LicenseCredentials,
  ): Promise<ValidationResult> {
    if (__env__ === "development") {
      const forced = Zotero.Prefs.get(
        "extensions.theciteshop.debug.forceOutcome",
      );
      if (typeof forced === "string" && forced) {
        csLog("WARN", `DEBUG: forcing license outcome "${forced}"`);
        const outcome = forced as LicenseOutcome;
        return { outcome, reasonKey: reasonKeyFor(outcome) };
      }
    }

    if (!credentials.zoteroUserId) {
      return { outcome: "no-zotero-user", reasonKey: "status-no-zotero" };
    }

    const response = await this.requestValidation(credentials);
    if (!response) {
      return {
        outcome: "unreachable",
        reasonKey: "status-server-unreachable",
      };
    }

    const body = response.body;
    const outcome = classifyResponse(response.status, body);
    const reasonText =
      body && typeof body.reason === "string" ? body.reason : undefined;

    csLog("INFO", `License validation → ${outcome} (HTTP ${response.status})`);

    if (outcome === "active") {
      const styles: string[] = Array.isArray(body?.styles) ? body.styles : [];
      this.setLastSyncOk(Date.now());
      this.setEntitlement(styles);
      return { outcome, styles, reasonText };
    }

    // Only an authoritative verdict clears state. Transient failures must
    // leave the tolerance clock and the snapshot intact.
    if (outcome === "expired" || outcome === "invalid-credentials") {
      this.clearLastSyncOk();
      this.clearEntitlement();
    }

    return { outcome, reasonText, reasonKey: reasonKeyFor(outcome) };
  }
}

export const licenseManager = new LicenseManager();
