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

  async function uploadFile(file, folder) {
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/hidrive`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/octet-stream", "x-pp-action": "upload",
        "x-pp-name": encodeURIComponent(file.name), "x-pp-folder": encodeURIComponent(folder) },
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

  // ---------- Rückkehr von der STRATO-Anmeldung ----------
  // STRATO leitet mit ?code=…&state=… zurück auf die App. Wir merken uns das,
  // räumen die Adresse auf und verbinden, sobald die Anmeldung bereit ist.
  (() => {
    const u = new URL(location.href);
    const code = u.searchParams.get("code"), st = u.searchParams.get("state");
    if (code && st) {
      try { sessionStorage.setItem("pp_hidrive_cb", JSON.stringify({ code, state: st })); } catch { /* egal */ }
      history.replaceState(null, "", "/#/archiv");
    }
    if (u.searchParams.get("error")) {
      try { sessionStorage.setItem("pp_hidrive_err", u.searchParams.get("error_description") || u.searchParams.get("error")); } catch { /* egal */ }
      history.replaceState(null, "", "/#/archiv");
    }
  })();

  async function finishCallback() {
    let cb = null, err = null;
    try {
      cb = JSON.parse(sessionStorage.getItem("pp_hidrive_cb") || "null");
      err = sessionStorage.getItem("pp_hidrive_err");
      sessionStorage.removeItem("pp_hidrive_cb");
      sessionStorage.removeItem("pp_hidrive_err");
    } catch { /* egal */ }
    if (err) { toast("HiDrive-Anmeldung abgebrochen: " + err, true); return; }
    if (!cb) return;
    try {
      const r = await call("callback", cb);
      ar.status = { ...(ar.status || {}), connected: true, alias: r.alias, folder: r.folder, can_manage: true };
      toast(`HiDrive verbunden – Ordner „${r.folder.split("/").pop()}“ ist angelegt.`);
    } catch (e) {
      toast(e.message, true);
    }
  }

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
    const sub = [d.category, dateText(d.doc_date), sizeText(d.size)].filter(Boolean).map(escapeHtml).join(" · ");
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
    if (!s.connected) {
      box.innerHTML = `<div class="banner banner-action">
        <div><strong>📂 Mit STRATO HiDrive verbinden</strong>
        <div class="small">${s.can_manage
          ? "Die Dokumente werden in deinem HiDrive im Ordner „Pichis Planner Archiv“ abgelegt. Du meldest dich dazu einmal bei STRATO an."
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
    const list = ar.filter ? ar.docs.filter(d => d.category === ar.filter) : ar.docs;
    $("#ar-items").innerHTML = list.length
      ? `<ul class="ar-list">${list.map(d => row(d)).join("")}</ul>`
      : (ar.status && ar.status.connected ? `<div class="empty"><div class="empty-icon">🗄️</div>
          <p><strong>Noch keine Dokumente.</strong></p>
          <p class="muted small">Mit dem orangen + Verträge, Rechnungen oder Bescheide ablegen. Der Text in PDFs wird automatisch durchsuchbar.</p></div>` : "");
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
    $("#ar-cats").innerHTML = [...new Set([...ar.docs.map(d => d.category).filter(Boolean), ...CATEGORIES])].map(c => `<option value="${escapeHtml(c)}"></option>`).join("");
    if (files.length === 1) f.title.value = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    $("#ar-sheet-title").textContent = "Dokument ablegen";
    $("#ar-file-block").hidden = false;
    $("#ar-detail").hidden = true;
    $("#btn-ar-save").textContent = "Ablegen";
    $("#btn-ar-delete").hidden = true;
    $("#form-ar").is_private.disabled = false;
    renderPending();
    renderTagPicker();
    openSheet("sheet-archive");
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
    $("#ar-cats").innerHTML = [...new Set([...ar.docs.map(x => x.category).filter(Boolean), ...CATEGORIES])].map(c => `<option value="${escapeHtml(c)}"></option>`).join("");
    $("#ar-sheet-title").textContent = d.title;
    $("#ar-file-block").hidden = true;
    $("#ar-title-row").hidden = false;
    $("#ar-multi-hint").hidden = true;
    $("#ar-detail").hidden = false;
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
      if (ar.pending.length === 1 && !f.title.value) f.title.value = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
      renderPending();
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
          if (isPdf) {
            try {
              const r = await pdfText(file, (i, total) => { btn.textContent = `Text wird gelesen${n} … ${i}/${total}`; });
              text = r.text; pages = r.pages;
            } catch (err) { console.warn("PDF-Text:", err); }
          } else if (/^text\//.test(file.type) && file.size < 2 * 1024 * 1024) {
            text = (await file.text()).slice(0, MAX_TEXT);
          }
          btn.textContent = `Wird in HiDrive abgelegt${n} …`;
          const up = await uploadFile(file, meta.category);
          const title = (ar.pending.length === 1 && f.title.value.trim()) || file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
          const { error } = await sb.from("archive_docs").insert({
            household_id: hid(), ...meta, is_private: !!meta.is_private,
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
        if (done) { await loadAll(); render(); }
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
    if (b.dataset.arFilter !== undefined) { ar.filter = b.dataset.arFilter; storageSet("pp_ar_filter", ar.filter); render(); return; }
    if (b.dataset.arDoc) { openDoc(b.dataset.arDoc); return; }
    if (b.id === "btn-ar-add") { openAdd(); return; }
    if (b.id === "btn-ar-connect") {
      b.disabled = true;
      try { const { url } = await call("auth_url"); location.href = url; }
      catch (err) { toast(err.message, true); b.disabled = false; }
      return;
    }
    if (b.id === "btn-ar-disconnect") {
      if (!confirm("HiDrive-Verbindung trennen? Die Dateien bleiben in HiDrive, sind in der App aber erst nach dem erneuten Verbinden wieder abrufbar.")) return;
      try { await call("disconnect"); ar.status = { ...ar.status, connected: false }; render(); renderFooter(); toast("Verbindung getrennt."); }
      catch (err) { toast(err.message, true); }
    }
  });

  function renderFooter() {
    const s = ar.status;
    $("#ar-footer").innerHTML = s && s.connected
      ? `<p class="muted small">📂 HiDrive${s.alias ? " · " + escapeHtml(s.alias) : ""} · Ordner „${escapeHtml((s.folder || "").split("/").pop())}“${s.can_manage ? ` · <button class="link" id="btn-ar-disconnect">Trennen</button>` : ""}</p>`
      : "";
  }

  // ---------- Modul ----------
  PP.modules.archive = {
    async enter() {
      ar.active = true;
      $("#ar-search").value = ar.query;
      render();
      try {
        await finishCallback();
        const [st] = await Promise.all([call("status").catch(err => { toast(err.message, true); return null; }), loadAll()]);
        if (st) ar.status = st;
        subscribe();
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
      // nach der Rückkehr von STRATO direkt ins Archiv
      try { if (sessionStorage.getItem("pp_hidrive_cb") && location.hash !== "#/archiv") location.hash = "#/archiv"; } catch { /* egal */ }
      sb.from("archive_docs").select("id", { count: "exact", head: true }).eq("household_id", hid())
        .then(({ count, error }) => { $("#tile-ar-status").textContent = error ? "Öffnen" : (count ? `${count} Dokument${count === 1 ? "" : "e"}` : "HiDrive"); });
    },
    reset() { this.leave(); ar.docs = []; ar.status = null; }
  };
})();
