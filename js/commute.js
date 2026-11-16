// =========================================================
// Pichis Planner – Fahrtzeit mit Verkehrslage
// Einstellungen je Person: Start, Ziel, Tage, Abfahrt (hin/zurück), Vorlauf
// Die Mitteilung selbst verschickt die Funktion „digest“ (TomTom).
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError } = PP;

  const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const cm = { from: null, to: null, days: [1, 2, 3, 4, 5], timer: null, search: { field: null, token: 0, items: [] } };

  const f = () => $("#form-commute");

  // ---------- Anzeigen ----------
  function render() {
    const p = state.profile || {};
    const form = f();
    if (!form) return;
    form.enabled.checked = !!p.commute_enabled;
    cm.from = p.commute_from_lat != null ? { label: p.commute_from || "", lat: p.commute_from_lat, lon: p.commute_from_lon } : null;
    cm.to = p.commute_to_lat != null ? { label: p.commute_to || "", lat: p.commute_to_lat, lon: p.commute_to_lon } : null;
    form.from.value = p.commute_from || "";
    form.to.value = p.commute_to || "";
    cm.days = Array.isArray(p.commute_days) ? p.commute_days.slice() : [1, 2, 3, 4, 5];
    form.time.value = p.commute_time ? String(p.commute_time).slice(0, 5) : "07:30";
    form.return_on.checked = !!p.commute_return_time;
    form.return_time.value = p.commute_return_time ? String(p.commute_return_time).slice(0, 5) : "17:00";
    form.lead.value = String(p.commute_lead ?? 15);
    paint();
  }

  function paint() {
    const form = f();
    $("#commute-fields").hidden = !form.enabled.checked;
    $("#commute-days").innerHTML = WD.map((d, i) =>
      `<button type="button" class="chip rp-day${cm.days.includes(i + 1) ? " active" : ""}" data-cm-day="${i + 1}" aria-pressed="${cm.days.includes(i + 1)}">${d}</button>`).join("");
    $("#commute-return-time").hidden = !form.return_on.checked;
  }

  // ---------- Speichern ----------
  async function save(silent) {
    const form = f();
    const enabled = form.enabled.checked;
    if (enabled && (!cm.from || !cm.to)) {
      if (!silent) toast("Bitte Start und Ziel aus der Vorschlagsliste wählen.", true);
      return false;
    }
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const time = form.time.value || "07:30";
    const ret = form.return_on.checked ? (form.return_time.value || "17:00") : null;
    const lead = +form.lead.value;
    const today = new Date().toISOString().slice(0, 10);
    const update = {
      commute_enabled: enabled,
      commute_from: cm.from ? cm.from.label.slice(0, 300) : "",
      commute_from_lat: cm.from ? cm.from.lat : null,
      commute_from_lon: cm.from ? cm.from.lon : null,
      commute_to: cm.to ? cm.to.label.slice(0, 300) : "",
      commute_to_lat: cm.to ? cm.to.lat : null,
      commute_to_lon: cm.to ? cm.to.lon : null,
      commute_days: cm.days.slice().sort(),
      commute_time: time,
      commute_return_time: ret,
      commute_lead: lead,
      // Zeitpunkt heute schon vorbei? Dann erst ab morgen melden
      commute_last: time <= hm ? today : null,
      commute_return_last: ret && ret <= hm ? today : null
    };
    const { error } = await sb.from("profiles").update(update).eq("id", state.session.user.id);
    if (error) {
      toast(/commute_/.test(error.message || "") ? "Bitte zuerst das SQL aus Schritt 27 in Supabase ausführen." : translateError(error), true);
      return false;
    }
    Object.assign(state.profile, update);
    return true;
  }

  function scheduleSave() {
    clearTimeout(cm.timer);
    cm.timer = setTimeout(() => save(true), 600);
  }

  // ---------- Ortssuche (OpenStreetMap / Photon) ----------
  function label(pr) {
    const street = [pr.street, pr.housenumber].filter(Boolean).join(" ");
    const town = [pr.postcode, pr.city || pr.town || pr.village].filter(Boolean).join(" ");
    return [...new Set([pr.name && pr.name !== pr.street ? pr.name : "", street, town].filter(Boolean))].join(", ");
  }

  async function search(field, q) {
    const token = ++cm.search.token;
    try {
      const url = new URL("https://photon.komoot.io/api/");
      url.searchParams.set("q", q);
      url.searchParams.set("lang", "de");
      url.searchParams.set("limit", "5");
      url.searchParams.set("lat", "49.99");
      url.searchParams.set("lon", "8.27");       // Rhein-Main bevorzugen
      const res = await fetch(url);
      const data = await res.json();
      if (token !== cm.search.token) return;
      cm.search.field = field;
      cm.search.items = (data.features || []).map(ft => ({
        label: label(ft.properties || {}),
        lat: ft.geometry.coordinates[1], lon: ft.geometry.coordinates[0]
      })).filter(x => x.label);
      const list = $(`#commute-${field}-list`);
      list.innerHTML = cm.search.items.map((it, i) => `<li data-cm-pick="${i}">${escapeHtml(it.label)}</li>`).join("") +
        (cm.search.items.length ? `<li class="place-credit">Suche: © OpenStreetMap</li>` : "");
      list.hidden = !cm.search.items.length;
    } catch (err) {
      console.warn("Ortssuche:", err);
    }
  }

  ["from", "to"].forEach(field => {
    const input = f()[field];
    input.addEventListener("input", () => {
      cm[field] = null;                       // erst durch Auswahl gültig
      const q = input.value.trim();
      clearTimeout(cm.search.timer);
      if (q.length < 3) { $(`#commute-${field}-list`).hidden = true; return; }
      cm.search.timer = setTimeout(() => search(field, q), 350);
    });
    input.addEventListener("blur", () => setTimeout(() => { $(`#commute-${field}-list`).hidden = true; }, 200));
    $(`#commute-${field}-list`).addEventListener("pointerdown", e => {
      const li = e.target.closest("[data-cm-pick]");
      if (!li) return;
      e.preventDefault();
      const it = cm.search.items[+li.dataset.cmPick];
      cm[field] = it;
      input.value = it.label;
      $(`#commute-${field}-list`).hidden = true;
      scheduleSave();
    });
  });

  // ---------- Bedienung ----------
  f().addEventListener("change", e => {
    if (e.target.name === "from" || e.target.name === "to") return;
    paint();
    scheduleSave();
    if (e.target.name === "enabled" && e.target.checked && !(cm.from && cm.to)) {
      setTimeout(() => f().from.focus(), 50);
    }
  });
  f().addEventListener("click", e => {
    const b = e.target.closest("[data-cm-day]");
    if (!b) return;
    const d = +b.dataset.cmDay;
    cm.days = cm.days.includes(d) ? cm.days.filter(x => x !== d) : [...cm.days, d];
    paint();
    scheduleSave();
  });

  $("#btn-commute-check").addEventListener("click", async () => {
    const btn = $("#btn-commute-check");
    const out = $("#commute-result");
    if (!cm.from || !cm.to) { toast("Bitte Start und Ziel aus der Vorschlagsliste wählen.", true); return; }
    btn.disabled = true;
    out.hidden = false;
    out.textContent = "Fahrtzeit wird abgefragt …";
    try {
      if (!(await save(false))) { out.hidden = true; return; }
      const { data, error } = await sb.functions.invoke("digest", {
        body: { action: "commute_check", from: cm.from, to: cm.to, to_name: cm.to.label, push: true }
      });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
        throw new Error(/Unbekannte Aktion/.test(msg) ? "Bitte zuerst die neue Funktion „digest“ in Supabase einspielen." : msg);
      }
      out.innerHTML = `<strong>${escapeHtml(data.title)}</strong><br>${escapeHtml(data.body.replace(/^Abfahrt [0-9:]+ → /, "Jetzt los → "))}` +
        (data.pushed ? `<br><span class="muted small">Test-Mitteilung ans Handy geschickt.</span>` : `<br><span class="muted small">Keine Mitteilung verschickt – sind „Mitteilungen aufs Handy“ eingeschaltet?</span>`);
    } catch (err) {
      out.textContent = err.message || "Fehler";
    } finally {
      btn.disabled = false;
    }
  });

  PP.modules.commute = {
    enter() {}, leave() {}, resume() {},
    refreshTile() { if (!cm.rendered && state.profile) { cm.rendered = true; render(); } },
    reset() { cm.rendered = false; }
  };
  $("#btn-open-settings").addEventListener("click", render);
})();
