// =========================================================
// Pichis Planner – Bundesliga (1. und 2. Liga)
// Spieltag, Tabelle und Lieblingsvereine je Person (OpenLigaDB über „news“)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, storageGet, storageSet, translateError, openSheet, closeSheets } = PP;
  const cfg = window.PP_CONFIG || {};
  const LEAGUES = [["bl1", "1. Bundesliga"], ["bl2", "2. Bundesliga"]];

  const fb = {
    active: false,
    league: storageGet("pp_fb_league") || "bl2",
    tab: storageGet("pp_fb_tab") || "mine",     // mine | day | table
    group: null,                                 // angezeigter Spieltag (null = aktueller)
    data: {},                                    // league|group → Übersicht
    fav: null,                                   // Lieblingsvereine mit Spielen
    teams: null                                  // alle Vereine beider Ligen (Auswahl)
  };

  const myTeams = () => {
    const t = state.profile && state.profile.football_teams;
    return Array.isArray(t) && t.length ? t : (cfg.FOOTBALL_DEFAULT || ["1. FC Kaiserslautern"]);
  };
  const isFav = name => myTeams().some(t => t.toLowerCase() === String(name || "").toLowerCase());

  async function invoke(body) {
    const { data, error } = await sb.functions.invoke("news", { body: { action: "football", ...body } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
      throw new Error(msg);
    }
    return data;
  }

  // ---------- Darstellung ----------
  const fmtKick = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" }) + " " +
      d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  };
  const logo = u => u ? `<img class="fb-logo" src="${escapeHtml(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  function score(m, withTime) {
    if (m.g1 == null && !withTime) return `<span class="fb-time">–:–</span>`;
    if (m.g1 == null) return `<span class="fb-time">${escapeHtml(new Date(m.utc).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }))}</span>`;
    return `<span class="fb-score${m.live ? " live" : ""}">${m.g1}:${m.g2}</span>`;
  }
  function matchRow(m, showDate = true) {
    return `<li class="fb-match${m.live ? " is-live" : ""}">
      ${showDate ? `<span class="fb-when">${m.live ? "🔴 LIVE" : escapeHtml(fmtKick(m.utc))}</span>` : ""}
      <span class="fb-team fb-home${isFav(m.t1) ? " fav" : ""}">${escapeHtml(m.s1 || m.t1)} ${logo(m.i1)}</span>
      ${score(m, !showDate)}
      <span class="fb-team fb-away${isFav(m.t2) ? " fav" : ""}">${logo(m.i2)} ${escapeHtml(m.s2 || m.t2)}</span>
    </li>`;
  }

  function resultFor(m, team) {
    if (m.g1 == null) return "";
    const home = m.t1.toLowerCase() === team.toLowerCase();
    const a = home ? m.g1 : m.g2, b = home ? m.g2 : m.g1;
    return a > b ? "S" : a < b ? "N" : "U";
  }

  function render() {
    if (!fb.active) return;
    $("#fb-tabs").innerHTML = [["mine", "⭐ Meine Vereine"], ["day", "📅 Spieltag"], ["table", "📊 Tabelle"]]
      .map(([k, l]) => `<button class="chip${fb.tab === k ? " active" : ""}" data-fb-tab="${k}">${l}</button>`).join("");
    $("#fb-leagues").hidden = fb.tab === "mine";
    $("#fb-leagues").innerHTML = LEAGUES.map(([k, l]) => `<button class="chip${fb.league === k ? " active" : ""}" data-fb-league="${k}">${l}</button>`).join("");
    const box = $("#fb-body");

    if (fb.tab === "mine") {
      if (!fb.fav) { box.innerHTML = `<p class="muted cal-empty">Wird geladen …</p>`; return; }
      box.innerHTML = fb.fav.teams.map(t => {
        const lg = t.league ? LEAGUES.find(l => l[0] === t.league)[1] : "nicht in der 1./2. Liga gefunden";
        const form = t.last.map(m => resultFor(m, t.team)).filter(Boolean)
          .map(r => `<span class="fb-form ${r}">${r}</span>`).join("");
        return `<section class="card fb-card">
          <div class="fb-card-head"><strong>${escapeHtml(t.team)}</strong><span class="muted small">${escapeHtml(lg)}</span>${form ? `<span class="fb-forms" title="Letzte Spiele: S = Sieg, U = Unentschieden, N = Niederlage">${form}</span>` : ""}</div>
          ${t.live ? `<ul class="fb-list">${matchRow(t.live)}</ul>` : ""}
          ${t.last.length ? `<h4 class="cal-sub">Zuletzt</h4><ul class="fb-list">${t.last.slice().reverse().map(m => matchRow(m)).join("")}</ul>` : ""}
          ${t.next.length ? `<h4 class="cal-sub">Nächste Spiele</h4><ul class="fb-list">${t.next.map(m => matchRow(m)).join("")}</ul>` : ""}
        </section>`;
      }).join("") + `<button type="button" class="btn btn-small" id="btn-fb-teams">⭐ Vereine auswählen</button>`;
      return;
    }

    const d = fb.data[`${fb.league}|${fb.group || "cur"}`];
    if (!d) { box.innerHTML = `<p class="muted cal-empty">Wird geladen …</p>`; return; }
    if (fb.tab === "day") {
      // nach Tagen gruppieren
      const byDay = new Map();
      for (const m of d.matches) {
        const k = new Date(m.utc).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(m);
      }
      box.innerHTML = `<div class="fb-daybar">
          <button class="icon-btn" data-fb-group="${d.group - 1}" ${d.group <= 1 ? "disabled" : ""} aria-label="Voriger Spieltag">‹</button>
          <strong>${d.group}. Spieltag${d.group === d.current ? " (aktuell)" : ""}</strong>
          <button class="icon-btn" data-fb-group="${d.group + 1}" ${d.group >= 38 ? "disabled" : ""} aria-label="Nächster Spieltag">›</button>
          ${d.group !== d.current ? `<button class="btn btn-small" data-fb-group="0">Aktuell</button>` : ""}
        </div>
        ${[...byDay.entries()].map(([day, ms]) => `<h4 class="cal-sub">${escapeHtml(day)}</h4><ul class="fb-list">${ms.map(m => matchRow(m, false)).join("")}</ul>`).join("") || `<p class="muted cal-empty">Keine Spiele.</p>`}`;
      return;
    }
    // Tabelle
    const n = d.table.length;
    box.innerHTML = `<table class="fb-table"><thead><tr><th>#</th><th>Verein</th><th>Sp</th><th>Diff</th><th>Pkt</th></tr></thead><tbody>
      ${d.table.map(t => {
        const zone = fb.league === "bl1"
          ? (t.pos <= 4 ? "cl" : t.pos <= 6 ? "el" : t.pos >= n - 1 ? "down" : t.pos === n - 2 ? "rel" : "")
          : (t.pos <= 2 ? "up" : t.pos === 3 ? "rel" : t.pos >= n - 1 ? "down" : t.pos === n - 2 ? "rel" : "");
        return `<tr class="${isFav(t.team) ? "fav " : ""}${zone ? "z-" + zone : ""}"><td>${t.pos}</td>
          <td class="fb-tname">${logo(t.icon)} ${escapeHtml(t.short || t.team)}</td>
          <td>${t.played}</td><td>${t.diff > 0 ? "+" : ""}${t.diff}</td><td><b>${t.points}</b></td></tr>`;
      }).join("")}</tbody></table>
      <p class="muted small">${fb.league === "bl1" ? "Plätze 1–4 Champions League, 5–6 Europa League, 16 Relegation, 17–18 Abstieg." : "Plätze 1–2 Aufstieg, 3 und 16 Relegation, 17–18 Abstieg."}</p>`;
  }

  // ---------- Laden ----------
  async function loadOverview(force) {
    const key = `${fb.league}|${fb.group || "cur"}`;
    if (!force && fb.data[key] && Date.now() - fb.data[key].loadedAt < 60000) { render(); return; }
    try {
      const d = await invoke({ what: "overview", league: fb.league, group: fb.group || 0 });
      fb.data[key] = { ...d, loadedAt: Date.now() };
    } catch (err) {
      if (!fb.data[key]) $("#fb-body").innerHTML = `<p class="muted cal-empty">${escapeHtml(err.message)}</p>`;
      toast(err.message, true);
      return;
    }
    render();
  }
  async function loadFav() {
    try {
      fb.fav = await invoke({ what: "fav", teams: myTeams() });
      fb.fav.loadedAt = Date.now();
    } catch (err) {
      $("#fb-body").innerHTML = `<p class="muted cal-empty">${escapeHtml(err.message)}</p>`;
      toast(err.message, true);
      return;
    }
    render();
    paintTile();
  }
  function load(force) { if (fb.tab === "mine") return loadFav(); return loadOverview(force); }

  // ---------- Vereine wählen ----------
  async function openTeams() {
    $("#fb-team-list").innerHTML = `<p class="muted small">Vereine werden geladen …</p>`;
    openSheet("sheet-fb-teams");
    try {
      if (!fb.teams) fb.teams = await invoke({ what: "teams" });
    } catch (err) { $("#fb-team-list").innerHTML = `<p class="muted small">${escapeHtml(err.message)}</p>`; return; }
    const chosen = new Set(myTeams().map(t => t.toLowerCase()));
    $("#fb-team-list").innerHTML = LEAGUES.map(([k, l]) => `<h4 class="cal-sub">${l}</h4><div class="chip-wrap">${(fb.teams[k] || []).map(t =>
      `<button type="button" class="chip${chosen.has(t.toLowerCase()) ? " active" : ""}" data-fb-team="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("")}</div>`).join("");
  }
  $("#sheet-fb-teams").addEventListener("click", e => {
    const b = e.target.closest("[data-fb-team]");
    if (b) b.classList.toggle("active");
  });
  $("#btn-fb-teams-save").addEventListener("click", async () => {
    const teams = [...document.querySelectorAll("#fb-team-list [data-fb-team].active")].map(b => b.dataset.fbTeam).slice(0, 6);
    const { error } = await sb.from("profiles").update({ football_teams: teams }).eq("id", state.session.user.id);
    if (error) { toast(/football_teams/.test(error.message || "") ? "Bitte zuerst das SQL aus Schritt 38 in Supabase ausführen." : translateError(error), true); return; }
    state.profile.football_teams = teams;
    closeSheets();
    fb.fav = null;
    render();
    loadFav();
  });

  $("#view-football").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.fbTab) { fb.tab = b.dataset.fbTab; storageSet("pp_fb_tab", fb.tab); render(); load(); }
    if (b.dataset.fbLeague) { fb.league = b.dataset.fbLeague; fb.group = null; storageSet("pp_fb_league", fb.league); render(); load(); }
    if (b.dataset.fbGroup !== undefined) { fb.group = +b.dataset.fbGroup || null; render(); loadOverview(); }
    if (b.id === "btn-fb-teams") openTeams();
    if (b.id === "btn-fb-refresh") load(true);
  });

  // ---------- Startseite ----------
  function paintTile() {
    const el = $("#tile-fb-status");
    if (!el || !fb.fav || !fb.fav.teams.length) return;
    const t = fb.fav.teams[0];
    const m = t.live || t.next[0];
    const last = t.last[t.last.length - 1];
    const short = (x, a, b) => `${x[a] || x[b]}`;
    if (t.live) el.textContent = `🔴 ${short(m, "s1", "t1")} ${m.g1}:${m.g2} ${short(m, "s2", "t2")}`;
    else if (last && (!m || Date.now() - Date.parse(last.utc) < 2 * 864e5)) el.textContent = `${short(last, "s1", "t1")} ${last.g1}:${last.g2} ${short(last, "s2", "t2")}`;
    else if (m) el.textContent = `${fmtKick(m.utc)} · ${short(m, "s1", "t1")} – ${short(m, "s2", "t2")}`;
  }
  async function refreshTile() {
    if (fb.fav && Date.now() - fb.fav.loadedAt < 10 * 60000) { paintTile(); return; }
    try { fb.fav = await invoke({ what: "fav", teams: myTeams() }); fb.fav.loadedAt = Date.now(); paintTile(); } catch { /* still */ }
  }

  PP.modules.football = {
    enter() { fb.active = true; render(); load(); },
    leave() { fb.active = false; },
    resume() { if (fb.active) load(true); },
    refreshTile,
    reset() { fb.data = {}; fb.fav = null; }
  };
})();
