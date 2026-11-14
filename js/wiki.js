// =========================================================
// Pichis Planner – Familien-Wiki
// Seiten & Vorlagen, Editor mit Knöpfen, Anhänge (PDF-Text durchsuchbar),
// Vorlagen ausfüllen, Formulieren und Fragen mit KI
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, memberName, openSheet, closeSheets } = PP;

  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const MAX_TEXT = 400000;
  const MAX_IMG_PX = 1800;
  const DEFAULT_CATEGORIES = ["Haushalt & Geräte", "Verträge & Versicherungen", "Finanzen & Steuern", "Gesundheit", "Auto",
    "Technik & Internet", "Schule & Kinder", "Notfall", "Rezepte", "Kommunikation"];
  const TAG_COLORS = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];

  const wk = {
    active: false,
    pages: [],
    tags: [],
    filter: storageGet("pp_wiki_filter") || "",
    query: "",
    results: null,
    current: null,       // geöffnete Seite (voll)
    files: [],
    channel: null,
    editing: null,       // ID im Editor (null = neu)
    draftTags: new Set(),
    urls: new Map(),
    useText: "",
    searchToken: 0
  };

  const me = () => state.session.user.id;
  const hid = () => state.household.id;

  // =========================================================
  // HTML bereinigen (nur erlaubte Formatierungen)
  // =========================================================
  const KEEP = {
    H2: [], H3: [], P: [], BR: [], B: [], STRONG: [], I: [], EM: [], U: [], UL: [], OL: [], LI: [],
    A: ["href"], BLOCKQUOTE: [], HR: [], IMG: ["data-path", "alt"], CODE: [], PRE: [], DIV: []
  };
  const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON",
    "SELECT", "TEXTAREA", "SVG", "MATH", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE", "VIDEO", "AUDIO", "CANVAS"]);
  const RENAME = { H1: "H2", H4: "H3", H5: "H3", H6: "H3", SECTION: "DIV", ARTICLE: "DIV", HEADER: "DIV", FOOTER: "DIV", TABLE: "DIV", TR: "P", TD: "SPAN", TH: "SPAN", S: "SPAN", STRIKE: "SPAN" };
  const RE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[\w.-]{1,120}$/i;

  function cleanNode(node, doc) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;                     // Text
      if (child.nodeType !== 1) { child.remove(); continue; } // Kommentare usw.
      let tag = child.tagName.toUpperCase();
      if (DROP.has(tag)) { child.remove(); continue; }
      if (RENAME[tag]) {
        const repl = doc.createElement(RENAME[tag]);
        while (child.firstChild) repl.appendChild(child.firstChild);
        child.replaceWith(repl);
        cleanNode(repl.parentNode === node ? node : repl, doc);
        continue;
      }
      if (!KEEP[tag]) {                                      // auspacken
        cleanNode(child, doc);
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        if (!KEEP[tag].includes(attr.name.toLowerCase())) child.removeAttribute(attr.name);
      }
      if (tag === "A") {
        const href = (child.getAttribute("href") || "").trim();
        if (!/^(https?:|mailto:|tel:|#\/)/i.test(href)) child.removeAttribute("href");
      }
      if (tag === "IMG") {
        if (!RE_PATH.test(child.getAttribute("data-path") || "")) { child.remove(); continue; }
      }
      cleanNode(child, doc);
    }
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<body>${html || ""}</body>`, "text/html");
    cleanNode(doc.body, doc);
    return doc.body.innerHTML.replace(/(<p><br><\/p>\s*){3,}/g, "<p><br></p>").trim();
  }

  // Reiner Text (für Suche, KI und Vorlagen) mit sinnvollen Zeilenumbrüchen
  function htmlToPlain(html) {
    const doc = new DOMParser().parseFromString(`<body>${html || ""}</body>`, "text/html");
    let out = "";
    const BLOCK = new Set(["P", "DIV", "H2", "H3", "LI", "BLOCKQUOTE", "PRE", "UL", "OL", "HR"]);
    (function walk(n, olIndex) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { out += c.nodeValue.replace(/\s+/g, " "); continue; }
        if (c.nodeType !== 1) continue;
        const t = c.tagName;
        if (t === "BR") { out += "\n"; continue; }
        if (t === "IMG") { continue; }
        if (BLOCK.has(t) && !out.endsWith("\n")) out += "\n";
        if (t === "LI") out += olIndex ? `${olIndex.n++}. ` : "• ";
        walk(c, t === "OL" ? { n: 1 } : (t === "UL" ? null : olIndex));
        if (BLOCK.has(t) && !out.endsWith("\n")) out += "\n";
      }
    })(doc.body, null);
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function plainToHtml(text) {
    return String(text || "").split(/\n{2,}/).map(par => `<p>${escapeHtml(par).replace(/\n/g, "<br>")}</p>`).join("");
  }

  // =========================================================
  // Daten
  // =========================================================
  const LIST_FIELDS = "id, kind, title, icon, category, subject, tag_ids, is_private, is_pinned, created_by, updated_by, updated_at";

  async function loadList() {
    const [p, t] = await Promise.all([
      sb.from("wiki_pages").select(LIST_FIELDS).eq("household_id", hid()).order("title"),
      sb.from("event_tags").select("id, name, color").eq("household_id", hid()).order("name")
    ]);
    if (p.error) throw p.error;
    wk.pages = p.data;
    wk.tags = t.error ? [] : t.data;
  }

  async function loadPage(id) {
    const [p, f] = await Promise.all([
      sb.from("wiki_pages").select("*").eq("id", id).maybeSingle(),
      sb.from("wiki_files").select("id, page_id, path, name, size, mime, pages, created_at, has_text").eq("page_id", id).order("created_at")
    ]);
    if (p.error) throw p.error;
    wk.current = p.data;
    wk.files = f.data || [];
  }

  function upsertLocal(row) {
    const slim = Object.fromEntries(LIST_FIELDS.split(", ").map(k => [k, row[k]]));
    const i = wk.pages.findIndex(x => x.id === row.id);
    if (i >= 0) wk.pages[i] = slim; else wk.pages.push(slim);
    wk.pages.sort((a, b) => a.title.localeCompare(b.title, "de"));
  }

  function subscribe() {
    unsubscribe();
    wk.channel = sb.channel("wiki-" + hid())
      .on("postgres_changes", { event: "*", schema: "public", table: "wiki_pages", filter: `household_id=eq.${hid()}` }, p => {
        if (p.eventType === "DELETE") wk.pages = wk.pages.filter(x => x.id !== (p.old && p.old.id));
        else upsertLocal(p.new);
        if (!PP.route.param) renderList();
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "wiki_pages" }, p => {
        wk.pages = wk.pages.filter(x => x.id !== (p.old && p.old.id));
        if (!PP.route.param) renderList();
      })
      .subscribe();
  }
  function unsubscribe() {
    if (wk.channel) { sb.removeChannel(wk.channel); wk.channel = null; }
  }

  async function signed(paths) {
    const now = Date.now();
    const need = paths.filter(p => { const c = wk.urls.get(p); return !c || c.until < now + 60000; });
    if (need.length) {
      const { data } = await sb.storage.from("wiki-files").createSignedUrls(need, 3600);
      for (const d of data || []) if (d.signedUrl) wk.urls.set(d.path, { url: d.signedUrl, until: now + 3600 * 1000 });
    }
    return paths.map(p => (wk.urls.get(p) || {}).url || "");
  }

  async function fillImages(root) {
    const imgs = [...root.querySelectorAll("img[data-path]")];
    if (!imgs.length) return;
    const urls = await signed(imgs.map(i => i.getAttribute("data-path")));
    imgs.forEach((img, k) => { if (urls[k]) img.src = urls[k]; });
  }

  // =========================================================
  // Liste & Suche
  // =========================================================
  const iconOf = p => p.icon || (p.kind === "template" ? "✉️" : "📄");
  const tagChip = t => `<span class="tag" style="--tag:${escapeHtml(t.color)}">${escapeHtml(t.name)}</span>`;

  function card(p) {
    const tags = (p.tag_ids || []).map(id => wk.tags.find(t => t.id === id)).filter(Boolean);
    return `<li><a class="wiki-card" href="#/wiki/${p.id}">
      <span class="wiki-icon">${escapeHtml(iconOf(p))}</span>
      <span class="wiki-card-text">
        <span class="wiki-title">${escapeHtml(p.title)}${p.is_private ? ' <span class="muted">🔒</span>' : ""}</span>
        <span class="wiki-sub">${p.kind === "template" ? "Vorlage" : escapeHtml(p.category || "Ohne Kategorie")}</span>
        ${tags.length ? `<span class="tag-row">${tags.map(tagChip).join("")}</span>` : ""}
      </span>
    </a></li>`;
  }

  function renderList() {
    if (!wk.active || PP.route.param) return;
    const cats = [...new Set(wk.pages.filter(p => p.kind === "page" && p.category).map(p => p.category))].sort((a, b) => a.localeCompare(b, "de"));
    if (wk.filter && wk.filter !== "__tpl" && !cats.includes(wk.filter)) wk.filter = "";
    $("#wiki-chips").innerHTML =
      `<button class="chip${!wk.filter ? " active" : ""}" data-wiki-filter="">Alle</button>` +
      `<button class="chip${wk.filter === "__tpl" ? " active" : ""}" data-wiki-filter="__tpl">✉️ Vorlagen</button>` +
      cats.map(c => `<button class="chip${wk.filter === c ? " active" : ""}" data-wiki-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("");

    if (wk.query.trim().length >= 2) { renderResults(); return; }

    let list = wk.pages;
    if (wk.filter === "__tpl") list = list.filter(p => p.kind === "template");
    else if (wk.filter) list = list.filter(p => p.category === wk.filter && p.kind === "page");

    const section = (title, items) => items.length
      ? `<section class="cat-group"><h3 class="cat-title">${title} <span class="cat-count">${items.length}</span></h3><ul class="wiki-list">${items.map(card).join("")}</ul></section>` : "";

    let html = "";
    if (!wk.filter) html += section("📌 Angeheftet", list.filter(p => p.is_pinned));
    const rest = wk.filter ? list : list.filter(p => !p.is_pinned);
    if (wk.filter === "__tpl") {
      html += section("Vorlagen", rest);
    } else {
      const groups = new Map();
      for (const p of rest) {
        const g = p.kind === "template" ? "✉️ Vorlagen" : (p.category || "Ohne Kategorie");
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(p);
      }
      [...groups.keys()].sort((a, b) => (a === "✉️ Vorlagen") - (b === "✉️ Vorlagen") || a.localeCompare(b, "de"))
        .forEach(g => { html += section(escapeHtml(g), groups.get(g)); });
    }
    $("#wiki-items").innerHTML = html || `<div class="empty">
      <div class="empty-icon">📚</div>
      <p><strong>${wk.pages.length ? "Nichts in dieser Kategorie." : "Euer Wiki ist noch leer."}</strong></p>
      <p class="muted small">Mit dem orangen + eine Seite anlegen – z. B. für eine Bedienungsanleitung, wichtige Kontakte oder eine Briefvorlage.</p>
    </div>`;
  }

  let searchTimer;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    if (wk.query.trim().length < 2) { wk.results = null; renderList(); return; }
    searchTimer = setTimeout(runSearch, 280);
  }

  async function runSearch() {
    const token = ++wk.searchToken;
    const q = wk.query.trim();
    $("#wiki-items").innerHTML = `<p class="muted wiki-wait">Suche …</p>`;
    const { data, error } = await sb.rpc("wiki_search", { p_household: hid(), p_query: q });
    if (token !== wk.searchToken) return;
    if (error) {
      // Rückfall ohne Datenbank-Suche: nur Titel
      const low = q.toLowerCase();
      wk.results = wk.pages.filter(p => p.title.toLowerCase().includes(low)).map(p => ({ page_id: p.id, title: p.title, icon: p.icon, kind: p.kind, category: p.category, snippet: "", file_name: null }));
    } else {
      wk.results = data;
    }
    renderResults();
  }

  function renderResults() {
    const r = wk.results;
    if (!r) { $("#wiki-items").innerHTML = `<p class="muted wiki-wait">Suche …</p>`; return; }
    if (!r.length) {
      $("#wiki-items").innerHTML = `<div class="empty"><div class="empty-icon">🔎</div>
        <p><strong>Nichts gefunden.</strong></p>
        <p class="muted small">Tipp: „✨ Frag das Wiki“ versteht auch ganze Fragen.</p></div>`;
      return;
    }
    $("#wiki-items").innerHTML = `<ul class="wiki-results">${r.map(h => `<li><a class="wiki-hit" href="#/wiki/${h.page_id}">
        <span class="wiki-icon">${escapeHtml(h.icon || (h.kind === "template" ? "✉️" : "📄"))}</span>
        <span class="wiki-card-text">
          <span class="wiki-title">${escapeHtml(h.title)}</span>
          ${h.file_name ? `<span class="wiki-sub">📎 in ${escapeHtml(h.file_name)}</span>` : `<span class="wiki-sub">${escapeHtml(h.kind === "template" ? "Vorlage" : (h.category || ""))}</span>`}
          ${h.snippet ? `<span class="wiki-snippet">${escapeHtml(h.snippet).replace(/«/g, "<mark>").replace(/»/g, "</mark>")}</span>` : ""}
        </span>
      </a></li>`).join("")}</ul>`;
  }

  // =========================================================
  // Seite anzeigen
  // =========================================================
  function sizeText(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return Math.round(b / 1024) + " KB";
    return (Math.round(b / 104857.6) / 10).toString().replace(".", ",") + " MB";
  }
  const fileIcon = m => /pdf/.test(m) ? "📕" : /^image\//.test(m) ? "🖼️" : /word|document/.test(m) ? "📝" : /sheet|excel|csv/.test(m) ? "📊" : "📎";

  async function showPage(id) {
    $("#wiki-list-wrap").hidden = true;
    $("#wiki-page-wrap").hidden = false;
    $("#wiki-page").innerHTML = `<p class="muted wiki-wait">Lädt …</p>`;
    try {
      await loadPage(id);
    } catch (err) {
      $("#wiki-page").innerHTML = `<p class="muted">${escapeHtml(translateError(err))}</p>`;
      return;
    }
    const p = wk.current;
    if (!p) { $("#wiki-page").innerHTML = `<p class="muted">Seite nicht gefunden oder privat.</p>`; return; }
    $("#greeting").textContent = p.title;

    const tags = (p.tag_ids || []).map(i => wk.tags.find(t => t.id === i)).filter(Boolean);
    const who = p.updated_by && memberName(p.updated_by) ? ` von ${escapeHtml(memberName(p.updated_by))}` : "";
    const when = new Date(p.updated_at).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });

    $("#wiki-page").innerHTML = `
      <div class="wiki-head">
        <span class="wiki-head-icon">${escapeHtml(iconOf(p))}</span>
        <div>
          <h2 class="wiki-h">${escapeHtml(p.title)}</h2>
          <p class="wiki-meta">${p.kind === "template" ? "✉️ Vorlage" : escapeHtml(p.category || "Ohne Kategorie")}${p.is_private ? " · 🔒 privat" : ""} · geändert ${when}${who}</p>
          ${tags.length ? `<span class="tag-row">${tags.map(tagChip).join("")}</span>` : ""}
        </div>
      </div>
      <div class="btn-row wiki-actions">
        ${p.kind === "template" ? `<button class="btn btn-primary btn-small" data-wiki-use>✍️ Verwenden</button>
          <button class="btn btn-small" data-wiki-ai-template>✨ Mit KI anpassen</button>` : ""}
        <button class="btn btn-secondary btn-small" data-wiki-edit>✏️ Bearbeiten</button>
      </div>
      ${p.kind === "template" && p.subject ? `<p class="wiki-subject"><span class="muted">Betreff:</span> ${escapeHtml(p.subject)}</p>` : ""}
      <article class="wiki-content${p.kind === "template" ? " is-template" : ""}">${sanitize(p.content_html) || '<p class="muted">Noch kein Inhalt.</p>'}</article>
      ${wk.files.length ? `<h3 class="sheet-sub">Anhänge</h3>
        <ul class="wiki-files">${wk.files.map(f => `<li><button class="wiki-file" data-open-file="${f.id}">
          <span class="file-icon">${fileIcon(f.mime)}</span>
          <span class="file-text"><span class="file-name">${escapeHtml(f.name)}</span>
          <span class="file-size">${sizeText(f.size)}${f.pages ? ` · ${f.pages} Seiten` : ""}${/pdf/.test(f.mime) ? (f.has_text ? " · durchsuchbar ✓" : " · kein Text (eingescannt)") : ""}</span></span>
        </button></li>`).join("")}</ul>` : ""}`;

    const art = $("#wiki-page .wiki-content");
    art.querySelectorAll("a[href]").forEach(a => {
      if (!a.getAttribute("href").startsWith("#/")) { a.target = "_blank"; a.rel = "noopener"; }
    });
    if (p.kind === "template") {
      art.innerHTML = art.innerHTML.replace(/\{\{\s*([^{}<>]{1,40}?)\s*\}\}/g, '<span class="ph">{{$1}}</span>');
    }
    fillImages(art);
  }

  // =========================================================
  // Editor
  // =========================================================
  function categoryOptions() {
    const used = wk.pages.map(p => p.category).filter(Boolean);
    return [...new Set([...used, ...DEFAULT_CATEGORIES])].sort((a, b) => a.localeCompare(b, "de"));
  }

  function renderTagPicker() {
    $("#wiki-edit-tags").innerHTML = wk.tags.length
      ? wk.tags.map(t => `<button type="button" class="chip chip-tag${wk.draftTags.has(t.id) ? " active" : ""}" data-pick-wiki-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags.</span>`;
  }

  function renderEditFiles() {
    const box = $("#wiki-edit-files");
    box.innerHTML = wk.editing && wk.files.length
      ? wk.files.map(f => `<li class="file-row">
          <span class="file-open"><span class="file-icon">${fileIcon(f.mime)}</span>
          <span class="file-text"><span class="file-name">${escapeHtml(f.name)}</span><span class="file-size">${sizeText(f.size)}${/pdf/.test(f.mime) ? (f.has_text ? " · durchsuchbar ✓" : " · kein Text") : ""}</span></span></span>
          <button type="button" class="icon-btn small" data-del-wiki-file="${f.id}" aria-label="Anhang löschen">✕</button>
        </li>`).join("")
      : `<li class="muted small">Noch keine Anhänge.</li>`;
  }

  function setKindUi() {
    const f = $("#form-wiki");
    const tpl = f.kind.value === "template";
    $("#wiki-subject-row").hidden = !tpl;
    $("#wiki-cat-row").hidden = tpl;
    $("#wiki-tpl-hint").hidden = !tpl;
  }

  async function openEditor(id, preset = {}) {
    if (id) {
      if (!wk.current || wk.current.id !== id) await loadPage(id);
    } else {
      wk.current = null;
      wk.files = [];
    }
    const p = id ? wk.current : null;
    wk.editing = p ? p.id : null;
    wk.draftTags = new Set(p ? p.tag_ids : []);
    const f = $("#form-wiki");
    f.reset();
    f.icon.value = p ? p.icon : (preset.icon || "");
    f.title.value = p ? p.title : (preset.title || "");
    f.kind.value = p ? p.kind : (preset.kind || (wk.filter === "__tpl" ? "template" : "page"));
    f.category.value = p ? p.category : (preset.category || (wk.filter && wk.filter !== "__tpl" ? wk.filter : ""));
    f.subject.value = p ? p.subject : (preset.subject || "");
    f.is_private.checked = p ? p.is_private : false;
    f.is_private.disabled = !!(p && p.created_by !== me());
    f.is_pinned.checked = p ? p.is_pinned : false;
    $("#wiki-cats").innerHTML = categoryOptions().map(c => `<option value="${escapeHtml(c)}"></option>`).join("");
    const ed = $("#wiki-editor");
    ed.innerHTML = p ? sanitize(p.content_html) : (preset.html || "");
    fillImages(ed);
    setKindUi();
    renderTagPicker();
    renderEditFiles();
    $("#wiki-sheet-title").textContent = p ? "Seite bearbeiten" : "Neue Seite";
    $("#btn-wiki-delete").hidden = !p;
    openSheet("sheet-wiki");
    if (!p) setTimeout(() => f.title.focus(), 60);
  }

  function editorHtml() {
    const ed = $("#wiki-editor").cloneNode(true);
    ed.querySelectorAll("img").forEach(i => i.removeAttribute("src"));
    return sanitize(ed.innerHTML);
  }

  async function save(silent = false) {
    const f = $("#form-wiki");
    const title = f.title.value.trim();
    if (!title) throw new Error("Bitte einen Titel eingeben.");
    const html = editorHtml();
    const row = {
      title,
      icon: f.icon.value.trim().slice(0, 8),
      kind: f.kind.value,
      category: f.kind.value === "template" ? "Kommunikation" : f.category.value.trim().slice(0, 60),
      subject: f.kind.value === "template" ? f.subject.value.trim().slice(0, 300) : "",
      content_html: html,
      content_text: htmlToPlain(html).slice(0, 200000),
      tag_ids: [...wk.draftTags].filter(i => wk.tags.some(t => t.id === i)),
      is_pinned: f.is_pinned.checked
    };
    if (!f.is_private.disabled) row.is_private = f.is_private.checked;
    let res;
    if (wk.editing) res = await sb.from("wiki_pages").update(row).eq("id", wk.editing).select().single();
    else res = await sb.from("wiki_pages").insert({ ...row, household_id: hid(), is_private: !!row.is_private }).select().single();
    if (res.error) {
      if (/wiki_pages|does not exist/i.test(res.error.message)) throw new Error("Bitte zuerst das SQL aus Schritt 17 in Supabase ausführen.");
      throw res.error;
    }
    wk.editing = res.data.id;
    wk.current = res.data;
    upsertLocal(res.data);
    $("#btn-wiki-delete").hidden = false;
    $("#wiki-sheet-title").textContent = "Seite bearbeiten";
    if (!silent) toast("Gespeichert.");
    return res.data;
  }

  // Werkzeugleiste: Auswahl im Editor behalten (wichtig auf dem iPhone)
  $("#wiki-toolbar").addEventListener("pointerdown", e => { if (e.target.closest("button")) e.preventDefault(); });
  $("#wiki-toolbar").addEventListener("click", e => {
    const b = e.target.closest("button[data-cmd]");
    if (!b) return;
    const ed = $("#wiki-editor");
    ed.focus();
    const cmd = b.dataset.cmd;
    if (["h2", "h3", "p", "blockquote"].includes(cmd)) document.execCommand("formatBlock", false, cmd.toUpperCase());
    else if (cmd === "link") {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      const v = prompt("Adresse (https://…, Telefon, Mail) oder Titel einer Wiki-Seite:", "");
      if (!v) return;
      let href = v.trim();
      const page = wk.pages.find(p => p.title.toLowerCase() === href.toLowerCase());
      if (page) href = "#/wiki/" + page.id;
      else if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(href)) href = "mailto:" + href;
      else if (/^[+\d][\d\s/()-]{5,}$/.test(href)) href = "tel:" + href.replace(/[^\d+]/g, "");
      else if (!/^(https?:|mailto:|tel:|#\/)/i.test(href)) href = "https://" + href;
      if (text) document.execCommand("createLink", false, href);
      else document.execCommand("insertHTML", false, `<a href="${escapeHtml(href)}">${escapeHtml(page ? page.title : v)}</a>`);
    }
    else if (cmd === "image") $("#wiki-img-input").click();
    else if (cmd === "placeholder") {
      const name = prompt("Name des Platzhalters, z. B. Vertragsnummer:", "");
      if (name) document.execCommand("insertText", false, `{{${name.trim()}}}`);
    }
    else document.execCommand(cmd, false, null);
  });

  // Einfügen: nur bereinigtes HTML übernehmen
  $("#wiki-editor").addEventListener("paste", e => {
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData("text/html");
    const text = cd.getData("text/plain");
    if (!html && !text) return;
    e.preventDefault();
    document.execCommand("insertHTML", false, html ? sanitize(html) : plainToHtml(text));
  });

  // ---------- Bilder im Text ----------
  function loadImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Bild konnte nicht gelesen werden.")); };
      img.src = url;
    });
  }
  async function shrink(file) {
    try {
      const img = await loadImg(file);
      const scale = Math.min(1, MAX_IMG_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
      return blob || file;
    } catch { return file; }
  }

  $("#wiki-img-input").addEventListener("change", async e => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    try {
      if (!wk.editing) await save(true);
      for (const file of files) {
        const blob = await shrink(file);
        const path = `${hid()}/${wk.editing}/${crypto.randomUUID()}.jpg`;
        const up = await sb.storage.from("wiki-files").upload(path, blob, { contentType: "image/jpeg", upsert: false });
        if (up.error) throw up.error;
        const [url] = await signed([path]);
        const ed = $("#wiki-editor");
        ed.focus();
        document.execCommand("insertHTML", false, `<p><img data-path="${path}" src="${escapeHtml(url)}" alt=""></p>`);
      }
    } catch (err) {
      toast(translateError(err), true);
    }
  });

  // ---------- Anhänge (PDF-Text auslesen) ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("PDF-Leser konnte nicht geladen werden."));
      document.head.appendChild(s);
    });
  }

  async function pdfText(file, progress) {
    await loadScript(PDFJS);
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = pdf.numPages;
    let text = "";
    for (let i = 1; i <= Math.min(n, 1000) && text.length < MAX_TEXT; i++) {
      progress(i, n);
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      text += tc.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ") + "\n\n";
    }
    return { text: text.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT), pages: n };
  }

  function safeName(name) {
    return (name || "datei").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-100) || "datei";
  }

  $("#btn-wiki-file").addEventListener("click", () => $("#wiki-file-input").click());
  $("#wiki-file-input").addEventListener("change", async e => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    const btn = $("#btn-wiki-file");
    btn.disabled = true;
    try {
      if (!wk.editing) await save(true);
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024) { toast(`„${file.name}“ ist größer als 50 MB.`, true); continue; }
        let text = "", pages = null;
        const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            const r = await pdfText(file, (i, n) => { btn.textContent = `Text wird gelesen … ${i}/${n}`; });
            text = r.text; pages = r.pages;
          } catch (err) {
            console.warn("PDF-Text:", err);
            toast("Text der PDF konnte nicht gelesen werden – sie wird trotzdem gespeichert.", true);
          }
        } else if (/^text\//.test(file.type) && file.size < 2 * 1024 * 1024) {
          text = (await file.text()).slice(0, MAX_TEXT);
        }
        btn.textContent = "Lädt hoch …";
        const path = `${hid()}/${wk.editing}/${crypto.randomUUID()}-${safeName(file.name)}`;
        const type = file.type || (isPdf ? "application/pdf" : "application/octet-stream");
        const up = await sb.storage.from("wiki-files").upload(path, file, { contentType: type, upsert: false });
        if (up.error) throw up.error;
        const { data, error } = await sb.from("wiki_files").insert({
          page_id: wk.editing, household_id: hid(), path, name: file.name.slice(0, 255), size: file.size, mime: type, pages, text_content: text
        }).select("id, page_id, path, name, size, mime, pages, created_at").single();
        if (error) { await sb.storage.from("wiki-files").remove([path]); throw error; }
        wk.files.push({ ...data, has_text: !!text.trim() });
        toast(isPdf ? (text ? `„${file.name}“ gespeichert – Text ist durchsuchbar.` : `„${file.name}“ gespeichert (kein Text gefunden – eingescannt?).`) : `„${file.name}“ gespeichert.`);
      }
    } catch (err) {
      toast(translateError(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "📎 Anleitung / Datei hinzufügen";
      renderEditFiles();
    }
  });

  $("#wiki-edit-files").addEventListener("click", async e => {
    const b = e.target.closest("[data-del-wiki-file]");
    if (!b) return;
    const f = wk.files.find(x => x.id === b.dataset.delWikiFile);
    if (!f || !confirm(`Anhang „${f.name}“ löschen?`)) return;
    const { error } = await sb.from("wiki_files").delete().eq("id", f.id);
    if (error) { toast(translateError(error), true); return; }
    await sb.storage.from("wiki-files").remove([f.path]);
    wk.files = wk.files.filter(x => x.id !== f.id);
    renderEditFiles();
  });

  // ---------- Editor: Speichern, Löschen, Tags ----------
  $("#form-wiki").addEventListener("change", e => { if (e.target.name === "kind") setKindUi(); });
  $("#form-wiki").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const p = await save(true);
      closeSheets();
      toast("Seite gespeichert.");
      if (PP.route.param === p.id) showPage(p.id);
      else location.hash = "#/wiki/" + p.id;
    });
  });

  $("#sheet-wiki").addEventListener("click", e => {
    const b = e.target.closest("[data-pick-wiki-tag]");
    if (!b) return;
    const id = b.dataset.pickWikiTag;
    wk.draftTags.has(id) ? wk.draftTags.delete(id) : wk.draftTags.add(id);
    renderTagPicker();
  });

  async function addTag() {
    const input = $("#form-wiki").new_tag;
    const name = input.value.trim().slice(0, 40);
    if (!name) return;
    let tag = wk.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      const { data, error } = await sb.from("event_tags").insert({ household_id: hid(), name, color: TAG_COLORS[wk.tags.length % TAG_COLORS.length] })
        .select("id, name, color").single();
      if (error) { toast(translateError(error), true); return; }
      tag = data;
      wk.tags.push(tag);
    }
    wk.draftTags.add(tag.id);
    input.value = "";
    renderTagPicker();
  }
  $("#btn-wiki-tag-add").addEventListener("click", addTag);
  $("#form-wiki").new_tag.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });

  $("#btn-wiki-delete").addEventListener("click", async () => {
    const p = wk.current;
    if (!p || !confirm(`Seite „${p.title}“ mit allen Anhängen löschen?`)) return;
    try {
      const folder = `${p.household_id}/${p.id}`;
      const { data: objs } = await sb.storage.from("wiki-files").list(folder, { limit: 1000 });
      if (objs && objs.length) await sb.storage.from("wiki-files").remove(objs.map(o => `${folder}/${o.name}`));
      const { error } = await sb.from("wiki_pages").delete().eq("id", p.id);
      if (error) throw error;
      wk.pages = wk.pages.filter(x => x.id !== p.id);
      closeSheets();
      toast("Seite gelöscht.");
      location.hash = "#/wiki";
    } catch (err) {
      toast(translateError(err), true);
    }
  });

  // =========================================================
  // Vorlage verwenden
  // =========================================================
  function placeholders(...texts) {
    const set = [];
    for (const t of texts) for (const m of String(t || "").matchAll(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g)) if (!set.includes(m[1])) set.push(m[1]);
    return set;
  }

  function autoValue(name) {
    const n = name.toLowerCase();
    if (/^datum|heute/.test(n)) return new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    if (/^(name|mein name|absender|unterschrift)$/.test(n)) return (state.profile && state.profile.display_name) || "";
    try { return (JSON.parse(storageGet("pp_wiki_ph") || "{}"))[name] || ""; } catch { return ""; }
  }

  function fill(text, values) {
    return String(text || "").replace(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g, (m, k) => (values[k] && values[k].trim()) ? values[k] : `[${k}]`);
  }

  function openUse() {
    const p = wk.current;
    const names = placeholders(p.subject, p.content_text);
    $("#wiki-use-title").textContent = p.title;
    $("#wiki-use-fields").innerHTML = names.length
      ? names.map((n, i) => `<label>${escapeHtml(n)}<input type="text" data-ph="${escapeHtml(n)}" value="${escapeHtml(autoValue(n))}" ${i === 0 ? "autofocus" : ""}></label>`).join("")
      : `<p class="muted small">Diese Vorlage hat keine Platzhalter. Tipp: Beim Bearbeiten mit {{Name}} Platzhalter einfügen.</p>`;
    updateUse();
    openSheet("sheet-wiki-use");
  }

  function useValues() {
    const v = {};
    document.querySelectorAll("#wiki-use-fields [data-ph]").forEach(i => { v[i.dataset.ph] = i.value; });
    return v;
  }

  function updateUse() {
    const p = wk.current;
    const v = useValues();
    $("#wiki-use-subject").value = fill(p.subject, v);
    $("#wiki-use-body").value = fill(p.content_text, v);
  }

  $("#wiki-use-fields").addEventListener("input", updateUse);

  function rememberValues() {
    try {
      const all = JSON.parse(storageGet("pp_wiki_ph") || "{}");
      Object.entries(useValues()).forEach(([k, val]) => { if (val && !/^datum/i.test(k)) all[k] = val; });
      storageSet("pp_wiki_ph", JSON.stringify(all));
    } catch { /* egal */ }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Kopiert."); }
    catch { toast("Kopieren nicht möglich – bitte Text markieren und kopieren.", true); }
  }
  function mail(subject, body) {
    location.href = `mailto:?subject=${encodeURIComponent(subject || "")}&body=${encodeURIComponent(body || "")}`;
  }
  async function share(subject, body) {
    if (navigator.share) { try { await navigator.share({ title: subject || undefined, text: body }); } catch { /* abgebrochen */ } }
    else copy(body);
  }

  $("#sheet-wiki-use").addEventListener("click", e => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const subject = $("#wiki-use-subject").value, body = $("#wiki-use-body").value;
    rememberValues();
    if (b.dataset.act === "copy") copy(body);
    if (b.dataset.act === "mail") mail(subject, body);
    if (b.dataset.act === "share") share(subject, body);
    if (b.dataset.act === "ai") openCompose({ base: (subject ? `Betreff: ${subject}\n\n` : "") + body, from: wk.current.title });
  });

  // =========================================================
  // Formulieren mit KI
  // =========================================================
  async function invokeAssist(payload) {
    const { data, error } = await sb.functions.invoke("assist", { body: payload });
    if (error) {
      let msg = error.message, status = "";
      try {
        const res = error.context; status = res && res.status;
        const raw = await res.text();
        try { const j = JSON.parse(raw); msg = j.error || j.message || raw; } catch { if (raw) msg = raw.slice(0, 200); }
      } catch { /* keine Antwort */ }
      if (status === 404) msg = "Die Funktion „assist“ ist noch nicht eingerichtet.";
      throw new Error(msg);
    }
    return data;
  }

  function openCompose(opts = {}) {
    const f = $("#form-compose");
    f.reset();
    f.base.value = opts.base || "";
    $("#compose-base-row").hidden = !opts.base;
    $("#compose-base-label").textContent = opts.from ? `Grundlage: „${opts.from}“` : "Grundlage";
    f.type.value = storageGet("pp_compose_type") || "mail";
    f.tone.value = storageGet("pp_compose_tone") || "freundlich";
    $("#compose-result").hidden = true;
    openSheet("sheet-wiki-compose");
  }

  $("#form-compose").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const btn = f.querySelector('button[type="submit"]');
      btn.textContent = "✨ Formuliert …";
      try {
        storageSet("pp_compose_type", f.type.value);
        storageSet("pp_compose_tone", f.tone.value);
        const r = await invokeAssist({
          action: "compose", type: f.type.value, tone: f.tone.value, recipient: f.recipient.value,
          points: f.points.value, base: f.base.value, sender: (state.profile && state.profile.display_name) || "",
          model: f.thorough.checked ? "sonnet" : "haiku"
        });
        $("#compose-subject").value = r.subject || "";
        $("#compose-subject-row").hidden = f.type.value === "nachricht";
        $("#compose-body").value = r.body || "";
        $("#compose-result").hidden = false;
        $("#compose-result").scrollIntoView({ behavior: "smooth", block: "start" });
      } finally {
        btn.textContent = "✨ Formulieren";
      }
    });
  });

  $("#compose-result").addEventListener("click", async e => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const subject = $("#compose-subject").value, body = $("#compose-body").value;
    if (b.dataset.act === "copy") copy(body);
    if (b.dataset.act === "mail") mail(subject, body);
    if (b.dataset.act === "share") share(subject, body);
    if (b.dataset.act === "save") {
      const title = prompt("Name der Vorlage:", subject || "Neue Vorlage");
      if (!title) return;
      const { data, error } = await sb.from("wiki_pages").insert({
        household_id: hid(), kind: "template", title: title.slice(0, 200), category: "Kommunikation",
        subject: subject.slice(0, 300), content_html: plainToHtml(body), content_text: body.slice(0, 200000)
      }).select().single();
      if (error) { toast(translateError(error), true); return; }
      upsertLocal(data);
      closeSheets();
      toast("Als Vorlage gespeichert.");
      location.hash = "#/wiki/" + data.id;
    }
  });

  // =========================================================
  // Frag das Wiki
  // =========================================================
  function renderAnswer(text, sources) {
    const byN = Object.fromEntries((sources || []).map(s => [s.n, s]));
    const lines = escapeHtml(text).split("\n");
    let html = "", list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trim();
      let m;
      if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${m[2]}</li>`; }
      else if ((m = line.match(/^[-•*]\s+(.*)$/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${m[1]}</li>`; }
      else if (!line) { close(); }
      else { close(); html += `<p>${line}</p>`; }
    }
    close();
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(>])\*([^*\s][^*]*?)\*(?=[\s.,;:!?)<]|$)/g, "$1<em>$2</em>")
      .replace(/\[(\d+)\]/g, (m, n) => byN[n] ? `<a class="src-ref" href="#/wiki/${byN[n].page_id}">${n}</a>` : m);
    return html;
  }

  $("#form-ask").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    const q = f.question.value.trim();
    if (!q) return;
    PP.withBusy(f, async () => {
      $("#ask-answer").innerHTML = `<p class="muted">✨ Claude sucht in eurem Wiki …</p>`;
      try {
        const r = await invokeAssist({ action: "ask", question: q });
        $("#ask-answer").innerHTML = `<div class="ask-text">${renderAnswer(r.answer, r.sources)}</div>` +
          (r.sources && r.sources.length ? `<h3 class="sheet-sub">Quellen</h3><ul class="ask-sources">${r.sources.map(s =>
            `<li><a href="#/wiki/${s.page_id}"><span class="src-ref">${s.n}</span> ${escapeHtml(s.title)}${s.file ? ` · 📎 ${escapeHtml(s.file)}` : ""}</a></li>`).join("")}</ul>` : "");
      } catch (err) {
        $("#ask-answer").innerHTML = "";
        throw err;
      }
    });
  });
  $("#ask-answer").addEventListener("click", e => { if (e.target.closest("a[href^='#/wiki/']")) closeSheets(); });

  // =========================================================
  // Klicks in der Ansicht
  // =========================================================
  $("#view-wiki").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.wikiFilter !== undefined) {
      wk.filter = t.dataset.wikiFilter;
      storageSet("pp_wiki_filter", wk.filter);
      renderList();
      return;
    }
    if (t.id === "btn-wiki-add") { openEditor(null); return; }
    if (t.id === "btn-wiki-ask") { $("#form-ask").reset(); $("#ask-answer").innerHTML = ""; openSheet("sheet-wiki-ask"); setTimeout(() => $("#form-ask").question.focus(), 60); return; }
    if (t.id === "btn-wiki-compose") { openCompose(); return; }
    if (t.hasAttribute("data-wiki-edit")) { openEditor(wk.current.id); return; }
    if (t.hasAttribute("data-wiki-use")) { openUse(); return; }
    if (t.hasAttribute("data-wiki-ai-template")) {
      const p = wk.current;
      openCompose({ base: (p.subject ? `Betreff: ${p.subject}\n\n` : "") + p.content_text, from: p.title });
      return;
    }
    if (t.dataset.openFile) {
      const f = wk.files.find(x => x.id === t.dataset.openFile);
      if (!f) return;
      const win = window.open("", "_blank");
      signed([f.path]).then(([url]) => {
        if (!url) { if (win) win.close(); toast("Datei konnte nicht geöffnet werden.", true); return; }
        if (win) win.location.href = url; else location.href = url;
      });
    }
  });

  $("#wiki-search").addEventListener("input", e => { wk.query = e.target.value; scheduleSearch(); });

  // =========================================================
  // Modul
  // =========================================================
  async function refreshTile() {
    if (!state.household) return;
    const { count, error } = await sb.from("wiki_pages").select("id", { count: "exact", head: true }).eq("household_id", hid());
    $("#tile-wiki-status").textContent = error ? "Öffnen" : (count ? `${count} Seite${count === 1 ? "" : "n"}` : "Öffnen");
  }

  PP.modules.wiki = {
    async enter() {
      const first = !wk.active;
      wk.active = true;
      const param = PP.route.param;
      try {
        if (first || !wk.pages.length) await loadList();
        if (first) subscribe();
      } catch (err) {
        console.error(err);
        toast(/wiki_pages|does not exist/i.test(err.message || "") ? "Bitte zuerst das SQL aus Schritt 17 in Supabase ausführen." : translateError(err), true);
      }
      if (param) {
        showPage(param);
      } else {
        wk.current = null;
        $("#wiki-page-wrap").hidden = true;
        $("#wiki-list-wrap").hidden = false;
        $("#wiki-search").value = wk.query;
        renderList();
      }
    },
    leave() {
      wk.active = false;
      unsubscribe();
      closeSheets();
    },
    async resume() {
      if (wk.active) { try { await loadList(); if (PP.route.param) showPage(PP.route.param); else renderList(); } catch (err) { console.error(err); } }
      else refreshTile();
    },
    refreshTile,
    reset() { this.leave(); wk.pages = []; wk.current = null; wk.urls = new Map(); }
  };

  PP._wiki = { sanitize, htmlToPlain, placeholders, fill, renderAnswer };
})();
