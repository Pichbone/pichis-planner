// =========================================================
// Pichis Planner – Geburtstage
// Liste nach Monaten, „Demnächst“, Tags, private Einträge,
// Import aus iPhone-Kontakten (vCard), Push-Erinnerungen
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, openSheet, closeSheets } = PP;

  const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const MON_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
  const REMIND = [[0, "Am Tag"], [1, "1 Tag vorher"], [3, "3 Tage vorher"], [7, "1 Woche vorher"], [14, "2 Wochen vorher"]];
  const TAG_COLORS = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];
  const SOON_DAYS = 30;

  const bd = {
    active: false,
    loaded: false,
    list: [],
    tags: [],
    filter: storageGet("pp_bd_filter") || "",
    query: "",
    editing: null,
    draftTags: new Set(),
    draftRemind: new Set([0]),
    importRows: [],
    importTag: "",
    channel: null
  };

  const me = () => state.session.user.id;
  const hid = () => state.household.id;
  const pad = n => String(n).padStart(2, "0");
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayIso = () => isoOf(new Date());

  // =========================================================
  // Datumsrechnung (29. Februar → 28. Februar in Nicht-Schaltjahren)
  // =========================================================
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

  function occurrence(b, year) {
    let day = b.birth_day;
    if (b.birth_month === 2 && day === 29 && !isLeap(year)) day = 28;
    return `${year}-${pad(b.birth_month)}-${pad(day)}`;
  }

  function daysBetween(fromIso, toIso) {
    return Math.round((Date.UTC(...toIso.split("-").map((v, i) => i === 1 ? v - 1 : +v)) -
      Date.UTC(...fromIso.split("-").map((v, i) => i === 1 ? v - 1 : +v))) / 86400000);
  }

  // Nächster Geburtstag ab heute (heute zählt mit)
  function next(b, fromIso = todayIso()) {
    const y = +fromIso.slice(0, 4);
    let date = occurrence(b, y);
    if (date < fromIso) date = occurrence(b, y + 1);
    const year = +date.slice(0, 4);
    return { date, days: daysBetween(fromIso, date), age: b.birth_year ? year - b.birth_year : null };
  }

  // Geburtstage an einem bestimmten Tag (für den Kalender)
  function on(list, iso) {
    const y = +iso.slice(0, 4);
    return (list || []).filter(b => occurrence(b, y) === iso).map(b => ({ ...b, age: b.birth_year ? y - b.birth_year : null }));
  }

  function countdown(days) {
    if (days === 0) return "heute 🎉";
    if (days === 1) return "morgen";
    if (days < 7) return `in ${days} Tagen`;
    if (days < 60) return `in ${days} Tagen`;
    const m = Math.round(days / 30.4);
    return `in ${m} Monaten`;
  }

  function ageText(b, n) {
    if (n.age == null || n.age < 0) return "";
    if (n.age === 0) return "wird geboren";
    return n.days === 0 ? `wird heute ${n.age}` : `wird ${n.age}`;
  }

  // =========================================================
  // Daten
  // =========================================================
  const FIELDS = "id, household_id, name, birth_month, birth_day, birth_year, relation, notes, tag_ids, remind_days, is_private, created_by, updated_at";

  async function loadAll() {
    const [b, t] = await Promise.all([
      sb.from("birthdays").select(FIELDS).eq("household_id", hid()).order("birth_month").order("birth_day"),
      sb.from("event_tags").select("id, name, color").eq("household_id", hid()).order("name")
    ]);
    if (b.error) throw b.error;
    bd.list = b.data;
    bd.tags = t.error ? [] : t.data;
    bd.loaded = true;
    if (bd.filter && !bd.tags.some(x => x.id === bd.filter)) bd.filter = "";
  }

  function upsertLocal(row) {
    const i = bd.list.findIndex(x => x.id === row.id);
    if (i >= 0) bd.list[i] = row; else bd.list.push(row);
  }

  function subscribe() {
    unsubscribe();
    bd.channel = sb.channel("bdays-" + hid())
      .on("postgres_changes", { event: "*", schema: "public", table: "birthdays", filter: `household_id=eq.${hid()}` }, p => {
        if (p.eventType === "DELETE") bd.list = bd.list.filter(x => x.id !== (p.old && p.old.id));
        else if (!p.new.is_private || p.new.created_by === me()) upsertLocal(p.new);
        render();
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "birthdays" }, p => {
        bd.list = bd.list.filter(x => x.id !== (p.old && p.old.id));
        render();
      })
      .subscribe();
  }
  function unsubscribe() {
    if (bd.channel) { sb.removeChannel(bd.channel); bd.channel = null; }
  }

  // =========================================================
  // Ansicht
  // =========================================================
  const tagChip = t => `<span class="tag" style="--tag:${escapeHtml(t.color)}">${escapeHtml(t.name)}</span>`;

  function row(b, n) {
    const tags = (b.tag_ids || []).map(id => bd.tags.find(t => t.id === id)).filter(Boolean);
    const age = ageText(b, n);
    const sub = [b.relation, age || (n.days === 0 ? "heute 🎉" : ""), n.days ? countdown(n.days) : ""].filter(Boolean).map(escapeHtml).join(" · ");
    return `<li><button class="bd-row${n.days === 0 ? " is-today" : ""}" data-bd="${b.id}">
      <span class="bd-date"><b>${b.birth_day}</b><small>${MON_SHORT[b.birth_month - 1]}</small></span>
      <span class="bd-main">
        <span class="bd-name">${escapeHtml(b.name)}${b.is_private ? ' <span class="muted">🔒</span>' : ""}</span>
        <span class="bd-sub">${sub}</span>
        ${tags.length ? `<span class="tag-row">${tags.map(tagChip).join("")}</span>` : ""}
      </span>
    </button></li>`;
  }

  function filtered() {
    const q = bd.query.trim().toLowerCase();
    return bd.list.filter(b =>
      (!bd.filter || (b.tag_ids || []).includes(bd.filter)) &&
      (!q || b.name.toLowerCase().includes(q) || (b.relation || "").toLowerCase().includes(q) || (b.notes || "").toLowerCase().includes(q)));
  }

  function render() {
    if (!bd.active) return;
    const today = todayIso();

    $("#bd-chips").innerHTML = bd.tags.length
      ? `<button class="chip${bd.filter ? "" : " active"}" data-bd-filter="">Alle</button>` +
        bd.tags.filter(t => bd.list.some(b => (b.tag_ids || []).includes(t.id)) || bd.filter === t.id)
          .map(t => `<button class="chip chip-tag${bd.filter === t.id ? " active" : ""}" data-bd-filter="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : "";

    const list = filtered().map(b => ({ b, n: next(b, today) }));

    // Heute
    const todays = list.filter(x => x.n.days === 0);
    $("#bd-hero").innerHTML = todays.map(({ b, n }) => `
      <div class="bd-hero">
        <div class="bd-hero-icon">🎂</div>
        <div class="bd-hero-text">
          <strong>${escapeHtml(b.name)}</strong> hat heute Geburtstag${n.age ? ` und wird <strong>${n.age}</strong>` : ""}!
          <div class="btn-row"><button class="btn btn-small" data-bd-wish="${b.id}">✨ Glückwunsch formulieren</button></div>
        </div>
      </div>`).join("");

    if (!bd.list.length) {
      $("#bd-items").innerHTML = `<div class="empty">
        <div class="empty-icon">🎂</div>
        <p><strong>Noch keine Geburtstage.</strong></p>
        <p class="muted small">Mit dem orangen + einzeln eintragen – oder alle auf einmal aus den iPhone-Kontakten übernehmen.</p>
        <button class="btn btn-secondary" data-bd-import>📇 Aus Kontakten importieren</button>
      </div>`;
      return;
    }
    if (!list.length) {
      $("#bd-items").innerHTML = `<p class="muted cal-empty">Keine Treffer.</p>`;
      return;
    }

    let html = "";
    const soon = list.filter(x => x.n.days > 0 && x.n.days <= SOON_DAYS).sort((a, b) => a.n.days - b.n.days);
    if (soon.length) {
      html += `<section class="cat-group"><h3 class="cat-title">Demnächst <span class="cat-count">${soon.length}</span></h3>
        <ul class="bd-list">${soon.map(x => row(x.b, x.n)).join("")}</ul></section>`;
    }
    // Alle nach Monat – beginnend mit dem aktuellen Monat
    const startMonth = new Date().getMonth();
    for (let k = 0; k < 12; k++) {
      const m = (startMonth + k) % 12 + 1;
      const items = list.filter(x => x.b.birth_month === m).sort((a, b) => a.b.birth_day - b.b.birth_day || a.b.name.localeCompare(b.b.name, "de"));
      if (!items.length) continue;
      html += `<section class="cat-group"><h3 class="cat-title">${MONTHS[m - 1]} <span class="cat-count">${items.length}</span></h3>
        <ul class="bd-list">${items.map(x => row(x.b, x.n)).join("")}</ul></section>`;
    }
    html += `<p class="bd-import-link"><button class="link" data-bd-import>📇 Weitere aus Kontakten importieren</button></p>`;
    $("#bd-items").innerHTML = html;
  }

  // =========================================================
  // Bearbeiten
  // =========================================================
  function renderTagPicker() {
    $("#bd-edit-tags").innerHTML = bd.tags.length
      ? bd.tags.map(t => `<button type="button" class="chip chip-tag${bd.draftTags.has(t.id) ? " active" : ""}" data-pick-bd-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags.</span>`;
  }
  function renderRemind() {
    $("#bd-remind").innerHTML = REMIND.map(([d, label]) =>
      `<button type="button" class="chip${bd.draftRemind.has(d) ? " active" : ""}" data-remind="${d}">${label}</button>`).join("");
  }
  function updateAgeHint() {
    const f = $("#form-bd");
    const y = parseInt(f.year.value, 10);
    const m = +f.month.value, d = +f.day.value;
    const hint = $("#bd-age-hint");
    if (!y || !m || !d || y < 1880) { hint.textContent = ""; return; }
    const n = next({ birth_month: m, birth_day: d, birth_year: y });
    hint.textContent = n.age != null && n.age >= 0 ? `Wird ${n.age} – ${countdown(n.days)}.` : "";
  }

  async function ensureLoaded() {
    if (!bd.loaded) await loadAll();
  }

  async function openEditor(id, preset = {}) {
    try { await ensureLoaded(); } catch (err) { toast(sqlHint(err), true); return; }
    let b = null;
    if (id) {
      const { data } = await sb.from("birthdays").select(FIELDS).eq("id", id).maybeSingle();
      b = data || bd.list.find(x => x.id === id);
      if (!b) { toast("Eintrag nicht gefunden.", true); return; }
      upsertLocal(b);
    }
    bd.editing = b ? b.id : null;
    bd.draftTags = new Set(b ? b.tag_ids : (preset.tag ? [preset.tag] : (bd.filter ? [bd.filter] : [])));
    bd.draftRemind = new Set(b ? b.remind_days : [0]);
    const f = $("#form-bd");
    f.reset();
    const pre = preset.date ? preset.date.split("-").map(Number) : null;
    f.name.value = b ? b.name : "";
    f.day.value = b ? b.birth_day : (pre ? pre[2] : "");
    f.month.value = b ? b.birth_month : (pre ? pre[1] : "");
    f.year.value = b && b.birth_year ? b.birth_year : "";
    f.relation.value = b ? b.relation : "";
    f.notes.value = b ? b.notes : "";
    f.is_private.checked = b ? b.is_private : false;
    f.is_private.disabled = !!(b && b.created_by !== me());
    $("#bd-sheet-title").textContent = b ? b.name : "Neuer Geburtstag";
    $("#btn-bd-delete").hidden = !b;
    $("#btn-bd-wish").hidden = !b;
    renderTagPicker();
    renderRemind();
    updateAgeHint();
    openSheet("sheet-bd");
    if (!b) setTimeout(() => f.name.focus(), 60);
  }

  function sqlHint(err) {
    return /birthdays|does not exist/i.test((err && err.message) || "") ? "Bitte zuerst das SQL aus Schritt 18 in Supabase ausführen." : translateError(err);
  }

  $("#form-bd").addEventListener("input", e => { if (["day", "month", "year"].includes(e.target.name)) updateAgeHint(); });
  $("#form-bd").addEventListener("change", e => { if (["day", "month", "year"].includes(e.target.name)) updateAgeHint(); });

  $("#form-bd").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const name = f.name.value.trim();
      const day = parseInt(f.day.value, 10), month = parseInt(f.month.value, 10);
      const yearRaw = f.year.value.trim();
      const year = yearRaw ? parseInt(yearRaw, 10) : null;
      if (!name) throw new Error("Bitte einen Namen eingeben.");
      if (!day || !month) throw new Error("Bitte Tag und Monat wählen.");
      const test = new Date(2000, month - 1, day);
      if (test.getMonth() !== month - 1) throw new Error(`Den ${day}. ${MONTHS[month - 1]} gibt es nicht.`);
      if (year !== null && (isNaN(year) || year < 1880 || year > new Date().getFullYear())) throw new Error("Bitte ein gültiges Geburtsjahr eingeben – oder leer lassen.");
      const row = {
        name: name.slice(0, 120), birth_day: day, birth_month: month, birth_year: year,
        relation: f.relation.value.trim().slice(0, 60), notes: f.notes.value.trim().slice(0, 2000),
        tag_ids: [...bd.draftTags].filter(i => bd.tags.some(t => t.id === i)),
        remind_days: [...bd.draftRemind].sort((a, b) => a - b)
      };
      if (!f.is_private.disabled) row.is_private = f.is_private.checked;
      const res = bd.editing
        ? await sb.from("birthdays").update(row).eq("id", bd.editing).select(FIELDS).single()
        : await sb.from("birthdays").insert({ ...row, household_id: hid() }).select(FIELDS).single();
      if (res.error) throw new Error(sqlHint(res.error));
      upsertLocal(res.data);
      closeSheets();
      const n = next(res.data);
      toast(n.days === 0 ? "Gespeichert – heute ist der Geburtstag! 🎉" : `Gespeichert – nächster Geburtstag ${countdown(n.days)}.`);
      render();
      refreshTile();
      if (PP.modules.calendar && PP.modules.calendar.refreshBirthdays) PP.modules.calendar.refreshBirthdays();
    });
  });

  $("#sheet-bd").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.pickBdTag) {
      const id = t.dataset.pickBdTag;
      bd.draftTags.has(id) ? bd.draftTags.delete(id) : bd.draftTags.add(id);
      renderTagPicker();
    } else if (t.dataset.remind !== undefined) {
      const d = +t.dataset.remind;
      bd.draftRemind.has(d) ? bd.draftRemind.delete(d) : bd.draftRemind.add(d);
      renderRemind();
    } else if (t.id === "btn-bd-tag-add") {
      addTag();
    } else if (t.id === "btn-bd-delete") {
      const b = bd.list.find(x => x.id === bd.editing);
      if (!b || !confirm(`Geburtstag von „${b.name}“ löschen?`)) return;
      const { error } = await sb.from("birthdays").delete().eq("id", b.id);
      if (error) { toast(translateError(error), true); return; }
      bd.list = bd.list.filter(x => x.id !== b.id);
      closeSheets();
      toast("Gelöscht.");
      render();
      refreshTile();
      if (PP.modules.calendar && PP.modules.calendar.refreshBirthdays) PP.modules.calendar.refreshBirthdays();
    } else if (t.id === "btn-bd-wish") {
      const b = bd.list.find(x => x.id === bd.editing);
      if (b) wish(b);
    }
  });

  async function addTag() {
    const input = $("#form-bd").new_tag;
    const name = input.value.trim().slice(0, 40);
    if (!name) return;
    let tag = bd.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      const { data, error } = await sb.from("event_tags").insert({ household_id: hid(), name, color: TAG_COLORS[bd.tags.length % TAG_COLORS.length] })
        .select("id, name, color").single();
      if (error) { toast(translateError(error), true); return; }
      tag = data;
      bd.tags.push(tag);
      bd.tags.sort((a, b) => a.name.localeCompare(b.name, "de"));
    }
    bd.draftTags.add(tag.id);
    input.value = "";
    renderTagPicker();
  }
  $("#form-bd").new_tag.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });

  // Glückwunsch mit der KI aus dem Wiki formulieren
  function wish(b) {
    const n = next(b);
    if (!PP.compose) { toast("Das Formulieren gibt es im Wiki – bitte App neu laden.", true); return; }
    closeSheets();
    PP.compose({
      type: "nachricht", tone: "locker", recipient: b.name + (b.relation ? ` (${b.relation})` : ""),
      points: `Herzlichen Glückwunsch zum Geburtstag${n.age ? ` – ${n.age}. Geburtstag` : ""}. Persönlich und herzlich, gern mit einem kleinen Wunsch fürs neue Lebensjahr.` +
        (b.notes ? `\nHintergrund: ${b.notes}` : "")
    });
  }

  // =========================================================
  // Import aus Kontakten (vCard / .vcf)
  // =========================================================
  function unescapeV(s) {
    return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
  }
  function decodeQP(s, charset) {
    const bytes = [];
    const str = s.replace(/=\r?\n/g, "");
    for (let i = 0; i < str.length; i++) {
      if (str[i] === "=" && /^[0-9A-F]{2}$/i.test(str.substr(i + 1, 2))) { bytes.push(parseInt(str.substr(i + 1, 2), 16)); i += 2; }
      else bytes.push(str.charCodeAt(i) & 255);
    }
    try { return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes)); } catch { return s; }
  }

  function parseBday(v, params) {
    v = v.trim();
    let m;
    const omit = /X-APPLE-OMIT-YEAR=(\d{4})/i.exec(params);
    if ((m = /^--(\d{2})-?(\d{2})/.exec(v))) return { year: null, month: +m[1], day: +m[2] };
    if ((m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v))) {
      let year = +m[1];
      if ((omit && +omit[1] === year) || year < 1880 || year === 1604 || year === 1900 && /omit/i.test(params)) year = null;
      return { year, month: +m[2], day: +m[3] };
    }
    if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?/.exec(v))) return { year: m[3] ? +m[3] : null, month: +m[2], day: +m[1] };
    return null;
  }

  function parseVcf(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
    const out = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.replace(/^item\d+\./i, "");
      if (/^BEGIN:VCARD/i.test(line)) { cur = {}; continue; }
      if (/^END:VCARD/i.test(line)) {
        if (cur && cur.bday && (cur.fn || cur.n)) {
          const b = cur.bday;
          const valid = b.month >= 1 && b.month <= 12 && b.day >= 1 && new Date(2000, b.month - 1, b.day).getMonth() === b.month - 1;
          if (valid) out.push({ name: (cur.fn || cur.n).slice(0, 120), birth_month: b.month, birth_day: b.day, birth_year: b.year && b.year <= new Date().getFullYear() ? b.year : null });
        }
        cur = null;
        continue;
      }
      if (!cur) continue;
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const head = line.slice(0, idx), val = line.slice(idx + 1);
      const [prop, ...params] = head.split(";");
      const pstr = params.join(";");
      const charset = (/CHARSET=([\w-]+)/i.exec(pstr) || [])[1];
      const value = /QUOTED-PRINTABLE/i.test(pstr) ? decodeQP(val, charset) : val;
      const P = prop.toUpperCase();
      if (P === "FN") cur.fn = unescapeV(value);
      else if (P === "N" && !cur.n) {
        const [last, first] = value.split(/(?<!\\);/).map(unescapeV);
        cur.n = [first, last].filter(Boolean).join(" ");
      } else if (P === "BDAY") cur.bday = parseBday(value, pstr);
    }
    return out;
  }

  function openImport() {
    bd.importRows = [];
    bd.importTag = bd.filter || "";
    $("#bd-import-list").innerHTML = "";
    $("#bd-import-step2").hidden = true;
    $("#bd-import-step1").hidden = false;
    openSheet("sheet-bd-import");
  }

  function renderImport() {
    const rows = bd.importRows;
    const sel = rows.filter(r => r.checked).length;
    const dupes = rows.filter(r => r.dupe).length;
    $("#bd-import-summary").textContent = rows.length
      ? `${rows.length} Kontakt${rows.length === 1 ? "" : "e"} mit Geburtstag gefunden${dupes ? ` – ${dupes === 1 ? "1 ist" : dupes + " sind"} schon eingetragen` : ""}.`
      : "In der Datei waren keine Kontakte mit Geburtstag.";
    $("#bd-import-list").innerHTML = rows.map((r, i) => `<li><label class="bd-import-row${r.dupe ? " dupe" : ""}">
      <input type="checkbox" data-imp="${i}" ${r.checked ? "checked" : ""}>
      <span class="bd-date"><b>${r.birth_day}</b><small>${MON_SHORT[r.birth_month - 1]}</small></span>
      <span class="bd-main"><span class="bd-name">${escapeHtml(r.name)}</span>
      <span class="bd-sub">${r.birth_year ? r.birth_year : "ohne Jahr"}${r.dupe ? " · schon vorhanden" : ""}</span></span>
    </label></li>`).join("");
    $("#bd-import-tags").innerHTML = `<button type="button" class="chip${bd.importTag ? "" : " active"}" data-imp-tag="">Ohne Tag</button>` +
      bd.tags.map(t => `<button type="button" class="chip chip-tag${bd.importTag === t.id ? " active" : ""}" data-imp-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("");
    $("#btn-bd-import-go").textContent = `${sel} übernehmen`;
    $("#btn-bd-import-go").disabled = !sel;
  }

  $("#bd-import-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      await ensureLoaded();
      const text = await file.text();
      const rows = parseVcf(text);
      const key = r => `${r.name.toLowerCase()}|${r.birth_month}|${r.birth_day}`;
      const have = new Set(bd.list.map(key));
      const seen = new Set();
      bd.importRows = rows.filter(r => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.birth_month - b.birth_month || a.birth_day - b.birth_day)
        .map(r => ({ ...r, dupe: have.has(key(r)), checked: !have.has(key(r)) }));
      $("#bd-import-step1").hidden = true;
      $("#bd-import-step2").hidden = false;
      renderImport();
    } catch (err) {
      toast(sqlHint(err), true);
    }
  });

  $("#sheet-bd-import").addEventListener("change", e => {
    const i = e.target.dataset.imp;
    if (i === undefined) return;
    bd.importRows[+i].checked = e.target.checked;
    renderImport();
  });
  $("#sheet-bd-import").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.impTag !== undefined) { bd.importTag = t.dataset.impTag; renderImport(); return; }
    if (t.id === "btn-bd-import-all") {
      const all = bd.importRows.every(r => r.checked || r.dupe);
      bd.importRows.forEach(r => { if (!r.dupe) r.checked = !all; });
      renderImport();
      return;
    }
    if (t.id === "btn-bd-import-go") {
      const pick = bd.importRows.filter(r => r.checked);
      if (!pick.length) return;
      t.disabled = true;
      try {
        const rows = pick.map(r => ({
          household_id: hid(), name: r.name, birth_month: r.birth_month, birth_day: r.birth_day, birth_year: r.birth_year,
          tag_ids: bd.importTag ? [bd.importTag] : [], remind_days: [0]
        }));
        for (let i = 0; i < rows.length; i += 200) {
          const { data, error } = await sb.from("birthdays").insert(rows.slice(i, i + 200)).select(FIELDS);
          if (error) throw new Error(sqlHint(error));
          (data || []).forEach(upsertLocal);
        }
        closeSheets();
        toast(`${pick.length} Geburtstag${pick.length === 1 ? "" : "e"} übernommen.`);
        render();
        refreshTile();
        if (PP.modules.calendar && PP.modules.calendar.refreshBirthdays) PP.modules.calendar.refreshBirthdays();
      } catch (err) {
        toast(translateError(err), true);
      } finally {
        t.disabled = false;
      }
    }
  });

  // =========================================================
  // Erinnerung per Push (Einstellung je Person)
  // =========================================================
  function renderPush() {
    const p = state.profile || {};
    const f = $("#form-bd-push");
    f.enabled.checked = p.birthday_push !== false;
    f.time.value = p.birthday_push_time ? String(p.birthday_push_time).slice(0, 5) : "08:00";
    $("#bd-push-time").hidden = !f.enabled.checked;
  }
  $("#form-bd-push").addEventListener("change", async e => {
    const f = $("#form-bd-push");
    $("#bd-push-time").hidden = !f.enabled.checked;
    const now = new Date();
    const time = f.time.value || "08:00";
    const update = {
      birthday_push: f.enabled.checked,
      birthday_push_time: time,
      birthday_push_last: time <= `${pad(now.getHours())}:${pad(now.getMinutes())}` ? todayIso() : null
    };
    const { error } = await sb.from("profiles").update(update).eq("id", me());
    if (error) {
      renderPush();
      toast(/birthday_push/.test(error.message) ? "Bitte zuerst das SQL aus Schritt 18 in Supabase ausführen." : translateError(error), true);
      return;
    }
    Object.assign(state.profile, update);
    if (e.target.name === "enabled" || e.target.name === "time") {
      toast(f.enabled.checked ? `Erinnerungen kommen um ${time} Uhr aufs Handy.` : "Geburtstags-Erinnerungen ausgeschaltet.");
    }
  });

  // =========================================================
  // Klicks in der Ansicht
  // =========================================================
  $("#view-birthdays").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.bdFilter !== undefined) {
      bd.filter = t.dataset.bdFilter;
      storageSet("pp_bd_filter", bd.filter);
      render();
    } else if (t.dataset.bd) openEditor(t.dataset.bd);
    else if (t.dataset.bdWish) { const b = bd.list.find(x => x.id === t.dataset.bdWish); if (b) wish(b); }
    else if (t.hasAttribute("data-bd-import")) openImport();
    else if (t.id === "btn-bd-add") openEditor(null);
  });
  $("#bd-search").addEventListener("input", e => { bd.query = e.target.value; render(); });

  // =========================================================
  // Kachel & Modul
  // =========================================================
  async function refreshTile() {
    if (!state.household) return;
    const el = $("#tile-bd-status");
    try {
      const { data, error } = await sb.from("birthdays").select("name, birth_month, birth_day, birth_year").eq("household_id", hid());
      if (error || !data.length) { el.textContent = "Öffnen"; return; }
      const today = todayIso();
      const ns = data.map(b => ({ b, n: next(b, today) })).sort((a, b) => a.n.days - b.n.days);
      const todays = ns.filter(x => x.n.days === 0);
      if (todays.length) el.textContent = "🎉 Heute: " + todays.map(x => x.b.name.split(" ")[0]).join(", ");
      else el.textContent = `${ns[0].b.name.split(" ")[0]} · ${countdown(ns[0].n.days)}`;
    } catch { el.textContent = "Öffnen"; }
  }

  PP.birthdays = {
    open: id => openEditor(id),
    create: preset => openEditor(null, preset || {}),
    on, next, occurrence,
    _parseVcf: parseVcf
  };

  PP.modules.birthdays = {
    async enter() {
      bd.active = true;
      $("#bd-search").value = bd.query;
      renderPush();
      try {
        await loadAll();
        subscribe();
      } catch (err) {
        console.error(err);
        toast(sqlHint(err), true);
      }
      render();
    },
    leave() {
      bd.active = false;
      unsubscribe();
      closeSheets();
      refreshTile();
    },
    async resume() {
      if (bd.active) { try { await loadAll(); render(); } catch (err) { console.error(err); } }
      else refreshTile();
    },
    refreshTile,
    reset() { this.leave(); bd.list = []; bd.tags = []; bd.loaded = false; }
  };
})();
