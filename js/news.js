// =========================================================
// Pichis Planner – News & RSS-Reader
// Schlagzeilen (tagesschau, SPIEGEL, BBC) plus eigene Feeds,
// gelesen/gemerkt je Person – synchron auf allen Geräten.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, storageGet, storageSet, translateError, openSheet, closeSheets } = PP;

  const CATS = [
    ["welt", "🌍 Welt"],
    ["deutschland", "🇩🇪 Deutschland"],
    ["wirtschaft", "📈 Wirtschaft"],
    ["international", "🇬🇧 International"]
  ];
  const STAR = "star";
  const ALL = "all";   // Nachrichten aller Rubriken + eigene Feeds auf einer Seite
  const SUGGEST = [
    ["heise.de", "heise"], ["golem.de", "Golem"], ["kicker.de", "kicker"],
    ["spektrum.de", "Spektrum"], ["allgemeine-zeitung.de", "Allgemeine Zeitung"], ["chefkoch.de", "Chefkoch"]
  ];

  const nw = {
    active: false,
    cat: storageGet("pp_news_cat") || ALL,
    data: {},           // Schlüssel → { items, at, errors, loadedAt }
    loading: false,
    feeds: [],          // eigene Feeds (rss_feeds)
    feedsReady: false,
    marks: new Map(),   // link → { read_at, starred, title, source, image, published, updated_at }
    marksReady: false,
    sqlMissing: false,
    found: null         // Ergebnis der Feed-Suche
  };

  const uid = () => state.session && state.session.user.id;
  const hid = () => state.household && state.household.id;
  const isFeedCat = k => k.startsWith("f:");
  const feedCats = () => [...new Set(nw.feeds.map(f => f.category))].sort((a, b) => a.localeCompare(b, "de"));
  const validCat = k => k === STAR || k === ALL || CATS.some(c => c[0] === k) || (isFeedCat(k) && feedCats().includes(k.slice(2)));

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
  const isRead = link => { const m = nw.marks.get(link); return !!(m && m.read_at); };
  const isStar = link => { const m = nw.marks.get(link); return !!(m && m.starred); };

  // ---------- Feeds und Markierungen laden ----------
  async function loadFeeds() {
    const { data, error } = await sb.from("rss_feeds")
      .select("id, title, url, site_url, category, is_private, created_by")
      .eq("household_id", hid()).order("title");
    if (error) {
      if (/rss_feeds/.test(error.message || "") && /exist|schema cache/i.test(error.message || "")) nw.sqlMissing = true;
      else console.warn("Feeds:", error);
      nw.feeds = [];
    } else {
      nw.feeds = data;
      nw.sqlMissing = false;
    }
    nw.feedsReady = true;
  }

  async function loadMarks() {
    const since = new Date(Date.now() - 45 * 864e5).toISOString();
    const { data, error } = await sb.from("rss_marks")
      .select("link, read_at, starred, title, source, image, published, updated_at")
      .or(`starred.eq.true,updated_at.gte.${since}`)
      .order("updated_at", { ascending: false }).limit(3000);
    if (error) { console.warn("Markierungen:", error); nw.marksReady = true; return; }
    nw.marks = new Map(data.map(m => [m.link, m]));
    nw.marksReady = true;
    // alte, nicht gemerkte Lesemarken aufräumen (höchstens einmal am Tag)
    const today = new Date().toDateString();
    if (storageGet("pp_rss_clean") !== today) {
      storageSet("pp_rss_clean", today);
      sb.from("rss_marks").delete().eq("starred", false).lt("updated_at", since).then(() => {});
    }
  }

  async function setMark(it, patch) {
    if (!it || !it.link || nw.sqlMissing) return;
    const old = nw.marks.get(it.link) || {};
    const row = {
      link: it.link.slice(0, 1000),
      read_at: old.read_at || null,
      starred: !!old.starred,
      title: String(it.title || old.title || "").slice(0, 300),
      source: String(it.source || old.source || "").slice(0, 120),
      image: safe(it.image || old.image) ? String(it.image || old.image).slice(0, 1000) : "",
      published: it.published || old.published || null,
      ...patch,
      updated_at: new Date().toISOString()
    };
    nw.marks.set(row.link, row);
    const { error } = await sb.from("rss_marks").upsert({ user_id: uid(), ...row }, { onConflict: "user_id,link" });
    if (error) {
      console.warn("Markierung:", error);
      if (/rss_marks/.test(error.message || "")) { nw.sqlMissing = true; toast("Bitte zuerst das SQL aus Schritt 33 in Supabase ausführen.", true); }
    }
  }

  async function markAllRead(items) {
    const now = new Date().toISOString();
    const rows = items.filter(it => !isRead(it.link)).slice(0, 200).map(it => {
      const old = nw.marks.get(it.link) || {};
      const row = {
        link: it.link.slice(0, 1000), read_at: now, starred: !!old.starred,
        title: String(it.title || "").slice(0, 300), source: String(it.source || "").slice(0, 120),
        image: safe(it.image) ? it.image.slice(0, 1000) : "", published: it.published || null, updated_at: now
      };
      nw.marks.set(row.link, row);
      return { user_id: uid(), ...row };
    });
    if (!rows.length) return;
    render();
    const { error } = await sb.from("rss_marks").upsert(rows, { onConflict: "user_id,link" });
    if (error) toast(translateError(error), true);
  }

  // ---------- Anzeige ----------
  function chips() {
    const list = [
      [ALL, "📋 Alles"],
      ...CATS,
      ...feedCats().map(c => ["f:" + c, "📰 " + escapeHtml(c)]),
      [STAR, "⭐ Gemerkt"]
    ];
    $("#news-cats").innerHTML = list.map(([k, label]) =>
      `<button class="chip${k === nw.cat ? " active" : ""}" data-news-cat="${escapeHtml(k)}">${label}</button>`).join("");
  }

  function itemHtml(it, i) {
    const read = isRead(it.link), star = isStar(it.link);
    return `<li class="news-li${read ? " is-read" : ""}">
        <a class="news-item" href="${escapeHtml(it.link)}" target="_blank" rel="noopener" data-news-i="${i}">
          ${safe(it.image) ? `<img class="news-img" src="${escapeHtml(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
          <span class="news-text">
            <span class="news-meta">${escapeHtml(it.source)}${it.published ? ` · ${escapeHtml(ago(it.published))}` : ""}</span>
            <span class="news-title">${escapeHtml(it.title)}</span>
            ${it.teaser ? `<span class="news-teaser">${escapeHtml(it.teaser)}</span>` : ""}
          </span>
        </a>
        <button type="button" class="news-star${star ? " on" : ""}" data-news-star="${i}" aria-pressed="${star}" aria-label="${star ? "Nicht mehr merken" : "Merken"}" title="${star ? "Nicht mehr merken" : "Merken"}">${star ? "★" : "☆"}</button>
      </li>`;
  }

  // Liste, die gerade angezeigt wird (für Klicks)
  let shown = [];

  function render() {
    if (!nw.active) return;
    if (nw.feedsReady && !validCat(nw.cat)) nw.cat = ALL;
    chips();
    const box = $("#news-items");

    if (nw.cat === STAR) {
      shown = [...nw.marks.values()].filter(m => m.starred)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      box.innerHTML = shown.length
        ? `<ul class="news-list">${shown.map(itemHtml).join("")}</ul>
           <p class="muted small news-foot">${shown.length} gemerkte Artikel · nur für dich sichtbar</p>`
        : `<p class="muted cal-empty">${nw.marksReady ? "Noch nichts gemerkt. Tippe bei einem Artikel auf ☆, um ihn hier zu sammeln." : "Wird geladen …"}</p>`;
      return;
    }

    const d = nw.data[nw.cat];
    if (!d) {
      shown = [];
      box.innerHTML = `<p class="muted cal-empty">${isFeedCat(nw.cat) ? "Feeds werden geladen …" : "Nachrichten werden geladen …"}</p>`;
      return;
    }
    shown = d.items;
    if (!shown.length) {
      box.innerHTML = `<p class="muted cal-empty">Gerade keine Meldungen.${d.errors && d.errors.length ? ` Nicht erreichbar: ${escapeHtml(d.errors.join(", "))}` : ""}</p>`;
      return;
    }
    const unread = shown.filter(it => !isRead(it.link)).length;
    box.innerHTML = `<div class="news-head">
        <span class="muted small">${unread ? `${unread} ungelesen` : "Alles gelesen ✓"}</span>
        ${unread ? `<button type="button" class="link" id="btn-news-allread">Alle als gelesen markieren</button>` : ""}
      </div>
      <ul class="news-list">${shown.map(itemHtml).join("")}</ul>
      <p class="muted small news-foot">${d.errors && d.errors.length ? `Nicht erreichbar: ${escapeHtml(d.errors.join(", "))} · ` : ""}Stand ${new Date(d.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr · Antippen öffnet den Artikel</p>`;
  }

  async function invoke(body) {
    const { data, error } = await sb.functions.invoke("news", { body });
    if (error) {
      let msg = error.message;
      try {
        const res = error.context;
        if (res.status === 404) msg = "Die Funktion „news“ ist noch nicht eingerichtet.";
        else { const j = await res.json(); msg = j.error || msg; }
      } catch { /* keine Antwort */ }
      throw new Error(msg);
    }
    return data;
  }

  async function load(force = false) {
    const key = nw.cat;
    if (key === STAR) { render(); return; }
    const have = nw.data[key];
    if (!force && have && Date.now() - have.loadedAt < 5 * 60 * 1000) { render(); return; }
    nw.loading = true;
    $("#btn-news-refresh").disabled = true;
    try {
      let data;
      if (key === ALL) {
        data = await loadAll();
      } else if (isFeedCat(key)) {
        const feeds = nw.feeds.filter(f => f.category === key.slice(2)).map(f => ({ url: f.url, title: f.title }));
        data = await invoke({ action: "feeds", feeds });
      } else {
        data = await invoke({ cat: key });
      }
      nw.data[key] = { ...data, loadedAt: Date.now() };
    } catch (err) {
      if (!nw.data[key] && key === nw.cat) $("#news-items").innerHTML = `<p class="muted cal-empty">${escapeHtml(err.message)}</p>`;
      toast(err.message, true);
      return;
    } finally {
      nw.loading = false;
      $("#btn-news-refresh").disabled = false;
    }
    if (key === nw.cat) render();
  }

  // „Alles“: alle Rubriken und alle eigenen Feeds zusammen, neueste zuerst
  async function loadAll() {
    const jobs = CATS.map(([cat]) => invoke({ cat }));
    if (nw.feeds.length) jobs.push(invoke({ action: "feeds", feeds: nw.feeds.map(f => ({ url: f.url, title: f.title })) }));
    const res = await Promise.allSettled(jobs);
    const ok = res.filter(r => r.status === "fulfilled").map(r => r.value || {});
    if (!ok.length) throw (res[0] && res[0].reason) || new Error("Die Nachrichten konnten gerade nicht geladen werden.");
    // gleiche Meldung nur einmal (gleicher Link oder gleicher Titel)
    const seen = new Set();
    const items = ok.flatMap(d => d.items || [])
      .sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")))
      .filter(it => {
        const k1 = it.link, k2 = String(it.title || "").toLowerCase().replace(/\W+/g, " ").trim();
        if (seen.has(k1) || (k2 && seen.has(k2))) return false;
        seen.add(k1); if (k2) seen.add(k2);
        return true;
      })
      .slice(0, 250);
    const errors = [...new Set(ok.flatMap(d => d.errors || []))];
    if (res.some(r => r.status === "rejected")) errors.push("einige Rubriken");
    return { at: Date.now(), items, errors };
  }

  async function enter() {
    nw.active = true;
    render();
    await Promise.all([
      nw.feedsReady ? null : loadFeeds(),
      nw.marksReady ? null : loadMarks()
    ]);
    render();
    load();
  }

  // ---------- Klicks in der Liste ----------
  $("#view-news").addEventListener("click", e => {
    const a = e.target.closest("[data-news-i]");
    if (a) {
      const it = shown[+a.dataset.newsI];
      if (it && !isRead(it.link)) {
        setMark(it, { read_at: new Date().toISOString() });
        a.closest(".news-li").classList.add("is-read");
        if (nw.cat !== STAR) setTimeout(render, 400);
      }
      return;   // Link öffnet sich normal
    }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.newsCat) {
      nw.cat = b.dataset.newsCat;
      storageSet("pp_news_cat", nw.cat);
      render();
      load();
    }
    if (b.dataset.newsStar !== undefined) {
      const it = shown[+b.dataset.newsStar];
      if (!it) return;
      const on = !isStar(it.link);
      setMark(it, { starred: on }).then(() => toast(on ? "⭐ Gemerkt." : "Aus der Merkliste entfernt."));
      render();
    }
    if (b.id === "btn-news-refresh") {
      loadMarks().then(render);
      load(true);
    }
    if (b.id === "btn-news-allread") markAllRead(shown);
    if (b.id === "btn-news-feeds") openFeeds();
  });

  // ---------- Feeds verwalten ----------
  function renderFeeds() {
    const list = $("#rss-feed-list");
    if (nw.sqlMissing) {
      list.innerHTML = `<li class="muted small">Für eigene Feeds bitte zuerst das SQL aus Schritt 33 in Supabase ausführen.</li>`;
      return;
    }
    list.innerHTML = nw.feeds.length
      ? feedCats().map(c => `<li class="rss-cat">${escapeHtml(c)}</li>` + nw.feeds.filter(f => f.category === c).map(f => {
          let host = "";
          try { host = new URL(f.site_url || f.url).hostname.replace(/^www\./, ""); } catch { /* egal */ }
          const mine = f.created_by === uid();
          return `<li class="rss-feed">
            <span class="rss-feed-text">
              <span class="rss-feed-title">${f.is_private ? "🔒 " : ""}${escapeHtml(f.title)}</span>
              <span class="muted small">${escapeHtml(host)}${!mine ? ` · von ${escapeHtml(PP.memberName ? PP.memberName(f.created_by) || "Familie" : "Familie")}` : ""}</span>
            </span>
            <button type="button" class="icon-btn" data-rss-del="${f.id}" aria-label="Feed entfernen" title="Entfernen">🗑</button>
          </li>`;
        }).join("")).join("")
      : `<li class="muted small">Noch keine eigenen Feeds. Füge unten eine Webseite oder Feed-Adresse hinzu.</li>`;
    $("#rss-cat-list").innerHTML = ["Meine Feeds", ...feedCats()].filter((c, i, a) => a.indexOf(c) === i)
      .map(c => `<option value="${escapeHtml(c)}">`).join("");
  }

  function resetFound() {
    nw.found = null;
    $("#rss-found").hidden = true;
    $("#form-rss-save").reset();
  }

  async function openFeeds() {
    resetFound();
    $("#form-rss-find").reset();
    $("#rss-suggest").innerHTML = SUGGEST.map(([u, n]) => `<button type="button" class="chip" data-rss-suggest="${u}">${n}</button>`).join("");
    if (!nw.feedsReady) await loadFeeds();
    renderFeeds();
    openSheet("sheet-rss");
  }

  async function find(url) {
    const f = $("#form-rss-find");
    f.url.value = url;
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Suche …";
    try {
      const r = await invoke({ action: "discover", url });
      nw.found = r;
      const s = $("#form-rss-save");
      s.title.value = (r.title || "").slice(0, 120);
      if (!s.category.value) s.category.value = nw.cat.startsWith("f:") ? nw.cat.slice(2) : "Meine Feeds";
      $("#rss-found-info").textContent = `Gefunden: ${r.url}${r.count ? ` · ${r.count} Artikel` : ""}`;
      $("#rss-found").hidden = false;
    } catch (err) {
      resetFound();
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Suchen";
    }
  }

  $("#form-rss-find").addEventListener("submit", e => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    if (url) find(url);
  });

  $("#sheet-rss").addEventListener("click", async e => {
    const s = e.target.closest("[data-rss-suggest]");
    if (s) { find(s.dataset.rssSuggest); return; }
    const d = e.target.closest("[data-rss-del]");
    if (d) {
      const f = nw.feeds.find(x => x.id === d.dataset.rssDel);
      if (!f) return;
      if (!confirm(`Feed „${f.title}“ entfernen?${f.is_private ? "" : " Er verschwindet für die ganze Familie."}`)) return;
      const { error } = await sb.from("rss_feeds").delete().eq("id", f.id);
      if (error) { toast(translateError(error), true); return; }
      nw.feeds = nw.feeds.filter(x => x.id !== f.id);
      delete nw.data["f:" + f.category];
      delete nw.data[ALL];
      renderFeeds();
      render();
      toast("Feed entfernt.");
    }
  });

  $("#form-rss-save").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      if (!nw.found) throw new Error("Bitte zuerst eine Adresse suchen.");
      const row = {
        household_id: hid(),
        title: f.title.value.trim().slice(0, 120) || nw.found.title || "Feed",
        url: nw.found.url,
        site_url: (nw.found.site_url || "").slice(0, 1000),
        category: (f.category.value.trim() || "Meine Feeds").slice(0, 40),
        is_private: f.is_private.checked
      };
      if (nw.feeds.some(x => x.url.toLowerCase() === row.url.toLowerCase() && (x.created_by === uid() || !x.is_private))) {
        throw new Error("Diesen Feed gibt es schon.");
      }
      const { data, error } = await sb.from("rss_feeds").insert(row).select("id, title, url, site_url, category, is_private, created_by").single();
      if (error) throw error;
      nw.feeds.push(data);
      nw.feeds.sort((a, b) => a.title.localeCompare(b.title, "de"));
      delete nw.data["f:" + data.category];
      delete nw.data[ALL];
      resetFound();
      $("#form-rss-find").reset();
      renderFeeds();
      toast(`„${data.title}“ hinzugefügt.`);
      nw.cat = "f:" + data.category;
      storageSet("pp_news_cat", nw.cat);
      render();
      load();
    });
  });

  // Änderungen anderer Familienmitglieder an den Feeds
  function feedsChanged() {
    nw.feedsReady = false;
    nw.data = Object.fromEntries(Object.entries(nw.data).filter(([k]) => !isFeedCat(k)));
    if (nw.active) loadFeeds().then(render);
  }

  PP.modules.news = {
    enter,
    leave() { nw.active = false; },
    resume() { if (nw.active) { Promise.all([loadFeeds(), loadMarks()]).then(() => { render(); load(); }); } },
    refreshTile() {},
    reset() {
      nw.data = {}; nw.feeds = []; nw.feedsReady = false;
      nw.marks = new Map(); nw.marksReady = false;
    },
    feedsChanged
  };
})();
