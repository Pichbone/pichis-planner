// =========================================================
// Pichis Planner – News aus aller Welt
// Schlagzeilen von tagesschau, SPIEGEL und BBC (über die Funktion „news“)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, $, toast, escapeHtml, storageGet, storageSet } = PP;

  const CATS = [
    ["welt", "🌍 Welt"],
    ["deutschland", "🇩🇪 Deutschland"],
    ["wirtschaft", "📈 Wirtschaft"],
    ["international", "🇬🇧 International"]
  ];

  const nw = {
    active: false,
    cat: storageGet("pp_news_cat") || "welt",
    data: {},          // cat → { items, at, errors }
    loading: false
  };
  if (!CATS.some(c => c[0] === nw.cat)) nw.cat = "welt";

  function ago(iso) {
    if (!iso) return "";
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    if (min < 1) return "gerade eben";
    if (min < 60) return `vor ${min} Min.`;
    const h = Math.round(min / 60);
    if (h < 24) return `vor ${h} Std.`;
    return new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short" });
  }

  const safe = u => /^https:\/\//i.test(u || "");

  function render() {
    if (!nw.active) return;
    $("#news-cats").innerHTML = CATS.map(([k, label]) =>
      `<button class="chip${k === nw.cat ? " active" : ""}" data-news-cat="${k}">${label}</button>`).join("");
    const d = nw.data[nw.cat];
    if (!d) {
      $("#news-items").innerHTML = `<p class="muted cal-empty">Nachrichten werden geladen …</p>`;
      return;
    }
    if (!d.items.length) {
      $("#news-items").innerHTML = `<p class="muted cal-empty">Gerade keine Meldungen.</p>`;
      return;
    }
    $("#news-items").innerHTML = `<ul class="news-list">${d.items.map(it => `<li>
        <a class="news-item" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">
          ${safe(it.image) ? `<img class="news-img" src="${escapeHtml(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
          <span class="news-text">
            <span class="news-meta">${escapeHtml(it.source)} · ${escapeHtml(ago(it.published))}</span>
            <span class="news-title">${escapeHtml(it.title)}</span>
            ${it.teaser ? `<span class="news-teaser">${escapeHtml(it.teaser)}</span>` : ""}
          </span>
        </a>
      </li>`).join("")}</ul>
      <p class="muted small news-foot">${d.errors && d.errors.length ? `Nicht erreichbar: ${escapeHtml(d.errors.join(", "))} · ` : ""}Stand ${new Date(d.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr · Antippen öffnet den Artikel</p>`;
  }

  async function load(force = false) {
    const cat = nw.cat;
    const have = nw.data[cat];
    if (!force && have && Date.now() - have.loadedAt < 5 * 60 * 1000) { render(); return; }
    nw.loading = true;
    $("#btn-news-refresh").disabled = true;
    try {
      const { data, error } = await sb.functions.invoke("news", { body: { cat } });
      if (error) {
        let msg = error.message;
        try {
          const res = error.context;
          if (res.status === 404) msg = "Die Funktion „news“ ist noch nicht eingerichtet.";
          else { const j = await res.json(); msg = j.error || msg; }
        } catch { /* keine Antwort */ }
        throw new Error(msg);
      }
      nw.data[cat] = { ...data, loadedAt: Date.now() };
    } catch (err) {
      if (!nw.data[cat]) $("#news-items").innerHTML = `<p class="muted cal-empty">${escapeHtml(err.message)}</p>`;
      toast(err.message, true);
      return;
    } finally {
      nw.loading = false;
      $("#btn-news-refresh").disabled = false;
    }
    if (cat === nw.cat) render();
  }

  $("#view-news").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.newsCat) {
      nw.cat = b.dataset.newsCat;
      storageSet("pp_news_cat", nw.cat);
      render();
      load();
    }
    if (b.id === "btn-news-refresh") load(true);
  });

  PP.modules.news = {
    enter() { nw.active = true; render(); load(); },
    leave() { nw.active = false; },
    resume() { if (nw.active) load(); },
    refreshTile() {},
    reset() { nw.data = {}; }
  };
})();
