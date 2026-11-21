// =========================================================
// Pichis Planner – KI-Verbrauch (nur für die Verwaltung)
// Liest das Protokoll ai_usage (Schritt 37) und schätzt Kosten und
// Restguthaben in der Claude Console.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError } = PP;

  // Listenpreise in US$ je 1 Mio. Tokens (Stand Nov. 2026; Haiku bis 100k Eingabe je Anfrage)
  const PRICES = {
    "claude-haiku-5-5": { in: 0.10, out: 0.50 },
    "claude-sonnet-5-5": { in: 2, out: 10 }
  };
  const ACTIONS = {
    ask: "Frag das Wiki", compose: "Texte schreiben", myday: "Mein Tag", docmeta: "Archiv-Vorschläge",
    recipe: "Rezepte auslesen", nutrition: "Nährwerte", plan: "Tag planen"
  };
  const isOwner = () => state.role === "owner";
  const hid = () => state.household && state.household.id;

  const u = { range: "month", rows: [], loaded: false };

  function costUsd(r) {
    const p = PRICES[r.model] || PRICES["claude-haiku-5-5"];
    const big = /haiku/.test(r.model) && r.input_tokens > 100000;   // lange Anfragen kosten bei Haiku mehr
    return (r.input_tokens * p.in * (big ? 5 : 1) + r.output_tokens * p.out * (big ? 5 : 1)) / 1e6;
  }
  const fx = () => Number(state.household.ai_fx) || 0.92;
  const eur = usd => (usd * fx()).toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: usd * fx() < 0.1 ? 3 : 2, maximumFractionDigits: usd * fx() < 0.1 ? 3 : 2 });
  const num = n => Math.round(n).toLocaleString("de-DE");

  function since() {
    const now = new Date();
    if (u.range === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
    if (u.range === "30") return new Date(now - 30 * 864e5);
    return state.household.ai_credit_since ? new Date(state.household.ai_credit_since) : new Date(now.getFullYear(), now.getMonth(), 1);
  }

  async function load() {
    const from = new Date(Math.min(+since(), state.household.ai_credit_since ? +new Date(state.household.ai_credit_since) : Infinity, +new Date(Date.now() - 31 * 864e5)));
    const rows = [];
    for (let off = 0; off < 20000; off += 1000) {
      const { data, error } = await sb.from("ai_usage").select("user_id, action, model, input_tokens, output_tokens, created_at")
        .eq("household_id", hid()).gte("created_at", from.toISOString()).order("created_at", { ascending: false }).range(off, off + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    u.rows = rows;
    u.loaded = true;
  }

  function render() {
    const box = $("#ai-usage-body");
    if (!u.loaded) { box.innerHTML = `<p class="muted small">Wird geladen …</p>`; return; }
    const from = since();
    const rows = u.rows.filter(r => new Date(r.created_at) >= from);
    const sum = rows.reduce((a, r) => ({ n: a.n + 1, i: a.i + r.input_tokens, o: a.o + r.output_tokens, c: a.c + costUsd(r) }), { n: 0, i: 0, o: 0, c: 0 });

    // Restguthaben seit dem eingetragenen Stand
    let credit = "";
    const h = state.household;
    if (h.ai_credit != null && h.ai_credit_since) {
      const used = u.rows.filter(r => new Date(r.created_at) >= new Date(h.ai_credit_since)).reduce((a, r) => a + costUsd(r), 0) * fx();
      const left = Number(h.ai_credit) - used;
      credit = `<div class="aiu-credit${left < 1 ? " low" : ""}">
        <span>Restguthaben ca.</span><b>${left.toLocaleString("de-DE", { style: "currency", currency: "EUR" })}</b>
        <small>von ${Number(h.ai_credit).toLocaleString("de-DE", { style: "currency", currency: "EUR" })} am ${new Date(h.ai_credit_since).toLocaleDateString("de-DE")}</small></div>`;
    }

    const group = (keyFn, label) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        const g = m.get(k) || { n: 0, t: 0, c: 0 };
        g.n++; g.t += r.input_tokens + r.output_tokens; g.c += costUsd(r);
        m.set(k, g);
      }
      return [...m.entries()].sort((a, b) => b[1].c - a[1].c).map(([k, g]) =>
        `<tr><td>${escapeHtml(label(k))}</td><td>${g.n}×</td><td>${num(g.t)}</td><td>${eur(g.c)}</td></tr>`).join("");
    };

    box.innerHTML = `${credit}
      <div class="chips aiu-range">
        ${[["month", "Dieser Monat"], ["30", "30 Tage"], ...(h.ai_credit_since ? [["credit", "Seit Guthaben"]] : [])].map(([k, l]) =>
          `<button type="button" class="chip${u.range === k ? " active" : ""}" data-aiu-range="${k}">${l}</button>`).join("")}
      </div>
      <div class="aiu-total"><div><b>${sum.n}</b><small>Anfragen</small></div><div><b>${num(sum.i + sum.o)}</b><small>Tokens</small></div><div><b>${eur(sum.c)}</b><small>geschätzt</small></div></div>
      ${rows.length ? `
      <table class="aiu-table"><thead><tr><th>Funktion</th><th>Anfr.</th><th>Tokens</th><th>Kosten</th></tr></thead>
        <tbody>${group(r => r.action, k => ACTIONS[k] || k || "–")}</tbody></table>
      <table class="aiu-table"><thead><tr><th>Person</th><th>Anfr.</th><th>Tokens</th><th>Kosten</th></tr></thead>
        <tbody>${group(r => r.user_id, k => PP.memberName(k) || "Unbekannt")}</tbody></table>` : `<p class="muted small">Im gewählten Zeitraum keine KI-Anfragen.</p>`}
      <form id="form-aiu" class="form aiu-form" autocomplete="off">
        <label>Guthaben laut Claude Console (€)
          <input type="text" name="credit" inputmode="decimal" placeholder="z. B. 5,00" value="${h.ai_credit != null ? String(h.ai_credit).replace(".", ",") : ""}">
        </label>
        <label>1 US$ = … €
          <input type="text" name="fx" inputmode="decimal" value="${String(fx()).replace(".", ",")}">
        </label>
        <button type="submit" class="btn btn-small">Guthaben-Stand speichern</button>
      </form>
      <p class="muted small">Schätzung nach Listenpreisen (Haiku 0,10 $/0,50 $, Sonnet 2 $/10 $ je 1 Mio. Tokens Eingabe/Ausgabe). Genau abgerechnet wird in der Claude Console unter Billing. Trage dort den angezeigten Stand ein – ab dann zieht die App den Verbrauch ab.</p>`;
  }

  async function refresh() {
    const sec = $("#ai-usage-section");
    sec.hidden = !isOwner();
    if (!isOwner()) return;
    u.loaded = false;
    render();
    try {
      const { data: h, error: he } = await sb.from("households").select("ai_credit, ai_credit_since, ai_fx").eq("id", hid()).maybeSingle();
      if (!he && h) Object.assign(state.household, h);
      await load();
    }
    catch (err) {
      $("#ai-usage-body").innerHTML = `<p class="muted small">${/ai_usage/.test(err.message || "") ? "Bitte zuerst das SQL aus Schritt 37 in Supabase ausführen." : escapeHtml(translateError(err))}</p>`;
      return;
    }
    render();
  }

  $("#ai-usage-body").addEventListener("click", e => {
    const b = e.target.closest("[data-aiu-range]");
    if (b) { u.range = b.dataset.aiuRange; render(); }
  });
  $("#ai-usage-body").addEventListener("submit", async e => {
    if (e.target.id !== "form-aiu") return;
    e.preventDefault();
    const f = e.target;
    const credit = parseFloat(f.credit.value.replace(/\./g, "").replace(",", "."));
    const rate = parseFloat(f.fx.value.replace(",", "."));
    const upd = {
      ai_credit: Number.isFinite(credit) ? Math.round(credit * 100) / 100 : null,
      ai_credit_since: Number.isFinite(credit) ? new Date().toISOString() : null,
      ai_fx: Number.isFinite(rate) && rate > 0.3 && rate < 3 ? rate : fx()
    };
    const { error } = await sb.from("households").update(upd).eq("id", hid());
    if (error) { toast(/ai_credit|ai_fx/.test(error.message || "") ? "Bitte zuerst das SQL aus Schritt 37 in Supabase ausführen." : translateError(error), true); return; }
    Object.assign(state.household, upd);
    if (upd.ai_credit_since) u.range = "credit";
    toast(upd.ai_credit != null ? "Guthaben-Stand gespeichert." : "Guthaben-Stand entfernt.");
    await refresh();
  });

  $("#btn-open-settings").addEventListener("click", refresh);
  PP.modules.aiUsage = { enter() {}, leave() {}, resume() {}, refreshTile() {}, reset() { u.rows = []; u.loaded = false; } };
})();
