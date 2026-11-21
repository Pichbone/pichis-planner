// =========================================================
// Pichis Planner – „Heute“ oben auf der Startseite
// Das Wichtigste des Tages auf einen Blick: nächster Termin, fällige
// Aufgaben, Abendessen, Müllabfuhr, Geburtstage. Jede Zeile führt in
// den passenden Bereich. Nichts Neues – nur gebündelt.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, escapeHtml, storageGet, storageSet } = PP;

  const CACHE = "pp_today";
  const pad = n => String(n).padStart(2, "0");
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let events = { at: 0, day: "", list: [] };
  let busy = false;

  function readCache() {
    try { const c = JSON.parse(storageGet(CACHE) || "null"); return c && c.day === isoOf(new Date()) ? c : null; } catch { return null; }
  }

  // Termine von heute (iCloud) – höchstens alle 10 Minuten neu holen
  async function loadEvents(today) {
    if (events.day === today && Date.now() - events.at < 10 * 60000) return events.list;
    const s = new Date(today + "T00:00:00"), e = new Date(s); e.setDate(e.getDate() + 1);
    const { data, error } = await sb.functions.invoke("icloud", { body: { action: "events", start: s.toISOString(), end: e.toISOString() } });
    if (error || !data) return events.list;
    const seen = new Set();
    events = {
      at: Date.now(), day: today,
      list: (data.events || []).filter(ev => { const k = ev.uid + "|" + ev.start; if (seen.has(k)) return false; seen.add(k); return true; })
        .map(ev => ({ title: ev.title, start: ev.start, end: ev.end, all_day: ev.all_day, color: ev.calendar_color }))
    };
    return events.list;
  }

  async function collect() {
    const today = isoOf(new Date());
    const t2 = new Date(); t2.setDate(t2.getDate() + 1);
    const tomorrow = isoOf(t2);
    const hid = state.household.id;
    const q = p => p.then(r => (r.error ? null : r.data)).catch(() => null);
    const [evs, todos, meal, waste, bdays] = await Promise.all([
      loadEvents(today).catch(() => []),
      q(sb.from("todos").select("title, due_date, due_time, priority").eq("household_id", hid).eq("is_done", false).lte("due_date", today)
        .order("due_time", { ascending: true, nullsFirst: false }).limit(50)),
      q(sb.from("meal_plan").select("*, recipes(name)").eq("household_id", hid).eq("day", today)),
      q(sb.from("waste_dates").select("day, kind, title").eq("household_id", hid).in("day", [today, tomorrow])),
      q(sb.from("birthdays").select("id, name, birth_month, birth_day, birth_year, is_private").eq("household_id", hid))
    ]);
    return { today, tomorrow, evs, todos, meal, waste, bdays, at: Date.now() };
  }

  function lines(d) {
    const out = [];
    const now = new Date();
    // Termine
    const evs = (d.evs || []).slice().sort((a, b) => (a.all_day === b.all_day ? String(a.start).localeCompare(String(b.start)) : a.all_day ? -1 : 1));
    const timed = evs.filter(e => !e.all_day && new Date(e.end) > now);
    const allDay = evs.filter(e => e.all_day);
    if (timed.length) {
      const e = timed[0];
      const running = new Date(e.start) <= now;
      const more = timed.length - 1;
      out.push({ icon: "📅", href: "#/kalender", main: `${running ? "jetzt" : clock(new Date(e.start))} ${e.title}`, sub: more ? `+${more} weitere${allDay.length ? ` · ${allDay.map(x => x.title).join(", ")}` : ""}` : allDay.map(x => x.title).join(", ") });
    } else if (allDay.length) {
      out.push({ icon: "📅", href: "#/kalender", main: allDay.map(x => x.title).join(", "), sub: "ganztägig" });
    }
    // Aufgaben
    const todos = d.todos || [];
    if (todos.length) {
      const over = todos.filter(t => t.due_date < d.today).length;
      const first = todos.find(t => t.due_date === d.today) || todos[0];
      out.push({ icon: "✅", href: "#/aufgaben", alert: over > 0,
        main: `${todos.length} Aufgabe${todos.length === 1 ? "" : "n"} fällig`,
        sub: [over ? `${over} überfällig` : "", first ? `${first.due_time ? String(first.due_time).slice(0, 5) + " " : ""}${first.title}` : ""].filter(Boolean).join(" · ") });
    }
    // Abendessen
    // eigenes Gericht (oder eins „für alle“)
    const me = state.session.user.id;
    const meals = Array.isArray(d.meal) ? d.meal : (d.meal ? [d.meal] : []);
    const mine = meals.filter(m => !Array.isArray(m.eaters) || !m.eaters.length || m.eaters.includes(me));
    const dish = mine.map(m => (m.recipes && m.recipes.name) || m.title).filter(Boolean).join(" / ");
    if (dish) out.push({ icon: "🍽️", href: "#/essen", main: dish, sub: "Abendessen" });
    // Müllabfuhr (heute oder morgen)
    const W = PP.waste;
    const wToday = (d.waste || []).filter(w => w.day === d.today), wTom = (d.waste || []).filter(w => w.day === d.tomorrow);
    if (W && (wToday.length || wTom.length)) {
      const list = wToday.length ? wToday : wTom;
      out.push({ icon: "🗑️", href: "#/muell", alert: !wToday.length && now.getHours() >= 16,
        main: `${wToday.length ? "Heute" : "Morgen"}: ${list.map(W.label).join(", ")}`, sub: wToday.length ? "" : "heute Abend rausstellen" });
    }
    // Geburtstage heute
    if (PP.birthdays && d.bdays) {
      const bt = PP.birthdays.on(d.bdays, d.today);
      if (bt.length) out.push({ icon: "🎂", href: "#/geburtstage", main: bt.map(b => b.name + (b.age > 0 ? ` (${b.age})` : "")).join(", "), sub: "hat heute Geburtstag 🎉" });
    }
    return out;
  }

  function paint(d) {
    const box = $("#today-box");
    if (!box) return;
    const ls = d ? lines(d) : [];
    if (!d) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="td-head"><span>Heute</span></div>` + (ls.length
      ? `<ul class="td-list">${ls.map(l => `<li><a class="td-row${l.alert ? " alert" : ""}" href="${l.href}">
          <span class="td-icon" aria-hidden="true">${l.icon}</span>
          <span class="td-text"><span class="td-main">${escapeHtml(l.main)}</span>${l.sub ? `<span class="td-sub">${escapeHtml(l.sub)}</span>` : ""}</span>
          <span class="td-go" aria-hidden="true">›</span></a></li>`).join("")}</ul>`
      : `<p class="muted small td-empty">Heute steht nichts an – genieß den Tag. ☀️</p>`);
  }

  const off = () => storageGet("pp_today_off") === "1";
  const tg = $("#today-toggle");
  if (tg) {
    tg.checked = !off();
    tg.addEventListener("change", () => {
      storageSet("pp_today_off", tg.checked ? "0" : "1");
      if (tg.checked) refresh(); else $("#today-box").hidden = true;
    });
  }

  async function refresh() {
    if (off()) { const b = $("#today-box"); if (b) b.hidden = true; return; }
    if (busy || !state.household) return;
    // sofort aus dem Zwischenspeicher, dann frisch
    const c = readCache();
    if (c) paint(c);
    busy = true;
    try {
      const d = await collect();
      storageSet(CACHE, JSON.stringify(d));
      if (document.body.dataset.view === "home" || !document.body.dataset.view) paint(d);
    } catch (err) {
      console.warn("Heute:", err);
    } finally { busy = false; }
  }

  // Termin-Zwischenspeicher übernehmen, damit „jetzt“/„nächster“ auch ohne Laden stimmt
  try { const c = readCache(); if (c) events = { at: c.at, day: c.today, list: c.evs || [] }; } catch { /* egal */ }

  PP.modules.today = {
    enter() {}, leave() {}, resume() { refresh(); },
    refreshTile: refresh,
    reset() { events = { at: 0, day: "", list: [] }; try { localStorage.removeItem(CACHE); } catch { /* egal */ } }
  };
})();
