// =========================================================
// Pichis Planner – Einkaufsliste
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, memberName, openSheet, closeSheets } = PP;

  // ---------- Kategorien (Reihenfolge = Weg durch den Laden) ----------
  const CATEGORIES = [
    { id: "obst", name: "Obst & Gemüse", icon: "🥦", words: [
      "obst", "gemüse", "apfel", "äpfel", "banane", "birne", "orange", "mandarine", "clementine", "zitrone", "limette",
      "traube", "erdbeer", "himbeer", "heidelbeer", "blaubeer", "beeren", "kiwi", "mango", "ananas", "melone", "pfirsich",
      "nektarine", "pflaume", "kirsche", "avocado", "tomate", "gurke", "salat", "paprika", "zwiebel", "knoblauch",
      "kartoffel", "karotte", "möhre", "zucchini", "aubergine", "brokkoli", "blumenkohl", "kohl", "spinat", "lauch",
      "porree", "sellerie", "champignon", "pilze", "ingwer", "kräuter", "petersilie", "schnittlauch", "basilikum",
      "radieschen", "rucola", "kürbis", "süßkartoffel", "fenchel", "spargel", "rote bete", "feldsalat"
    ]},
    { id: "backwaren", name: "Brot & Backwaren", icon: "🥖", words: [
      "brot", "brötchen", "toast", "baguette", "croissant", "laugen", "brezel", "breze", "kuchen", "semmel",
      "wraps", "tortilla", "knäckebrot", "zwieback", "ciabatta", "berliner"
    ]},
    { id: "kuehl", name: "Milch, Käse & Eier", icon: "🧀", words: [
      "milch", "joghurt", "jogurt", "quark", "sahne", "butter", "käse", "gouda", "mozzarella", "feta", "parmesan",
      "frischkäse", "schmand", "creme fraiche", "crème fraîche", "eier", "ei", "margarine", "skyr", "kefir",
      "buttermilch", "pudding", "hafermilch", "sojamilch", "hefe"
    ]},
    { id: "fleisch", name: "Fleisch, Wurst & Fisch", icon: "🥩", words: [
      "fleisch", "hack", "hähnchen", "hühnchen", "huhn", "pute", "rind", "schwein", "wurst", "salami", "schinken",
      "speck", "bacon", "würstchen", "steak", "schnitzel", "lachs", "fisch", "garnelen", "aufschnitt", "filet",
      "frikadelle", "bratwurst", "leberkäse", "gyros", "lamm"
    ]},
    { id: "tiefkuehl", name: "Tiefkühl", icon: "🧊", words: [
      "tiefkühl", "tk", "pizza", "eis", "pommes", "fischstäbchen", "eiswürfel", "kroketten", "gefroren"
    ]},
    { id: "vorrat", name: "Vorrat & Konserven", icon: "🥫", words: [
      "nudeln", "spaghetti", "pasta", "penne", "fusilli", "lasagne", "reis", "mehl", "zucker", "salz", "pfeffer", "öl",
      "olivenöl", "essig", "müsli", "cornflakes", "haferflocken", "linsen", "kichererbsen", "bohnen", "brühe",
      "gewürz", "honig", "marmelade", "konfitüre", "dose", "konserve", "passierte", "soße", "sauce", "ketchup",
      "senf", "mayo", "mayonnaise", "pesto", "backpulver", "vanillezucker", "puderzucker", "mais", "thunfisch",
      "brotaufstrich", "erdnussbutter", "tomatenmark", "suppe"
    ]},
    { id: "suesses", name: "Süßes & Snacks", icon: "🍫", words: [
      "schokolade", "schoko", "chips", "gummibärchen", "kekse", "keks", "bonbons", "süßigkeiten", "popcorn",
      "nüsse", "erdnüsse", "salzstangen", "riegel", "nutella", "pralinen", "lakritz", "cracker", "flips", "waffeln"
    ]},
    { id: "getraenke", name: "Getränke", icon: "🥤", words: [
      "wasser", "sprudel", "saft", "cola", "limo", "limonade", "bier", "wein", "sekt", "schorle", "eistee",
      "kaffee", "tee", "kakao", "mineralwasser", "fanta", "sprite", "energy", "smoothie", "espresso", "kaffeepads",
      "kapseln", "radler", "prosecco", "gin", "whisky", "rum", "aperol"
    ]},
    { id: "drogerie", name: "Drogerie", icon: "🧴", words: [
      "shampoo", "duschgel", "seife", "zahnpasta", "zahncreme", "zahnbürste", "zahnseide", "deo", "creme",
      "windeln", "taschentücher", "rasierer", "rasierklingen", "rasierschaum", "tampons", "binden", "watte",
      "wattepads", "pflaster", "sonnencreme", "bodylotion", "lotion", "haarspray", "spülung", "haargel",
      "mundspülung", "feuchttücher", "abschminktücher"
    ]},
    { id: "haushalt", name: "Haushalt", icon: "🧽", words: [
      "spülmittel", "spüli", "waschmittel", "weichspüler", "müllbeutel", "müllsäcke", "alufolie",
      "frischhaltefolie", "backpapier", "küchenrolle", "küchentücher", "schwamm", "schwämme", "reiniger",
      "putzmittel", "batterien", "glühbirne", "kerzen", "spülmaschinentabs", "tabs", "entkalker",
      "toilettenpapier", "klopapier", "gefrierbeutel", "servietten", "streichhölzer", "feuerzeug"
    ]},
    { id: "sonstiges", name: "Sonstiges", icon: "🛍️", words: [] }
  ];
  const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

  // ---------- Zustand ----------
  const shop = {
    householdId: null,
    lists: [],
    items: [],
    history: new Map(),
    activeListId: null,
    channel: null,
    showDone: false,
    editingItemId: null,
    editingListId: null,
    active: false,
    tags: [],
    tagFilter: storageGet("pp_shop_tag") || "",
    draftTags: new Set()
  };

  // ---------- Tags ----------
  const TAG_COLORS = ["#E0703F", "#2F5D50", "#3B6EA5", "#8E5BB5", "#B7791F", "#0F766E", "#BE185D", "#4B5563", "#C2410C"];
  function normTag(s) { return String(s).toLowerCase().replace(/[^a-z0-9äöüß]/g, ""); }

  async function createTag(name) {
    const clean = String(name).trim().slice(0, 40);
    if (!clean) return null;
    const existing = shop.tags.find(t => t.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const { data, error } = await sb.from("event_tags").insert({
      household_id: state.household.id, name: clean, color: TAG_COLORS[shop.tags.length % TAG_COLORS.length]
    }).select("id, name, color").single();
    if (error) { toast(translateError(error), true); return null; }
    shop.tags.push(data);
    shop.tags.sort((a, b) => a.name.localeCompare(b.name));
    return data;
  }

  // "#Grillen" aus der Eingabe herauslösen (gilt für alle Artikel der Eingabe)
  async function takeTags(text) {
    const ids = [];
    let m;
    const re = /(?:^|\s)#([a-zäöüß0-9][\wäöüß-]*)/i;
    while ((m = text.match(re))) {
      text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
      const q = normTag(m[1]);
      if (!q) continue;
      let tag = shop.tags.find(t => normTag(t.name) === q) || shop.tags.find(t => normTag(t.name).startsWith(q));
      if (!tag) tag = await createTag(m[1].replace(/-/g, " "));
      if (tag && !ids.includes(tag.id)) ids.push(tag.id);
    }
    return { text: text.replace(/\s+/g, " ").trim(), ids };
  }

  function tagChip(tag) {
    return `<span class="tag" style="--tag:${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>`;
  }

  // ---------- Eingabe verstehen ----------
  const UNIT = "(?:x|×|g|gr|kg|l|ml|cl|stk\\.?|stück|pck\\.?|packung(?:en)?|pkg|dose(?:n)?|flasche(?:n)?|becher|bund|netz|kiste(?:n)?|beutel|glas|gläser|tüte(?:n)?|rolle(?:n)?|kasten|kästen)";
  const QTY = `\\d+(?:[.,]\\d+)?\\s*${UNIT}?`;
  const RE_LEAD = new RegExp(`^(${QTY})\\s+(.+)$`, "i");
  const RE_TRAIL = new RegExp(`^(.+?)\\s+(${QTY})$`, "i");

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function parseEntry(raw) {
    const text = raw.trim().replace(/\s+/g, " ");
    if (!text) return null;
    let m = text.match(RE_LEAD);
    if (m) return { quantity: m[1].trim(), name: capitalize(m[2].trim()) };
    m = text.match(RE_TRAIL);
    if (m) return { quantity: m[2].trim(), name: capitalize(m[1].trim()) };
    return { quantity: "", name: capitalize(text) };
  }

  // Mehrere Artikel auf einmal: "Milch, Eier, 1,5 l Cola" oder zeilenweise
  function splitEntries(text) {
    // Dezimal-Kommas ("1,5 l") vorübergehend schützen, dann an Komma/Semikolon/Zeile trennen
    return text
      .replace(/(\d),(\d)/g, "$1\u0001$2")
      .split(/[,;\n]/)
      .map(s => s.replace(/\u0001/g, ","))
      .map(parseEntry)
      .filter(Boolean);
  }

  // Kategorie erraten: zuerst aus früheren Einkäufen, sonst nach Stichworten.
  // Bei zusammengesetzten Wörtern zählt der hintere Teil ("Orangensaft" → Getränke).
  function guessCategory(name) {
    const key = name.toLowerCase().trim();
    const known = shop.history.get(key);
    if (known) return known.category;

    const words = [...key.matchAll(/[a-zäöüß]+/g)];
    let best = "sonstiges", bestEnd = -1, bestLen = 0;

    for (const cat of CATEGORIES) {
      for (const kw of cat.words) {
        let end = -1;
        if (kw.length <= 3) {
          for (const w of words) if (w[0] === kw) end = Math.max(end, w.index + w[0].length);
        } else {
          const idx = key.lastIndexOf(kw);
          if (idx >= 0) end = idx + kw.length;
        }
        if (end < 0) continue;
        if (end > bestEnd || (end === bestEnd && kw.length > bestLen)) {
          best = cat.id; bestEnd = end; bestLen = kw.length;
        }
      }
    }
    return best;
  }

  // ---------- Daten ----------
  async function loadAll() {
    const hid = state.household.id;
    const [lists, items, history] = await Promise.all([
      sb.from("shopping_lists").select("*").eq("household_id", hid)
        .order("sort_order", { ascending: true }).order("created_at", { ascending: true }),
      sb.from("shopping_items").select("*").eq("household_id", hid)
        .order("created_at", { ascending: true }),
      sb.from("shopping_history").select("name, name_key, category, use_count").eq("household_id", hid)
        .order("use_count", { ascending: false }).limit(500)
    ]);
    if (lists.error) throw lists.error;
    if (items.error) throw items.error;
    if (history.error) throw history.error;

    shop.lists = lists.data;
    shop.items = items.data;
    shop.history = new Map(history.data.map(h => [h.name_key, h]));
    const tg = await sb.from("event_tags").select("id, name, color").eq("household_id", hid).order("name");
    if (!tg.error) shop.tags = tg.data;
    if (shop.tagFilter && !shop.tags.some(t => t.id === shop.tagFilter)) shop.tagFilter = "";

    if (shop.lists.length === 0) {
      const { data, error } = await sb.from("shopping_lists")
        .insert({ household_id: hid, name: "Supermarkt" }).select().single();
      if (error) throw error;
      shop.lists = [data];
    }

    const saved = storageGet("pp_list");
    if (!shop.lists.some(l => l.id === shop.activeListId)) {
      shop.activeListId = shop.lists.some(l => l.id === saved) ? saved : shop.lists[0].id;
    }
  }

  function upsertLocal(arr, row) {
    const i = arr.findIndex(x => x.id === row.id);
    if (i >= 0) arr[i] = row; else arr.push(row);
  }

  // ---------- Live-Abgleich ----------
  function subscribe() {
    unsubscribe();
    const hid = state.household.id;
    shop.channel = sb.channel("shop-" + hid)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "shopping_items", filter: `household_id=eq.${hid}` },
        onItemChange)
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "shopping_items" },
        onItemChange)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "shopping_lists", filter: `household_id=eq.${hid}` },
        onListChange)
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "shopping_lists" },
        onListChange)
      .subscribe();
  }

  function unsubscribe() {
    if (shop.channel) {
      sb.removeChannel(shop.channel);
      shop.channel = null;
    }
  }

  function onItemChange(payload) {
    if (payload.eventType === "DELETE") {
      const id = payload.old && payload.old.id;
      shop.items = shop.items.filter(x => x.id !== id);
    } else {
      upsertLocal(shop.items, payload.new);
      const key = payload.new.name.toLowerCase();
      shop.history.set(key, { name: payload.new.name, name_key: key, category: payload.new.category });
    }
    render();
  }

  function onListChange(payload) {
    if (payload.eventType === "DELETE") {
      const id = payload.old && payload.old.id;
      shop.lists = shop.lists.filter(x => x.id !== id);
      shop.items = shop.items.filter(x => x.list_id !== id);
      if (shop.activeListId === id && shop.lists[0]) shop.activeListId = shop.lists[0].id;
    } else {
      upsertLocal(shop.lists, payload.new);
    }
    render();
  }

  // ---------- Aktionen ----------
  async function addFromInput(rawText) {
    const parsed = await takeTags(rawText);
    const tagIds = [...parsed.ids];
    if (shop.tagFilter && !tagIds.includes(shop.tagFilter)) tagIds.push(shop.tagFilter);
    const entries = splitEntries(parsed.text);
    if (entries.length === 0) return;
    const merge = item => [...new Set([...(item.tag_ids || []), ...tagIds])];

    const listId = shop.activeListId;
    const inserts = [];
    const reactivate = [];
    let skipped = 0;

    for (const e of entries) {
      const existing = shop.items.find(x => x.list_id === listId && x.name.toLowerCase() === e.name.toLowerCase());
      if (existing && !existing.is_done) {
        if ((e.quantity && e.quantity !== existing.quantity) || merge(existing).length !== (existing.tag_ids || []).length) {
          reactivate.push({ id: existing.id, quantity: e.quantity || existing.quantity, is_done: false, tag_ids: merge(existing) });
        } else {
          skipped++;
        }
      } else if (existing && existing.is_done) {
        reactivate.push({ id: existing.id, quantity: e.quantity || existing.quantity, is_done: false, tag_ids: merge(existing) });
      } else {
        inserts.push({
          list_id: listId,
          household_id: state.household.id,
          name: e.name,
          quantity: e.quantity,
          category: guessCategory(e.name),
          ...(tagIds.length ? { tag_ids: tagIds } : {})
        });
      }
    }

    if (inserts.length) {
      const { data, error } = await sb.from("shopping_items").insert(inserts).select();
      if (error) throw error;
      data.forEach(row => upsertLocal(shop.items, row));
    }
    for (const r of reactivate) {
      const upd = { quantity: r.quantity, is_done: false };
      if (tagIds.length) upd.tag_ids = r.tag_ids;
      const { data, error } = await sb.from("shopping_items")
        .update(upd).eq("id", r.id).select().single();
      if (error) throw error;
      upsertLocal(shop.items, data);
    }
    render();

    if (skipped === 1 && entries.length === 1) toast("Steht schon auf der Liste.");
    else if (skipped > 0) toast(`${skipped} Artikel standen schon auf der Liste.`);
  }

  async function toggleItem(id) {
    const item = shop.items.find(x => x.id === id);
    if (!item) return;
    const before = item.is_done;
    item.is_done = !before;
    render();
    const { data, error } = await sb.from("shopping_items")
      .update({ is_done: !before }).eq("id", id).select().single();
    if (error) {
      item.is_done = before;
      render();
      toast(translateError(error), true);
      return;
    }
    upsertLocal(shop.items, data);
    render();
  }

  async function clearDone() {
    const done = shop.items.filter(x => x.list_id === shop.activeListId && x.is_done);
    if (done.length === 0) return;
    if (!confirm(`${done.length} erledigte Artikel von der Liste entfernen?`)) return;
    const { error } = await sb.from("shopping_items")
      .delete().eq("list_id", shop.activeListId).eq("is_done", true);
    if (error) { toast(translateError(error), true); return; }
    const ids = new Set(done.map(x => x.id));
    shop.items = shop.items.filter(x => !ids.has(x.id));
    render();
  }

  // ---------- Darstellung ----------
  function render() {
    if (!shop.active) return;
    renderChips();
    renderItems();
    renderSuggestions();
  }

  function openCount(listId) {
    return shop.items.filter(x => x.list_id === listId && !x.is_done).length;
  }

  function renderChips() {
    const chips = shop.lists.map(l => {
      const n = openCount(l.id);
      const active = l.id === shop.activeListId;
      return `<button class="chip${active ? " active" : ""}" data-list="${l.id}">
        ${escapeHtml(l.name)}${n ? ` <span class="chip-count">${n}</span>` : ""}
      </button>`;
    }).join("");
    $("#list-chips").innerHTML = chips +
      `<button class="chip chip-add" data-new-list aria-label="Neue Liste">+ Liste</button>`;
  }

  function itemRow(item) {
    const meta = [];
    if (item.note) meta.push(escapeHtml(item.note));
    const tags = (item.tag_ids || []).map(id => shop.tags.find(t => t.id === id)).filter(Boolean);
    if (item.created_by && item.created_by !== state.session.user.id) {
      const n = memberName(item.created_by);
      if (n) meta.push("von " + escapeHtml(n));
    }
    return `<li class="item${item.is_done ? " done" : ""}" data-id="${item.id}">
      <button class="check" data-toggle="${item.id}" aria-label="${item.is_done ? "Wieder auf die Liste" : "Abhaken"}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      </button>
      <button class="item-main" data-edit="${item.id}">
        <span class="item-name">${item.quantity ? `<span class="qty">${escapeHtml(item.quantity)}</span>` : ""}${escapeHtml(item.name)}</span>
        ${meta.length ? `<span class="item-meta">${meta.join(" · ")}</span>` : ""}
        ${tags.length ? `<span class="tag-row">${tags.map(tagChip).join("")}</span>` : ""}
      </button>
    </li>`;
  }

  function renderItems() {
    const onList = shop.items.filter(x => x.list_id === shop.activeListId);
    const used = new Set(onList.flatMap(x => x.tag_ids || []));
    const shown = shop.tags.filter(t => used.has(t.id) || t.id === shop.tagFilter);
    $("#shop-tags").innerHTML = shown.length
      ? `<button class="chip${shop.tagFilter ? "" : " active"}" data-shop-tag="">Alle</button>` +
        shown.map(t => `<button class="chip chip-tag${shop.tagFilter === t.id ? " active" : ""}" data-shop-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : "";
    const listItems = shop.tagFilter ? onList.filter(x => (x.tag_ids || []).includes(shop.tagFilter)) : onList;
    const open = listItems.filter(x => !x.is_done);
    const done = listItems.filter(x => x.is_done)
      .sort((a, b) => String(b.done_at || "").localeCompare(String(a.done_at || "")));

    let html = "";
    if (open.length === 0) {
      html = `<div class="empty">
        <div class="empty-icon">🧺</div>
        <p><strong>${done.length ? "Alles eingekauft!" : "Die Liste ist leer."}</strong></p>
        <p class="muted small">Oben eintippen, z. B. „2 Milch, Brot, 500 g Hack“.</p>
      </div>`;
    } else {
      for (const cat of CATEGORIES) {
        const group = open.filter(x => (CAT_BY_ID[x.category] ? x.category : "sonstiges") === cat.id);
        if (!group.length) continue;
        html += `<section class="cat-group">
          <h3 class="cat-title"><span>${cat.icon}</span> ${escapeHtml(cat.name)}</h3>
          <ul class="items">${group.map(itemRow).join("")}</ul>
        </section>`;
      }
    }
    $("#shop-items").innerHTML = html;

    if (done.length) {
      $("#shop-done").innerHTML = `
        <div class="done-head">
          <button class="link done-toggle" data-toggle-done>
            ${shop.showDone ? "▾" : "▸"} Im Wagen (${done.length})
          </button>
          <button class="link danger-link" data-clear-done>Entfernen</button>
        </div>
        ${shop.showDone ? `<ul class="items">${done.map(itemRow).join("")}</ul>` : ""}`;
    } else {
      $("#shop-done").innerHTML = "";
    }
  }

  function renderSuggestions() {
    const onList = new Set(shop.items
      .filter(x => x.list_id === shop.activeListId && !x.is_done)
      .map(x => x.name.toLowerCase()));
    $("#shop-suggestions").innerHTML = [...shop.history.values()]
      .filter(h => !onList.has(h.name_key))
      .slice(0, 200)
      .map(h => `<option value="${escapeHtml(h.name)}"></option>`)
      .join("");
  }

  // ---------- Bearbeiten-Fenster: Artikel ----------
  function fillCategorySelect() {
    $("#form-item").category.innerHTML = CATEGORIES
      .map(c => `<option value="${c.id}">${c.icon} ${escapeHtml(c.name)}</option>`).join("");
  }

  function openItemSheet(id) {
    const item = shop.items.find(x => x.id === id);
    if (!item) return;
    shop.editingItemId = id;
    const f = $("#form-item");
    f.name.value = item.name;
    f.quantity.value = item.quantity;
    f.note.value = item.note;
    f.category.value = CAT_BY_ID[item.category] ? item.category : "sonstiges";
    f.list.innerHTML = shop.lists
      .map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join("");
    f.list.value = item.list_id;
    $("#item-list-row").hidden = shop.lists.length < 2;
    shop.draftTags = new Set(item.tag_ids || []);
    f.new_tag.value = "";
    renderTagPicker();
    openSheet("sheet-item");
  }

  $("#form-item").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const upd = {
        name: f.name.value.trim(),
        quantity: f.quantity.value.trim(),
        note: f.note.value.trim(),
        category: f.category.value,
        list_id: f.list.value
      };
      const before = shop.items.find(x => x.id === shop.editingItemId);
      const tagIds = [...shop.draftTags].filter(id => shop.tags.some(t => t.id === id));
      if (tagIds.length || (before && before.tag_ids && before.tag_ids.length)) upd.tag_ids = tagIds;
      const { data, error } = await sb.from("shopping_items").update(upd).eq("id", shop.editingItemId).select().single();
      if (error && /tag_ids/.test(error.message || "")) throw new Error("Bitte zuerst das SQL aus Schritt 15 in Supabase ausführen.");
      if (error) throw error;
      upsertLocal(shop.items, data);
      shop.history.set(data.name.toLowerCase(), { name: data.name, name_key: data.name.toLowerCase(), category: data.category });
      closeSheets();
      render();
    });
  });

  function renderTagPicker() {
    $("#item-edit-tags").innerHTML = shop.tags.length
      ? shop.tags.map(t => `<button type="button" class="chip chip-tag${shop.draftTags.has(t.id) ? " active" : ""}" data-pick-shop-tag="${t.id}" style="--tag:${escapeHtml(t.color)}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join("")
      : `<span class="muted small">Noch keine Tags – unten einen anlegen.</span>`;
  }
  $("#item-edit-tags").addEventListener("click", e => {
    const b = e.target.closest("[data-pick-shop-tag]");
    if (!b) return;
    const id = b.dataset.pickShopTag;
    shop.draftTags.has(id) ? shop.draftTags.delete(id) : shop.draftTags.add(id);
    renderTagPicker();
  });
  async function addTagFromField() {
    const input = $("#form-item").new_tag;
    const tag = await createTag(input.value);
    if (!tag) return;
    shop.draftTags.add(tag.id);
    input.value = "";
    renderTagPicker();
  }
  $("#btn-item-tag-add").addEventListener("click", addTagFromField);
  $("#form-item").new_tag.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addTagFromField(); }
  });

  $("#btn-delete-item").addEventListener("click", async () => {
    const id = shop.editingItemId;
    const { error } = await sb.from("shopping_items").delete().eq("id", id);
    if (error) { toast(translateError(error), true); return; }
    shop.items = shop.items.filter(x => x.id !== id);
    closeSheets();
    render();
  });

  // ---------- Bearbeiten-Fenster: Liste ----------
  function openListSheet(id) {
    shop.editingListId = id;
    const f = $("#form-list");
    const list = id ? shop.lists.find(l => l.id === id) : null;
    $("#sheet-list-title").textContent = list ? "Liste bearbeiten" : "Neue Liste";
    f.name.value = list ? list.name : "";
    $("#btn-delete-list").hidden = !list || shop.lists.length < 2;
    openSheet("sheet-list");
  }

  $("#form-list").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const name = f.name.value.trim();
      if (shop.editingListId) {
        const { data, error } = await sb.from("shopping_lists")
          .update({ name }).eq("id", shop.editingListId).select().single();
        if (error) throw error;
        upsertLocal(shop.lists, data);
      } else {
        const { data, error } = await sb.from("shopping_lists").insert({
          household_id: state.household.id,
          name,
          sort_order: shop.lists.length
        }).select().single();
        if (error) throw error;
        upsertLocal(shop.lists, data);
        shop.activeListId = data.id;
        storageSet("pp_list", data.id);
      }
      closeSheets();
      render();
    });
  });

  $("#btn-delete-list").addEventListener("click", async () => {
    const list = shop.lists.find(l => l.id === shop.editingListId);
    if (!list) return;
    const n = shop.items.filter(x => x.list_id === list.id).length;
    if (!confirm(`Liste „${list.name}“${n ? ` mit ${n} Artikeln` : ""} wirklich löschen?`)) return;
    const { error } = await sb.from("shopping_lists").delete().eq("id", list.id);
    if (error) { toast(translateError(error), true); return; }
    shop.lists = shop.lists.filter(l => l.id !== list.id);
    shop.items = shop.items.filter(x => x.list_id !== list.id);
    shop.activeListId = shop.lists[0] ? shop.lists[0].id : null;
    storageSet("pp_list", shop.activeListId || "");
    closeSheets();
    render();
  });

  // ---------- Klicks in der Ansicht ----------
  $("#view-shopping").addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;

    if (t.dataset.toggle) { toggleItem(t.dataset.toggle); return; }
    if (t.dataset.edit) { openItemSheet(t.dataset.edit); return; }
    if (t.dataset.list) {
      if (t.dataset.list === shop.activeListId) { openListSheet(t.dataset.list); return; }
      shop.activeListId = t.dataset.list;
      storageSet("pp_list", shop.activeListId);
      render();
      return;
    }
    if (t.hasAttribute("data-new-list")) { openListSheet(null); return; }
    if (t.dataset.shopTag !== undefined) {
      shop.tagFilter = t.dataset.shopTag;
      storageSet("pp_shop_tag", shop.tagFilter);
      renderItems();
      return;
    }
    if (t.hasAttribute("data-toggle-done")) { shop.showDone = !shop.showDone; renderItems(); return; }
    if (t.hasAttribute("data-clear-done")) { clearDone(); return; }
  });

  $("#form-add-item").addEventListener("submit", e => {
    e.preventDefault();
    const input = e.target.text;
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    addFromInput(text).catch(err => {
      input.value = text;
      toast(translateError(err), true);
    });
  });

  // ---------- Kachel auf der Startseite ----------
  async function refreshTile() {
    if (!state.household) return;
    const { count, error } = await sb.from("shopping_items")
      .select("id", { count: "exact", head: true })
      .eq("household_id", state.household.id)
      .eq("is_done", false);
    if (error) return;
    $("#tile-shop-status").textContent = count ? `${count} offen` : "Alles erledigt";
  }

  // ---------- Modul-Schnittstelle ----------
  PP.modules.shopping = {
    async enter() {
      shop.active = true;
      try {
        if (shop.householdId !== state.household.id) {
          shop.householdId = state.household.id;
          shop.activeListId = null;
        }
        if (!$("#form-item").category.options.length) fillCategorySelect();
        await loadAll();
        render();
        subscribe();
      } catch (err) {
        console.error(err);
        toast(translateError(err), true);
      }
    },
    leave() {
      shop.active = false;
      unsubscribe();
      closeSheets();
    },
    async resume() {
      if (shop.active) {
        try { await loadAll(); render(); subscribe(); } catch (err) { console.error(err); }
      } else {
        refreshTile();
      }
    },
    refreshTile,
    reset() {
      this.leave();
      shop.householdId = null;
      shop.lists = [];
      shop.items = [];
      shop.history = new Map();
      shop.activeListId = null;
    }
  };

  // Für Tests im Browser
  PP._shopping = { parseEntry, splitEntries, guessCategory };
})();
