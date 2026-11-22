// =========================================================
// Pichis Planner – Gesundheit: Gewicht & Wasser
// Trinkziel mit Schnellknöpfen und KI für andere Getränke,
// Gewicht mit Verlauf und Wochenschnitt. Streng privat je Person.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, openSheet, closeSheets } = PP;

  // Feste Schnellknöpfe (Anteil, der fürs Trinkziel zählt)
  const BUILTIN = [
    { key: "w250", icon: "💧", name: "Wasser", ml: 250, factor: 1 },
    { key: "w500", icon: "💧", name: "Wasser", ml: 500, factor: 1 },
    { key: "kaffee", icon: "☕", name: "Kaffee", ml: 200, factor: 0.95 },
    { key: "tee", icon: "🍵", name: "Tee", ml: 250, factor: 1 },
    { key: "schorle", icon: "🧃", name: "Saftschorle", ml: 300, factor: 0.95 },
    { key: "milch", icon: "🥛", name: "Milch", ml: 200, factor: 0.9 }
  ];

  const hl = {
    active: false, drinks: [], week: [], presets: [], weights: [],
    ai: null,          // KI-Vorschlag, der noch bestätigt werden muss
    editPresets: false, busy: false
  };
  const me = () => state.session.user.id;
  const pad = n => String(n).padStart(2, "0");
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => isoDay(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDay(d); };
  const liters = ml => (Math.round(ml / 100) / 10).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const kgText = v => Number(v).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num = v => { const x = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
  const goal = () => (state.profile && state.profile.water_goal_ml) || 2000;

  function sqlHint(err) {
    const m = (err && err.message) || "";
    return /health_|water_|weight_goal|does not exist|schema cache/.test(m) ? "Bitte zuerst das SQL aus Schritt 44 in Supabase ausführen." : translateError(err);
  }

  // ---------- Daten ----------
  async function loadAll() {
    const from = addDays(today(), -6);
    const [dr, pr, wg] = await Promise.all([
      sb.from("health_drinks").select("*").eq("user_id", me()).gte("day", from).order("created_at", { ascending: false }),
      sb.from("health_drink_presets").select("*").eq("user_id", me()).order("created_at"),
      sb.from("health_weight").select("*").eq("user_id", me()).order("day", { ascending: false }).limit(400)
    ]);
    for (const r of [dr, pr, wg]) if (r.error) throw r.error;
    hl.week = dr.data.sort((a, b) => b.created_at.localeCompare(a.created_at));
    hl.drinks = hl.week.filter(d => d.day === today());
    hl.presets = pr.data.filter(p => !p.hidden);
    hl.weights = wg.data.sort((a, b) => b.day.localeCompare(a.day));
    if (state.profile && state.profile.water_goal_ml === undefined) {
      const { data } = await sb.from("profiles").select("water_goal_ml, weight_goal, water_push, water_push_times").eq("id", me()).maybeSingle();
      if (data) Object.assign(state.profile, data);
    }
  }

  const sumWater = list => list.reduce((a, d) => a + (d.water_ml || 0), 0);

  // ---------- Getränk eintragen ----------
  async function addDrink(p) {
    if (hl.busy) return;
    hl.busy = true;
    const row = { day: today(), name: p.name.slice(0, 80), ml: Math.round(p.ml), water_ml: Math.round(p.ml * p.factor) };
    const { data, error } = await sb.from("health_drinks").insert(row).select().single();
    hl.busy = false;
    if (error) { toast(sqlHint(error), true); return; }
    hl.drinks.unshift(data); hl.week.unshift(data);
    const had = sumWater(hl.drinks);
    if (had >= goal() && had - data.water_ml < goal()) toast(`🎉 Tagesziel geschafft: ${liters(had)} Liter!`);
    render(); refreshTile();
  }

  async function askAi(text) {
    const box = $("#hl-ai");
    box.innerHTML = `<p class="muted small">✨ KI schätzt das Getränk …</p>`;
    try {
      const { data, error } = await sb.functions.invoke("assist", { body: { action: "drink", text } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
        throw new Error(msg);
      }
      hl.ai = data;
      renderAi();
    } catch (err) {
      hl.ai = null;
      box.innerHTML = `<p class="small warn-text">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderAi() {
    const box = $("#hl-ai");
    const a = hl.ai;
    if (!a) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="hl-ai-card">
      <div class="hl-ai-head"><span class="hl-ai-icon">${escapeHtml(a.icon)}</span>
        <span><strong>${escapeHtml(a.name)}</strong><br><span class="muted small">${a.ml} ml · zählt ${Math.round(a.factor * 100)} % = <strong>${a.water_ml} ml</strong></span></span></div>
      ${a.note ? `<p class="muted small">${escapeHtml(a.note)}</p>` : ""}
      <div class="hl-ai-row">
        <label class="small">Menge <input type="text" inputmode="numeric" id="hl-ai-ml" value="${a.ml}"> ml</label>
        <button type="button" class="btn btn-primary btn-small" id="btn-hl-ai-add">Eintragen</button>
        <button type="button" class="link small" id="btn-hl-ai-cancel">Abbrechen</button>
      </div>
      <label class="switch small"><input type="checkbox" id="hl-ai-keep" checked><span>Als Schnellknopf merken</span></label>
    </div>`;
  }

  // ---------- Anzeige ----------
  function presetList() {
    return [...BUILTIN.map(b => ({ ...b, builtin: true })), ...hl.presets.map(p => ({ key: p.id, icon: p.icon, name: p.name, ml: p.ml, factor: +p.factor }))];
  }

  function weekBars() {
    const days = [...Array(7)].map((_, i) => addDays(today(), i - 6));
    const max = Math.max(goal(), ...days.map(d => sumWater(hl.week.filter(x => x.day === d))));
    return `<div class="hl-week">${days.map(d => {
      const v = sumWater(hl.week.filter(x => x.day === d));
      const wd = new Date(d + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short" }).replace(".", "");
      return `<div class="hl-bar${v >= goal() ? " ok" : ""}${d === today() ? " now" : ""}" title="${liters(v)} l">
        <span class="hl-bar-col"><span style="height:${Math.round(v / max * 100)}%"></span><i style="bottom:${Math.round(goal() / max * 100)}%"></i></span>
        <span class="hl-bar-day">${wd}</span></div>`;
    }).join("")}</div>`;
  }

  function weightChart() {
    const pts = hl.weights.filter(w => w.day >= addDays(today(), -90)).slice().reverse();
    if (pts.length < 2) return pts.length ? `<p class="muted small">Ab dem zweiten Eintrag siehst du hier die Kurve.</p>` : "";
    const t0 = new Date(pts[0].day + "T12:00:00").getTime(), t1 = new Date(pts[pts.length - 1].day + "T12:00:00").getTime();
    const g = state.profile && state.profile.weight_goal ? +state.profile.weight_goal : null;
    const vals = pts.map(p => +p.kg).concat(g ? [g] : []);
    const lo = Math.min(...vals) - 0.5, hi = Math.max(...vals) + 0.5;
    const W = 320, H = 130, P = 14;
    const X = d => P + (t1 === t0 ? 0 : (new Date(d + "T12:00:00").getTime() - t0) / (t1 - t0)) * (W - 2 * P);
    const Y = v => H - P - (v - lo) / (hi - lo) * (H - 2 * P);
    // gleitender 7-Tage-Schnitt
    const avg = pts.map(p => {
      const win = pts.filter(q => q.day <= p.day && q.day > addDays(p.day, -7));
      return [X(p.day), Y(win.reduce((a, q) => a + +q.kg, 0) / win.length)];
    });
    return `<svg class="hl-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">
      ${g ? `<line x1="${P}" x2="${W - P}" y1="${Y(g).toFixed(1)}" y2="${Y(g).toFixed(1)}" class="hl-goal-line"/><text x="${W - P}" y="${(Y(g) - 4).toFixed(1)}" text-anchor="end" class="hl-chart-label">Ziel ${kgText(g)}</text>` : ""}
      ${pts.map(p => `<circle cx="${X(p.day).toFixed(1)}" cy="${Y(+p.kg).toFixed(1)}" r="2.6" class="hl-dot"/>`).join("")}
      <polyline points="${avg.map(a => a.map(v => v.toFixed(1)).join(",")).join(" ")}" fill="none" class="hl-avg" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="${P}" y="11" class="hl-chart-label">${kgText(hi - 0.5)} kg</text><text x="${P}" y="${H - 2}" class="hl-chart-label">${kgText(lo + 0.5)} kg</text>
    </svg><p class="muted small">Punkte: einzelne Messungen · Linie: 7-Tage-Schnitt · letzte 90 Tage</p>`;
  }

  function weekAvg(endDay) {
    const win = hl.weights.filter(w => w.day <= endDay && w.day > addDays(endDay, -7));
    return win.length ? win.reduce((a, w) => a + +w.kg, 0) / win.length : null;
  }

  function render() {
    const had = sumWater(hl.drinks), g = goal();
    const pct = Math.min(100, Math.round(had / g * 100));
    const presets = presetList();
    const p = state.profile || {};
    const last = hl.weights[0];
    const avgNow = weekAvg(today()), avgBefore = weekAvg(addDays(today(), -28));
    const trend = avgNow != null && avgBefore != null ? avgNow - avgBefore : null;
    const suggest = last ? Math.round(+last.kg * 35 / 100) * 100 : null;

    $("#hl-body").innerHTML = `
      <section class="card hl-water">
        <div class="hl-water-head">
          <div><div class="hl-big">${liters(had)} <small>von ${liters(g)} l</small></div>
            <p class="muted small">${had >= g ? "🎉 Tagesziel geschafft!" : `Noch ${liters(g - had)} Liter bis zum Ziel`}</p></div>
          <div class="hl-drop" style="--p:${pct}"><span>${pct} %</span></div>
        </div>
        <div class="hl-progress"><span style="width:${pct}%"></span></div>
        <div class="hl-presets">${presets.map(x => `<button type="button" class="hl-preset" data-hl-preset="${x.key}">
            <span class="hl-p-icon">${escapeHtml(x.icon)}</span><span class="hl-p-name">${escapeHtml(x.name)}</span><span class="hl-p-ml">${x.ml} ml</span>
            ${hl.editPresets && !x.builtin ? `<span class="hl-p-del" data-hl-del-preset="${x.key}" aria-label="Schnellknopf entfernen">✕</span>` : ""}
          </button>`).join("")}</div>
        ${hl.presets.length ? `<p class="small"><button type="button" class="link" id="btn-hl-edit-presets">${hl.editPresets ? "Fertig" : "Eigene Knöpfe bearbeiten"}</button></p>` : ""}
        <form id="form-hl-ai" class="hl-ai-form" autocomplete="off">
          <input type="text" name="text" maxlength="120" placeholder="Anderes Getränk …" aria-label="Anderes Getränk">
          <button type="submit" class="btn btn-small">✨ Berechnen</button>
        </form>
        <div id="hl-ai"></div>
        ${hl.drinks.length ? `<h4 class="cal-sub">Heute</h4><ul class="hl-list">${hl.drinks.map(d => `<li>
            <span>${new Date(d.created_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>
            <span class="hl-l-name">${escapeHtml(d.name)}</span>
            <span class="muted small">${d.ml} ml${d.water_ml !== d.ml ? ` → ${d.water_ml}` : ""}</span>
            <button type="button" class="icon-btn small" data-hl-del-drink="${d.id}" aria-label="Löschen">✕</button></li>`).join("")}</ul>` : ""}
        <h4 class="cal-sub">Letzte 7 Tage</h4>
        ${weekBars()}
      </section>

      <section class="card hl-weight">
        <h3 class="hl-h">⚖️ Gewicht</h3>
        ${last ? `<div class="hl-stats">
            <div><span class="hl-stat">${kgText(last.kg)} kg</span><span class="muted small">${last.day === today() ? "heute" : new Date(last.day + "T12:00:00").toLocaleDateString("de-DE")}</span></div>
            ${avgNow != null ? `<div><span class="hl-stat">${kgText(avgNow)} kg</span><span class="muted small">7-Tage-Schnitt</span></div>` : ""}
            ${trend != null ? `<div><span class="hl-stat ${trend <= 0 ? "down" : "up"}">${trend > 0 ? "+" : ""}${kgText(trend)} kg</span><span class="muted small">seit 4 Wochen</span></div>` : ""}
            ${p.weight_goal ? `<div><span class="hl-stat">${kgText(Math.abs(+last.kg - +p.weight_goal))} kg</span><span class="muted small">bis zum Ziel ${kgText(p.weight_goal)}</span></div>` : ""}
          </div>` : `<p class="muted small">Trag dein Gewicht ein – am besten morgens, immer zur gleichen Zeit.</p>`}
        <form id="form-hl-weight" class="hl-weight-form" autocomplete="off">
          <input type="text" inputmode="decimal" name="kg" placeholder="${last ? kgText(last.kg) : "z. B. 84,5"}" aria-label="Gewicht in kg" required>
          <span>kg</span>
          <input type="date" name="day" value="${today()}" max="${today()}" aria-label="Tag">
          <button type="submit" class="btn btn-primary btn-small">Eintragen</button>
        </form>
        ${weightChart()}
        ${hl.weights.length ? `<details class="hl-hist"><summary>Alle Einträge (${hl.weights.length})</summary><ul class="hl-list">${hl.weights.slice(0, 60).map(w => `<li>
            <span>${new Date(w.day + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</span>
            <span class="hl-l-name">${kgText(w.kg)} kg</span>
            <button type="button" class="icon-btn small" data-hl-del-weight="${w.id}" aria-label="Löschen">✕</button></li>`).join("")}</ul></details>` : ""}
      </section>

      <details class="card hl-settings"${hl.openSettings ? " open" : ""}>
        <summary>⚙️ Einstellungen</summary>
        <form id="form-hl-settings" class="form" autocomplete="off">
          <label>Trinkziel pro Tag (Liter)
            <input type="number" name="goal" min="0.5" max="8" step="0.1" value="${(g / 1000).toFixed(1)}" required>
          </label>
          ${suggest ? `<p class="small"><button type="button" class="link" id="btn-hl-suggest" data-ml="${suggest}">Vorschlag für ${kgText(last.kg)} kg: ${liters(suggest)} l übernehmen</button> <span class="muted">(35 ml pro kg)</span></p>` : ""}
          <label>Zielgewicht (kg) <span class="hint">(optional)</span>
            <input type="text" inputmode="decimal" name="weight_goal" value="${p.weight_goal ? kgText(p.weight_goal) : ""}" placeholder="z. B. 80">
          </label>
          <label class="switch"><input type="checkbox" name="push"${p.water_push ? " checked" : ""}><span>💧 Push-Erinnerung, wenn ich hinter dem Ziel liege</span></label>
          <div class="form-row form-row-even">
            <label>1. Uhrzeit <input type="time" name="t1" value="${escapeHtml((p.water_push_times || "15:00,18:00").split(",")[0] || "15:00")}"></label>
            <label>2. Uhrzeit <input type="time" name="t2" value="${escapeHtml((p.water_push_times || "15:00,18:00").split(",")[1] || "")}"></label>
          </div>
          <p class="muted small">Die Erinnerung kommt nur, wenn du zu dieser Uhrzeit deutlich unter dem Soll liegst (über den Tag von 8 bis 21 Uhr verteilt). Push-Mitteilungen müssen in den Einstellungen der App eingeschaltet sein.</p>
          <button type="submit" class="btn btn-small">Speichern</button>
        </form>
      </details>`;
    if (hl.ai) renderAi();
  }

  // ---------- Bedienung ----------
  $("#hl-body").addEventListener("click", async e => {
    const del = e.target.closest("[data-hl-del-preset]");
    if (del) {
      e.stopPropagation();
      const id = del.dataset.hlDelPreset;
      const { error } = await sb.from("health_drink_presets").delete().eq("id", id);
      if (error) { toast(sqlHint(error), true); return; }
      hl.presets = hl.presets.filter(p => p.id !== id);
      if (!hl.presets.length) hl.editPresets = false;
      render(); return;
    }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.hlPreset) {
      if (hl.editPresets) return;
      const p = presetList().find(x => x.key === b.dataset.hlPreset);
      if (p) { b.classList.add("hit"); await addDrink(p); }
      return;
    }
    if (b.id === "btn-hl-edit-presets") { hl.editPresets = !hl.editPresets; render(); return; }
    if (b.id === "btn-hl-ai-cancel") { hl.ai = null; renderAi(); return; }
    if (b.id === "btn-hl-ai-add") {
      const a = hl.ai;
      const ml = Math.round(num($("#hl-ai-ml").value) || a.ml);
      if (ml < 1 || ml > 5000) { toast("Die Menge passt nicht.", true); return; }
      const keep = $("#hl-ai-keep").checked;
      hl.ai = null;
      if (keep && !presetList().some(x => x.name.toLowerCase() === a.name.toLowerCase() && x.ml === ml)) {
        const { data, error } = await sb.from("health_drink_presets").insert({ name: a.name.slice(0, 60), icon: a.icon || "🥤", ml, factor: a.factor }).select().single();
        if (!error) hl.presets.push(data);
      }
      await addDrink({ name: a.name, ml, factor: a.factor });
      return;
    }
    if (b.dataset.hlDelDrink) {
      const id = b.dataset.hlDelDrink;
      const { error } = await sb.from("health_drinks").delete().eq("id", id);
      if (error) { toast(sqlHint(error), true); return; }
      hl.drinks = hl.drinks.filter(d => d.id !== id); hl.week = hl.week.filter(d => d.id !== id);
      render(); refreshTile(); return;
    }
    if (b.dataset.hlDelWeight) {
      if (!confirm("Diesen Eintrag löschen?")) return;
      const id = b.dataset.hlDelWeight;
      const { error } = await sb.from("health_weight").delete().eq("id", id);
      if (error) { toast(sqlHint(error), true); return; }
      hl.weights = hl.weights.filter(w => w.id !== id);
      render(); return;
    }
    if (b.id === "btn-hl-suggest") { $("#form-hl-settings").goal.value = (+b.dataset.ml / 1000).toFixed(1); return; }
  });

  $("#hl-body").addEventListener("toggle", e => { if (e.target.classList && e.target.classList.contains("hl-settings")) hl.openSettings = e.target.open; }, true);

  $("#hl-body").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target;
    if (f.id === "form-hl-ai") {
      const text = f.text.value.trim();
      if (!text) return;
      f.text.value = "";
      askAi(text);
      return;
    }
    if (f.id === "form-hl-weight") {
      const kgv = num(f.kg.value);
      if (kgv == null || kgv < 20 || kgv > 400) { toast("Bitte das Gewicht in kg eintragen, z. B. 84,5.", true); return; }
      const day = f.day.value || today();
      const { data, error } = await sb.from("health_weight").upsert({ user_id: me(), day, kg: Math.round(kgv * 10) / 10 }, { onConflict: "user_id,day" }).select().single();
      if (error) { toast(sqlHint(error), true); return; }
      hl.weights = [data, ...hl.weights.filter(w => w.day !== data.day)].sort((a, b) => b.day.localeCompare(a.day));
      toast(`${kgText(data.kg)} kg eingetragen.`);
      render(); return;
    }
    if (f.id === "form-hl-settings") {
      PP.withBusy(f, async () => {
        const g = Math.round((num(f.goal.value) || 2) * 10) * 100;
        if (g < 500 || g > 8000) throw new Error("Das Trinkziel liegt zwischen 0,5 und 8 Litern.");
        const wg = f.weight_goal.value.trim() ? num(f.weight_goal.value) : null;
        if (wg != null && (wg < 20 || wg > 400)) throw new Error("Das Zielgewicht passt nicht.");
        const times = [f.t1.value, f.t2.value].filter(t => /^\d\d:\d\d$/.test(t)).sort();
        if (f.push.checked && !times.length) throw new Error("Bitte mindestens eine Uhrzeit für die Erinnerung angeben.");
        const upd = { water_goal_ml: g, weight_goal: wg != null ? Math.round(wg * 10) / 10 : null, water_push: f.push.checked, water_push_times: [...new Set(times)].join(",") || "15:00,18:00" };
        const { error } = await sb.from("profiles").update(upd).eq("id", me());
        if (error) throw new Error(sqlHint(error));
        Object.assign(state.profile, upd);
        toast("Gespeichert.");
        render(); refreshTile();
      });
    }
  });

  // ---------- Startseite & Training ----------
  async function refreshTile() {
    const el = $("#tile-hl-status");
    if (!el || !state.session) return;
    const { data, error } = await sb.from("health_drinks").select("water_ml").eq("user_id", me()).eq("day", today());
    if (error) { el.textContent = "Gewicht & Wasser"; return; }
    el.textContent = `💧 ${liters(sumWater(data || []))} / ${liters(goal())} l`;
  }
  // Für das Fitnesstagebuch: letztes Gewicht
  PP.lastWeight = async () => {
    const { data, error } = await sb.from("health_weight").select("day, kg").eq("user_id", me()).order("day", { ascending: false }).limit(1);
    return error || !data ? null : data[0] || null;
  };

  PP.modules.health = {
    async enter() {
      hl.active = true;
      try { await loadAll(); } catch (err) { console.error(err); toast(sqlHint(err), true); }
      render();
    },
    leave() { hl.active = false; hl.ai = null; },
    async resume() {
      if (hl.active) { try { await loadAll(); render(); } catch { /* egal */ } }
      else refreshTile();
    },
    refreshTile,
    reset() { hl.drinks = []; hl.week = []; hl.presets = []; hl.weights = []; hl.ai = null; }
  };
})();
