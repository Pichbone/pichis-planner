// =========================================================
// Pichis Planner – Push-Mitteilungen (Einstellungen und Versand-Hilfen)
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, translateError } = PP;

  let publicKey = null;

  function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }
  function isIOS() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function standalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  async function callPush(action, payload = {}) {
    const { data, error } = await sb.functions.invoke("push", { body: { action, ...payload } });
    if (error) {
      let msg = error.message, status = "";
      try {
        const res = error.context;
        status = res && res.status;
        const raw = await res.text();
        try { const j = JSON.parse(raw); msg = j.error || j.message || raw; } catch { if (raw) msg = raw.slice(0, 200); }
      } catch { /* keine Antwort */ }
      if (status === 404) msg = "Die Funktion „push“ wurde nicht gefunden. Bitte in Supabase mit genau diesem Namen anlegen.";
      throw new Error(msg);
    }
    return data;
  }

  async function currentSubscription() {
    if (!supported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
    if (/Macintosh/.test(ua)) return "Mac";
    if (/Android/.test(ua)) return "Android";
    if (/Windows/.test(ua)) return "Windows";
    return "Browser";
  }

  // ---------- Einstellungen ----------
  async function renderSettings() {
    const status = $("#push-status");
    const btn = $("#btn-push-toggle");
    const test = $("#btn-push-test");
    const f = $("#form-push-prefs");
    f.push_messages.checked = state.profile ? state.profile.push_messages !== false : true;
    f.push_tasks.checked = state.profile ? state.profile.push_tasks !== false : true;

    if (!supported()) {
      btn.hidden = true;
      test.hidden = true;
      status.textContent = isIOS() && !standalone()
        ? "Auf iPhone und iPad funktionieren Mitteilungen nur in der installierten App: In Safari „Teilen“ → „Zum Home-Bildschirm“, dann die App von dort öffnen."
        : "Dieser Browser unterstützt keine Mitteilungen.";
      return;
    }
    if (Notification.permission === "denied") {
      btn.hidden = true;
      test.hidden = true;
      status.textContent = "Mitteilungen sind für Pichis Planner blockiert. Bitte in den Einstellungen des Geräts erlauben (iPhone: Einstellungen → Mitteilungen → Pichis Planner).";
      return;
    }

    const sub = await currentSubscription().catch(() => null);
    btn.hidden = false;
    test.hidden = !sub;
    btn.textContent = sub ? "Auf diesem Gerät ausschalten" : "Auf diesem Gerät einschalten";
    btn.classList.toggle("btn-ghost", !!sub);
    btn.classList.toggle("btn-secondary", !sub);
    status.textContent = sub
      ? `Eingeschaltet auf diesem ${deviceName()}.`
      : "Noch nicht eingeschaltet auf diesem Gerät.";

    // Schlüssel schon vorab holen, damit das Einschalten direkt nach dem Tippen klappt
    if (!sub && !publicKey) {
      callPush("public_key").then(d => { publicKey = d.publicKey; }).catch(() => { /* später erneut */ });
    }
  }

  async function enable() {
    const btn = $("#btn-push-toggle");
    btn.disabled = true;
    try {
      // Erlaubnis muss direkt nach dem Tippen angefragt werden (iPhone)
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toast("Ohne Erlaubnis können keine Mitteilungen angezeigt werden.", true);
        return;
      }
      if (!publicKey) publicKey = (await callPush("public_key")).publicKey;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64urlToBytes(publicKey)
        });
      }
      const json = sub.toJSON();
      const { error } = await sb.from("push_subscriptions").upsert({
        user_id: state.session.user.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        device: deviceName()
      }, { onConflict: "endpoint" });
      if (error) throw error;
      toast("Mitteilungen eingeschaltet.");
    } catch (err) {
      console.error(err);
      toast(translateError(err), true);
    } finally {
      btn.disabled = false;
      renderSettings();
    }
  }

  async function disable() {
    const btn = $("#btn-push-toggle");
    btn.disabled = true;
    try {
      const sub = await currentSubscription();
      if (sub) {
        await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      toast("Mitteilungen auf diesem Gerät ausgeschaltet.");
    } catch (err) {
      toast(translateError(err), true);
    } finally {
      btn.disabled = false;
      renderSettings();
    }
  }

  $("#btn-push-toggle").addEventListener("click", async () => {
    const sub = await currentSubscription().catch(() => null);
    sub ? disable() : enable();
  });

  $("#btn-push-test").addEventListener("click", async () => {
    const btn = $("#btn-push-test");
    btn.disabled = true;
    try {
      const r = await callPush("test");
      toast(r.sent ? `Test-Mitteilung an ${r.sent} Gerät${r.sent === 1 ? "" : "e"} gesendet.` : "Kein Gerät erreicht – bitte Mitteilungen aus- und wieder einschalten.", !r.sent);
    } catch (err) {
      toast(translateError(err), true);
    } finally {
      btn.disabled = false;
    }
  });

  $("#form-push-prefs").addEventListener("change", async e => {
    const t = e.target;
    if (!t.name) return;
    const { error } = await sb.from("profiles").update({ [t.name]: t.checked }).eq("id", state.session.user.id);
    if (error) { t.checked = !t.checked; toast(translateError(error), true); return; }
    if (state.profile) state.profile[t.name] = t.checked;
  });

  $("#btn-open-settings").addEventListener("click", () => { renderSettings(); });

  // Klick auf eine Mitteilung bei offener App: zur passenden Ansicht springen
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", e => {
      if (e.data && e.data.type === "navigate" && e.data.url) {
        const u = new URL(e.data.url);
        if (u.origin === location.origin) location.hash = u.hash;
      }
    });
  }

  // ---------- Hilfen für andere Module (still, ohne Fehlermeldung) ----------
  PP.notify = {
    message(messageId) {
      callPush("message", { message_id: messageId }).catch(err => console.warn("Push:", err.message));
    },
    task(todoId) {
      callPush("task", { todo_id: todoId }).catch(err => console.warn("Push:", err.message));
    }
  };
})();
