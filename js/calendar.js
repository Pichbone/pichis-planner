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

  async function loadEvents(force = false) {
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
    $("#cal-month-title").textContent = `${MONTHS[cal.month.getMonth()]} ${cal.month.getFullYear()}`;
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
      const dots = list.slice(0, 4).map(ev => `<i style="background:${escapeHtml(ev.calendar_color)}"></i>`).join("");
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
  }

  // ---------- Detail-Fenster: Tags und Personen ----------
  function openEvent(id) {
    const ev = cal.events.find(x => x.id === id);
    if (!ev) return;
    cal.editing = ev;
    const meta = metaOf(ev);
    cal.draftTags = new Set(meta ? meta.tag_ids : []);
    cal.draftMembers = new Set(meta ? meta.member_ids : []);

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
    $("#ev-where").textContent = ev.location || "";
    $("#ev-where").hidden = !ev.location;
    $("#ev-notes").textContent = ev.notes || "";
    $("#ev-notes").hidden = !ev.notes;
    const owner = ev.owner_id === state.session.user.id ? "" : " von " + (memberName(ev.owner_id) || "?");
    $("#ev-calendar").innerHTML = `<i style="background:${escapeHtml(ev.calendar_color)}"></i>${escapeHtml(ev.calendar_name)}${escapeHtml(owner)}`;
    $("#ev-series-hint").hidden = !ev.recurring;

    renderEventPickers();
    $("#form-new-tag").reset();
    openSheet("sheet-event");
  }

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

  $("#btn-save-event").addEventListener("click", async () => {
    const ev = cal.editing;
    if (!ev) return;
    const btn = $("#btn-save-event");
    btn.disabled = true;
    try {
      const existing = metaOf(ev);
      const payload = {
        tag_ids: [...cal.draftTags].filter(id => cal.tags.some(t => t.id === id)),
        member_ids: [...cal.draftMembers]
      };
      let res;
      if (existing) {
        res = await sb.from("event_meta").update(payload).eq("id", existing.id)
          .select("id, calendar_id, uid, tag_ids, member_ids").single();
      } else {
        res = await sb.from("event_meta").insert({
          household_id: state.household.id,
          calendar_id: ev.calendar_id,
          uid: ev.uid,
          ...payload
        }).select("id, calendar_id, uid, tag_ids, member_ids").single();
      }
      if (res.error) throw res.error;
      cal.metas.set(ev.calendar_id + "|" + ev.uid, res.data);
      closeSheets();
      render();
    } catch (err) {
      toast(PP.translateError(err), true);
    } finally {
      btn.disabled = false;
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
      <span class="cal-name">${escapeHtml(c.name)}${c.read_only ? ' <span class="muted small">(nur lesen)</span>' : ""}</span>
      <label class="switch switch-sm" title="In der App anzeigen">
        <input type="checkbox" data-cal-show="${c.id}" ${cal.hidden.has(c.id) ? "" : "checked"}><span class="small">Anzeigen</span>
      </label>
      ${own ? `<label class="switch switch-sm" title="Für die Familie sichtbar">
        <input type="checkbox" data-cal-share="${c.id}" ${c.share_with_household ? "checked" : ""}><span class="small">Familie</span>
      </label>` : ""}
    </li>`;

    $("#cal-list-mine").innerHTML = mine.length ? mine.map(c => row(c, true)).join("") : `<li class="muted small">–</li>`;
    $("#cal-list-mine-block").hidden = !mine.length;

    const byOwner = {};
    others.forEach(c => { (byOwner[c.user_id] = byOwner[c.user_id] || []).push(c); });
    $("#cal-list-others").innerHTML = Object.keys(byOwner).length
      ? Object.entries(byOwner).map(([uid, list]) =>
          `<li class="cal-owner">${escapeHtml(memberName(uid) || "Familie")}</li>` + list.map(c => row(c, false)).join("")).join("")
      : `<li class="muted small">Noch keine freigegebenen Kalender von anderen.</li>`;

    $("#cal-tag-list").innerHTML = cal.tags.length
      ? cal.tags.map(t => `<li class="cal-row">${tagChip(t)}<button class="icon-btn small" data-del-tag="${t.id}" aria-label="Tag löschen">✕</button></li>`).join("")
      : `<li class="muted small">Noch keine Tags. Tags vergibst du, indem du einen Termin antippst.</li>`;
  }

  $("#sheet-calsettings").addEventListener("change", async e => {
    const t = e.target;
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
  $("#view-calendar").addEventListener("click", e => {
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
  });

  $("#sheet-connect").addEventListener("click", e => {
    if (e.target.closest("[data-cal-connect]")) openConnect();
  });
  $("#cal-account").addEventListener("click", e => {
    if (e.target.closest("[data-cal-connect]")) openConnect();
  });

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
