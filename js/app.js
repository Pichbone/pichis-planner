// =========================================================
// Pichis Planner – App-Kern
// Anmeldung, Haushalt, Navigation, gemeinsame Hilfsfunktionen
// =========================================================

(() => {
  "use strict";

  const cfg = window.PP_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const state = {
    session: null,
    profile: null,
    household: null,
    role: null,
    members: []
  };

  // ---------- Hilfsfunktionen ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const screens = ["loading", "auth", "recovery", "household", "app"];
  let currentScreen = "loading";
  function show(name) {
    currentScreen = name;
    screens.forEach(s => { $("#screen-" + s).hidden = s !== name; });
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("error", isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 3000);
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function translateError(err) {
    const m = (err && (err.message || err.error_description)) || String(err);
    if (/Invalid login credentials/i.test(m)) return "E-Mail oder Passwort ist falsch.";
    if (/Email not confirmed/i.test(m)) return "Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Mail).";
    if (/already registered|already exists/i.test(m)) return "Diese E-Mail-Adresse ist bereits registriert.";
    if (/Password should be at least/i.test(m)) return "Das Passwort muss mindestens 8 Zeichen haben.";
    if (/repeat_interval|repeat_days|repeat_until/.test(m)) return "Für benutzerdefinierte Wiederholungen bitte zuerst das SQL aus Schritt 20 in Supabase ausführen.";
    if (/rate limit|too many/i.test(m)) return "Zu viele Versuche. Bitte warte kurz und versuche es erneut.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Keine Verbindung. Bitte Internet prüfen.";
    return m;
  }

  async function withBusy(form, fn) {
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try { await fn(); }
    catch (err) { console.error(err); toast(translateError(err), true); }
    finally { if (btn) btn.disabled = false; }
  }

  function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function storageSet(key, val) { try { localStorage.setItem(key, val); } catch { /* egal */ } }

  function memberName(userId) {
    const m = state.members.find(x => x.id === userId);
    return m ? m.name : "";
  }

  // ---------- Bottom-Sheets (Bearbeiten-Fenster) ----------
  function openSheet(id) {
    $$(".sheet").forEach(s => { s.hidden = s.id !== id; });
    $("#sheet-backdrop").hidden = false;
    const first = $("#" + id + " input");
    if (first && !matchMedia("(pointer: coarse)").matches) first.focus();
  }
  function closeSheets() {
    $$(".sheet").forEach(s => { s.hidden = true; });
    $("#sheet-backdrop").hidden = true;
  }
  $("#sheet-backdrop").addEventListener("click", closeSheets);
  $$("[data-close-sheet]").forEach(b => b.addEventListener("click", closeSheets));

  // ---------- Gemeinsame Schnittstelle für Module ----------
  const modules = {};
  window.PP = {
    sb, state, cfg, modules,
    $, $$, toast, escapeHtml, translateError, withBusy,
    storageGet, storageSet, memberName, openSheet, closeSheets
  };

  // ---------- Daten laden ----------
  async function loadProfile() {
    const { data, error } = await sb
      .from("profiles")
      .select("*")
      .eq("id", state.session.user.id)
      .maybeSingle();
    if (error) throw error;
    state.profile = data || { id: state.session.user.id, display_name: "" };
  }

  async function loadHousehold() {
    const { data, error } = await sb
      .from("household_members")
      .select("role, households (id, name, invite_code)")
      .eq("user_id", state.session.user.id)
      .order("joined_at", { ascending: true });
    if (error) throw error;

    if (!data || data.length === 0) {
      state.household = null;
      state.role = null;
      return;
    }

    const lastId = storageGet("pp_household");
    const entry = data.find(d => d.households && d.households.id === lastId) || data[0];
    state.household = entry.households;
    state.role = entry.role;
    storageSet("pp_household", state.household.id);
  }

  async function loadMembers() {
    const { data: rows, error } = await sb
      .from("household_members")
      .select("user_id, role, joined_at")
      .eq("household_id", state.household.id)
      .order("joined_at", { ascending: true });
    if (error) throw error;

    const ids = rows.map(r => r.user_id);
    const { data: profiles, error: pErr } = await sb
      .from("profiles")
      .select("id, display_name")
      .in("id", ids);
    if (pErr) throw pErr;

    const byId = Object.fromEntries(profiles.map(p => [p.id, p]));
    state.members = rows.map(r => ({
      id: r.user_id,
      role: r.role,
      name: (byId[r.user_id] && byId[r.user_id].display_name) || "Unbekannt"
    }));
  }

  // ---------- Steuerung ----------
  let routing = false;
  async function route() {
    if (routing) return;
    routing = true;
    try {
      if (!state.session) { show("auth"); return; }

      await loadProfile();
      $$("[data-user-name]").forEach(el => { el.textContent = state.profile.display_name; });

      await loadHousehold();
      if (!state.household) { show("household"); return; }

      await loadMembers();
      renderApp();
      show("app");
      applyView();
    } catch (err) {
      console.error(err);
      toast(translateError(err), true);
      show(state.session ? "household" : "auth");
    } finally {
      routing = false;
    }
  }

  // ---------- Ansichten innerhalb der App ----------
  const VIEWS = {
    "": { id: "home", title: null },
    "einkauf": { id: "shopping", title: "Einkaufsliste", module: "shopping" },
    "aufgaben": { id: "todos", title: "Aufgaben", module: "todos" },
    "kalender": { id: "calendar", title: "Kalender", module: "calendar" },
    "medien": { id: "media", title: "Neue Medien", module: "media" },
    "nachrichten": { id: "messages", title: "Nachrichten", module: "messages" },
    "notizen": { id: "notes", title: "Notizen", module: "notes" },
    "tagebuch": { id: "journal", title: "Tagebuch", module: "journal" },
    "mail": { id: "mailin", title: "Eingang", module: "mailin" },
    "wiki": { id: "wiki", title: "Wiki", module: "wiki" },
    "geburtstage": { id: "birthdays", title: "Geburtstage", module: "birthdays" }
  };
  let activeView = null;

  function applyView() {
    if (currentScreen !== "app") return;
    const key = (location.hash || "").replace(/^#\/?/, "");
    const [base, ...rest] = key.split("/");
    const view = VIEWS[key] || VIEWS[base] || VIEWS[""];
    PP.route = { base, param: decodeURIComponent(rest.join("/")) };

    $$(".view").forEach(v => { v.hidden = v.id !== "view-" + view.id; });
    $("#btn-back").hidden = view.id === "home";
    $("#topbar-logo").hidden = view.id !== "home";
    $("#greeting").textContent = view.title || greetingText();

    if (activeView && activeView !== view && activeView.module && modules[activeView.module]) {
      modules[activeView.module].leave();
    }
    activeView = view;

    if (view.module && modules[view.module]) {
      modules[view.module].enter();
    } else {
      Object.values(modules).forEach(m => m.refreshTile && m.refreshTile());
    }
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", applyView);
  $("#btn-back").addEventListener("click", () => {
    if (history.length > 1 && location.hash) history.back();
    else location.hash = "";
  });

  // ---------- Darstellung ----------
  function greetingText() {
    const h = new Date().getHours();
    const name = state.profile.display_name || "";
    if (h < 11) return `Guten Morgen, ${name}`;
    if (h < 18) return `Hallo, ${name}`;
    return `Guten Abend, ${name}`;
  }

  function renderApp() {
    $$("[data-household-name]").forEach(el => { el.textContent = state.household.name; });

    const me = state.session.user.id;
    $("#member-list").innerHTML = state.members.map(m => `
      <li>
        <span class="avatar">${escapeHtml((m.name || "?").trim().charAt(0).toUpperCase())}</span>
        <span class="member-name">${escapeHtml(m.name)}${m.id === me ? ' <span class="muted">(du)</span>' : ""}</span>
        ${m.role === "owner" ? '<span class="badge">Verwaltung</span>' : ""}
      </li>
    `).join("");

    $("#invite-code").textContent = state.household.invite_code;
    $("#btn-new-code").hidden = state.role !== "owner";
    $("#form-profile").name.value = state.profile.display_name;
    renderDigestSettings();
    $("#app-version").textContent = cfg.APP_VERSION;

    renderInstallHint();
  }

  // ---------- Anmelde-Ansicht ----------
  function showAuthPanel(name) {
    $$("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== name; });
    $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    $(".tabs").hidden = name === "forgot";
  }

  $$(".tab").forEach(tab => tab.addEventListener("click", () => showAuthPanel(tab.dataset.tab)));
  $("#btn-show-forgot").addEventListener("click", () => showAuthPanel("forgot"));
  $$("[data-back-login]").forEach(b => b.addEventListener("click", () => showAuthPanel("login")));

  $("#form-login").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const { error } = await sb.auth.signInWithPassword({
        email: f.email.value.trim(),
        password: f.password.value
      });
      if (error) throw error;
      f.reset();
    });
  });

  $("#form-register").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const { data, error } = await sb.auth.signUp({
        email: f.email.value.trim(),
        password: f.password.value,
        options: {
          data: { display_name: f.name.value.trim() },
          emailRedirectTo: window.location.origin
        }
      });
      if (error) throw error;
      f.reset();
      if (!data.session) {
        toast("Fast geschafft! Bitte bestätige deine E-Mail über den Link in der Mail.");
        showAuthPanel("login");
      }
    });
  });

  $("#form-forgot").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), {
        redirectTo: window.location.origin
      });
      if (error) throw error;
      f.reset();
      toast("Falls die Adresse registriert ist, ist der Link unterwegs.");
      showAuthPanel("login");
    });
  });

  $("#form-recovery").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const { error } = await sb.auth.updateUser({ password: f.password.value });
      if (error) throw error;
      f.reset();
      recoveryMode = false;
      toast("Neues Passwort gespeichert.");
      route();
    });
  });

  // ---------- Haushalt ----------
  $("#form-create-household").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const { data, error } = await sb.rpc("create_household", { p_name: f.name.value.trim() });
      if (error) throw error;
      storageSet("pp_household", data.id);
      f.reset();
      toast("Haushalt angelegt!");
      await route();
    });
  });

  $("#form-join-household").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const { data, error } = await sb.rpc("join_household", { p_code: f.code.value.trim() });
      if (error) throw error;
      storageSet("pp_household", data.id);
      f.reset();
      toast(`Willkommen bei „${data.name}“!`);
      await route();
    });
  });

  // ---------- Einstellungen ----------
  function openSettings(open) {
    $("#settings-panel").hidden = !open;
    $("#settings-backdrop").hidden = !open;
  }
  $("#btn-open-settings").addEventListener("click", () => openSettings(true));
  $("#btn-close-settings").addEventListener("click", () => openSettings(false));
  $("#settings-backdrop").addEventListener("click", () => openSettings(false));

  $("#form-profile").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const name = f.name.value.trim();
      const { error } = await sb
        .from("profiles")
        .update({ display_name: name })
        .eq("id", state.session.user.id);
      if (error) throw error;
      state.profile.display_name = name;
      await loadMembers();
      renderApp();
      applyView();
      toast("Name gespeichert.");
    });
  });

  // ---------- Tägliche Zusammenfassung ----------
  function renderDigestSettings() {
    const f = $("#form-digest");
    const p = state.profile || {};
    f.enabled.checked = !!p.digest_enabled;
    f.time.value = String(p.digest_time || "06:30").slice(0, 5);
    f.skip_empty.checked = !!p.digest_skip_empty;
    $("#digest-options").hidden = !f.enabled.checked;
    $("#digest-email").textContent = (state.session && state.session.user.email) || "deine Registrierungs-Adresse";
  }

  $("#form-digest").enabled.addEventListener("change", e => {
    $("#digest-options").hidden = !e.target.checked;
  });

  $("#form-digest").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    withBusy(f, async () => {
      const time = f.time.value || "06:30";
      const now = new Date();
      const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const update = {
        digest_enabled: f.enabled.checked,
        digest_time: time,
        digest_skip_empty: f.skip_empty.checked
      };
      // Uhrzeit für heute schon vorbei? Dann geht die erste Mail morgen raus.
      if (f.enabled.checked && time <= nowHm) update.digest_last_sent = today;
      if (f.enabled.checked && time > nowHm) update.digest_last_sent = null;

      const { error } = await sb.from("profiles").update(update).eq("id", state.session.user.id);
      if (error) throw error;
      Object.assign(state.profile, update);
      toast(f.enabled.checked
        ? `Gespeichert – die Zusammenfassung kommt täglich gegen ${time} Uhr.`
        : "Gespeichert – keine täglichen Mails mehr.");
    });
  });

  $("#btn-digest-test").addEventListener("click", async () => {
    const btn = $("#btn-digest-test");
    btn.disabled = true;
    btn.textContent = "Wird gesendet …";
    try {
      const { data, error } = await sb.functions.invoke("digest", { body: { action: "test" } });
      if (error) {
        let msg = error.message;
        let status = "";
        try {
          const res = error.context;
          if (res && res.status) status = res.status;
          const raw = await res.text();
          try {
            const j = JSON.parse(raw);
            msg = j.error || j.message || j.msg || raw || msg;
          } catch { if (raw) msg = raw.slice(0, 200); }
        } catch { /* keine Antwort lesbar */ }
        if (status === 404) msg = "Die Funktion „digest“ wurde nicht gefunden (404). Bitte Name und Deploy in Supabase prüfen.";
        if (status === 401) msg = "Zugriff verweigert (401). Bitte bei der Funktion „digest“ „Verify JWT“ ausschalten.";
        throw new Error((status ? `[${status}] ` : "") + msg);
      }
      if (!data || !data.sent || !data.to) {
        throw new Error("Die Funktion „digest“ hat nicht wie erwartet geantwortet. Ist der richtige Code deployed?");
      }
      toast(`Testmail an ${data.to} gesendet.`);
    } catch (err) {
      toast(translateError(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Testmail jetzt senden";
    }
  });

  $("#btn-copy-code").addEventListener("click", async () => {
    const code = state.household && state.household.invite_code;
    if (!code) return;
    const text = `Tritt unserem Haushalt in Pichis Planner bei: ${window.location.origin} – Einladungscode: ${code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Pichis Planner", text });
      } else {
        await navigator.clipboard.writeText(code);
        toast("Code kopiert.");
      }
    } catch { /* Teilen abgebrochen */ }
  });

  $("#btn-new-code").addEventListener("click", async () => {
    if (!confirm("Neuen Einladungscode erzeugen? Der alte Code funktioniert dann nicht mehr.")) return;
    try {
      const { data, error } = await sb.rpc("regenerate_invite_code", { hid: state.household.id });
      if (error) throw error;
      state.household.invite_code = data;
      $("#invite-code").textContent = data;
      toast("Neuer Code erzeugt.");
    } catch (err) {
      toast(translateError(err), true);
    }
  });

  $$("[data-logout]").forEach(b => b.addEventListener("click", async () => {
    openSettings(false);
    await sb.auth.signOut();
  }));

  // ---------- Installations-Hinweis ----------
  function renderInstallHint() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (standalone || storageGet("pp_install_dismissed") === "1") {
      $("#install-hint").hidden = true;
      return;
    }
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isMacSafari = /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua) && !isIOS;

    let text = "";
    if (isIOS) text = "In Safari auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.";
    else if (isMacSafari) text = "In Safari im Menü „Ablage“ auf „Zum Dock hinzufügen …“ klicken.";
    else text = "Im Browser-Menü „App installieren“ wählen.";

    $("#install-hint-text").textContent = " " + text;
    $("#install-hint").hidden = false;
  }
  $("#btn-dismiss-install").addEventListener("click", () => {
    storageSet("pp_install_dismissed", "1");
    $("#install-hint").hidden = true;
  });

  // ---------- Start ----------
  let recoveryMode = false;

  function start() {
    sb.auth.onAuthStateChange((event, session) => {
      state.session = session;
      // Supabase-Aufrufe nicht direkt im Callback ausführen
      setTimeout(() => {
        if (event === "PASSWORD_RECOVERY") { recoveryMode = true; show("recovery"); return; }
        if (recoveryMode) return; // erst neues Passwort setzen
        if (event === "SIGNED_OUT") {
          Object.values(modules).forEach(m => m.reset && m.reset());
          activeView = null;
          state.profile = state.household = null;
          state.members = [];
          showAuthPanel("login");
          show("auth");
          return;
        }
        if (event === "INITIAL_SESSION" || event === "SIGNED_IN") route();
      }, 0);
    });

    // Beim Zurückkehren in die App (iPhone schließt Verbindungen im Hintergrund)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || currentScreen !== "app") return;
      Object.values(modules).forEach(m => m.resume && m.resume());
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(err => console.warn("Service Worker:", err));
    }
  }

  // Erst starten, wenn alle Module geladen sind
  document.addEventListener("DOMContentLoaded", start);
})();
