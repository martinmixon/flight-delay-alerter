// Flight Delay Alerter — frontend. Fetches the Action-generated data.json and
// renders one card per upcoming trip. No frameworks; vanilla JS.

const tripsEl = document.getElementById("trips");
const updatedEl = document.getElementById("updated");
const refreshBtn = document.getElementById("refresh");

const VERDICT_CLASS = { HIGH: "high", MODERATE: "moderate", LOW: "low" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function loadData() {
  refreshBtn.disabled = true;
  try {
    // Cache-bust so we always see the latest committed data.json.
    const res = await fetch(`./data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
    renderError(err);
  } finally {
    refreshBtn.disabled = false;
  }
}

function render(data) {
  const trips = Array.isArray(data.trips) ? data.trips : [];
  if (trips.length === 0) {
    tripsEl.innerHTML = `
      <div class="empty">
        <span class="emoji" aria-hidden="true">🛫</span>
        <p>No trips within the next ${esc(data.window_days ?? 2)} days.</p>
        <p>Add upcoming flights to <code>trips.json</code> and you'll see their
        departure risk here.</p>
      </div>`;
  } else {
    tripsEl.innerHTML = trips.map(card).join("");
  }
  updatedEl.textContent = data.generated_local
    ? `Updated ${data.generated_local}`
    : "";
}

function card(t) {
  const v = String(t.verdict || "LOW").toUpperCase();
  const cls = VERDICT_CLASS[v] || "low";
  const route = t.arrival_iata ? `${esc(t.iata)} → ${esc(t.arrival_iata)}` : esc(t.iata);
  const flight = [t.airline, t.flight].filter(Boolean).join(" ");
  const when = `${esc(t.date)} · ${esc(t.depart_local)} local`;

  const reasons = (t.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("");

  return `
    <article class="card ${cls}">
      <div class="card-top">
        <div class="route">
          <div class="airport">${route}</div>
          <div class="route-detail">${when}${flight ? " · " + esc(flight) : ""}</div>
        </div>
        <span class="badge ${cls}">${esc(v)}</span>
      </div>
      <ul class="reasons">${reasons}</ul>
      ${detail(t)}
    </article>`;
}

function detail(t) {
  const w = t.weather || {};
  const f = t.faa || {};
  const a = t.amadeus || {};
  const s = t.sources || {};
  const rows = [];

  // Weather
  if (s.weather === "ok" && w.flight_category) {
    const bits = [`<strong>${esc(w.flight_category)}</strong>`];
    if (w.ceiling_ft != null) bits.push(`ceiling ${esc(w.ceiling_ft)} ft`);
    if (w.vis_mi != null) bits.push(`vis ${esc(w.vis_mi)} mi`);
    if (w.ts) bits.push("TS");
    if (w.gust_kt != null) bits.push(`gust ${esc(w.gust_kt)} kt`);
    rows.push(row("Weather", bits.join(" · "), s.weather));
  } else {
    rows.push(row("Weather", srcText(s.weather), s.weather));
  }

  // FAA
  if (s.faa === "ok") {
    let faaText = "No active events";
    if (f.ground_stop) faaText = "Ground stop";
    else if (f.gdp) faaText = "Ground delay program";
    else if (f.closure) faaText = "Airport closure";
    else if (f.delay) faaText = `Departure delay ${esc(f.delay)}`;
    if (f.reason && (f.ground_stop || f.gdp || f.closure || f.delay)) {
      faaText += ` — ${esc(f.reason)}`;
    }
    rows.push(row("FAA", faaText, s.faa));
  } else {
    rows.push(row("FAA", srcText(s.faa), s.faa));
  }

  // Amadeus
  let amText;
  if (a.available && a.probability_bucket) {
    amText = `${esc(a.probability_bucket)} probability`;
    if (a.probability != null) amText += ` (${Math.round(a.probability * 100)}%)`;
  } else {
    amText = srcText(s.amadeus);
  }
  rows.push(row("Amadeus", amText, s.amadeus));

  // Raw TAF, if present
  const taf = w.taf_raw
    ? `<div class="detail"><dt>TAF</dt><dd class="taf">${esc(w.taf_raw)}</dd></div>`
    : "";

  return `<dl class="detail">${rows.join("")}</dl>${taf}`;
}

function row(label, value, status) {
  const pill = status ? `<span class="pill ${esc(status)}">${esc(status)}</span>` : "";
  return `<dt>${esc(label)}</dt><dd>${value}${pill}</dd>`;
}

function srcText(status) {
  if (status === "error") return "Data unavailable";
  if (status === "skipped") return "Not checked";
  return "—";
}

function renderError(err) {
  console.error("Failed to load data.json:", err);
  tripsEl.innerHTML = `
    <div class="error-state">
      <p>Couldn't load the latest risk data.</p>
      <p>If you're offline, the last cached data will appear once available.</p>
    </div>`;
}

refreshBtn.addEventListener("click", loadData);
loadData();

// Register the service worker for offline / installable support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) =>
      console.warn("Service worker registration failed:", e)
    );
  });
}
