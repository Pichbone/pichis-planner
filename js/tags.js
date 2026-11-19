// =========================================================
// Pichis Planner – Tags verwalten (Einstellungen)
// Umbenennen, Farbe, Zusammenführen, Löschen – gilt für die ganze Familie
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, openSheet, closeSheets } = PP;

  const COLORS = ["#E0703F", "#C2410C", "#B7791F", "#2F5D50", "#0F766E", "#3B6EA5", "#1E3A8A", "#8E5BB5", "#BE185D", "#9D174D", "#4B5563", "#7C5A2B"];
  const tg = { tags: [], usage: new Map(), editing: null, color: "" };
  const hid = () => state.household.id;

  async function load() {
    const [t, u] = await Promise.all([
      sb.from("event_tags").select("id, name, color").eq("household_id", hid()).order("name"),
      sb.rpc("tag_usage", { p_household: hid() })
    ]);
    if (t.error) throw t.error;
    tg.tags = t.data;
    tg.usage = new Map((u.data || []).map(r => [r.tag_id, Number(r.uses)]));
    tg.usageKnown = !u.error;
  }

  function render() {
    const list = $("#tags-settings");
    if (!list) return;
    list.innerHTML = tg.tags.length
      ? tg.tags.map(t => {
          const n = tg.usage.get(t.id) || 0;
          return `<li><button type="button" class="tg-row" data-tg="${t.id}">
            <span class="tag" style="--tag:${escapeHtml(t.color)}">${escapeHtml(t.name)}</span>
            <span class="tg-count">${tg.usageKnown ? (n ? `${n}×` : "unbenutzt") : ""}</span>
            <span class="tg-edit" aria-hidden="true">✏️</span>
          </button></li>`;
        }).join("")
      : `<li class="muted small">Noch keine Tags. Neue Tags legst du direkt beim Termin, der Aufgabe oder der Notiz an.</li>`;
  }

  async function refresh() {
    try { await load(); } catch (err) { console.warn("Tags:", err); }
    render();
  }

  // ---------- Bearbeiten ----------
  function paintColors() {
    $("#tg-colors").innerHTML = COLORS.map(c =>
      `<button type="button" class="tg-swatch${c.toLowerCase() === tg.color.toLowerCase() ? " on" : ""}" data-tg-color="${c}" style="--sw:${c}" aria-label="Farbe ${c}"></button>`).join("") +
      `<label class="tg-swatch tg-custom" title="Eigene Farbe" style="--sw:${escapeHtml(tg.color)}"><input type="color" id="tg-color-input" value="${escapeHtml(tg.color)}" aria-label="Eigene Farbe"></label>`;
    $("#tg-preview").innerHTML = `<span class="tag" style="--tag:${escapeHtml(tg.color)}">${escapeHtml($("#form-tag").name.value || "Tag")}</span>`;
  }

  function open(id) {
    const t = tg.tags.find(x => x.id === id);
    if (!t) return;
    tg.editing = t;
    tg.color = t.color || "#2F5D50";
    const f = $("#form-tag");
    f.name.value = t.name;
    const n = tg.usage.get(t.id) || 0;
    $("#tg-usage").textContent = tg.usageKnown
      ? (n ? `Wird ${n}× verwendet – in Terminen, Aufgaben, Notizen, Einkauf, Geburtstagen, Wiki und Archiv.` : "Wird im Moment nirgends verwendet.")
      : "";
    $("#tg-merge").innerHTML = `<option value="">– Tag wählen –</option>` +
      tg.tags.filter(x => x.id !== t.id).map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join("");
    $("#tg-merge-row").hidden = tg.tags.length < 2;
    paintColors();
    openSheet("sheet-tag");
  }

  $("#tags-settings").addEventListener("click", e => {
    const b = e.target.closest("[data-tg]");
    if (b) open(b.dataset.tg);
  });

  $("#sheet-tag").addEventListener("click", e => {
    const b = e.target.closest("[data-tg-color]");
    if (b) { tg.color = b.dataset.tgColor; paintColors(); }
  });
  $("#sheet-tag").addEventListener("input", e => {
    if (e.target.id === "tg-color-input") { tg.color = e.target.value; paintColors(); }
    if (e.target.name === "name") paintColors();
  });

  $("#form-tag").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const name = f.name.value.trim().slice(0, 40);
      if (!name) throw new Error("Bitte einen Namen eingeben.");
      if (tg.tags.some(x => x.id !== tg.editing.id && x.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Einen Tag „${name}“ gibt es schon – zum Zusammenlegen unten „Zusammenführen“ nutzen.`);
      }
      const { error } = await sb.from("event_tags").update({ name, color: tg.color }).eq("id", tg.editing.id);
      if (error) throw error;
      closeSheets();
      toast("Tag gespeichert.");
      await refresh();
    });
  });

  $("#btn-tg-merge").addEventListener("click", async () => {
    const to = tg.tags.find(x => x.id === $("#tg-merge").value);
    const from = tg.editing;
    if (!to) { toast("Bitte den Tag wählen, mit dem zusammengeführt werden soll.", true); return; }
    if (!confirm(`„${from.name}“ in „${to.name}“ zusammenführen? Alle Einträge mit „${from.name}“ bekommen „${to.name}“, danach wird „${from.name}“ gelöscht.`)) return;
    const { error } = await sb.rpc("merge_tags", { p_from: from.id, p_to: to.id });
    if (error) {
      toast(/merge_tags|function/i.test(error.message || "") ? "Bitte zuerst das SQL aus Schritt 31 in Supabase ausführen." : translateError(error), true);
      return;
    }
    closeSheets();
    toast(`„${from.name}“ ist jetzt „${to.name}“.`);
    await refresh();
  });

  $("#btn-tg-delete").addEventListener("click", async () => {
    const t = tg.editing;
    const n = tg.usage.get(t.id) || 0;
    if (!confirm(`Tag „${t.name}“ löschen?${n ? ` Er wird bei ${n} Einträgen entfernt.` : ""} Die Einträge selbst bleiben erhalten.`)) return;
    let { error } = await sb.rpc("delete_tag", { p_tag: t.id });
    if (error && /delete_tag|function/i.test(error.message || "")) {
      ({ error } = await sb.from("event_tags").delete().eq("id", t.id));   // vor Schritt 31
    }
    if (error) { toast(translateError(error), true); return; }
    closeSheets();
    toast("Tag gelöscht.");
    await refresh();
  });

  // Neuer Tag
  $("#form-tag-new").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const name = f.name.value.trim().slice(0, 40);
      if (!name) return;
      if (tg.tags.some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`„${name}“ gibt es schon.`);
      const { error } = await sb.from("event_tags").insert({ household_id: hid(), name, color: COLORS[tg.tags.length % COLORS.length] });
      if (error) throw error;
      f.reset();
      await refresh();
    });
  });

  $("#btn-open-settings").addEventListener("click", refresh);
  PP.tagsAdmin = { refresh, deleteTag: async id => sb.rpc("delete_tag", { p_tag: id }) };
  PP.modules.tagsAdmin = { enter() {}, leave() {}, resume() {}, refreshTile() {}, reset() { tg.tags = []; } };
})();
