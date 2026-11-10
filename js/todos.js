// =========================================================
// Pichis Planner – ToDos / Aufgaben
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, memberName, openSheet, closeSheets } = PP;

  const REPEAT_LABEL = { none: "", daily: "täglich", weekly: "wöchentlich", monthly: "monatlich", yearly: "jährlich" };
  const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
  const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

  const td = {
    householdId: null,
    items: [],
    filter: storageGet("pp_todo_filter") || "all",
    tags: [],
    tagFilter: storageGet("pp_todo_tag") || "",
    draftTags: new Set(),
    channel: null,
    showDone: false,
    editingId: null,
    files: new Map(),
    active: false
  };

  // ---------- Datum ----------
  function isoDate(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }
  function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function dayDiff(iso) { return Math.round((parseIso(iso) - startOfToday()) / 86400000); }

  function dueLabel(iso) {
    const diff = dayDiff(iso);
    if (diff === 0) return "Heute";
    if (diff === 1) return "Morgen";
    if (diff === -1) return "Gestern";
    const d = parseIso(iso);
    if (diff > 1 && diff < 7) return WEEKDAY_SHORT[d.getDay()] + ", " + d.getDate() + "." + (d.getMonth() + 1) + ".";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.getDate() + "." + (d.getMonth() + 1) + "." + (sameYear ? "" : d.getFullYear());
  }

  // ---------- Schnelleingabe verstehen ----------
  // Beispiele: "Müll rausbringen jeden Dienstag", "Zahnarzt anrufen morgen !",
  //            "Geschenk kaufen 15.12. @Anna", "Steuer #privat"
  const B = "(?:^|\\s)";        // Wortanfang
  const E = "(?=$|[\\s.,!?])";  // Wortende

  function normTag(s) { return String(s).toLowerCase().replace(/[^a-z0-9äöüß]/g, ""); }

  function parseTodo(raw, members, tags = []) {
    let text = " " + raw.trim().replace(/\s+/g, " ") + " ";
    const out = { title: "", due_date: null, due_time: null, duration_minutes: null, priority: 0, repeat: "none", is_private: false, assigned_to: null, tag_ids: [], new_tags: [] };
    const today = startOfToday();

    function take(re) {
      const m = text.match(re);
      if (m) text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
      return m;
    }

    if (take(new RegExp(B + "#privat" + E, "i"))) out.is_private = true;

    // Tags: "#DJ", "#Aareal" (Anfang des Namens reicht), unbekannte werden neu angelegt
    let hm;
    while ((hm = take(/(?:^|\s)#([a-zäöüß0-9][\wäöüß-]*)/i))) {
      const q = normTag(hm[1]);
      if (!q) continue;
      const tag = tags.find(t => normTag(t.name) === q) || tags.find(t => normTag(t.name).startsWith(q));
      if (tag) { if (!out.tag_ids.includes(tag.id)) out.tag_ids.push(tag.id); }
      else if (!out.new_tags.some(n => normTag(n) === q)) out.new_tags.push(hm[1].replace(/-/g, " "));
    }
    if (take(/(?:^|\s)!+(?=\s|$)/) || take(/!+\s*$/)) out.priority = 1;

    const at = take(/(?:^|\s)@([a-zäöüß][\wäöüß-]*)/i);
    if (at) {
      const q = at[1].toLowerCase();
      const m = members.find(x => x.name.toLowerCase().startsWith(q));
      if (m) out.assigned_to = m.id;
    }

    // Wiederholung
    let m;
    if (take(new RegExp(B + "(?:jeden tag|täglich)" + E, "i"))) out.repeat = "daily";
    else if ((m = take(new RegExp(B + "jeden (" + WEEKDAYS.join("|") + ")" + E, "i")))) {
      out.repeat = "weekly";
      out.due_date = isoDate(nextWeekday(m[1].toLowerCase(), true));
    }
    else if (take(new RegExp(B + "(?:jede woche|wöchentlich)" + E, "i"))) out.repeat = "weekly";
    else if (take(new RegExp(B + "(?:jeden monat|monatlich)" + E, "i"))) out.repeat = "monthly";
    else if (take(new RegExp(B + "(?:jedes jahr|jährlich)" + E, "i"))) out.repeat = "yearly";

    // Datum
    if (!out.due_date) {
      if (take(new RegExp(B + "(?:bis |am )?übermorgen" + E, "i"))) out.due_date = isoDate(addDays(today, 2));
      else if (take(new RegExp(B + "(?:bis |am )?heute" + E, "i"))) out.due_date = isoDate(today);
      else if (take(new RegExp(B + "(?:bis |am )?morgen" + E, "i"))) out.due_date = isoDate(addDays(today, 1));
      else if (take(new RegExp(B + "nächste woche" + E, "i"))) out.due_date = isoDate(nextWeekday("montag", false));
      else if ((m = take(new RegExp(B + "in (\\d{1,3}) tag(?:en)?" + E, "i")))) out.due_date = isoDate(addDays(today, +m[1]));
      else if ((m = take(new RegExp(B + "in (\\d{1,2}|einer) woche(?:n)?" + E, "i")))) {
        const n = m[1].toLowerCase() === "einer" ? 1 : +m[1];
        out.due_date = isoDate(addDays(today, 7 * n));
      }
      else if ((m = take(new RegExp(B + "(?:bis |am )?(" + WEEKDAYS.join("|") + ")" + E, "i")))) {
        out.due_date = isoDate(nextWeekday(m[1].toLowerCase(), false));
      }
      else if ((m = take(new RegExp(B + "(?:bis |am )?(\\d{1,2})\\.(\\d{1,2})\\.(\\d{2,4})?" + E, "i")))) {
        const day = +m[1], mon = +m[2];
        let year = m[3] ? +m[3] : today.getFullYear();
        if (year < 100) year += 2000;
        let d = new Date(year, mon - 1, day);
        if (!m[3] && d < today) d = new Date(year + 1, mon - 1, day);
        if (d.getMonth() === mon - 1) out.due_date = isoDate(d);
      }
    }
    // Dauer: "für 2 Std", "1,5 h", "30 min", "90 Minuten"
    if ((m = take(new RegExp(B + "(?:für\\s+)?(\\d+(?:[.,]\\d+)?)\\s*(std\\.?|stunden?|h|min\\.?|minuten?)" + E, "i")))) {
      const n = parseFloat(m[1].replace(",", "."));
      const mins = /^m/i.test(m[2]) ? Math.round(n) : Math.round(n * 60);
      if (mins > 0 && mins <= 10080) out.duration_minutes = mins;
    }

    // Uhrzeit: "um 15 Uhr", "15:30", "um 9.15", "18 Uhr"
    if ((m = take(new RegExp(B + "(?:um\\s+)?(\\d{1,2})[:.](\\d{2})(?:\\s*uhr)?" + E, "i"))) ||
        (m = take(new RegExp(B + "(?:um\\s+)?(\\d{1,2})\\s*uhr" + E, "i"))) ||
        (m = take(new RegExp(B + "um\\s+(\\d{1,2})" + E, "i")))) {
      const h = +m[1], min = m[2] ? +m[2] : 0;
      if (h < 24 && min < 60) out.due_time = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
    if (out.due_time && !out.due_date) out.due_date = isoDate(today);

    if (out.repeat !== "none" && !out.due_date) out.due_date = isoDate(today);

    const title = text.replace(/\s+/g, " ").trim().replace(/^[,.\-–]+|[,.\-–]+$/g, "").trim();
    out.title = title.charAt(0).toUpperCase() + title.slice(1);
    return out;
  }

  // Nächster Wochentag; includeToday = heute zählt mit (für "jeden Dienstag")
  function nextWeekday(name, includeToday) {
    const target = WEEKDAYS.indexOf(name);
    const today = startOfToday();
    let diff = (target - today.getDay() + 7) % 7;
    if (diff === 0 && !includeToday) diff = 7;
    return addDays(today, diff);
  }

  // ---------- Daten ----------
  async function loadAll() {
    const { data, error } = await sb.from("todos").select("*")
      .eq("household_id", state.household.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    td.items = data;
    const tg = await sb.from("event_tags").select("id, name, color").eq("household_id", state.household.id).order("name");
    if (!tg.error) td.tags = tg.data;
    if (td.tagFilter && !td.tags.some(t => t.id === td.tagFilter)) td.tagFilter = "";
    await loadFiles();
  }

  async function loadFiles() {
    const { data, error } = await sb.from("todo_attachments")
      .select("id, todo_id, path, name, size, mime, created_at")
      .eq("household_id", state.household.id)
      .order("created_at", { ascending: true });
    if (error) { console.warn(error); return; }
    td.files = new Map();
    for (const f of data) {
      if (!td.files.has(f.todo_id)) td.files.set(f.todo_id, []);
      td.files.get(f.todo_id).push(f);
    }
  }

  function filesOf(todoId) { return (td.files && td.files.get(todoId)) || []; }

  function upsertLocal(row) {
    const i = td.items.findIndex(x => x.id === row.id);
    if (i >= 0) td.items[i] = row; else td.items.push(row);
  }

  // ---------- Live-Abgleich ----------
  function subscribe() {
    unsubscribe();
    const hid = state.household.id;
    td.channel = sb.channel("todos-" + hid)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "todos", filter: `household_id=eq.${hid}` }, onChange)
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "todos" }, onChange)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "todo_attachments", filter: `household_id=eq.${hid}` },
        () => loadFiles().then(() => { render(); if (td.editingId) renderFiles(); }))
      .subscribe();
  }
  function unsubscribe() {
    if (td.channel) { sb.removeChannel(td.channel); td.channel = null; }
  }
  function onChange(payload) {
    if (payload.eventType === "DELETE") {
      const id = payload.old && payload.old.id;
      td.items = td.items.filter(x => x.id !== id);
    } else {
      upsertLocal(payload.new);
    }
    render();
  }

  // ---------- Aktionen ----------
  async function addFromInput(text) {
    const p = parseTodo(text, state.members, td.tags);
    if (!p.title) { toast("Bitte einen Text für die Aufgabe eingeben.", true); return false; }

    // Neue Tags anlegen
    for (const name of p.new_tags) {
      const tag = await createTag(name);
      if (tag) p.tag_ids.push(tag.id);
    }
    delete p.new_tags;
    if (td.tagFilter && !p.tag_ids.includes(td.tagFilter)) p.tag_ids.push(td.tagFilter);
    if (!p.tag_ids.length) delete p.tag_ids;   // funktioniert auch vor Schritt 12

    // Im Filter "Privat" neue Aufgaben automatisch privat anlegen
    if (td.filter === "private") p.is_private = true;
    if (td.filter === "mine" && !p.assigned_to && !p.is_private) p.assigned_to = state.session.user.id;

    const { data, error } = await sb.from("todos").insert({
      household_id: state.household.id,
      ...p
    }).select().single();
    if (error) throw error;
    upsertLocal(data);
    render();
    if (data.assigned_to && data.assigned_to !== state.session.user.id && PP.notify) PP.notify.task(data.id);
    if (!data.due_time && PP.planner) PP.planner.suggestFor(data);

    const extras = [];
    if (data.due_date) extras.push(dueLabel(data.due_date));
    if (data.assigned_to) extras.push("für " + memberName(data.assigned_to));
    if (data.repeat !== "none") extras.push(REPEAT_LABEL[data.repeat]);
    if (data.is_private) extras.push("privat");
    if (data.tag_ids && data.tag_ids.length) extras.push(data.tag_ids.map(id => (td.tags.find(t => t.id === id) || {}).name).filter(Boolean).map(n => "#" + n).join(" "));
    if (extras.length) toast("Aufgabe angelegt: " + extras.join(", "));
    return true;
  }

  async function toggle(id) {
    const item = td.items.find(x => x.id === id);
    if (!item) return;
    const before = item.is_done;
    const wasRepeating = item.repeat !== "none";
    item.is_done = !before;
    render();
    const { data, error } = await sb.from("todos").update({ is_done: !before }).eq("id", id).select().single();
    if (error) {
      item.is_done = before;
      render();
      toast(translateError(error), true);
      return;
    }
    upsertLocal(data);
    if (!before && wasRepeating) {
      await loadAll(); // nächste Wiederholung abholen
      toast("Erledigt – nächster Termin ist eingetragen.");
    }
    render();
  }

  async function clearDone() {
    const done = visible().filter(x => x.is_done);
    if (!done.length) return;
    if (!confirm(`${done.length} erledigte Aufgaben endgültig entfernen?`)) return;
    const ids = done.map(x => x.id);
    await removeStoredFiles(ids.flatMap(id => filesOf(id).map(f => f.path)));
    const { error } = await sb.from("todos").delete().in("id", ids);
    if (error) { toast(translateError(error), true); return; }
    const set = new Set(ids);
    td.items = td.items.filter(x => !set.has(x.id));
    render();
  }

  // ---------- Darstellung ----------
  function visible() {
    const me = state.session.user.id;
    let list = td.items;
    if (td.filter === "mine") list = list.filter(x => x.assigned_to === me || (x.is_private && x.created_by === me));
    if (td.filter === "private") list = list.filter(x => x.is_private);
    if (td.tagFilter) list = list.filter(x => (x.tag_ids || []).includes(td.tagFilter));
    return list;
  }

  function tagChip(tag) {
    return `<span class="tag" style="--tag:${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>`;
  }

  async function createTag(name) {
    const clean = String(name).trim().slice(0, 40);
    if (!clean) return null;
    const existing = td.tags.find(t => t.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const colors = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];
    const { data, error } = await sb.from("event_tags").insert({
      household_id: state.household.id, name: clean, color: colors[td.tags.length % colors.length]
    }).select("id, name, color").single();
    if (error) { toast(translateError(error), true); return null; }
    td.tags.push(data);
    td.tags.sort((a, b) => a.name.localeCompare(b.name));
    return data;
  }

  function sortOpen(a, b) {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    if (a.due_time !== b.due_time) {
      if (!a.due_time) return 1;
      if (!b.due_time) return -1;
      return a.due_time < b.due_time ? -1 : 1;
    }
    return String(a.created_at).localeCompare(String(b.created_at));
  }

  function bucket(item) {
    if (!item.due_date) return "none";
    const diff = dayDiff(item.due_date);
    if (diff < 0) return "overdue";
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff < 7) return "week";
    return "later";
  }
  const BUCKETS = [
    ["overdue", "Überfällig"],
    ["today", "Heute"],
    ["tomorrow", "Morgen"],
    ["week", "Diese Woche"],
    ["later", "Später"],
    ["none", "Ohne Datum"]
  ];

  function row(item) {
    const meta = [];
    if (item.due_date) {
      const overdue = !item.is_done && dayDiff(item.due_date) < 0;
      meta.push(`<span class="${overdue ? "due-overdue" : ""}">${escapeHtml(dueLabel(item.due_date))}${item.due_time ? ", " + timeRange(item) : ""}</span>`);
    } else if (item.duration_minutes) {
      meta.push("⏱ " + durationText(item.duration_minutes));
    }
    const nFiles = filesOf(item.id).length;
    if (nFiles) meta.push(`📎 ${nFiles}`);
    if (item.repeat !== "none") meta.push("🔁 " + REPEAT_LABEL[item.repeat]);
    if (item.is_private) meta.push("🔒 privat");
    if (item.notes) meta.push(escapeHtml(item.notes.split("\n")[0]).slice(0, 80));
    const tags = (item.tag_ids || []).map(id => td.tags.find(t => t.id === id)).filter(Boolean);

    let who = "";
    if (item.assigned_to) {
      const n = memberName(item.assigned_to) || "?";
      who = `<span class="avatar avatar-sm" title="${escapeHtml(n)}">${escapeHtml(n.charAt(0).toUpperCase())}</span>`;
    }

    return `<li class="item${item.is_done ? " done" : ""}${item.priority ? " important" : ""}">
      <button class="check" data-toggle="${item.id}" aria-label="${item.is_done ? "Wieder öffnen" : "Erledigt"}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      </button>
      <button class="item-main" data-edit="${item.id}">
        <span class="item-name">${item.priority ? '<span class="prio">!</span>' : ""}${escapeHtml(item.title)}</span>
        ${meta.length ? `<span class="item-meta">${meta.join(" · ")}</span>` : ""}
        ${tags.length ? `<span class="tag-row">${tags.map(tagChip).join("")}</span>` : ""}
      </button>
      ${who ? `<span class="item-side">${who}</span>` : ""}
    </li>`;
  }

  function render() {
    if (!td.active) return;

    // Filter-Chips
    document.querySelectorAll("#todo-filters .chip").forEach(c => {
      c.classList.toggle("active", c.dataset.filter === td.filter);
    });

    const used = new Set(td.items.flatMap(x => x.tag_ids || []));
    const shown = td.tags.filter(t => used.has(t.id) || t.id === td.tagFilter);
    $("#todo-tags").innerHTML = shown.length
      ? `<button class="chip${td.tagFilter ? "" : " active"}" data-todo-tag="">Alle Tags</button>` +
        shown.map(t => `<button class="chip chip-tag${td.tagFilter === t.id ? " active" : ""}" data-todo-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : "";

    const items = visible();
    const open = items.filter(x => !x.is_done).sort(sortOpen);
    const done = items.filter(x => x.is_done)
      .sort((a, b) => String(b.done_at || "").localeCompare(String(a.done_at || "")));

    let html = "";
    if (!open.length) {
      html = `<div class="empty">
        <div class="empty-icon">${done.length ? "🎉" : "📝"}</div>
        <p><strong>${done.length ? "Alles erledigt!" : "Noch keine Aufgaben."}</strong></p>
        <p class="muted small">Oben eintippen, z. B. „Müll rausbringen jeden Dienstag @Anna“.</p>
      </div>`;
    } else {
      for (const [key, label] of BUCKETS) {
        const group = open.filter(x => bucket(x) === key);
        if (!group.length) continue;
        html += `<section class="cat-group">
          <h3 class="cat-title${key === "overdue" ? " title-overdue" : ""}">${label} <span class="cat-count">${group.length}</span></h3>
          <ul class="items">${group.map(row).join("")}</ul>
        </section>`;
      }
    }
    $("#todo-items").innerHTML = html;

    $("#todo-done").innerHTML = done.length ? `
      <div class="done-head">
        <button class="link done-toggle" data-toggle-done>${td.showDone ? "▾" : "▸"} Erledigt (${done.length})</button>
        <button class="link danger-link" data-clear-done>Entfernen</button>
      </div>
      ${td.showDone ? `<ul class="items">${done.map(row).join("")}</ul>` : ""}` : "";
  }

  // ---------- Bearbeiten-Fenster ----------
  function openEdit(id) {
    const item = td.items.find(x => x.id === id);
    if (!item) return;
    td.editingId = id;
    const f = $("#form-todo");
    const me = state.session.user.id;
    f.title.value = item.title;
    f.notes.value = item.notes;
    f.due_date.value = item.due_date || "";
    f.due_time.value = item.due_time ? String(item.due_time).slice(0, 5) : "";
    setDurationSelect(item.duration_minutes);
    f.assigned_to.innerHTML = `<option value="">Niemand</option>` + state.members
      .map(m => `<option value="${m.id}">${escapeHtml(m.name)}${m.id === me ? " (du)" : ""}</option>`).join("");
    f.assigned_to.value = item.assigned_to || "";
    f.repeat.value = item.repeat;
    f.priority.checked = item.priority === 1;
    f.is_private.checked = item.is_private;
    td.draftTags = new Set(item.tag_ids || []);
    f.new_tag.value = "";
    renderTagPicker();
    // Privat umschalten darf nur, wer die Aufgabe angelegt hat
    f.is_private.disabled = item.created_by !== me;
    $("#todo-created").textContent = item.created_by && item.created_by !== me
      ? "Angelegt von " + (memberName(item.created_by) || "jemandem")
      : "";
    renderFiles();
    openSheet("sheet-todo");
  }

  $("#form-todo").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const payload = {
        title: f.title.value.trim(),
        notes: f.notes.value.trim(),
        due_date: f.due_date.value || null,
        due_time: f.due_time.value || null,
        duration_minutes: f.duration_minutes.value ? +f.duration_minutes.value : null,
        assigned_to: f.assigned_to.value || null,
        repeat: f.repeat.value,
        priority: f.priority.checked ? 1 : 0
      };
      const tagIds = [...td.draftTags].filter(id => td.tags.some(t => t.id === id));
      const before0 = td.items.find(x => x.id === td.editingId);
      if (tagIds.length || (before0 && before0.tag_ids && before0.tag_ids.length)) payload.tag_ids = tagIds;
      if (!f.is_private.disabled) payload.is_private = f.is_private.checked;
      if (payload.repeat !== "none" && !payload.due_date) payload.due_date = isoDate(startOfToday());
      if (payload.due_time && !payload.due_date) payload.due_date = isoDate(startOfToday());

      const before = td.items.find(x => x.id === td.editingId);
      const prevAssignee = before ? before.assigned_to : null;
      const { data, error } = await sb.from("todos").update(payload).eq("id", td.editingId).select().single();
      if (error) throw error;
      upsertLocal(data);
      if (data.assigned_to && data.assigned_to !== prevAssignee && data.assigned_to !== state.session.user.id && PP.notify) {
        PP.notify.task(data.id);
      }
      closeSheets();
      render();
    });
  });

  function renderTagPicker() {
    $("#todo-edit-tags").innerHTML = td.tags.length
      ? td.tags.map(t => `<button type="button" class="chip chip-tag${td.draftTags.has(t.id) ? " active" : ""}" data-pick-todo-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags – unten einen anlegen.</span>`;
  }

  $("#todo-edit-tags").addEventListener("click", e => {
    const b = e.target.closest("[data-pick-todo-tag]");
    if (!b) return;
    const id = b.dataset.pickTodoTag;
    td.draftTags.has(id) ? td.draftTags.delete(id) : td.draftTags.add(id);
    renderTagPicker();
  });

  async function addTagFromField() {
    const input = $("#form-todo").new_tag;
    const tag = await createTag(input.value);
    if (!tag) return;
    td.draftTags.add(tag.id);
    input.value = "";
    renderTagPicker();
  }
  $("#btn-todo-tag-add").addEventListener("click", addTagFromField);
  $("#form-todo").new_tag.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addTagFromField(); }
  });

  $("#btn-delete-todo").addEventListener("click", async () => {
    const id = td.editingId;
    const item = td.items.find(x => x.id === id);
    if (item && item.repeat !== "none" && !confirm("Diese Aufgabe wiederholt sich. Wirklich löschen? Es werden keine weiteren Termine angelegt.")) return;
    await removeStoredFiles(filesOf(id).map(f => f.path));
    const { error } = await sb.from("todos").delete().eq("id", id);
    if (error) { toast(translateError(error), true); return; }
    td.items = td.items.filter(x => x.id !== id);
    td.files.delete(id);
    closeSheets();
    render();
  });

  // ---------- Uhrzeit und Dauer ----------
  function durationText(min) {
    if (min < 60) return `${min} Min.`;
    const h = min / 60;
    if (min % 60 === 0) return `${h} Std.`;
    return `${String(Math.round(h * 10) / 10).replace(".", ",")} Std.`;
  }

  function timeRange(item) {
    const start = String(item.due_time).slice(0, 5);
    if (!item.duration_minutes) return start;
    const [h, m] = start.split(":").map(Number);
    const end = h * 60 + m + item.duration_minutes;
    if (end >= 24 * 60) return `${start} · ${durationText(item.duration_minutes)}`;
    return `${start}–${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  }

  function setDurationSelect(value) {
    const sel = $("#form-todo").duration_minutes;
    sel.querySelectorAll("option[data-custom]").forEach(o => o.remove());
    const v = value ? String(value) : "";
    if (v && ![...sel.options].some(o => o.value === v)) {
      const o = document.createElement("option");
      o.value = v; o.textContent = durationText(+v); o.dataset.custom = "1";
      sel.appendChild(o);
    }
    sel.value = v;
  }

  // ---------- Anlagen ----------
  const FILE_ICONS = [
    [/^image\//, "🖼️"], [/pdf/, "📄"], [/word|document|text/, "📝"],
    [/sheet|excel|csv/, "📊"], [/audio/, "🎵"], [/video/, "🎬"], [/zip|compressed/, "🗜️"]
  ];
  function fileIcon(mime) {
    for (const [re, icon] of FILE_ICONS) if (re.test(mime || "")) return icon;
    return "📎";
  }
  function sizeText(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
    return (Math.round(b / 1024 / 102.4) / 10).toString().replace(".", ",") + " MB";
  }
  function safeName(name) {
    return (name || "datei").normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-80) || "datei";
  }

  function renderFiles() {
    const files = filesOf(td.editingId);
    $("#todo-files").innerHTML = files.length
      ? files.map(f => `<li class="file-row">
          <button type="button" class="file-open" data-open-file="${f.id}">
            <span class="file-icon">${fileIcon(f.mime)}</span>
            <span class="file-text"><span class="file-name">${escapeHtml(f.name)}</span><span class="file-size">${sizeText(f.size)}</span></span>
          </button>
          <button type="button" class="icon-btn small" data-del-file="${f.id}" aria-label="Anlage löschen">✕</button>
        </li>`).join("")
      : `<li class="muted small">Noch keine Anlagen.</li>`;
  }

  async function uploadFiles(fileList) {
    const todoId = td.editingId;
    const hid = state.household.id;
    const btn = $("#btn-add-file");
    btn.disabled = true;
    let ok = 0;
    try {
      for (const file of fileList) {
        if (file.size > 25 * 1024 * 1024) { toast(`„${file.name}“ ist größer als 25 MB.`, true); continue; }
        btn.textContent = `Lädt hoch … (${ok + 1}/${fileList.length})`;
        const path = `${hid}/${todoId}/${crypto.randomUUID()}-${safeName(file.name)}`;
        const up = await sb.storage.from("todo-files").upload(path, file, {
          contentType: file.type || "application/octet-stream",
          upsert: false
        });
        if (up.error) throw up.error;
        const { data, error } = await sb.from("todo_attachments").insert({
          todo_id: todoId, household_id: hid, path,
          name: (file.name || "Datei").slice(0, 255), size: file.size, mime: file.type || ""
        }).select("id, todo_id, path, name, size, mime, created_at").single();
        if (error) {
          await sb.storage.from("todo-files").remove([path]);
          throw error;
        }
        if (!td.files.has(todoId)) td.files.set(todoId, []);
        td.files.get(todoId).push(data);
        ok++;
      }
      if (ok) toast(ok === 1 ? "Anlage hinzugefügt." : `${ok} Anlagen hinzugefügt.`);
    } catch (err) {
      toast(/Bucket not found/i.test(err.message || "") ? "Speicherort fehlt – bitte das SQL aus Schritt 7 ausführen." : translateError(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "＋ Datei oder Foto hinzufügen";
      renderFiles();
      render();
    }
  }

  async function removeStoredFiles(paths) {
    if (!paths.length) return;
    const { error } = await sb.storage.from("todo-files").remove(paths);
    if (error) console.warn("Dateien konnten nicht gelöscht werden:", error);
  }

  $("#btn-add-file").addEventListener("click", () => $("#todo-file-input").click());
  $("#todo-file-input").addEventListener("change", e => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) uploadFiles(files);
  });

  $("#todo-files").addEventListener("click", async e => {
    const openBtn = e.target.closest("[data-open-file]");
    const delBtn = e.target.closest("[data-del-file]");
    const files = filesOf(td.editingId);

    if (openBtn) {
      const f = files.find(x => x.id === openBtn.dataset.openFile);
      if (!f) return;
      // Fenster sofort öffnen (sonst blockiert Safari), dann Adresse setzen
      const win = window.open("", "_blank");
      const { data, error } = await sb.storage.from("todo-files").createSignedUrl(f.path, 3600);
      if (error) { if (win) win.close(); toast(translateError(error), true); return; }
      if (win) win.location.href = data.signedUrl; else location.href = data.signedUrl;
    }

    if (delBtn) {
      const f = files.find(x => x.id === delBtn.dataset.delFile);
      if (!f || !confirm(`Anlage „${f.name}“ löschen?`)) return;
      const { error } = await sb.from("todo_attachments").delete().eq("id", f.id);
      if (error) { toast(translateError(error), true); return; }
      await removeStoredFiles([f.path]);
      td.files.set(td.editingId, files.filter(x => x.id !== f.id));
      renderFiles();
      render();
    }
  });

  // ---------- Klicks ----------
  $("#view-todos").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.toggle) { toggle(t.dataset.toggle); return; }
    if (t.dataset.edit) { openEdit(t.dataset.edit); return; }
    if (t.id === "btn-todo-plan") { if (PP.planner) PP.planner.open(); return; }
    if (t.dataset.todoTag !== undefined) {
      td.tagFilter = t.dataset.todoTag;
      storageSet("pp_todo_tag", td.tagFilter);
      render();
      return;
    }
    if (t.dataset.filter) {
      td.filter = t.dataset.filter;
      storageSet("pp_todo_filter", td.filter);
      render();
      return;
    }
    if (t.hasAttribute("data-toggle-done")) { td.showDone = !td.showDone; render(); return; }
    if (t.hasAttribute("data-clear-done")) { clearDone(); return; }
  });

  $("#form-add-todo").addEventListener("submit", e => {
    e.preventDefault();
    const input = e.target.text;
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    addFromInput(text).then(ok => { if (!ok) input.value = text; }).catch(err => {
      input.value = text;
      toast(translateError(err), true);
    });
  });

  // ---------- Kachel ----------
  async function refreshTile() {
    if (!state.household) return;
    const { data, error } = await sb.from("todos").select("due_date")
      .eq("household_id", state.household.id).eq("is_done", false);
    if (error) return;
    const today = isoDate(startOfToday());
    const overdue = data.filter(x => x.due_date && x.due_date < today).length;
    const dueToday = data.filter(x => x.due_date === today).length;
    let s = data.length ? `${data.length} offen` : "Alles erledigt";
    if (overdue) s += ` · ${overdue} überfällig`;
    else if (dueToday) s += ` · ${dueToday} heute`;
    $("#tile-todo-status").textContent = s;
  }

  // ---------- Modul-Schnittstelle ----------
  PP.modules.todos = {
    async enter() {
      td.active = true;
      td.householdId = state.household.id;
      try {
        await loadAll();
        render();
        subscribe();
      } catch (err) {
        console.error(err);
        toast(translateError(err), true);
      }
    },
    leave() {
      td.active = false;
      unsubscribe();
      closeSheets();
    },
    async resume() {
      if (td.active) {
        try { await loadAll(); render(); subscribe(); } catch (err) { console.error(err); }
      } else {
        refreshTile();
      }
    },
    refreshTile,
    reset() {
      this.leave();
      td.items = [];
      td.householdId = null;
    }
  };

  PP._todos = { parseTodo, dueLabel };
})();
