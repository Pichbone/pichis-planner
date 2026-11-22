// =========================================================
// Pichis Planner – Fitnesstagebuch
// Übungen, feste Trainingspläne, Training im Studio Satz für Satz
// eintragen (Wiederholungen × Gewicht), Pausen-Timer, Verlauf je Übung.
// Alles privat: jede Person sieht nur ihr eigenes Training.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, openSheet, closeSheets } = PP;

  const MUSCLES = ["Brust", "Rücken", "Schultern", "Bizeps", "Trizeps", "Beine", "Po", "Waden", "Bauch", "Ganzkörper", "Cardio"];
  const fx = {
    active: false, tab: "train",
    exercises: [], plans: [], items: [], sessions: [], sets: [],   // sets: die letzten Sätze (für „letztes Mal“)
    run: null,            // laufendes Training { session, order, rows, rest, target }
    rest: null,           // Pausen-Timer { until, total, timer }
    tick: null,
    draft: null,          // Plan im Editor
    editEx: null
  };
  const me = () => state.session.user.id;

  function sqlHint(err) {
    const m = (err && err.message) || "";
    return /fit_|does not exist|schema cache/.test(m) ? "Bitte zuerst das SQL aus Schritt 43 in Supabase ausführen." : translateError(err);
  }

  // ---------- Hilfen ----------
  const num = v => { const x = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
  const kg = v => { const x = Number(v) || 0; return (Math.round(x * 100) / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 }); };
  const exById = id => fx.exercises.find(e => e.id === id);
  const exName = id => (exById(id) || {}).name || "Übung";
  const mmss = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const dayText = iso => new Date(iso).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
  const agoText = iso => {
    const d = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(iso).setHours(12, 0, 0, 0)) / 864e5);
    return d <= 0 ? "heute" : d === 1 ? "gestern" : `vor ${d} Tagen`;
  };
  const duration = s => {
    if (!s.finished_at) return "";
    const m = Math.round((new Date(s.finished_at) - new Date(s.started_at)) / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60} Min.` : `${m} Min.`;
  };
  const nSets = n => `${n} Satz${n === 1 ? "" : "e"}`;
  const planItems = pid => fx.items.filter(i => i.plan_id === pid).sort((a, b) => a.sort - b.sort);

  // ---------- Daten ----------
  async function loadAll() {
    const [ex, pl, it, se] = await Promise.all([
      sb.from("fit_exercises").select("*").eq("user_id", me()).order("name"),
      sb.from("fit_plans").select("*").eq("user_id", me()).order("sort").order("created_at"),
      sb.from("fit_plan_items").select("*").eq("user_id", me()).order("sort"),
      sb.from("fit_sessions").select("*").eq("user_id", me()).order("started_at", { ascending: false }).limit(60)
    ]);
    for (const r of [ex, pl, it, se]) if (r.error) throw r.error;
    fx.exercises = ex.data; fx.plans = pl.data; fx.items = it.data;
    fx.sessions = se.data.sort((a, b) => b.started_at.localeCompare(a.started_at));
    const st = await sb.from("fit_sets").select("id, session_id, exercise_id, set_no, reps, weight, created_at")
      .eq("user_id", me()).order("created_at", { ascending: false }).limit(3000);
    if (st.error) throw st.error;
    fx.sets = st.data.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const open = fx.sessions.find(s => !s.finished_at);
    if (open && (!fx.run || fx.run.session.id !== open.id)) restoreRun(open);
    if (!open) fx.run = null;
  }

  // Sätze einer Übung in einem Training
  const setsOf = (sid, exId) => fx.sets.filter(s => s.session_id === sid && s.exercise_id === exId).sort((a, b) => a.set_no - b.set_no);
  // Letztes abgeschlossenes Training mit dieser Übung (nicht das laufende)
  function lastSets(exId) {
    const cur = fx.run && fx.run.session.id;
    const s = fx.sets.find(x => x.exercise_id === exId && x.session_id !== cur);
    return s ? setsOf(s.session_id, exId) : [];
  }
  function best(exId) {
    let top = null;
    for (const s of fx.sets) if (s.exercise_id === exId && s.reps > 0 && (!top || +s.weight > +top.weight || (+s.weight === +top.weight && s.reps > top.reps))) top = s;
    return top;
  }

  // ---------- Laufendes Training ----------
  const RUN_KEY = id => `pp_fx_run_${id}`;
  function saveRun() {
    if (!fx.run) return;
    const { order, rows, rest, target } = fx.run;
    storageSet(RUN_KEY(fx.run.session.id), JSON.stringify({ order, rows, rest, target }));
  }
  function restoreRun(session) {
    let saved = null;
    try { saved = JSON.parse(storageGet(RUN_KEY(session.id)) || "null"); } catch { /* egal */ }
    const run = { session, order: [], rows: {}, rest: {}, target: {} };
    fx.run = run;
    if (saved) Object.assign(run, saved);
    else if (session.plan_id) for (const i of planItems(session.plan_id)) addToRun(run, i.exercise_id, i);
    // Übungen mit Sätzen, die (z. B. auf einem anderen Gerät) dazugekommen sind
    for (const s of fx.sets.filter(x => x.session_id === session.id)) if (!run.order.includes(s.exercise_id)) addToRun(run, s.exercise_id);
    fx.run = run;
  }
  function addToRun(run, exId, item) {
    if (run.order.includes(exId)) return;
    run.order.push(exId);
    const last = lastSets(exId);
    run.rows[exId] = item ? item.sets : Math.max(last.length, 3);
    run.rest[exId] = item ? item.rest_sec : 90;
    run.target[exId] = item ? item.reps : null;
  }

  async function startSession(planId) {
    if (fx.run) { renderBody(); return; }
    const plan = fx.plans.find(p => p.id === planId);
    const { data, error } = await sb.from("fit_sessions").insert({ plan_id: plan ? plan.id : null, plan_name: plan ? plan.name : "Freies Training" }).select().single();
    if (error) { toast(sqlHint(error), true); return; }
    fx.sessions.unshift(data);
    const run = { session: data, order: [], rows: {}, rest: {}, target: {} };
    fx.run = run;
    if (plan) for (const i of planItems(plan.id)) addToRun(run, i.exercise_id, i);
    saveRun();
    fx.tab = "train";
    render();
    refreshTile();
  }

  // Vorschlag für einen Satz: vorheriger Satz heute → gleicher Satz letztes Mal → Plan
  function suggest(exId, n) {
    const today = setsOf(fx.run.session.id, exId);
    const prevToday = today.filter(s => s.set_no < n).pop();
    const last = lastSets(exId);
    const lastN = last.find(s => s.set_no === n) || last[last.length - 1];
    const target = fx.run.target[exId];
    return {
      reps: (prevToday && prevToday.reps) || (lastN && lastN.reps) || target || "",
      weight: prevToday ? +prevToday.weight : lastN ? +lastN.weight : ""
    };
  }

  function exerciseCard(exId) {
    const ex = exById(exId) || { name: "Übung", machine: "" };
    const done = setsOf(fx.run.session.id, exId);
    const rows = Math.max(fx.run.rows[exId] || 0, done.length ? done[done.length - 1].set_no : 0);
    const last = lastSets(exId);
    const top = best(exId);
    let html = "";
    for (let n = 1; n <= rows; n++) {
      const s = done.find(x => x.set_no === n);
      const sug = s ? { reps: s.reps, weight: +s.weight } : suggest(exId, n);
      const isPr = s && top && top.id === s.id && fx.sets.filter(x => x.exercise_id === exId).length > 1;
      html += `<div class="fx-set${s ? " done" : ""}" data-ex="${exId}" data-n="${n}">
        <span class="fx-no">${n}</span>
        <input type="text" inputmode="numeric" class="fx-reps" value="${escapeHtml(String(sug.reps))}" aria-label="Wiederholungen Satz ${n}" ${s ? "disabled" : ""}>
        <span class="fx-x">×</span>
        <input type="text" inputmode="decimal" class="fx-kg" value="${sug.weight === "" ? "" : escapeHtml(kg(sug.weight))}" aria-label="Gewicht Satz ${n} in kg" ${s ? "disabled" : ""}>
        <span class="fx-unit">kg${isPr ? " 🏆" : ""}</span>
        <button type="button" class="check-btn${s ? " on" : ""}" data-fx-done="${s ? s.id : ""}" aria-label="${s ? "Satz zurücknehmen" : "Satz erledigt"}">${s ? "✓" : ""}</button>
      </div>`;
    }
    const allDone = rows && done.length >= rows;
    return `<div class="card fx-ex${allDone ? " fx-ex-done" : ""}">
      <div class="fx-ex-head">
        <button type="button" class="fx-ex-name" data-fx-ex="${exId}">${escapeHtml(ex.name)}${ex.machine ? ` <span class="muted small">· ${escapeHtml(ex.machine)}</span>` : ""}</button>
        <button type="button" class="icon-btn small" data-fx-remove="${exId}" aria-label="Übung aus dem Training nehmen">✕</button>
      </div>
      <p class="muted small fx-last">${last.length ? `Letztes Mal: ${last.map(s => `${s.reps} × ${kg(s.weight)}`).join(" · ")} kg` : "Zum ersten Mal"}${top && top.reps ? ` · 🏆 ${kg(top.weight)} kg × ${top.reps}` : ""}</p>
      ${html}
      <button type="button" class="link small" data-fx-addset="${exId}">+ Satz</button>
    </div>`;
  }

  function renderRun() {
    const r = fx.run;
    const sets = fx.sets.filter(s => s.session_id === r.session.id);
    const volume = sets.reduce((a, s) => a + s.reps * s.weight, 0);
    const free = fx.exercises.filter(e => !e.archived && !r.order.includes(e.id));
    return `<div class="card fx-run-head">
        <div><strong>${escapeHtml(r.session.plan_name || "Training")}</strong>
          <p class="muted small"><span id="fx-elapsed">${mmss((Date.now() - new Date(r.session.started_at)) / 1000)}</span> · ${nSets(sets.length)}${volume ? ` · ${kg(Math.round(volume))} kg bewegt` : ""}</p></div>
        <button type="button" class="btn btn-primary btn-small" id="btn-fx-finish">Beenden</button>
      </div>
      ${r.order.map(exerciseCard).join("") || `<p class="muted small">Noch keine Übung – unten eine hinzufügen.</p>`}
      <div class="fx-addex">
        <select id="fx-addex" aria-label="Übung hinzufügen"><option value="">+ Übung hinzufügen …</option>
          ${free.map(e => `<option value="${e.id}">${escapeHtml(e.name)}${e.muscle ? ` (${escapeHtml(e.muscle)})` : ""}</option>`).join("")}
          <option value="__new">＋ Neue Übung anlegen …</option></select>
      </div>
      <p class="small"><button type="button" class="link danger-link" id="btn-fx-discard">Training verwerfen</button></p>`;
  }

  // ---------- Übersicht ----------
  function renderTrain() {
    if (fx.run) return renderRun();
    const lastOf = pid => fx.sessions.find(s => s.plan_id === pid && s.finished_at);
    const plans = fx.plans.map(p => {
      const n = planItems(p.id).length, l = lastOf(p.id);
      return `<li><button class="ar-doc fx-plan" data-fx-start="${p.id}" ${n ? "" : "disabled"}>
        <span class="ar-icon">🏋️</span>
        <span class="ar-main"><span class="ar-title">${escapeHtml(p.name)}</span>
        <span class="ar-sub">${n} Übung${n === 1 ? "" : "en"}${l ? ` · zuletzt ${agoText(l.started_at)}` : ""}</span></span>
        <span class="fx-go">▶</span></button></li>`;
    }).join("");
    const done = fx.sessions.filter(s => s.finished_at);
    const hist = done.slice(0, 30).map(s => {
      const st = fx.sets.filter(x => x.session_id === s.id);
      const exs = new Set(st.map(x => x.exercise_id)).size;
      return `<li><button class="ar-doc" data-fx-session="${s.id}">
        <span class="ar-icon">📅</span>
        <span class="ar-main"><span class="ar-title">${escapeHtml(dayText(s.started_at))} · ${escapeHtml(s.plan_name || "Training")}</span>
        <span class="ar-sub">${[duration(s), `${exs} Übung${exs === 1 ? "" : "en"}`, nSets(st.length)].filter(Boolean).join(" · ")}</span></span></button></li>`;
    }).join("");
    const intro = !fx.exercises.length
      ? `<div class="empty"><div class="empty-icon">🏋️</div><p><strong>Willkommen im Fitnesstagebuch.</strong></p>
         <p class="muted small">1. Unter „Übungen“ deine Geräte und Übungen anlegen.<br>2. Unter „Pläne“ feste Trainingspläne zusammenstellen.<br>3. Im Studio den Plan antippen und Satz für Satz abhaken.</p>
         <button class="btn btn-primary" data-fx-tab="exercises">Erste Übung anlegen</button></div>`
      : !fx.plans.length ? `<div class="empty"><p class="muted small">Noch kein Trainingsplan.</p><button class="btn btn-primary" id="btn-fx-plan-new">+ Plan anlegen</button></div>` : "";
    return intro +
      (plans ? `<h4 class="cal-sub">Training starten</h4><ul class="ar-list">${plans}</ul>` : "") +
      (fx.exercises.length ? `<button type="button" class="btn btn-small" data-fx-start="">Freies Training ohne Plan</button>` : "") +
      (hist ? `<h4 class="cal-sub">Letzte Trainings</h4><ul class="ar-list">${hist}</ul>` : "");
  }

  function renderPlans() {
    return `<ul class="ar-list">${fx.plans.map(p => {
      const its = planItems(p.id);
      return `<li><button class="ar-doc" data-fx-plan="${p.id}"><span class="ar-icon">📋</span>
        <span class="ar-main"><span class="ar-title">${escapeHtml(p.name)}</span>
        <span class="ar-sub">${its.length ? its.map(i => escapeHtml(exName(i.exercise_id))).join(", ") : "noch leer"}</span></span></button></li>`;
    }).join("")}</ul>
      ${fx.plans.length ? "" : `<p class="muted small">Ein Plan ist eine feste Folge von Übungen mit Sätzen, Wiederholungen und Pause – z. B. „Plan A – Oberkörper“.</p>`}
      <button type="button" class="btn btn-primary" id="btn-fx-plan-new">+ Plan anlegen</button>`;
  }

  function renderExercises() {
    const list = fx.exercises.filter(e => !e.archived);
    const groups = [...new Set(list.map(e => e.muscle || ""))].sort((a, b) => (a === "") - (b === "") || MUSCLES.indexOf(a) - MUSCLES.indexOf(b));
    return groups.map(g => `<h4 class="cal-sub">${escapeHtml(g || "Ohne Muskelgruppe")}</h4><ul class="ar-list">${list.filter(e => (e.muscle || "") === g).map(e => {
      const top = best(e.id);
      return `<li><button class="ar-doc" data-fx-ex="${e.id}"><span class="ar-icon">💪</span>
        <span class="ar-main"><span class="ar-title">${escapeHtml(e.name)}</span>
        <span class="ar-sub">${[e.machine, top && top.reps ? `🏆 ${kg(top.weight)} kg × ${top.reps}` : ""].filter(Boolean).map(escapeHtml).join(" · ") || "noch nicht trainiert"}</span></span></button></li>`;
    }).join("")}</ul>`).join("") +
      (list.length ? "" : `<p class="muted small">Leg die Übungen an, die du im Studio machst – gern mit der Gerätenummer.</p>`) +
      `<button type="button" class="btn btn-primary" id="btn-fx-ex-new">+ Übung anlegen</button>`;
  }

  function renderBody() {
    const box = $("#fx-body");
    if (!box) return;
    box.innerHTML = fx.tab === "plans" ? renderPlans() : fx.tab === "exercises" ? renderExercises() : renderTrain();
  }

  function render() {
    $("#fx-tabs").innerHTML = [["train", fx.run ? "⏱️ Training läuft" : "🏋️ Training"], ["plans", "📋 Pläne"], ["exercises", "💪 Übungen"]]
      .map(([k, l]) => `<button class="chip${fx.tab === k ? " active" : ""}" data-fx-tab="${k}">${l}</button>`).join("");
    renderBody();
    renderRest();
  }

  // ---------- Pausen-Timer ----------
  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach(t => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; g.gain.value = 0.15;
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.15);
      });
    } catch { /* kein Ton */ }
  }
  function startRest(sec) {
    stopRest();
    if (!sec) return;
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch { /* egal */ }
    fx.rest = { until: Date.now() + sec * 1000, total: sec };
    fx.rest.timer = setInterval(renderRest, 250);
    renderRest();
  }
  function stopRest() {
    if (fx.rest) clearInterval(fx.rest.timer);
    fx.rest = null;
    renderRest();
  }
  function renderRest() {
    const bar = $("#fx-rest");
    if (!bar) return;
    if (!fx.rest) { bar.hidden = true; return; }
    const left = (fx.rest.until - Date.now()) / 1000;
    if (left <= 0) {
      stopRest();
      beep();
      if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
      toast("Pause vorbei – nächster Satz! 💪");
      return;
    }
    if (!fx.active) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<div class="fx-rest-fill" style="width:${Math.max(0, Math.min(100, left / fx.rest.total * 100))}%"></div>
      <span class="fx-rest-text">Pause <strong>${mmss(left)}</strong></span>
      <button type="button" class="btn btn-small" data-fx-rest="-15">−15</button>
      <button type="button" class="btn btn-small" data-fx-rest="15">+15</button>
      <button type="button" class="icon-btn small" data-fx-rest="stop" aria-label="Pause beenden">✕</button>`;
  }
  $("#fx-rest").addEventListener("click", e => {
    const b = e.target.closest("[data-fx-rest]");
    if (!b || !fx.rest) return;
    if (b.dataset.fxRest === "stop") { stopRest(); return; }
    fx.rest.until += Number(b.dataset.fxRest) * 1000;
    fx.rest.total = Math.max(fx.rest.total, (fx.rest.until - Date.now()) / 1000);
    renderRest();
  });

  // ---------- Bedienung: Übersicht & Training ----------
  $("#fx-tabs").addEventListener("click", e => {
    const b = e.target.closest("[data-fx-tab]");
    if (b) { fx.tab = b.dataset.fxTab; render(); }
  });

  $("#fx-body").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.fxTab) { fx.tab = b.dataset.fxTab; render(); if (fx.tab === "exercises" && !fx.exercises.length) openExercise(null); return; }
    if (b.dataset.fxStart !== undefined) { b.disabled = true; await startSession(b.dataset.fxStart); return; }
    if (b.dataset.fxSession) { openSession(b.dataset.fxSession); return; }
    if (b.dataset.fxPlan) { openPlan(b.dataset.fxPlan); return; }
    if (b.id === "btn-fx-plan-new") { openPlan(null); return; }
    if (b.id === "btn-fx-ex-new") { openExercise(null); return; }
    if (b.dataset.fxEx) { openExercise(b.dataset.fxEx); return; }
    if (b.id === "btn-fx-finish") { finish(); return; }
    if (b.id === "btn-fx-discard") { discard(); return; }
    if (b.dataset.fxAddset) {
      const id = b.dataset.fxAddset;
      fx.run.rows[id] = Math.max(fx.run.rows[id] || 0, setsOf(fx.run.session.id, id).length) + 1;
      saveRun(); renderBody(); return;
    }
    if (b.dataset.fxRemove) {
      const id = b.dataset.fxRemove;
      if (setsOf(fx.run.session.id, id).length && !confirm(`„${exName(id)}“ samt erledigter Sätze aus diesem Training nehmen?`)) return;
      const del = setsOf(fx.run.session.id, id).map(s => s.id);
      if (del.length) {
        const { error } = await sb.from("fit_sets").delete().in("id", del);
        if (error) { toast(sqlHint(error), true); return; }
        fx.sets = fx.sets.filter(s => !del.includes(s.id));
      }
      fx.run.order = fx.run.order.filter(x => x !== id);
      saveRun(); renderBody(); return;
    }
    if (b.dataset.fxDone !== undefined) { toggleSet(b); return; }
  });

  async function toggleSet(b) {
    const row = b.closest(".fx-set");
    const exId = row.dataset.ex, n = +row.dataset.n;
    if (b.dataset.fxDone) {   // zurücknehmen
      const { error } = await sb.from("fit_sets").delete().eq("id", b.dataset.fxDone);
      if (error) { toast(sqlHint(error), true); return; }
      fx.sets = fx.sets.filter(s => s.id !== b.dataset.fxDone);
      renderBody(); return;
    }
    const reps = Math.round(num(row.querySelector(".fx-reps").value) ?? NaN);
    const weight = num(row.querySelector(".fx-kg").value) ?? 0;
    if (!Number.isFinite(reps) || reps < 0 || reps > 500) { toast("Bitte die Wiederholungen eintragen.", true); row.querySelector(".fx-reps").focus(); return; }
    if (weight < 0 || weight > 1000) { toast("Das Gewicht passt nicht.", true); return; }
    b.disabled = true;
    const before = best(exId);
    const { data, error } = await sb.from("fit_sets").insert({ session_id: fx.run.session.id, exercise_id: exId, set_no: n, reps, weight })
      .select("id, session_id, exercise_id, set_no, reps, weight, created_at").single();
    b.disabled = false;
    if (error) { toast(sqlHint(error), true); return; }
    fx.sets.unshift(data);
    if (before && reps > 0 && (weight > +before.weight || (weight === +before.weight && reps > before.reps))) toast(`🏆 Neue Bestleistung: ${kg(weight)} kg × ${reps}!`);
    renderBody();
    // Pause nach jedem Satz – außer nach dem letzten Satz der letzten Übung
    const lastEx = fx.run.order[fx.run.order.length - 1];
    const finishedAll = exId === lastEx && setsOf(fx.run.session.id, exId).length >= (fx.run.rows[exId] || 0);
    if (!finishedAll) startRest(fx.run.rest[exId] ?? 90);
  }

  $("#fx-body").addEventListener("change", e => {
    if (e.target.id !== "fx-addex" || !fx.run) return;
    const v = e.target.value;
    e.target.value = "";
    if (v === "__new") { openExercise(null, true); return; }
    if (!v) return;
    addToRun(fx.run, v);
    saveRun(); renderBody();
  });
  // Enter im Gewichtsfeld = Satz abhaken
  $("#fx-body").addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target.closest(".fx-set")) return;
    e.preventDefault();
    const btn = e.target.closest(".fx-set").querySelector("[data-fx-done]");
    if (btn && !btn.dataset.fxDone) toggleSet(btn);
  });

  async function finish() {
    const r = fx.run;
    const sets = fx.sets.filter(s => s.session_id === r.session.id);
    if (!sets.length) { if (confirm("Noch kein Satz erledigt – Training verwerfen?")) discard(true); return; }
    const open = r.order.reduce((a, id) => a + Math.max(0, (r.rows[id] || 0) - setsOf(r.session.id, id).length), 0);
    if (open && !confirm(`${open} Satz${open === 1 ? "" : "e"} noch offen. Training trotzdem beenden?`)) return;
    const { data, error } = await sb.from("fit_sessions").update({ finished_at: new Date().toISOString() }).eq("id", r.session.id).select().single();
    if (error) { toast(sqlHint(error), true); return; }
    Object.assign(r.session, data);
    const i = fx.sessions.findIndex(s => s.id === data.id);
    if (i >= 0) fx.sessions[i] = data;
    storageSet(RUN_KEY(r.session.id), "");
    fx.run = null;
    stopRest();
    const exs = new Set(sets.map(s => s.exercise_id)).size;
    toast(`Stark! ${duration(data)} · ${exs} Übung${exs === 1 ? "" : "en"} · ${nSets(sets.length)}. 💪`);
    render(); refreshTile();
  }

  async function discard(silent) {
    const r = fx.run;
    if (!r || (!silent && !confirm("Dieses Training mit allen Sätzen löschen?"))) return;
    const { error } = await sb.from("fit_sessions").delete().eq("id", r.session.id);
    if (error) { toast(sqlHint(error), true); return; }
    fx.sessions = fx.sessions.filter(s => s.id !== r.session.id);
    fx.sets = fx.sets.filter(s => s.session_id !== r.session.id);
    storageSet(RUN_KEY(r.session.id), "");
    fx.run = null;
    stopRest();
    render(); refreshTile();
  }

  // ---------- Vergangenes Training ansehen ----------
  function openSession(id) {
    const s = fx.sessions.find(x => x.id === id);
    if (!s) return;
    const st = fx.sets.filter(x => x.session_id === id);
    const exs = [...new Set(st.slice().reverse().map(x => x.exercise_id))];
    const vol = st.reduce((a, x) => a + x.reps * x.weight, 0);
    $("#fx-sheet-title").textContent = `${dayText(s.started_at)} · ${s.plan_name || "Training"}`;
    $("#fx-sheet-body").innerHTML = `<p class="muted small">${[new Date(s.started_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr", duration(s), vol ? `${kg(Math.round(vol))} kg bewegt` : ""].filter(Boolean).join(" · ")}</p>
      ${exs.map(e => `<div class="fx-hist"><strong>${escapeHtml(exName(e))}</strong>
        <span class="muted small">${setsOf(id, e).map(x => `${x.reps} × ${kg(x.weight)}`).join(" · ")} kg</span></div>`).join("") || `<p class="muted small">Keine Sätze.</p>`}
      <div class="note-actions"><span></span><button type="button" class="link danger-link" data-fx-del-session="${id}">Training löschen</button></div>`;
    openSheet("sheet-fx");
  }

  // ---------- Übung anlegen / bearbeiten + Verlauf ----------
  function chart(exId) {
    // bestes Gewicht je Training, älteste zuerst
    const by = new Map();
    for (const s of fx.sets) {
      if (s.exercise_id !== exId || !s.reps) continue;
      const cur = by.get(s.session_id);
      if (!cur || +s.weight > cur.w) by.set(s.session_id, { w: +s.weight, t: s.created_at });
    }
    const pts = [...by.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-20);
    if (pts.length < 2) return pts.length ? `<p class="muted small">Ein Training bisher – ab dem zweiten siehst du hier die Kurve.</p>` : "";
    const W = 320, H = 120, P = 16;
    const lo = Math.min(...pts.map(p => p.w)), hi = Math.max(...pts.map(p => p.w));
    const span = hi - lo || 1;
    const xy = pts.map((p, i) => [P + i * (W - 2 * P) / (pts.length - 1), H - P - (p.w - lo) / span * (H - 2 * P)]);
    return `<svg class="fx-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">
      <polyline points="${xy.map(p => p.map(v => v.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === xy.length - 1 ? 4.5 : 3}" fill="currentColor"/>`).join("")}
      <text x="${P}" y="11" class="fx-chart-label">${kg(hi)} kg</text>
      <text x="${P}" y="${H - 2}" class="fx-chart-label">${kg(lo)} kg</text>
    </svg><p class="muted small">Schwerster Satz je Training · ${new Date(pts[0].t).toLocaleDateString("de-DE")} bis ${new Date(pts[pts.length - 1].t).toLocaleDateString("de-DE")}</p>`;
  }

  function openExercise(id, addToTraining) {
    const e = id ? exById(id) : null;
    fx.editEx = { id, addToTraining: !!addToTraining };
    const top = e && best(e.id);
    const sessions = e ? [...new Set(fx.sets.filter(s => s.exercise_id === e.id).map(s => s.session_id))].slice(0, 8) : [];
    $("#fx-sheet-title").textContent = e ? e.name : "Neue Übung";
    $("#fx-sheet-body").innerHTML = `
      ${e ? `${top && top.reps ? `<p class="fx-pr">🏆 Bestleistung <strong>${kg(top.weight)} kg × ${top.reps}</strong> <span class="muted small">(${new Date(top.created_at).toLocaleDateString("de-DE")})</span></p>` : ""}
        ${chart(e.id)}
        ${sessions.length ? `<h3 class="sheet-sub">Verlauf</h3>${sessions.map(sid => {
          const s = fx.sessions.find(x => x.id === sid);
          return `<div class="fx-hist"><span>${s ? escapeHtml(dayText(s.started_at)) : ""}</span><span class="muted small">${setsOf(sid, e.id).map(x => `${x.reps} × ${kg(x.weight)}`).join(" · ")} kg</span></div>`;
        }).join("")}` : ""}
        <h3 class="sheet-sub">Angaben</h3>` : ""}
      <form id="form-fx-ex" class="form" autocomplete="off">
        <label>Name <input type="text" name="name" maxlength="80" required placeholder="z. B. Bankdrücken" value="${escapeHtml(e ? e.name : "")}"></label>
        <div class="form-row form-row-even">
          <label>Muskelgruppe <select name="muscle"><option value="">–</option>${MUSCLES.map(m => `<option${e && e.muscle === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
          <label>Gerät / Nr. <input type="text" name="machine" maxlength="60" placeholder="z. B. Gerät 12" value="${escapeHtml(e ? e.machine : "")}"></label>
        </div>
        <label>Notiz <span class="hint">(optional)</span><textarea name="note" rows="2" maxlength="500" placeholder="z. B. Sitzhöhe 4, Lehne Stufe 2">${escapeHtml(e ? e.note : "")}</textarea></label>
        <button type="submit" class="btn btn-primary btn-block">Speichern</button>
      </form>
      ${e ? `<div class="note-actions"><span></span><button type="button" class="link danger-link" data-fx-del-ex="${e.id}">Übung löschen</button></div>` : ""}`;
    openSheet("sheet-fx");
    if (!e) setTimeout(() => $("#form-fx-ex").name.focus(), 60);
  }

  // ---------- Plan bearbeiten ----------
  function openPlan(id) {
    const p = id ? fx.plans.find(x => x.id === id) : null;
    fx.draft = { id, name: p ? p.name : "", items: p ? planItems(p.id).map(i => ({ exercise_id: i.exercise_id, sets: i.sets, reps: i.reps, rest_sec: i.rest_sec })) : [] };
    $("#fx-sheet-title").textContent = p ? p.name : "Neuer Plan";
    renderPlanEditor();
    openSheet("sheet-fx");
  }
  function renderPlanEditor() {
    const d = fx.draft;
    const avail = fx.exercises.filter(e => !e.archived && !d.items.some(i => i.exercise_id === e.id));
    $("#fx-sheet-body").innerHTML = `<form id="form-fx-plan" class="form" autocomplete="off">
      <label>Name <input type="text" name="name" maxlength="60" required placeholder="z. B. Plan A – Oberkörper" value="${escapeHtml(d.name)}"></label>
      <h3 class="sheet-sub">Übungen</h3>
      <div class="fx-plan-items">${d.items.map((i, k) => `<div class="fx-pi" data-k="${k}">
          <span class="fx-pi-name">${k + 1}. ${escapeHtml(exName(i.exercise_id))}</span>
          <label class="fx-pi-f">Sätze<input type="number" min="1" max="20" data-f="sets" value="${i.sets}"></label>
          <label class="fx-pi-f">Wdh.<input type="number" min="1" max="200" data-f="reps" value="${i.reps}"></label>
          <label class="fx-pi-f">Pause s<input type="number" min="0" max="900" step="15" data-f="rest_sec" value="${i.rest_sec}"></label>
          <span class="fx-pi-btns">
            <button type="button" class="icon-btn small" data-pi="up" ${k ? "" : "disabled"} aria-label="Nach oben">↑</button>
            <button type="button" class="icon-btn small" data-pi="down" ${k < d.items.length - 1 ? "" : "disabled"} aria-label="Nach unten">↓</button>
            <button type="button" class="icon-btn small" data-pi="del" aria-label="Entfernen">✕</button></span>
        </div>`).join("") || `<p class="muted small">Noch keine Übung im Plan.</p>`}</div>
      ${avail.length ? `<select id="fx-pi-add" aria-label="Übung hinzufügen"><option value="">+ Übung hinzufügen …</option>${avail.map(e => `<option value="${e.id}">${escapeHtml(e.name)}${e.muscle ? ` (${escapeHtml(e.muscle)})` : ""}</option>`).join("")}</select>`
        : `<p class="muted small">${fx.exercises.length ? "Alle Übungen sind schon im Plan." : "Erst unter „Übungen“ Übungen anlegen."}</p>`}
      <button type="submit" class="btn btn-primary btn-block">Plan speichern</button>
    </form>
    ${d.id ? `<div class="note-actions"><span></span><button type="button" class="link danger-link" data-fx-del-plan="${d.id}">Plan löschen</button></div>` : ""}`;
  }

  $("#fx-sheet-body").addEventListener("input", e => {
    if (!fx.draft) return;
    if (e.target.name === "name" && e.target.form && e.target.form.id === "form-fx-plan") fx.draft.name = e.target.value;
    const pi = e.target.closest(".fx-pi");
    if (pi && e.target.dataset.f) fx.draft.items[+pi.dataset.k][e.target.dataset.f] = Math.round(num(e.target.value) ?? 0);
  });
  $("#fx-sheet-body").addEventListener("change", e => {
    if (e.target.id !== "fx-pi-add" || !e.target.value) return;
    const last = lastSets(e.target.value);
    fx.draft.items.push({ exercise_id: e.target.value, sets: Math.max(last.length, 3), reps: (last[0] && last[0].reps) || 10, rest_sec: 90 });
    renderPlanEditor();
  });

  $("#fx-sheet-body").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.pi) {
      const k = +b.closest(".fx-pi").dataset.k, its = fx.draft.items;
      if (b.dataset.pi === "del") its.splice(k, 1);
      else { const j = b.dataset.pi === "up" ? k - 1 : k + 1; [its[k], its[j]] = [its[j], its[k]]; }
      renderPlanEditor(); return;
    }
    if (b.dataset.fxDelPlan) {
      if (!confirm("Diesen Plan löschen? Vergangene Trainings bleiben erhalten.")) return;
      const { error } = await sb.from("fit_plans").delete().eq("id", b.dataset.fxDelPlan);
      if (error) { toast(sqlHint(error), true); return; }
      fx.plans = fx.plans.filter(p => p.id !== b.dataset.fxDelPlan);
      fx.items = fx.items.filter(i => i.plan_id !== b.dataset.fxDelPlan);
      closeSheets(); render(); return;
    }
    if (b.dataset.fxDelEx) {
      const id = b.dataset.fxDelEx, used = fx.sets.some(s => s.exercise_id === id);
      if (!confirm(used ? "Übung löschen? Dein Verlauf bleibt in vergangenen Trainings erhalten, die Übung verschwindet aus Listen und Plänen." : "Übung löschen?")) return;
      const q = used ? sb.from("fit_exercises").update({ archived: true }).eq("id", id) : sb.from("fit_exercises").delete().eq("id", id);
      const { error } = await q;
      if (error) { toast(sqlHint(error), true); return; }
      if (used) {
        await sb.from("fit_plan_items").delete().eq("exercise_id", id);
        exById(id).archived = true;
      } else fx.exercises = fx.exercises.filter(x => x.id !== id);
      fx.items = fx.items.filter(i => i.exercise_id !== id);
      closeSheets(); render(); return;
    }
    if (b.dataset.fxDelSession) {
      if (!confirm("Dieses Training löschen?")) return;
      const id = b.dataset.fxDelSession;
      const { error } = await sb.from("fit_sessions").delete().eq("id", id);
      if (error) { toast(sqlHint(error), true); return; }
      fx.sessions = fx.sessions.filter(s => s.id !== id);
      fx.sets = fx.sets.filter(s => s.session_id !== id);
      closeSheets(); render(); refreshTile();
    }
  });

  $("#fx-sheet-body").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      if (f.id === "form-fx-ex") {
        const row = { name: f.name.value.trim().slice(0, 80), muscle: f.muscle.value, machine: f.machine.value.trim().slice(0, 60), note: f.note.value.trim().slice(0, 500) };
        if (!row.name) throw new Error("Bitte einen Namen eingeben.");
        const id = fx.editEx && fx.editEx.id;
        const q = id ? sb.from("fit_exercises").update(row).eq("id", id) : sb.from("fit_exercises").insert(row);
        const { data, error } = await q.select().single();
        if (error) throw new Error(sqlHint(error));
        if (id) Object.assign(exById(id), data); else fx.exercises.push(data);
        fx.exercises.sort((a, b) => a.name.localeCompare(b.name, "de"));
        if (!id && fx.editEx.addToTraining && fx.run) { addToRun(fx.run, data.id); saveRun(); }
        closeSheets(); render();
        toast(id ? "Gespeichert." : `„${data.name}“ angelegt.`);
      }
      if (f.id === "form-fx-plan") {
        const d = fx.draft;
        const name = f.name.value.trim().slice(0, 60);
        if (!name) throw new Error("Bitte einen Namen eingeben.");
        let plan;
        if (d.id) {
          const r = await sb.from("fit_plans").update({ name }).eq("id", d.id).select().single();
          if (r.error) throw new Error(sqlHint(r.error));
          plan = r.data;
          const del = await sb.from("fit_plan_items").delete().eq("plan_id", d.id);
          if (del.error) throw new Error(sqlHint(del.error));
        } else {
          const r = await sb.from("fit_plans").insert({ name, sort: fx.plans.length }).select().single();
          if (r.error) throw new Error(sqlHint(r.error));
          plan = r.data;
        }
        const clamp = (v, lo, hi, def) => Math.min(hi, Math.max(lo, Number.isFinite(v) && v ? v : def));
        const rows = d.items.map((i, k) => ({ plan_id: plan.id, exercise_id: i.exercise_id, sort: k,
          sets: clamp(i.sets, 1, 20, 3), reps: clamp(i.reps, 1, 200, 10), rest_sec: Math.min(900, Math.max(0, Number.isFinite(i.rest_sec) ? i.rest_sec : 90)) }));
        let saved = [];
        if (rows.length) {
          const r = await sb.from("fit_plan_items").insert(rows).select();
          if (r.error) throw new Error(sqlHint(r.error));
          saved = r.data;
        }
        fx.plans = d.id ? fx.plans.map(p => p.id === plan.id ? plan : p) : [...fx.plans, plan];
        fx.items = fx.items.filter(i => i.plan_id !== plan.id).concat(saved);
        closeSheets(); render();
        toast("Plan gespeichert.");
      }
    });
  });

  // ---------- Uhr fürs laufende Training ----------
  function startTick() {
    stopTick();
    fx.tick = setInterval(() => {
      const el = $("#fx-elapsed");
      if (el && fx.run) el.textContent = mmss((Date.now() - new Date(fx.run.session.started_at)) / 1000);
    }, 1000);
  }
  function stopTick() { if (fx.tick) clearInterval(fx.tick); fx.tick = null; }

  // ---------- Startseite ----------
  async function refreshTile() {
    const el = $("#tile-fx-status");
    if (!el || !state.session) return;
    const { data, error } = await sb.from("fit_sessions").select("started_at, finished_at").eq("user_id", me()).order("started_at", { ascending: false }).limit(1);
    if (error || !data || !data[0]) { el.textContent = "Training starten"; return; }
    const s = data[0];
    el.textContent = !s.finished_at ? `Läuft seit ${Math.max(1, Math.round((Date.now() - new Date(s.started_at)) / 60000))} Min.` : `Zuletzt ${agoText(s.started_at)}`;
  }

  PP.modules.fitness = {
    async enter() {
      fx.active = true;
      try { await loadAll(); } catch (err) { console.error(err); toast(sqlHint(err), true); }
      if (fx.run) fx.tab = "train";
      render();
      startTick();
    },
    leave() { fx.active = false; stopTick(); renderRest(); closeSheets(); },
    async resume() { if (fx.active) { try { await loadAll(); render(); } catch { /* egal */ } } else refreshTile(); },
    refreshTile,
    reset() { this.leave(); stopRest(); fx.run = null; fx.exercises = []; fx.plans = []; fx.items = []; fx.sessions = []; fx.sets = []; }
  };
})();
