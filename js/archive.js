// =========================================================
// Pichis Planner – Dokumentenarchiv (Dateien in STRATO HiDrive)
// Ablegen mit Kategorie, Datum, Tags; PDF-Text wird für die Suche gelesen.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, cfg, $, toast, escapeHtml, translateError, storageGet, storageSet, openSheet, closeSheets } = PP;

  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const MAX_TEXT = 400000;
  const MAX_FILE = 100 * 1024 * 1024;
  const CATEGORIES = ["Verträge", "Versicherungen", "Rechnungen & Belege", "Steuer", "Bank & Finanzen", "Gesundheit", "Auto",
    "Haus & Wohnung", "Arbeit", "Schule & Ausbildung", "Ausweise & Urkunden", "Garantie & Anleitungen", "Sonstiges"];
  const TAG_COLORS = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];

  const ar = {
    active: false,
    status: null,
    docs: [],
    tags: [],
    filter: storageGet("pp_ar_filter") || "",
    tagFilter: storageGet("pp_ar_tag") || "",
    recipeLinks: new Map(),   // Archiv-Dokument → Rezept im Essensplan
    limit: 50,                // „Alle“: so viele Dokumente zeigen, dann „Weitere anzeigen“
    years: new Map(),         // Jahr → auf-/zugeklappt (von Hand)
    folders: [],          // Unterordner in HiDrive = Kategorien
    ai: storageGet("pp_ar_ai") !== "0",   // KI-Vorschläge beim Ablegen
    textCache: new Map(), // Datei → { text, pages } (schon ausgelesen)
    dirty: new Set(),     // Felder, die von Hand geändert wurden
    aiToken: 0,   // z. B. Person oder „Steuer 2026“
    query: "",
    results: null,
    editing: null,
    draftTags: new Set(),
    pending: [],          // ausgewählte Dateien beim Ablegen
    token: 0,
    channel: null
  };
  const me = () => state.session.user.id;
  const hid = () => state.household.id;

  // ---------- Server ----------
  async function call(action, payload = {}) {
    const { data, error } = await sb.functions.invoke("hidrive", { body: { action, ...payload } });
    if (error) {
      let msg = error.message || "Fehler";
      try {
        const res = error.context;
        if (res && res.status === 404 && !/Dokument|Datei/.test(msg)) msg = "Die Funktion „hidrive“ ist noch nicht eingerichtet.";
        const j = await res.json(); if (j && j.error) msg = j.error;
      } catch { /* keine JSON-Antwort */ }
      throw new Error(msg);
    }
    return data;
  }

  async function authHeaders() {
    const { data } = await sb.auth.getSession();
    return { Authorization: `Bearer ${data.session.access_token}`, apikey: cfg.SUPABASE_KEY };
  }

  // Dateiname nach Schema „2026-10-02 Elektro Müller – Rechnung Bad.pdf“
  // (gleiche Regeln wie in der Funktion „hidrive“ → fileNameFor)
  function fileNameFor(title, date, oldName) {
    const dot = oldName.lastIndexOf(".");
    const ext = dot > 0 && oldName.length - dot <= 6 ? oldName.slice(dot).toLowerCase() : "";
    const t = String(title || "").normalize("NFC").replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim().slice(0, 120).trim() || "Dokument";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? `${date} ` : "";
    return `${d}${t}${ext}`;
  }
  const isRecipeCat = c => /rezept/i.test(c || "");
  // Rezepte ohne Datum im Namen („Lasagne Bolognese.pdf“)
  const nameFor = (title, date, category, oldName) => fileNameFor(title, isRecipeCat(category) ? null : date, oldName);
  const sameName = (cur, want) => cur === want || cur.replace(/ \(\d+\)(\.[^.]*)?$/, "$1") === want;

  // „2026-10-02 Rechnung.pdf“, „20261002_Rechnung.pdf“, „02.10.2026 Rechnung.pdf“ → Datum + Titel
  function splitName(fileName) {
    let base = fileName.replace(/\.[^.]+$/, "");
    let date = null;
    let m = base.match(/^(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?=[\s_\-–]|$)[\s_\-–]*/);
    if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
    else if ((m = base.match(/^(\d{2})\.(\d{2})\.(\d{4})(?=[\s_\-–]|$)[\s_\-–]*/))) date = `${m[3]}-${m[2]}-${m[1]}`;
    if (date && isNaN(new Date(date + "T12:00:00"))) date = null;
    if (date) base = base.slice(m[0].length);
    const title = base.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
    return { date, title: title || fileName.replace(/\.[^.]+$/, "") };
  }

  async function uploadFile(file, folder, name = file.name) {
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/hidrive`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/octet-stream", "x-pp-action": "upload",
        "x-pp-name": encodeURIComponent(name), "x-pp-folder": encodeURIComponent(folder) },
      body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Hochladen fehlgeschlagen (${res.status}).`);
    return data;
  }

  async function downloadBlob(doc) {
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/hidrive`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "download", doc_id: doc.id })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Öffnen fehlgeschlagen (${res.status}).`);
    }
    return new Blob([await res.arrayBuffer()], { type: doc.mime || res.headers.get("content-type") || "application/octet-stream" });
  }

  // ---------- HiDrive verbinden (WebDAV, Benutzername + Passwort) ----------
  function openConnect() {
    const f = $("#form-hidrive");
    f.reset();
    f.username.value = (ar.status && ar.status.alias) || "";
    const folder = ar.status && ar.status.folder;
    f.folder.value = folder && ar.status.alias && folder.startsWith(`/users/${ar.status.alias}/`)
      ? folder.slice(`/users/${ar.status.alias}/`.length) : (folder || "Pichis Planner Archiv");
    openSheet("sheet-hidrive");
  }

  $("#form-hidrive").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const r = await call("connect", { username: f.username.value.trim(), password: f.password.value, folder: f.folder.value.trim() });
      f.password.value = "";
      ar.status = { ...(ar.status || {}), error: null, connected: true, alias: r.alias, folder: r.folder, can_manage: true };
      closeSheets();
      render(); renderFooter();
      toast(`HiDrive verbunden – Ordner „${r.folder.split("/").pop()}“ ist bereit.`);
    });
  });


  // ---------- Daten ----------
  const LIST_FIELDS = "id, title, category, doc_date, notes, tag_ids, file_name, size, mime, pages, has_text, is_private, created_by, created_at, updated_at";

  async function loadAll() {
    const [d, t] = await Promise.all([
      sb.from("archive_docs").select(LIST_FIELDS).eq("household_id", hid())
        .order("doc_date", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }),
      sb.from("event_tags").select("id, name, color").eq("household_id", hid()).order("name")
    ]);
    if (d.error) throw d.error;
    ar.docs = d.data;
    ar.tags = t.error ? [] : t.data;
    // Welche Rezept-Dokumente sind schon im Essensplan? (Schritt 35)
    const r = await sb.from("recipes").select("id, archive_doc_id").eq("household_id", hid()).not("archive_doc_id", "is", null);
    ar.recipeLinks = new Map(r.error ? [] : r.data.map(x => [x.archive_doc_id, x.id]));
  }

  function subscribe() {
    unsubscribe();
    ar.channel = sb.channel("archive-" + hid())
      .on("postgres_changes", { event: "*", schema: "public", table: "archive_docs", filter: `household_id=eq.${hid()}` }, () => reload())
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "archive_docs" }, p => {
        ar.docs = ar.docs.filter(x => x.id !== (p.old && p.old.id)); render();
      })
      .subscribe();
  }
  function unsubscribe() { if (ar.channel) { sb.removeChannel(ar.channel); ar.channel = null; } }
  let reloadTimer = null;
  function reload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(async () => { try { await loadAll(); render(); } catch { /* egal */ } }, 400); }

  // ---------- Darstellung ----------
  const fileIcon = m => /pdf/.test(m) ? "📕" : /^image\//.test(m) ? "🖼️" : /word|document|text/.test(m) ? "📝" : /sheet|excel|csv/.test(m) ? "📊" : "📄";
  const dateText = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" }) : "";
  function sizeText(b) {
    if (!b) return "";
    if (b < 1024) return b + " B";
    if (b < 1048576) return Math.round(b / 1024) + " KB";
    return (Math.round(b / 104857.6) / 10).toString().replace(".", ",") + " MB";
  }
  const tagChip = t => `<span class="tag" style="--tag:${escapeHtml(t.color)}">${escapeHtml(t.name)}</span>`;

  function row(d, snippet) {
    const tags = (d.tag_ids || []).map(id => ar.tags.find(t => t.id === id)).filter(Boolean);
    const sub = [d.category, dateText(d.doc_date), sizeText(d.size)].filter(Boolean).map(escapeHtml).join(" · ") + (ar.recipeLinks.has(d.id) ? " · 🍽️" : "");
    return `<li><button class="ar-doc" data-ar-doc="${d.id}">
      <span class="ar-icon">${fileIcon(d.mime || "")}</span>
      <span class="ar-main">
        <span class="ar-title">${escapeHtml(d.title)}${d.is_private ? ' <span class="muted">🔒</span>' : ""}</span>
        <span class="ar-sub">${sub}</span>
        ${snippet ? `<span class="wiki-snippet">${escapeHtml(snippet).replace(/«/g, "<mark>").replace(/»/g, "</mark>")}</span>` : ""}
        ${tags.length ? `<span class="tag-row">${tags.map(tagChip).join("")}</span>` : ""}
      </span>
    </button></li>`;
  }

  function renderStatus() {
    const s = ar.status;
    const box = $("#ar-status");
    if (!s) { box.innerHTML = ""; return; }
    if (s.error) {
      // Verbindung zu HiDrive konnte nicht geprüft werden – Grund dauerhaft anzeigen
      box.innerHTML = `<div class="banner banner-action">
        <div><strong>📂 HiDrive-Verbindung kann nicht geprüft werden</strong>
        <div class="small">${escapeHtml(s.error)}</div></div>
        <button class="btn btn-small" id="btn-ar-retry">Erneut</button>
      </div>`;
      $("#btn-ar-add").hidden = true;
      return;
    }
    if (!s.connected) {
      box.innerHTML = `<div class="banner banner-action">
        <div><strong>📂 Mit STRATO HiDrive verbinden</strong>
        <div class="small">${s.can_manage
          ? "Die Dokumente werden in deinem HiDrive im Ordner „Pichis Planner Archiv“ abgelegt. Dazu einmal den HiDrive-Benutzernamen und das Passwort eingeben (WebDAV)."
          : "Das Archiv muss einmal von der Verwaltung des Haushalts mit HiDrive verbunden werden."}</div></div>
        ${s.can_manage ? `<button class="btn btn-primary btn-small" id="btn-ar-connect">Verbinden</button>` : ""}
      </div>`;
    } else {
      box.innerHTML = "";
    }
    $("#btn-ar-add").hidden = !s.connected;
  }

  function render() {
    if (!ar.active) return;
    renderStatus();
    const cats = [...new Set(ar.docs.map(d => d.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
    if (ar.filter && !cats.includes(ar.filter)) ar.filter = "";
    $("#ar-chips").innerHTML = cats.length
      ? `<button class="chip${ar.filter ? "" : " active"}" data-ar-filter="">Alle</button>` +
        cats.map(c => `<button class="chip${ar.filter === c ? " active" : ""}" data-ar-filter="${escapeHtml(c)}">${escapeHtml(c)} <span class="chip-count">${ar.docs.filter(d => d.category === c).length}</span></button>`).join("")
      : "";

    if (ar.query.trim().length >= 2) {
      const r = ar.results;
      $("#ar-items").innerHTML = !r ? `<p class="muted cal-empty">Suche …</p>`
        : r.length ? `<ul class="ar-list">${r.map(h => row(ar.docs.find(d => d.id === h.id) || h, h.snippet)).join("")}</ul>`
        : `<p class="muted cal-empty">Nichts gefunden.</p>`;
      return;
    }
    // Tags, die im Archiv vorkommen (für Person, Steuerjahr usw.)
    const usedTags = ar.tags.filter(t => ar.docs.some(d => (d.tag_ids || []).includes(t.id)));
    if (ar.tagFilter && !usedTags.some(t => t.id === ar.tagFilter)) ar.tagFilter = "";
    // „Alle“ ohne Rezepte – die gibt es über ihren eigenen Chip
    const recipeCount = ar.filter ? 0 : ar.docs.filter(d => isRecipeCat(d.category)).length;
    const inCat = ar.filter ? ar.docs.filter(d => d.category === ar.filter) : ar.docs.filter(d => !isRecipeCat(d.category));
    $("#ar-tagchips").innerHTML = usedTags.length
      ? usedTags.map(t => `<button class="chip chip-tag${ar.tagFilter === t.id ? " active" : ""}" data-ar-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)} <span class="chip-count">${inCat.filter(d => (d.tag_ids || []).includes(t.id)).length}</span></button>`).join("")
      : "";
    const list = ar.tagFilter ? inCat.filter(d => (d.tag_ids || []).includes(ar.tagFilter)) : inCat;
    const openRecipes = isRecipeCat(ar.filter) ? list.filter(d => !ar.recipeLinks.has(d.id)).length : 0;
    const recipeHint = recipeCount
      ? `<p class="muted small ar-recipe-hint">🍽️ ${recipeCount} Rezept${recipeCount === 1 ? "" : "e"} findest du unter ${[...new Set(ar.docs.filter(d => isRecipeCat(d.category)).map(d => `„${escapeHtml(d.category)}“`))].join(", ")}.</p>` : "";
    $("#ar-items").innerHTML = list.length
      ? (openRecipes ? `<div class="ar-recipe-bar"><span>🍽️ ${openRecipes} Rezept${openRecipes === 1 ? "" : "e"} noch nicht im Essensplan</span><button class="btn btn-small" id="btn-ar-recipes-all">Alle übernehmen</button></div>` : "") +
        (isRecipeCat(ar.filter) ? recipeList(list) : yearList(list)) + recipeHint
      : recipeHint || (ar.status && ar.status.connected ? `<div class="empty"><div class="empty-icon">🗄️</div>
          <p><strong>Noch keine Dokumente.</strong></p>
          <p class="muted small">Mit dem orangen + Verträge, Rechnungen oder Bescheide ablegen. Der Text in PDFs wird automatisch durchsuchbar.</p></div>` : "");
  }

  // Rezepte: alphabetisch, ohne Jahre
  function recipeList(list) {
    return `<ul class="ar-list">${[...list].sort((a, b) => a.title.localeCompare(b.title, "de", { numeric: true })).map(d => row(d)).join("")}</ul>`;
  }

  // Nach Jahren gruppiert, ältere Jahre zugeklappt; in „Alle“ nur die neuesten ar.limit
  function yearList(list) {
    const groups = new Map();
    for (const d of list) {
      const y = d.doc_date ? d.doc_date.slice(0, 4) : "";
      if (!groups.has(y)) groups.set(y, []);
      groups.get(y).push(d);
    }
    const years = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : b.localeCompare(a)));
    const autoOpen = new Set(years.filter(y => y).slice(0, 2));   // die zwei neuesten Jahre
    const limited = !ar.filter && !ar.tagFilter;
    let left = limited ? ar.limit : Infinity, hidden = 0;
    const html = years.map(y => {
      const docs = groups.get(y);
      const open = ar.years.has(y) ? ar.years.get(y) : (autoOpen.has(y) || years.length === 1 || (y === "" && years.length <= 2));
      let items = "";
      if (open) {
        // von Hand aufgeklappte Jahre ganz zeigen, sonst bis zur Grenze
        const manual = ar.years.get(y) === true;
        const show = manual ? docs : docs.slice(0, Math.max(0, left));
        if (!manual) { left -= show.length; hidden += docs.length - show.length; }
        items = show.length ? `<ul class="ar-list">${show.map(d => row(d)).join("")}</ul>` : "";
      }
      return `<section class="ar-year">
        <button type="button" class="ar-year-head" data-ar-year="${y}" aria-expanded="${open}">
          <span class="ar-year-arrow">${open ? "▾" : "▸"}</span>
          <span class="ar-year-name">${y || "Ohne Datum"}</span>
          <span class="chip-count">${docs.length}</span>
        </button>${items}</section>`;
    }).join("");
    return html + (hidden ? `<button type="button" class="btn btn-secondary btn-block ar-more" id="btn-ar-more">Weitere anzeigen (${hidden})</button>` : "");
  }

  let searchTimer = null;
  $("#ar-search").addEventListener("input", e => {
    ar.query = e.target.value;
    clearTimeout(searchTimer);
    if (ar.query.trim().length < 2) { ar.results = null; render(); return; }
    ar.results = null;
    render();
    searchTimer = setTimeout(async () => {
      const token = ++ar.token;
      const { data, error } = await sb.rpc("archive_search", { p_household: hid(), p_query: ar.query.trim() });
      if (token !== ar.token) return;
      ar.results = (error || !data) ? ar.docs.filter(d => d.title.toLowerCase().includes(ar.query.toLowerCase())).map(d => ({ id: d.id, title: d.title, snippet: "" })) : data;
      // Treffer über Tag-Namen ergänzen (z. B. „Tim“ oder „Steuer 2026“)
      const q = ar.query.trim().toLowerCase();
      const tagIds = ar.tags.filter(t => t.name.toLowerCase().includes(q)).map(t => t.id);
      if (tagIds.length) {
        const have = new Set(ar.results.map(r => r.id));
        ar.results = ar.results.concat(ar.docs.filter(d => !have.has(d.id) && (d.tag_ids || []).some(id => tagIds.includes(id)))
          .map(d => ({ id: d.id, title: d.title, snippet: "" })));
      }
      render();
    }, 300);
  });

  // ---------- PDF-Text ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("PDF-Leser konnte nicht geladen werden."));
      document.head.appendChild(s);
    });
  }
  // ---------- Word (.docx) lesen – ohne Bibliothek ----------
  // .docx ist ein ZIP-Archiv; der Text steht in word/document.xml
  async function zipEntry(buf, wanted) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Keine gültige Word-Datei.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
      if (name === wanted) {
        const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
        const data = new Uint8Array(buf, start, csize);
        if (method === 0) return new TextDecoder().decode(data);
        if (method === 8) {
          const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
          return new TextDecoder().decode(out);
        }
        throw new Error("Unbekannte Komprimierung in der Word-Datei.");
      }
      p += 46 + nlen + elen + clen;
    }
    return null;
  }
  async function docxText(blob) {
    const xml = await zipEntry(await blob.arrayBuffer(), "word/document.xml");
    if (!xml) return "";
    return xml
      .replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>|<w:cr\/>/g, "\n").replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
  }
  const isDocx = (name, mime) => /\.docx$/i.test(name || "") || /wordprocessingml/.test(mime || "");
  const isPlain = (name, mime) => /^text\//.test(mime || "") || /\.(txt|md|csv)$/i.test(name || "");

  // Text aus PDF, Word oder Textdatei – { text, pages }
  async function extractText(blob, name, mime, progress = () => {}) {
    if (/pdf/i.test(mime || "") || /\.pdf$/i.test(name || "")) return pdfText(blob, progress);
    if (isDocx(name, mime)) return { text: await docxText(blob), pages: null };
    if (isPlain(name, mime) && blob.size < 2 * 1024 * 1024) return { text: (await blob.text()).slice(0, MAX_TEXT), pages: null };
    return { text: "", pages: null };
  }
  const canRead = (name, mime) => /pdf/i.test(mime || "") || /\.pdf$/i.test(name || "") || isDocx(name, mime) || isPlain(name, mime);

  async function pdfText(file, progress) {
    await loadScript(PDFJS);
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = "";
    for (let i = 1; i <= Math.min(pdf.numPages, 1000) && text.length < MAX_TEXT; i++) {
      progress(i, pdf.numPages);
      const tc = await (await pdf.getPage(i)).getTextContent();
      text += tc.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ") + "\n\n";
    }
    return { text: text.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT), pages: pdf.numPages };
  }

  // ---------- Kategorien = Unterordner in HiDrive ----------
  function catList() {
    const used = ar.docs.map(d => d.category).filter(Boolean);
    // Mit HiDrive-Ordnern: genau diese (plus schon benutzte), sonst die Vorschläge
    return [...new Set(ar.folders.length ? [...ar.folders, ...used] : [...used, ...CATEGORIES])].sort((a, b) => a.localeCompare(b, "de"));
  }
  function renderCats() {
    const cur = $("#form-ar").category.value.trim();
    const list = catList();
    $("#ar-cats").innerHTML = list.map(c => `<option value="${escapeHtml(c)}"></option>`).join("");
    $("#ar-cat-chips").innerHTML = list.map(c =>
      `<button type="button" class="chip${c === cur ? " active" : ""}" data-ar-cat="${escapeHtml(c)}">${ar.folders.includes(c) ? "📁 " : ""}${escapeHtml(c)}</button>`).join("");
  }
  async function loadFolders() {
    if (!(ar.status && ar.status.connected)) return;
    try { ar.folders = (await call("folders")).folders || []; } catch (err) { console.warn("Ordner:", err); }
  }
  $("#form-ar").category.addEventListener("input", renderCats);

  // ---------- Vorschau ----------
  let previewUrl = null, previewBack = null, previewToken = 0;
  async function showPreview(title, getBlob, mime, back) {
    const token = ++previewToken;
    previewBack = back;
    $("#arp-title").textContent = title;
    $("#btn-arp-back").hidden = !back;
    const body = $("#arp-body");
    body.innerHTML = `<p class="muted cal-empty">Vorschau wird geladen …</p>`;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    openSheet("sheet-ar-preview");
    try {
      const blob = await getBlob();
      if (token !== previewToken) return;
      const type = mime || blob.type || "";
      if (/^image\//.test(type) && !/heic/i.test(type)) {
        previewUrl = URL.createObjectURL(blob);
        body.innerHTML = `<img class="arp-img" src="${previewUrl}" alt="">`;
      } else if (/pdf/.test(type)) {
        await loadScript(PDFJS);
        const lib = window.pdfjsLib;
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const pdf = await lib.getDocument({ data: await blob.arrayBuffer() }).promise;
        const max = Math.min(pdf.numPages, 5);
        body.innerHTML = "";
        const width = Math.min(body.clientWidth || 360, 900);
        for (let i = 1; i <= max; i++) {
          if (token !== previewToken) return;
          const page = await pdf.getPage(i);
          const v1 = page.getViewport({ scale: 1 });
          const scale = (width / v1.width) * Math.min(window.devicePixelRatio || 1, 2);
          const vp = page.getViewport({ scale });
          const c = document.createElement("canvas");
          c.className = "arp-page";
          c.width = vp.width; c.height = vp.height;
          body.appendChild(c);
          await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        }
        if (pdf.numPages > max) body.insertAdjacentHTML("beforeend", `<p class="muted small">Vorschau zeigt die ersten ${max} von ${pdf.numPages} Seiten – „Öffnen“ zeigt alles.</p>`);
      } else if (/^text\//.test(type) && blob.size < 1024 * 1024) {
        body.innerHTML = `<pre class="arp-text">${escapeHtml(await blob.text())}</pre>`;
      } else {
        body.innerHTML = `<p class="muted cal-empty">Für diesen Dateityp gibt es keine Vorschau.${/heic/i.test(type) ? " (HEIC-Fotos kann der Browser nicht anzeigen.)" : ""}</p>`;
      }
    } catch (err) {
      if (token === previewToken) body.innerHTML = `<p class="muted cal-empty">${escapeHtml(err.message || "Vorschau nicht möglich.")}</p>`;
    }
  }
  $("#btn-arp-back").addEventListener("click", () => {
    previewToken++;
    if (previewBack) openSheet(previewBack); else closeSheets();
  });

  // ---------- KI: Angaben aus dem Inhalt vorschlagen ----------
  async function aiSuggest(text, fileName) {
    const { data, error } = await sb.functions.invoke("assist", { body: {
      action: "docmeta", text: text.slice(0, 20000), file_name: fileName,
      categories: catList(), tags: ar.tags.map(t => t.name)
    } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
      throw new Error(msg);
    }
    return { ...data, tag_ids: (data.tags || []).map(n => (ar.tags.find(t => t.name === n) || {}).id).filter(Boolean) };
  }

  function aiStatus(msg, kind = "") {
    const el = $("#ar-ai-status");
    el.hidden = !msg;
    el.textContent = msg || "";
    el.className = "ar-ai-status small" + (kind ? " " + kind : "");
  }

  // Vorschlag ins Formular – von Hand Geändertes bleibt (außer bei „überschreiben“)
  function applySuggestion(s, overwrite) {
    const f = $("#form-ar");
    const set = (name, val) => { if (val && (overwrite || !ar.dirty.has(name))) f[name].value = val; };
    set("title", s.title);
    set("doc_date", s.doc_date);
    set("category", s.category);
    if (s.notes && (overwrite ? !f.notes.value.includes(s.notes) : !f.notes.value.trim())) {
      f.notes.value = f.notes.value.trim() ? `${f.notes.value.trim()}\n${s.notes}` : s.notes;
    }
    for (const id of s.tag_ids || []) ar.draftTags.add(id);
    renderCats();
    renderTagPicker();
  }

  async function readPending(file) {
    if (ar.textCache.has(file)) return ar.textCache.get(file);
    const r = await extractText(file, file.name, file.type, (i, total) => aiStatus(`📖 Text wird gelesen … ${i}/${total}`));
    ar.textCache.set(file, r);
    return r;
  }

  // Beim Auswählen einer einzelnen PDF gleich lesen und Vorschlag holen
  async function autoSuggest() {
    if (!ar.ai || ar.editing || ar.pending.length !== 1) { aiStatus(""); return; }
    const file = ar.pending[0];
    if (!canRead(file.name, file.type)) { aiStatus(""); return; }
    const token = ++ar.aiToken;
    try {
      const { text } = await readPending(file);
      if (token !== ar.aiToken) return;
      if (text.trim().length < 20) { aiStatus("Kein lesbarer Text (eingescannt?) – bitte die Angaben selbst eintragen.", "warn"); return; }
      aiStatus("✨ KI liest das Dokument …");
      const s = await aiSuggest(text, file.name);
      if (token !== ar.aiToken) return;
      applySuggestion(s, false);
      aiStatus("✨ Vorschlag übernommen – bitte kurz prüfen.", "ok");
    } catch (err) {
      if (token === ar.aiToken) aiStatus(`KI-Vorschlag nicht möglich: ${err.message}`, "warn");
    }
  }

  ["title", "doc_date", "category"].forEach(n => $("#form-ar")[n].addEventListener("input", () => ar.dirty.add(n)));
  $("#ar-ai-toggle").addEventListener("change", e => {
    ar.ai = e.target.checked;
    storageSet("pp_ar_ai", ar.ai ? "1" : "0");
    if (ar.ai) autoSuggest(); else { ar.aiToken++; aiStatus(""); }
  });

  // ---------- Ablegen / Bearbeiten ----------
  function renderTagPicker() {
    $("#ar-edit-tags").innerHTML = ar.tags.length
      ? ar.tags.map(t => `<button type="button" class="chip chip-tag${ar.draftTags.has(t.id) ? " active" : ""}" data-pick-ar-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags.</span>`;
  }
  function renderPending() {
    $("#ar-files").innerHTML = ar.pending.length
      ? ar.pending.map((f, i) => `<li class="file-row"><span class="file-open"><span class="file-icon">${fileIcon(f.type)}</span>
          <span class="file-text"><span class="file-name">${escapeHtml(f.name)}</span><span class="file-size">${sizeText(f.size)}</span></span></span>
          <button type="button" class="icon-btn small" data-ar-unpick="${i}" aria-label="Entfernen">✕</button></li>`).join("")
      : "";
    $("#ar-title-row").hidden = ar.pending.length > 1;
    $("#ar-multi-hint").hidden = ar.pending.length < 2;
  }

  function openAdd(files = []) {
    ar.editing = null;
    ar.pending = [...files];
    ar.draftTags = new Set();
    const f = $("#form-ar");
    f.reset();
    f.category.value = ar.filter || "";
    renderCats();
    if (!ar.folders.length) loadFolders().then(renderCats);
    if (files.length === 1) f.title.value = splitName(files[0].name).title;
    ar.dirty = new Set();
    ar.textCache = new Map();
    ar.aiToken++;
    aiStatus("");
    $("#ar-ai-toggle").checked = ar.ai;
    $("#ar-sheet-title").textContent = "Dokument ablegen";
    $("#ar-file-block").hidden = false;
    $("#ar-detail").hidden = true;
    $("#btn-ar-save").textContent = "Ablegen";
    $("#btn-ar-delete").hidden = true;
    $("#form-ar").is_private.disabled = false;
    renderPending();
    renderTagPicker();
    openSheet("sheet-archive");
    autoSuggest();
  }

  function openDoc(id) {
    const d = ar.docs.find(x => x.id === id);
    if (!d) return;
    ar.editing = d;
    ar.pending = [];
    ar.draftTags = new Set(d.tag_ids || []);
    const f = $("#form-ar");
    f.reset();
    f.title.value = d.title;
    f.category.value = d.category;
    f.doc_date.value = d.doc_date || "";
    f.notes.value = d.notes || "";
    f.is_private.checked = d.is_private;
    f.is_private.disabled = d.created_by !== me();
    renderCats();
    if (!ar.folders.length) loadFolders().then(renderCats);
    $("#ar-sheet-title").textContent = d.title;
    $("#ar-file-block").hidden = true;
    $("#ar-title-row").hidden = false;
    $("#ar-multi-hint").hidden = true;
    $("#ar-detail").hidden = false;
    ar.dirty = new Set();
    ar.aiToken++;
    aiStatus("");
    $("#btn-ar-ai").hidden = !d.has_text;
    $("#btn-ar-recipe").hidden = !isRecipeCat(d.category);
    $("#btn-ar-recipe").textContent = ar.recipeLinks.has(d.id) ? "🍽️ Im Essensplan ✓ – neu auslesen" : "🍽️ In den Essensplan übernehmen";
    $("#ar-detail-file").innerHTML = `${fileIcon(d.mime || "")} ${escapeHtml(d.file_name)} · ${sizeText(d.size)}${d.pages ? ` · ${d.pages} Seiten` : ""}` +
      (/pdf/.test(d.mime || "") ? (d.has_text ? " · durchsuchbar ✓" : " · kein Text (eingescannt)") : "");
    $("#btn-ar-save").textContent = "Speichern";
    $("#btn-ar-delete").hidden = false;
    renderTagPicker();
    openSheet("sheet-archive");
  }

  $("#ar-file-input").addEventListener("change", e => {
    const files = [...e.target.files].filter(f => {
      if (f.size > MAX_FILE) { toast(`„${f.name}“ ist größer als 100 MB.`, true); return false; }
      return true;
    });
    e.target.value = "";
    if (!files.length) return;
    if ($("#sheet-archive").hidden) openAdd(files);
    else {
      ar.pending.push(...files);
      const f = $("#form-ar");
      if (ar.pending.length === 1 && !f.title.value) f.title.value = splitName(files[0].name).title;
      renderPending();
      autoSuggest();
    }
  });

  $("#sheet-archive").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.pickArTag) {
      const id = b.dataset.pickArTag;
      ar.draftTags.has(id) ? ar.draftTags.delete(id) : ar.draftTags.add(id);
      renderTagPicker();
    } else if (b.dataset.arUnpick !== undefined) {
      ar.pending.splice(+b.dataset.arUnpick, 1);
      renderPending();
    } else if (b.id === "btn-ar-pick") {
      $("#ar-file-input").click();
    } else if (b.id === "btn-ar-tag-add") {
      addTag();
    } else if (b.dataset.arCat !== undefined) {
      $("#form-ar").category.value = b.dataset.arCat;
      renderCats();
    } else if (b.id === "btn-ar-recipe") {
      const d = ar.editing;
      b.disabled = true;
      aiStatus("🍽️ Rezept wird ausgelesen …");
      try {
        const r = await toRecipe(d, msg => aiStatus(msg));
        aiStatus(`🍽️ „${r.name}“ ist im Essensplan – ${r.count} Zutaten.`, "ok");
        b.textContent = "🍽️ Im Essensplan ✓ – neu auslesen";
        render();
      } catch (err) {
        aiStatus(`Rezept nicht übernommen: ${err.message}`, "warn");
      } finally { b.disabled = false; }
    } else if (b.id === "btn-ar-ai") {
      const d = ar.editing;
      b.disabled = true;
      aiStatus("✨ KI liest das Dokument …");
      try {
        const { data: row, error } = await sb.from("archive_docs").select("text_content").eq("id", d.id).single();
        if (error) throw error;
        if (!row.text_content || row.text_content.trim().length < 20) throw new Error("Dieses Dokument hat keinen lesbaren Text (eingescannt oder Foto).");
        applySuggestion(await aiSuggest(row.text_content, d.file_name), true);
        aiStatus("✨ Vorschlag eingetragen – mit „Speichern“ übernehmen.", "ok");
      } catch (err) {
        aiStatus(`KI-Vorschlag nicht möglich: ${err.message}`, "warn");
      } finally { b.disabled = false; }
    } else if (b.id === "btn-ar-preview") {
      const d = ar.editing;
      showPreview(d.title, () => downloadBlob(d), d.mime, "sheet-archive");
    } else if (b.id === "btn-ar-open") {
      openFile(ar.editing, false);
    } else if (b.id === "btn-ar-share") {
      openFile(ar.editing, true);
    } else if (b.id === "btn-ar-delete") {
      const d = ar.editing;
      if (!d || !confirm(`„${d.title}“ löschen? Die Datei wird auch aus HiDrive entfernt.`)) return;
      try {
        await call("delete", { doc_id: d.id });
      } catch (err) {
        if (!confirm(`${err.message}\n\nEintrag trotzdem aus der App entfernen?`)) return;
        await call("delete", { doc_id: d.id, force: true });
      }
      ar.docs = ar.docs.filter(x => x.id !== d.id);
      closeSheets();
      toast("Gelöscht.");
      render();
    }
  });

  async function addTag() {
    const input = $("#form-ar").new_tag;
    const name = input.value.trim().slice(0, 40);
    if (!name) return;
    let tag = ar.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      const { data, error } = await sb.from("event_tags").insert({ household_id: hid(), name, color: TAG_COLORS[ar.tags.length % TAG_COLORS.length] }).select("id, name, color").single();
      if (error) { toast(translateError(error), true); return; }
      tag = data; ar.tags.push(tag);
    }
    ar.draftTags.add(tag.id);
    input.value = "";
    renderTagPicker();
  }
  $("#form-ar").new_tag.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });

  $("#form-ar").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const btn = $("#btn-ar-save");
      const meta = {
        category: f.category.value.trim().slice(0, 60) || "Sonstiges",
        doc_date: f.doc_date.value || null,
        notes: f.notes.value.trim().slice(0, 2000),
        tag_ids: [...ar.draftTags].filter(id => ar.tags.some(t => t.id === id))
      };
      if (!f.is_private.disabled) meta.is_private = f.is_private.checked;

      // Bearbeiten
      if (ar.editing) {
        const title = f.title.value.trim();
        if (!title) throw new Error("Bitte einen Titel eingeben.");
        const d0 = ar.editing;
        const wantName = nameFor(title, meta.doc_date, meta.category, d0.file_name);
        if (ar.status && ar.status.connected &&
            (meta.category !== d0.category || !sameName(d0.file_name, wantName))) {
          // Datei in HiDrive in den Ordner der Kategorie verschieben und nach Datum + Titel benennen
          const r = await call("place", { doc_id: d0.id, category: meta.category, title: title.slice(0, 200), doc_date: meta.doc_date });
          meta.category = r.category;
          if (r.moved && !ar.folders.includes(r.category)) ar.folders.push(r.category);
        }
        const { error } = await sb.from("archive_docs").update({ ...meta, title: title.slice(0, 200) }).eq("id", ar.editing.id);
        if (error) throw error;
        closeSheets();
        toast("Gespeichert.");
        await loadAll(); render();
        return;
      }

      // Ablegen
      if (!ar.pending.length) throw new Error("Bitte zuerst eine Datei auswählen.");
      let done = 0;
      try {
        for (const file of ar.pending) {
          const n = ar.pending.length > 1 ? ` (${done + 1}/${ar.pending.length})` : "";
          let text = "", pages = null;
          const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
          if (ar.textCache.has(file)) {
            ({ text, pages } = ar.textCache.get(file));
          } else if (canRead(file.name, file.type)) {
            try {
              ({ text, pages } = await extractText(file, file.name, file.type, (i, total) => { btn.textContent = `Text wird gelesen${n} … ${i}/${total}`; }));
            } catch (err) { console.warn("Text:", err); }
          }
          btn.textContent = `Wird in HiDrive abgelegt${n} …`;
          const parts = splitName(file.name);
          const title = (ar.pending.length === 1 && f.title.value.trim()) || parts.title;
          const date = meta.doc_date || parts.date;
          const up = await uploadFile(file, meta.category, nameFor(title, date, meta.category, file.name));
          const { error } = await sb.from("archive_docs").insert({
            household_id: hid(), ...meta, doc_date: date, is_private: !!meta.is_private,
            title: title.slice(0, 200), file_name: (up.name || file.name).slice(0, 255), file_path: up.path,
            size: file.size, mime: file.type || (isPdf ? "application/pdf" : ""), pages, text_content: text
          });
          if (error) {
            if (/archive_docs/.test(error.message || "")) throw new Error("Bitte zuerst das SQL aus Schritt 30 in Supabase ausführen.");
            throw error;
          }
          done++;
        }
      } finally {
        btn.textContent = "Ablegen";
        if (done) { await loadAll(); render(); loadFolders(); }
      }
      closeSheets();
      toast(done === 1 ? "Dokument abgelegt." : `${done} Dokumente abgelegt.`);
    });
  });

  // Öffnen: Fenster sofort öffnen (sonst blockiert Safari), dann füllen
  async function openFile(doc, share) {
    if (!doc) return;
    const win = share ? null : window.open("", "_blank");
    try {
      if (win) win.document.write("<p style='font:16px -apple-system,sans-serif;padding:20px'>Dokument wird aus HiDrive geladen …</p>");
      const blob = await downloadBlob(doc);
      if (share && navigator.canShare) {
        const file = new File([blob], doc.file_name, { type: blob.type });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: doc.title }); return; }
      }
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url;
      else {
        const a = document.createElement("a");
        a.href = url; a.download = doc.file_name;
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (err) {
      if (win) win.close();
      if (err && err.name === "AbortError") return;
      toast(err.message || "Öffnen fehlgeschlagen.", true);
    }
  }

  // ---------- Klicks ----------
  $("#view-archive").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.arFilter !== undefined) { ar.filter = b.dataset.arFilter; ar.limit = 50; storageSet("pp_ar_filter", ar.filter); render(); return; }
    if (b.dataset.arYear !== undefined) {
      const y = b.dataset.arYear;
      ar.years.set(y, b.getAttribute("aria-expanded") !== "true");
      render();
      return;
    }
    if (b.id === "btn-ar-more") { ar.limit += 50; render(); return; }
    if (b.dataset.arTag) { ar.tagFilter = ar.tagFilter === b.dataset.arTag ? "" : b.dataset.arTag; storageSet("pp_ar_tag", ar.tagFilter); render(); return; }
    if (b.dataset.arDoc) { openDoc(b.dataset.arDoc); return; }
    if (b.id === "btn-ar-add") { openAdd(); return; }
    if (b.id === "btn-ar-retry") {
      b.disabled = true;
      ar.status = await call("status").catch(err => ({ error: err.message || "Unbekannter Fehler" }));
      render(); renderFooter();
      return;
    }
    if (b.id === "btn-ar-connect" || b.id === "btn-ar-relogin") { openConnect(); return; }
    if (b.id === "btn-ar-import") { openImport(); return; }
    if (b.id === "btn-ar-sync") {
      b.disabled = true; b.textContent = "🔄 Wird abgeglichen …";
      try {
        const r = await call("scan");
        if (r.fixed) { await loadAll(); render(); }
        toast([r.fixed ? `${r.fixed} Eintr${r.fixed === 1 ? "ag" : "äge"} an HiDrive angepasst` : "Alles passt zu HiDrive",
          r.files && r.files.length ? `${r.files.length} neue Datei${r.files.length === 1 ? "" : "en"} zum Übernehmen` : "",
          r.missing ? `${r.missing} Datei${r.missing === 1 ? "" : "en"} in HiDrive nicht gefunden` : ""].filter(Boolean).join(" · ") + ".", !!r.missing);
      } catch (err) { toast(err.message, true); }
      finally { renderFooter(); }
      return;
    }
    if (b.id === "btn-ar-recipes-all") { recipesAll(b); return; }
    if (b.id === "btn-ar-rename-all") { renameAll(b); return; }
    if (b.id === "btn-ar-disconnect") {
      if (!confirm("HiDrive-Verbindung trennen? Die Dateien bleiben in HiDrive, sind in der App aber erst nach dem erneuten Verbinden wieder abrufbar.")) return;
      try { await call("disconnect"); ar.status = { ...ar.status, connected: false }; render(); renderFooter(); toast("Verbindung getrennt."); }
      catch (err) { toast(err.message, true); }
    }
  });

  function renderFooter() {
    const s = ar.status;
    $("#ar-footer").innerHTML = s && s.connected
      ? `<p class="ar-imp-cta"><button class="btn btn-small" id="btn-ar-import">📥 Aus HiDrive übernehmen</button> <button class="btn btn-small" id="btn-ar-sync">🔄 Mit HiDrive abgleichen</button></p><p class="muted small">📂 HiDrive${s.alias ? " · " + escapeHtml(s.alias) : ""} · Ordner „${escapeHtml((s.folder || "").split("/").pop())}“${s.can_manage ? ` · <button class="link" id="btn-ar-rename-all">Dateinamen angleichen</button> · <button class="link" id="btn-ar-relogin">Zugang ändern</button> · <button class="link" id="btn-ar-disconnect">Trennen</button>` : ""}</p>`
      : "";
  }

  // ---------- Rezepte → Essensplan ----------
  // Foto (auch HEIC in Safari) als verkleinertes JPEG für die KI
  async function imageForAi(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch { throw new Error("Dieses Bild kann der Browser nicht lesen (HEIC? – bitte in Safari öffnen oder als JPEG ablegen)."); }
      return drawJpeg(img, img.naturalWidth, img.naturalHeight);
    } finally { URL.revokeObjectURL(url); }
  }
  function drawJpeg(src, w, h) {
    const s = Math.min(1, 1568 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }
  // Eingescannte PDF ohne Text: erste Seite als Bild
  async function pdfPageImage(blob) {
    await loadScript(PDFJS);
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await lib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const page = await pdf.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 1568 / Math.max(v1.width, v1.height) });
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    return drawJpeg(c, c.width, c.height);
  }

  async function recipeSource(doc, status) {
    const { data } = await sb.from("archive_docs").select("text_content").eq("id", doc.id).single();
    const stored = (data && data.text_content) || "";
    if (stored.trim().length >= 40) return { text: stored };
    const mime = doc.mime || "";
    status("📥 Datei wird aus HiDrive geladen …");
    const blob = await downloadBlob(doc);
    if (/^image\//.test(mime) || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(doc.file_name)) return { image: await imageForAi(blob) };
    if (canRead(doc.file_name, mime)) {
      const r = await extractText(blob, doc.file_name, mime);
      if (r.text.trim().length >= 40) {
        // gleich für die Suche merken
        sb.from("archive_docs").update({ text_content: r.text, pages: r.pages }).eq("id", doc.id).then(() => {});
        return { text: r.text };
      }
      if (/pdf/i.test(mime) || /\.pdf$/i.test(doc.file_name)) return { image: await pdfPageImage(blob) };
    }
    throw new Error("Aus diesem Dateityp lässt sich kein Rezept lesen (z. B. alte .doc-Dateien – bitte als .docx oder PDF speichern).");
  }

  async function toRecipe(doc, status = () => {}) {
    const src = await recipeSource(doc, status);
    status(src.image ? "✨ KI liest das Foto …" : "✨ KI liest das Rezept …");
    const { data, error } = await sb.functions.invoke("assist", { body: { action: "recipe", ...src, file_name: doc.file_name } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
      throw new Error(msg);
    }
    const row = {
      name: data.name.slice(0, 120), servings: data.servings,
      ingredients: (data.ingredients || []).map(s => s.slice(0, 120)).join("\n").slice(0, 5000),
      instructions: (data.instructions || "").slice(0, 20000), archive_doc_id: doc.id
    };
    const known = ar.recipeLinks.get(doc.id);
    let res;
    if (known) res = await sb.from("recipes").update(row).eq("id", known).select("id").single();
    else res = await sb.from("recipes").insert({ ...row, household_id: hid() }).select("id").single();
    if (res.error) {
      if (/archive_doc_id/.test(res.error.message || "")) throw new Error("Bitte zuerst das SQL aus Schritt 35 in Supabase ausführen.");
      if (/recipes/.test(res.error.message || "")) throw new Error("Bitte zuerst das SQL aus Schritt 32 in Supabase ausführen.");
      throw res.error;
    }
    ar.recipeLinks.set(doc.id, res.data.id);
    return { name: row.name, count: (data.ingredients || []).length };
  }

  async function recipesAll(btn) {
    const todo = ar.docs.filter(d => d.category === ar.filter && !ar.recipeLinks.has(d.id));
    if (!todo.length) return;
    if (!confirm(`${todo.length} Rezept${todo.length === 1 ? "" : "e"} von der KI auslesen und in den Essensplan übernehmen?`)) return;
    btn.disabled = true;
    let ok = 0;
    const bad = [];
    for (const d of todo) {
      btn.textContent = `${ok + bad.length + 1}/${todo.length} …`;
      try { await toRecipe(d); ok++; } catch (err) { console.warn(d.file_name, err); bad.push(`${d.title}: ${err.message}`); }
    }
    render();
    toast(bad.length ? `${ok} übernommen, ${bad.length} nicht: ${bad.slice(0, 2).join(" · ")}${bad.length > 2 ? " …" : ""}` : `${ok} Rezept${ok === 1 ? "" : "e"} im Essensplan.`, !!bad.length);
  }

  // Für den Essensplan: Original eines Rezepts anzeigen
  PP.archiveDoc = {
    async preview(docId, back) {
      const { data: doc, error } = await sb.from("archive_docs").select("id, title, mime, file_name").eq("id", docId).maybeSingle();
      if (error || !doc) { toast("Das Original ist im Archiv nicht mehr vorhanden.", true); return; }
      showPreview(doc.title, () => downloadBlob(doc), doc.mime, back);
    }
  };

  // ---------- Alle Dateinamen an Datum + Titel angleichen ----------
  async function renameAll(btn) {
    const todo = ar.docs.filter(d => !sameName(d.file_name, nameFor(d.title, d.doc_date, d.category, d.file_name)));
    if (!todo.length) { toast("Alle Dateinamen passen schon zu Datum und Titel."); return; }
    const ex = todo[0];
    if (!confirm(`${todo.length} Datei${todo.length === 1 ? "" : "en"} in HiDrive umbenennen?\n\nBeispiel:\n${ex.file_name}\n→ ${nameFor(ex.title, ex.doc_date, ex.category, ex.file_name)}`)) return;
    btn.disabled = true;
    let ok = 0, bad = 0;
    for (const d of todo) {
      btn.textContent = `Umbenennen … ${ok + bad + 1}/${todo.length}`;
      try { await call("place", { doc_id: d.id }); ok++; } catch (err) { console.warn(d.file_name, err); bad++; }
    }
    await loadAll(); render(); renderFooter();
    toast(bad ? `${ok} umbenannt, ${bad} nicht möglich (Datei fehlt in HiDrive?).` : `${ok} Datei${ok === 1 ? "" : "en"} umbenannt.`, !!bad);
  }

  // ---------- Aus HiDrive übernehmen ----------
  const imp = { files: [], picked: new Set(), tags: new Set(), busy: false };
  const MIME = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", gif: "image/gif", webp: "image/webp",
    txt: "text/plain", csv: "text/csv", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pages: "application/vnd.apple.pages", zip: "application/zip" };
  const mimeOf = f => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    return MIME[ext] || (f.type && !/directory/i.test(f.type) ? f.type : "");
  };

  function renderImport() {
    const list = $("#ar-imp-list");
    if (!imp.files.length) {
      list.innerHTML = "";
      $("#ar-imp-opts").hidden = true;
      return;
    }
    list.innerHTML = imp.files.map((f, i) => `<li class="ar-imp-li"><button type="button" class="icon-btn small ar-imp-eye" data-imp-preview="${i}" aria-label="Vorschau" title="Vorschau">👁</button><label class="ar-imp-row">
        <input type="checkbox" data-imp="${i}"${imp.picked.has(i) ? " checked" : ""}>
        <span class="file-icon">${fileIcon(mimeOf(f))}</span>
        <span class="ar-imp-text"><span class="ar-imp-name">${escapeHtml(f.name)}</span>
        <span class="muted small">${escapeHtml(f.folder || "Sonstiges")} · ${escapeHtml(sizeText(f.size))}${f.modified ? " · " + escapeHtml(dateText(f.modified.slice(0, 10))) : ""}</span></span>
      </label></li>`).join("");
    $("#ar-imp-tags").innerHTML = ar.tags.length
      ? ar.tags.map(t => `<button type="button" class="chip chip-tag${imp.tags.has(t.id) ? " active" : ""}" data-imp-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags.</span>`;
    $("#ar-imp-opts").hidden = false;
    $("#btn-ar-imp").textContent = imp.picked.size ? `${imp.picked.size} übernehmen` : "Nichts ausgewählt";
    $("#btn-ar-imp").disabled = !imp.picked.size || imp.busy;
  }

  async function openImport() {
    imp.files = []; imp.picked = new Set(); imp.tags = new Set();
    $("#form-ar-import").reset();
    $("#ar-imp-info").textContent = "HiDrive-Ordner wird durchsucht …";
    renderImport();
    openSheet("sheet-ar-import");
    try {
      const r = await call("scan");
      if (r.fixed) { await loadAll(); render(); }
      imp.files = r.files || [];
      imp.picked = new Set(imp.files.map((_, i) => i));
      $("#ar-imp-info").textContent = imp.files.length
        ? `${imp.files.length} neue Datei${imp.files.length === 1 ? "" : "en"} im Ordner „${(r.root || "").split("/").pop()}“ gefunden.`
        : `Keine neuen Dateien – alles im Ordner „${(r.root || "").split("/").pop()}“ ist schon im Archiv.`;
      if (r.fixed) $("#ar-imp-info").textContent += ` ${r.fixed} vorhandene Eintr${r.fixed === 1 ? "ag" : "äge"} an HiDrive angepasst (Ordner/Name).`;
    } catch (err) {
      $("#ar-imp-info").textContent = err.message;
    }
    renderImport();
  }

  async function fetchBlob(path) {
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/hidrive`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fetch", path })
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Lesen fehlgeschlagen (${res.status}).`); }
    return await res.blob();
  }

  $("#sheet-ar-import").addEventListener("change", e => {
    const c = e.target.closest("[data-imp]");
    if (!c) return;
    const i = +c.dataset.imp;
    c.checked ? imp.picked.add(i) : imp.picked.delete(i);
    renderImport();
  });
  $("#sheet-ar-import").addEventListener("click", e => {
    const pv = e.target.closest("[data-imp-preview]");
    if (pv) {
      const file = imp.files[+pv.dataset.impPreview];
      if (file) showPreview(file.name, () => fetchBlob(file.path), mimeOf(file), "sheet-ar-import");
      return;
    }
    const t = e.target.closest("[data-imp-tag]");
    if (!t) return;
    const id = t.dataset.impTag;
    imp.tags.has(id) ? imp.tags.delete(id) : imp.tags.add(id);
    renderImport();
  });

  $("#form-ar-import").addEventListener("submit", async e => {
    e.preventDefault();
    if (imp.busy || !imp.picked.size) return;
    const f = e.target, btn = $("#btn-ar-imp");
    const chosen = [...imp.picked].sort((a, b) => a - b).map(i => imp.files[i]);
    imp.busy = true; btn.disabled = true;
    let done = 0, aiFail = "";
    const failed = [];
    try {
      for (const file of chosen) {
        const n = `${done + failed.length + 1}/${chosen.length}`;
        const mime = mimeOf(file);
        let text = "", pages = null;
        if (canRead(file.name, mime) && file.size <= 30 * 1024 * 1024) {
          try {
            btn.textContent = `Wird gelesen ${n} …`;
            const blob = await fetchBlob(file.path);
            ({ text, pages } = await extractText(blob, file.name, mime, (i, total) => { btn.textContent = `Text wird gelesen ${n} … ${i}/${total}`; }));
          } catch (err) { console.warn("Text:", err); }
        }
        const parts = splitName(file.name);
        let sug = null;
        if (f.ai.checked && text.trim().length >= 20) {
          btn.textContent = `✨ KI liest ${n} …`;
          try { sug = await aiSuggest(text, file.name); } catch (err) { console.warn("KI:", err); aiFail = err.message; }
        }
        btn.textContent = `Wird übernommen ${n} …`;
        // Unterordner bleibt die Kategorie; nur Dateien direkt im Archiv-Ordner bekommen die KI-Kategorie
        const category = (file.folder || (sug && sug.category) || "Sonstiges").slice(0, 60);
        const tagIds = [...new Set([...imp.tags, ...((sug && sug.tag_ids) || [])])].filter(id => ar.tags.some(t => t.id === id));
        const { data: row, error } = await sb.from("archive_docs").insert({
          household_id: hid(), title: ((sug && sug.title) || parts.title).slice(0, 200), category,
          doc_date: (sug && sug.doc_date) || parts.date || (file.modified ? file.modified.slice(0, 10) : null), notes: ((sug && sug.notes) || "").slice(0, 2000),
          tag_ids: tagIds, is_private: f.is_private.checked,
          file_name: file.name.slice(0, 255), file_path: file.path, size: file.size || 0, mime, pages, text_content: text
        }).select("id, title, doc_date, file_name").single();
        if (error) { console.warn(error); failed.push(file.name); continue; }
        done++;
        const wrongFolder = category !== (file.folder || "");
        const wrongName = f.rename.checked && !sameName(row.file_name, nameFor(row.title, row.doc_date, category, row.file_name));
        if (wrongFolder || wrongName) {
          btn.textContent = `Wird einsortiert ${n} …`;
          try { await call(f.rename.checked ? "place" : "move", { doc_id: row.id, category }); } catch (err) { console.warn("Einsortieren:", err); }
        }
      }
    } finally {
      imp.busy = false;
      if (done) { await loadAll(); render(); }
    }
    closeSheets();
    toast(failed.length
      ? `${done} übernommen, ${failed.length} fehlgeschlagen: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? " …" : ""}`
      : `${done} Dokument${done === 1 ? "" : "e"} übernommen.${aiFail ? ` KI-Vorschläge teilweise nicht möglich: ${aiFail}` : ""}`, !!failed.length || !!aiFail);
  });

  // ---------- Modul ----------
  PP.modules.archive = {
    async enter() {
      ar.active = true;
      $("#ar-search").value = ar.query;
      render();
      try {
        const [st] = await Promise.all([call("status").catch(err => ({ error: err.message || "Unbekannter Fehler" })), loadAll()]);
        if (st) ar.status = st;
        subscribe();
        loadFolders();
      } catch (err) {
        console.error(err);
        toast(/archive_docs|does not exist/i.test(err.message || "") ? "Bitte zuerst das SQL aus Schritt 30 in Supabase ausführen." : translateError(err), true);
      }
      render();
      renderFooter();
    },
    leave() { ar.active = false; unsubscribe(); closeSheets(); },
    async resume() { if (ar.active) { try { await loadAll(); render(); } catch { /* egal */ } } },
    refreshTile() {
      sb.from("archive_docs").select("id", { count: "exact", head: true }).eq("household_id", hid())
        .then(({ count, error }) => { $("#tile-ar-status").textContent = error ? "Öffnen" : (count ? `${count} Dokument${count === 1 ? "" : "e"}` : "HiDrive"); });
    },
    reset() { this.leave(); ar.docs = []; ar.status = null; }
  };
})();
