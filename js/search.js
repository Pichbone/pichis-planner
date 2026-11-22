// =========================================================
// Pichis Planner – Suche über alles
// Aufgaben, Termine, Notizen, Wiki, Archiv (auch im PDF-Text), Rezepte,
// Bücher, Geburtstage und Reisen auf einmal. Es gelten die normalen
// Rechte: Privates anderer taucht nie auf.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, escapeHtml, storageGet, storageSet } = PP;

  const se = { active: false, query: "", token: 0, results: {}, pending: new Set(), events: null, eventsAt: 0, timer: null };
  const hid = () => state.household.id;
  const RECENT_KEY = "pp_search_recent";

  const GROUPS = [
    { key: "todos", icon: "✅", label: "Aufgaben" },
    { key: "events", icon: "📅", label: "Termine" },
    { key: "notes", icon: "📝", label: "Notizen" },
    { key: "wiki", icon: "📖", label: "Wiki" },
    { key: "archive", icon: "🗄️", label: "Archiv" },
    { key: "recipes", icon: "🍽️", label: "Rezepte" },
    { key: "books", icon: "📚", label: "Bücher" },
    { key: "birthdays", icon: "🎂", label: "Geburtstage" },
    { key: "trips", icon: "🧳", label: "Urlaub" }
  ];

  // ---------- Hilfen ----------
  const fmtDay = iso => iso ? new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" }) : "";
  const norm = s => String(s || "").toLowerCase();
  // Für PostgREST-Filter: Sonderzeichen raus, die die Abfrage stören
  const safe = q => q.replace(/[,()*%_\\:"]/g, " ").replace(/\s+/g, " ").trim();
  const words = q => norm(q).split(/\s+/).filter(Boolean);

  // Textstelle rund um den Treffer, Treffer markiert
  function snippet(text, q, len = 110) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const w = words(q);
    const i = w.map(x => norm(t).indexOf(x)).filter(x => x >= 0).sort((a, b) => a - b)[0];
    if (i == null) return escapeHtml(t.slice(0, len)) + (t.length > len ? " …" : "");
    const start = Math.max(0, i - 40);
    const part = (start ? "… " : "") + t.slice(start, start + len) + (start + len < t.length ? " …" : "");
    return mark(part, q);
  }
  function mark(text, q) {
    let html = escapeHtml(text);
    for (const w of words(q).filter(x => x.length >= 2)) {
      const re = new RegExp(`(${escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      html = html.replace(re, "<mark>$1</mark>");
    }
    return html;
  }
  // «…» aus der Datenbank-Suche (ts_headline) → <mark>
  const headline = s => escapeHtml(String(s || "").replace(/\s+/g, " ")).replace(/«/g, "<mark>").replace(/»/g, "</mark>");

  // ---------- Quellen ----------
  const SOURCES = {
    async todos(q) {
      const s = safe(q);
      const { data, error } = await sb.from("todos").select("id, title, notes, due_date, is_done")
        .eq("household_id", hid()).or(`title.ilike.*${s}*,notes.ilike.*${s}*`).order("is_done").limit(25);
      if (error) throw error;
      return data.map(t => ({ id: t.id, title: t.title, sub: [t.is_done ? "✓ erledigt" : "", t.due_date ? "fällig " + fmtDay(t.due_date) : ""].filter(Boolean).join(" · "),
        snip: t.notes && norm(t.notes).includes(norm(q)) ? snippet(t.notes, q) : "", open: { mod: "todos", hash: "#/aufgaben", id: t.id } }));
    },
    async notes(q) {
      const s = safe(q);
      const { data, error } = await sb.from("notes").select("id, title, body, note_date, updated_at")
        .eq("household_id", hid()).or(`title.ilike.*${s}*,body.ilike.*${s}*`).order("updated_at", { ascending: false }).limit(25);
      if (error) throw error;
      return data.map(n => ({ id: n.id, title: n.title || String(n.body || "").split("\n")[0].slice(0, 60) || "Notiz",
        sub: n.note_date ? fmtDay(n.note_date) : "", snip: snippet(n.body, q), open: { mod: "notes", hash: "#/notizen", id: n.id } }));
    },
    async wiki(q) {
      const { data, error } = await sb.rpc("wiki_search", { p_household: hid(), p_query: q });
      if (error) throw error;
      const seen = new Set();
      return (data || []).filter(h => !seen.has(h.page_id) && seen.add(h.page_id)).slice(0, 25).map(h => ({ id: h.page_id, title: `${h.icon ? h.icon + " " : ""}${h.title}`,
        sub: [h.category, h.file_name ? "📎 " + h.file_name : ""].filter(Boolean).join(" · "), snip: headline(h.snippet), href: "#/wiki/" + h.page_id }));
    },
    async archive(q) {
      const { data, error } = await sb.rpc("archive_search", { p_household: hid(), p_query: q });
      if (error) throw error;
      return (data || []).slice(0, 25).map(d => ({ id: d.id, title: d.title, sub: [d.category, fmtDay(d.doc_date)].filter(Boolean).join(" · "),
        snip: headline(d.snippet), open: { mod: "archive", hash: "#/archiv", id: d.id } }));
    },
    async recipes(q) {
      const s = safe(q);
      const { data, error } = await sb.from("recipes").select("id, name, ingredients, servings")
        .eq("household_id", hid()).or(`name.ilike.*${s}*,ingredients.ilike.*${s}*`).order("name").limit(25);
      if (error) throw error;
      return data.map(r => ({ id: r.id, title: r.name, sub: `für ${r.servings}`, snip: norm(r.name).includes(norm(q)) ? "" : snippet(r.ingredients, q),
        open: { mod: "meals", hash: "#/essen", id: r.id } }));
    },
    async books(q) {
      const s = safe(q);
      const { data, error } = await sb.from("books").select("id, title, author, series, series_index")
        .eq("household_id", hid()).or(`title.ilike.*${s}*,author.ilike.*${s}*,series.ilike.*${s}*,file_name.ilike.*${s}*`).order("title").limit(25);
      if (error) throw error;
      return data.map(b => ({ id: b.id, title: b.title, sub: [b.author, b.series ? `${b.series}${b.series_index ? " " + b.series_index : ""}` : ""].filter(Boolean).join(" · "),
        open: { mod: "books", hash: "#/buecher", id: b.id } }));
    },
    async birthdays(q) {
      const s = safe(q);
      const { data, error } = await sb.from("birthdays").select("id, name, birth_day, birth_month, relation, notes")
        .eq("household_id", hid()).or(`name.ilike.*${s}*,relation.ilike.*${s}*,notes.ilike.*${s}*`).order("name").limit(25);
      if (error) throw error;
      return data.map(b => ({ id: b.id, title: b.name, sub: [`${b.birth_day}.${b.birth_month}.`, b.relation].filter(Boolean).join(" · "),
        open: { mod: "birthdays", hash: "#/geburtstage", id: b.id } }));
    },
    async trips(q) {
      const s = safe(q);
      const { data, error } = await sb.from("trips").select("id, title, start_date, end_date, is_template")
        .eq("household_id", hid()).or(`title.ilike.*${s}*,note.ilike.*${s}*`).limit(25);
      if (error) throw error;
      return data.map(t => ({ id: t.id, title: t.title, sub: t.is_template ? "Vorlage" : fmtDay(t.start_date), href: "#/urlaub/" + t.id }));
    },
    // Termine kommen live aus den Kalendern: einmal laden (90 Tage zurück, 1 Jahr voraus), dann lokal filtern
    async events(q) {
      if (!se.events || Date.now() - se.eventsAt > 10 * 60000) {
        const start = new Date(); start.setDate(start.getDate() - 90);
        const end = new Date(); end.setDate(end.getDate() + 365);
        const { data, error } = await sb.functions.invoke("icloud", { body: { action: "events", start: start.toISOString(), end: end.toISOString() } });
        if (error) throw error;
        se.events = (data && data.events) || [];
        se.eventsAt = Date.now();
      }
      const w = words(q);
      const now = new Date().toISOString();
      const hits = se.events.filter(e => { const hay = norm(`${e.title} ${e.location || ""} ${e.notes || ""} ${e.calendar_name || ""}`); return w.every(x => hay.includes(x)); });
      const up = hits.filter(e => String(e.start) >= now.slice(0, 10)).sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const past = hits.filter(e => String(e.start) < now.slice(0, 10)).sort((a, b) => String(b.start).localeCompare(String(a.start)));
      return [...up, ...past].slice(0, 25)
        .map(e => ({ id: e.id, title: e.title || "Termin", sub: [fmtDay(e.start) + (e.all_day ? "" : " " + new Date(e.start).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })), e.location, e.calendar_name].filter(Boolean).join(" · "),
          snip: e.notes && norm(e.notes).includes(w[0]) ? snippet(e.notes, q) : "", open: { mod: "calendar", hash: "#/kalender", id: e.id, date: String(e.start).slice(0, 10) } }));
    }
  };

  // ---------- Suchen ----------
  function run(q) {
    se.query = q;
    const token = ++se.token;
    se.results = {};
    se.pending = new Set();
    if (q.trim().length < 2) { render(); return; }
    for (const g of GROUPS) {
      se.pending.add(g.key);
      SOURCES[g.key](q.trim()).then(list => { if (token === se.token) se.results[g.key] = list; })
        .catch(err => { console.warn("Suche", g.key, err); if (token === se.token) se.results[g.key] = []; })
        .finally(() => { if (token === se.token) { se.pending.delete(g.key); render(); } });
    }
    render();
  }

  function remember(q) {
    q = q.trim();
    if (q.length < 2) return;
    let list = [];
    try { list = JSON.parse(storageGet(RECENT_KEY) || "[]"); } catch { /* egal */ }
    list = [q, ...list.filter(x => norm(x) !== norm(q))].slice(0, 8);
    storageSet(RECENT_KEY, JSON.stringify(list));
  }

  function render() {
    const box = $("#se-results");
    if (!box) return;
    const q = se.query.trim();
    if (q.length < 2) {
      let recent = [];
      try { recent = JSON.parse(storageGet(RECENT_KEY) || "[]"); } catch { /* egal */ }
      box.innerHTML = `<p class="muted small">Durchsucht Aufgaben, Termine, Notizen, Wiki, Archiv (auch den Text in PDFs), Rezepte, Bücher, Geburtstage und Urlaub.</p>
        ${recent.length ? `<h4 class="cal-sub">Zuletzt gesucht</h4><div class="chips">${recent.map(r => `<button class="chip" data-se-recent="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join("")}</div>` : ""}`;
      return;
    }
    const total = GROUPS.reduce((a, g) => a + (se.results[g.key] || []).length, 0);
    const html = GROUPS.filter(g => (se.results[g.key] || []).length).map(g => {
      const list = se.results[g.key];
      return `<h4 class="cal-sub">${g.icon} ${g.label} <span class="chip-count">${list.length}</span></h4>
        <ul class="ar-list se-list">${list.map((r, i) => `<li><button class="ar-doc" data-se="${g.key}:${i}">
          <span class="ar-main"><span class="ar-title">${mark(r.title, q)}</span>
          ${r.sub ? `<span class="ar-sub">${escapeHtml(r.sub)}</span>` : ""}
          ${r.snip ? `<span class="se-snip">${r.snip}</span>` : ""}</span></button></li>`).join("")}</ul>`;
    }).join("");
    const busy = se.pending.size ? `<p class="muted small se-busy">Suche läuft … ${se.pending.has("events") && se.pending.size === 1 ? "(Termine werden geladen)" : ""}</p>` : "";
    box.innerHTML = busy + (html || (se.pending.size ? "" : `<div class="empty"><div class="empty-icon">🔎</div><p><strong>Nichts gefunden.</strong></p><p class="muted small">Tipp: ein kürzeres Wort probieren, z. B. „Versich“ statt „Versicherungsvertrag“.</p></div>`)) +
      (total && !se.pending.size ? `<p class="muted small">${total} Treffer</p>` : "");
  }

  // ---------- Bedienung ----------
  $("#se-input").addEventListener("input", e => {
    clearTimeout(se.timer);
    const v = e.target.value;
    se.timer = setTimeout(() => run(v), 300);
  });
  $("#se-input").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(se.timer); remember(e.target.value); run(e.target.value); e.target.blur(); } });

  $("#se-results").addEventListener("click", e => {
    const rec = e.target.closest("[data-se-recent]");
    if (rec) { $("#se-input").value = rec.dataset.seRecent; run(rec.dataset.seRecent); return; }
    const b = e.target.closest("[data-se]");
    if (!b) return;
    const [g, i] = b.dataset.se.split(":");
    const r = (se.results[g] || [])[+i];
    if (!r) return;
    remember(se.query);
    if (r.href) { location.hash = r.href; return; }
    PP.openLater(r.open.mod, r.open, r.open.hash);
  });

  // Suchfeld auf der Startseite
  const home = $("#home-search");
  if (home) {
    home.addEventListener("submit", e => {
      e.preventDefault();
      const q = e.target.q.value.trim();
      e.target.q.value = "";
      se.query = q;
      location.hash = "#/suche";
    });
  }

  PP.modules.search = {
    enter() {
      se.active = true;
      const input = $("#se-input");
      input.value = se.query;
      run(se.query);
      setTimeout(() => { input.focus(); if (se.query) input.select(); }, 80);
    },
    leave() { se.active = false; },
    resume() { if (se.active && se.query) { se.events = null; run(se.query); } },
    reset() { se.query = ""; se.results = {}; se.events = null; }
  };
})();
