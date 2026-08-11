# ── Prefs pane ──────────────────────────────────────────────────
email-placeholder = you@example.com
license-placeholder = XXXX-XXXX-XXXX-XXXX

# ── Status messages ──────────────────────────────────────────────
status-verifying = Verifying license…
status-verified = ✓ License verified
status-invalid-email = Please enter a valid email address.
status-missing-license = Please enter your license key.
status-no-zotero = Please log in to your Zotero account at zotero.org first.
status-validation-failed = License validation failed.
status-verify-error = Verification failed. Please try again.
status-credentials-cleared = Credentials cleared.
status-loading-styles = Loading styles…
status-styles-found = { $count } style found
status-styles-found-plural = { $count } styles found
status-no-styles = Style(s) not available. Please contact support at info@theciteshop.com.
status-installed-ok = ✓ "{ $name }" installed successfully
status-updated-ok = ✓ "{ $name }" updated successfully
status-install-failed = Failed to install "{ $name }"
status-all-uptodate = ✓ All styles are up to date.
status-updates-available = { $count } update(s) available — click Update to install.
status-update-failed = Update check failed. Please try again.
status-missing-credentials = Missing credentials.
status-logs-copied = ✓ Logs copied to clipboard

# ── Subscription enforcement ─────────────────────────────────────
status-subscription-expired = Your subscription has expired. Your purchased styles have been removed from Zotero. Renew at theciteshop.com to restore them.
status-license-invalid = This license is no longer valid. Your purchased styles have been removed from Zotero.
status-offline-tolerance = License server unreachable. Your styles will be removed in { $days } day(s) unless a connection is restored.
status-offline-removed = No license check has succeeded for { $days } days. Your purchased styles have been removed from Zotero.
status-rate-limited = Too many license checks. Please try again later.
status-server-unreachable = Could not reach the license server. Please check your connection.
status-server-error = The license server is temporarily unavailable. Please try again later.
status-last-synced = Last verified: { $date }
status-replace-existing = A citation style with this ID is already installed in Zotero ("{ $name }"). Installing will replace it, and it will be removed if your subscription ends. Continue?
status-logout-will-remove = Clearing your credentials will also remove { $count } purchased style(s) from Zotero. Continue?

# ── Removal notification (popup) ─────────────────────────────────
notify-removed-title = The Cite Shop
notify-removed-expired = Your subscription has ended — { $count } purchased style(s) were removed from Zotero.
notify-removed-offline = Your license could not be verified for { $days } days — { $count } purchased style(s) were removed from Zotero.
notify-removed-hint = Open Settings → The Cite Shop to sign in and restore them.

# ── Style row ────────────────────────────────────────────────────
badge-latest = Latest version
badge-update = Update available
btn-install = Install
btn-update = Update
btn-reinstall = Reinstall
btn-installing = Installing…
btn-failed = Failed
date-available = Available: { $date }
date-installed = Installed: { $date }
date-update = Installed: { $installedDate }  →  New: { $newDate }
