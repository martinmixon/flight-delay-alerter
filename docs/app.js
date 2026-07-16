// Flight Delay Alerter — frontend. Two parts:
//   1. Display: fetch the Action-generated data.json and render a card per trip.
//   2. Editor:  add/edit upcoming trips on-device (localStorage), then "Save &
//               score" posts them to the Cloudflare Worker, which commits
//               trips.json so the server-side Action scores them (no GitHub
//               visit). No frameworks; vanilla JS.

const TRIPS_KEY = "fda_trips";
const AIRPORTS_KEY = "fda_airports";       // remembered airport codes for suggestions
const WORKER_URL_KEY = "fda_worker_url";   // Cloudflare Worker endpoint
const WORKER_KEY_KEY = "fda_worker_key";   // app key sent to the Worker (this device only)

const tripsEl = document.getElementById("trips");
const updatedEl = document.getElementById("updated");
const refreshBtn = document.getElementById("refresh");

const VERDICT_CLASS = { HIGH: "high", MODERATE: "moderate", LOW: "low" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ==========================================================================
// Part 1 — display data.json
// ==========================================================================
async function loadData() {
  refreshBtn.disabled = true;
  try {
    // Cache-bust so we always see the latest committed data.json.
    const res = await fetch(`./data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
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
        <p>Add upcoming flights below (<strong>Manage trips</strong>) and they'll
        appear here once scored.</p>
      </div>`;
  } else {
    tripsEl.innerHTML = trips.map(card).join("");
  }
  updatedEl.textContent = data.generated_local ? `Updated ${data.generated_local}` : "";
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
  const s = t.sources || {};
  const rows = [];

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

// ==========================================================================
// Part 2 — trip editor
// ==========================================================================
const editorEl = document.getElementById("editor");
const toggleBtn = document.getElementById("toggle-editor");
const form = document.getElementById("trip-form");
const listEl = document.getElementById("trip-list");
const errorEl = document.getElementById("form-error");
const submitBtn = document.getElementById("form-submit");
const cancelBtn = document.getElementById("form-cancel");
const toastEl = document.getElementById("toast");
const airportListEl = document.getElementById("airport-list");
const saveCloudBtn = document.getElementById("save-cloud");
const saveStatusEl = document.getElementById("save-status");
const settingsEl = document.getElementById("settings");
const toggleSettingsBtn = document.getElementById("toggle-settings");
const sUrl = document.getElementById("s-url");
const sKey = document.getElementById("s-key");

let trips = [];
let editingIndex = null;

const TRIP_ORDER = ["iata", "icao", "date", "depart_local", "airline", "flight", "arrival_iata"];
const COMMON_AIRPORTS = ["ATL", "LGA", "JFK", "EWR", "BOS", "DCA", "ORD", "DFW", "DEN", "LAX", "SFO", "SEA"];

function loadTrips() {
  try {
    const stored = localStorage.getItem(TRIPS_KEY);
    if (stored) { trips = JSON.parse(stored); return true; }
  } catch (e) {
    console.warn("Could not read saved trips:", e);
  }
  return false;
}

function saveTrips() {
  try {
    localStorage.setItem(TRIPS_KEY, JSON.stringify(cleanTrips()));
  } catch (e) {
    console.warn("Could not save trips:", e);
  }
  renderTrips();
}

// Fetch the committed trips.json the Action publishes alongside the site, so a
// fresh device starts from the real repo state.
async function fetchCommittedTrips() {
  const res = await fetch(`./trips.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function initEditor() {
  loadSettings();
  renderAirportOptions();
  const hadLocal = loadTrips();
  if (!hadLocal) {
    try { trips = await fetchCommittedTrips(); } catch (e) { trips = []; }
  }
  saveTrips();
}

// --- Remembered airports (for the datalist suggestions) -------------------
function loadAirports() {
  try { return JSON.parse(localStorage.getItem(AIRPORTS_KEY) || "[]"); }
  catch (e) { return []; }
}
function rememberAirports(...codes) {
  const set = new Set(loadAirports());
  codes.filter(Boolean).forEach((c) => set.add(c.toUpperCase()));
  localStorage.setItem(AIRPORTS_KEY, JSON.stringify([...set]));
  renderAirportOptions();
}
function renderAirportOptions() {
  const codes = [...new Set([...loadAirports(), ...COMMON_AIRPORTS])];
  airportListEl.innerHTML = codes.map((c) => `<option value="${esc(c)}"></option>`).join("");
}

function tripLabel(t) {
  const route = t.arrival_iata ? `${t.iata} → ${t.arrival_iata}` : t.iata;
  const flight = [t.airline, t.flight].filter(Boolean).join("");
  return `${route} · ${t.date} ${t.depart_local}${flight ? " · " + flight : ""}`;
}

function renderTrips() {
  if (trips.length === 0) {
    listEl.innerHTML = `<li class="trip-empty">No trips saved yet.</li>`;
  } else {
    listEl.innerHTML = trips.map((t, i) => `
      <li class="trip-row">
        <span class="trip-text">${esc(tripLabel(t))}</span>
        <span class="trip-buttons">
          <button type="button" class="btn btn-link" data-edit="${i}">Edit</button>
          <button type="button" class="btn btn-link danger" data-del="${i}">Delete</button>
        </span>
      </li>`).join("");
  }
}

// Trips with a stable field order, dropping empty optional fields (payload shape).
function cleanTrips() {
  return trips.map((t) => {
    const out = {};
    for (const key of TRIP_ORDER) {
      const v = t[key];
      if (v !== undefined && v !== null && String(v).trim() !== "") out[key] = v;
    }
    return out;
  });
}

// Split a combined flight like "DL1234" into airline + number.
function parseFlight(raw) {
  const s = String(raw || "").toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([A-Z]{2,3})(\d{1,5})$/);
  if (m) return { airline: m[1], flight: m[2] };
  return { airline: "", flight: s };
}

function readForm() {
  const fd = new FormData(form);
  const val = (k) => String(fd.get(k) || "").trim();
  const iata = val("iata").toUpperCase();
  let icao = val("icao").toUpperCase();
  if (!icao && /^[A-Z]{3}$/.test(iata)) icao = "K" + iata;  // auto US ICAO
  const { airline, flight } = parseFlight(val("flight"));

  const trip = {
    iata,
    icao,
    date: val("date"),
    depart_local: val("depart_local"),
    airline,
    flight,
    arrival_iata: val("arrival_iata").toUpperCase(),
  };

  const errors = [];
  if (!/^[A-Z]{3}$/.test(trip.iata)) errors.push("Departure airport must be a 3-letter code.");
  if (!/^[A-Z]{4}$/.test(trip.icao)) errors.push("ICAO must be 4 letters.");
  if (!trip.date) errors.push("Date is required.");
  if (!/^\d{2}:\d{2}$/.test(trip.depart_local)) errors.push("Departure time is required.");
  if (trip.arrival_iata && !/^[A-Z]{3}$/.test(trip.arrival_iata)) {
    errors.push("Arrival must be a 3-letter code.");
  }
  return { trip, errors };
}

function showFormError(msgs) {
  errorEl.textContent = msgs.join(" ");
  errorEl.hidden = msgs.length === 0;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const { trip, errors } = readForm();
  if (errors.length) return showFormError(errors);
  showFormError([]);

  if (editingIndex === null) trips.push(trip);
  else trips[editingIndex] = trip;
  rememberAirports(trip.iata, trip.arrival_iata);
  saveTrips();
  resetForm();
});

function startEdit(i) {
  editingIndex = i;
  const t = trips[i];
  form.iata.value = t.iata || "";
  form.icao.value = t.icao || "";
  form.date.value = t.date || "";
  form.depart_local.value = t.depart_local || "";
  form.arrival_iata.value = t.arrival_iata || "";
  form.flight.value = [t.airline, t.flight].filter(Boolean).join("");
  submitBtn.textContent = "Save changes";
  cancelBtn.hidden = false;
  showFormError([]);
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function resetForm() {
  editingIndex = null;
  form.reset();
  submitBtn.textContent = "Add trip";
  cancelBtn.hidden = true;
  showFormError([]);
}

cancelBtn.addEventListener("click", resetForm);

listEl.addEventListener("click", (e) => {
  const editBtn = e.target.closest("[data-edit]");
  const delBtn = e.target.closest("[data-del]");
  if (editBtn) startEdit(Number(editBtn.dataset.edit));
  if (delBtn) {
    const i = Number(delBtn.dataset.del);
    if (confirm(`Delete ${tripLabel(trips[i])}?`)) {
      trips.splice(i, 1);
      if (editingIndex === i) resetForm();
      saveTrips();
    }
  }
});

// Suggest an ICAO (K + IATA) as the user types the departure code.
form.iata.addEventListener("input", () => {
  const iata = form.iata.value.trim().toUpperCase();
  if (!form.icao.value.trim() && /^[A-Z]{3}$/.test(iata)) form.icao.placeholder = "K" + iata;
});

// --- Cloud settings (Worker URL + app key, this device only) --------------
function loadSettings() {
  sUrl.value = localStorage.getItem(WORKER_URL_KEY) || "";
  sKey.value = localStorage.getItem(WORKER_KEY_KEY) || "";
}
document.getElementById("save-settings").addEventListener("click", () => {
  localStorage.setItem(WORKER_URL_KEY, sUrl.value.trim().replace(/\/+$/, ""));
  localStorage.setItem(WORKER_KEY_KEY, sKey.value);
  toast("Cloud settings saved.");
  settingsEl.hidden = true;
  toggleSettingsBtn.setAttribute("aria-expanded", "false");
});
toggleSettingsBtn.addEventListener("click", () => {
  const open = settingsEl.hasAttribute("hidden");
  settingsEl.hidden = !open;
  toggleSettingsBtn.setAttribute("aria-expanded", String(open));
});

function setSaveStatus(msg, kind) {
  saveStatusEl.textContent = msg;
  saveStatusEl.hidden = !msg;
  saveStatusEl.className = "save-status" + (kind ? " " + kind : "");
}

// --- Save & score: POST trips to the Worker -------------------------------
saveCloudBtn.addEventListener("click", async () => {
  const url = (localStorage.getItem(WORKER_URL_KEY) || "").trim();
  const key = localStorage.getItem(WORKER_KEY_KEY) || "";
  if (!url || !key) {
    setSaveStatus("Add your Worker URL and app key in Cloud settings first.", "error");
    settingsEl.hidden = false;
    toggleSettingsBtn.setAttribute("aria-expanded", "true");
    return;
  }
  saveCloudBtn.disabled = true;
  setSaveStatus("Saving…", "");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ trips: cleanTrips() }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 140);
      throw new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
    }
    setSaveStatus("Saved. Scoring now — results appear in about a minute.", "ok");
    // The Action needs ~a minute to score + publish; refresh the cards then.
    setTimeout(loadData, 75000);
  } catch (err) {
    console.error("Save failed:", err);
    setSaveStatus("Couldn't save: " + err.message, "error");
  } finally {
    saveCloudBtn.disabled = false;
  }
});

toggleBtn.addEventListener("click", () => {
  const opening = editorEl.hasAttribute("hidden");
  if (opening) {
    editorEl.removeAttribute("hidden");
    toggleBtn.setAttribute("aria-expanded", "true");
    toggleBtn.textContent = "Hide editor";
    editorEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    editorEl.setAttribute("hidden", "");
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.textContent = "Manage trips";
  }
});

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}

refreshBtn.addEventListener("click", loadData);

// ==========================================================================
// Boot
// ==========================================================================
loadData();
initEditor();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) =>
      console.warn("Service worker registration failed:", e)
    );
  });
}
