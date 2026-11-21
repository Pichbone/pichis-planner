// =========================================================
// Pichis Planner – Essensplan (Abendessen) mit Rezepten
// Woche planen, Rezepte sammeln, Zutaten auf die Einkaufsliste
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, openSheet, closeSheets } = PP;

  const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  // Was meist im Haus ist – wird beim Übernehmen erst einmal abgewählt
  const PANTRY = ["salz", "pfeffer", "öl", "olivenöl", "wasser", "zucker", "mehl", "essig", "gewürze", "paprikapulver", "oregano", "brühe", "gemüsebrühe"];

  const ml = {
    active: false,
    tab: storageGet("pp_meal_tab") || "week",
    weekStart: null,
    plan: [],          // Einträge der angezeigten Woche
    recipes: [],
    query: "",
    editDay: null,
    editRecipe: null,
    pickRecipe: null,
    shopRows: [],
    channel: null
  };
  const hid = () => state.household.id;
  const pad = n => String(n).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  const today = () => iso(new Date());

  function sqlHint(err) {
    return /recipes|meal_plan|does not exist/i.test((err && err.message) || "") ? "Bitte zuerst das SQL aus Schritt 32 in Supabase ausführen." : translateError(err);
  }

  // =========================================================
  // Zutaten lesen, umrechnen, zusammenfassen
  // =========================================================
  const UNIT = "kg|g|mg|l|ml|cl|dl|EL|TL|Msp|Prise[n]?|Stk|Stück|Dose[n]?|Pck|Päckchen|Packung(?:en)?|Bund|Becher|Zehe[n]?|Scheibe[n]?|Tasse[n]?|Glas|Gläser|Kopf|Köpfe|Knolle[n]?|Stange[n]?|Zweig[e]?|Handvoll|Beutel|Flasche[n]?|Netz";
  const FRAC = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
  const RE_ING = new RegExp(`^(\\d+(?:[.,]\\d+)?(?:\\s*[-–]\\s*\\d+(?:[.,]\\d+)?)?|\\d+\\s*\\/\\s*\\d+|[½¼¾⅓⅔])?\\s*(?:(${UNIT})\\.?(?=\\s|$))?\\s*(.*)$`, "i");

  function num(s) {
    if (!s) return null;
    s = s.trim();
    if (FRAC[s] != null) return FRAC[s];
    if (/\//.test(s)) { const [a, b] = s.split("/").map(Number); return b ? a / b : null; }
    if (/[-–]/.test(s)) s = s.split(/[-–]/)[1];        // „2-3“ → 3
    const n = parseFloat(s.replace(",", "."));
    return isNaN(n) ? null : n;
  }

  // „Salz, Pfeffer“ (ohne Menge) sind zwei Zutaten
  function splitLines(text) {
    const out = [];
    for (const line of String(text || "").split("\n")) {
      const l = line.replace(/^[\s\-•*·]+/, "").trim();
      if (!l) continue;
      const parts = l.split(/\s*,\s*|\s+und\s+/i);
      if (parts.length > 1 && !/^[\d½¼¾⅓⅔]/.test(l) && parts.every(p => p && p.split(/\s+/).length <= 3)) out.push(...parts);
      else out.push(l);
    }
    return out;
  }

  function parseIngredient(line) {
    const raw = String(line || "").replace(/^[\s\-•*·]+/, "").trim();
    if (!raw) return null;
    const m = RE_ING.exec(raw);
    const qty = m && m[1] ? num(m[1]) : null;
    let unit = m && m[2] ? m[2] : "";
    let name = (m && m[3] ? m[3] : raw).trim();
    if (!name) { name = raw; unit = ""; }
    // Zusatz in Klammern oder nach Komma ist Hinweis, nicht Name: „Zwiebel, fein gewürfelt“
    const note = (name.match(/\(([^)]*)\)|,\s*(.+)$/) || []).slice(1).find(Boolean) || "";
    name = name.replace(/\([^)]*\)/g, "").replace(/,.*$/, "").trim() || name;
    return { qty, unit, name, note, raw };
  }

  function fmtQty(q, unit) {
    if (q == null) return "";
    let v = q;
    if (/^(g|ml)$/i.test(unit) && v >= 100) v = Math.round(v / 10) * 10;
    else if (/^(g|ml)$/i.test(unit)) v = Math.round(v / 5) * 5 || Math.round(v);
    else if (Math.abs(v - Math.round(v)) < 0.05) v = Math.round(v);
    else if (Math.abs(v * 2 - Math.round(v * 2)) < 0.1) v = Math.round(v * 2) / 2;
    else v = Math.round(v * 10) / 10;
    const s = String(v).replace(".", ",").replace(/^0,5$/, "½").replace(/,5$/, "½");
    return s;
  }

  // Zutaten aller geplanten Gerichte (umgerechnet auf die Personenzahl) zusammenfassen
  function collect(entries) {
    const map = new Map();
    for (const e of entries) {
      const r = ml.recipes.find(x => x.id === e.recipe_id);
      if (!r) continue;
      const factor = (e.servings || r.servings) / (r.servings || 1);
      for (const line of splitLines(r.ingredients)) {
        const ing = parseIngredient(line);
        if (!ing) continue;
        const key = ing.name.toLowerCase() + "|" + ing.unit.toLowerCase();
        const cur = map.get(key) || { name: ing.name, unit: ing.unit, qty: 0, hasQty: false, from: new Set() };
        if (ing.qty != null) { cur.qty += ing.qty * factor; cur.hasQty = true; }
        cur.from.add(r.name);
        map.set(key, cur);
      }
    }
    return [...map.values()].map(x => ({
      name: x.name,
      quantity: x.hasQty ? (fmtQty(x.qty, x.unit) + (x.unit ? " " + x.unit : "")).trim() : "",
      from: [...x.from]
    })).sort((a, b) => a.name.localeCompare(b.name, "de"));
  }

  // =========================================================
  // Daten
  // =========================================================
  async function loadRecipes() {
    const { data, error } = await sb.from("recipes").select("*").eq("household_id", hid()).order("name");
    if (error) throw error;
    ml.recipes = data;
  }
  async function loadWeek() {
    const from = iso(ml.weekStart), to = iso(addDays(ml.weekStart, 6));
    const { data, error } = await sb.from("meal_plan").select("*").eq("household_id", hid()).gte("day", from).lte("day", to);
    if (error) throw error;
    ml.plan = data.filter(x => x.day >= from && x.day <= to);
  }
  function subscribe() {
    unsubscribe();
    const re = () => { clearTimeout(ml.t); ml.t = setTimeout(async () => { try { await Promise.all([loadWeek(), loadRecipes()]); render(); } catch { /* egal */ } }, 300); };
    ml.channel = sb.channel("meals-" + hid())
      .on("postgres_changes", { event: "*", schema: "public", table: "meal_plan", filter: `household_id=eq.${hid()}` }, re)
      .on("postgres_changes", { event: "*", schema: "public", table: "recipes", filter: `household_id=eq.${hid()}` }, re)
      .subscribe();
  }
  function unsubscribe() { if (ml.channel) { sb.removeChannel(ml.channel); ml.channel = null; } }

  const dishOf = e => {
    if (!e) return "";
    const r = e.recipe_id && ml.recipes.find(x => x.id === e.recipe_id);
    return r ? r.name : e.title;
  };

  // =========================================================
  // Nährwerte je Portion (KI-Schätzung aus den Zutaten, Schritt 36)
  // =========================================================
  const nutKey = r => `${r.servings}|${String(r.ingredients || "").split("\n").map(l => l.trim().toLowerCase()).filter(Boolean).join("\n")}`;
  const nutOk = r => r && r.nutrition && r.nutrition.kcal != null && r.nutrition_for === nutKey(r);
  const kcalText = r => nutOk(r) ? `≈ ${Math.round(r.nutrition.kcal)} kcal` : "";
  const fmtG = v => v == null ? "–" : `${String(v).replace(".", ",")} g`;
  const nutBusy = new Set();

  async function calcNutrition(r) {
    if (!r || !String(r.ingredients || "").trim() || nutBusy.has(r.id)) return null;
    nutBusy.add(r.id);
    try {
      const { data, error } = await sb.functions.invoke("assist", { body: { action: "nutrition", name: r.name, servings: r.servings, ingredients: r.ingredients } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
        throw new Error(msg);
      }
      const key = nutKey(r);
      const { error: e2 } = await sb.from("recipes").update({ nutrition: data, nutrition_for: key }).eq("id", r.id);
      if (e2) throw new Error(/nutrition/.test(e2.message || "") ? "Bitte zuerst das SQL aus Schritt 36 in Supabase ausführen." : translateError(e2));
      const cur = ml.recipes.find(x => x.id === r.id);
      if (cur) { cur.nutrition = data; cur.nutrition_for = key; }
      return data;
    } finally {
      nutBusy.delete(r.id);
    }
  }

  function renderNutrition() {
    const box = $("#recipe-nutrition");
    const r = ml.editRecipe && ml.recipes.find(x => x.id === ml.editRecipe.id);
    if (!r) { box.hidden = true; return; }
    box.hidden = false;
    if (nutBusy.has(r.id)) { box.innerHTML = `<p class="muted small">🔢 Nährwerte werden berechnet …</p>`; return; }
    if (!String(r.ingredients || "").trim()) { box.innerHTML = `<p class="muted small">Nährwerte: erst Zutaten eintragen.</p>`; return; }
    const n = r.nutrition;
    if (!n || n.kcal == null) {
      box.innerHTML = `<button type="button" class="btn btn-small" id="btn-nutri">🔢 Nährwerte pro Portion berechnen</button>`;
      return;
    }
    const stale = !nutOk(r);
    box.innerHTML = `<div class="nutri-head"><strong>Pro Portion</strong><span class="muted small">KI-Schätzung · Verlässlichkeit ${escapeHtml(n.confidence || "mittel")}</span></div>
      <div class="nutri-kcal">${Math.round(n.kcal)} <small>kcal</small></div>
      <dl class="nutri-grid">
        <div><dt>Kohlenhydrate</dt><dd>${fmtG(n.carbs)}</dd></div>
        <div><dt>davon Zucker</dt><dd>${fmtG(n.sugar)}</dd></div>
        <div><dt>Fett</dt><dd>${fmtG(n.fat)}</dd></div>
        <div><dt>davon gesättigt</dt><dd>${fmtG(n.saturated)}</dd></div>
        <div><dt>Eiweiß</dt><dd>${fmtG(n.protein)}</dd></div>
        <div><dt>Ballaststoffe</dt><dd>${fmtG(n.fiber)}</dd></div>
        <div><dt>Salz</dt><dd>${fmtG(n.salt)}</dd></div>
      </dl>
      ${n.note ? `<p class="muted small">${escapeHtml(n.note)}</p>` : ""}
      ${stale ? `<p class="small nutri-stale">Zutaten oder Portionen wurden geändert – <button type="button" class="link" id="btn-nutri">neu berechnen</button></p>`
              : `<button type="button" class="link small" id="btn-nutri">neu berechnen</button>`}`;
  }

  async function nutriFor(r, quiet) {
    renderNutrition();
    try {
      await calcNutrition(r);
      if (!quiet) toast("Nährwerte berechnet.");
    } catch (err) {
      toast(`Nährwerte: ${err.message}`, true);
    }
    renderNutrition();
    if (ml.active) render();
  }

  async function nutriAll(btn) {
    const todo = ml.recipes.filter(r => String(r.ingredients || "").trim() && !nutOk(r));
    if (!todo.length) return;
    btn.disabled = true;
    let ok = 0, bad = 0, lastErr = "";
    for (const r of todo) {
      btn.textContent = `🔢 ${ok + bad + 1}/${todo.length} …`;
      try { await calcNutrition(r); ok++; } catch (err) { bad++; lastErr = err.message; if (/Schritt 36/.test(lastErr)) break; }
    }
    render();
    toast(bad ? `${ok} berechnet, ${bad} nicht: ${lastErr}` : `Nährwerte für ${ok} Rezept${ok === 1 ? "" : "e"} berechnet.`, !!bad);
  }

  // =========================================================
  // Darstellung
  // =========================================================
  function render() {
    if (!ml.active) return;
    $("#meal-tabs").innerHTML =
      `<button class="chip${ml.tab === "week" ? " active" : ""}" data-meal-tab="week">🗓️ Woche</button>` +
      `<button class="chip${ml.tab === "recipes" ? " active" : ""}" data-meal-tab="recipes">📖 Rezepte <span class="chip-count">${ml.recipes.length}</span></button>`;
    $("#meal-week").hidden = ml.tab !== "week";
    $("#meal-recipes").hidden = ml.tab !== "recipes";
    if (ml.tab === "week") renderWeek(); else renderRecipes();
  }

  function renderWeek() {
    const s = ml.weekStart, e = addDays(s, 6);
    const same = s.getMonth() === e.getMonth();
    $("#meal-week-title").textContent = `${s.getDate()}.${same ? "" : " " + s.toLocaleDateString("de-DE", { month: "short" })} – ${e.getDate()}. ${e.toLocaleDateString("de-DE", { month: "short", year: "numeric" })}`;
    const t = today();
    let html = "";
    for (let i = 0; i < 7; i++) {
      const d = iso(addDays(s, i));
      const entry = ml.plan.find(x => x.day === d);
      const dish = dishOf(entry);
      const r = entry && entry.recipe_id && ml.recipes.find(x => x.id === entry.recipe_id);
      html += `<li><button class="meal-day${d === t ? " is-today" : ""}${d < t ? " is-past" : ""}" data-meal-day="${d}">
        <span class="meal-date"><b>${WD[i]}</b><small>${parse(d).getDate()}.${parse(d).getMonth() + 1}.</small></span>
        <span class="meal-main">
          ${dish ? `<span class="meal-dish">${r && r.is_favorite ? "⭐ " : ""}${escapeHtml(dish)}</span>
            <span class="meal-sub">${[r ? `für ${entry.servings}` : "", r ? kcalText(r) + (kcalText(r) ? "/Portion" : "") : "", entry.note].filter(Boolean).map(escapeHtml).join(" · ")}</span>`
          : `<span class="meal-empty">+ Abendessen planen</span>`}
        </span>
      </button></li>`;
    }
    $("#meal-days").innerHTML = html;
    const withRecipe = ml.plan.filter(x => x.recipe_id && x.day >= (iso(s) > t ? iso(s) : t));
    $("#btn-meal-shop").disabled = !withRecipe.length;
    $("#btn-meal-shop").textContent = withRecipe.length
      ? `🛒 Zutaten für ${withRecipe.length} Gericht${withRecipe.length === 1 ? "" : "e"} auf die Einkaufsliste`
      : "🛒 Zutaten auf die Einkaufsliste";
  }

  function renderRecipes() {
    const q = ml.query.trim().toLowerCase();
    const list = ml.recipes
      .filter(r => !q || r.name.toLowerCase().includes(q) || r.ingredients.toLowerCase().includes(q))
      .sort((a, b) => (b.is_favorite - a.is_favorite) || a.name.localeCompare(b.name, "de"));
    const missing = ml.recipes.filter(r => String(r.ingredients || "").trim() && !nutOk(r)).length;
    $("#recipe-items").innerHTML = list.length
      ? (missing ? `<div class="ar-recipe-bar"><span>🔢 ${missing} Rezept${missing === 1 ? "" : "e"} ohne aktuelle Nährwerte</span><button class="btn btn-small" id="btn-nutri-all">Berechnen</button></div>` : "") +
        `<ul class="ar-list">${list.map(r => {
          const n = r.ingredients.split("\n").filter(l => l.trim()).length;
          return `<li><button class="ar-doc" data-recipe="${r.id}">
            <span class="ar-icon">${r.is_favorite ? "⭐" : "🍲"}</span>
            <span class="ar-main"><span class="ar-title">${escapeHtml(r.name)}</span>
            <span class="ar-sub">für ${r.servings} · ${n} Zutat${n === 1 ? "" : "en"}${nutOk(r) ? ` · ${kcalText(r)}` : ""}${r.url ? " · 🔗" : ""}${r.archive_doc_id ? " · 📄" : ""}</span></span>
          </button></li>`;
        }).join("")}</ul>`
      : `<div class="empty"><div class="empty-icon">📖</div><p><strong>${ml.recipes.length ? "Nichts gefunden." : "Noch keine Rezepte."}</strong></p>
         <p class="muted small">Mit „+ Rezept“ Lieblingsgerichte mit Zutaten speichern – dann landen die Zutaten per Knopfdruck auf der Einkaufsliste.</p></div>`;
  }

  // =========================================================
  // Tag planen
  // =========================================================
  function renderPicker() {
    const q = $("#meal-search").value.trim().toLowerCase();
    const list = ml.recipes.filter(r => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => (b.is_favorite - a.is_favorite) || a.name.localeCompare(b.name, "de")).slice(0, 30);
    $("#meal-pick").innerHTML = list.map(r =>
      `<button type="button" class="chip${ml.pickRecipe === r.id ? " active" : ""}" data-pick-recipe="${r.id}">${r.is_favorite ? "⭐ " : ""}${escapeHtml(r.name)}</button>`).join("") ||
      `<span class="muted small">${ml.recipes.length ? "Kein Rezept gefunden – einfach unten eintragen." : "Noch keine Rezepte – trag das Gericht einfach unten ein."}</span>`;
  }

  function openDay(day) {
    ml.editDay = day;
    const entry = ml.plan.find(x => x.day === day);
    ml.pickRecipe = entry ? entry.recipe_id : null;
    const f = $("#form-meal");
    f.reset();
    $("#meal-search").value = "";
    f.title.value = entry && !entry.recipe_id ? entry.title : "";
    f.servings.value = entry ? entry.servings : (storageGet("pp_meal_servings") || 4);
    f.note.value = entry ? entry.note : "";
    const d = parse(day);
    $("#meal-sheet-title").textContent = `🍽️ ${WD_LONG[(d.getDay() + 6) % 7]}, ${d.getDate()}.${d.getMonth() + 1}.`;
    $("#btn-meal-remove").hidden = !entry;
    renderPicker();
    openSheet("sheet-meal");
  }

  $("#meal-search").addEventListener("input", renderPicker);
  $("#sheet-meal").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.pickRecipe) {
      ml.pickRecipe = ml.pickRecipe === b.dataset.pickRecipe ? null : b.dataset.pickRecipe;
      const r = ml.recipes.find(x => x.id === ml.pickRecipe);
      if (r && !ml.plan.find(x => x.day === ml.editDay)) $("#form-meal").servings.value = storageGet("pp_meal_servings") || r.servings;
      if (ml.pickRecipe) $("#form-meal").title.value = "";
      renderPicker();
    }
    if (b.dataset.step) {
      const f = $("#form-meal");
      f.servings.value = Math.max(1, Math.min(50, (+f.servings.value || 4) + +b.dataset.step));
    }
  });
  $("#form-meal").title.addEventListener("input", e => { if (e.target.value.trim() && ml.pickRecipe) { ml.pickRecipe = null; renderPicker(); } });

  $("#form-meal").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const title = f.title.value.trim();
      if (!ml.pickRecipe && !title) throw new Error("Bitte ein Rezept wählen oder ein Gericht eintragen.");
      const row = {
        household_id: hid(), day: ml.editDay,
        recipe_id: ml.pickRecipe, title: ml.pickRecipe ? "" : title.slice(0, 120),
        servings: Math.max(1, Math.min(50, +f.servings.value || 4)), note: f.note.value.trim().slice(0, 500)
      };
      storageSet("pp_meal_servings", String(row.servings));
      const { error } = await sb.from("meal_plan").upsert(row, { onConflict: "household_id,day" });
      if (error) throw new Error(sqlHint(error));
      closeSheets();
      await loadWeek();
      render();
    });
  });

  $("#btn-meal-remove").addEventListener("click", async () => {
    const { error } = await sb.from("meal_plan").delete().eq("household_id", hid()).eq("day", ml.editDay);
    if (error) { toast(translateError(error), true); return; }
    ml.plan = ml.plan.filter(x => x.day !== ml.editDay);
    closeSheets();
    render();
  });
  $("#btn-meal-show-recipe").addEventListener("click", () => {
    if (ml.pickRecipe) { closeSheets(); openRecipe(ml.pickRecipe); }
    else toast("Erst ein Rezept auswählen.");
  });

  // =========================================================
  // Rezepte
  // =========================================================
  function openRecipe(id) {
    const r = id ? ml.recipes.find(x => x.id === id) : null;
    ml.editRecipe = r;
    const f = $("#form-recipe");
    f.reset();
    f.name.value = r ? r.name : "";
    f.servings.value = r ? r.servings : 4;
    f.ingredients.value = r ? r.ingredients : "";
    f.instructions.value = r ? r.instructions : "";
    f.url.value = r ? r.url : "";
    f.is_favorite.checked = r ? r.is_favorite : false;
    f.plan_day.value = "";
    $("#recipe-sheet-title").textContent = r ? r.name : "Neues Rezept";
    $("#btn-recipe-delete").hidden = !r;
    $("#recipe-link").innerHTML = r && /^https?:\/\//.test(r.url) ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">🔗 Rezept im Netz öffnen</a>` : "";
    $("#recipe-original").hidden = !(r && r.archive_doc_id && PP.archiveDoc);
    previewIngredients();
    renderNutrition();
    openSheet("sheet-recipe");
    if (!r) setTimeout(() => f.name.focus(), 60);
  }

  function previewIngredients() {
    const f = $("#form-recipe");
    const items = splitLines(f.ingredients.value).map(parseIngredient).filter(Boolean);
    $("#recipe-preview").textContent = items.length
      ? "Erkannt: " + items.slice(0, 6).map(i => [i.qty != null ? fmtQty(i.qty, i.unit) : "", i.unit, i.name].filter(Boolean).join(" ")).join(" · ") + (items.length > 6 ? " …" : "")
      : "";
  }
  $("#form-recipe").ingredients.addEventListener("input", previewIngredients);

  $("#form-recipe").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const name = f.name.value.trim();
      if (!name) throw new Error("Bitte einen Namen eingeben.");
      const url = f.url.value.trim();
      const row = {
        name: name.slice(0, 120), servings: Math.max(1, Math.min(50, +f.servings.value || 4)),
        ingredients: f.ingredients.value.split("\n").map(l => l.trim()).filter(Boolean).join("\n").slice(0, 5000),
        instructions: f.instructions.value.trim().slice(0, 20000),
        url: url && !/^https?:\/\//i.test(url) ? "https://" + url : url,
        is_favorite: f.is_favorite.checked
      };
      let id = ml.editRecipe && ml.editRecipe.id;
      if (id) {
        const { error } = await sb.from("recipes").update(row).eq("id", id);
        if (error) throw new Error(sqlHint(error));
      } else {
        const { data, error } = await sb.from("recipes").insert({ ...row, household_id: hid() }).select("id").single();
        if (error) throw new Error(sqlHint(error));
        id = data.id;
      }
      // Direkt einplanen?
      if (f.plan_day.value) {
        const { error } = await sb.from("meal_plan").upsert({ household_id: hid(), day: f.plan_day.value, recipe_id: id, title: "", servings: row.servings, note: "" }, { onConflict: "household_id,day" });
        if (error) throw error;
      }
      closeSheets();
      toast(f.plan_day.value ? "Gespeichert und eingeplant." : "Rezept gespeichert.");
      await Promise.all([loadRecipes(), loadWeek()]);
      render();
      // Nährwerte neu schätzen, wenn sich Zutaten oder Portionen geändert haben
      const saved = ml.recipes.find(x => x.id === id);
      if (saved && row.ingredients && !nutOk(saved)) nutriFor(saved, true);
    });
  });

  $("#recipe-nutrition").addEventListener("click", e => {
    if (e.target.closest("#btn-nutri")) {
      const r = ml.editRecipe && ml.recipes.find(x => x.id === ml.editRecipe.id);
      if (r) nutriFor(r, false);
    }
  });
  $("#recipe-items").addEventListener("click", e => {
    const b = e.target.closest("#btn-nutri-all");
    if (b) nutriAll(b);
  });

  $("#btn-recipe-original").addEventListener("click", () => {
    const r = ml.editRecipe;
    if (r && r.archive_doc_id && PP.archiveDoc) PP.archiveDoc.preview(r.archive_doc_id, "sheet-recipe");
  });

  $("#btn-recipe-delete").addEventListener("click", async () => {
    const r = ml.editRecipe;
    if (!r || !confirm(`Rezept „${r.name}“ löschen? Geplante Abende behalten den Namen des Gerichts.`)) return;
    // Name in geplanten Tagen behalten
    await sb.from("meal_plan").update({ title: r.name.slice(0, 120) }).eq("household_id", hid()).eq("recipe_id", r.id);
    const { error } = await sb.from("recipes").delete().eq("id", r.id);
    if (error) { toast(translateError(error), true); return; }
    closeSheets();
    await Promise.all([loadRecipes(), loadWeek()]);
    render();
  });

  // =========================================================
  // Zutaten auf die Einkaufsliste
  // =========================================================
  async function openShop() {
    const t = today();
    const entries = ml.plan.filter(x => x.recipe_id && x.day >= t);
    const rows = collect(entries.length ? entries : ml.plan.filter(x => x.recipe_id));
    // Einkaufslisten und schon Offenes
    const [{ data: lists }, { data: open }] = await Promise.all([
      sb.from("shopping_lists").select("id, name, sort_order").eq("household_id", hid()).order("sort_order"),
      sb.from("shopping_items").select("list_id, name").eq("household_id", hid()).eq("is_done", false)
    ]);
    ml.lists = lists || [];
    ml.open = open || [];
    $("#meal-shop-list").innerHTML = ml.lists.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join("");
    const last = storageGet("pp_list");
    if (last && ml.lists.some(l => l.id === last)) $("#meal-shop-list").value = last;
    ml.shopRows = rows.map(r => ({ ...r, pantry: PANTRY.includes(r.name.toLowerCase()), checked: !PANTRY.includes(r.name.toLowerCase()) }));
    markExisting();
    $("#meal-shop-dishes").textContent = [...new Set(entries.map(dishOf))].join(" · ");
    renderShop();
    openSheet("sheet-meal-shop");
  }

  function markExisting() {
    const listId = $("#meal-shop-list").value;
    const have = new Set(ml.open.filter(i => i.list_id === listId).map(i => i.name.toLowerCase()));
    ml.shopRows.forEach(r => { r.exists = have.has(r.name.toLowerCase()); if (r.exists) r.checked = false; });
  }

  function renderShop() {
    const sel = ml.shopRows.filter(r => r.checked).length;
    $("#meal-shop-items").innerHTML = ml.shopRows.length ? ml.shopRows.map((r, i) => `<li><label class="bd-import-row${r.exists || r.pantry ? " dupe" : ""}">
        <input type="checkbox" data-shop-row="${i}" ${r.checked ? "checked" : ""}>
        <span class="bd-main"><span class="bd-name">${r.quantity ? `<b>${escapeHtml(r.quantity)}</b> ` : ""}${escapeHtml(r.name)}</span>
        <span class="bd-sub">${escapeHtml(r.from.join(", "))}${r.exists ? " · steht schon auf der Liste" : r.pantry ? " · meist im Haus" : ""}</span></span>
      </label></li>`).join("") : `<li class="muted small">Die geplanten Rezepte haben noch keine Zutaten.</li>`;
    $("#btn-meal-shop-go").textContent = sel ? `${sel} Artikel übernehmen` : "Nichts ausgewählt";
    $("#btn-meal-shop-go").disabled = !sel;
  }

  $("#sheet-meal-shop").addEventListener("change", e => {
    if (e.target.dataset.shopRow !== undefined) { ml.shopRows[+e.target.dataset.shopRow].checked = e.target.checked; renderShop(); }
    if (e.target.id === "meal-shop-list") { ml.shopRows.forEach(r => { if (r.exists) r.checked = !r.pantry; }); markExisting(); renderShop(); }
  });

  $("#btn-meal-shop-go").addEventListener("click", async () => {
    const pick = ml.shopRows.filter(r => r.checked);
    const listId = $("#meal-shop-list").value;
    if (!pick.length || !listId) return;
    const guess = PP._shopping && PP._shopping.guessCategory ? PP._shopping.guessCategory : () => "sonstiges";
    const rows = pick.map(r => ({
      id: crypto.randomUUID(), household_id: hid(), list_id: listId, name: r.name.slice(0, 80),
      quantity: r.quantity.slice(0, 20), note: "", category: guess(r.name), is_done: false
    }));
    const { error } = await sb.from("shopping_items").insert(rows);
    if (error) { toast(translateError(error), true); return; }
    storageSet("pp_list", listId);
    closeSheets();
    toast(`${rows.length} Artikel auf „${(ml.lists.find(l => l.id === listId) || {}).name || "die Einkaufsliste"}“.`);
  });

  // =========================================================
  // Klicks
  // =========================================================
  $("#view-meals").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mealTab) { ml.tab = b.dataset.mealTab; storageSet("pp_meal_tab", ml.tab); render(); return; }
    if (b.dataset.mealDay) { openDay(b.dataset.mealDay); return; }
    if (b.dataset.recipe) { openRecipe(b.dataset.recipe); return; }
    if (b.id === "btn-meal-prev" || b.id === "btn-meal-next" || b.id === "btn-meal-today") {
      ml.weekStart = b.id === "btn-meal-today" ? mondayOf(new Date()) : addDays(ml.weekStart, b.id === "btn-meal-prev" ? -7 : 7);
      loadWeek().then(render).catch(err => toast(sqlHint(err), true));
      return;
    }
    if (b.id === "btn-meal-shop") { openShop().catch(err => toast(translateError(err), true)); return; }
    if (b.id === "btn-recipe-add") { openRecipe(null); return; }
  });
  $("#recipe-search").addEventListener("input", e => { ml.query = e.target.value; renderRecipes(); });

  // =========================================================
  // Kachel & Modul
  // =========================================================
  async function refreshTile() {
    if (!state.household) return;
    const { data, error } = await sb.from("meal_plan").select("title, recipe_id, recipes(name)").eq("household_id", hid()).eq("day", today()).maybeSingle();
    $("#tile-meal-status").textContent = error || !data ? "Was gibt's heute?" : "Heute: " + ((data.recipes && data.recipes.name) || data.title || "geplant");
  }

  PP.meals = { parseIngredient, splitLines, collect, fmtQty };
  PP.modules.meals = {
    async enter() {
      ml.active = true;
      if (!ml.weekStart) ml.weekStart = mondayOf(new Date());
      render();
      try { await Promise.all([loadRecipes(), loadWeek()]); subscribe(); }
      catch (err) { console.error(err); toast(sqlHint(err), true); }
      render();
    },
    leave() { ml.active = false; unsubscribe(); closeSheets(); },
    async resume() { if (ml.active) { try { await Promise.all([loadRecipes(), loadWeek()]); render(); } catch { /* egal */ } } else refreshTile(); },
    refreshTile,
    reset() { this.leave(); ml.plan = []; ml.recipes = []; ml.weekStart = null; }
  };
})();
