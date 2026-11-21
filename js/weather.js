// =========================================================
// Pichis Planner – Wetter (klein oben auf der Startseite)
// Daten: Open-Meteo (kostenlos, ohne Schlüssel, Deutscher Wetterdienst u. a.)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { $, escapeHtml, storageGet, storageSet, openSheet } = PP;

  const PLACE = (PP.cfg && PP.cfg.WEATHER) || { name: "Bodenheim", lat: 49.9294, lon: 8.3117 };
  const CACHE_KEY = "pp_weather";
  const MAX_AGE = 30 * 60 * 1000;   // höchstens alle 30 Minuten neu laden

  // WMO-Wettercodes → Symbol und Text
  function codeInfo(code, isDay = true) {
    const c = Number(code);
    if (c === 0) return [isDay ? "☀️" : "🌙", "Klar"];
    if (c === 1) return [isDay ? "🌤️" : "🌙", "Überwiegend klar"];
    if (c === 2) return ["⛅", "Teils bewölkt"];
    if (c === 3) return ["☁️", "Bedeckt"];
    if (c === 45 || c === 48) return ["🌫️", "Nebel"];
    if (c >= 51 && c <= 57) return ["🌦️", "Nieselregen"];
    if (c === 61 || c === 80) return ["🌦️", "Leichter Regen"];
    if (c === 63 || c === 81) return ["🌧️", "Regen"];
    if (c === 65 || c === 82) return ["🌧️", "Starker Regen"];
    if (c === 66 || c === 67) return ["🌧️", "Gefrierender Regen"];
    if (c >= 71 && c <= 77) return ["🌨️", "Schnee"];
    if (c === 85 || c === 86) return ["🌨️", "Schneeschauer"];
    if (c >= 95) return ["⛈️", "Gewitter"];
    return ["🌡️", ""];
  }

  const deg = v => `${Math.round(v)}°`;

  function readCache() {
    try {
      const c = JSON.parse(storageGet(CACHE_KEY) || "null");
      return c && c.lat === PLACE.lat && c.lon === PLACE.lon ? c : null;
    } catch { return null; }
  }

  async function fetchWeather() {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", PLACE.lat);
    url.searchParams.set("longitude", PLACE.lon);
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,precipitation");
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    url.searchParams.set("timezone", "Europe/Berlin");
    url.searchParams.set("forecast_days", "4");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Wetter nicht erreichbar");
    const data = await res.json();
    const c = { at: Date.now(), lat: PLACE.lat, lon: PLACE.lon, current: data.current, daily: data.daily };
    storageSet(CACHE_KEY, JSON.stringify(c));
    return c;
  }

  function paintChip(w) {
    const chip = $("#weather-chip");
    if (!chip) return;
    if (!w || !w.current) { chip.hidden = true; return; }
    const [icon, text] = codeInfo(w.current.weather_code, w.current.is_day === 1);
    chip.innerHTML = `<span class="wx-icon" aria-hidden="true">${icon}</span><span class="wx-temp">${deg(w.current.temperature_2m)}</span>`;
    chip.setAttribute("aria-label", `Wetter in ${PLACE.name}: ${text}, ${deg(w.current.temperature_2m)}`);
    chip.title = `${PLACE.name}: ${text}`;
    chip.hidden = document.body.dataset.view && document.body.dataset.view !== "home";
  }

  let loading = false;
  async function refresh(force = false) {
    const cached = readCache();
    if (cached) paintChip(cached);
    if (loading || (!force && cached && Date.now() - cached.at < MAX_AGE)) return cached;
    loading = true;
    try {
      const w = await fetchWeather();
      paintChip(w);
      return w;
    } catch (err) {
      console.warn("Wetter:", err);
      return cached;
    } finally {
      loading = false;
    }
  }

  function renderSheet(w) {
    if (!w || !w.current) {
      $("#weather-body").innerHTML = `<p class="muted">Das Wetter konnte gerade nicht geladen werden.</p>`;
      return;
    }
    const cur = w.current;
    const [icon, text] = codeInfo(cur.weather_code, cur.is_day === 1);
    const d = w.daily;
    const days = d.time.map((t, i) => {
      const [ic, tx] = codeInfo(d.weather_code[i]);
      const name = i === 0 ? "Heute" : i === 1 ? "Morgen" : new Date(t + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short" });
      const rain = d.precipitation_probability_max && d.precipitation_probability_max[i] != null ? `${d.precipitation_probability_max[i]} %` : "";
      return `<li title="${escapeHtml(tx)}"><span class="wx-day">${name}</span><span class="wx-dicon">${ic}</span>
        <span class="wx-range"><b>${deg(d.temperature_2m_max[i])}</b> ${deg(d.temperature_2m_min[i])}</span>
        <span class="wx-rain">${rain ? "💧 " + rain : ""}</span></li>`;
    }).join("");
    const time = new Date(w.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    $("#weather-body").innerHTML = `
      <div class="wx-now">
        <span class="wx-big">${icon}</span>
        <div>
          <div class="wx-now-temp">${deg(cur.temperature_2m)}</div>
          <div class="muted">${escapeHtml(text)} · gefühlt ${deg(cur.apparent_temperature)} · Wind ${Math.round(cur.wind_speed_10m)} km/h</div>
        </div>
      </div>
      <ul class="wx-days">${days}</ul>
      <p class="muted small">Stand ${time} Uhr · Daten: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></p>`;
  }

  $("#weather-chip").addEventListener("click", async () => {
    $("#weather-title").textContent = `Wetter in ${PLACE.name}`;
    renderSheet(readCache());
    openSheet("sheet-weather");
    renderSheet(await refresh(true));
  });

  // Beim Wechsel der Ansicht: nur auf der Startseite zeigen
  window.addEventListener("hashchange", () => setTimeout(() => paintChip(readCache()), 0));

  PP.modules.weather = {
    enter() {}, leave() {},
    resume: () => refresh(),
    refreshTile: () => refresh(),   // läuft beim Öffnen der Startseite
    reset() {}
  };

  // ---------- Datum und Uhrzeit oben im Kopf ----------
  const fmtDate = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short" });
  const fmtTime = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
  let clockTimer = null;
  function paintClock() {
    const el = $("#clock-chip");
    if (!el) return;
    const now = new Date();
    el.innerHTML = `<span class="clock-date">${fmtDate.format(now).replace(".,", ",")}</span><span class="clock-time">${fmtTime.format(now)}</span>`;
    el.title = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    clearTimeout(clockTimer);
    clockTimer = setTimeout(paintClock, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);   // zur vollen Minute
  }
  paintClock();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) paintClock(); });
})();
