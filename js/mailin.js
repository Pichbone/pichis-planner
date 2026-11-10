// =========================================================
// Pichis Planner – Aufgaben per Mail (Anleitung + Protokoll)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError } = PP;

  const mi = { active: false, address: "", configured: null, log: [] };
  const KIND = { todo: ["✅", "Aufgabe", "#/aufgaben"], shopping: ["🛒", "Einkauf", "#/einkauf"], note: ["📝", "Notiz", "#/notizen"] };

  async function call(action) {
    const { data, error } = await sb.functions.invoke("mailin", { body: { action } });
    if (error) {
      let msg = error.message, status = "";
      try {
        const res = error.context;
        status = res && res.status;
        const raw = await res.text();
        try { const j = JSON.parse(raw); msg = j.error || j.message || raw; } catch { if (raw) msg = raw.slice(0, 200); }
      } catch { /* keine Antwort */ }
      if (status === 404) msg = "Die Funktion „mailin“ ist noch nicht eingerichtet.";
      throw new Error(msg);
    }
    return data;
  }

  function plus(addr, tag) {
    const [l, d] = addr.split("@");
    return d ? `${l}+${tag}@${d}` : addr;
  }

  function render() {
    if (!mi.active) return;
    const a = mi.address;
    $("#mi-address").innerHTML = a
      ? `<span class="mi-addr">${escapeHtml(a)}</span><button class="btn btn-small" data-copy="${escapeHtml(a)}">Kopieren</button>`
      : `<span class="muted">${mi.configured === false ? "Noch nicht eingerichtet – siehe Anleitung zu Schritt 14." : "Wird geladen …"}</span>`;
    $("#mi-plus").innerHTML = a ? `
      <li><code>${escapeHtml(plus(a, "einkauf"))}</code> → Einkaufsliste</li>
      <li><code>${escapeHtml(plus(a, "notiz"))}</code> → Notiz</li>` : "";

    $("#mi-log").innerHTML = mi.log.length
      ? mi.log.map(l => {
          const k = KIND[l.kind] || KIND.todo;
          const d = new Date(l.created_at);
          return `<li><a class="mi-row" href="${k[2]}">
            <span class="mi-icon">${k[0]}</span>
            <span class="mi-text">
              <span class="mi-title">${escapeHtml(l.result || l.subject || k[1])}</span>
              <span class="mi-sub">${escapeHtml(l.subject ? "„" + l.subject + "“ · " : "")}${d.toLocaleString("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </span>
          </a></li>`;
        }).join("")
      : `<li class="muted small">Noch nichts per Mail angekommen.</li>`;
  }

  async function load() {
    const [info, log] = await Promise.all([
      call("info").catch(err => ({ error: err.message })),
      sb.from("mail_log").select("kind, subject, result, created_at")
        .eq("user_id", state.session.user.id).order("created_at", { ascending: false }).limit(20)
    ]);
    mi.address = info.address || "";
    mi.configured = info.error ? false : !!info.configured;
    mi.log = log.error ? [] : log.data;
    render();
  }

  $("#view-mailin").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.copy) {
      try { await navigator.clipboard.writeText(t.dataset.copy); toast("Adresse kopiert."); } catch { /* egal */ }
      return;
    }
    if (t.id === "btn-mi-run") {
      t.disabled = true;
      t.textContent = "Wird abgerufen …";
      try {
        const r = await call("run");
        if (r.skipped) toast("Das Postfach wird gerade schon abgerufen.");
        else toast(r.checked ? `${r.done} Mail${r.done === 1 ? "" : "s"} verarbeitet${r.rejected ? `, ${r.rejected} abgelehnt` : ""}${r.failed ? `, ${r.failed} mit Fehler` : ""}.` : "Keine neuen Mails.");
        await load();
      } catch (err) {
        toast(translateError(err), true);
      } finally {
        t.disabled = false;
        t.textContent = "↻ Jetzt abrufen";
      }
    }
  });

  async function refreshTile() {
    if (!state.session) return;
    const { data, error } = await sb.from("mail_log").select("created_at")
      .eq("user_id", state.session.user.id).order("created_at", { ascending: false }).limit(1);
    const el = $("#tile-mi-status");
    if (error || !data || !data.length) { el.textContent = "Öffnen"; return; }
    const d = new Date(data[0].created_at);
    const today = new Date().toDateString() === d.toDateString();
    el.textContent = "Zuletzt " + (today ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : d.toLocaleDateString("de-DE", { day: "numeric", month: "numeric" }));
  }

  PP.modules.mailin = {
    async enter() {
      mi.active = true;
      render();
      try { await load(); } catch (err) { toast(translateError(err), true); }
    },
    leave() { mi.active = false; },
    async resume() { if (mi.active) load(); else refreshTile(); },
    refreshTile,
    reset() { mi.active = false; mi.log = []; mi.address = ""; }
  };
})();
