// =========================================================
// Pichis Planner – Neue Medien
// Songs, Alben, Filme, Serien, Bücher und Links
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, storageGet, storageSet, memberName, openSheet, closeSheets } = PP;

  const TYPES = {
    song:  { label: "Song",  plural: "Songs",  icon: "🎵", done: "gehört" },
    album: { label: "Album", plural: "Alben",  icon: "💿", done: "gehört" },
    film:  { label: "Film",  plural: "Filme",  icon: "🎬", done: "gesehen" },
    serie: { label: "Serie", plural: "Serien", icon: "📺", done: "gesehen" },
    buch:  { label: "Buch",  plural: "Bücher", icon: "📚", done: "gelesen" },
    link:  { label: "Link",  plural: "Links",  icon: "🔗", done: "erledigt" }
  };
  const MONTHS = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sep.", "Okt.", "Nov.", "Dez."];

  const md = {
    active: false,
    items: [],
    type: storageGet("pp_media_type") || "all",
    genre: "",
    showDone: false,
    channel: null,
    editingId: null,
    addType: storageGet("pp_media_addtype") || "film",
    picked: null      // ausgewählter Suchtreffer (Quelle, ID)
  };

  // ---------- Hilfen ----------
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addDaysIso(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    const x = new Date(y, m - 1, d + n);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  function dateText(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${d}. ${MONTHS[m - 1]} ${y}`;
  }
  function safeUrl(u) {
    return /^https?:\/\//i.test(u || "") ? u : "";
  }

  async function callMedia(action, payload) {
    const { data, error } = await sb.functions.invoke("media", { body: { action, ...payload } });
    if (error) {
      let msg = error.message, status = "";
      try {
        const res = error.context;
        status = res && res.status;
        const raw = await res.text();
        try { const j = JSON.parse(raw); msg = j.error || j.message || raw; } catch { if (raw) msg = raw.slice(0, 200); }
      } catch { /* keine Antwort */ }
      if (status === 404) msg = "Die Funktion „media“ wurde nicht gefunden. Bitte in Supabase mit genau diesem Namen anlegen.";
      throw new Error(msg);
    }
    return data;
  }

  // ---------- Daten ----------
  async function loadAll() {
    const { data, error } = await sb.from("media_items").select("*")
      .eq("household_id", state.household.id)
      .order("release_date", { ascending: true, nullsFirst: false });
    if (error) throw error;
    md.items = data;
  }

  function upsertLocal(row) {
    const i = md.items.findIndex(x => x.id === row.id);
    if (i >= 0) md.items[i] = row; else md.items.push(row);
  }

  function subscribe() {
    unsubscribe();
    const hid = state.household.id;
    md.channel = sb.channel("media-" + hid)
      .on("postgres_changes", { event: "*", schema: "public", table: "media_items", filter: `household_id=eq.${hid}` }, onChange)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "media_items" }, onChange)
      .subscribe();
  }
  function unsubscribe() {
    if (md.channel) { sb.removeChannel(md.channel); md.channel = null; }
  }
  function onChange(p) {
    if (p.eventType === "DELETE") md.items = md.items.filter(x => x.id !== (p.old && p.old.id));
    else upsertLocal(p.new);
    render();
  }

  // ---------- Darstellung ----------
  function visible() {
    return md.items.filter(x =>
      (md.type === "all" || x.type === md.type) &&
      (!md.genre || x.genre.toLowerCase() === md.genre.toLowerCase()) &&
      (md.showDone || !x.is_done));
  }

  function card(it) {
    const t = TYPES[it.type] || TYPES.link;
    const today = todayIso();
    let when = "";
    if (it.release_date) {
      if (it.release_date > today) {
        const days = Math.round((new Date(it.release_date) - new Date(today)) / 86400000);
        when = `<span class="media-soon">erscheint ${days === 1 ? "morgen" : days <= 14 ? `in ${days} Tagen` : "am " + dateText(it.release_date)}</span>`;
      } else if (it.release_date === today) {
        when = `<span class="media-soon">erscheint heute</span>`;
      } else {
        when = dateText(it.release_date);
      }
    }
    const tall = ["film", "serie", "buch"].includes(it.type);
    const img = safeUrl(it.image_url)
      ? `<img src="${escapeHtml(it.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="media-cover${tall ? " tall" : ""}">`
      : `<span class="media-cover media-cover-empty${tall ? " tall" : ""}">${t.icon}</span>`;
    const link = safeUrl(it.url)
      ? `<a class="icon-btn small media-open" href="${escapeHtml(it.url)}" target="_blank" rel="noopener" aria-label="Öffnen">↗</a>` : "";
    const by = it.added_by && it.added_by !== state.session.user.id && memberName(it.added_by)
      ? ` · von ${escapeHtml(memberName(it.added_by))}` : "";

    return `<li class="media-item${it.is_done ? " done" : ""}">
      <button class="media-main" data-edit="${it.id}">
        ${img}
        <span class="media-text">
          <span class="media-type">${t.icon} ${t.label}${it.genre ? " · " + escapeHtml(it.genre) : ""}</span>
          <span class="media-title">${escapeHtml(it.title)}</span>
          ${it.creator ? `<span class="media-sub">${escapeHtml(it.creator)}</span>` : ""}
          <span class="media-sub">${when}${by}</span>
          ${it.note ? `<span class="media-note">${escapeHtml(it.note)}</span>` : ""}
        </span>
      </button>
      <span class="media-actions">
        <button class="check-btn${it.is_done ? " on" : ""}" data-done="${it.id}" aria-label="${it.is_done ? "Nicht mehr" : "Als"} ${t.done} markieren" title="${t.done}">✓</button>
        ${link}
      </span>
    </li>`;
  }

  function render() {
    if (!md.active) return;

    // Medienart-Filter
    const counts = {};
    md.items.filter(x => !x.is_done).forEach(x => { counts[x.type] = (counts[x.type] || 0) + 1; });
    $("#media-types").innerHTML =
      `<button class="chip${md.type === "all" ? " active" : ""}" data-type="all">Alle</button>` +
      Object.entries(TYPES).map(([k, t]) =>
        `<button class="chip${md.type === k ? " active" : ""}" data-type="${k}">${t.icon} ${t.plural}${counts[k] ? ` <span class="chip-count">${counts[k]}</span>` : ""}</button>`).join("");

    // Genre-Auswahl
    const genres = [...new Set(md.items
      .filter(x => md.type === "all" || x.type === md.type)
      .map(x => x.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
    if (md.genre && !genres.some(g => g.toLowerCase() === md.genre.toLowerCase())) md.genre = "";
    $("#media-genre").innerHTML = `<option value="">Alle Genres</option>` +
      genres.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
    $("#media-genre").value = md.genre;
    $("#media-genre").hidden = !genres.length;
    $("#media-show-done").checked = md.showDone;
    $("#media-genres-dl").innerHTML = [...new Set(md.items.map(x => x.genre).filter(Boolean))]
      .map(g => `<option value="${escapeHtml(g)}"></option>`).join("");

    // Gruppen nach Datum
    const list = visible();
    const today = todayIso();
    const recentFrom = addDaysIso(today, -60);
    const groups = [
      ["Erscheint demnächst", list.filter(x => x.release_date && x.release_date >= today)
        .sort((a, b) => a.release_date.localeCompare(b.release_date))],
      ["Neu erschienen", list.filter(x => x.release_date && x.release_date < today && x.release_date >= recentFrom)
        .sort((a, b) => b.release_date.localeCompare(a.release_date))],
      ["Ohne Datum", list.filter(x => !x.release_date)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))],
      ["Früher erschienen", list.filter(x => x.release_date && x.release_date < recentFrom)
        .sort((a, b) => b.release_date.localeCompare(a.release_date))]
    ];

    const html = groups.filter(([, g]) => g.length).map(([title, g]) => `
      <section class="cat-group">
        <h3 class="cat-title">${title} <span class="cat-count">${g.length}</span></h3>
        <ul class="media-list">${g.map(card).join("")}</ul>
      </section>`).join("");

    $("#media-items").innerHTML = html || `<div class="empty">
      <div class="empty-icon">🎬</div>
      <p><strong>${md.items.length ? "Keine Treffer für diesen Filter." : "Noch keine Medien."}</strong></p>
      <p class="muted small">Mit dem orangen + einen Film, ein Album, ein Buch oder einen Link eintragen.</p>
    </div>`;
  }

  // ---------- Hinzufügen / Bearbeiten ----------
  function setAddType(type) {
    md.addType = type;
    storageSet("pp_media_addtype", type);
    $("#media-add-types").innerHTML = Object.entries(TYPES).map(([k, t]) =>
      `<button type="button" class="chip${k === type ? " active" : ""}" data-add-type="${k}">${t.icon} ${t.label}</button>`).join("");
    const isLink = type === "link";
    const f = $("#form-media-search");
    f.q.placeholder = isLink ? "Adresse einfügen, z. B. https://…" : `${TYPES[type].label} suchen, z. B. Titel oder Name`;
    f.q.type = isLink ? "url" : "search";
    $("#btn-media-search").textContent = isLink ? "Infos laden" : "Suchen";
    $("#media-results").innerHTML = "";
  }

  function fillForm(it) {
    const f = $("#form-media");
    f.title.value = it.title || "";
    f.creator.value = it.creator || "";
    f.release_date.value = it.release_date || "";
    f.genre.value = it.genre || "";
    f.url.value = it.url || "";
    f.note.value = it.note || "";
    f.image_url.value = it.image_url || "";
    f.description.value = it.description || "";
    const prev = $("#media-form-cover");
    prev.innerHTML = safeUrl(it.image_url) ? `<img src="${escapeHtml(it.image_url)}" alt="" referrerpolicy="no-referrer">` : "";
  }

  function openAdd() {
    md.editingId = null;
    md.picked = null;
    $("#media-sheet-title").textContent = "Medium hinzufügen";
    $("#media-search-block").hidden = false;
    $("#btn-media-delete").hidden = true;
    $("#form-media-search").reset();
    $("#form-media").reset();
    fillForm({});
    setAddType(md.type !== "all" ? md.type : md.addType);
    openSheet("sheet-media");
    setTimeout(() => $("#form-media-search").q.focus(), 50);
  }

  function openEdit(id) {
    const it = md.items.find(x => x.id === id);
    if (!it) return;
    md.editingId = id;
    md.picked = null;
    md.addType = it.type;
    $("#media-sheet-title").textContent = `${TYPES[it.type].icon} ${TYPES[it.type].label} bearbeiten`;
    $("#media-search-block").hidden = true;
    $("#btn-media-delete").hidden = false;
    $("#form-media").reset();
    fillForm(it);
    openSheet("sheet-media");
  }

  let lastResults = [];
  $("#form-media-search").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    const q = f.q.value.trim();
    if (!q) return;
    PP.withBusy(f, async () => {
      $("#media-results").innerHTML = `<p class="muted small">Suche läuft …</p>`;
      if (md.addType === "link") {
        const r = await callMedia("preview", { url: q });
        md.picked = { source: "link", source_id: "" };
        fillForm(r);
        if (r.type && r.type !== "link" && TYPES[r.type]) setAddType(r.type);
        $("#media-results").innerHTML = `<p class="muted small">Infos übernommen – unten prüfen und speichern.</p>`;
        return;
      }
      const data = await callMedia("search", { type: md.addType, q });
      lastResults = data.results || [];
      const sourceName = { apple: "Apple", tmdb: "TMDB", google_books: "Google Books" }[data.source] || "";
      $("#media-results").innerHTML = lastResults.length
        ? `<ul class="result-list">${lastResults.map((r, i) => `
            <li><button type="button" class="result" data-pick="${i}">
              ${safeUrl(r.image_url) ? `<img src="${escapeHtml(r.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="result-noimg">${TYPES[md.addType].icon}</span>`}
              <span class="result-text">
                <span class="result-title">${escapeHtml(r.title)}</span>
                <span class="result-sub">${escapeHtml([r.creator, r.release_date ? r.release_date.slice(0, 4) : "", r.genre].filter(Boolean).join(" · "))}</span>
              </span>
            </button></li>`).join("")}</ul>
           ${sourceName ? `<p class="muted small">Daten von ${sourceName}</p>` : ""}`
        : `<p class="muted small">Nichts gefunden. Du kannst die Angaben unten auch selbst eintragen.</p>`;
    });
  });

  $("#media-results").addEventListener("click", e => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    const r = lastResults[+b.dataset.pick];
    if (!r) return;
    md.picked = { source: r.source, source_id: r.source_id };
    fillForm(r);
    $("#media-results").innerHTML = `<p class="muted small">✓ „${escapeHtml(r.title)}“ übernommen – unten prüfen und speichern.</p>`;
    $("#form-media").title.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  $("#media-add-types").addEventListener("click", e => {
    const b = e.target.closest("[data-add-type]");
    if (b) setAddType(b.dataset.addType);
  });

  $("#form-media").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const row = {
        title: f.title.value.trim(),
        creator: f.creator.value.trim(),
        release_date: f.release_date.value || null,
        genre: f.genre.value.trim(),
        url: safeUrl(f.url.value.trim()),
        note: f.note.value.trim(),
        image_url: safeUrl(f.image_url.value.trim()),
        description: f.description.value.trim()
      };
      let res;
      if (md.editingId) {
        res = await sb.from("media_items").update(row).eq("id", md.editingId).select().single();
      } else {
        res = await sb.from("media_items").insert({
          ...row,
          household_id: state.household.id,
          type: md.addType,
          source: md.picked ? md.picked.source : "manuell",
          source_id: md.picked ? md.picked.source_id : ""
        }).select().single();
      }
      if (res.error) {
        if (/duplicate|unique/i.test(res.error.message)) throw new Error("Das steht schon in eurer Medienliste.");
        throw res.error;
      }
      upsertLocal(res.data);
      closeSheets();
      render();
      toast(md.editingId ? "Gespeichert." : `„${res.data.title}“ hinzugefügt.`);
    });
  });

  $("#btn-media-delete").addEventListener("click", async () => {
    const it = md.items.find(x => x.id === md.editingId);
    if (!it || !confirm(`„${it.title}“ aus der Liste entfernen?`)) return;
    const { error } = await sb.from("media_items").delete().eq("id", it.id);
    if (error) { toast(PP.translateError(error), true); return; }
    md.items = md.items.filter(x => x.id !== it.id);
    closeSheets();
    render();
  });

  // ---------- Klicks in der Ansicht ----------
  $("#view-media").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.type) {
      md.type = t.dataset.type;
      storageSet("pp_media_type", md.type);
      render();
      return;
    }
    if (t.id === "btn-media-add") { openAdd(); return; }
    if (t.dataset.edit) { openEdit(t.dataset.edit); return; }
    if (t.dataset.done) {
      const it = md.items.find(x => x.id === t.dataset.done);
      if (!it) return;
      const before = it.is_done;
      it.is_done = !before;
      render();
      const { data, error } = await sb.from("media_items").update({ is_done: !before }).eq("id", it.id).select().single();
      if (error) { it.is_done = before; render(); toast(PP.translateError(error), true); return; }
      upsertLocal(data);
      render();
    }
  });

  $("#media-genre").addEventListener("change", e => { md.genre = e.target.value; render(); });
  $("#media-show-done").addEventListener("change", e => { md.showDone = e.target.checked; render(); });

  // ---------- Kachel ----------
  async function refreshTile() {
    if (!state.household) return;
    const { count, error } = await sb.from("media_items")
      .select("id", { count: "exact", head: true })
      .eq("household_id", state.household.id)
      .eq("is_done", false)
      .gte("release_date", todayIso());
    if (error) return;
    $("#tile-media-status").textContent = count ? `${count} erscheinen demnächst` : "Öffnen";
  }

  PP.modules.media = {
    async enter() {
      md.active = true;
      try {
        await loadAll();
        render();
        subscribe();
      } catch (err) {
        console.error(err);
        toast(PP.translateError(err), true);
      }
    },
    leave() {
      md.active = false;
      unsubscribe();
      closeSheets();
    },
    async resume() {
      if (md.active) {
        try { await loadAll(); render(); subscribe(); } catch (err) { console.error(err); }
      } else {
        refreshTile();
      }
    },
    refreshTile,
    reset() {
      this.leave();
      md.items = [];
    }
  };
})();
