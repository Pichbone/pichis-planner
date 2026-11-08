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
    channel: null,
    showDone: false,
    editingId: null,
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

  function parseTodo(raw, members) {
    let text = " " + raw.trim().replace(/\s+/g, " ") + " ";
    const out = { title: "", due_date: null, priority: 0, repeat: "none", is_private: false, assigned_to: null };
    const today = startOfToday();

    function take(re) {
      const m = text.match(re);
      if (m) text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
      return m;
    }

    if (take(new RegExp(B + "#privat" + E, "i"))) out.is_private = true;
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
  }

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
    const p = parseTodo(text, state.members);
    if (!p.title) { toast("Bitte einen Text für die Aufgabe eingeben.", true); return false; }

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

    const extras = [];
    if (data.due_date) extras.push(dueLabel(data.due_date));
    if (data.assigned_to) extras.push("für " + memberName(data.assigned_to));
    if (data.repeat !== "none") extras.push(REPEAT_LABEL[data.repeat]);
    if (data.is_private) extras.push("privat");
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
    const { error } = await sb.from("todos").delete().in("id", ids);
    if (error) { toast(translateError(error), true); return; }
    const set = new Set(ids);
    td.items = td.items.filter(x => !set.has(x.id));
    render();
  }

  // ---------- Darstellung ----------
  function visible() {
    const me = state.session.user.id;
    if (td.filter === "mine") return td.items.filter(x => x.assigned_to === me || (x.is_private && x.created_by === me));
    if (td.filter === "private") return td.items.filter(x => x.is_private);
    return td.items;
  }

  function sortOpen(a, b) {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
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
      meta.push(`<span class="${overdue ? "due-overdue" : ""}">${escapeHtml(dueLabel(item.due_date))}</span>`);
    }
    if (item.repeat !== "none") meta.push("🔁 " + REPEAT_LABEL[item.repeat]);
    if (item.is_private) meta.push("🔒 privat");
    if (item.notes) meta.push(escapeHtml(item.notes.split("\n")[0]).slice(0, 80));

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
    f.assigned_to.innerHTML = `<option value="">Niemand</option>` + state.members
      .map(m => `<option value="${m.id}">${escapeHtml(m.name)}${m.id === me ? " (du)" : ""}</option>`).join("");
    f.assigned_to.value = item.assigned_to || "";
    f.repeat.value = item.repeat;
    f.priority.checked = item.priority === 1;
    f.is_private.checked = item.is_private;
    // Privat umschalten darf nur, wer die Aufgabe angelegt hat
    f.is_private.disabled = item.created_by !== me;
    $("#todo-created").textContent = item.created_by && item.created_by !== me
      ? "Angelegt von " + (memberName(item.created_by) || "jemandem")
      : "";
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
        assigned_to: f.assigned_to.value || null,
        repeat: f.repeat.value,
        priority: f.priority.checked ? 1 : 0
      };
      if (!f.is_private.disabled) payload.is_private = f.is_private.checked;
      if (payload.repeat !== "none" && !payload.due_date) payload.due_date = isoDate(startOfToday());

      const { data, error } = await sb.from("todos").update(payload).eq("id", td.editingId).select().single();
      if (error) throw error;
      upsertLocal(data);
      closeSheets();
      render();
    });
  });

  $("#btn-delete-todo").addEventListener("click", async () => {
    const id = td.editingId;
    const item = td.items.find(x => x.id === id);
    if (item && item.repeat !== "none" && !confirm("Diese Aufgabe wiederholt sich. Wirklich löschen? Es werden keine weiteren Termine angelegt.")) return;
    const { error } = await sb.from("todos").delete().eq("id", id);
    if (error) { toast(translateError(error), true); return; }
    td.items = td.items.filter(x => x.id !== id);
    closeSheets();
    render();
  });

  // ---------- Klicks ----------
  $("#view-todos").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.toggle) { toggle(t.dataset.toggle); return; }
    if (t.dataset.edit) { openEdit(t.dataset.edit); return; }
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
