// =========================================================
// Pichis Planner – Aufgaben per Mail (Anleitung + Protokoll)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError } = PP;

  const mi = { active: false, address: "", configured: null, log: [], token: null, freshToken: "" };
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
          const via = l.source === "siri" ? "🎙️ Siri · " : "✉️ Mail · ";
          return `<li><a class="mi-row" href="${k[2]}">
            <span class="mi-icon">${k[0]}</span>
            <span class="mi-text">
              <span class="mi-title">${escapeHtml(l.result || l.subject || k[1])}</span>
              <span class="mi-sub">${via}${escapeHtml(l.subject ? "„" + l.subject + "“ · " : "")}${d.toLocaleString("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </span>
          </a></li>`;
        }).join("")
      : `<li class="muted small">Noch nichts per Mail oder Siri angekommen.</li>`;

    renderSiri();
  }

  // ---------- Siri & Erinnerungen ----------
  const endpoint = () => PP.cfg.SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/mailin";
  const fmt = iso => new Date(iso).toLocaleString("de-DE", { day: "numeric", month: "numeric", year: "2-digit", hour: "2-digit", minute: "2-digit" });

  function renderSiri() {
    $("#siri-url").innerHTML = `<code>${escapeHtml(endpoint())}</code><button class="btn btn-small" data-copy="${escapeHtml(endpoint())}">Kopieren</button>`;
    let html;
    if (mi.freshToken) {
      html = `<div class="siri-token">
        <code>${escapeHtml(mi.freshToken)}</code>
        <button class="btn btn-small" data-copy="${escapeHtml(mi.freshToken)}">Kopieren</button>
      </div>
      <p class="small siri-warn">⚠️ Der Schlüssel wird nur jetzt angezeigt. Kopiere ihn gleich in den Kurzbefehl.</p>`;
    } else if (mi.token) {
      html = `<p class="small">✓ Schlüssel vorhanden · erstellt ${escapeHtml(fmt(mi.token.created_at))}${mi.token.last_used_at ? " · zuletzt benutzt " + escapeHtml(fmt(mi.token.last_used_at)) : " · noch nicht benutzt"}</p>`;
    } else {
      html = `<p class="small muted">Noch kein Schlüssel. Er verbindet deinen Kurzbefehl mit deinem Konto.</p>`;
    }
    $("#siri-token-box").innerHTML = html;
    $("#btn-siri-token").textContent = mi.token || mi.freshToken ? "Neuen Schlüssel erzeugen" : "Schlüssel erzeugen";
    $("#btn-siri-revoke").hidden = !(mi.token || mi.freshToken);
  }

  function b64url(bytes) {
    let s = "";
    bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function sha256Hex(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function newToken() {
    if (mi.token && !confirm("Neuen Schlüssel erzeugen? Der bisherige funktioniert dann nicht mehr – du musst ihn im Kurzbefehl ersetzen.")) return;
    const token = "pp_" + b64url(crypto.getRandomValues(new Uint8Array(24)));
    const me = state.session.user.id;
    await sb.from("api_tokens").delete().eq("user_id", me);
    const { data, error } = await sb.from("api_tokens").insert({ user_id: me, token_hash: await sha256Hex(token), label: "Kurzbefehl" })
      .select("id, created_at, last_used_at").single();
    if (error) {
      throw new Error(/api_tokens/.test(error.message) ? "Bitte zuerst das SQL aus Schritt 16 in Supabase ausführen." : error.message);
    }
    mi.token = data;
    mi.freshToken = token;
    renderSiri();
  }

  async function revokeToken() {
    if (!confirm("Schlüssel löschen? Der Kurzbefehl funktioniert dann nicht mehr.")) return;
    const { error } = await sb.from("api_tokens").delete().eq("user_id", state.session.user.id);
    if (error) throw error;
    mi.token = null;
    mi.freshToken = "";
    renderSiri();
    toast("Schlüssel gelöscht.");
  }

  async function load() {
    const [info, log] = await Promise.all([
      call("info").catch(err => ({ error: err.message })),
      sb.from("mail_log").select("*")
        .eq("user_id", state.session.user.id).order("created_at", { ascending: false }).limit(20)
    ]);
    mi.address = info.address || "";
    mi.configured = info.error ? false : !!info.configured;
    mi.log = log.error ? [] : log.data;
    const tk = await sb.from("api_tokens").select("id, created_at, last_used_at").eq("user_id", state.session.user.id)
      .order("created_at", { ascending: false }).limit(1);
    mi.token = tk.error || !tk.data.length ? null : tk.data[0];
    render();
  }

  $("#view-mailin").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.copy) {
      try { await navigator.clipboard.writeText(t.dataset.copy); toast("Adresse kopiert."); } catch { /* egal */ }
      return;
    }
    if (t.id === "btn-siri-token") {
      t.disabled = true;
      try { await newToken(); } catch (err) { toast(translateError(err), true); } finally { t.disabled = false; }
      return;
    }
    if (t.id === "btn-siri-revoke") {
      try { await revokeToken(); } catch (err) { toast(translateError(err), true); }
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
    leave() { mi.active = false; mi.freshToken = ""; },
    async resume() { if (mi.active) load(); else refreshTile(); },
    refreshTile,
    reset() { mi.active = false; mi.log = []; mi.address = ""; }
  };
})();
