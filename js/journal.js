// =========================================================
// Pichis Planner – Tagebuch (nur für die eigene Person)
// Texte, Bilder, Stimmungsbarometer, Erinnerung
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, openSheet, closeSheets } = PP;

  const MOODS = [
    { v: 1, emoji: "😞", label: "Mies", color: "#B5402B" },
    { v: 2, emoji: "🙁", label: "Nicht so gut", color: "#E0703F" },
    { v: 3, emoji: "😐", label: "Okay", color: "#B7791F" },
    { v: 4, emoji: "🙂", label: "Gut", color: "#6B9E4A" },
    { v: 5, emoji: "😄", label: "Super", color: "#2F5D50" }
  ];
  const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const WD = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  const MAX_PX = 2000;   // Bilder werden auf diese Kantenlänge verkleinert

  const jn = {
    active: false,
    entries: [],
    images: new Map(),   // entry_id → [bild]
    urls: new Map(),     // path → { url, until }
    query: "",
    editing: null,       // ID des Eintrags im Editor (null = neu)
    draftMood: null,
    dirty: false
  };

  const me = () => state.session.user.id;
  const pad = n => String(n).padStart(2, "0");
  function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function longDate(iso) {
    const d = parseIso(iso);
    return `${WD[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}`;
  }
  const moodOf = v => MOODS.find(m => m.v === v) || null;

  function missingSql(err) {
    return /journal_|relation .*does not exist|Bucket not found/i.test((err && err.message) || "");
  }

  // ---------- Daten ----------
  async function loadAll() {
    const [e, i] = await Promise.all([
      sb.from("journal_entries").select("*").eq("user_id", me())
        .order("entry_date", { ascending: false }).order("created_at", { ascending: false }),
      sb.from("journal_images").select("id, entry_id, path, width, height, created_at").eq("user_id", me())
        .order("created_at", { ascending: true })
    ]);
    if (e.error) throw e.error;
    if (i.error) throw i.error;
    jn.entries = e.data.sort((a, b) => b.entry_date.localeCompare(a.entry_date) || String(b.created_at).localeCompare(String(a.created_at)));
    jn.images = new Map();
    for (const img of i.data) {
      if (!jn.images.has(img.entry_id)) jn.images.set(img.entry_id, []);
      jn.images.get(img.entry_id).push(img);
    }
  }

  const imagesOf = id => jn.images.get(id) || [];

  // Geschützte Bild-Adressen (1 Stunde gültig), gesammelt angefragt
  async function signedUrls(paths) {
    const now = Date.now();
    const need = paths.filter(p => { const c = jn.urls.get(p); return !c || c.until < now + 60000; });
    if (need.length) {
      const { data, error } = await sb.storage.from("journal").createSignedUrls(need, 3600);
      if (!error && data) {
        for (const d of data) if (d.signedUrl) jn.urls.set(d.path, { url: d.signedUrl, until: now + 3600 * 1000 });
      }
    }
    return paths.map(p => (jn.urls.get(p) || {}).url || "");
  }

  async function fillImages(root) {
    const imgs = [...root.querySelectorAll("img[data-path]")];
    if (!imgs.length) return;
    const urls = await signedUrls(imgs.map(i => i.dataset.path));
    imgs.forEach((img, k) => { if (urls[k]) img.src = urls[k]; });
  }

  // ---------- Darstellung ----------
  function moodChart() {
    // Letzte 30 Tage: je Tag der Durchschnitt der Einträge
    const byDay = new Map();
    for (const e of jn.entries) {
      if (!e.mood) continue;
      if (!byDay.has(e.entry_date)) byDay.set(e.entry_date, []);
      byDay.get(e.entry_date).push(e.mood);
    }
    const days = [];
    const t = parseIso(todayIso());
    for (let i = 29; i >= 0; i--) {
      const d = new Date(t); d.setDate(d.getDate() - i);
      const iso = isoDate(d);
      const list = byDay.get(iso);
      days.push({ iso, d, v: list ? list.reduce((a, b) => a + b, 0) / list.length : null });
    }
    const withMood = days.filter(x => x.v !== null);
    if (!withMood.length) return "";

    const last7 = days.slice(-7).filter(x => x.v !== null);
    const avg7 = last7.length ? last7.reduce((a, x) => a + x.v, 0) / last7.length : null;
    const avgMood = avg7 ? moodOf(Math.round(avg7)) : null;

    const bars = days.map(x => {
      if (x.v === null) return `<span class="mood-bar mood-none" title="${escapeHtml(longDate(x.iso))}: kein Eintrag"></span>`;
      const m = moodOf(Math.round(x.v));
      return `<span class="mood-bar" style="height:${20 + x.v * 16}%;background:${m.color}" title="${escapeHtml(longDate(x.iso))}: ${m.label}"></span>`;
    }).join("");

    return `<div class="card mood-card">
      <div class="mood-head">
        <span class="mood-title">Stimmung · letzte 30 Tage</span>
        ${avgMood ? `<span class="mood-avg">Ø 7 Tage: ${avgMood.emoji} ${avgMood.label}</span>` : ""}
      </div>
      <div class="mood-chart" role="img" aria-label="Stimmungsverlauf der letzten 30 Tage">${bars}</div>
      <div class="mood-axis"><span>vor 30 Tagen</span><span>heute</span></div>
    </div>`;
  }

  function entryCard(e) {
    const m = moodOf(e.mood);
    const imgs = imagesOf(e.id);
    const text = e.body.length > 220 ? e.body.slice(0, 220) + " …" : e.body;
    return `<li><button class="jn-card" data-entry="${e.id}">
      <span class="jn-date">
        <span class="jn-day">${parseIso(e.entry_date).getDate()}</span>
        <span class="jn-wd">${WD[parseIso(e.entry_date).getDay()].slice(0, 2)}</span>
      </span>
      <span class="jn-main">
        <span class="jn-top">
          ${m ? `<span class="jn-mood" title="${m.label}">${m.emoji}</span>` : ""}
          <span class="jn-title">${escapeHtml(e.title || (m ? m.label : "Eintrag"))}</span>
        </span>
        ${text ? `<span class="jn-text">${escapeHtml(text)}</span>` : ""}
        ${imgs.length ? `<span class="jn-thumbs">${imgs.slice(0, 4).map(i => `<img data-path="${escapeHtml(i.path)}" alt="" loading="lazy">`).join("")}${imgs.length > 4 ? `<span class="jn-more">+${imgs.length - 4}</span>` : ""}</span>` : ""}
      </span>
    </button></li>`;
  }

  function render() {
    if (!jn.active) return;
    const t = todayIso();
    const hasToday = jn.entries.some(e => e.entry_date === t);
    $("#jn-today").innerHTML = hasToday
      ? `<span>✓ Heute hast du schon geschrieben.</span>`
      : `<span>Wie war dein Tag?</span>`;

    $("#jn-chart").innerHTML = moodChart();

    const q = jn.query.trim().toLowerCase();
    const list = jn.entries.filter(e => !q || (e.title + " " + e.body).toLowerCase().includes(q));
    let html = "", month = "";
    for (const e of list) {
      const d = parseIso(e.entry_date);
      const key = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      if (key !== month) {
        if (month) html += `</ul></section>`;
        html += `<section class="cat-group"><h3 class="cat-title">${key}</h3><ul class="jn-list">`;
        month = key;
      }
      html += entryCard(e);
    }
    if (month) html += `</ul></section>`;
    $("#jn-items").innerHTML = html || `<div class="empty">
      <div class="empty-icon">📔</div>
      <p><strong>${jn.entries.length ? "Nichts gefunden." : "Dein Tagebuch ist noch leer."}</strong></p>
      <p class="muted small">Nur du kannst deine Einträge sehen – auch die Familie nicht.</p>
    </div>`;
    fillImages($("#jn-items"));
  }

  // ---------- Editor ----------
  function renderMoodPicker() {
    $("#jn-moods").innerHTML = MOODS.map(m =>
      `<button type="button" class="mood-btn${jn.draftMood === m.v ? " active" : ""}" data-mood="${m.v}" style="--mood:${m.color}" aria-label="${m.label}">
        <span class="mood-emoji">${m.emoji}</span><span class="mood-label">${m.label}</span>
      </button>`).join("");
  }

  function renderEditorImages() {
    const imgs = jn.editing ? imagesOf(jn.editing) : [];
    $("#jn-images").innerHTML = imgs.map(i => `<li>
        <button type="button" class="jn-img" data-open-img="${i.id}"><img data-path="${escapeHtml(i.path)}" alt=""></button>
        <button type="button" class="jn-img-del" data-del-img="${i.id}" aria-label="Bild entfernen">✕</button>
      </li>`).join("");
    fillImages($("#jn-images"));
  }

  function openEditor(id, preset = {}) {
    const e = id ? jn.entries.find(x => x.id === id) : null;
    jn.editing = e ? e.id : null;
    jn.draftMood = e ? e.mood : null;
    jn.dirty = false;
    const f = $("#form-jn");
    f.reset();
    f.entry_date.value = e ? e.entry_date : (preset.date || todayIso());
    f.title.value = e ? e.title : "";
    f.body.value = e ? e.body : "";
    $("#jn-sheet-title").textContent = e ? longDate(e.entry_date) : "Neuer Eintrag";
    $("#btn-jn-delete").hidden = !e;
    renderMoodPicker();
    renderEditorImages();
    openSheet("sheet-jn");
    autoGrow();
  }

  function autoGrow() {
    const el = $("#form-jn").body;
    el.style.height = "auto";
    el.style.height = Math.min(Math.max(el.scrollHeight, 160), window.innerHeight * 0.5) + "px";
  }

  function formRow() {
    const f = $("#form-jn");
    return {
      entry_date: f.entry_date.value || todayIso(),
      title: f.title.value.trim(),
      body: f.body.value.replace(/\s+$/, ""),
      mood: jn.draftMood
    };
  }

  async function save(allowEmpty = false) {
    const row = formRow();
    if (!allowEmpty && !row.title && !row.body.trim() && !row.mood && !imagesOf(jn.editing).length) {
      throw new Error("Schreib etwas, wähle eine Stimmung oder füge ein Bild hinzu.");
    }
    let res;
    if (jn.editing) res = await sb.from("journal_entries").update(row).eq("id", jn.editing).select().single();
    else res = await sb.from("journal_entries").insert({ ...row, user_id: me() }).select().single();
    if (res.error) throw res.error;
    const i = jn.entries.findIndex(x => x.id === res.data.id);
    if (i >= 0) jn.entries[i] = res.data; else jn.entries.push(res.data);
    jn.entries.sort((a, b) => b.entry_date.localeCompare(a.entry_date) || String(b.created_at).localeCompare(String(a.created_at)));
    jn.editing = res.data.id;
    jn.dirty = false;
    $("#btn-jn-delete").hidden = false;
    return res.data;
  }

  $("#form-jn").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      try {
        await save();
      } catch (err) {
        if (missingSql(err)) throw new Error("Bitte zuerst das SQL aus Schritt 13 in Supabase ausführen.");
        throw err;
      }
      closeSheets();
      render();
      refreshTile();
      toast("Eintrag gespeichert.");
    });
  });

  $("#form-jn").body.addEventListener("input", () => { jn.dirty = true; autoGrow(); });
  $("#form-jn").title.addEventListener("input", () => { jn.dirty = true; });
  $("#form-jn").entry_date.addEventListener("change", e => {
    jn.dirty = true;
    if (e.target.value) $("#jn-sheet-title").textContent = longDate(e.target.value);
  });

  $("#jn-moods").addEventListener("click", e => {
    const b = e.target.closest("[data-mood]");
    if (!b) return;
    const v = +b.dataset.mood;
    jn.draftMood = jn.draftMood === v ? null : v;
    jn.dirty = true;
    renderMoodPicker();
  });

  // ---------- Bilder ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Bild konnte nicht gelesen werden.")); };
      img.src = url;
    });
  }

  // Verkleinern auf max. 2000 px und als JPEG speichern
  async function shrink(file) {
    try {
      const img = await loadImage(file);
      const scale = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.85));
      if (blob && (blob.size < file.size || scale < 1)) return { blob, w, h, type: "image/jpeg", ext: "jpg" };
      return { blob: file, w: img.naturalWidth, h: img.naturalHeight, type: file.type || "image/jpeg", ext: (file.type.split("/")[1] || "jpg").replace("jpeg", "jpg") };
    } catch {
      return { blob: file, w: null, h: null, type: file.type || "image/jpeg", ext: "jpg" };
    }
  }

  async function addImages(files) {
    const btn = $("#btn-jn-img");
    btn.disabled = true;
    let ok = 0;
    try {
      if (!jn.editing) await save(true);   // Eintrag zuerst anlegen
      for (const file of files) {
        if (!/^image\//.test(file.type || "image/")) continue;
        btn.textContent = `Lädt hoch … (${ok + 1}/${files.length})`;
        const s = await shrink(file);
        const path = `${me()}/${jn.editing}/${crypto.randomUUID()}.${s.ext}`;
        const up = await sb.storage.from("journal").upload(path, s.blob, { contentType: s.type, upsert: false });
        if (up.error) throw up.error;
        const { data, error } = await sb.from("journal_images").insert({
          entry_id: jn.editing, user_id: me(), path, width: s.w, height: s.h, size: s.blob.size
        }).select("id, entry_id, path, width, height, created_at").single();
        if (error) { await sb.storage.from("journal").remove([path]); throw error; }
        if (!jn.images.has(jn.editing)) jn.images.set(jn.editing, []);
        jn.images.get(jn.editing).push(data);
        ok++;
      }
      if (ok) toast(ok === 1 ? "Bild hinzugefügt." : `${ok} Bilder hinzugefügt.`);
    } catch (err) {
      toast(missingSql(err) ? "Bitte zuerst das SQL aus Schritt 13 in Supabase ausführen." : translateError(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "📷 Bild hinzufügen";
      renderEditorImages();
      render();
    }
  }

  $("#btn-jn-img").addEventListener("click", () => $("#jn-file").click());
  $("#jn-file").addEventListener("change", e => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) addImages(files);
  });

  $("#jn-images").addEventListener("click", async e => {
    const open = e.target.closest("[data-open-img]");
    const del = e.target.closest("[data-del-img]");
    const imgs = imagesOf(jn.editing);
    if (open) {
      const img = imgs.find(i => i.id === open.dataset.openImg);
      if (!img) return;
      const [url] = await signedUrls([img.path]);
      $("#jn-viewer-img").src = url;
      $("#jn-viewer").hidden = false;
    }
    if (del) {
      const img = imgs.find(i => i.id === del.dataset.delImg);
      if (!img || !confirm("Bild aus dem Eintrag entfernen?")) return;
      const { error } = await sb.from("journal_images").delete().eq("id", img.id);
      if (error) { toast(translateError(error), true); return; }
      await sb.storage.from("journal").remove([img.path]);
      jn.images.set(jn.editing, imgs.filter(i => i.id !== img.id));
      renderEditorImages();
      render();
    }
  });

  $("#jn-viewer").addEventListener("click", () => {
    $("#jn-viewer").hidden = true;
    $("#jn-viewer-img").removeAttribute("src");
  });

  $("#btn-jn-delete").addEventListener("click", async () => {
    const e = jn.entries.find(x => x.id === jn.editing);
    if (!e || !confirm(`Eintrag vom ${longDate(e.entry_date)} endgültig löschen?`)) return;
    const paths = imagesOf(e.id).map(i => i.path);
    if (paths.length) await sb.storage.from("journal").remove(paths);
    const { error } = await sb.from("journal_entries").delete().eq("id", e.id);
    if (error) { toast(translateError(error), true); return; }
    jn.entries = jn.entries.filter(x => x.id !== e.id);
    jn.images.delete(e.id);
    closeSheets();
    render();
    refreshTile();
  });

  // ---------- Erinnerung ----------
  async function pushActive() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
      const reg = await navigator.serviceWorker.ready;
      return !!(await reg.pushManager.getSubscription());
    } catch { return false; }
  }

  async function renderReminder() {
    const p = state.profile || {};
    const f = $("#form-jn-reminder");
    f.enabled.checked = !!p.journal_reminder;
    f.time.value = p.journal_reminder_time ? String(p.journal_reminder_time).slice(0, 5) : "21:00";
    $("#jn-reminder-time").hidden = !f.enabled.checked;
    const hint = $("#jn-reminder-hint");
    if (f.enabled.checked && !(await pushActive())) {
      hint.hidden = false;
      hint.textContent = "Mitteilungen sind auf diesem Gerät noch nicht eingeschaltet – Personen-Symbol oben rechts → „Mitteilungen aufs Handy“.";
    } else {
      hint.hidden = true;
    }
  }

  $("#form-jn-reminder").addEventListener("change", async e => {
    const f = $("#form-jn-reminder");
    $("#jn-reminder-time").hidden = !f.enabled.checked;
    const now = new Date();
    const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const time = f.time.value || "21:00";
    const update = {
      journal_reminder: f.enabled.checked,
      journal_reminder_time: time,
      // Uhrzeit heute schon vorbei? Dann ab morgen erinnern.
      journal_reminder_last: time <= nowHm ? todayIso() : null
    };
    const { error } = await sb.from("profiles").update(update).eq("id", me());
    if (error) {
      f.enabled.checked = !!(state.profile && state.profile.journal_reminder);
      toast(/journal_reminder/.test(error.message) ? "Bitte zuerst das SQL aus Schritt 13 in Supabase ausführen." : translateError(error), true);
      return;
    }
    Object.assign(state.profile, update);
    renderReminder();
    if (e.target.name === "enabled" || e.target.name === "time") {
      toast(f.enabled.checked ? `Erinnerung täglich um ${time} Uhr – nur wenn du noch nichts geschrieben hast.` : "Erinnerung ausgeschaltet.");
    }
  });

  // ---------- Ansicht ----------
  $("#view-journal").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.entry) { openEditor(t.dataset.entry); return; }
    if (t.id === "btn-jn-add") {
      const today = jn.entries.find(x => x.entry_date === todayIso());
      if (today && !confirm("Für heute gibt es schon einen Eintrag. Einen weiteren anlegen?\n(Abbrechen öffnet den vorhandenen.)")) {
        openEditor(today.id);
      } else {
        openEditor(null);
      }
    }
  });
  $("#jn-search").addEventListener("input", e => { jn.query = e.target.value; render(); });

  // ---------- Kachel ----------
  async function refreshTile() {
    if (!state.session) return;
    const { count, error } = await sb.from("journal_entries")
      .select("id", { count: "exact", head: true }).eq("user_id", me()).eq("entry_date", todayIso());
    $("#tile-jn-status").textContent = error ? "Nur für dich" : (count ? "Heute geschrieben ✓" : "Nur für dich");
  }

  PP.modules.journal = {
    async enter() {
      jn.active = true;
      renderReminder();
      try {
        await loadAll();
        render();
      } catch (err) {
        console.error(err);
        toast(missingSql(err) ? "Bitte zuerst das SQL aus Schritt 13 in Supabase ausführen." : translateError(err), true);
      }
    },
    leave() {
      jn.active = false;
      closeSheets();
      $("#jn-viewer").hidden = true;
    },
    async resume() {
      if (jn.active) {
        try { await loadAll(); render(); } catch (err) { console.error(err); }
      } else {
        refreshTile();
      }
    },
    refreshTile,
    reset() {
      this.leave();
      jn.entries = [];
      jn.images = new Map();
      jn.urls = new Map();
    }
  };
})();
