// =========================================================
// Pichis Planner – „Mein Tag“
// Die KI fragt, was dich heute beschäftigt hat, hört zu und fragt nach.
// Streng privat (nur für dich), ein Gespräch pro Tag.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet } = PP;

  // Einstiegsfragen – jeden Tag eine andere
  const QUESTIONS = [
    "Was hat dich heute beschäftigt?",
    "Was ist dir heute durch den Kopf gegangen?",
    "Wie war dein Tag – was ist hängen geblieben?",
    "Worüber hast du heute am meisten nachgedacht?",
    "Was hat dich heute gefreut – und was hat dich Kraft gekostet?",
    "Gab es heute einen Moment, der dir wichtig war?",
    "Was nimmst du aus dem heutigen Tag mit?",
    "Was hat dich heute überrascht?",
    "Was liegt dir heute Abend noch auf dem Herzen?",
    "Worauf bist du heute ein bisschen stolz?",
    "Was hat dich heute geärgert oder gestresst?",
    "Mit wem hattest du heute ein gutes Gespräch?",
    "Was würdest du an heute gern noch einmal anders machen?",
    "Was beschäftigt dich, wenn du an morgen denkst?"
  ];

  const md = {
    active: false,
    day: null,          // angezeigter Tag (YYYY-MM-DD)
    entry: null,        // { id, day, messages }
    list: [],           // frühere Tage
    sending: false
  };

  const me = () => state.session.user.id;
  const pad = n => String(n).padStart(2, "0");
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayIso = () => isoOf(new Date());
  const longDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });

  function questionFor(iso) {
    const d = new Date(iso + "T12:00:00");
    const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    return QUESTIONS[(doy + d.getFullYear()) % QUESTIONS.length];
  }

  function sqlHint(err) {
    return /my_day|does not exist/i.test((err && err.message) || "") ? "Bitte zuerst das SQL aus Schritt 21 in Supabase ausführen." : translateError(err);
  }

  // ---------- Daten ----------
  async function loadDay(day) {
    const { data, error } = await sb.from("my_day").select("id, day, messages, updated_at").eq("user_id", me()).eq("day", day).maybeSingle();
    if (error) throw error;
    md.entry = data;
  }

  async function loadList() {
    const { data, error } = await sb.from("my_day").select("day, messages").eq("user_id", me())
      .order("day", { ascending: false }).limit(60);
    if (error) throw error;
    md.list = data || [];
  }

  // ---------- Darstellung ----------
  function textHtml(t) {
    return escapeHtml(t).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  }

  function render() {
    if (!md.active) return;
    const day = md.day;
    const isToday = day === todayIso();
    const msgs = (md.entry && md.entry.messages) || [];

    $("#md-date").textContent = isToday ? "Heute · " + longDate(day) : longDate(day);
    $("#md-question").textContent = questionFor(day);
    $("#md-back-today").hidden = isToday;

    $("#md-thread").innerHTML = msgs.map(m => `<div class="md-msg ${m.role === "assistant" ? "md-ai" : "md-me"}">
        ${m.role === "assistant" ? '<span class="md-who">✨</span>' : ""}
        <div class="md-bubble">${textHtml(m.text)}</div>
      </div>`).join("") + (md.sending ? `<div class="md-msg md-ai"><span class="md-who">✨</span><div class="md-bubble md-typing"><span></span><span></span><span></span></div></div>` : "");

    const hasMine = msgs.some(m => m.role === "user");
    $("#md-actions").hidden = !hasMine || md.sending;
    $("#md-input").placeholder = msgs.length ? "Antworten oder weiterschreiben …" : "Schreib einfach drauflos – ein paar Sätze reichen.";

    // Frühere Tage
    const others = md.list.filter(x => x.day !== day);
    $("#md-history").innerHTML = others.length
      ? `<h3 class="cat-title">Frühere Tage</h3><ul class="md-days">${others.map(x => {
          const first = (x.messages || []).find(m => m.role === "user");
          return `<li><a class="md-day" href="#/meintag/${x.day}">
            <span class="md-day-date">${escapeHtml(longDate(x.day))}</span>
            <span class="md-day-text">${escapeHtml(first ? first.text.replace(/\s+/g, " ").slice(0, 110) : "")}${first && first.text.length > 110 ? " …" : ""}</span>
          </a></li>`;
        }).join("")}</ul>` : "";
  }

  function scrollToEnd() {
    const last = $("#md-thread").lastElementChild;
    if (last) last.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------- Schreiben ----------
  async function send() {
    const input = $("#md-input");
    const text = input.value.trim();
    if (!text || md.sending) return;
    md.sending = true;
    // sofort anzeigen
    const before = md.entry ? md.entry.messages.slice() : [];
    md.entry = { ...(md.entry || { day: md.day }), messages: [...before, { role: "user", text, at: new Date().toISOString() }] };
    input.value = "";
    autosize();
    render();
    scrollToEnd();
    $("#md-send").disabled = true;
    try {
      const { data, error } = await sb.functions.invoke("assist", {
        body: { action: "myday", day: md.day, text, model: $("#md-thorough").checked ? "sonnet" : "haiku" }
      });
      if (error) {
        let msg = error.message;
        try {
          const res = error.context;
          const raw = await res.text();
          try { const j = JSON.parse(raw); msg = j.error || msg; } catch { if (raw) msg = raw.slice(0, 200); }
          if (res.status === 404) msg = "Die Funktion „assist“ ist noch nicht auf dem neuesten Stand.";
        } catch { /* keine Antwort */ }
        throw new Error(msg);
      }
      md.entry = { ...md.entry, messages: data.messages };
      if (!md.list.some(x => x.day === md.day)) md.list.unshift({ day: md.day, messages: data.messages });
      else md.list = md.list.map(x => x.day === md.day ? { ...x, messages: data.messages } : x);
      refreshTile();
    } catch (err) {
      // Text zurück ins Feld, damit nichts verloren geht
      md.entry = { ...md.entry, messages: before };
      input.value = text;
      autosize();
      toast(sqlHint(err), true);
    } finally {
      md.sending = false;
      $("#md-send").disabled = false;
      render();
      scrollToEnd();
    }
  }

  function autosize() {
    const t = $("#md-input");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 260) + "px";
  }

  $("#form-md").addEventListener("submit", e => { e.preventDefault(); send(); });
  $("#md-input").addEventListener("input", autosize);
  $("#md-input").addEventListener("keydown", e => {
    // Am Computer: Cmd/Strg + Enter schickt ab
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });
  $("#md-thorough").checked = storageGet("pp_md_thorough") === "1";
  $("#md-thorough").addEventListener("change", e => storageSet("pp_md_thorough", e.target.checked ? "1" : "0"));

  // ---------- Ins Tagebuch / Löschen ----------
  $("#md-actions").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b || !md.entry) return;
    if (b.dataset.act === "journal") {
      const mine = md.entry.messages.filter(m => m.role === "user").map(m => m.text.trim()).join("\n\n");
      b.disabled = true;
      try {
        const { data: existing } = await sb.from("journal_entries").select("id")
          .eq("user_id", me()).eq("entry_date", md.day).eq("title", "Mein Tag").maybeSingle();
        const res = existing
          ? await sb.from("journal_entries").update({ body: mine.slice(0, 50000) }).eq("id", existing.id)
          : await sb.from("journal_entries").insert({ user_id: me(), entry_date: md.day, title: "Mein Tag", body: mine.slice(0, 50000) });
        if (res.error) throw res.error;
        toast(existing ? "Tagebuch-Eintrag aktualisiert." : "Im Tagebuch gespeichert – nur deine eigenen Worte.");
      } catch (err) {
        toast(/journal_entries/.test(err.message || "") ? "Das Tagebuch (Schritt 13) ist noch nicht eingerichtet." : translateError(err), true);
      } finally {
        b.disabled = false;
      }
    }
    if (b.dataset.act === "delete") {
      if (!md.entry.id || !confirm(`Das Gespräch vom ${longDate(md.day)} löschen?`)) return;
      const { error } = await sb.from("my_day").delete().eq("id", md.entry.id);
      if (error) { toast(translateError(error), true); return; }
      md.list = md.list.filter(x => x.day !== md.day);
      md.entry = null;
      toast("Gelöscht.");
      render();
      refreshTile();
    }
  });

  // ---------- Kachel & Modul ----------
  async function refreshTile() {
    if (!state.session) return;
    const el = $("#tile-md-status");
    const { data, error } = await sb.from("my_day").select("messages").eq("user_id", me()).eq("day", todayIso()).maybeSingle();
    el.textContent = !error && data && (data.messages || []).length ? "Heute geschrieben ✓" : "Nur für dich";
  }

  PP.modules.myday = {
    async enter() {
      md.active = true;
      const param = PP.route.param;
      md.day = /^\d{4}-\d{2}-\d{2}$/.test(param || "") && param <= todayIso() ? param : todayIso();
      md.entry = null;
      render();
      try {
        await Promise.all([loadDay(md.day), loadList()]);
      } catch (err) {
        console.error(err);
        toast(sqlHint(err), true);
      }
      render();
      if (!(md.entry && md.entry.messages.length) && !matchMedia("(pointer: coarse)").matches) $("#md-input").focus();
    },
    leave() { md.active = false; },
    async resume() {
      if (!md.active) { refreshTile(); return; }
      // Nach Mitternacht automatisch zum neuen Tag
      if (!PP.route.param && md.day !== todayIso()) md.day = todayIso();
      try { await Promise.all([loadDay(md.day), loadList()]); render(); } catch (err) { console.error(err); }
    },
    refreshTile,
    reset() { md.active = false; md.entry = null; md.list = []; }
  };
})();
