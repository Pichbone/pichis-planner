// =========================================================
// Pichis Planner – Kühlschrank-Koch
// Foto vom Kühlschrank/Vorrat (oder eintippen) → KI erkennt, was da ist,
// und schlägt Gerichte vor: zuerst eigene Rezepte, dann neue Ideen.
// Mit einem Tipp in den Essensplan, Fehlendes auf die Einkaufsliste.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, openSheet } = PP;

  const fr = { photos: [], result: null, busy: false, lists: [] };
  const hid = () => state.household.id;
  const pad = n => String(n).padStart(2, "0");
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const MAX_PX = 1280;

  // Foto verkleinern → Base64-JPEG (spart Zeit und KI-Kosten)
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Foto konnte nicht gelesen werden.")); i.src = url; });
      const scale = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.8);
      return { b64: dataUrl.split(",")[1], preview: dataUrl };
    } finally { URL.revokeObjectURL(url); }
  }

  function open() {
    fr.result = null;
    renderForm();
    renderResult();
    openSheet("sheet-fridge");
  }

  function renderForm() {
    $("#fr-photos").innerHTML = fr.photos.map((p, i) => `<span class="fr-thumb"><img src="${p.preview}" alt=""><button type="button" data-fr-rm="${i}" aria-label="Foto entfernen">✕</button></span>`).join("") +
      (fr.photos.length < 3 ? `<button type="button" class="fr-add" id="btn-fr-photo">📸<span>${fr.photos.length ? "Noch ein Foto" : "Foto machen"}</span></button>` : "");
  }

  function renderResult() {
    const box = $("#fr-result");
    const r = fr.result;
    if (!r) { box.innerHTML = ""; return; }
    box.innerHTML = `
      ${r.seen.length ? `<h3 class="sheet-sub">Erkannt</h3><div class="fr-seen">${r.seen.map(x => `<span class="fr-chip">${escapeHtml(x)}</span>`).join("")}</div>
        <p class="muted small">Etwas falsch oder fehlt? Unten im Textfeld ergänzen und neu vorschlagen lassen.</p>` : ""}
      <h3 class="sheet-sub">Vorschläge</h3>
      ${r.suggestions.length ? r.suggestions.map((s, i) => `<div class="card fr-card">
        <div class="fr-head"><strong>${escapeHtml(s.name)}</strong><span class="fr-badge${s.recipe_id ? " own" : ""}">${s.recipe_id ? "📖 Dein Rezept" : "✨ Neue Idee"}</span></div>
        <p class="small">${escapeHtml(s.why)}</p>
        <p class="muted small">${s.minutes ? `⏱️ ca. ${s.minutes} Min. · ` : ""}für ${s.servings}</p>
        ${s.uses.length ? `<p class="small">✅ <strong>Hast du:</strong> ${s.uses.map(escapeHtml).join(", ")}</p>` : ""}
        ${s.missing.length ? `<p class="small">🛒 <strong>Fehlt:</strong> ${s.missing.map(escapeHtml).join(", ")}</p>` : `<p class="small">👍 Alles da!</p>`}
        ${!s.recipe_id && s.ingredients.length ? `<details class="fr-recipe"><summary>Rezept ansehen</summary>
          <ul>${s.ingredients.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul><p class="small fr-steps">${escapeHtml(s.instructions)}</p></details>` : ""}
        <div class="btn-row fr-actions">
          <span class="fr-plan"><input type="date" data-fr-day="${i}" value="${today()}" aria-label="Tag"><button type="button" class="btn btn-primary btn-small" data-fr-plan="${i}">📅 Einplanen</button></span>
          ${s.missing.length ? `<button type="button" class="btn btn-small" data-fr-shop="${i}">🛒 Fehlendes (${s.missing.length})</button>` : ""}
          ${!s.recipe_id && s.ingredients.length ? `<button type="button" class="btn btn-small" data-fr-save="${i}"${s.savedId ? " disabled" : ""}>${s.savedId ? "📖 Gespeichert ✓" : "📖 Als Rezept speichern"}</button>` : ""}
        </div>
      </div>`).join("") : `<p class="muted small">Dazu fiel der KI nichts Passendes ein – versuch es mit einem anderen Foto oder tipp ein paar Zutaten ein.</p>`}`;
  }

  async function suggest() {
    if (fr.busy) return;
    const f = $("#form-fridge");
    const text = f.text.value.trim();
    if (!fr.photos.length && !text) { toast("Bitte ein Foto machen oder eintippen, was da ist.", true); return; }
    fr.busy = true;
    const btn = $("#btn-fr-go");
    btn.disabled = true;
    btn.textContent = fr.photos.length ? "✨ KI schaut in den Kühlschrank …" : "✨ KI überlegt …";
    try {
      const { data: recipes } = await sb.from("recipes").select("id, name, ingredients").eq("household_id", hid()).order("name").limit(300);
      const { data, error } = await sb.functions.invoke("assist", { body: {
        action: "fridge", images: fr.photos.map(p => p.b64), text, servings: +f.servings.value || 2,
        mode: f.own.checked ? "own" : "all",
        recipes: (recipes || []).map(r => ({ id: r.id, name: r.name, ingredients: String(r.ingredients || "").split("\n").slice(0, 15).join(", ") }))
      } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
        throw new Error(msg);
      }
      fr.result = data;
      renderResult();
      setTimeout(() => $("#fr-result").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) {
      toast(err.message || translateError(err), true);
    } finally {
      fr.busy = false;
      btn.disabled = false;
      btn.textContent = "✨ Was koche ich?";
    }
  }

  async function plan(i) {
    const s = fr.result.suggestions[i];
    const day = ($(`[data-fr-day="${i}"]`) || {}).value || today();
    const { data: ex } = await sb.from("meal_plan").select("id").eq("household_id", hid()).eq("day", day);
    const row = { household_id: hid(), day, servings: s.servings, note: "", sort: (ex || []).length };
    if (s.recipe_id || s.savedId) Object.assign(row, { recipe_id: s.recipe_id || s.savedId, title: "" });
    else Object.assign(row, { recipe_id: null, title: s.name.slice(0, 120), components: [...s.uses, ...s.missing].join("\n").slice(0, 2000) });
    let { error } = await sb.from("meal_plan").insert(row);
    if (error && /components/.test(error.message || "")) { delete row.components; ({ error } = await sb.from("meal_plan").insert(row)); }
    if (error) { toast(translateError(error), true); return; }
    const when = day === today() ? "heute" : new Date(day + "T12:00:00").toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "short" });
    toast(`„${s.name}“ für ${when} eingeplant.`);
    if (PP.modules.meals && PP.modules.meals.resume) PP.modules.meals.resume();
  }

  async function shop(i) {
    const s = fr.result.suggestions[i];
    if (!fr.lists.length) {
      const { data } = await sb.from("shopping_lists").select("id, name, sort_order").eq("household_id", hid()).order("sort_order");
      fr.lists = data || [];
    }
    if (!fr.lists.length) { toast("Noch keine Einkaufsliste angelegt.", true); return; }
    const last = storageGet("pp_list");
    const list = fr.lists.find(l => l.id === last) || fr.lists[0];
    const parse = PP.meals && PP.meals.parseIngredient;
    const guess = PP._shopping && PP._shopping.guessCategory ? PP._shopping.guessCategory : () => "sonstiges";
    const rows = s.missing.map(m => {
      let name = m, quantity = "";
      try {
        const p = parse && parse(m);
        if (p && p.name) { name = p.name; quantity = p.qty != null ? `${PP.meals.fmtQty(p.qty, p.unit)}${p.unit ? " " + p.unit : ""}` : ""; }
      } catch { /* Rohtext */ }
      return { id: crypto.randomUUID(), household_id: hid(), list_id: list.id, name: String(name).slice(0, 80), quantity: String(quantity || "").slice(0, 20), note: s.name.slice(0, 80), category: guess(name), is_done: false };
    });
    const { error } = await sb.from("shopping_items").insert(rows);
    if (error) { toast(translateError(error), true); return; }
    toast(`${rows.length} Artikel auf „${list.name}“.`);
  }

  async function saveRecipe(i, btn) {
    const s = fr.result.suggestions[i];
    btn.disabled = true;
    const { data, error } = await sb.from("recipes").insert({
      household_id: hid(), name: s.name.slice(0, 120), servings: s.servings,
      ingredients: s.ingredients.join("\n").slice(0, 5000), instructions: s.instructions.slice(0, 20000), url: "", is_favorite: false
    }).select("id").single();
    if (error) { btn.disabled = false; toast(translateError(error), true); return; }
    s.savedId = data.id;
    renderResult();
    toast(`„${s.name}“ bei deinen Rezepten gespeichert.`);
    if (PP.modules.meals && PP.modules.meals.resume) PP.modules.meals.resume();
  }

  // ---------- Bedienung ----------
  $("#sheet-fridge").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "btn-fr-photo") { $("#fr-input").click(); return; }
    if (b.dataset.frRm) { fr.photos.splice(+b.dataset.frRm, 1); renderForm(); return; }
    if (b.dataset.frPlan) { plan(+b.dataset.frPlan); return; }
    if (b.dataset.frShop) { shop(+b.dataset.frShop); return; }
    if (b.dataset.frSave) { saveRecipe(+b.dataset.frSave, b); return; }
  });
  $("#fr-input").addEventListener("change", async e => {
    const files = [...e.target.files].slice(0, 3 - fr.photos.length);
    e.target.value = "";
    for (const f of files) {
      try { fr.photos.push(await shrink(f)); } catch (err) { toast(err.message, true); }
    }
    renderForm();
  });
  $("#form-fridge").addEventListener("submit", e => { e.preventDefault(); suggest(); });
  $("#form-fridge").own.addEventListener("change", e => storageSet("pp_fridge_own", e.target.checked ? "1" : "0"));

  // Personenzahl wie im Essensplan merken
  const f0 = $("#form-fridge");
  f0.servings.value = storageGet("pp_meal_servings") || "2";
  f0.own.checked = storageGet("pp_fridge_own") === "1";

  PP.fridge = { open };
})();
