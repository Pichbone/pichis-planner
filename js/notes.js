// =========================================================
// Pichis Planner – Notizen
// Tags (gemeinsam mit dem Kalender), optionales Datum/Uhrzeit,
// angeheftet, privat, als Aufgabe übernehmen
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, memberName, openSheet, closeSheets } = PP;

  const MONTHS = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sep.", "Okt.", "Nov.", "Dez."];
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const TAG_COLORS = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];

  const nt = {
    active: false,
    notes: [],
    tags: [],
    tagFilter: storageGet("pp_note_tag") || "",
    query: "",
    channel: null,
    editing: null,        // null = neu, sonst ID
    draftTags: new Set(),
    loaded: false
  };

  const me = () => state.session.user.id;
  const pad = n => String(n).padStart(2, "0");
  function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function dateLabel(iso, time) {
    const [y, m, d] = iso.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const t = todayIso();
    const diff = Math.round((date - new Date(t + "T00:00:00")) / 86400000);
    let s;
    if (diff === 0) s = "Heute";
    else if (diff === 1) s = "Morgen";
    else if (diff === -1) s = "Gestern";
    else s = `${WD[date.getDay()]}, ${d}. ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? " " + y : ""}`;
    return time ? `${s}, ${String(time).slice(0, 5)}` : s;
  }

  function linkify(html) {
    return html.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  // ---------- Daten ----------
  async function loadAll() {
    const hid = state.household.id;
    const [n, t] = await Promise.all([
      sb.from("notes").select("*").eq("household_id", hid).order("updated_at", { ascending: false }),
      sb.from("event_tags").select("id, name, color").eq("household_id", hid).order("name")
    ]);
    if (n.error) throw n.error;
    if (t.error) throw t.error;
    nt.notes = n.data;
    nt.tags = t.data;
    nt.loaded = true;
    if (nt.tagFilter && !nt.tags.some(x => x.id === nt.tagFilter)) nt.tagFilter = "";
  }

  function upsertLocal(row) {
    const i = nt.notes.findIndex(x => x.id === row.id);
    if (i >= 0) nt.notes[i] = row; else nt.notes.unshift(row);
  }

  function subscribe() {
    unsubscribe();
    const hid = state.household.id;
    nt.channel = sb.channel("notes-" + hid)
      .on("postgres_changes", { event: "*", schema: "public", table: "notes", filter: `household_id=eq.${hid}` }, p => {
        if (p.eventType === "DELETE") nt.notes = nt.notes.filter(x => x.id !== (p.old && p.old.id));
        else upsertLocal(p.new);
        render();
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "notes" }, p => {
        nt.notes = nt.notes.filter(x => x.id !== (p.old && p.old.id));
        render();
      })
      .subscribe();
  }
  function unsubscribe() {
    if (nt.channel) { sb.removeChannel(nt.channel); nt.channel = null; }
  }

  // ---------- Darstellung ----------
  function tagChip(tag) {
    return `<span class="tag" style="--tag:${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>`;
  }

  function card(n) {
    const tags = n.tag_ids.map(id => nt.tags.find(t => t.id === id)).filter(Boolean);
    const preview = n.body.length > 260 ? n.body.slice(0, 260) + " …" : n.body;
    const meta = [];
    if (n.is_private) meta.push("🔒 privat");
    if (n.created_by !== me() && memberName(n.created_by)) meta.push("von " + escapeHtml(memberName(n.created_by)));
    const past = n.note_date && n.note_date < todayIso();
    return `<li><button class="note-card${n.is_pinned ? " pinned" : ""}" data-note="${n.id}">
      <span class="note-top">
        ${n.note_date ? `<span class="note-date${past ? " past" : ""}">📅 ${escapeHtml(dateLabel(n.note_date, n.note_time))}</span>` : ""}
        ${n.is_pinned ? `<span class="note-pin" title="Angeheftet">📌</span>` : ""}
      </span>
      ${n.title ? `<span class="note-title">${escapeHtml(n.title)}</span>` : ""}
      ${preview ? `<span class="note-body">${escapeHtml(preview)}</span>` : ""}
      ${tags.length ? `<span class="tag-row">${tags.map(tagChip).join("")}</span>` : ""}
      ${meta.length ? `<span class="note-meta">${meta.join(" · ")}</span>` : ""}
    </button></li>`;
  }

  function render() {
    if (!nt.active) return;

    // Tag-Filter
    const used = new Set(nt.notes.flatMap(n => n.tag_ids));
    const tags = nt.tags.filter(t => used.has(t.id));
    $("#note-tags").innerHTML = tags.length
      ? `<button class="chip${nt.tagFilter ? "" : " active"}" data-note-tag="">Alle</button>` +
        tags.map(t => `<button class="chip chip-tag${nt.tagFilter === t.id ? " active" : ""}" data-note-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : "";

    const q = nt.query.trim().toLowerCase();
    const list = nt.notes.filter(n =>
      (!nt.tagFilter || n.tag_ids.includes(nt.tagFilter)) &&
      (!q || (n.title + " " + n.body).toLowerCase().includes(q)));

    const t = todayIso();
    const pinned = list.filter(n => n.is_pinned);
    const rest = list.filter(n => !n.is_pinned);
    const upcoming = rest.filter(n => n.note_date && n.note_date >= t)
      .sort((a, b) => (a.note_date + (a.note_time || "")).localeCompare(b.note_date + (b.note_time || "")));
    const other = rest.filter(n => !n.note_date || n.note_date < t);

    const section = (title, items) => items.length
      ? `<section class="cat-group"><h3 class="cat-title">${title} <span class="cat-count">${items.length}</span></h3>
          <ul class="note-list">${items.map(card).join("")}</ul></section>` : "";

    const html = section("📌 Angeheftet", pinned) + section("📅 Mit Datum", upcoming) + section("Notizen", other);
    $("#note-items").innerHTML = html || `<div class="empty">
      <div class="empty-icon">📝</div>
      <p><strong>${nt.notes.length ? "Keine Notizen für diesen Filter." : "Noch keine Notizen."}</strong></p>
      <p class="muted small">Mit dem orangen + eine Notiz anlegen – optional mit Datum, dann erscheint sie im Kalender.</p>
    </div>`;
  }

  // ---------- Editor ----------
  function renderTagPicker() {
    $("#note-edit-tags").innerHTML = nt.tags.length
      ? nt.tags.map(t => `<button type="button" class="chip chip-tag${nt.draftTags.has(t.id) ? " active" : ""}" data-pick-note-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags – unten einen anlegen.</span>`;
  }

  function setDateUi() {
    const f = $("#form-note");
    const on = f.has_date.checked;
    $("#note-date-row").hidden = !on;
    if (on && !f.note_date.value) f.note_date.value = todayIso();
  }

  async function ensureLoaded() {
    if (!nt.loaded || !nt.tags.length) {
      const t = await sb.from("event_tags").select("id, name, color").eq("household_id", state.household.id).order("name");
      if (!t.error) nt.tags = t.data;
    }
  }

  async function openEditor(id, preset = {}) {
    await ensureLoaded();
    let n = id ? nt.notes.find(x => x.id === id) : null;
    if (id && !n) {
      const r = await sb.from("notes").select("*").eq("id", id).maybeSingle();
      if (r.error || !r.data) { toast("Notiz nicht gefunden.", true); return; }
      n = r.data;
      upsertLocal(n);
    }
    nt.editing = n ? n.id : null;
    nt.draftTags = new Set(n ? n.tag_ids : (preset.tag ? [preset.tag] : (nt.tagFilter ? [nt.tagFilter] : [])));

    const f = $("#form-note");
    f.reset();
    f.title.value = n ? n.title : "";
    f.body.value = n ? n.body : "";
    const date = n ? n.note_date : (preset.date || "");
    f.has_date.checked = !!date;
    f.note_date.value = date || "";
    f.note_time.value = n && n.note_time ? String(n.note_time).slice(0, 5) : "";
    f.is_pinned.checked = n ? n.is_pinned : false;
    f.is_private.checked = n ? n.is_private : false;
    f.is_private.disabled = !!(n && n.created_by !== me());
    setDateUi();
    renderTagPicker();
    $("#form-note-tag").reset();

    $("#note-sheet-title").textContent = n ? "Notiz" : "Neue Notiz";
    $("#btn-note-delete").hidden = !n;
    $("#btn-note-todo").hidden = false;
    $("#note-info").textContent = n
      ? `Zuletzt geändert ${new Date(n.updated_at).toLocaleString("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}${n.updated_by && n.updated_by !== me() && memberName(n.updated_by) ? " von " + memberName(n.updated_by) : ""}`
      : "";
    openSheet("sheet-note");
    autoGrow();
    if (!n) setTimeout(() => f.title.focus(), 60);
  }

  function autoGrow() {
    const el = $("#form-note").body;
    el.style.height = "auto";
    el.style.height = Math.min(Math.max(el.scrollHeight, 140), window.innerHeight * 0.45) + "px";
  }

  function formData() {
    const f = $("#form-note");
    const hasDate = f.has_date.checked && f.note_date.value;
    const row = {
      title: f.title.value.trim(),
      body: f.body.value.replace(/\s+$/, ""),
      tag_ids: [...nt.draftTags].filter(id => nt.tags.some(t => t.id === id)),
      note_date: hasDate ? f.note_date.value : null,
      note_time: hasDate && f.note_time.value ? f.note_time.value : null,
      is_pinned: f.is_pinned.checked
    };
    if (!f.is_private.disabled) row.is_private = f.is_private.checked;
    return row;
  }

  async function save() {
    const row = formData();
    if (!row.title && !row.body.trim()) throw new Error("Bitte einen Titel oder Text eingeben.");
    let res;
    if (nt.editing) {
      res = await sb.from("notes").update(row).eq("id", nt.editing).select().single();
    } else {
      res = await sb.from("notes").insert({ ...row, household_id: state.household.id, is_private: !!row.is_private }).select().single();
    }
    if (res.error) {
      if (/relation .*notes|does not exist/i.test(res.error.message)) throw new Error("Bitte zuerst das SQL aus Schritt 11 in Supabase ausführen.");
      throw res.error;
    }
    upsertLocal(res.data);
    nt.editing = res.data.id;
    if (PP.calendarRefreshExtras) PP.calendarRefreshExtras();
    return res.data;
  }

  $("#form-note").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const n = await save();
      closeSheets();
      render();
      toast(n.note_date ? `Gespeichert – im Kalender am ${dateLabel(n.note_date, n.note_time)}.` : "Notiz gespeichert.");
    });
  });

  $("#form-note").has_date.addEventListener("change", setDateUi);
  $("#form-note").body.addEventListener("input", autoGrow);

  $("#sheet-note").addEventListener("click", e => {
    const b = e.target.closest("[data-pick-note-tag]");
    if (!b) return;
    const id = b.dataset.pickNoteTag;
    nt.draftTags.has(id) ? nt.draftTags.delete(id) : nt.draftTags.add(id);
    renderTagPicker();
  });

  $("#form-note-tag").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const name = f.name.value.trim();
      if (!name) return;
      const existing = nt.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        nt.draftTags.add(existing.id);
      } else {
        const { data, error } = await sb.from("event_tags").insert({
          household_id: state.household.id,
          name,
          color: TAG_COLORS[nt.tags.length % TAG_COLORS.length]
        }).select("id, name, color").single();
        if (error) throw error;
        nt.tags.push(data);
        nt.tags.sort((a, b) => a.name.localeCompare(b.name));
        nt.draftTags.add(data.id);
      }
      f.reset();
      renderTagPicker();
    });
  });

  $("#btn-note-delete").addEventListener("click", async () => {
    const n = nt.notes.find(x => x.id === nt.editing);
    if (!n || !confirm(`Notiz${n.title ? " „" + n.title + "“" : ""} löschen?`)) return;
    const { error } = await sb.from("notes").delete().eq("id", n.id);
    if (error) { toast(translateError(error), true); return; }
    nt.notes = nt.notes.filter(x => x.id !== n.id);
    closeSheets();
    render();
    if (PP.calendarRefreshExtras) PP.calendarRefreshExtras();
  });

  // Notiz als Aufgabe übernehmen (Notiz bleibt erhalten)
  $("#btn-note-todo").addEventListener("click", async () => {
    const btn = $("#btn-note-todo");
    const row = formData();
    const title = row.title || row.body.trim().split("\n")[0].slice(0, 200);
    if (!title) { toast("Bitte zuerst einen Titel oder Text eingeben.", true); return; }
    btn.disabled = true;
    try {
      // Notiz vorher speichern, damit nichts verloren geht
      await save();
      const notesText = row.title ? row.body.trim().slice(0, 2000) : row.body.trim().split("\n").slice(1).join("\n").slice(0, 2000);
      const { data, error } = await sb.from("todos").insert({
        household_id: state.household.id,
        title,
        notes: notesText,
        due_date: row.note_date,
        due_time: row.note_time,
        is_private: !!(row.is_private ?? false),
        ...(row.tag_ids.length ? { tag_ids: row.tag_ids } : {})
      }).select().single();
      if (error) throw error;
      closeSheets();
      render();
      toast(data.due_date ? `Aufgabe angelegt (fällig ${dateLabel(data.due_date, data.due_time)}).` : "Aufgabe angelegt – die Notiz bleibt erhalten.");
    } catch (err) {
      toast(translateError(err), true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Ansicht ----------
  $("#view-notes").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.note) { openEditor(t.dataset.note); return; }
    if (t.dataset.noteTag !== undefined) {
      nt.tagFilter = t.dataset.noteTag;
      storageSet("pp_note_tag", nt.tagFilter);
      render();
      return;
    }
    if (t.id === "btn-note-add") openEditor(null);
  });

  $("#note-search").addEventListener("input", e => { nt.query = e.target.value; render(); });

  // ---------- Kachel ----------
  async function refreshTile() {
    if (!state.household) return;
    const { count, error } = await sb.from("notes")
      .select("id", { count: "exact", head: true })
      .eq("household_id", state.household.id)
      .eq("note_date", todayIso());
    if (error) { $("#tile-note-status").textContent = "Öffnen"; return; }
    $("#tile-note-status").textContent = count ? `${count} für heute` : "Öffnen";
  }

  PP.notes = {
    open: id => openEditor(id),
    create: preset => openEditor(null, preset || {})
  };

  PP.modules.notes = {
    async enter() {
      nt.active = true;
      try {
        await loadAll();
        render();
        subscribe();
      } catch (err) {
        console.error(err);
        toast(/relation .*notes|does not exist/i.test(err.message || "") ? "Bitte zuerst das SQL aus Schritt 11 in Supabase ausführen." : translateError(err), true);
      }
    },
    leave() {
      nt.active = false;
      unsubscribe();
      closeSheets();
    },
    async resume() {
      if (nt.active) {
        try { await loadAll(); render(); subscribe(); } catch (err) { console.error(err); }
      } else {
        refreshTile();
      }
    },
    refreshTile,
    reset() {
      this.leave();
      nt.notes = [];
      nt.tags = [];
      nt.loaded = false;
    }
  };
})();
