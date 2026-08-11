# The Cite Shop Client Sync — Zotero Plugin

A Zotero plugin that allows you to install and manage your purchased custom citation styles directly within Zotero.

Please download the latest version of the plugin here:
[https://github.com/TheCiteShop/theciteshop-client-sync/releases](https://github.com/TheCiteShop/theciteshop-client-sync/releases)

![The Cite Shop Client Sync - install, update, reinstall](./assets/screenshots/The%20Cite%20Shop%20Client%20Sync%20-%20install,%20update,%20reinstall.png)

## Requirements

- Zotero 7 or later
- An active subscription (purchased at [theciteshop.com](https://theciteshop.com))
- A Zotero account (zotero.org) — your license is tied to this account, and works on as many devices as you like
- A periodic internet connection — see [Subscription and offline use](#subscription-and-offline-use)

## Installation

1. Download the latest `.xpi` file from the [releases page](https://github.com/TheCiteShop/theciteshop-client-sync/releases)
2. In Zotero, go to **Tools → Plugins**
3. Click the gear icon and select **Install Plugin From File…**
4. Select the downloaded `.xpi` file
5. Restart Zotero when prompted

## First Use

After installation, Zotero will automatically open the **The Cite Shop Client Sync** settings pane. (If not, go to Edit > Settings)

1. Enter the **email address** you used to purchase your license
2. Enter your **license key**
3. Click **Verify License**
4. Your purchased styles will appear — click **Install** next to each one

## Updating Styles

When updated versions of your styles are available:

1. Open Zotero **Settings → The Cite Shop Client Sync**
2. Click **Check for Updates**
3. Any styles with updates will show an **Update available** badge
4. Click **Update** next to each style to install the latest version

More detailled instructions with screenshots can be seen on my website: [The Cite Shop Client Sync – Setup & Use](https://theciteshop.com/en/client-sync-einrichtung/)

## Subscription and offline use

Styles installed by this plugin are tied to an active subscription.

- The plugin verifies your license when Zotero starts, once a day while it is
  running, and whenever you open its settings pane.
- **You can work offline for up to 3 days.** If no license check has succeeded
  in that time, your purchased styles are removed from Zotero and you will see
  a notification explaining why. Reconnect and open the settings pane to
  reinstall them.
- If your subscription ends, is refunded, or is revoked, your purchased styles
  are removed the next time the plugin checks.
- Clearing your credentials, or uninstalling the plugin, also removes them.

Only styles this plugin installed are ever removed. Styles you installed
yourself from Zotero's public style repository are left alone. If a purchased
style would replace one you already have, the plugin asks first.

## Troubleshooting

**"Please log in to your Zotero account"**
→ Open Zotero, go to **Edit → Preferences → Sync** and sign in to your zotero.org account first.

**"Email does not match this license key"**
→ Make sure you are using the same email address you used when purchasing.

**My styles disappeared**
→ One of three things happened: your subscription ended; the plugin could not
reach the license server for more than 3 days; or the credentials were cleared.
Open **Settings → The Cite Shop Client Sync** — the status message will say
which. Once your subscription is active and you are online, verify your license
and reinstall.

## Support

For license issues or support, please contact: info@theciteshop.com

---

## Changelog

### v0.0.1

- Initial release
- License validation via email and license key
- Browse, install, and update purchased citation styles within Zotero
- Dark mode support: all UI elements adapt to Zotero's light/dark theme
- Subscription enforcement: license is re-checked at startup, daily, and when
  the settings pane is opened
- Purchased styles are removed if the subscription ends, or if no license check
  has succeeded for 3 days; only styles installed by this plugin are touched
- Auto-opens settings on first install
