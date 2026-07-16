# Flight Delay Risk Alerter

An installable phone app (PWA) that tells you, on days you're flying, whether
your **departure airport** is likely to cause a delay. It's a static site hosted
free on GitHub Pages; a scheduled GitHub Action does all the data fetching and
scoring server-side and commits the result as `public/data.json`, which the app
displays.

## How it works

```
GitHub Action (cron)  ──►  scripts/fetch_and_score.py  ──►  public/data.json  ──►  PWA (GitHub Pages)
   runs server-side           FAA + NWS weather + Amadeus        committed              displays cards
```

Why server-side? GitHub Pages is static-only, the data APIs don't allow browser
CORS, and Amadeus needs an OAuth secret that must never ship in client code. The
Action runs where there's no CORS and secrets live in GitHub Secrets.

### Risk sources

| Source | What it contributes |
| --- | --- |
| **FAA NAS status** | Active ground stops, ground delay programs (GDP), closures, departure delays |
| **NWS aviation weather (TAF)** | Ceiling, visibility, thunderstorms, gusty winds at departure time |
| **Amadeus Flight Delay Prediction** *(optional)* | A statistical delay-probability bucket |

### Verdict

- **HIGH** — FAA ground stop / GDP / closure, **or** thunderstorms / IFR at departure, **or** high Amadeus probability.
- **MODERATE** — FAA delay (no stop), **or** MVFR / gusty weather, **or** moderate Amadeus probability.
- **LOW** — no active FAA events, a favorable forecast, low probability.

The job **never crashes on a failed source** — it records `ok` / `error` /
`skipped` per source and scores on whatever succeeded.

---

## Setup

### 1. Enable GitHub Pages
Push this repo to GitHub, then **Settings → Pages**:
- **Source:** *Deploy from a branch*
- **Branch:** `main`, **folder:** `/public`

Your app will be served at `https://martinmixon.github.io/flight-delay-alerter/`.

### 2. Add repo Secrets (Settings → Secrets and variables → Actions)
This build **activates Amadeus**, so add:

| Secret | Required? | Purpose |
| --- | --- | --- |
| `AMADEUS_CLIENT_ID` | yes (for Amadeus) | Amadeus Self-Service API key |
| `AMADEUS_CLIENT_SECRET` | yes (for Amadeus) | Amadeus Self-Service API secret |

Get free keys at <https://developers.amadeus.com> (Self-Service). Until they're
added, the Amadeus source reports `skipped`/`error` and the app still scores on
FAA + weather.

Optional **Variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AMADEUS_HOST` | `https://test.api.amadeus.com` | Set to `https://api.amadeus.com` for production keys |
| `LOCAL_TZ` | `America/New_York` | Timezone for the "last updated" display string |

Email alerts are **off** in this build. To turn them on later, see the commented
block at the bottom of `.github/workflows/update.yml`.

### 3. Edit your trips — `trips.json`
An array of upcoming flights:

```json
[
  {
    "iata": "ATL",
    "icao": "KATL",
    "date": "2026-07-20",
    "depart_local": "08:15",
    "airline": "DL",
    "flight": "1234",
    "arrival_iata": "LGA"
  }
]
```

- `iata` / `icao` — departure airport codes (required).
- `date` — `YYYY-MM-DD` (required).
- `depart_local` — scheduled local departure `HH:MM`, 24h (required).
- `airline` / `flight` / `arrival_iata` — optional; enable the Amadeus source.

Only trips dated **today through 2 days out** (`WINDOW_DAYS` in
`scripts/fetch_and_score.py`) are scored.

> **Amadeus note:** the prediction API also wants arrival time, aircraft type,
> and flight duration. Add `arrivalTime`, `aircraftCode`, and `duration` fields
> to a trip to get a full prediction; without them the Amadeus call degrades
> gracefully.

### 4. Install on your phone
Open the Pages URL in mobile Chrome/Safari → **Add to Home Screen**. It installs
as a standalone app and loads offline with the last cached data.

### 5. Test it
**Actions** tab → *Update delay data* → **Run workflow** (`workflow_dispatch`).
The job runs tests, fetches feeds, scores, and commits `public/data.json` if it
changed. Refresh the app to see the update.

---

## Local development

```bash
pip install -r requirements.txt
pytest -q                        # run the unit tests
python scripts/fetch_and_score.py   # fetch live data -> public/data.json
```

Serve the frontend locally:

```bash
python -m http.server -d public 8000
# open http://localhost:8000
```

Regenerate the PWA icons (only if you change the design):

```bash
python scripts/make_icons.py
```

## Tests

Offline and deterministic — they use saved API samples in `tests/fixtures/`, so
no live calls:

- `tests/test_faa_parser.py` — FAA NAS status XML parsing.
- `tests/test_taf_flags.py` — TAF forecast extraction + risk flags.
- `tests/test_scoring.py` — the source-combining verdict.

## Repo layout

```
public/                 # served by GitHub Pages
  index.html app.js styles.css
  manifest.webmanifest service-worker.js
  icons/                # PWA icons (192, 512, maskable)
  data.json             # GENERATED by the Action
scripts/
  fetch_and_score.py    # the backend job
  make_icons.py         # icon generator (dev-only)
tests/                  # offline unit tests + fixtures
trips.json              # your upcoming trips
.github/workflows/update.yml
requirements.txt
```
