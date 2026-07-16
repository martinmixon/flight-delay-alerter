# Trip write-proxy Worker (Cloudflare)

This tiny Cloudflare Worker lets the app save trips **without opening GitHub**.
The app POSTs your trip list here with a shared app key; the Worker verifies it
and commits `trips.json` to the repo using a GitHub token kept as a **server-side
secret**. Committing `trips.json` triggers the scoring Action. No secret ever
touches your phone.

```
App  ──POST {trips} + app key──►  Worker (holds GitHub token)  ──commit──►  trips.json  ──►  Action scores
```

## One-time setup (~10 minutes)

### 1. Create a GitHub token for the Worker
GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**:
- **Repository access:** Only select repositories → `flight-delay-alerter`.
- **Permissions:** Repository permissions → **Contents: Read and write**.
- Generate and copy the token (starts with `github_pat_…`).

### 2. Pick an app key
Any long random string (e.g. run `openssl rand -hex 24`, or mash the keyboard).
You'll give this same value to both the Worker and the app. It's what stops
strangers from writing to your repo.

### 3. Deploy the Worker
With [Node.js](https://nodejs.org) installed, from this `worker/` folder:

```bash
npm install -g wrangler        # one-time
wrangler login                 # opens a browser to authorize Cloudflare
wrangler secret put GITHUB_TOKEN   # paste the token from step 1
wrangler secret put APP_KEY        # paste the app key from step 2
wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://flight-trips.<your-subdomain>.workers.dev`.

> Prefer the dashboard? Create a Worker at dash.cloudflare.com, paste
> `worker.js`, add the two secrets and the `[vars]` under Settings → Variables,
> and deploy. Same result.

### 4. Tell the app
Open the site → **Manage trips → Cloud settings**, paste the **Worker URL** and
the **app key**, and Save. Now **Save & score** in the app writes your trips and
the cards update about a minute later.

## Config

`wrangler.toml` `[vars]` (non-secret): `REPO`, `ALLOW_ORIGIN` (your Pages
origin), `BRANCH`, `TRIPS_PATH`. Secrets (`GITHUB_TOKEN`, `APP_KEY`) are set via
`wrangler secret put` and never committed.

## Security notes

- The GitHub token lives only in Cloudflare's secret store, never in the app or
  this repo.
- The app key is the only thing in your browser; it can do exactly one thing —
  write `trips.json` to this one repo through the Worker. Rotate it anytime by
  re-running `wrangler secret put APP_KEY` and updating the app.
- The Worker validates every trip and caps the count, and only allows requests
  from your site's origin.
