// =========================================================
// Pichis Planner – Kalender (iCloud)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, storageGet, storageSet, memberName, openSheet, closeSheets } = PP;

  const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const WEEKDAYS_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  const TAG_COLORS = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];

  const cal = {
    active: false,
    me: null,                 // eigene iCloud-Verbindung
    calendars: [],            // sichtbare Kalender (eigene + freigegebene)
    tags: [],
    metas: new Map(),         // "kalenderId|uid" → { id, tag_ids, member_ids }
    events: [],
    errors: [],
    cache: new Map(),         // Zeitraum → { events, errors }
    month: firstOfMonth(new Date()),
    selected: isoDate(new Date()),
    hidden: new Set(JSON.parse(storageGet("pp_cal_hidden") || "[]")),
    tagFilter: storageGet("pp_cal_tag") || "",
    showTodos: storageGet("pp_cal_todos") === "1",
    showShopping: storageGet("pp_cal_shop") === "1",
    showNotes: storageGet("pp_cal_notes") !== "0",
    notes: [],
    todos: [],
    shopping: [],
    loading: false,
    channel: null,
    editing: null,            // Termin im Detail-Fenster
    draftTags: new Set(),
    draftMembers: new Set(),
    loadToken: 0
  };

  // ---------- Datum ----------
  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function gridStart(month) {
    const wd = (month.getDay() + 6) % 7; // Montag = 0
    return addDays(month, -wd);
  }
  function timeText(d) { return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
  function longDate(iso) {
    const d = parseIso(iso);
    return `${WEEKDAYS_LONG[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
  }

  // ---------- Server-Funktion ----------
  async function callIcloud(action, payload = {}) {
    const { data, error } = await sb.functions.invoke("icloud", { body: { action, ...payload } });
    if (error) {
      let msg = error.message || "Fehler";
      try {
        const j = await error.context.json();
        if (j && j.error) msg = j.error;
      } catch { /* keine JSON-Antwort */ }
      if (/Failed to send|fetch|FunctionsFetchError|FunctionsRelayError/i.test(msg)) {
        msg = "Die Server-Funktion „icloud“ ist nicht erreichbar. Ist sie in Supabase angelegt?";
      }
      throw new Error(msg);
    }
    return data;
  }

  // ---------- Daten laden ----------
  async function loadBase() {
    const hid = state.household.id;
    const [me, cals, tags, metas] = await Promise.all([
      callIcloud("status").catch(err => { toast(err.message, true); return null; }),
      // "kind" (für Kalender-Abos) wird erst mit Schritt 9 (SQL) abgefragt – Abos sind vorerst zurückgestellt
      sb.from("calendars").select("id, user_id, name, color, share_with_household, read_only").order("name"),
      sb.from("event_tags").select("id, name, color").eq("household_id", hid).order("name"),
      sb.from("event_meta").select("id, calendar_id, uid, tag_ids, member_ids").eq("household_id", hid)
    ]);
    if (cals.error) throw cals.error;
    if (tags.error) throw tags.error;
    if (metas.error) throw metas.error;

    cal.me = me;
    cal.calendars = cals.data;
    cal.tags = tags.data;
    cal.metas = new Map(metas.data.map(m => [m.calendar_id + "|" + m.uid, m]));
    if (cal.tagFilter && !cal.tags.some(t => t.id === cal.tagFilter)) cal.tagFilter = "";
  }

  function rangeOf(month) {
    const start = gridStart(month);
    return { start, end: addDays(start, 42), key: isoDate(start) };
  }

  // Aufgaben und Einkaufsliste für die Kalenderansicht (nur wenn eingeschaltet)
  async function loadExtras() {
    const hid = state.household.id;
    const { start, end } = rangeOf(cal.month);
    const today = isoDate(new Date());
    const jobs = [];
    if (cal.showTodos) {
      jobs.push(sb.from("todos")
        .select("*")
        .eq("household_id", hid)
        .or(`and(due_date.gte.${isoDate(start)},due_date.lt.${isoDate(end)}),and(due_date.lt.${today},is_done.eq.false)`)
        .then(r => { cal.todos = r.error ? [] : r.data; }));
    } else {
      cal.todos = [];
    }
    if (cal.showNotes) {
      jobs.push(sb.from("notes")
        .select("id, title, body, note_date, note_time, tag_ids, is_private, is_pinned, created_by")
        .eq("household_id", hid)
        .gte("note_date", isoDate(start)).lt("note_date", isoDate(end))
        .then(r => { cal.notes = r.error ? [] : r.data; }));
    } else {
      cal.notes = [];
    }
    if (cal.showShopping) {
      jobs.push(Promise.all([
        sb.from("shopping_lists").select("id, name, sort_order").eq("household_id", hid).order("sort_order"),
        sb.from("shopping_items").select("list_id, name, quantity").eq("household_id", hid).eq("is_done", false).order("created_at")
      ]).then(([l, i]) => {
        cal.shopping = (l.data || []).map(list => ({
          list, items: (i.data || []).filter(x => x.list_id === list.id)
        })).filter(x => x.items.length);
      }));
    } else {
      cal.shopping = [];
    }
    await Promise.all(jobs);
  }

  function todosOn(iso) {
    const today = isoDate(new Date());
    return cal.todos.filter(t =>
      t.due_date === iso || (iso === today && t.due_date < today && !t.is_done))
      .sort((a, b) => {
        if (a.is_done !== b.is_done) return a.is_done ? 1 : -1;
        if ((a.due_date < today) !== (b.due_date < today)) return a.due_date < today ? -1 : 1;
        if (a.due_time !== b.due_time) return !a.due_time ? 1 : !b.due_time ? -1 : a.due_time < b.due_time ? -1 : 1;
        return b.priority - a.priority;
      });
  }

  async function loadEvents(force = false) {
    loadExtras().then(() => render()).catch(err => console.warn(err));
    const { start, end, key } = rangeOf(cal.month);
    const token = ++cal.loadToken;

    if (!force && cal.cache.has(key)) {
      const c = cal.cache.get(key);
      cal.events = c.events; cal.errors = c.errors;
      render();
      return;
    }

    cal.loading = true;
    render();
    try {
      const data = await callIcloud("events", { start: start.toISOString(), end: end.toISOString() });
      if (token !== cal.loadToken) return; // inzwischen anderer Monat
      cal.cache.set(key, data);
      cal.events = data.events || [];
      cal.errors = data.errors || [];
    } catch (err) {
      if (token !== cal.loadToken) return;
      cal.events = []; cal.errors = [];
      toast(err.message, true);
    } finally {
      if (token === cal.loadToken) {
        cal.loading = false;
        render();
      }
    }
  }

  // ---------- Live-Abgleich für Tags und Teilnehmer ----------
  function subscribe() {
    unsubscribe();
    const hid = state.household.id;
    cal.channel = sb.channel("cal-" + hid)
      .on("postgres_changes", { event: "*", schema: "public", table: "event_meta", filter: `household_id=eq.${hid}` }, p => {
        if (p.eventType === "DELETE") {
          for (const [k, m] of cal.metas) if (m.id === (p.old && p.old.id)) cal.metas.delete(k);
        } else {
          cal.metas.set(p.new.calendar_id + "|" + p.new.uid, p.new);
        }
        render();
      })
      .subscribe();
  }
  function unsubscribe() {
    if (cal.channel) { sb.removeChannel(cal.channel); cal.channel = null; }
  }

  // ---------- Termine je Tag ----------
  function metaOf(ev) { return cal.metas.get(ev.calendar_id + "|" + ev.uid) || null; }

  function passesFilter(ev) {
    if (cal.hidden.has(ev.calendar_id)) return false;
    if (cal.tagFilter) {
      const m = metaOf(ev);
      if (!m || !m.tag_ids.includes(cal.tagFilter)) return false;
    }
    return true;
  }

  function daysOf(ev) {
    const days = [];
    let s, e;
    if (ev.all_day) {
      s = parseIso(ev.start);
      e = addDays(parseIso(ev.end), -1);
    } else {
      const sd = new Date(ev.start), ed = new Date(ev.end);
      s = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate());
      const last = new Date(Math.max(+sd, +ed - 1));
      e = new Date(last.getFullYear(), last.getMonth(), last.getDate());
    }
    for (let d = s, i = 0; d <= e && i < 60; d = addDays(d, 1), i++) days.push(isoDate(d));
    return days;
  }

  function eventsByDay() {
    const map = new Map();
    for (const ev of cal.events) {
      if (!passesFilter(ev)) continue;
      for (const day of daysOf(ev)) {
        if (!map.has(day)) map.set(day, []);
        map.get(day).push(ev);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
        return a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title);
      });
    }
    return map;
  }

  // ---------- Darstellung ----------
  function tagChip(tag, extra = "") {
    return `<span class="tag" style="--tag:${escapeHtml(tag.color)}"${extra}>${escapeHtml(tag.name)}</span>`;
  }

  function avatar(userId) {
    const n = memberName(userId) || "?";
    return `<span class="avatar avatar-sm" title="${escapeHtml(n)}">${escapeHtml(n.charAt(0).toUpperCase())}</span>`;
  }

  function eventTime(ev, day) {
    if (ev.all_day) return "Ganztägig";
    const s = new Date(ev.start), e = new Date(ev.end);
    const startsToday = isoDate(s) === day;
    const endsToday = isoDate(new Date(+e - 1)) === day;
    if (startsToday && endsToday) return `${timeText(s)} – ${timeText(e)}`;
    if (startsToday) return `ab ${timeText(s)}`;
    if (endsToday) return `bis ${timeText(e)}`;
    return "Ganztägig";
  }

  function render() {
    if (!cal.active) return;
    const byDay = eventsByDay();

    // Kopfzeile
    const mName = MONTHS[cal.month.getMonth()];
    $("#cal-month-title").innerHTML = `<span class="m-long">${mName}</span><span class="m-short">${mName.length > 4 ? mName.slice(0, 3) + "." : mName}</span> ${cal.month.getFullYear()}`;
    $("#cal-loading").hidden = !cal.loading;

    // Hinweise
    let notes = "";
    if (cal.me && !cal.me.connected) {
      notes += `<div class="banner banner-action">
        <div><strong>Deinen iCloud-Kalender verbinden</strong><br><span class="small">Dann sieht die Familie deine Termine – du entscheidest, welche Kalender.</span></div>
        <button class="btn btn-small" data-cal-connect>Verbinden</button>
      </div>`;
    } else if (cal.me && cal.me.status === "error") {
      notes += `<div class="banner banner-warn">
        <div><strong>iCloud-Verbindung abgelaufen</strong><br><span class="small">Bitte ein neues app-spezifisches Passwort eintragen.</span></div>
        <button class="btn btn-small" data-cal-connect>Erneuern</button>
      </div>`;
    }
    const otherErrors = [...new Set(cal.errors
      .filter(e => e.owner_id !== state.session.user.id)
      .map(e => memberName(e.owner_id) || "jemandem"))];
    if (otherErrors.length) {
      notes += `<div class="banner banner-warn"><div class="small">Kalender von ${escapeHtml(otherErrors.join(", "))} konnten nicht geladen werden. Die Verbindung muss dort erneuert werden.</div></div>`;
    }
    $("#cal-notes").innerHTML = notes;

    // Tag-Filter
    $("#cal-tags").innerHTML = cal.tags.length
      ? `<button class="chip${cal.tagFilter ? "" : " active"}" data-tag-filter="">Alle</button>` +
        cal.tags.map(t => `<button class="chip chip-tag${cal.tagFilter === t.id ? " active" : ""}" data-tag-filter="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : "";

    // Monatsraster
    const start = gridStart(cal.month);
    const today = isoDate(new Date());
    let grid = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map(d => `<div class="cal-wd">${d}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const iso = isoDate(d);
      const list = byDay.get(iso) || [];
      const cls = ["cal-day"];
      if (d.getMonth() !== cal.month.getMonth()) cls.push("other");
      if (iso === today) cls.push("today");
      if (iso === cal.selected) cls.push("selected");
      const dots = list.slice(0, 4).map(ev => `<i style="background:${escapeHtml(ev.calendar_color)}"></i>`).join("") +
        (cal.showTodos && cal.todos.some(t => t.due_date === iso && !t.is_done) ? '<i class="todo-dot"></i>' : "") +
        (cal.showNotes && cal.notes.some(n => n.note_date === iso) ? '<i class="note-dot"></i>' : "");
      grid += `<button class="${cls.join(" ")}" data-day="${iso}" aria-label="${longDate(iso)}, ${list.length} Termine">
        <span class="num">${d.getDate()}</span><span class="dots">${dots}${list.length > 4 ? "<b>+</b>" : ""}</span>
      </button>`;
    }
    $("#cal-grid").innerHTML = grid;

    // Tagesliste
    const dayList = byDay.get(cal.selected) || [];
    $("#cal-day-title").textContent = cal.selected === today ? "Heute · " + longDate(cal.selected) : longDate(cal.selected);
    $("#cal-day-list").innerHTML = dayList.length
      ? `<ul class="events">${dayList.map(ev => {
          const meta = metaOf(ev);
          const tags = meta ? meta.tag_ids.map(id => cal.tags.find(t => t.id === id)).filter(Boolean) : [];
          const members = meta ? meta.member_ids.filter(id => memberName(id)) : [];
          const owner = ev.owner_id !== state.session.user.id ? " · " + escapeHtml(memberName(ev.owner_id)) : "";
          return `<li><button class="event" data-event="${escapeHtml(ev.id)}" style="--cal:${escapeHtml(ev.calendar_color)}">
            <span class="event-time">${eventTime(ev, cal.selected)}</span>
            <span class="event-body">
              <span class="event-title">${escapeHtml(ev.title)}${ev.recurring ? ' <span class="muted">🔁</span>' : ""}</span>
              ${ev.location ? `<span class="event-sub">📍 ${escapeHtml(ev.location)}</span>` : ""}
              <span class="event-sub">${escapeHtml(ev.calendar_name)}${owner}</span>
              ${tags.length ? `<span class="tag-row">${tags.map(t => tagChip(t)).join("")}</span>` : ""}
            </span>
            ${members.length ? `<span class="event-people">${members.map(avatar).join("")}</span>` : ""}
          </button></li>`;
        }).join("")}</ul>`
      : `<p class="muted cal-empty">${cal.loading ? "Termine werden geladen …" : "Keine Termine."}</p>`;

    // Aufgaben des Tages
    let extra = "";
    if (cal.showTodos) {
      const tds = todosOn(cal.selected);
      if (tds.length) {
        extra += `<h4 class="cal-sub">✅ Aufgaben</h4><ul class="events">${tds.map(t => {
          const overdue = !t.is_done && t.due_date < today;
          let when = t.due_time ? String(t.due_time).slice(0, 5) : "";
          if (when && t.duration_minutes) {
            const [h, m] = when.split(":").map(Number);
            const e = h * 60 + m + t.duration_minutes;
            if (e < 1440) when += `–${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`;
          }
          const who = t.assigned_to && memberName(t.assigned_to) ? avatar(t.assigned_to) : "";
          return `<li class="cal-todo${t.is_done ? " done" : ""}">
            <button class="check-btn${t.is_done ? " on" : ""}" data-cal-todo="${t.id}" aria-label="Erledigt">✓</button>
            <a class="cal-todo-main" href="#/aufgaben">
              <span class="event-title">${t.priority ? '<span class="prio">!</span>' : ""}${escapeHtml(t.title)}</span>
              <span class="event-sub">${overdue ? `<span class="due-overdue">überfällig seit ${escapeHtml(longDate(t.due_date))}</span>` : (when || "Ganztägig")}${t.is_private ? " · 🔒" : ""}</span>
              ${(t.tag_ids || []).length ? `<span class="tag-row">${t.tag_ids.map(id => cal.tags.find(x => x.id === id)).filter(Boolean).map(x => tagChip(x)).join("")}</span>` : ""}
            </a>
            ${who}
          </li>`;
        }).join("")}</ul>`;
      }
    }

    // Notizen des Tages
    if (cal.showNotes) {
      const ns = cal.notes.filter(n => n.note_date === cal.selected)
        .sort((a, b) => String(a.note_time || "").localeCompare(String(b.note_time || "")));
      if (ns.length) {
        extra += `<h4 class="cal-sub">📝 Notizen</h4><ul class="events">${ns.map(n => {
          const tags = n.tag_ids.map(id => cal.tags.find(t => t.id === id)).filter(Boolean);
          const text = n.title || n.body.split("\n")[0];
          const sub = n.title && n.body ? n.body.replace(/\s+/g, " ").slice(0, 120) : "";
          return `<li><button class="cal-note" data-cal-note="${n.id}">
            <span class="event-time">${n.note_time ? String(n.note_time).slice(0, 5) : "📝"}</span>
            <span class="event-body">
              <span class="event-title">${escapeHtml(text)}${n.is_private ? ' <span class="muted">🔒</span>' : ""}</span>
              ${sub ? `<span class="event-sub">${escapeHtml(sub)}</span>` : ""}
              ${tags.length ? `<span class="tag-row">${tags.map(t => tagChip(t)).join("")}</span>` : ""}
            </span>
          </button></li>`;
        }).join("")}</ul>`;
      }
    }

    // Einkaufsliste (am heutigen Tag)
    if (cal.showShopping && cal.selected === today && cal.shopping.length) {
      extra += `<h4 class="cal-sub">🛒 Einkaufsliste</h4>` + cal.shopping.map(s => {
        const names = s.items.slice(0, 12).map(i => (i.quantity ? i.quantity + " " : "") + i.name);
        return `<a class="cal-shop" href="#/einkauf">
          <span class="event-title">${escapeHtml(s.list.name)} <span class="chip-count">${s.items.length}</span></span>
          <span class="event-sub">${escapeHtml(names.join(", "))}${s.items.length > 12 ? " …" : ""}</span>
        </a>`;
      }).join("");
    }
    $("#cal-day-extra").innerHTML = extra;
    if (extra && !dayList.length && !cal.loading) $("#cal-day-list").innerHTML = `<p class="muted cal-empty">Keine Termine.</p>`;
  }

  // ---------- Termin-Fenster: ansehen, anlegen, bearbeiten ----------
  const ALARM_OPTIONS = ["none", "0", "10", "30", "60", "120", "1440", "2880"];

  function hhmm(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }

  function writableOwnCalendars() {
    const me = state.session.user.id;
    return cal.calendars.filter(c => c.user_id === me && !c.read_only);
  }

  function canEdit(ev) {
    return writableOwnCalendars().some(c => c.id === ev.calendar_id);
  }

  function fillReadonly(ev) {
    $("#ev-title").textContent = ev.title;
    let when;
    if (ev.all_day) {
      const last = addDays(parseIso(ev.end), -1);
      when = ev.start === isoDate(last) ? longDate(ev.start) + " · ganztägig"
        : `${longDate(ev.start)} – ${longDate(isoDate(last))}`;
    } else {
      const s = new Date(ev.start), e = new Date(ev.end);
      when = isoDate(s) === isoDate(e)
        ? `${longDate(isoDate(s))} · ${timeText(s)} – ${timeText(e)}`
        : `${longDate(isoDate(s))}, ${timeText(s)} – ${longDate(isoDate(e))}, ${timeText(e)}`;
    }
    $("#ev-when").textContent = when + (ev.recurring ? " · wiederholt sich" : "");
    $("#ev-where").textContent = ev.location ? "📍 " + ev.location : "";
    $("#ev-where").hidden = !ev.location;
    $("#ev-notes").textContent = ev.notes || "";
    $("#ev-notes").hidden = !ev.notes;
    const owner = ev.owner_id === state.session.user.id ? "" : " von " + (memberName(ev.owner_id) || "?");
    $("#ev-calendar").innerHTML = `<i style="background:${escapeHtml(ev.calendar_color)}"></i>${escapeHtml(ev.calendar_name)}${escapeHtml(owner)}`;
  }

  function setAllDayUi(allDay) {
    document.querySelectorAll("#form-event [data-time]").forEach(el => { el.hidden = allDay; });
  }

  function fillCalendarSelect(selected) {
    const f = $("#form-event");
    const list = writableOwnCalendars();
    f.calendar_id.innerHTML = list.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    if (selected && list.some(c => c.id === selected)) f.calendar_id.value = selected;
  }

  function setAlarmSelect(value) {
    const sel = $("#form-event").alarm;
    const keep = sel.querySelector('option[value="keep"]');
    if (ALARM_OPTIONS.includes(value)) {
      keep.hidden = true;
      sel.value = value;
    } else {
      keep.hidden = false;
      sel.value = "keep";
    }
  }

  function openEvent(id) {
    const ev = cal.events.find(x => x.id === id);
    if (!ev) return;
    cal.editing = { mode: canEdit(ev) ? "edit" : "view", ev };
    const meta = metaOf(ev);
    cal.draftTags = new Set(meta ? meta.tag_ids : []);
    cal.draftMembers = new Set(meta ? meta.member_ids : []);

    const editable = cal.editing.mode === "edit";
    $("#ev-head").textContent = editable ? "Termin bearbeiten" : "Termin";
    $("#ev-readonly").hidden = editable;
    $("#form-event").hidden = !editable;
    $("#btn-delete-event").hidden = !editable;
    $("#btn-delete-event").textContent = ev.recurring ? "Ganze Serie löschen" : "Termin löschen";
    $("#ev-series-hint").hidden = !ev.recurring;

    if (editable) {
      const f = $("#form-event");
      f.reset();
      f.title.value = ev.title;
      f.location.value = ev.location || "";
      f.notes.value = ev.notes || "";
      f.all_day.checked = ev.all_day;
      if (ev.all_day) {
        f.start_date.value = ev.start;
        f.end_date.value = isoDate(addDays(parseIso(ev.end), -1));
        f.start_time.value = "10:00";
        f.end_time.value = "11:00";
      } else {
        const s = new Date(ev.start), e = new Date(ev.end);
        f.start_date.value = isoDate(s);
        f.end_date.value = isoDate(e);
        f.start_time.value = hhmm(s);
        f.end_time.value = hhmm(e);
      }
      setAllDayUi(ev.all_day);
      fillCalendarSelect(ev.calendar_id);
      setAlarmSelect(ev.alarm === null || ev.alarm === undefined ? "none" : String(ev.alarm));

      // Bei Serien: Zeiten und Wiederholung nur im Apple-Kalender ändern
      const series = !!ev.recurring;
      ["all_day", "start_date", "end_date", "start_time", "end_time"].forEach(n => { f[n].disabled = series; });
      $("#ev-series-times").hidden = !series;
      $("#ev-cal-row").hidden = true;      // Kalender wechseln geht nicht
      $("#ev-repeat-row").hidden = true;
    } else {
      fillReadonly(ev);
    }

    renderEventPickers();
    $("#form-new-tag").reset();
    openSheet("sheet-event");
  }

  function openNewEvent() {
    const own = writableOwnCalendars();
    if (!own.length) {
      toast("Verbinde zuerst deinen iCloud-Kalender, um Termine anzulegen.");
      openConnect();
      return;
    }
    cal.editing = { mode: "new", ev: null };
    cal.draftTags = new Set(cal.tagFilter ? [cal.tagFilter] : []);
    cal.draftMembers = new Set();

    const f = $("#form-event");
    f.reset();
    ["all_day", "start_date", "end_date", "start_time", "end_time"].forEach(n => { f[n].disabled = false; });

    // Startzeit: heute nächste volle Stunde, sonst 10 Uhr
    let start = "10:00", end = "11:00", day = cal.selected;
    if (cal.selected === isoDate(new Date())) {
      const h = new Date().getHours() + 1;
      if (h <= 22) { start = `${String(h).padStart(2, "0")}:00`; end = `${String(h + 1).padStart(2, "0")}:00`; }
      else { day = isoDate(addDays(new Date(), 1)); }
    }
    f.start_date.value = day;
    f.end_date.value = day;
    f.start_time.value = start;
    f.end_time.value = end;
    setAllDayUi(false);
    fillCalendarSelect(storageGet("pp_cal_last"));
    setAlarmSelect(storageGet("pp_cal_alarm") || "30");

    $("#ev-head").textContent = "Neuer Termin";
    $("#ev-readonly").hidden = true;
    $("#form-event").hidden = false;
    $("#ev-series-times").hidden = true;
    $("#ev-cal-row").hidden = false;
    $("#ev-repeat-row").hidden = false;
    $("#btn-delete-event").hidden = true;
    $("#ev-series-hint").hidden = true;

    renderEventPickers();
    $("#form-new-tag").reset();
    openSheet("sheet-event");
    setTimeout(() => f.title.focus(), 50);
  }

  // Formular-Komfort: Ende folgt dem Beginn
  (() => {
    const f = $("#form-event");
    let lastStart = null;
    f.all_day.addEventListener("change", () => setAllDayUi(f.all_day.checked));
    f.start_date.addEventListener("change", () => {
      if (!f.end_date.value || f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value;
    });
    f.start_time.addEventListener("focus", () => { lastStart = f.start_time.value; });
    f.start_time.addEventListener("change", () => {
      const toMin = v => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };
      if (!f.start_time.value) return;
      const dur = lastStart && f.end_time.value ? Math.max(15, toMin(f.end_time.value) - toMin(lastStart)) : 60;
      const endMin = Math.min(toMin(f.start_time.value) + dur, 23 * 60 + 55);
      if (f.start_date.value === f.end_date.value) {
        f.end_time.value = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
      }
      lastStart = f.start_time.value;
    });
  })();

  function renderEventPickers() {
    $("#ev-tags").innerHTML = cal.tags.length
      ? cal.tags.map(t => `<button type="button" class="chip chip-tag${cal.draftTags.has(t.id) ? " active" : ""}" data-pick-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags – unten einen anlegen.</span>`;

    const me = state.session.user.id;
    $("#ev-members").innerHTML = state.members.map(m =>
      `<button type="button" class="chip chip-person${cal.draftMembers.has(m.id) ? " active" : ""}" data-pick-member="${m.id}">
        ${escapeHtml(m.name)}${m.id === me ? " (du)" : ""}
      </button>`).join("");
  }

  $("#sheet-event").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.pickTag) {
      const id = t.dataset.pickTag;
      cal.draftTags.has(id) ? cal.draftTags.delete(id) : cal.draftTags.add(id);
      renderEventPickers();
    } else if (t.dataset.pickMember) {
      const id = t.dataset.pickMember;
      cal.draftMembers.has(id) ? cal.draftMembers.delete(id) : cal.draftMembers.add(id);
      renderEventPickers();
    }
  });

  $("#form-new-tag").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const name = f.name.value.trim();
      if (!name) return;
      const existing = cal.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        cal.draftTags.add(existing.id);
      } else {
        const { data, error } = await sb.from("event_tags").insert({
          household_id: state.household.id,
          name,
          color: TAG_COLORS[cal.tags.length % TAG_COLORS.length]
        }).select("id, name, color").single();
        if (error) throw error;
        cal.tags.push(data);
        cal.tags.sort((a, b) => a.name.localeCompare(b.name));
        cal.draftTags.add(data.id);
      }
      f.reset();
      renderEventPickers();
    });
  });

  async function saveMeta(calendarId, uid) {
    const key = calendarId + "|" + uid;
    const existing = cal.metas.get(key);
    const payload = {
      tag_ids: [...cal.draftTags].filter(id => cal.tags.some(t => t.id === id)),
      member_ids: [...cal.draftMembers]
    };
    if (!existing && !payload.tag_ids.length && !payload.member_ids.length) return;
    const res = existing
      ? await sb.from("event_meta").update(payload).eq("id", existing.id)
          .select("id, calendar_id, uid, tag_ids, member_ids").single()
      : await sb.from("event_meta").insert({ household_id: state.household.id, calendar_id: calendarId, uid, ...payload })
          .select("id, calendar_id, uid, tag_ids, member_ids").single();
    if (res.error) throw res.error;
    cal.metas.set(key, res.data);
  }

  function formPayload() {
    const f = $("#form-event");
    return {
      title: f.title.value.trim(),
      location: f.location.value.trim(),
      notes: f.notes.value.trim(),
      all_day: f.all_day.checked,
      start_date: f.start_date.value,
      end_date: f.end_date.value || f.start_date.value,
      start_time: f.start_time.value,
      end_time: f.end_time.value,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin",
      repeat: f.repeat.value,
      alarm: f.alarm.value
    };
  }

  $("#btn-save-event").addEventListener("click", async () => {
    const ed = cal.editing;
    if (!ed) return;
    const f = $("#form-event");
    if (ed.mode !== "view" && !f.reportValidity()) return;

    const btn = $("#btn-save-event");
    btn.disabled = true;
    btn.textContent = "Speichert …";
    try {
      if (ed.mode === "view") {
        await saveMeta(ed.ev.calendar_id, ed.ev.uid);
        closeSheets();
        render();
        return;
      }

      const p = formPayload();
      if (ed.mode === "new") {
        p.calendar_id = f.calendar_id.value;
        const r = await callIcloud("create", p);
        storageSet("pp_cal_last", p.calendar_id);
        storageSet("pp_cal_alarm", p.alarm);
        await saveMeta(r.calendar_id, r.uid);
        toast("Termin angelegt – er erscheint auch im Apple-Kalender.");
      } else {
        const ev = ed.ev;
        const r = await callIcloud("update", { ...p, calendar_id: ev.calendar_id, href: ev.href, etag: ev.etag });
        await saveMeta(ev.calendar_id, ev.uid);
        toast(r.series ? "Serie aktualisiert." : "Termin gespeichert.");
      }

      // Zum Datum des Termins springen und neu laden
      cal.selected = p.start_date;
      cal.month = firstOfMonth(parseIso(p.start_date));
      cal.cache.clear();
      closeSheets();
      await loadEvents(true);
    } catch (err) {
      toast(err.message || PP.translateError(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Speichern";
    }
  });

  $("#btn-delete-event").addEventListener("click", async () => {
    const ed = cal.editing;
    if (!ed || ed.mode !== "edit") return;
    const ev = ed.ev;
    const question = ev.recurring
      ? `„${ev.title}“ ist ein Serientermin. Die ganze Serie löschen – auch im Apple-Kalender?`
      : `„${ev.title}“ löschen – auch im Apple-Kalender?`;
    if (!confirm(question)) return;
    try {
      await callIcloud("delete", { calendar_id: ev.calendar_id, href: ev.href, etag: ev.etag, uid: ev.uid });
      cal.metas.delete(ev.calendar_id + "|" + ev.uid);
      cal.cache.clear();
      closeSheets();
      toast("Termin gelöscht.");
      await loadEvents(true);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- Verbinden ----------
  function openConnect() {
    const f = $("#form-connect");
    f.reset();
    if (cal.me && cal.me.username) f.username.value = cal.me.username;
    openSheet("sheet-connect");
  }

  $("#form-connect").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const me = await callIcloud("connect", {
        username: f.username.value.trim(),
        password: f.password.value
      });
      cal.me = me;
      f.reset();
      await loadBase();
      cal.cache.clear();
      toast(`Verbunden – ${me.calendars.length} Kalender gefunden.`);
      openSettings();
      loadEvents(true);
    });
  });

  // ---------- Einstellungen ----------
  function openSettings() {
    renderSettings();
    openSheet("sheet-calsettings");
  }

  function renderSettings() {
    const me = state.session.user.id;
    const mine = cal.calendars.filter(c => c.user_id === me);
    const others = cal.calendars.filter(c => c.user_id !== me);

    let acc;
    if (cal.me && cal.me.connected) {
      acc = `<p class="small">Verbunden als <strong>${escapeHtml(cal.me.username)}</strong>${cal.me.status === "error" ? ' · <span class="due-overdue">Verbindung abgelaufen</span>' : ""}</p>
        <div class="btn-row">
          <button class="btn btn-small" data-cal-sync>Kalender neu einlesen</button>
          <button class="btn btn-small" data-cal-connect>Passwort ändern</button>
        </div>`;
    } else {
      acc = `<p class="small muted">Noch nicht verbunden.</p><button class="btn btn-small" data-cal-connect>iCloud verbinden</button>`;
    }
    $("#cal-account").innerHTML = acc;

    const row = (c, own) => `<li class="cal-row">
      <i class="cal-dot" style="background:${escapeHtml(c.color)}"></i>
      <span class="cal-name">${escapeHtml(c.name)}${c.kind === "ics" ? ' <span class="muted small">(Abo)</span>' : c.read_only ? ' <span class="muted small">(nur lesen)</span>' : ""}</span>
      <label class="switch switch-sm" title="In der App anzeigen">
        <input type="checkbox" data-cal-show="${c.id}" ${cal.hidden.has(c.id) ? "" : "checked"}><span class="small">Anzeigen</span>
      </label>
      ${own ? `<label class="switch switch-sm" title="Für die Familie sichtbar">
        <input type="checkbox" data-cal-share="${c.id}" ${c.share_with_household ? "checked" : ""}><span class="small">Familie</span>
      </label>` : ""}
      ${own && c.kind === "ics" ? `<button class="icon-btn small" data-del-feed="${c.id}" aria-label="Abo entfernen" title="Abo entfernen">✕</button>` : ""}
    </li>`;

    $("#cal-list-mine").innerHTML = mine.length ? mine.map(c => row(c, true)).join("") : `<li class="muted small">–</li>`;
    $("#cal-list-mine-block").hidden = !mine.length;

    const byOwner = {};
    others.forEach(c => { (byOwner[c.user_id] = byOwner[c.user_id] || []).push(c); });
    $("#cal-list-others").innerHTML = Object.keys(byOwner).length
      ? Object.entries(byOwner).map(([uid, list]) =>
          `<li class="cal-owner">${escapeHtml(memberName(uid) || "Familie")}</li>` + list.map(c => row(c, false)).join("")).join("")
      : `<li class="muted small">Noch keine freigegebenen Kalender von anderen.</li>`;

    $("#cal-show-todos").checked = cal.showTodos;
    $("#cal-show-shop").checked = cal.showShopping;
    $("#cal-show-notes").checked = cal.showNotes;

    $("#cal-tag-list").innerHTML = cal.tags.length
      ? cal.tags.map(t => `<li class="cal-row">${tagChip(t)}<button class="icon-btn small" data-del-tag="${t.id}" aria-label="Tag löschen">✕</button></li>`).join("")
      : `<li class="muted small">Noch keine Tags. Tags vergibst du, indem du einen Termin antippst.</li>`;
  }

  $("#sheet-calsettings").addEventListener("change", async e => {
    const t = e.target;
    if (t.id === "cal-show-todos" || t.id === "cal-show-shop" || t.id === "cal-show-notes") {
      cal.showTodos = $("#cal-show-todos").checked;
      cal.showShopping = $("#cal-show-shop").checked;
      cal.showNotes = $("#cal-show-notes").checked;
      storageSet("pp_cal_todos", cal.showTodos ? "1" : "0");
      storageSet("pp_cal_shop", cal.showShopping ? "1" : "0");
      storageSet("pp_cal_notes", cal.showNotes ? "1" : "0");
      await loadExtras();
      render();
      return;
    }
    if (t.dataset.calShow) {
      t.checked ? cal.hidden.delete(t.dataset.calShow) : cal.hidden.add(t.dataset.calShow);
      storageSet("pp_cal_hidden", JSON.stringify([...cal.hidden]));
      render();
    }
    if (t.dataset.calShare) {
      const id = t.dataset.calShare;
      const { error } = await sb.from("calendars").update({ share_with_household: t.checked }).eq("id", id);
      if (error) {
        t.checked = !t.checked;
        toast(PP.translateError(error), true);
        return;
      }
      const c = cal.calendars.find(x => x.id === id);
      if (c) c.share_with_household = t.checked;
    }
  });

  $("#sheet-calsettings").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-cal-sync")) {
      t.disabled = true;
      try {
        cal.me = await callIcloud("sync");
        await loadBase();
        renderSettings();
        cal.cache.clear();
        loadEvents(true);
        toast("Kalenderliste aktualisiert.");
      } catch (err) { toast(err.message, true); }
      finally { t.disabled = false; }
    }
    if (t.dataset.delFeed) {
      const c = cal.calendars.find(x => x.id === t.dataset.delFeed);
      if (!c || !confirm(`Abo „${c.name}“ entfernen?`)) return;
      try {
        cal.me = await callIcloud("remove_feed", { calendar_id: c.id });
        await loadBase();
        renderSettings();
        cal.cache.clear();
        loadEvents(true);
        toast("Abo entfernt.");
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (t.dataset.delTag) {
      const tag = cal.tags.find(x => x.id === t.dataset.delTag);
      if (!tag || !confirm(`Tag „${tag.name}“ löschen? Er wird bei allen Terminen entfernt.`)) return;
      const { error } = await sb.from("event_tags").delete().eq("id", tag.id);
      if (error) { toast(PP.translateError(error), true); return; }
      cal.tags = cal.tags.filter(x => x.id !== tag.id);
      if (cal.tagFilter === tag.id) { cal.tagFilter = ""; storageSet("pp_cal_tag", ""); }
      renderSettings();
      render();
    }
  });

  $("#form-feed").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const r = await callIcloud("add_feed", {
        name: f.name.value.trim(),
        url: f.url.value.trim(),
        color: f.color.value,
        share: f.share.checked
      });
      cal.me = r;
      f.reset();
      await loadBase();
      renderSettings();
      cal.cache.clear();
      loadEvents(true);
      toast(`Abonniert – ${r.feed_events || 0} Termine gefunden.`);
    });
  });

  $("#btn-cal-disconnect").addEventListener("click", async () => {
    if (!confirm("iCloud-Verbindung trennen? Deine Kalender verschwinden dann auch bei der Familie aus der App.")) return;
    try {
      cal.me = await callIcloud("disconnect");
      await loadBase();
      cal.cache.clear();
      closeSheets();
      loadEvents(true);
      toast("Verbindung getrennt.");
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Klicks in der Ansicht ----------
  $("#view-calendar").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.day) {
      cal.selected = t.dataset.day;
      const d = parseIso(cal.selected);
      if (d.getMonth() !== cal.month.getMonth()) {
        cal.month = firstOfMonth(d);
        loadEvents();
      } else {
        render();
      }
      return;
    }
    if (t.dataset.event) { openEvent(t.dataset.event); return; }
    if (t.dataset.tagFilter !== undefined) {
      cal.tagFilter = t.dataset.tagFilter;
      storageSet("pp_cal_tag", cal.tagFilter);
      render();
      return;
    }
    if (t.hasAttribute("data-cal-connect")) { openConnect(); return; }
    if (t.id === "cal-prev" || t.id === "cal-next") {
      const delta = t.id === "cal-prev" ? -1 : 1;
      cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + delta, 1);
      const sel = parseIso(cal.selected);
      if (sel.getMonth() !== cal.month.getMonth() || sel.getFullYear() !== cal.month.getFullYear()) {
        cal.selected = isoDate(cal.month.getMonth() === new Date().getMonth() && cal.month.getFullYear() === new Date().getFullYear() ? new Date() : cal.month);
      }
      loadEvents();
      return;
    }
    if (t.id === "cal-today") {
      cal.month = firstOfMonth(new Date());
      cal.selected = isoDate(new Date());
      loadEvents();
      return;
    }
    if (t.id === "cal-settings") { openSettings(); return; }
    if (t.id === "cal-add") { openNewEvent(); return; }
    if (t.id === "cal-plan") { if (PP.planner) PP.planner.open(cal.selected); return; }
    if (t.id === "cal-note-add") { if (PP.notes) PP.notes.create({ date: cal.selected }); return; }
    if (t.dataset.calNote) { if (PP.notes) PP.notes.open(t.dataset.calNote); return; }
    if (t.dataset.calTodo) {
      const td = cal.todos.find(x => x.id === t.dataset.calTodo);
      if (!td) return;
      const before = td.is_done;
      td.is_done = !before;
      render();
      const { error } = await sb.from("todos").update({ is_done: !before }).eq("id", td.id);
      if (error) { td.is_done = before; render(); toast(PP.translateError(error), true); return; }
      await loadExtras();   // wiederkehrende Aufgaben: nächsten Termin holen
      render();
      return;
    }
  });

  $("#sheet-connect").addEventListener("click", e => {
    if (e.target.closest("[data-cal-connect]")) openConnect();
  });
  $("#cal-account").addEventListener("click", e => {
    if (e.target.closest("[data-cal-connect]")) openConnect();
  });

  // Nach dem Einplanen: Aufgaben im Kalender neu laden
  PP.calendarRefreshExtras = async () => {
    if (!cal.active) return;
    await loadExtras();
    render();
  };

  // ---------- Modul-Schnittstelle ----------
  PP.modules.calendar = {
    async enter() {
      cal.active = true;
      render();
      try {
        await loadBase();
        render();
        subscribe();
        await loadEvents();
      } catch (err) {
        console.error(err);
        toast(PP.translateError(err), true);
      }
    },
    leave() {
      cal.active = false;
      unsubscribe();
      closeSheets();
    },
    async resume() {
      if (!cal.active) return;
      cal.cache.clear();
      try { await loadBase(); subscribe(); await loadEvents(true); } catch (err) { console.error(err); }
    },
    refreshTile() { /* Kalender-Kachel zeigt keine Zahl, um iCloud nicht unnötig abzufragen */ },
    reset() {
      this.leave();
      cal.cache.clear();
      cal.events = []; cal.calendars = []; cal.tags = []; cal.metas = new Map(); cal.me = null;
    }
  };
})();
