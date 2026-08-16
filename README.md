# WebLime

WebLime öffnet komplette Projektordner im Browser und macht sie sofort durchsuchbar. Das Frontend läuft ohne Framework oder Build-Schritt auf GitHub Pages. Dateien bleiben entweder nur im lokalen Browser oder werden über einen geschützten Cloudflare Worker in R2 synchronisiert.

## Funktionen

- Projektordner und einzelne Dateien per Auswahl oder Drag & Drop öffnen
- projektweite Volltextsuche in einem Web Worker
- Regex, Groß-/Kleinschreibung, Wortsuche und Include-/Exclude-Globs
- schnelle Datei-, Symbol- und Zeilennavigation
- virtualisierte Darstellung großer Textdateien
- Vorschau für Bilder, Audio, Video und PDF
- lokaler Suchindex in IndexedDB
- optionaler Cloud-Sync über einen privaten R2-Bucket
- Offline-App-Shell über Service Worker
- responsive Bedienung auf Desktop, Tablet und Mobilgerät

## Tastenkürzel

| Funktion | Taste |
|---|---|
| Datei öffnen | `Strg+P` |
| Befehlspalette | `Strg+Shift+P` |
| Im ganzen Projekt suchen | `Strg+Shift+F` |
| In aktueller Datei suchen | `Strg+F` |
| Zu Zeile springen | `Strg+G` |
| Zu Symbol springen | `Strg+R` |
| Projektleiste ein-/ausblenden | `Strg+B` |
| Tab schließen | `Strg+W` |

## Lokal testen

```powershell
node dev-server.js
```

Danach `http://localhost:8777` öffnen. Ein Doppelklick auf `index.html` reicht nicht, weil Web Worker, IndexedDB und Service Worker eine HTTP-Adresse benötigen.

## Kostenlos über GitHub Pages veröffentlichen

Das Repository enthält bereits `.github/workflows/pages.yml`. Bei jedem Push auf `main` wird nur das fertige Frontend veröffentlicht; Worker-Code und Entwicklungsdateien landen nicht in der Website.

1. Ein neues GitHub-Repository erstellen.
2. Diesen Ordner als Repository hochladen und auf den Branch `main` pushen.
3. In GitHub **Settings → Pages** öffnen.
4. Unter **Build and deployment** als Quelle **GitHub Actions** wählen.
5. Unter **Actions** warten, bis der Workflow **GitHub Pages** erfolgreich ist.

Die Website ist anschließend unter `https://DEIN-NAME.github.io/REPOSITORY/` erreichbar.

## Optional: Cloud-Speicher mit Cloudflare R2

Ohne Cloud-Backend funktioniert WebLime vollständig lokal. Für geräteübergreifenden Sync werden ein R2-Bucket und der Worker aus `worker/` benötigt.

Aktuelle Free-Tier-Größenordnungen:

- R2 Standard: 10 GB-Monate Speicher, 1 Million Class-A- und 10 Millionen Class-B-Operationen pro Monat
- Workers Free: 100.000 Anfragen pro Tag
- ausgehender R2-Datenverkehr ist kostenlos

R2 wird über einen Checkout aktiviert. Nutzung oberhalb der Freigrenzen kann berechnet werden.

### Einrichten

```powershell
npx wrangler@latest login
npx wrangler@latest r2 bucket create weblime
cd worker
npx wrangler@latest secret put AUTH_TOKEN
npx wrangler@latest deploy
```

Für `AUTH_TOKEN` ein langes zufälliges Token verwenden, zum Beispiel:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Vor dem Deployment in `worker/wrangler.toml` die erlaubte Herkunft exakt eintragen. Bei GitHub Pages gehört der Repository-Pfad nicht zur Origin:

```toml
ALLOWED_ORIGIN = "https://DEIN-NAME.github.io"
```

Danach in WebLime **Sync → Cloud verbinden** öffnen und Worker-URL sowie Token eintragen. Die Worker-URL bleibt auf dem Gerät gespeichert; das Token nur bis zum Schließen des Browsers.

## Sicherheitsmodell

- Ohne gesetztes `AUTH_TOKEN` verweigert der Worker alle Dateioperationen.
- R2 ist nicht öffentlich; alle Zugriffe laufen über den Worker.
- CORS wird auf die konfigurierte Website-Origin begrenzt.
- Dateipfade werden im Browser und Worker validiert.
- Hochgeladene Dateinamen und Inhalte werden vor der HTML-Ausgabe escaped.
- Das Frontend enthält eine restriktive Content Security Policy.

Das gemeinsame Token eignet sich für einen privaten Einzelnutzer-Betrieb. Für mehrere Benutzer mit getrennten Rechten werden echte Accounts und eine zentrale Metadatenbank benötigt.

## Projektstruktur

```text
index.html                    Oberfläche und Sicherheits-Metadaten
css/style.css                 responsives Workspace-Design
js/db.js                      IndexedDB-Speicher
js/lang.js                    Sprach-Erkennung und Highlighting
js/search-worker.js           projektweite Suche
js/backend.js                 geschützter Worker-Client
js/zip.js                     begrenzter ZIP32-Export
js/app.js                     Oberfläche und Anwendungslogik
manifest.webmanifest          installierbare Web-App
sw.js                         Offline-App-Shell
.github/workflows/pages.yml   automatische GitHub-Pages-Veröffentlichung
worker/                       Cloudflare Worker vor dem privaten R2-Bucket
```

## Betriebsgrenzen

- Textdateien bis 20 MB werden lokal indexiert.
- Beim Cloud-Sync werden fehlende Textinhalte bis 5 MB automatisch in den Suchindex geladen.
- Der Browser-ZIP-Export ist zum Schutz vor Speicherabstürzen auf 400 MB und 65.535 Dateien begrenzt.
- Dateien über 40 MB werden in 20-MB-Teilen nach R2 hochgeladen.
