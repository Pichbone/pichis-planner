// =========================================================
// Pichis Planner – Müllabfuhr
// Termine aus der ICS-Datei der KAW Mainz-Bingen, Erinnerung am
// Vorabend (Push), Anzeige im Kalender und in der Tages-Mail.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, openSheet, closeSheets } = PP;

  const KINDS = {
    rest:       { icon: "⚫", label: "Restmüll",       color: "#4B5563", re: /rest/i },
    bio:        { icon: "🟤", label: "Biotonne",       color: "#8B5A2B", re: /bio/i },
    papier:     { icon: "🔵", label: "Papier",         color: "#2563EB", re: /papier|pappe|ppk|blau/i },
    gelb:       { icon: "🟡", label: "Gelber Sack",    color: "#EAB308", re: /gelb|wertstoff|verpackung|lvp/i },
    glas:       { icon: "🟢", label: "Glas",           color: "#16A34A", re: /glas/i },
    sperr:      { icon: "🛋️", label: "Sperrmüll",      color: "#7C3AED", re: /sperr/i },
    gruen:      { icon: "🌿", label: "Grünschnitt",    color: "#15803D", re: /grün|gruen|baum|strauch|garten/i },
    schadstoff: { icon: "☣️", label: "Schadstoffe",    color: "#DC2626", re: /schadstoff|problem|sondermüll/i },
    sonstig:    { icon: "♻️", label: "Abholung",       color: "#0F766E", re: /./ }
  };
  const ORDER = ["rest", "bio", "papier", "gelb", "glas", "sperr", "gruen", "schadstoff"];
  // Alte Müll-Aufgaben erkennen
  // („Müller“ o. Ä. bewusst nicht – nur echte Müll-Wörter)
  const TODO_RE = /(^|[^a-zäöüß])m(ü|ue)ll(?![a-df-zäöüß]|er\b)|tonne|abfall|gelbe[nr]? ?s(a|ä)ck|altpapier|papier ?(raus|tonne)|wertstoff|biotonne|restm(ü|ue)ll|sperrm(ü|ue)ll/i;

  const ws = { active: false, rows: [], loaded: false, preview: null, oldTodos: [] };
  const hid = () => state.household.id;
  const pad = n => String(n).padStart(2, "0");
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => isoOf(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };
  // Eigene Zuordnungen („Abfuhr 2“ → Biotonne) merken
  const MAP_KEY = "pp_ws_map";
  // Version 0.45.1 hat bei gleichlautenden Terminen falsch zugeordnet – einmalig vergessen
  try { if (localStorage.getItem("pp_ws_map_v") !== "2") { localStorage.removeItem("pp_ws_map"); localStorage.setItem("pp_ws_map_v", "2"); } } catch { /* egal */ }
  const loadMap = () => { try { return JSON.parse(localStorage.getItem(MAP_KEY) || "{}"); } catch { return {}; } };
  const saveMap = m => { try { localStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch { /* egal */ } };
  const kindOf = (text, title) => {
    const m = loadMap();
    if (title && m[title.toLowerCase()]) return m[title.toLowerCase()];
    return ORDER.find(k => KINDS[k].re.test(text)) || "sonstig";
  };
  const label = r => (r.kind === "sonstig" && r.title) ? r.title : KINDS[r.kind].label;

  function sqlHint(err) {
    const m = (err && err.message) || "";
    return /waste_|does not exist|schema cache/.test(m) ? "Bitte zuerst das SQL aus Schritt 38 in Supabase ausführen." : translateError(err);
  }

  // ---------- Daten ----------
  async function load() {
    const { data, error } = await sb.from("waste_dates").select("id, day, kind, title")
      .eq("household_id", hid()).gte("day", addDays(today(), -1)).order("day").limit(500);
    if (error) throw error;
    ws.rows = data;
    ws.loaded = true;
  }

  // Für Kalender und Startseite: Termine an einem Tag
  function on(rows, iso) { return (rows || []).filter(r => r.day === iso).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)); }

  // ---------- ICS lesen ----------
  function parseIcs(text) {
    const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
    const events = [];
    let ev = null;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") { ev = {}; continue; }
      if (line === "END:VEVENT") { if (ev && ev.date) events.push(ev); ev = null; continue; }
      if (!ev) continue;
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).split(";")[0].toUpperCase();
      const val = line.slice(i + 1).trim();
      if (key === "DTSTART") {
        const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
        if (m) {
          if (m[4] && m[7]) {
            // Zeitpunkt in UTC → Tag in Berlin
            const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
            ev.date = isoOf(new Date(d.toLocaleString("en-US", { timeZone: "Europe/Berlin" })));
          } else ev.date = `${m[1]}-${m[2]}-${m[3]}`;
        }
      } else if (["SUMMARY", "DESCRIPTION", "CATEGORIES", "LOCATION"].includes(key)) {
        ev[key.toLowerCase()] = val.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim();
      }
      else if (key === "RRULE") ev.rrule = val;
      // Sonstige Angaben (z. B. UID „rest-…“, X-Felder, Farbe) – manche Kalender verstecken die Abfallart dort
      if (!["DTSTART", "DTEND", "DTSTAMP", "CREATED", "LAST-MODIFIED", "SEQUENCE", "TRANSP", "STATUS", "RRULE", "SUMMARY", "DESCRIPTION", "CATEGORIES", "LOCATION", "BEGIN", "END"].includes(key)) {
        ev.extra = ((ev.extra || "") + " " + val).slice(0, 500);
      }
    }
    // Wiederholungen (selten bei Abfallkalendern) für bis zu 1 Jahr ausrollen
    const out = [];
    const limit = addDays(today(), 400);
    for (const e of events) {
      // Die Abfallart steht je nach Kalender im Titel, in der Beschreibung oder in der Kategorie
      e.text = [e.summary, e.categories, e.description, e.location, e.extra].filter(Boolean).join(" · ");
      e.title = (ORDER.some(k => KINDS[k].re.test(e.summary || "")) ? e.summary : [e.summary, e.categories, e.description].filter(Boolean).join(" – ")) || "";
      out.push({ day: e.date, text: e.text, title: e.title });
      if (!e.rrule) continue;
      const p = Object.fromEntries(e.rrule.split(";").map(x => x.split("=")));
      const step = p.FREQ === "WEEKLY" ? 7 * (+p.INTERVAL || 1) : p.FREQ === "DAILY" ? (+p.INTERVAL || 1) : 0;
      if (!step) continue;
      const until = p.UNTIL ? `${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}` : limit;
      let d = e.date, n = 1;
      while (n < (+p.COUNT || 500)) {
        d = addDays(d, step);
        if (d > until || d > limit) break;
        out.push({ day: d, text: e.text, title: e.title });
        n++;
      }
    }
    const seen = new Set();
    return out.map(e => ({ day: e.day, kind: kindOf(e.text || "", e.title || ""), title: (e.title || "").slice(0, 120) }))
      .filter(e => { const k = e.day + e.kind; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  // ---------- Anzeige ----------
  function dayLabel(iso) {
    const t = today();
    if (iso === t) return "Heute";
    if (iso === addDays(t, 1)) return "Morgen";
    return new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
  }
  const chip = r => `<span class="ws-chip" style="--ws:${KINDS[r.kind].color}">${KINDS[r.kind].icon} ${escapeHtml(label(r))}</span>`;

  function render() {
    if (!ws.active) return;
    const box = $("#ws-items");
    if (!ws.loaded) { box.innerHTML = `<p class="muted cal-empty">Wird geladen …</p>`; return; }
    const t = today();
    const up = ws.rows.filter(r => r.day >= t).sort((a, b) => a.day.localeCompare(b.day));
    if (!up.length) {
      box.innerHTML = `<div class="empty"><div class="empty-icon">🗑️</div><p><strong>Noch keine Abholtermine.</strong></p>
        <p class="muted small">Lade beim Abfallkalender der KAW Mainz-Bingen für deine Straße die <b>ICS-Datei</b> herunter und tippe oben auf „📥 ICS-Datei laden“.</p></div>`;
    } else {
      const days = [...new Set(up.map(r => r.day))].slice(0, 40);
      box.innerHTML = `<ul class="ws-list">${days.map(d => `<li class="${d === t ? "is-today" : ""}${d === addDays(t, 1) ? " is-tomorrow" : ""}">
          <span class="ws-date">${escapeHtml(dayLabel(d))}</span>
          <span class="ws-chips">${on(up, d).map(chip).join("")}</span></li>`).join("")}</ul>
        <p class="muted small">${up.length} Termine bis ${new Date(up[up.length - 1].day + "T12:00:00").toLocaleDateString("de-DE")}. Für das nächste Jahr einfach die neue ICS-Datei laden. · <button type="button" class="link danger-link" id="btn-ws-clear">Alle Termine löschen</button></p>`;
    }
    renderUnknown();
    renderPush();
  }

  // Unbekannte Abfallarten von Hand zuordnen
  function renderUnknown() {
    const box = $("#ws-unknown");
    const titles = [...new Set(ws.rows.filter(r => r.kind === "sonstig").map(r => r.title || ""))];
    const all = ws.rows.filter(r => r.day >= today());
    // Alle Termine heißen gleich und nichts verrät die Tonne → Zuordnen ergibt keinen Sinn
    if (titles.length === 1 && all.length > 3 && all.every(r => r.kind === "sonstig")) {
      box.hidden = false;
      box.innerHTML = `<p><strong>In der Datei steht nicht, welche Tonne abgeholt wird.</strong></p>
        <p class="muted small">Alle Termine heißen „${escapeHtml(titles[0] || "–")}“. Bitte schau, ob es beim Abfallkalender eine Datei <b>je Abfallart</b> gibt (z. B. nur Restmüll, nur Bio …) – die kannst du nacheinander laden und dabei die Tonne wählen.</p>`;
      return;
    }
    if (!titles.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = `<p><strong>Welche Tonne ist das?</strong></p>
      <p class="muted small">Diese Termine konnte die App keiner Abfallart zuordnen. Einmal auswählen – gilt für alle Termine mit diesem Namen, auch beim nächsten Laden der Datei.</p>
      ${titles.map(t => `<label class="ws-map">${escapeHtml(t || "(ohne Namen)")}
        <select data-ws-map="${escapeHtml(t)}"><option value="">– wählen –</option>${ORDER.map(k => `<option value="${k}">${KINDS[k].icon} ${KINDS[k].label}</option>`).join("")}</select>
      </label>`).join("")}`;
  }

  $("#ws-unknown").addEventListener("change", async e => {
    const sel = e.target.closest("[data-ws-map]");
    if (!sel || !sel.value) return;
    const title = sel.dataset.wsMap, kind = sel.value;
    const m = loadMap(); m[title.toLowerCase()] = kind; saveMap(m);
    // vorhandene Termine umstellen (gleicher Tag + Art schon da → doppelten Eintrag entfernen)
    const rows = ws.rows.filter(r => r.kind === "sonstig" && (r.title || "") === title);
    for (const r of rows) {
      if (ws.rows.some(x => x.day === r.day && x.kind === kind)) {
        await sb.from("waste_dates").delete().eq("id", r.id);
      } else {
        const { error } = await sb.from("waste_dates").update({ kind }).eq("id", r.id);
        if (error) { toast(sqlHint(error), true); return; }
      }
    }
    toast(`„${title}“ ist jetzt ${KINDS[kind].label}.`);
    await refresh();
  });

  function renderPush() {
    const f = $("#form-ws-push");
    const p = state.profile || {};
    f.enabled.checked = p.waste_push !== false;
    f.time.value = String(p.waste_push_time || "19:00").slice(0, 5);
    $("#ws-push-time").hidden = !f.enabled.checked;
  }

  async function refresh() {
    try { await load(); } catch (err) { ws.loaded = true; ws.rows = []; toast(sqlHint(err), true); }
    render();
  }

  // ---------- ICS-Datei laden ----------
  $("#ws-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let rows = [];
    try { rows = parseIcs(await file.text()); } catch (err) { toast("Die Datei konnte nicht gelesen werden.", true); return; }
    const future = rows.filter(r => r.day >= today());
    if (!future.length) { toast("In der Datei sind keine kommenden Termine.", true); return; }
    ws.preview = future;
    const counts = {};
    for (const r of future) counts[r.kind] = (counts[r.kind] || 0) + 1;
    $("#ws-preview").innerHTML = `<p><b>${future.length} Termine</b> vom ${new Date(future[0].day + "T12:00:00").toLocaleDateString("de-DE")} bis ${new Date(future[future.length - 1].day + "T12:00:00").toLocaleDateString("de-DE")}:</p>
      <p class="ws-chips">${Object.entries(counts).sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).map(([k, n]) =>
        `<span class="ws-chip" style="--ws:${KINDS[k].color}">${KINDS[k].icon} ${KINDS[k].label} · ${n}×</span>`).join("")}</p>
      <p class="muted small">Vorhandene Termine ab ${new Date(future[0].day + "T12:00:00").toLocaleDateString("de-DE")} derselben Tonne(n) werden dabei ersetzt.</p>`;
    $("#ws-fixkind").innerHTML = `<option value="">Automatisch erkennen</option>` + ORDER.map(k => `<option value="${k}">${KINDS[k].icon} nur ${KINDS[k].label}</option>`).join("");
    // Datei ohne erkennbare Abfallart → gleich zur Auswahl auffordern
    $("#ws-fixkind").value = "";
    openSheet("sheet-ws-import");
  });

  $("#btn-ws-import").addEventListener("click", async () => {
    const fixed = $("#ws-fixkind").value;
    let rows = ws.preview;
    if (!rows || !rows.length) return;
    if (fixed) {
      const seen = new Set();
      rows = rows.map(r => ({ ...r, kind: fixed })).filter(r => !seen.has(r.day) && seen.add(r.day));
    }
    const btn = $("#btn-ws-import");
    btn.disabled = true;
    try {
      // nur die Abfallarten aus dieser Datei ersetzen – so lassen sich mehrere Dateien (je Tonne) nacheinander laden
      const kinds = [...new Set(rows.map(r => r.kind))];
      const del = await sb.from("waste_dates").delete().eq("household_id", hid()).gte("day", rows[0].day).in("kind", kinds);
      if (del.error) throw del.error;
      for (let i = 0; i < rows.length; i += 300) {
        const { error } = await sb.from("waste_dates").insert(rows.slice(i, i + 300).map(r => ({ household_id: hid(), ...r })));
        if (error) throw error;
      }
      closeSheets();
      toast(`${rows.length} Abholtermine übernommen.`);
      ws.preview = null;
      await refresh();
      // Danach anbieten, die alten Müll-Aufgaben aufzuräumen
      findOldTodos(true);
    } catch (err) {
      toast(sqlHint(err), true);
    } finally { btn.disabled = false; }
  });

  // ---------- Alte Müll-Aufgaben aufräumen ----------
  async function findOldTodos(auto) {
    const { data, error } = await sb.from("todos").select("id, title, due_date, repeat, is_done, is_private, created_by")
      .eq("household_id", hid()).eq("is_done", false);
    if (error) { if (!auto) toast(translateError(error), true); return; }
    ws.oldTodos = (data || []).filter(t => TODO_RE.test(t.title || ""));
    if (!ws.oldTodos.length) { if (!auto) toast("Keine Müll-Aufgaben gefunden."); return; }
    $("#ws-old-list").innerHTML = ws.oldTodos.map(t => `<li><label class="ar-imp-row">
        <input type="checkbox" data-ws-old="${t.id}" checked>
        <span class="ar-imp-text"><span class="ar-imp-name">${escapeHtml(t.title)}</span>
        <span class="muted small">${[t.due_date ? "fällig " + new Date(t.due_date + "T12:00:00").toLocaleDateString("de-DE") : "ohne Datum", t.repeat && t.repeat !== "none" ? "🔁 wiederholt sich" : "", t.is_private ? "🔒 privat" : ""].filter(Boolean).join(" · ")}</span></span>
      </label></li>`).join("");
    openSheet("sheet-ws-old");
  }

  $("#btn-ws-old-delete").addEventListener("click", async () => {
    const ids = [...document.querySelectorAll("[data-ws-old]")].filter(c => c.checked).map(c => c.dataset.wsOld);
    if (!ids.length) { closeSheets(); return; }
    const { error } = await sb.from("todos").delete().in("id", ids);
    if (error) { toast(translateError(error), true); return; }
    closeSheets();
    toast(`${ids.length} alte Müll-Aufgabe${ids.length === 1 ? "" : "n"} gelöscht.`);
  });

  // ---------- Erinnerung ----------
  $("#form-ws-push").addEventListener("change", async e => {
    const f = e.currentTarget;
    $("#ws-push-time").hidden = !f.enabled.checked;
    const upd = { waste_push: f.enabled.checked, waste_push_time: f.time.value || "19:00" };
    // heute schon vorbei? Dann erst morgen erinnern
    const now = new Date();
    if (upd.waste_push_time <= `${pad(now.getHours())}:${pad(now.getMinutes())}`) upd.waste_push_last = today();
    const { error } = await sb.from("profiles").update(upd).eq("id", state.session.user.id);
    if (error) { toast(sqlHint(error), true); return; }
    Object.assign(state.profile, upd);
    toast(upd.waste_push ? `Erinnerung am Vorabend um ${upd.waste_push_time} Uhr.` : "Keine Müll-Erinnerung mehr.");
  });

  $("#view-waste").addEventListener("click", e => {
    if (e.target.closest("#btn-ws-file")) $("#ws-file").click();
    if (e.target.closest("#btn-ws-old")) findOldTodos(false);
    if (e.target.closest("#btn-ws-clear")) {
      if (!confirm("Alle Abholtermine löschen? Danach die ICS-Datei(en) neu laden.")) return;
      sb.from("waste_dates").delete().eq("household_id", hid()).then(({ error }) => {
        if (error) { toast(sqlHint(error), true); return; }
        try { localStorage.removeItem(MAP_KEY); } catch { /* egal */ }
        toast("Alle Abholtermine gelöscht.");
        refresh();
      });
    }
  });

  // ---------- Startseite ----------
  async function refreshTile() {
    const el = $("#tile-ws-status");
    if (!el) return;
    try {
      const { data, error } = await sb.from("waste_dates").select("day, kind, title").eq("household_id", hid()).gte("day", today()).order("day").limit(6);
      if (error) { el.textContent = "Termine laden"; return; }
      if (!data.length) { el.textContent = "Termine laden"; return; }
      const d = data[0].day;
      el.textContent = `${dayLabel(d)}: ${on(data, d).map(label).join(", ")}`;
      el.closest(".tile").classList.toggle("tile-alert", d === addDays(today(), 1) || d === today());
    } catch { /* egal */ }
  }

  PP.waste = { KINDS, on, label, chip };
  PP.modules.waste = {
    enter() { ws.active = true; render(); refresh(); },
    leave() { ws.active = false; },
    resume() { if (ws.active) refresh(); },
    refreshTile,
    reset() { ws.rows = []; ws.loaded = false; }
  };
})();
