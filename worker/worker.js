/**
 * Flight Delay Alerter — write-proxy Worker (Cloudflare).
 *
 * The PWA is static, so it can't safely hold a GitHub token to write trips.json.
 * This Worker does: the app POSTs its trip list here with a shared app key; the
 * Worker verifies the key and commits trips.json to the repo via the GitHub
 * Contents API using a token kept as a Worker secret. Committing trips.json
 * triggers the scoring Action. No secrets ever reach the browser.
 *
 * Secrets (set with `wrangler secret put` or in the dashboard):
 *   GITHUB_TOKEN  — fine-grained PAT, Contents: Read and write, this repo only
 *   APP_KEY       — a random string you also paste into the app's Cloud settings
 *
 * Vars (in wrangler.toml [vars]):
 *   REPO          — "owner/repo", e.g. "martinmixon/flight-delay-alerter"
 *   ALLOW_ORIGIN  — the site origin, e.g. "https://martinmixon.github.io"
 *   BRANCH        — branch to commit to (default "main")
 *   TRIPS_PATH    — path in the repo (default "trips.json")
 */

const MAX_TRIPS = 50;

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405, cors);

    // --- Auth: constant-time-ish check of the shared app key ---------------
    const auth = request.headers.get("Authorization") || "";
    const presented = auth.replace(/^Bearer\s+/i, "");
    if (!env.APP_KEY || !safeEqual(presented, env.APP_KEY)) {
      return json({ error: "Unauthorized" }, 401, cors);
    }

    // --- Validate the incoming trips --------------------------------------
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400, cors); }

    const trips = body && body.trips;
    const problem = validateTrips(trips);
    if (problem) return json({ error: problem }, 400, cors);

    // --- Commit trips.json to GitHub --------------------------------------
    const repo = env.REPO;
    const branch = env.BRANCH || "main";
    const path = env.TRIPS_PATH || "trips.json";
    const apiBase = `https://api.github.com/repos/${repo}/contents/${path}`;
    const ghHeaders = {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "flight-delay-alerter-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    try {
      // Current file SHA (needed to update an existing file).
      let sha;
      const cur = await fetch(`${apiBase}?ref=${branch}`, { headers: ghHeaders });
      if (cur.status === 200) sha = (await cur.json()).sha;
      else if (cur.status !== 404) {
        return json({ error: `GitHub read failed (${cur.status})` }, 502, cors);
      }

      const content = JSON.stringify(trips, null, 2) + "\n";
      const put = await fetch(apiBase, {
        method: "PUT",
        headers: ghHeaders,
        body: JSON.stringify({
          message: "chore: update trips from app",
          content: b64(content),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!put.ok) {
        const detail = (await put.text().catch(() => "")).slice(0, 200);
        return json({ error: `GitHub write failed (${put.status})`, detail }, 502, cors);
      }
      return json({ ok: true, count: trips.length }, 200, cors);
    } catch (e) {
      return json({ error: "Upstream error", detail: String(e).slice(0, 200) }, 502, cors);
    }
  },
};

function validateTrips(trips) {
  if (!Array.isArray(trips)) return "Body must be { trips: [...] }";
  if (trips.length > MAX_TRIPS) return `Too many trips (max ${MAX_TRIPS})`;
  for (const t of trips) {
    if (typeof t !== "object" || t === null) return "Each trip must be an object";
    if (!/^[A-Z]{3}$/.test(t.iata || "")) return "Each trip needs a 3-letter iata";
    if (!/^[A-Z]{4}$/.test(t.icao || "")) return "Each trip needs a 4-letter icao";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || "")) return "Each trip needs a YYYY-MM-DD date";
    if (!/^\d{2}:\d{2}$/.test(t.depart_local || "")) return "Each trip needs an HH:MM depart_local";
    if (t.arrival_iata && !/^[A-Z]{3}$/.test(t.arrival_iata)) return "arrival_iata must be 3 letters";
  }
  return null;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// Base64 for a UTF-8 string (btoa needs Latin-1).
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Length-constant string compare to avoid trivial timing leaks.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
