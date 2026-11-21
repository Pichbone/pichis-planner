// =========================================================
// Pichis Planner – Urlaub & Packlisten
// Reisen mit Countdown, gemeinsame Packlisten zum Abhaken,
// wiederverwendbare Vorlagen, Reiseunterlagen aus dem Archiv (per Tag)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, openSheet, closeSheets, memberName } = PP;

  const tr = { active: false, trips: [], items: [], openId: null, editing: null, docs: [], channel: null, tags: [] };
  const hid = () => state.household.id;
  const me = () => state.session.user.id;
  const pad = n => String(n).padStart(2, "0");
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const days = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);
  const fmt = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" }) : "";

  function sqlHint(err) {
    const m = (err && err.message) || "";
    return /trips|trip_items|does not exist|schema cache/.test(m) ? "Bitte zuerst das SQL aus Schritt 38 in Supabase ausführen." : translateError(err);
  }

  // ---------- Daten ----------
  async function loadTrips() {
    const { data, error } = await sb.from("trips").select("*").eq("household_id", hid()).order("start_date", { ascending: true, nullsFirst: false });
    if (error) throw error;
    tr.trips = data;
  }
  async function loadItems(id) {
    const { data, error } = await sb.from("trip_items").select("*").eq("trip_id", id).order("sort").order("created_at");
    if (error) throw error;
    tr.items = data;
  }
  async function loadDocs(trip) {
    tr.docs = [];
    if (!trip || !trip.tag_id) return;
    const { data } = await sb.from("archive_docs").select("id, title, mime, file_name, doc_date").eq("household_id", hid())
      .contains("tag_ids", [trip.tag_id]).order("doc_date", { ascending: true, nullsFirst: false }).limit(50);
    tr.docs = data || [];
  }
  async function loadTags() {
    const { data } = await sb.from("event_tags").select("id, name, color").eq("household_id", hid()).order("name");
    tr.tags = data || [];
  }

  function countdown(t) {
    if (!t.start_date) return "";
    const d = days(today(), t.start_date);
    if (d > 1) return `Noch ${d} Tage`;
    if (d === 1) return "Morgen geht's los!";
    if (d === 0) return "Heute geht's los! 🎉";
    if (t.end_date && days(today(), t.end_date) >= 0) return "Gerade unterwegs ☀️";
    return "Vorbei";
  }

  // ---------- Übersicht ----------
  function renderList() {
    const t = today();
    const trips = tr.trips.filter(x => !x.is_template);
    const upcoming = trips.filter(x => !x.start_date || (x.end_date || x.start_date) >= t);
    const past = trips.filter(x => x.start_date && (x.end_date || x.start_date) < t).reverse();
    const templates = tr.trips.filter(x => x.is_template);
    const card = x => `<li><button class="ar-doc tr-card" data-trip="${x.id}">
        <span class="ar-icon">${x.is_template ? "📋" : "🧳"}</span>
        <span class="ar-main"><span class="ar-title">${escapeHtml(x.title)}${x.is_private ? ' <span class="muted">🔒</span>' : ""}</span>
        <span class="ar-sub">${x.is_template ? "Vorlage" : [x.start_date ? `${fmt(x.start_date)}${x.end_date && x.end_date !== x.start_date ? " – " + fmt(x.end_date) : ""}` : "ohne Datum", countdown(x)].filter(Boolean).map(escapeHtml).join(" · ")}</span></span>
      </button></li>`;
    $("#tr-body").innerHTML =
      (upcoming.length ? `<ul class="ar-list">${upcoming.map(card).join("")}</ul>`
        : `<div class="empty"><div class="empty-icon">🧳</div><p><strong>Noch keine Reise geplant.</strong></p>
           <p class="muted small">Mit „+ Reise“ anlegen – die Packliste könnt ihr gemeinsam abhaken. Einmal gepackte Listen lassen sich als Vorlage für den nächsten Urlaub speichern.</p></div>`) +
      (templates.length ? `<h4 class="cal-sub">📋 Vorlagen</h4><ul class="ar-list">${templates.map(card).join("")}</ul>` : "") +
      (past.length ? `<details class="tr-past"><summary>Vergangene Reisen (${past.length})</summary><ul class="ar-list">${past.map(card).join("")}</ul></details>` : "");
  }

  // ---------- Reise / Packliste ----------
  function renderTrip() {
    const x = tr.trips.find(t => t.id === tr.openId);
    if (!x) { tr.openId = null; renderList(); return; }
    const items = tr.items;
    const done = items.filter(i => i.is_done).length;
    const sections = [...new Set(items.map(i => i.section || ""))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b, "de"));
    const members = state.members || [];
    const itemRow = i => `<li class="tr-item${i.is_done ? " done" : ""}">
        <button type="button" class="check-btn${i.is_done ? " on" : ""}" data-tr-check="${i.id}" aria-label="${i.is_done ? "Nicht gepackt" : "Gepackt"}">${i.is_done ? "✓" : ""}</button>
        <span class="tr-text">${escapeHtml(i.text)}</span>
        <button type="button" class="tr-who" data-tr-who="${i.id}" title="Wer packt das?">${i.who && memberName(i.who) ? escapeHtml(memberName(i.who).slice(0, 2)) : "👤"}</button>
        <button type="button" class="icon-btn small" data-tr-del="${i.id}" aria-label="Entfernen">✕</button>
      </li>`;
    const templates = tr.trips.filter(t => t.is_template && t.id !== x.id);
    $("#tr-body").innerHTML = `<div class="tr-head card">
        <div class="tr-title"><strong>${escapeHtml(x.title)}</strong>${x.is_private ? ' <span class="muted">🔒</span>' : ""}
          <button type="button" class="link" id="btn-tr-edit">Bearbeiten</button></div>
        ${x.is_template ? `<p class="muted small">Vorlage – beim Anlegen einer Reise kannst du sie übernehmen.</p>`
          : `<p class="tr-count">${escapeHtml(countdown(x))}</p><p class="muted small">${x.start_date ? `${fmt(x.start_date)}${x.end_date && x.end_date !== x.start_date ? " – " + fmt(x.end_date) : ""}` : "Noch ohne Datum"}</p>`}
        ${x.note ? `<p class="small tr-note">${escapeHtml(x.note)}</p>` : ""}
        ${items.length ? `<div class="tr-progress"><span style="width:${Math.round(done / items.length * 100)}%"></span></div><p class="muted small">${done} von ${items.length} gepackt</p>` : ""}
      </div>
      ${tr.docs.length ? `<h4 class="cal-sub">📄 Reiseunterlagen</h4><ul class="ar-list">${tr.docs.map(d => `<li><button class="ar-doc" data-tr-doc="${d.id}">
          <span class="ar-icon">📄</span><span class="ar-main"><span class="ar-title">${escapeHtml(d.title)}</span><span class="ar-sub">${escapeHtml(d.file_name)}</span></span></button></li>`).join("")}</ul>` : ""}
      <h4 class="cal-sub">🎒 Packliste</h4>
      ${sections.map(s => `${s ? `<p class="tr-section">${escapeHtml(s)}</p>` : ""}<ul class="tr-list">${items.filter(i => (i.section || "") === s).map(itemRow).join("")}</ul>`).join("") || `<p class="muted small">Noch nichts auf der Liste.</p>`}
      <form id="form-tr-item" class="tr-add" autocomplete="off">
        <input type="text" name="text" maxlength="120" placeholder="z. B. Sonnencreme" aria-label="Neuer Eintrag" required>
        <input type="text" name="section" maxlength="40" placeholder="Bereich" aria-label="Bereich (z. B. Bad, Kleidung)" list="tr-sections" value="${escapeHtml(tr.lastSection || "")}">
        <datalist id="tr-sections">${["Kleidung", "Bad", "Technik", "Dokumente", "Apotheke", "Kinder", "Sonstiges", ...sections].filter((v, i, a) => v && a.indexOf(v) === i).map(s => `<option value="${escapeHtml(s)}">`).join("")}</datalist>
        <button type="submit" class="btn btn-small">+</button>
      </form>
      <div class="btn-row tr-actions">
        ${templates.length && !x.is_template ? `<select id="tr-template" aria-label="Vorlage übernehmen"><option value="">📋 Vorlage übernehmen …</option>${templates.map(t => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("")}</select>` : ""}
        ${items.length && !x.is_template ? `<button type="button" class="btn btn-small" id="btn-tr-save-template">Als Vorlage speichern</button>` : ""}
        ${done ? `<button type="button" class="link" id="btn-tr-reset">Alle Haken entfernen</button>` : ""}
      </div>
      <p class="small"><button type="button" class="link" id="btn-tr-back">‹ Alle Reisen</button></p>`;
  }

  function render() {
    if (!tr.active) return;
    $("#btn-tr-add").hidden = !!tr.openId;
    if (tr.openId) renderTrip(); else renderList();
  }

  async function openTrip(id) {
    tr.openId = id;
    try {
      await loadItems(id);
      await loadDocs(tr.trips.find(t => t.id === id));
    } catch (err) { toast(sqlHint(err), true); }
    render();
    subscribe();
  }

  function subscribe() {
    if (tr.channel) { sb.removeChannel(tr.channel); tr.channel = null; }
    if (!tr.openId) return;
    tr.channel = sb.channel("trip-" + tr.openId)
      .on("postgres_changes", { event: "*", schema: "public", table: "trip_items", filter: `trip_id=eq.${tr.openId}` }, async () => {
        try { await loadItems(tr.openId); render(); } catch { /* egal */ }
      }).subscribe();
  }

  // ---------- Bearbeiten ----------
  async function openEdit(trip, asTemplate = false) {
    tr.editing = trip;
    if (!tr.tags.length) await loadTags();
    const f = $("#form-trip");
    f.reset();
    f.title.value = trip ? trip.title : "";
    f.start_date.value = trip ? trip.start_date || "" : "";
    f.end_date.value = trip ? trip.end_date || "" : "";
    f.note.value = trip ? trip.note || "" : "";
    f.is_private.checked = trip ? trip.is_private : false;
    f.is_private.disabled = !!trip && trip.created_by !== me();
    f.is_template.checked = trip ? trip.is_template : asTemplate;
    f.tag_id.innerHTML = `<option value="">– keine –</option>` + tr.tags.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    f.tag_id.value = trip && trip.tag_id ? trip.tag_id : "";
    const templates = tr.trips.filter(t => t.is_template);
    $("#trip-from-row").hidden = !!trip || !templates.length;
    f.from_template.innerHTML = `<option value="">– leere Liste –</option>` + templates.map(t => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("");
    $("#trip-sheet-title").textContent = trip ? "Reise bearbeiten" : "Neue Reise";
    $("#btn-trip-delete").hidden = !trip;
    openSheet("sheet-trip");
  }

  async function copyItems(fromId, toId) {
    const { data, error } = await sb.from("trip_items").select("text, section, sort").eq("trip_id", fromId);
    if (error) throw error;
    const have = new Set(tr.openId === toId ? tr.items.map(i => i.text.toLowerCase()) : []);
    const rows = (data || []).filter(i => !have.has(i.text.toLowerCase())).map((i, n) => ({ trip_id: toId, household_id: hid(), text: i.text, section: i.section, sort: i.sort ?? n }));
    if (rows.length) {
      const { error: e2 } = await sb.from("trip_items").insert(rows);
      if (e2) throw e2;
    }
    return rows.length;
  }

  $("#form-trip").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const row = {
        title: f.title.value.trim().slice(0, 120),
        start_date: f.is_template.checked ? null : (f.start_date.value || null),
        end_date: f.is_template.checked ? null : (f.end_date.value || f.start_date.value || null),
        note: f.note.value.trim().slice(0, 2000),
        tag_id: f.tag_id.value || null,
        is_template: f.is_template.checked
      };
      if (!row.title) throw new Error("Bitte einen Namen eingeben.");
      if (row.start_date && row.end_date && row.end_date < row.start_date) throw new Error("Das Ende liegt vor dem Anfang.");
      if (!f.is_private.disabled) row.is_private = f.is_private.checked;
      let id = tr.editing && tr.editing.id;
      if (id) {
        const { error } = await sb.from("trips").update({ ...row, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw new Error(sqlHint(error));
      } else {
        const { data, error } = await sb.from("trips").insert({ ...row, household_id: hid() }).select("id").single();
        if (error) throw new Error(sqlHint(error));
        id = data.id;
        if (f.from_template.value) await copyItems(f.from_template.value, id);
      }
      closeSheets();
      await loadTrips();
      await openTrip(id);
    });
  });

  $("#btn-trip-delete").addEventListener("click", async () => {
    const x = tr.editing;
    if (!x || !confirm(`„${x.title}“ mit Packliste löschen?`)) return;
    const { error } = await sb.from("trips").delete().eq("id", x.id);
    if (error) { toast(sqlHint(error), true); return; }
    closeSheets();
    tr.openId = null;
    await loadTrips();
    render();
  });

  // ---------- Klicks ----------
  $("#view-trips").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "btn-tr-add") { openEdit(null); return; }
    if (b.dataset.trip) { location.hash = "#/urlaub/" + b.dataset.trip; return; }
    if (b.id === "btn-tr-back") { location.hash = "#/urlaub"; return; }
    if (b.id === "btn-tr-edit") { openEdit(tr.trips.find(t => t.id === tr.openId)); return; }
    if (b.dataset.trDoc) { if (PP.archiveDoc) PP.archiveDoc.preview(b.dataset.trDoc, null); return; }
    if (b.dataset.trCheck) {
      const i = tr.items.find(x => x.id === b.dataset.trCheck);
      if (!i) return;
      i.is_done = !i.is_done;
      render();
      const { error } = await sb.from("trip_items").update({ is_done: i.is_done }).eq("id", i.id);
      if (error) toast(sqlHint(error), true);
      return;
    }
    if (b.dataset.trWho) {
      // reihum: niemand → Person 1 → Person 2 … → niemand
      const i = tr.items.find(x => x.id === b.dataset.trWho);
      const ids = (state.members || []).map(m => m.id);
      const next = i.who ? ids[ids.indexOf(i.who) + 1] || null : ids[0] || null;
      i.who = next;
      render();
      const { error } = await sb.from("trip_items").update({ who: next }).eq("id", i.id);
      if (error) toast(sqlHint(error), true);
      return;
    }
    if (b.dataset.trDel) {
      tr.items = tr.items.filter(x => x.id !== b.dataset.trDel);
      render();
      const { error } = await sb.from("trip_items").delete().eq("id", b.dataset.trDel);
      if (error) toast(sqlHint(error), true);
      return;
    }
    if (b.id === "btn-tr-reset") {
      if (!confirm("Alle Haken entfernen (z. B. für die Rückreise)?")) return;
      tr.items.forEach(i => { i.is_done = false; });
      render();
      const { error } = await sb.from("trip_items").update({ is_done: false }).eq("trip_id", tr.openId);
      if (error) toast(sqlHint(error), true);
      return;
    }
    if (b.id === "btn-tr-save-template") {
      const x = tr.trips.find(t => t.id === tr.openId);
      const name = prompt("Name der Vorlage:", x.title.replace(/\s*\d{4}\s*$/, "") || "Packliste");
      if (!name) return;
      const { data, error } = await sb.from("trips").insert({ household_id: hid(), title: name.slice(0, 120), is_template: true }).select("id").single();
      if (error) { toast(sqlHint(error), true); return; }
      const n = await copyItems(tr.openId, data.id).catch(err => { toast(sqlHint(err), true); return 0; });
      await loadTrips();
      toast(`Vorlage „${name}“ mit ${n} Einträgen gespeichert.`);
    }
  });

  $("#view-trips").addEventListener("change", async e => {
    if (e.target.id !== "tr-template" || !e.target.value) return;
    try {
      const n = await copyItems(e.target.value, tr.openId);
      await loadItems(tr.openId);
      render();
      toast(n ? `${n} Einträge aus der Vorlage übernommen.` : "Alles aus der Vorlage steht schon auf der Liste.");
    } catch (err) { toast(sqlHint(err), true); }
  });

  $("#view-trips").addEventListener("submit", async e => {
    if (e.target.id !== "form-tr-item") return;
    e.preventDefault();
    const f = e.target;
    const text = f.text.value.trim().slice(0, 120);
    if (!text) return;
    tr.lastSection = f.section.value.trim().slice(0, 40);
    const { data, error } = await sb.from("trip_items").insert({ trip_id: tr.openId, household_id: hid(), text, section: tr.lastSection, sort: tr.items.length }).select("*").single();
    if (error) { toast(sqlHint(error), true); return; }
    tr.items.push(data);
    render();
    const input = document.querySelector("#form-tr-item [name=text]");
    if (input) input.focus();
  });

  // ---------- Startseite ----------
  async function refreshTile() {
    const el = $("#tile-tr-status");
    if (!el) return;
    const { data, error } = await sb.from("trips").select("title, start_date, end_date").eq("household_id", hid()).eq("is_template", false)
      .gte("end_date", today()).order("start_date").limit(1);
    if (error || !data || !data.length) { el.textContent = "Packlisten"; return; }
    const x = data[0];
    el.textContent = `${countdown(x)}: ${x.title}`;
  }

  PP.modules.trips = {
    async enter() {
      tr.active = true;
      const id = PP.route && PP.route.base === "urlaub" ? PP.route.param : "";
      try { await loadTrips(); } catch (err) { toast(sqlHint(err), true); }
      if (id && tr.trips.some(t => t.id === id)) await openTrip(id);
      else { tr.openId = null; subscribe(); render(); }
    },
    leave() { tr.active = false; tr.openId = null; subscribe(); },
    async resume() { if (tr.active) { try { await loadTrips(); if (tr.openId) await loadItems(tr.openId); render(); } catch { /* egal */ } } },
    refreshTile,
    reset() { tr.trips = []; tr.items = []; tr.openId = null; }
  };
})();
