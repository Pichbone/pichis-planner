// =========================================================
// Pichis Planner – Startseite selbst einrichten
// Kacheln ein-/ausblenden, sortieren und breit anzeigen (je Person)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, $$, toast, escapeHtml, translateError, storageGet, storageSet } = PP;

  const CACHE_KEY = "pp_tiles";
  let layout = null;          // [{ id, hidden, wide }]
  let saveTimer = null;
  let loaded = false;         // Profil-Einstellung schon übernommen?

  // Kachel-Kennung aus dem Link (#/aufgaben → aufgaben); ohne Link: nach Name
  function tileId(el) {
    if (el.dataset.tile) return el.dataset.tile;
    const href = el.getAttribute("href") || "";
    const id = href.replace(/^#\/?/, "") || (el.querySelector(".tile-name") || {}).textContent.trim().toLowerCase().replace(/\W+/g, "-");
    el.dataset.tile = id;
    return id;
  }

  function tiles() {
    const box = $(".tiles");
    return box ? [...box.children].filter(el => el.classList.contains("tile")) : [];
  }

  // Gespeicherte Einstellung mit den vorhandenen Kacheln abgleichen
  // (neue Kacheln aus späteren Versionen erscheinen automatisch am Ende)
  function normalize(saved) {
    const all = tiles().map(tileId);
    const out = [];
    for (const s of Array.isArray(saved) ? saved : []) {
      if (s && all.includes(s.id) && !out.some(o => o.id === s.id)) out.push({ id: s.id, hidden: !!s.hidden, wide: !!s.wide });
    }
    for (const id of all) if (!out.some(o => o.id === id)) out.push({ id, hidden: false, wide: false });
    return out;
  }

  function apply() {
    const box = $(".tiles");
    if (!box || !layout) return;
    const byId = new Map(tiles().map(el => [tileId(el), el]));
    for (const t of layout) {
      const el = byId.get(t.id);
      if (!el) continue;
      box.appendChild(el);              // Reihenfolge
      el.hidden = t.hidden;
      el.classList.toggle("tile-wide", t.wide);
    }
    const empty = $("#tiles-empty");
    if (empty) empty.hidden = layout.some(t => !t.hidden);
  }

  function load() {
    let saved = state.profile && state.profile.home_tiles;
    if (!saved) { try { saved = JSON.parse(storageGet(CACHE_KEY) || "null"); } catch { saved = null; } }
    layout = normalize(saved);
    apply();
    renderSettings();
  }

  function scheduleSave() {
    storageSet(CACHE_KEY, JSON.stringify(layout));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { error } = await sb.from("profiles").update({ home_tiles: layout }).eq("id", state.session.user.id);
      if (error) {
        toast(/home_tiles/.test(error.message || "") ? "Gilt erst nur auf diesem Gerät – für alle Geräte bitte das SQL aus Schritt 26 ausführen." : translateError(error), true);
        return;
      }
      if (state.profile) state.profile.home_tiles = layout;
    }, 700);
  }

  // ---------- Einstellungen ----------
  function info(id) {
    const el = tiles().find(t => tileId(t) === id);
    return {
      icon: el ? (el.querySelector(".tile-icon") || {}).textContent || "" : "",
      name: el ? (el.querySelector(".tile-name") || {}).textContent || id : id
    };
  }

  function renderSettings() {
    const list = $("#tiles-settings");
    if (!list || !layout) return;
    list.innerHTML = layout.map((t, i) => {
      const { icon, name } = info(t.id);
      return `<li class="ts-row${t.hidden ? " is-hidden" : ""}">
        <label class="ts-show" title="Anzeigen">
          <input type="checkbox" data-ts-show="${i}" ${t.hidden ? "" : "checked"} aria-label="${escapeHtml(name)} anzeigen">
          <span class="ts-icon">${escapeHtml(icon)}</span>
          <span class="ts-name">${escapeHtml(name)}</span>
        </label>
        <button type="button" class="ts-btn${t.wide ? " on" : ""}" data-ts-wide="${i}" aria-pressed="${t.wide}" title="Breit anzeigen" aria-label="${escapeHtml(name)} breit anzeigen">↔︎</button>
        <button type="button" class="ts-btn" data-ts-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="${escapeHtml(name)} nach oben">↑</button>
        <button type="button" class="ts-btn" data-ts-down="${i}" ${i === layout.length - 1 ? "disabled" : ""} aria-label="${escapeHtml(name)} nach unten">↓</button>
      </li>`;
    }).join("");
  }

  function changed(focusSel) {
    apply();
    renderSettings();
    scheduleSave();
    if (focusSel) { const b = $(focusSel); if (b && !b.disabled) b.focus(); }
  }

  $("#tiles-settings").addEventListener("change", e => {
    const i = e.target.dataset.tsShow;
    if (i === undefined) return;
    layout[+i].hidden = !e.target.checked;
    changed();
  });
  $("#tiles-settings").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tsWide !== undefined) { const t = layout[+b.dataset.tsWide]; t.wide = !t.wide; changed(`[data-ts-wide="${b.dataset.tsWide}"]`); }
    if (b.dataset.tsUp !== undefined) {
      const i = +b.dataset.tsUp; if (i < 1) return;
      [layout[i - 1], layout[i]] = [layout[i], layout[i - 1]];
      changed(`[data-ts-up="${i - 1}"]`);
    }
    if (b.dataset.tsDown !== undefined) {
      const i = +b.dataset.tsDown; if (i >= layout.length - 1) return;
      [layout[i + 1], layout[i]] = [layout[i], layout[i + 1]];
      changed(`[data-ts-down="${i + 1}"]`);
    }
  });
  $("#btn-tiles-reset").addEventListener("click", () => {
    if (!confirm("Startseite auf die ursprüngliche Anordnung zurücksetzen?")) return;
    // ursprüngliche Reihenfolge = Reihenfolge in der Seite beim Laden
    layout = ORIGINAL.map(id => ({ id, hidden: false, wide: false }));
    changed();
  });

  const ORIGINAL = tiles().map(tileId);

  // Sofort aus dem Zwischenspeicher anwenden (vor dem Laden des Profils)
  try { const c = JSON.parse(storageGet(CACHE_KEY) || "null"); if (c) { layout = normalize(c); apply(); } } catch { /* egal */ }

  PP.tiles = { load };
  PP.modules.tiles = {
    enter() {}, leave() {},
    resume() {},
    refreshTile() { if (!loaded && state.profile) { loaded = true; load(); } },
    reset() { layout = null; loaded = false; storageSet(CACHE_KEY, "null"); }
  };
})();
