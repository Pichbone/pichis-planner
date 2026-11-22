// =========================================================
// Pichis Planner – Auto: Tankbuch
// Tankungen eintragen (auch per Foto vom Tankbeleg), Verbrauch von
// Volltankung zu Volltankung, Kosten, Verlauf. Mehrere Autos möglich.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, openSheet, closeSheets } = PP;

  const TYPES = [["e5", "Super E5"], ["e10", "Super E10"], ["diesel", "Diesel"]];
  const ca = { active: false, cars: [], fuel: [], carId: storageGet("pp_car") || "", editId: null, editCar: null, stations: null };
  const hid = () => state.household.id;
  const me = () => state.session.user.id;
  const pad = n => String(n).padStart(2, "0");
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const num = v => { const x = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
  const de = (v, d = 1) => Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = v => Number(v).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
  const km = v => Math.round(v).toLocaleString("de-DE");
  const fmtDay = iso => new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });

  function sqlHint(err) {
    const m = (err && err.message) || "";
    return /cars|car_fuelings|does not exist|schema cache/.test(m) ? "Bitte zuerst das SQL aus Schritt 46 in Supabase ausführen." : translateError(err);
  }

  // ---------- Daten ----------
  async function loadCars() {
    const { data, error } = await sb.from("cars").select("*").eq("household_id", hid()).eq("archived", false).order("created_at");
    if (error) throw error;
    ca.cars = data;
    if (!ca.cars.some(c => c.id === ca.carId)) ca.carId = ca.cars[0] ? ca.cars[0].id : "";
  }
  async function loadFuel() {
    ca.fuel = [];
    if (!ca.carId) return;
    const { data, error } = await sb.from("car_fuelings").select("*").eq("car_id", ca.carId).order("odometer", { ascending: true });
    if (error) throw error;
    ca.fuel = data.sort((a, b) => a.odometer - b.odometer || a.day.localeCompare(b.day));
  }
  const car = () => ca.cars.find(c => c.id === ca.carId);
  const cost = f => f.total != null ? +f.total : f.price_l != null ? +f.price_l * +f.liters : null;

  // Verbrauch: von Volltankung zu Volltankung (Teiltankungen dazwischen zählen mit)
  function consumption() {
    const out = new Map();   // id der Volltankung → { l100, km }
    let lastFull = null, liters = 0;
    for (const f of ca.fuel) {
      if (lastFull) liters += +f.liters;
      if (f.full_tank) {
        if (lastFull && f.odometer > lastFull.odometer) {
          const dist = f.odometer - lastFull.odometer;
          out.set(f.id, { l100: liters / dist * 100, km: dist, liters });
        }
        lastFull = f; liters = 0;
      }
    }
    return out;
  }

  function stats() {
    const cons = consumption();
    const vals = [...cons.values()];
    const sumL = vals.reduce((a, v) => a + v.liters, 0), sumKm = vals.reduce((a, v) => a + v.km, 0);
    const avg = sumKm ? sumL / sumKm * 100 : null;
    // Kosten pro 100 km: Kosten der Tankungen nach der ersten Volltankung / gefahrene km
    const first = ca.fuel.find(f => f.full_tank);
    const after = first ? ca.fuel.filter(f => f.odometer > first.odometer) : [];
    const costAfter = after.reduce((a, f) => a + (cost(f) || 0), 0);
    const driven = ca.fuel.length > 1 ? ca.fuel[ca.fuel.length - 1].odometer - ca.fuel[0].odometer : 0;
    const distFull = first ? ca.fuel[ca.fuel.length - 1].odometer - first.odometer : 0;
    const per100 = distFull > 0 && costAfter > 0 ? costAfter / distFull * 100 : null;
    const year = String(new Date().getFullYear());
    const costYear = ca.fuel.filter(f => f.day.startsWith(year)).reduce((a, f) => a + (cost(f) || 0), 0);
    const days = ca.fuel.length > 1 ? (new Date(ca.fuel[ca.fuel.length - 1].day) - new Date(ca.fuel[0].day)) / 864e5 : 0;
    const kmMonth = days >= 20 ? driven / days * 30.4 : null;
    const last = [...ca.fuel].reverse().find(f => cons.has(f.id));
    return { cons, avg, per100, costYear, kmMonth, last: last ? cons.get(last.id) : null, driven };
  }

  // ---------- Anzeige ----------
  function chart(cons) {
    const pts = ca.fuel.filter(f => cons.has(f.id)).slice(-24).map(f => ({ d: f.day, v: cons.get(f.id).l100 }));
    if (pts.length < 2) return "";
    const W = 320, H = 120, P = 14;
    const lo = Math.min(...pts.map(p => p.v)) - 0.3, hi = Math.max(...pts.map(p => p.v)) + 0.3;
    const xy = pts.map((p, i) => [P + i * (W - 2 * P) / (pts.length - 1), H - P - (p.v - lo) / (hi - lo) * (H - 2 * P)]);
    return `<svg class="car-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verbrauch je Tankfüllung">
      <polyline points="${xy.map(p => p.map(v => v.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${xy.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="currentColor"/>`).join("")}
      <text x="${P}" y="11" class="car-chart-label">${de(hi - 0.3)} l</text><text x="${P}" y="${H - 2}" class="car-chart-label">${de(lo + 0.3)} l</text>
    </svg><p class="muted small">Verbrauch je Tankfüllung (l/100 km) · letzte ${pts.length}</p>`;
  }

  function render() {
    const box = $("#car-body");
    if (!box) return;
    $("#car-chips").innerHTML = ca.cars.map(c => `<button class="chip${c.id === ca.carId ? " active" : ""}" data-car="${c.id}">🚗 ${escapeHtml(c.name)}${c.is_private ? " 🔒" : ""}</button>`).join("") +
      `<button class="chip" data-car-new>＋ Auto</button>`;
    if (!ca.cars.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">🚗</div><p><strong>Noch kein Auto angelegt.</strong></p>
        <p class="muted small">Leg dein Auto an – danach trägst du beim Tanken Kilometerstand und Liter ein (oder fotografierst den Beleg), und die App rechnet Verbrauch und Kosten aus.</p>
        <button class="btn btn-primary" data-car-new>＋ Auto anlegen</button></div>`;
      return;
    }
    const c = car();
    const s = stats();
    const warn = s.last && s.avg && s.cons.size >= 3 && s.last.l100 > s.avg * 1.15;
    box.innerHTML = `
      <button type="button" class="btn btn-primary btn-block car-add" id="btn-car-fuel">⛽ Tanken eintragen</button>
      <section class="card car-stats">
        <div class="car-big">${s.avg != null ? `${de(s.avg)} <small>l/100 km</small>` : "–"}</div>
        <p class="muted small">${s.avg != null ? `Ø-Verbrauch aus ${s.cons.size} Tankfüllung${s.cons.size === 1 ? "" : "en"}` : "Der Verbrauch erscheint ab der zweiten Volltankung."}</p>
        <div class="hl-stats">
          ${s.last ? `<div><span class="hl-stat${warn ? " up" : ""}">${de(s.last.l100)} l</span><span class="muted small">letzte Füllung</span></div>` : ""}
          ${s.per100 != null ? `<div><span class="hl-stat">${eur(s.per100)}</span><span class="muted small">pro 100 km</span></div>` : ""}
          <div><span class="hl-stat">${eur(s.costYear)}</span><span class="muted small">Sprit ${new Date().getFullYear()}</span></div>
          ${s.kmMonth != null ? `<div><span class="hl-stat">${km(s.kmMonth)} km</span><span class="muted small">pro Monat</span></div>` : ""}
        </div>
        ${warn ? `<p class="small car-warn">⚠️ Die letzte Füllung lag ${Math.round((s.last.l100 / s.avg - 1) * 100)} % über deinem Schnitt – Reifendruck, Kurzstrecke oder Winter?</p>` : ""}
        ${chart(s.cons)}
      </section>
      <h4 class="cal-sub">Tankungen</h4>
      ${ca.fuel.length ? `<ul class="ar-list">${[...ca.fuel].reverse().map(f => {
        const k = s.cons.get(f.id), co = cost(f);
        return `<li><button class="ar-doc" data-fuel="${f.id}"><span class="ar-icon">⛽</span>
          <span class="ar-main"><span class="ar-title">${fmtDay(f.day)} · ${de(f.liters, 2)} l${co != null ? ` · ${eur(co)}` : ""}</span>
          <span class="ar-sub">${km(f.odometer)} km${f.price_l != null ? ` · ${de(f.price_l, 3)} €/l` : ""}${f.full_tank ? "" : " · teilgetankt"}${k ? ` · <strong>${de(k.l100)} l/100 km</strong> auf ${km(k.km)} km` : ""}${f.station ? " · " + escapeHtml(f.station) : ""}</span></span></button></li>`;
      }).join("")}</ul>` : `<p class="muted small">Noch keine Tankung. Tipp: Beim ersten Mal voll tanken – ab der zweiten Volltankung rechnet die App den Verbrauch.</p>`}
      <p class="small"><button type="button" class="link" data-car-edit="${c.id}">Auto bearbeiten</button></p>`;
  }

  // ---------- Tankung eintragen ----------
  function openFuel(id) {
    const f = id ? ca.fuel.find(x => x.id === id) : null;
    ca.editId = id || null;
    ca.stations = null;
    const last = ca.fuel[ca.fuel.length - 1];
    const form = $("#form-fuel");
    form.reset();
    form.day.value = f ? f.day : today();
    form.odometer.value = f ? f.odometer : "";
    form.odometer.placeholder = last ? `zuletzt ${km(last.odometer)}` : "z. B. 85.400";
    form.liters.value = f ? de(f.liters, 2) : "";
    form.price_l.value = f && f.price_l != null ? de(f.price_l, 3) : "";
    form.total.value = f && f.total != null ? de(f.total, 2) : "";
    form.full_tank.checked = f ? f.full_tank : true;
    form.station.value = f ? f.station : "";
    form.note.value = f ? f.note : "";
    $("#fuel-sheet-title").textContent = f ? "Tankung bearbeiten" : `Tanken – ${car().name}`;
    $("#btn-fuel-delete").hidden = !f;
    $("#fuel-stations").innerHTML = "";
    $("#fuel-hint").textContent = "";
    openSheet("sheet-fuel");
  }

  // Preis ↔ Betrag ergänzen
  function fillMissing(changed) {
    const f = $("#form-fuel");
    const l = num(f.liters.value), p = num(f.price_l.value), t = num(f.total.value);
    if (!l) return;
    if (changed !== "total" && p && (changed === "price_l" || !t)) f.total.value = de(l * p, 2);
    else if (changed !== "price_l" && t && (changed === "total" || !p)) f.price_l.value = de(t / l, 3);
  }
  ["liters", "price_l", "total"].forEach(n => $("#form-fuel")[n].addEventListener("change", () => fillMissing(n)));

  // Tankstellen in der Nähe (Tankerkönig) – mit aktuellem Preis
  async function nearby(btn) {
    btn.disabled = true;
    btn.textContent = "📍 Suche Tankstellen …";
    try {
      const pos = await new Promise((res, rej) => {
        if (!navigator.geolocation) { rej(new Error("Standort nicht verfügbar.")); return; }
        navigator.geolocation.getCurrentPosition(p => res(p.coords), () => rej(new Error("Standort nicht freigegeben.")), { timeout: 10000, maximumAge: 120000 });
      });
      const { data, error } = await sb.functions.invoke("news", { body: { action: "fuel", type: car().fuel_type, spots: [{ lat: pos.latitude, lng: pos.longitude, rad: 2 }] } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
        throw new Error(msg);
      }
      ca.stations = (data.spots[0] || { stations: [] }).stations.sort((a, b) => a.dist - b.dist).slice(0, 6);
      $("#fuel-stations").innerHTML = ca.stations.length ? ca.stations.map((s, i) => `<button type="button" class="fuel-st" data-st="${i}">
          <strong>${escapeHtml(s.brand || s.name)}</strong> <span class="muted small">${escapeHtml(s.street)} · ${de(s.dist)} km</span><span class="fuel-st-p">${de(s.price, 3)} €</span></button>`).join("")
        : `<p class="muted small">Keine Tankstelle im Umkreis von 2 km gefunden.</p>`;
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "📍 Tankstelle in der Nähe";
    }
  }

  // Foto vom Tankbeleg → KI liest Liter, Preis, Betrag, Tankstelle
  async function readReceipt(file) {
    const hint = $("#fuel-hint");
    hint.textContent = "✨ Beleg wird gelesen …";
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Foto konnte nicht gelesen werden.")); i.src = url; });
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const { data, error } = await sb.functions.invoke("assist", { body: { action: "receipt", image: c.toDataURL("image/jpeg", 0.85).split(",")[1] } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
        throw new Error(msg);
      }
      const f = $("#form-fuel");
      if (data.date) f.day.value = data.date;
      if (data.liters) f.liters.value = de(data.liters, 2);
      if (data.price_l) f.price_l.value = de(data.price_l, 3);
      if (data.total) f.total.value = de(data.total, 2);
      if (data.station) f.station.value = data.station;
      fillMissing("liters");
      hint.textContent = data.liters ? "✓ Vom Beleg übernommen – bitte noch den Kilometerstand eintragen." : "Auf dem Beleg war nicht alles lesbar – bitte ergänzen.";
      if (data.fuel && data.fuel !== car().fuel_type) hint.textContent += ` (Beleg: ${(TYPES.find(t => t[0] === data.fuel) || [, data.fuel])[1]})`;
      f.odometer.focus();
    } catch (err) {
      hint.textContent = "";
      toast(err.message, true);
    }
  }

  $("#sheet-fuel").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "btn-fuel-nearby") { nearby(b); return; }
    if (b.id === "btn-fuel-photo") { $("#fuel-photo").click(); return; }
    if (b.dataset.st) {
      const s = ca.stations[+b.dataset.st];
      const f = $("#form-fuel");
      f.station.value = `${s.brand || s.name}, ${s.street}`.slice(0, 120);
      // Preis nur übernehmen, wenn noch keiner da ist (z. B. vom Beleg)
      if (!num(f.price_l.value)) { f.price_l.value = de(s.price, 3); fillMissing("price_l"); }
      $("#fuel-stations").innerHTML = "";
      return;
    }
    if (b.id === "btn-fuel-delete") {
      if (!confirm("Diese Tankung löschen?")) return;
      const { error } = await sb.from("car_fuelings").delete().eq("id", ca.editId);
      if (error) { toast(sqlHint(error), true); return; }
      ca.fuel = ca.fuel.filter(x => x.id !== ca.editId);
      closeSheets(); render(); refreshTile();
    }
  });
  $("#fuel-photo").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) readReceipt(f); });

  $("#form-fuel").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const odo = Math.round(num(f.odometer.value.replace(/\./g, "")) ?? NaN);
      const liters = num(f.liters.value), price = num(f.price_l.value), total = num(f.total.value);
      if (!Number.isFinite(odo) || odo < 0) throw new Error("Bitte den Kilometerstand eintragen.");
      if (!liters || liters <= 0 || liters > 300) throw new Error("Bitte die getankten Liter eintragen.");
      const others = ca.fuel.filter(x => x.id !== ca.editId);
      const before = others.filter(x => x.day <= f.day.value).pop();
      if (before && odo < before.odometer && !confirm(`Der Kilometerstand ist kleiner als bei der Tankung vom ${fmtDay(before.day)} (${km(before.odometer)} km). Trotzdem speichern?`)) return;
      const row = {
        day: f.day.value || today(), odometer: odo, liters: Math.round(liters * 100) / 100,
        price_l: price ? Math.round(price * 1000) / 1000 : null, total: total ? Math.round(total * 100) / 100 : (price ? Math.round(price * liters * 100) / 100 : null),
        full_tank: f.full_tank.checked, station: f.station.value.trim().slice(0, 120), note: f.note.value.trim().slice(0, 300)
      };
      const q = ca.editId ? sb.from("car_fuelings").update(row).eq("id", ca.editId) : sb.from("car_fuelings").insert({ ...row, household_id: hid(), car_id: ca.carId });
      const { data, error } = await q.select().single();
      if (error) throw new Error(sqlHint(error));
      ca.fuel = [...ca.fuel.filter(x => x.id !== data.id), data].sort((a, b) => a.odometer - b.odometer || a.day.localeCompare(b.day));
      closeSheets(); render(); refreshTile();
      const k = consumption().get(data.id);
      toast(k ? `Gespeichert · ${de(k.l100)} l/100 km auf ${km(k.km)} km.` : "Gespeichert.");
    });
  });

  // ---------- Auto anlegen / bearbeiten ----------
  function openCar(id) {
    const c = id ? ca.cars.find(x => x.id === id) : null;
    ca.editCar = id || null;
    const f = $("#form-car");
    f.reset();
    f.name.value = c ? c.name : "";
    f.plate.value = c ? c.plate : "";
    f.fuel_type.value = c ? c.fuel_type : ((state.profile && state.profile.fuel_type) || "e5");
    f.tank_l.value = c && c.tank_l ? de(c.tank_l, 0) : "";
    f.is_private.checked = c ? c.is_private : false;
    f.is_private.disabled = !!c && c.created_by !== me();
    $("#car-sheet-title").textContent = c ? c.name : "Neues Auto";
    $("#btn-car-delete").hidden = !c;
    openSheet("sheet-car");
    if (!c) setTimeout(() => f.name.focus(), 60);
  }

  $("#form-car").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const row = { name: f.name.value.trim().slice(0, 60), plate: f.plate.value.trim().toUpperCase().slice(0, 20), fuel_type: f.fuel_type.value,
        tank_l: num(f.tank_l.value) || null };
      if (!f.is_private.disabled) row.is_private = f.is_private.checked;
      if (!row.name) throw new Error("Bitte einen Namen eingeben, z. B. „Golf“.");
      const q = ca.editCar ? sb.from("cars").update(row).eq("id", ca.editCar) : sb.from("cars").insert({ ...row, household_id: hid() });
      const { data, error } = await q.select().single();
      if (error) throw new Error(sqlHint(error));
      ca.cars = [...ca.cars.filter(c => c.id !== data.id), data];
      ca.carId = data.id; storageSet("pp_car", data.id);
      await loadFuel();
      closeSheets(); render(); refreshTile();
    });
  });
  $("#btn-car-delete").addEventListener("click", async () => {
    const c = ca.cars.find(x => x.id === ca.editCar);
    if (!c || !confirm(`„${c.name}“ mit allen Tankungen löschen?`)) return;
    const { error } = await sb.from("cars").delete().eq("id", c.id);
    if (error) { toast(sqlHint(error), true); return; }
    ca.cars = ca.cars.filter(x => x.id !== c.id);
    ca.carId = ca.cars[0] ? ca.cars[0].id : "";
    await loadFuel();
    closeSheets(); render(); refreshTile();
  });

  $("#view-car").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-car-new")) { openCar(null); return; }
    if (b.dataset.carEdit) { openCar(b.dataset.carEdit); return; }
    if (b.dataset.car) {
      ca.carId = b.dataset.car; storageSet("pp_car", ca.carId);
      try { await loadFuel(); } catch (err) { toast(sqlHint(err), true); }
      render(); return;
    }
    if (b.id === "btn-car-fuel") { openFuel(null); return; }
    if (b.dataset.fuel) { openFuel(b.dataset.fuel); return; }
  });

  // ---------- Startseite ----------
  async function refreshTile() {
    const el = $("#tile-car-status");
    if (!el || !state.household) return;
    const { data, error } = await sb.from("car_fuelings").select("day, liters, total, price_l").eq("household_id", hid()).order("day", { ascending: false }).limit(1);
    if (error || !data || !data[0]) { el.textContent = "Tankbuch"; return; }
    const f = data[0];
    const d = Math.round((new Date(today() + "T12:00:00") - new Date(f.day + "T12:00:00")) / 864e5);
    el.textContent = `Getankt ${d <= 0 ? "heute" : d === 1 ? "gestern" : `vor ${d} Tagen`}`;
  }

  PP.modules.car = {
    async enter() {
      ca.active = true;
      try { await loadCars(); await loadFuel(); } catch (err) { console.error(err); toast(sqlHint(err), true); }
      render();
    },
    leave() { ca.active = false; closeSheets(); },
    async resume() { if (ca.active) { try { await loadCars(); await loadFuel(); render(); } catch { /* egal */ } } else refreshTile(); },
    refreshTile,
    reset() { ca.cars = []; ca.fuel = []; }
  };
})();
