// =========================================================
// Pichis Planner – Tankpreise (Tankerkönig über die Funktion „news“)
// Günstigste Tankstellen bei Bodenheim, auf dem Weg und bei der Arbeit
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError } = PP;
  const cfg = window.PP_CONFIG || {};
  const TYPES = [["e5", "Super E5"], ["e10", "Super E10"], ["diesel", "Diesel"]];

  const fu = { active: false, data: null, loading: false };

  const type = () => (state.profile && state.profile.fuel_type) || "e5";
  const typeName = () => (TYPES.find(t => t[0] === type()) || TYPES[0])[1];

  // Orte: Zuhause (Fahrtzeit-Start oder Wetter-Ort), Mitte der Strecke, Arbeit
  function spots() {
    const p = state.profile || {};
    const home = p.commute_from_lat != null ? { lat: p.commute_from_lat, lng: p.commute_from_lon, name: (p.commute_from || "Zuhause").split(",")[0] }
      : cfg.WEATHER ? { lat: cfg.WEATHER.lat, lng: cfg.WEATHER.lon, name: cfg.WEATHER.name } : null;
    const list = [];
    if (home) list.push({ ...home, rad: 5 });
    if (p.commute_to_lat != null && home) {
      const work = { lat: p.commute_to_lat, lng: p.commute_to_lon, name: (p.commute_to || "Arbeit").split(",")[0] };
      const km = Math.hypot((work.lat - home.lat) * 111, (work.lng - home.lng) * 111 * Math.cos(home.lat * Math.PI / 180));
      if (km > 12) list.push({ lat: (home.lat + work.lat) / 2, lng: (home.lng + work.lng) / 2, rad: Math.min(10, Math.max(4, km / 4)), name: "Auf dem Weg" });
      if (km > 4) list.push({ ...work, rad: 5 });
    }
    return list;
  }

  async function load() {
    const sp = spots();
    if (!sp.length) throw new Error("Kein Ort bekannt – bitte unter Einstellungen → Fahrtzeit Start und Ziel eintragen.");
    const { data, error } = await sb.functions.invoke("news", { body: { action: "fuel", type: type(), spots: sp.map(s => ({ lat: s.lat, lng: s.lng, rad: s.rad })) } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
      throw new Error(msg);
    }
    fu.data = { at: Date.now(), type: data.type, spots: data.spots.map((x, i) => ({ ...sp[i], stations: x.stations, fetched: x.at })) };
    return fu.data;
  }

  const euro = p => p.toFixed(3).replace(".", ",").replace(/(\d)$/, "<sup>$1</sup>");
  const mapsUrl = s => `https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d`;

  function render() {
    if (!fu.active) return;
    $("#fu-types").innerHTML = TYPES.map(([k, l]) => `<button class="chip${type() === k ? " active" : ""}" data-fu-type="${k}">${l}</button>`).join("");
    const box = $("#fu-body");
    if (!fu.data) { box.innerHTML = `<p class="muted cal-empty">${fu.loading ? "Preise werden geladen …" : ""}</p>`; return; }
    const all = fu.data.spots.flatMap(s => s.stations.filter(x => x.open));
    const best = all.length ? Math.min(...all.map(x => x.price)) : null;
    box.innerHTML = fu.data.spots.map(s => {
      const open = s.stations.filter(x => x.open).slice(0, 8);
      return `<section class="card fu-card"><div class="fu-head"><strong>${escapeHtml(s.name)}</strong><span class="muted small">Umkreis ${Math.round(s.rad)} km</span></div>
        ${open.length ? `<ul class="fu-list">${open.map(x => `<li><a class="fu-row${x.price === best ? " best" : ""}" href="${mapsUrl(x)}" target="_blank" rel="noopener">
            <span class="fu-price">${euro(x.price)}</span>
            <span class="fu-text"><span class="fu-name">${escapeHtml(x.brand || x.name)}</span>
            <span class="muted small">${escapeHtml(x.street)}, ${escapeHtml(x.place)} · ${String(x.dist).replace(".", ",")} km</span></span>
          </a></li>`).join("")}</ul>` : `<p class="muted small">Gerade keine geöffnete Tankstelle mit ${typeName()} im Umkreis.</p>`}
      </section>`;
    }).join("") + `<p class="muted small fu-foot">Stand ${new Date(fu.data.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr · nur geöffnete Tankstellen · Antippen startet die Route · Daten: <a href="https://www.tankerkoenig.de" target="_blank" rel="noopener">Tankerkönig</a> / MTS-K (CC BY 4.0)</p>`;
  }

  async function refresh(force) {
    if (!force && fu.data && fu.data.type === type() && Date.now() - fu.data.at < 5 * 60000) { render(); paintTile(); return; }
    fu.loading = true;
    render();
    try { await load(); }
    catch (err) { $("#fu-body").innerHTML = `<p class="muted cal-empty">${escapeHtml(err.message)}</p>`; fu.loading = false; return; }
    fu.loading = false;
    render();
    paintTile();
  }

  $("#view-fuel").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.fuType) {
      const upd = { fuel_type: b.dataset.fuType };
      const { error } = await sb.from("profiles").update(upd).eq("id", state.session.user.id);
      if (error) { toast(/fuel_type/.test(error.message || "") ? "Bitte zuerst das SQL aus Schritt 38 in Supabase ausführen." : translateError(error), true); return; }
      Object.assign(state.profile, upd);
      fu.data = null;
      refresh(true);
    }
    if (b.id === "btn-fu-refresh") refresh(true);
  });

  function paintTile() {
    const el = $("#tile-fu-status");
    if (!el || !fu.data) return;
    const all = fu.data.spots.flatMap(s => s.stations.filter(x => x.open));
    if (!all.length) return;
    const best = all.reduce((a, b) => (b.price < a.price ? b : a));
    el.textContent = `${typeName()} ab ${best.price.toFixed(3).replace(".", ",")} € · ${best.brand || best.name}`;
  }

  PP.modules.fuel = {
    enter() { fu.active = true; render(); refresh(); },
    leave() { fu.active = false; },
    resume() { if (fu.active) refresh(); },
    async refreshTile() {
      if (fu.data && Date.now() - fu.data.at < 15 * 60000) { paintTile(); return; }
      try { await load(); paintTile(); } catch { /* Kachel bleibt bei „Preise ansehen“ */ }
    },
    reset() { fu.data = null; }
  };
})();
