# The Cite Shop Client Sync — Zotero-Plugin

Ein Zotero-Plugin, mit dem Sie Ihre gekauften Zitierstile direkt in Zotero installieren und verwalten können.

## Voraussetzungen

- Zotero 7 oder neuer
- Ein aktives Abonnement (erhältlich auf [theciteshop.com](https://theciteshop.com))
- Ein Zotero-Konto (zotero.org) — Ihre Lizenz ist an dieses Konto gebunden und funktioniert auf beliebig vielen Geräten
- Eine regelmäßige Internetverbindung — siehe [Abonnement und Offline-Nutzung](#abonnement-und-offline-nutzung)

## Installation

1. Laden Sie die aktuelle `.xpi`-Datei von der [Releases-Seite](https://github.com/TheCiteShop/theciteshop-client-sync/releases) herunter
2. Öffnen Sie in Zotero **Werkzeuge → Plugins**
3. Klicken Sie auf das Zahnrad-Symbol und wählen Sie **Plugin aus Datei installieren…**
4. Wählen Sie die heruntergeladene `.xpi`-Datei aus
5. Starten Sie Zotero neu, wenn Sie dazu aufgefordert werden

## Erste Verwendung

Nach der Installation öffnet Zotero automatisch den Einstellungsbereich **The Cite Shop Client Sync**.

1. Geben Sie die **E-Mail-Adresse** ein, mit der Sie Ihre Lizenz erworben haben
2. Geben Sie Ihren **Lizenzschlüssel** ein
3. Klicken Sie auf **Lizenz prüfen**
4. Ihre gekauften Stile werden angezeigt — klicken Sie neben jedem Stil auf **Installieren**

## Stile aktualisieren

Wenn aktualisierte Versionen Ihrer Stile verfügbar sind:

1. Öffnen Sie **Einstellungen → Meine Zitierstile** in Zotero
2. Klicken Sie auf **Nach Updates suchen**
3. Stile mit verfügbaren Updates werden mit dem Badge **Update verfügbar** markiert
4. Klicken Sie neben dem jeweiligen Stil auf **Aktualisieren**

## Abonnement und Offline-Nutzung

Die von diesem Plugin installierten Stile sind an ein aktives Abonnement gebunden.

- Das Plugin prüft Ihre Lizenz beim Start von Zotero, einmal täglich während der
  Laufzeit und immer dann, wenn Sie den Einstellungsbereich öffnen.
- **Sie können bis zu 3 Tage offline arbeiten.** War in diesem Zeitraum keine
  Lizenzprüfung erfolgreich, werden Ihre gekauften Stile aus Zotero entfernt und
  Sie erhalten eine Benachrichtigung mit der Begründung. Stellen Sie eine
  Verbindung her und öffnen Sie die Einstellungen, um sie neu zu installieren.
- Endet Ihr Abonnement oder wird es erstattet bzw. widerrufen, werden Ihre
  gekauften Stile bei der nächsten Prüfung entfernt.
- Auch das Löschen der Zugangsdaten oder das Deinstallieren des Plugins entfernt sie.

Es werden ausschließlich Stile entfernt, die dieses Plugin installiert hat.
Stile, die Sie selbst aus dem öffentlichen Zotero-Stilverzeichnis installiert
haben, bleiben unberührt. Würde ein gekaufter Stil einen vorhandenen ersetzen,
fragt das Plugin vorher nach.

## Fehlerbehebung

**„Bitte zuerst bei Ihrem Zotero-Konto anmelden"**
→ Öffnen Sie Zotero, gehen Sie zu **Bearbeiten → Einstellungen → Synchronisierung** und melden Sie sich mit Ihrem zotero.org-Konto an.

**„E-Mail stimmt nicht mit diesem Lizenzschlüssel überein"**
→ Stellen Sie sicher, dass Sie dieselbe E-Mail-Adresse verwenden, mit der Sie den Kauf getätigt haben.

**„Meine Stile sind verschwunden"**
→ Dafür gibt es drei mögliche Gründe: Ihr Abonnement ist beendet; das Plugin
konnte den Lizenzserver länger als 3 Tage nicht erreichen; oder die Zugangsdaten
wurden gelöscht. Öffnen Sie **Einstellungen → The Cite Shop Client Sync** — die
Statusmeldung nennt den Grund.

## Support

Bei Lizenzproblemen oder Fragen wenden Sie sich bitte an: info@theciteshop.com
