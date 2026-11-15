// =========================================================
// Pichis Planner – Hintergrundbild (für die ganze Familie gleich)
// Bild und Abschwächung hängen am Haushalt; ändern darf die Verwaltung.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, translateError, storageGet, storageSet } = PP;

  const MAX_PX = 2400;
  const CACHE_KEY = "pp_bg";
  const bg = { path: null, dim: 45, loading: false, slideTimer: null };

  const root = document.documentElement;
  const isOwner = () => state.role === "owner";

  // ---------- Anzeigen ----------
  function show(url, dim) {
    if (url) {
      root.style.setProperty("--app-bg-image", `url("${url.replace(/"/g, "%22")}")`);
      root.style.setProperty("--app-bg-veil", String(Math.max(0, Math.min(90, dim)) / 100));
      document.body.classList.add("has-bg");
    } else {
      root.style.removeProperty("--app-bg-image");
      document.body.classList.remove("has-bg");
    }
  }

  function readCache() {
    try { return JSON.parse(storageGet(CACHE_KEY) || "null"); } catch { return null; }
  }

  // Beim Start sofort das zuletzt bekannte Bild zeigen (ohne auf die Datenbank zu warten)
  (() => {
    const c = readCache();
    if (c && c.url && c.until > Date.now() + 60000) { bg.path = c.path; bg.dim = c.dim; show(c.url, c.dim); }
  })();

  async function signedUrl(path) {
    const c = readCache();
    if (c && c.path === path && c.url && c.until > Date.now() + 3600000) return c.url;
    const { data, error } = await sb.storage.from("household-files").createSignedUrl(path, 7 * 86400);
    if (error) throw error;
    return data.signedUrl;
  }

  async function load() {
    if (!state.household || bg.loading) return;
    bg.loading = true;
    try {
      const { data, error } = await sb.from("households").select("background_path, background_dim").eq("id", state.household.id).maybeSingle();
      if (error) {
        // Schritt 23 noch nicht eingespielt – einfach ohne Bild
        if (/background_/.test(error.message || "")) { bg.missing = true; renderSettings(); return; }
        throw error;
      }
      bg.missing = false;
      bg.path = data ? data.background_path : null;
      bg.dim = data && data.background_dim != null ? data.background_dim : 45;
      if (!bg.path) {
        storageSet(CACHE_KEY, "null");
        show(null);
      } else {
        const url = await signedUrl(bg.path);
        const c = readCache();
        const until = c && c.path === bg.path && c.url === url ? c.until : Date.now() + 7 * 86400 * 1000;
        storageSet(CACHE_KEY, JSON.stringify({ path: bg.path, url, dim: bg.dim, until }));
        show(url, bg.dim);
      }
      renderSettings();
    } catch (err) {
      console.warn("Hintergrund:", err);
    } finally {
      bg.loading = false;
    }
  }

  // ---------- Einstellungen (Personen-Symbol oben rechts) ----------
  function renderSettings() {
    const box = $("#bg-settings");
    if (!box) return;
    const c = readCache();
    const url = c && c.path === bg.path ? c.url : "";
    $("#bg-preview").style.backgroundImage = bg.path && url ? `url("${url.replace(/"/g, "%22")}")` : "";
    $("#bg-preview").classList.toggle("empty", !bg.path);
    $("#bg-dim").value = bg.dim;
    $("#bg-dim-value").textContent = bg.dim + " %";
    $("#bg-dim-row").hidden = !bg.path;
    $("#btn-bg-remove").hidden = !bg.path;
    const owner = isOwner();
    $("#btn-bg-pick").hidden = !owner;
    $("#btn-bg-remove").hidden = !owner || !bg.path;
    $("#bg-dim").disabled = !owner;
    $("#bg-note").textContent = bg.missing
      ? "Bitte zuerst das SQL aus Schritt 23 in Supabase ausführen."
      : owner
        ? "Gilt für alle in der Familie. Fotos werden automatisch verkleinert."
        : "Das Hintergrundbild legt die Verwaltung des Haushalts fest.";
  }

  function loadImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Das Bild konnte nicht gelesen werden (HEIC? Bitte als JPEG wählen).")); };
      img.src = url;
    });
  }

  async function shrink(file) {
    const img = await loadImg(file);
    const scale = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
    if (!blob) throw new Error("Das Bild konnte nicht umgewandelt werden.");
    return blob;
  }

  async function saveRow(update) {
    const { error } = await sb.from("households").update(update).eq("id", state.household.id);
    if (error) throw error;
  }

  $("#btn-bg-pick").addEventListener("click", () => $("#bg-file").click());
  $("#bg-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const btn = $("#btn-bg-pick");
    btn.disabled = true;
    btn.textContent = "Lädt hoch …";
    const old = bg.path;
    try {
      const blob = await shrink(file);
      const path = `${state.household.id}/hintergrund-${crypto.randomUUID()}.jpg`;
      const up = await sb.storage.from("household-files").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      try {
        await saveRow({ background_path: path });
      } catch (err) {
        await sb.storage.from("household-files").remove([path]);
        throw err;
      }
      if (old) await sb.storage.from("household-files").remove([old]);
      storageSet(CACHE_KEY, "null");
      await load();
      toast("Hintergrund gespeichert – die Familie sieht ihn beim nächsten Öffnen.");
    } catch (err) {
      toast(/background_|Bucket not found/i.test(err.message || "") ? "Bitte zuerst das SQL aus Schritt 23 in Supabase ausführen." : translateError(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "🖼️ Bild wählen";
    }
  });

  $("#btn-bg-remove").addEventListener("click", async () => {
    if (!bg.path || !confirm("Hintergrundbild für alle entfernen?")) return;
    try {
      const old = bg.path;
      await saveRow({ background_path: null });
      await sb.storage.from("household-files").remove([old]);
      bg.path = null;
      storageSet(CACHE_KEY, "null");
      show(null);
      renderSettings();
      toast("Hintergrund entfernt.");
    } catch (err) {
      toast(translateError(err), true);
    }
  });

  // Schieber: sofort sehen, kurz danach speichern
  $("#bg-dim").addEventListener("input", e => {
    bg.dim = +e.target.value;
    $("#bg-dim-value").textContent = bg.dim + " %";
    root.style.setProperty("--app-bg-veil", String(bg.dim / 100));
    clearTimeout(bg.slideTimer);
    bg.slideTimer = setTimeout(async () => {
      try {
        await saveRow({ background_dim: bg.dim });
        const c = readCache();
        if (c) storageSet(CACHE_KEY, JSON.stringify({ ...c, dim: bg.dim }));
      } catch (err) { toast(translateError(err), true); }
    }, 600);
  });

  PP.background = { load, renderSettings };

  PP.modules.background = {
    enter() {}, leave() {},
    resume: load,
    refreshTile: load,     // Startseite: Bild ggf. aktualisieren
    reset() { bg.path = null; storageSet(CACHE_KEY, "null"); show(null); }
  };
})();
