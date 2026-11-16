// =========================================================
// Pichis Planner – Sicherung
// Monatlich per E-Mail (Funktion „digest“) oder sofort herunterladen
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, translateError } = PP;

  async function call(action) {
    const { data, error } = await sb.functions.invoke("digest", { body: { action } });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* egal */ }
      throw new Error(/Unbekannte Aktion/.test(msg) ? "Bitte zuerst die neue Funktion „digest“ in Supabase einspielen." : msg);
    }
    return data;
  }

  function render() {
    const f = $("#form-backup");
    if (!f) return;
    const p = state.profile || {};
    f.enabled.checked = !!p.backup_enabled;
    $("#backup-last").textContent = p.backup_last
      ? "Letzte Sicherung per Mail: " + new Date(p.backup_last + "T12:00:00").toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" })
      : "";
  }

  $("#form-backup").addEventListener("change", async e => {
    if (e.target.name !== "enabled") return;
    const on = e.target.checked;
    const { error } = await sb.from("profiles").update({ backup_enabled: on }).eq("id", state.session.user.id);
    if (error) {
      e.target.checked = !on;
      toast(/backup_/.test(error.message || "") ? "Bitte zuerst das SQL aus Schritt 28 in Supabase ausführen." : translateError(error), true);
      return;
    }
    state.profile.backup_enabled = on;
    toast(on ? "Ab jetzt kommt am Monatsanfang eine Sicherung per E-Mail." : "Monatliche Sicherung ausgeschaltet.");
  });

  $("#btn-backup-mail").addEventListener("click", async e => {
    const b = e.currentTarget;
    b.disabled = true;
    const label = b.textContent;
    b.textContent = "Wird gesendet …";
    try {
      const r = await call("backup_send");
      toast(`Sicherung an ${r.to} geschickt.`);
    } catch (err) {
      toast(err.message || translateError(err), true);
    } finally {
      b.disabled = false;
      b.textContent = label;
    }
  });

  $("#btn-backup-download").addEventListener("click", async e => {
    const b = e.currentTarget;
    b.disabled = true;
    const label = b.textContent;
    b.textContent = "Wird erstellt …";
    try {
      const data = await call("backup_download");
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pichis-planner-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      toast(err.message || translateError(err), true);
    } finally {
      b.disabled = false;
      b.textContent = label;
    }
  });

  $("#btn-open-settings").addEventListener("click", render);
  PP.modules.backup = { enter() {}, leave() {}, resume() {}, refreshTile() {}, reset() {} };
})();
