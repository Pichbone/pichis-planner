// =========================================================
// Pichis Planner – Tag planen (KI + Regel-Planer)
// Freie Zeiten berechnet die App selbst. An die KI gehen nur
// freie Zeitfenster und Aufgaben – keine Termintitel.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, memberName, openSheet, closeSheets } = PP;

  const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

  const pl = {
    date: null,
    result: null,     // { plan, unplanned, summary, source, note }
    busy: [],         // für die Anzeige
    tasks: new Map(), // id → Aufgabe
    selected: new Set(),
    suggestion: null, // { todo, placement }
    token: 0,
    sToken: 0
  };

  // ---------- Datum und Zeit ----------
  const pad = n => String(n).padStart(2, "0");
  function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(iso, n) { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoDate(d); }
  function toMin(hhmm) { const [h, m] = String(hhmm).slice(0, 5).split(":").map(Number); return h * 60 + m; }
  function toHHMM(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
  function todayIso() { return isoDate(new Date()); }

  function dayName(iso) {
    const t = todayIso();
    if (iso === t) return "Heute";
    if (iso === addDays(t, 1)) return "Morgen";
    if (iso === addDays(t, 2)) return "Übermorgen";
    const d = parseIso(iso);
    return `${WEEKDAYS[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
  }

  function durationText(min) {
    if (min < 60) return `${min} Min.`;
    return min % 60 === 0 ? `${min / 60} Std.` : `${String(Math.round(min / 6) / 10).replace(".", ",")} Std.`;
  }

  // ---------- Einstellungen ----------
  function settings() {
    const p = state.profile || {};
    const t = (v, d) => (v ? String(v).slice(0, 5) : d);
    return {
      ai: p.plan_ai !== false,
      suggest: p.plan_suggest !== false,
      weekday: [t(p.plan_weekday_start, "17:00"), t(p.plan_weekday_end, "21:00")],
      weekend: [t(p.plan_weekend_start, "09:00"), t(p.plan_weekend_end, "19:00")],
      defaultMinutes: p.plan_default_minutes || 30,
      buffer: p.plan_buffer_minutes ?? 10,
      model: p.plan_model || "haiku"
    };
  }

  // ---------- Server-Aufrufe ----------
  async function invoke(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let msg = error.message, status = "";
      try {
        const res = error.context;
        status = res && res.status;
        const raw = await res.text();
        try { const j = JSON.parse(raw); msg = j.error || j.message || raw; } catch { if (raw) msg = raw.slice(0, 200); }
      } catch { /* keine Antwort */ }
      if (status === 404) msg = `Die Funktion „${name}“ ist noch nicht eingerichtet.`;
      const err = new Error(msg);
      err.status = status;
      throw err;
    }
    return data;
  }

  // ---------- Was ist belegt? ----------
  const me = () => state.session.user.id;

  function isMine(t) {
    return t.assigned_to === me() || (!t.assigned_to && t.created_by === me());
  }

  async function loadContext(dates) {
    const hid = state.household.id;
    const first = parseIso(dates[0]);
    const end = parseIso(addDays(dates[dates.length - 1], 1));

    const [todosRes, metaRes, eventsRes] = await Promise.all([
      sb.from("todos")
        .select("id, title, due_date, due_time, duration_minutes, priority, assigned_to, created_by, is_private, created_at")
        .eq("household_id", hid).eq("is_done", false),
      sb.from("event_meta").select("calendar_id, uid, member_ids").eq("household_id", hid),
      invoke("icloud", { action: "events", start: first.toISOString(), end: end.toISOString() })
        .catch(err => ({ events: [], failed: err.message }))
    ]);
    if (todosRes.error) throw todosRes.error;

    const metas = new Map((metaRes.data || []).map(m => [m.calendar_id + "|" + m.uid, m]));
    const todos = todosRes.data.filter(isMine);

    // Nur eigene Termine und solche, bei denen ich dabei bin, blockieren meine Zeit
    const events = (eventsRes.events || []).filter(ev => {
      if (ev.owner_id === me()) return true;
      const m = metas.get(ev.calendar_id + "|" + ev.uid);
      return !!(m && m.member_ids && m.member_ids.includes(me()));
    });

    return { todos, events, calendarNote: eventsRes.failed || (eventsRes.errors && eventsRes.errors.length ? "Einige Kalender konnten nicht geladen werden." : "") };
  }

  // Belegte Zeiten eines Tages (Minuten), mit Titel nur für die Anzeige
  function busyOn(date, ctx, cfg) {
    const out = [];
    for (const ev of ctx.events) {
      if (ev.all_day) continue;
      const s = new Date(ev.start), e = new Date(ev.end);
      const sd = isoDate(s), ed = isoDate(new Date(+e - 1));
      if (ed < date || sd > date) continue;
      const from = sd < date ? 0 : s.getHours() * 60 + s.getMinutes();
      const to = isoDate(e) > date ? 24 * 60 : e.getHours() * 60 + e.getMinutes();
      if (to > from) out.push({ from, to, label: ev.title, kind: "event", color: ev.calendar_color });
    }
    for (const t of ctx.todos) {
      if (t.due_date !== date || !t.due_time) continue;
      const from = toMin(t.due_time);
      out.push({ from, to: Math.min(from + (t.duration_minutes || cfg.defaultMinutes), 24 * 60), label: t.title, kind: "todo" });
    }
    return out.sort((a, b) => a.from - b.from);
  }

  // Freie Zeitfenster eines Tages
  function freeSlots(date, busy, cfg) {
    const d = parseIso(date);
    const [ws, we] = (d.getDay() === 0 || d.getDay() === 6) ? cfg.weekend : cfg.weekday;
    let start = toMin(ws);
    const end = toMin(we);
    if (date === todayIso()) {
      const now = new Date();
      const nowMin = Math.ceil((now.getHours() * 60 + now.getMinutes() + 5) / 15) * 15;
      start = Math.max(start, nowMin);
    }
    if (end - start < 10) return [];

    let free = [[start, end]];
    for (const b of busy) {
      const bs = b.from - cfg.buffer, be = b.to + cfg.buffer;
      free = free.flatMap(([fs, fe]) => {
        if (be <= fs || bs >= fe) return [[fs, fe]];
        const parts = [];
        if (bs > fs) parts.push([fs, bs]);
        if (be < fe) parts.push([be, fe]);
        return parts;
      });
    }
    return free.filter(([a, b]) => b - a >= 10).map(([a, b]) => ({ date, start: toHHMM(a), end: toHHMM(b) }));
  }

  // Kandidaten für einen Tag: meine offenen Aufgaben ohne Uhrzeit
  function candidates(ctx, date) {
    const t = todayIso();
    const horizon = addDays(date, 7);
    const rank = x => {
      if (x.due_date && x.due_date < t) return 0;
      if (x.priority) return 1;
      if (x.due_date && x.due_date <= date) return 2;
      if (x.due_date) return 3;
      return 4;
    };
    return ctx.todos
      .filter(x => !x.due_time && (!x.due_date || x.due_date <= horizon))
      .sort((a, b) => rank(a) - rank(b) ||
        String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")) ||
        String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, 25);
  }

  function taskPayload(t) {
    return {
      id: t.id,
      title: t.title,
      minutes: t.duration_minutes || null,
      due: t.due_date || null,
      important: !!t.priority,
      overdue: !!(t.due_date && t.due_date < todayIso())
    };
  }

  // ---------- Regel-Planer (ohne KI) ----------
  function rulePlan(tasks, slots, cfg) {
    const free = slots.map(s => ({ date: s.date, from: toMin(s.start), to: toMin(s.end) }));
    const plan = [], unplanned = [];
    const t = todayIso();
    for (const task of tasks) {
      const minutes = task.duration_minutes || cfg.defaultMinutes;
      const seg = free.find(f => f.to - f.from >= minutes);
      if (!seg) {
        unplanned.push({ id: task.id, reason: "Keine passende Lücke mehr frei." });
        continue;
      }
      const start = seg.from;
      seg.from = start + minutes + cfg.buffer;
      let reason = "Passt in die Lücke.";
      if (task.due_date && task.due_date < t) reason = "Überfällig – deshalb zuerst.";
      else if (task.priority) reason = "Wichtig – deshalb früh eingeplant.";
      else if (task.due_date && task.due_date <= seg.date) reason = "Ist bis dahin fällig.";
      plan.push({ id: task.id, date: seg.date, start: toHHMM(start), end: toHHMM(start + minutes), minutes, reason });
    }
    return { plan, unplanned, summary: "", source: "rules" };
  }

  // ---------- Planen (KI mit Rückfall auf Regeln) ----------
  async function makePlan(tasks, slots, cfg, mode) {
    if (cfg.ai) {
      try {
        const now = new Date();
        const r = await invoke("plan", {
          mode,
          today: todayIso(),
          now: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
          slots,
          tasks: tasks.map(taskPayload),
          buffer: cfg.buffer,
          default_minutes: cfg.defaultMinutes,
          model: cfg.model
        });
        return { ...r, source: "ai" };
      } catch (err) {
        const r = rulePlan(tasks, slots, cfg);
        r.note = `KI nicht verfügbar (${err.message}) – Regel-Planer verwendet.`;
        return r;
      }
    }
    return rulePlan(tasks, slots, cfg);
  }

  // =========================================================
  // Fenster „Tag planen“
  // =========================================================
  async function open(date) {
    pl.date = date || todayIso();
    openSheet("sheet-plan");
    await run();
  }

  async function run() {
    const token = ++pl.token;
    const cfg = settings();
    renderDays();
    $("#plan-source").innerHTML = "";
    $("#plan-body").innerHTML = `<p class="muted plan-wait">✨ ${cfg.ai ? "Claude plant deinen Tag …" : "Plane deinen Tag …"}</p>`;
    $("#btn-plan-apply").hidden = true;
    $("#btn-plan-again").hidden = true;

    try {
      const ctx = await loadContext([pl.date]);
      if (token !== pl.token) return;
      const busy = busyOn(pl.date, ctx, cfg);
      const slots = freeSlots(pl.date, busy, cfg);
      const tasks = candidates(ctx, pl.date);
      pl.busy = busy;
      pl.tasks = new Map(tasks.map(t => [t.id, t]));

      if (!tasks.length) {
        pl.result = null;
        renderEmpty("🎉 Keine offenen Aufgaben ohne Uhrzeit – nichts zu planen.");
        return;
      }
      if (!slots.length) {
        pl.result = null;
        const [ws, we] = [0, 6].includes(parseIso(pl.date).getDay()) ? cfg.weekend : cfg.weekday;
        renderEmpty(`In deiner Planungszeit (${ws}–${we} Uhr) ist ${pl.date === todayIso() ? "heute" : "an diesem Tag"} nichts mehr frei. Probier einen anderen Tag oder passe die Planungszeiten in den Einstellungen an.`);
        return;
      }

      const result = await makePlan(tasks, slots, cfg, "day");
      if (token !== pl.token) return;
      result.plan = (result.plan || []).filter(p => pl.tasks.has(p.id));
      result.unplanned = result.unplanned || [];
      if (ctx.calendarNote) result.note = [result.note, "Kalender: " + ctx.calendarNote].filter(Boolean).join(" ");
      pl.result = result;
      pl.selected = new Set(result.plan.map(p => p.id));
      renderPlan(cfg);
    } catch (err) {
      if (token !== pl.token) return;
      renderEmpty(translateError(err));
    }
  }

  function renderDays() {
    const t = todayIso();
    const days = [t, addDays(t, 1), addDays(t, 2)];
    if (!days.includes(pl.date)) days.unshift(pl.date);
    $("#plan-days").innerHTML = days.map(d =>
      `<button class="chip${d === pl.date ? " active" : ""}" data-plan-day="${d}">${escapeHtml(dayName(d))}</button>`).join("");
  }

  function renderEmpty(text) {
    $("#plan-body").innerHTML = `<p class="plan-empty">${escapeHtml(text)}</p>`;
    $("#btn-plan-apply").hidden = true;
    $("#btn-plan-again").hidden = false;
  }

  function renderPlan(cfg) {
    const r = pl.result;
    const label = r.source === "ai"
      ? `✨ Vorschlag von Claude (${r.model === "sonnet" ? "Sonnet" : "Haiku"})`
      : "🧮 Vorschlag vom Regel-Planer";
    $("#plan-source").innerHTML = `<span class="plan-badge">${label}</span>` +
      (r.summary ? `<span class="plan-summary">${escapeHtml(r.summary)}</span>` : "") +
      (r.note ? `<span class="plan-note">${escapeHtml(r.note)}</span>` : "");

    // Zeitstrahl: belegte Zeiten + Vorschläge
    const rows = [
      ...pl.busy.map(b => ({ from: b.from, to: b.to, busy: b })),
      ...r.plan.map(p => ({ from: toMin(p.start), to: toMin(p.end), plan: p }))
    ].sort((a, b) => a.from - b.from || (a.busy ? -1 : 1));

    let html = `<ul class="plan-list">` + rows.map(x => {
      const time = `${toHHMM(x.from)}–${toHHMM(Math.min(x.to, 1439))}`;
      if (x.busy) {
        return `<li class="plan-row plan-busy" style="--cal:${escapeHtml(x.busy.color || "var(--line)")}">
          <span class="plan-time">${time}</span>
          <span class="plan-text"><span class="plan-title">${x.busy.kind === "todo" ? "✅ " : "📅 "}${escapeHtml(x.busy.label)}</span></span>
        </li>`;
      }
      const p = x.plan, t = pl.tasks.get(p.id) || {};
      const on = pl.selected.has(p.id);
      return `<li class="plan-row plan-task${on ? "" : " off"}">
        <button class="check-btn${on ? " on" : ""}" data-plan-pick="${p.id}" aria-label="Übernehmen an/aus">✓</button>
        <span class="plan-time">${time}</span>
        <span class="plan-text">
          <span class="plan-title">${t.priority ? '<span class="prio">!</span>' : ""}${escapeHtml(t.title || "?")}</span>
          <span class="plan-reason">${escapeHtml(p.reason || "")}${!t.duration_minutes ? ` · geschätzt ${durationText(p.minutes)}` : ""}</span>
        </span>
      </li>`;
    }).join("") + `</ul>`;

    const un = r.unplanned.filter(u => pl.tasks.has(u.id));
    if (un.length) {
      html += `<details class="plan-unplanned"><summary>Nicht eingeplant (${un.length})</summary><ul>` +
        un.map(u => `<li><strong>${escapeHtml(pl.tasks.get(u.id).title)}</strong>${u.reason ? ` – <span class="muted">${escapeHtml(u.reason)}</span>` : ""}</li>`).join("") +
        `</ul></details>`;
    }
    if (!r.plan.length) html = `<p class="plan-empty">Heute passt leider keine Aufgabe sinnvoll in deine freie Zeit.</p>` + html;
    $("#plan-body").innerHTML = html;

    const n = r.plan.filter(p => pl.selected.has(p.id)).length;
    $("#btn-plan-apply").hidden = !r.plan.length;
    $("#btn-plan-apply").disabled = !n;
    $("#btn-plan-apply").textContent = n === 1 ? "1 Aufgabe übernehmen" : `${n} Aufgaben übernehmen`;
    $("#btn-plan-again").hidden = false;
  }

  async function applyPlacements(placements) {
    const results = await Promise.all(placements.map(p => {
      const t = pl.tasks.get(p.id) || (pl.suggestion && pl.suggestion.todo.id === p.id ? pl.suggestion.todo : {});
      const update = { due_date: p.date, due_time: p.start };
      if (!t.duration_minutes) update.duration_minutes = p.minutes;
      return sb.from("todos").update(update).eq("id", p.id);
    }));
    const failed = results.find(r => r.error);
    if (failed) throw failed.error;
    if (PP.calendarRefreshExtras) PP.calendarRefreshExtras();
  }

  $("#sheet-plan").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.planDay) {
      pl.date = t.dataset.planDay;
      run();
      return;
    }
    if (t.dataset.planPick) {
      const id = t.dataset.planPick;
      pl.selected.has(id) ? pl.selected.delete(id) : pl.selected.add(id);
      renderPlan(settings());
      return;
    }
    if (t.id === "btn-plan-again") { run(); return; }
    if (t.id === "btn-plan-apply") {
      const chosen = pl.result.plan.filter(p => pl.selected.has(p.id));
      t.disabled = true;
      try {
        await applyPlacements(chosen);
        closeSheets();
        toast(chosen.length === 1 ? "Aufgabe eingeplant." : `${chosen.length} Aufgaben eingeplant.`);
      } catch (err) {
        toast(translateError(err), true);
      } finally {
        t.disabled = false;
      }
    }
  });

  // =========================================================
  // Vorschlag beim Anlegen einer Aufgabe
  // =========================================================
  async function suggestFor(todo) {
    const cfg = settings();
    if (!cfg.suggest || !todo || todo.is_done || todo.due_time || !isMine(todo)) return;

    const box = $("#todo-suggest");
    const token = ++pl.sToken;
    pl.suggestion = { todo, placement: null };
    box.hidden = false;
    box.innerHTML = `<span class="muted small">✨ Suche eine passende Zeit für „${escapeHtml(todo.title)}“ …</span>`;

    try {
      const t = todayIso();
      let last = addDays(t, 2);
      if (todo.due_date && todo.due_date >= t && todo.due_date < last) last = todo.due_date;
      const dates = [t];
      while (dates[dates.length - 1] < last) dates.push(addDays(dates[dates.length - 1], 1));

      const ctx = await loadContext(dates);
      if (token !== pl.sToken) return;
      const slots = dates.flatMap(d => freeSlots(d, busyOn(d, ctx, cfg), cfg));
      if (!slots.length) {
        showSuggestion(null, "Keine freie Zeit in deinen Planungszeiten bis " + dayName(last).toLowerCase() + ".");
        return;
      }
      const r = await makePlan([todo], slots, cfg, "single");
      if (token !== pl.sToken) return;
      const p = (r.plan || []).find(x => x.id === todo.id);
      if (!p) {
        const why = r.unplanned[0] && r.unplanned[0].reason;
        showSuggestion(null, why || "Keine passende Zeit gefunden.");
        return;
      }
      pl.suggestion.placement = p;
      showSuggestion(p, p.reason, r.source);
    } catch (err) {
      if (token !== pl.sToken) return;
      box.hidden = true;
      console.warn("Vorschlag:", err);
    }
  }

  let hideTimer;
  function showSuggestion(p, reason, source) {
    const box = $("#todo-suggest");
    clearTimeout(hideTimer);
    if (!p) {
      box.innerHTML = `<span class="muted small">✨ ${escapeHtml(reason)}</span>`;
      hideTimer = setTimeout(() => { box.hidden = true; }, 6000);
      return;
    }
    const t = pl.suggestion.todo;
    box.innerHTML = `
      <div class="suggest-text">
        <span class="suggest-head">${source === "ai" ? "✨" : "🧮"} Vorschlag für „${escapeHtml(t.title)}“</span>
        <strong>${escapeHtml(dayName(p.date))}, ${p.start}–${p.end}</strong>
        ${reason ? `<span class="muted small">${escapeHtml(reason)}</span>` : ""}
      </div>
      <div class="suggest-actions">
        <button type="button" class="btn btn-small btn-primary" data-suggest="ok">Übernehmen</button>
        <button type="button" class="icon-btn small" data-suggest="no" aria-label="Verwerfen">✕</button>
      </div>`;
  }

  $("#todo-suggest").addEventListener("click", async e => {
    const b = e.target.closest("[data-suggest]");
    if (!b) return;
    const box = $("#todo-suggest");
    if (b.dataset.suggest === "no") { box.hidden = true; pl.suggestion = null; return; }
    const s = pl.suggestion;
    if (!s || !s.placement) return;
    b.disabled = true;
    try {
      await applyPlacements([s.placement]);
      box.hidden = true;
      pl.suggestion = null;
      toast(`Eingeplant: ${dayName(s.placement.date)}, ${s.placement.start} Uhr.`);
    } catch (err) {
      b.disabled = false;
      toast(translateError(err), true);
    }
  });

  // =========================================================
  // Einstellungen
  // =========================================================
  function renderSettings() {
    const f = $("#form-plan");
    const c = settings();
    f.plan_ai.checked = c.ai;
    f.plan_suggest.checked = c.suggest;
    f.plan_weekday_start.value = c.weekday[0];
    f.plan_weekday_end.value = c.weekday[1];
    f.plan_weekend_start.value = c.weekend[0];
    f.plan_weekend_end.value = c.weekend[1];
    f.plan_default_minutes.value = String(c.defaultMinutes);
    f.plan_buffer_minutes.value = String(c.buffer);
    f.plan_model.value = c.model;
    $("#plan-model-row").hidden = !c.ai;
  }

  $("#btn-open-settings").addEventListener("click", renderSettings);
  $("#form-plan").plan_ai.addEventListener("change", e => { $("#plan-model-row").hidden = !e.target.checked; });

  $("#form-plan").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      if (f.plan_weekday_start.value >= f.plan_weekday_end.value || f.plan_weekend_start.value >= f.plan_weekend_end.value) {
        throw new Error("Das Ende der Planungszeit muss nach dem Beginn liegen.");
      }
      const update = {
        plan_ai: f.plan_ai.checked,
        plan_suggest: f.plan_suggest.checked,
        plan_weekday_start: f.plan_weekday_start.value,
        plan_weekday_end: f.plan_weekday_end.value,
        plan_weekend_start: f.plan_weekend_start.value,
        plan_weekend_end: f.plan_weekend_end.value,
        plan_default_minutes: +f.plan_default_minutes.value,
        plan_buffer_minutes: +f.plan_buffer_minutes.value,
        plan_model: f.plan_model.value
      };
      const { error } = await sb.from("profiles").update(update).eq("id", me());
      if (error) {
        if (/plan_/.test(error.message)) throw new Error("Bitte zuerst das SQL aus Schritt 10 in Supabase ausführen.");
        throw error;
      }
      Object.assign(state.profile, update);
      toast("Planungs-Einstellungen gespeichert.");
    });
  });

  // ---------- Schnittstelle ----------
  PP.planner = { open, suggestFor };
  PP._planner = { freeSlots, rulePlan, busyOn, candidates, settings };
})();
