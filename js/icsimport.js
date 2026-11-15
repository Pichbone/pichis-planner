// =========================================================
// Pichis Planner – ICS-Datei importieren
// Termine → in einen eigenen iCloud-Kalender, oder
// Aufgaben (und auf Wunsch Termine) → als Aufgaben in die App
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, openSheet, closeSheets } = PP;

  const TAG_COLORS = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];
  const WD = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

  const ix = {
    data: null,         // { name, events, todos }
    target: "events",
    rows: [],           // aktuelle Liste mit { ..., checked, dupe }
    tags: [],
    tagId: "",
    busy: false
  };
  const me = () => state.session.user.id;
  const hid = () => state.household.id;

  async function callIcloud(action, payload = {}) {
    const { data, error } = await sb.functions.invoke("icloud", { body: { action, ...payload } });
    if (error) {
      let msg = error.message || "Fehler";
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* keine JSON-Antwort */ }
      if (/Unbekannte Aktion/.test(msg)) msg = "Bitte zuerst die neue Funktion „icloud“ in Supabase einspielen.";
      throw new Error(msg);
    }
    return data;
  }

  const dateText = iso => new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric", year: "numeric" });

  // RRULE → Wiederholung einer Aufgabe
  function rruleToTodo(rule) {
    const out = { repeat: "none", repeat_interval: 1, repeat_days: [], repeat_until: null };
    if (!rule) return out;
    const p = Object.fromEntries(rule.toUpperCase().split(";").map(kv => kv.split("=")));
    const freq = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" }[p.FREQ];
    if (!freq) return out;
    out.repeat = freq;
    out.repeat_interval = Math.max(1, Math.min(999, parseInt(p.INTERVAL || "1", 10) || 1));
    if (freq === "weekly" && p.BYDAY && /^(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*$/.test(p.BYDAY)) {
      out.repeat_days = [...new Set(p.BYDAY.split(",").map(d => WD[d]))].sort();
      if (out.repeat_interval === 1 && out.repeat_days.join() === "1,2,3,4,5") { out.repeat = "weekdays"; out.repeat_days = []; }
    }
    if (p.UNTIL && /^\d{8}/.test(p.UNTIL)) out.repeat_until = `${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}`;
    return out;
  }

  // ---------- Öffnen ----------
  function open(target) {
    ix.data = null;
    ix.target = target || "events";
    $("#ics-step1").hidden = false;
    $("#ics-step2").hidden = true;
    $("#ics-file-label").classList.remove("is-busy");
    openSheet("sheet-ics");
  }

  $("#ics-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { toast("Die Datei ist zu groß (höchstens 3 MB).", true); return; }
    const label = $("#ics-file-label");
    label.classList.add("is-busy");
    $("#ics-file-text").textContent = "Datei wird gelesen …";
    try {
      const text = await file.text();
      ix.data = await callIcloud("ics_preview", { ics: text });
      if (!ix.data.events.length && !ix.data.todos.length) throw new Error("In der Datei wurden keine Termine oder Aufgaben gefunden.");
      // Enthält die Datei Aufgaben, sind Aufgaben das naheliegende Ziel
      if (ix.data.todos.length && !ix.data.events.length) ix.target = "todos";
      if (!ix.data.todos.length && ix.target === "todos" && !ix.data.events.length) ix.target = "events";
      await prepareStep2(file.name);
    } catch (err) {
      toast(err.message || translateError(err), true);
    } finally {
      label.classList.remove("is-busy");
      $("#ics-file-text").textContent = "📂 ICS-Datei auswählen";
    }
  });

  async function prepareStep2(fileName) {
    const d = ix.data;
    $("#ics-summary").textContent = [
      d.name ? `„${d.name}“` : `„${fileName}“`,
      `${d.events.length} Termin${d.events.length === 1 ? "" : "e"}`,
      `${d.todos.length} Aufgabe${d.todos.length === 1 ? "" : "n"}`
    ].join(" · ");

    // Ziel-Kalender (eigene, beschreibbare iCloud-Kalender)
    const { data: cals } = await sb.from("calendars").select("id, name, color, read_only, account_id").eq("user_id", me()).order("name");
    const own = (cals || []).filter(c => !c.read_only && c.account_id);
    $("#ics-calendar").innerHTML = own.length
      ? own.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")
      : `<option value="">– kein iCloud-Kalender verbunden –</option>`;
    const last = PP.storageGet("pp_cal_last");
    if (last && own.some(c => c.id === last)) $("#ics-calendar").value = last;

    // Aufgaben: Tags und Zuständige
    const { data: tags } = await sb.from("event_tags").select("id, name, color").eq("household_id", hid()).order("name");
    ix.tags = tags || [];
    ix.tagId = "";
    $("#ics-assigned").innerHTML = `<option value="">Niemand</option>` + state.members
      .map(m => `<option value="${m.id}">${escapeHtml(m.name)}${m.id === me() ? " (du)" : ""}</option>`).join("");
    $("#ics-with-events").checked = !d.todos.length;
    $("#ics-with-events-row").hidden = !d.events.length || !d.todos.length;
    $("#ics-cats").checked = true;
    $("#ics-private").checked = false;

    $("#ics-step1").hidden = true;
    $("#ics-step2").hidden = false;
    await buildRows();
  }

  // ---------- Liste ----------
  async function buildRows() {
    const d = ix.data;
    document.querySelectorAll('#sheet-ics input[name="ics-target"]').forEach(r => { r.checked = r.value === ix.target; });
    $("#ics-events-opts").hidden = ix.target !== "events";
    $("#ics-todos-opts").hidden = ix.target !== "todos";
    if (ix.target === "events") {
      ix.rows = d.events.map(e => ({ kind: "event", ...e, checked: true, dupe: false }));
    } else {
      const withEvents = $("#ics-with-events").checked || !d.todos.length;
      const fromTodos = d.todos.map(t => ({ kind: "todo", ...t, checked: !t.done, dupe: false }));
      const fromEvents = withEvents ? d.events.map(e => ({
        kind: "event-todo", ...e, due_date: e.start_date, due_time: e.all_day ? null : e.start_time,
        important: false, done: false, checked: true, dupe: false
      })) : [];
      ix.rows = [...fromTodos, ...fromEvents];
      // Doppelte erkennen: offene Aufgabe mit gleichem Titel und Datum
      const { data: open } = await sb.from("todos").select("title, due_date").eq("household_id", hid()).eq("is_done", false);
      const have = new Set((open || []).map(t => `${t.title.toLowerCase()}|${t.due_date || ""}`));
      ix.rows.forEach(r => {
        if (have.has(`${r.title.toLowerCase()}|${r.due_date || ""}`)) { r.dupe = true; r.checked = false; }
      });
    }
    renderTags();
    renderRows();
  }

  function renderTags() {
    $("#ics-tags").innerHTML = `<button type="button" class="chip${ix.tagId ? "" : " active"}" data-ics-tag="">Kein Tag</button>` +
      ix.tags.map(t => `<button type="button" class="chip chip-tag${ix.tagId === t.id ? " active" : ""}" data-ics-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("");
  }

  function renderRows() {
    const rows = ix.rows;
    const sel = rows.filter(r => r.checked).length;
    $("#ics-list").innerHTML = rows.length ? rows.map((r, i) => {
      const date = r.kind === "todo" ? r.due_date : r.start_date;
      const time = r.kind === "todo" ? r.due_time : (r.all_day ? "ganztägig" : r.start_time + (r.end_time && r.end_date === r.start_date ? "–" + r.end_time : ""));
      const extra = [
        r.kind === "todo" ? "✅ Aufgabe" : (ix.target === "todos" ? "📅 Termin" : ""),
        r.rrule ? "🔁" : "", r.important ? "❗" : "", r.done ? "erledigt" : "", r.dupe ? "schon vorhanden" : "",
        r.location ? "📍 " + r.location : ""
      ].filter(Boolean).join(" · ");
      return `<li><label class="bd-import-row${r.dupe || r.done ? " dupe" : ""}">
        <input type="checkbox" data-ics-row="${i}" ${r.checked ? "checked" : ""}>
        <span class="bd-main">
          <span class="bd-name">${escapeHtml(r.title)}</span>
          <span class="bd-sub">${date ? escapeHtml(dateText(date)) : "ohne Datum"}${time ? " · " + escapeHtml(time) : ""}${extra ? " · " + escapeHtml(extra) : ""}</span>
        </span>
      </label></li>`;
    }).join("") : `<li class="muted small">Nichts zum Übernehmen.</li>`;
    const go = $("#btn-ics-go");
    go.textContent = sel ? `${sel} ${ix.target === "events" ? "Termin" + (sel === 1 ? "" : "e") + " in iCloud anlegen" : "Aufgabe" + (sel === 1 ? "" : "n") + " anlegen"}` : "Nichts ausgewählt";
    go.disabled = !sel || ix.busy || (ix.target === "events" && !$("#ics-calendar").value);
  }

  $("#sheet-ics").addEventListener("change", e => {
    const t = e.target;
    if (t.name === "ics-target") { ix.target = t.value; buildRows(); return; }
    if (t.id === "ics-with-events") { buildRows(); return; }
    if (t.dataset.icsRow !== undefined) { ix.rows[+t.dataset.icsRow].checked = t.checked; renderRows(); return; }
    if (t.id === "ics-calendar") renderRows();
  });
  $("#sheet-ics").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.icsTag !== undefined) { ix.tagId = b.dataset.icsTag; renderTags(); return; }
    if (b.id === "btn-ics-all") {
      const all = ix.rows.every(r => r.checked);
      ix.rows.forEach(r => { r.checked = !all; });
      renderRows();
    }
    if (b.id === "btn-ics-back") { $("#ics-step2").hidden = true; $("#ics-step1").hidden = false; }
    if (b.id === "btn-ics-go") run();
  });

  // ---------- Übernehmen ----------
  async function run() {
    const pick = ix.rows.filter(r => r.checked);
    if (!pick.length || ix.busy) return;
    ix.busy = true;
    const go = $("#btn-ics-go");
    go.disabled = true;
    try {
      if (ix.target === "events") await importEvents(pick, go);
      else await importTodos(pick, go);
    } catch (err) {
      toast(err.message || translateError(err), true);
    } finally {
      ix.busy = false;
      renderRows();
    }
  }

  async function importEvents(pick, go) {
    const calendar_id = $("#ics-calendar").value;
    if (!calendar_id) throw new Error("Bitte zuerst deinen iCloud-Kalender verbinden.");
    const total = { created: 0, existing: 0, failed: 0, errors: [] };
    for (let i = 0; i < pick.length; i += 20) {
      go.textContent = `Wird übertragen … ${Math.min(i + 20, pick.length)}/${pick.length}`;
      const r = await callIcloud("ics_import", { calendar_id, items: pick.slice(i, i + 20).map(x => x.raw) });
      total.created += r.created; total.existing += r.existing; total.failed += r.failed;
      total.errors.push(...(r.errors || []));
    }
    PP.storageSet("pp_cal_last", calendar_id);
    closeSheets();
    const parts = [`${total.created} Termin${total.created === 1 ? "" : "e"} angelegt`];
    if (total.existing) parts.push(`${total.existing} schon vorhanden`);
    if (total.failed) parts.push(`${total.failed} fehlgeschlagen`);
    toast(parts.join(", ") + "." + (total.errors.length ? " " + total.errors[0] : ""), !!total.failed && !total.created);
    if (PP.modules.calendar && PP.modules.calendar.resume) PP.modules.calendar.resume();
  }

  async function tagIdsFor(r) {
    const ids = ix.tagId ? [ix.tagId] : [];
    if ($("#ics-cats").checked) {
      for (const name of r.categories || []) {
        let tag = ix.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (!tag) {
          const { data, error } = await sb.from("event_tags").insert({ household_id: hid(), name, color: TAG_COLORS[ix.tags.length % TAG_COLORS.length] })
            .select("id, name, color").single();
          if (error) continue;
          tag = data;
          ix.tags.push(tag);
        }
        if (!ids.includes(tag.id)) ids.push(tag.id);
      }
    }
    return ids;
  }

  async function importTodos(pick, go) {
    const assigned = $("#ics-assigned").value || null;
    const priv = $("#ics-private").checked;
    const rows = [];
    let needsExtra = false;
    for (const r of pick) {
      const rp = rruleToTodo(r.rrule);
      const notes = [r.kind === "event-todo" && r.location ? "📍 " + r.location : "", r.notes || ""].filter(Boolean).join("\n").slice(0, 2000);
      const row = {
        household_id: hid(),
        title: r.title.slice(0, 200),
        notes,
        due_date: r.due_date || (rp.repeat !== "none" ? new Date().toISOString().slice(0, 10) : null),
        due_time: r.due_time || null,
        duration_minutes: r.kind === "event-todo" && r.minutes && r.minutes <= 1440 ? r.minutes : null,
        priority: r.important ? 1 : 0,
        repeat: rp.repeat,
        is_private: priv,
        assigned_to: priv ? null : assigned
      };
      const tags = await tagIdsFor(r);
      if (tags.length) row.tag_ids = tags;
      if (rp.repeat_interval > 1 || rp.repeat_days.length || rp.repeat_until) {
        Object.assign(row, { repeat_interval: rp.repeat_interval, repeat_days: rp.repeat_days, repeat_until: rp.repeat_until });
        needsExtra = true;
      }
      rows.push(row);
    }
    // Spalten müssen in allen Zeilen gleich sein
    if (needsExtra) rows.forEach(r => { if (!("repeat_interval" in r)) Object.assign(r, { repeat_interval: 1, repeat_days: [], repeat_until: null }); });
    if (rows.some(r => r.tag_ids)) rows.forEach(r => { if (!r.tag_ids) r.tag_ids = []; });

    let done = 0;
    for (let i = 0; i < rows.length; i += 100) {
      go.textContent = `Wird angelegt … ${Math.min(i + 100, rows.length)}/${rows.length}`;
      const { error } = await sb.from("todos").insert(rows.slice(i, i + 100));
      if (error) throw error;
      done += Math.min(100, rows.length - i);
    }
    closeSheets();
    toast(`${done} Aufgabe${done === 1 ? "" : "n"} angelegt.`);
    if (PP.modules.todos && PP.modules.todos.resume) PP.modules.todos.resume();
  }

  // Einstiege: Kalender-Einstellungen und Aufgaben
  document.addEventListener("click", e => {
    if (e.target.closest("#btn-cal-import")) open("events");
    else if (e.target.closest("#btn-todo-import")) open("todos");
  });

  PP.icsImport = { open, _rruleToTodo: rruleToTodo };
})();
