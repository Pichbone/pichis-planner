// =========================================================
// Pichis Planner – Bücher
// Bibliothek aus einem HiDrive-Ordner (Standard „Buecher“), Cover und
// Angaben aus den EPUB-Dateien, „An Kindle senden“ per Mail.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, openSheet, closeSheets } = PP;
  const cfg = window.PP_CONFIG || {};
  const KINDLE_OK = ["epub", "pdf", "docx", "doc", "txt", "rtf"];
  const COLORS = ["#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#C2410C", "#4B5563"];

  const bk = {
    active: false, books: [], covers: new Map(), query: "", sort: storageGet("pp_bk_sort") || "new",
    syncing: false, progress: null, open: null, folder: "",
    reads: new Map(),                                  // book_id → gelesen am (nur eigene)
    readFilter: storageGet("pp_bk_read") || ""          // "" | "unread" | "read"
  };
  const hid = () => state.household.id;
  const isOwner = () => state.role === "owner";

  function sqlHint(err) {
    const m = (err && err.message) || "";
    return /books|kindle_email|books_folder|does not exist|schema cache/.test(m) ? "Bitte zuerst das SQL aus Schritt 41 in Supabase ausführen." : translateError(err);
  }

  // ---------- Daten ----------
  async function loadBooks() {
    const rows = [];
    for (let off = 0; off < 20000; off += 1000) {
      const { data, error } = await sb.from("books").select("id, file_name, size, modified, format, title, author, series, series_index, description, cover_path, sent_at, created_at")
        .eq("household_id", hid()).range(off, off + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    bk.books = rows;
    const r = await sb.from("book_reads").select("book_id, read_at");
    bk.reads = new Map(r.error ? [] : r.data.map(x => [x.book_id, x.read_at]));
    await signCovers();
  }

  async function signCovers() {
    const need = bk.books.map(b => b.cover_path).filter(p => p && !bk.covers.has(p));
    for (let i = 0; i < need.length; i += 100) {
      const { data } = await sb.storage.from("household-files").createSignedUrls(need.slice(i, i + 100), 7 * 86400);
      for (const x of data || []) if (x.signedUrl) bk.covers.set(x.path, x.signedUrl);
    }
  }

  async function call(action, payload = {}) {
    const { data, error } = await sb.functions.invoke("hidrive", { body: { action, ...payload } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
      throw new Error(msg);
    }
    return data;
  }

  // Ordner abgleichen und EPUBs in Portionen auslesen
  async function sync(force) {
    if (bk.syncing) return;
    const last = +storageGet("pp_bk_sync") || 0;
    if (!force && Date.now() - last < 5 * 60000 && bk.books.length) return;
    bk.syncing = true;
    try {
      for (let round = 0; round < 60; round++) {
        const r = await call("books_sync");
        bk.folder = r.folder;
        bk.progress = r.pending ? { done: r.total - r.pending, total: r.total } : null;
        await loadBooks();
        render();
        if (!r.pending) break;
      }
      storageSet("pp_bk_sync", String(Date.now()));
    } catch (err) {
      bk.progress = null;
      toast(err.message, true);
      if (!bk.books.length) $("#bk-items").innerHTML = `<p class="muted cal-empty">${escapeHtml(err.message)}</p>`;
    } finally {
      bk.syncing = false;
      bk.progress = null;
      render();
      refreshTile();
    }
  }

  // ---------- Anzeige ----------
  const colorOf = s => COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  function coverHtml(b, big) {
    const url = b.cover_path && bk.covers.get(b.cover_path);
    if (url) return `<img class="bk-cover${big ? " big" : ""}" src="${escapeHtml(url)}" alt="" loading="lazy">`;
    return `<span class="bk-cover bk-fake${big ? " big" : ""}" style="--bk:${colorOf(b.title || b.file_name)}">
      <b>${escapeHtml((b.title || b.file_name).slice(0, 60))}</b>${b.author ? `<small>${escapeHtml(b.author.slice(0, 40))}</small>` : ""}</span>`;
  }

  function sorted(list) {
    const by = {
      new: (a, b) => String(b.modified || b.created_at).localeCompare(String(a.modified || a.created_at)),
      title: (a, b) => (a.title || a.file_name).localeCompare(b.title || b.file_name, "de", { numeric: true }),
      author: (a, b) => (a.author || "~").localeCompare(b.author || "~", "de") || (a.series || "").localeCompare(b.series || "", "de") || (a.series_index || 0) - (b.series_index || 0) || (a.title || "").localeCompare(b.title || "", "de"),
      series: (a, b) => (a.series ? 0 : 1) - (b.series ? 0 : 1) || (a.series || "").localeCompare(b.series || "", "de") || (a.series_index || 0) - (b.series_index || 0)
    };
    return [...list].sort(by[bk.sort] || by.new);
  }

  function render() {
    if (!bk.active) return;
    $("#bk-sort").innerHTML = [["new", "Neu"], ["title", "Titel"], ["author", "Autor"], ["series", "Reihe"]]
      .map(([k, l]) => `<button class="chip${bk.sort === k ? " active" : ""}" data-bk-sort="${k}">${l}</button>`).join("");
    const q = bk.query.trim().toLowerCase();
    $("#bk-readf").innerHTML = [["", "Alle"], ["unread", "Ungelesen"], ["read", "✓ Gelesen"]]
      .map(([k, l]) => `<button class="chip${bk.readFilter === k ? " active" : ""}" data-bk-read="${k}">${l}</button>`).join("");
    const list = sorted(bk.books
      .filter(b => !bk.readFilter || (bk.readFilter === "read") === bk.reads.has(b.id))
      .filter(b => !q || [b.title, b.author, b.series, b.file_name].some(x => String(x || "").toLowerCase().includes(q))));
    $("#bk-status").textContent = bk.progress
      ? `📖 Bücher werden eingelesen … ${bk.progress.done} von ${bk.progress.total}`
      : bk.syncing ? "🔄 Ordner wird abgeglichen …" : (bk.books.length ? `${bk.books.length} Bücher${q ? ` · ${list.length} gefunden` : ""}` : "");
    $("#bk-items").innerHTML = list.length
      ? `<ul class="bk-grid">${list.map(b => `<li><button class="bk-item${bk.reads.has(b.id) ? " is-read" : ""}" data-bk="${b.id}">
          <span class="bk-wrap">${coverHtml(b)}${bk.reads.has(b.id) ? `<span class="bk-read-badge" title="Gelesen">✓</span>` : ""}</span>
          <span class="bk-title">${escapeHtml(b.title || b.file_name)}</span>
          <span class="bk-author">${escapeHtml(b.author || "")}${b.series ? ` · ${escapeHtml(b.series)}${b.series_index ? " " + escapeHtml(String(b.series_index).replace(".", ",")) : ""}` : ""}</span>
        </button></li>`).join("")}</ul>`
      : (bk.syncing ? `<p class="muted cal-empty">Wird geladen …</p>` : `<div class="empty"><div class="empty-icon">📚</div><p><strong>${bk.books.length ? "Nichts gefunden." : "Noch keine Bücher."}</strong></p>
          <p class="muted small">Lege EPUB- oder PDF-Dateien in HiDrive in den Ordner „${escapeHtml((bk.folder || "Buecher").split("/").pop())}“ – sie erscheinen hier automatisch.</p></div>`);
    renderSettings();
  }

  function renderSettings() {
    const f = $("#form-bk-settings");
    if (!f || f.dataset.filled) return;
    f.kindle.value = (state.profile && state.profile.kindle_email) || "";
    f.folder.value = (state.household && state.household.books_folder) || "Buecher";
    $("#bk-folder-row").hidden = !isOwner();
    f.dataset.filled = "1";
  }

  function openBook(id) {
    const b = bk.books.find(x => x.id === id);
    if (!b) return;
    bk.open = b;
    const fmt = (b.format || "").toLowerCase();
    const ok = KINDLE_OK.includes(fmt);
    $("#bk-detail").innerHTML = `<div class="bk-detail-head">${coverHtml(b, true)}
        <div><h3>${escapeHtml(b.title || b.file_name)}</h3>
        ${b.author ? `<p class="bk-d-author">${escapeHtml(b.author)}</p>` : ""}
        ${b.series ? `<p class="muted small">📚 ${escapeHtml(b.series)}${b.series_index ? ", Band " + escapeHtml(String(b.series_index).replace(".", ",")) : ""}</p>` : ""}
        <p class="muted small">${escapeHtml(fmt.toUpperCase())} · ${(b.size / 1048576).toFixed(1).replace(".", ",")} MB</p>
        ${b.sent_at ? `<p class="muted small">✓ zuletzt an Kindle gesendet am ${new Date(b.sent_at).toLocaleDateString("de-DE")}</p>` : ""}</div></div>
      ${b.description ? `<p class="bk-desc">${escapeHtml(b.description)}</p>` : ""}
      ${ok ? "" : `<p class="small nutri-stale">${escapeHtml(fmt.toUpperCase())} nimmt Amazon per Mail nicht an – in Calibre als EPUB speichern.</p>`}
      ${b.size > 35 * 1048576 ? `<p class="small nutri-stale">Über 35 MB – zu groß für den Versand per Mail.</p>` : ""}`;
    $("#btn-bk-kindle").disabled = !ok || b.size > 35 * 1048576;
    paintReadBtn();
    openSheet("sheet-book");
  }

  // ---------- Klicks ----------
  $("#view-books").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.bk) { openBook(b.dataset.bk); return; }
    if (b.dataset.bkRead !== undefined) { bk.readFilter = b.dataset.bkRead; storageSet("pp_bk_read", bk.readFilter); render(); return; }
    if (b.dataset.bkSort) { bk.sort = b.dataset.bkSort; storageSet("pp_bk_sort", bk.sort); render(); return; }
    if (b.id === "btn-bk-refresh") sync(true);
  });
  $("#bk-search").addEventListener("input", e => { bk.query = e.target.value; render(); });

  $("#btn-bk-kindle").addEventListener("click", async () => {
    const b = bk.open;
    if (!b) return;
    const to = state.profile && state.profile.kindle_email;
    if (!to) { closeSheets(); toast("Bitte zuerst unten deine Kindle-Adresse eintragen.", true); $("#form-bk-settings").kindle.focus(); return; }
    const btn = $("#btn-bk-kindle");
    btn.disabled = true;
    btn.textContent = "📤 Wird gesendet …";
    try {
      const { data, error } = await sb.functions.invoke("digest", { body: { action: "kindle_send", book_id: b.id } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
        throw new Error(msg);
      }
      b.sent_at = new Date().toISOString();
      closeSheets();
      toast(`„${b.title || b.file_name}“ ist unterwegs zu ${data.to}. Auf dem Kindle erscheint es in wenigen Minuten.`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "📤 An Kindle senden";
    }
  });

  // ---------- Gelesen (je Person) ----------
  function paintReadBtn() {
    const b = bk.open, at = b && bk.reads.get(b.id);
    $("#btn-bk-read").textContent = at ? `✓ Gelesen (${new Date(at).toLocaleDateString("de-DE")})` : "☐ Als gelesen markieren";
    $("#btn-bk-read").classList.toggle("btn-primary", !!at);
  }
  $("#btn-bk-read").addEventListener("click", async () => {
    const b = bk.open;
    if (!b) return;
    const was = bk.reads.get(b.id);
    if (was) bk.reads.delete(b.id); else bk.reads.set(b.id, new Date().toISOString());
    paintReadBtn(); render();
    const { error } = was
      ? await sb.from("book_reads").delete().eq("book_id", b.id).eq("user_id", state.session.user.id)
      : await sb.from("book_reads").insert({ book_id: b.id });
    if (error) {
      if (was) bk.reads.set(b.id, was); else bk.reads.delete(b.id);
      paintReadBtn(); render();
      toast(sqlHint(error), true);
    }
  });

  $("#btn-bk-download").addEventListener("click", async () => {
    const b = bk.open;
    if (!b) return;
    const btn = $("#btn-bk-download");
    btn.disabled = true;
    try {
      const { data: s } = await sb.auth.getSession();
      const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/hidrive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.session.access_token}`, apikey: cfg.SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "book_fetch", book_id: b.id })
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Laden fehlgeschlagen (${res.status}).`); }
      const blob = await res.blob();
      const file = new File([blob], b.file_name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: b.title }); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = b.file_name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      toast(err.message, true);
    } finally { btn.disabled = false; }
  });

  $("#form-bk-settings").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const kindle = f.kindle.value.trim().toLowerCase();
      if (kindle && !/^[^@\s]+@(free\.)?kindle\.com$/.test(kindle)) throw new Error("Die Kindle-Adresse endet auf @kindle.com (steht im Amazon-Konto unter „Geräte“).");
      const { error } = await sb.from("profiles").update({ kindle_email: kindle }).eq("id", state.session.user.id);
      if (error) throw new Error(sqlHint(error));
      state.profile.kindle_email = kindle;
      if (isOwner()) {
        const folder = f.folder.value.trim().replace(/\/+$/, "") || "Buecher";
        if (folder !== (state.household.books_folder || "Buecher")) {
          const { error: e2 } = await sb.from("households").update({ books_folder: folder }).eq("id", hid());
          if (e2) throw new Error(sqlHint(e2));
          state.household.books_folder = folder;
          sync(true);
        }
      }
      toast("Gespeichert.");
    });
  });

  // ---------- Startseite ----------
  async function refreshTile() {
    const el = $("#tile-bk-status");
    if (!el || !state.household) return;
    const { count, error } = await sb.from("books").select("id", { count: "exact", head: true }).eq("household_id", hid());
    el.textContent = error ? "HiDrive" : count ? `${count} Bücher` : "HiDrive";
  }

  PP.modules.books = {
    async enter() {
      bk.active = true;
      render();
      try {
        if (state.household && state.household.books_folder === undefined) {
          const { data } = await sb.from("households").select("books_folder").eq("id", hid()).maybeSingle();
          if (data) state.household.books_folder = data.books_folder;
        }
        await loadBooks();
      } catch (err) { toast(sqlHint(err), true); }
      render();
      const go = PP.takePending && PP.takePending("books");
      if (go) openBook(go.id);
      sync(false);
    },
    leave() { bk.active = false; },
    resume() { if (bk.active) sync(false); },
    refreshTile,
    reset() { bk.books = []; bk.covers = new Map(); }
  };
})();
