// =========================================================
// Pichis Planner – Wunschliste & Geschenkideen
// Jede Person trägt ihre Wünsche ein, alle sehen sie. „Ich schenke das“
// sehen alle außer der Person selbst – die Überraschung bleibt.
// Geheime Ideen für jemanden sieht die beschenkte Person nicht.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, memberName, openSheet, closeSheets } = PP;

  const gf = { active: false, wishes: [], claims: new Map(), person: storageGet("pp_gift_person") || "", editId: null, editFor: null };
  const hid = () => state.household.id;
  const me = () => state.session.user.id;
  const STARS = { 1: "☆", 2: "⭐", 3: "⭐⭐⭐" };
  const PRIO = { 1: "Kleinigkeit", 2: "Wunsch", 3: "Großer Wunsch" };
  const eur = v => Number(v).toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: Number(v) % 1 ? 2 : 0 });
  const num = v => { const x = parseFloat(String(v ?? "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

  function sqlHint(err) {
    const m = (err && err.message) || "";
    return /gift_|does not exist|schema cache/.test(m) ? "Bitte zuerst das SQL aus Schritt 47 in Supabase ausführen." : translateError(err);
  }

  // ---------- Daten ----------
  async function loadAll() {
    const [w, c] = await Promise.all([
      sb.from("gift_wishes").select("*").eq("household_id", hid()).order("priority", { ascending: false }).order("created_at"),
      sb.from("gift_claims").select("*").eq("household_id", hid())
    ]);
    if (w.error) throw w.error;
    gf.wishes = w.data;
    gf.claims = new Map((c.error ? [] : c.data).map(x => [x.wish_id, x]));
  }

  const people = () => {
    const list = (state.members || []).slice().sort((a, b) => (a.id === me() ? -1 : b.id === me() ? 1 : a.name.localeCompare(b.name, "de")));
    return list;
  };
  const current = () => (people().some(p => p.id === gf.person) ? gf.person : me());

  // ---------- Anzeige ----------
  function render() {
    const who = current();
    const mine = who === me();
    const name = memberName(who) || "Ich";
    $("#gift-people").innerHTML = people().map(p => {
      const n = gf.wishes.filter(w => w.for_user === p.id && !w.received).length;
      return `<button class="chip${p.id === who ? " active" : ""}" data-gift-person="${p.id}">${p.id === me() ? "🎁 Meine Wünsche" : escapeHtml(p.name)}${n ? ` <span class="chip-count">${n}</span>` : ""}</button>`;
    }).join("");

    const list = gf.wishes.filter(w => w.for_user === who);
    const open = list.filter(w => !w.received);
    const got = list.filter(w => w.received);
    const card = w => {
      const c = gf.claims.get(w.id);
      const secret = w.created_by !== w.for_user;
      const u = /^https?:\/\//i.test(w.url) ? w.url : "";
      let claim = "";
      if (!mine && !w.received) {
        claim = !c ? `<button type="button" class="btn btn-small gift-claim" data-gift-claim="${w.id}">🎁 Ich schenke das</button>`
          : c.claimed_by === me() ? `<span class="gift-mine">🎁 Du schenkst das${c.bought ? " · gekauft ✓" : ""}</span>
              ${c.bought ? "" : `<button type="button" class="link small" data-gift-bought="${w.id}">✓ gekauft</button>`}
              <button type="button" class="link small" data-gift-unclaim="${w.id}">zurückgeben</button>`
          : `<span class="gift-taken">✓ ${escapeHtml(memberName(c.claimed_by) || "Jemand")} schenkt das${c.bought ? " (gekauft)" : ""}</span>`;
      }
      return `<li class="card gift-card${w.received ? " received" : ""}${c && !mine ? " taken" : ""}">
        <div class="gift-head">
          <span class="gift-prio" title="${PRIO[w.priority]}">${STARS[w.priority]}</span>
          <span class="gift-title">${u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(w.title)}</a>` : escapeHtml(w.title)}</span>
          ${w.price != null ? `<span class="gift-price">${eur(w.price)}</span>` : ""}
        </div>
        ${w.note ? `<p class="small gift-note">${escapeHtml(w.note)}</p>` : ""}
        <p class="muted small">${[u ? "🔗 " + escapeHtml(host(u)) : "", secret ? `🤫 Idee von ${escapeHtml(w.created_by === me() ? "dir" : memberName(w.created_by) || "jemandem")} – ${escapeHtml(memberName(w.for_user))} sieht das nicht` : "",
          w.received ? `✓ bekommen${w.received_at ? " am " + new Date(w.received_at + "T12:00:00").toLocaleDateString("de-DE") : ""}` : ""].filter(Boolean).join(" · ")}</p>
        <div class="gift-actions">
          ${claim}
          ${(w.created_by === me() || w.for_user === me()) ? `<button type="button" class="link small" data-gift-edit="${w.id}">Bearbeiten</button>` : ""}
          ${mine && !w.received ? `<button type="button" class="link small" data-gift-got="${w.id}">✓ Bekommen</button>` : ""}
        </div>
      </li>`;
    };

    const myClaims = [...gf.claims.values()].filter(c => c.claimed_by === me()).map(c => gf.wishes.find(w => w.id === c.wish_id)).filter(w => w && !w.received);
    $("#gift-body").innerHTML = `
      ${mine ? `<button type="button" class="btn btn-primary btn-block" data-gift-add="${me()}">＋ Wunsch eintragen</button>
        <p class="muted small gift-intro">Alle im Haushalt sehen deine Wünsche. Wer was schenkt, siehst du nicht – damit es eine Überraschung bleibt.</p>`
        : `<div class="btn-row"><button type="button" class="btn btn-small" data-gift-add="${who}">🤫 Geheime Idee für ${escapeHtml(name)}</button></div>
        <p class="muted small gift-intro">${escapeHtml(name)} sieht nicht, wer was schenkt, und auch keine geheimen Ideen.</p>`}
      ${open.length ? `<ul class="gift-list">${open.map(card).join("")}</ul>`
        : `<div class="empty"><div class="empty-icon">🎁</div><p><strong>${mine ? "Noch keine Wünsche." : `${escapeHtml(name)} hat noch keine Wünsche eingetragen.`}</strong></p>
           ${mine ? `<p class="muted small">Trag ein, worüber du dich freuen würdest – gern mit Link, Preis und Größe oder Farbe.</p>` : ""}</div>`}
      ${got.length ? `<details class="tr-past"><summary>Schon bekommen (${got.length})</summary><ul class="gift-list">${got.map(card).join("")}</ul></details>` : ""}
      ${mine && myClaims.length ? `<h4 class="cal-sub">🎁 Was ich verschenke</h4><ul class="ar-list">${myClaims.map(w => {
          const c = gf.claims.get(w.id);
          return `<li><button class="ar-doc" data-gift-person="${w.for_user}"><span class="ar-icon">${c.bought ? "✅" : "🎁"}</span><span class="ar-main"><span class="ar-title">${escapeHtml(w.title)}</span>
            <span class="ar-sub">für ${escapeHtml(memberName(w.for_user))}${w.price != null ? " · " + eur(w.price) : ""}${c.bought ? " · gekauft" : ""}</span></span></button></li>`;
        }).join("")}</ul>` : ""}`;
  }

  // ---------- Wunsch anlegen / bearbeiten ----------
  function openWish(id, forUser) {
    const w = id ? gf.wishes.find(x => x.id === id) : null;
    gf.editId = id || null;
    gf.editFor = w ? w.for_user : forUser;
    const f = $("#form-gift");
    f.reset();
    f.title.value = w ? w.title : "";
    f.url.value = w ? w.url : "";
    f.price.value = w && w.price != null ? String(w.price).replace(".", ",") : "";
    f.note.value = w ? w.note : "";
    f.priority.value = String(w ? w.priority : 2);
    const secret = gf.editFor !== me();
    $("#gift-sheet-title").textContent = w ? "Wunsch bearbeiten" : secret ? `🤫 Idee für ${memberName(gf.editFor)}` : "Neuer Wunsch";
    $("#gift-secret-hint").hidden = !secret;
    $("#gift-secret-hint").textContent = secret ? `${memberName(gf.editFor)} sieht diese Idee nicht – nur die anderen im Haushalt.` : "";
    $("#btn-gift-delete").hidden = !w;
    $("#btn-gift-reopen").hidden = !(w && w.received);
    openSheet("sheet-gift");
    if (!w) setTimeout(() => f.title.focus(), 60);
  }

  // Link einfügen → Titel aus der Adresse vorschlagen, wenn noch leer
  $("#form-gift").url.addEventListener("change", e => {
    const f = e.target.form;
    const u = e.target.value.trim();
    if (u && !/^https?:\/\//i.test(u) && /\.[a-z]{2,}/i.test(u)) e.target.value = "https://" + u;
    if (!f.title.value.trim() && /^https?:\/\//i.test(e.target.value)) {
      try {
        const parts = new URL(e.target.value).pathname.split("/").filter(p => p && !/^(dp|p|product|produkt|artikel|item|gp)$/i.test(p) && !/^[A-Z0-9]{8,}$/.test(p) && /[a-z]/i.test(p));
        const guess = (parts.sort((a, b) => b.length - a.length)[0] || "").replace(/\.(html?|php)$/, "").replace(/[-_+]+/g, " ").replace(/\b\d{5,}\b/g, "").trim();
        if (guess.length > 3) f.title.value = guess.charAt(0).toUpperCase() + guess.slice(1, 120);
      } catch { /* egal */ }
    }
  });

  $("#form-gift").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    PP.withBusy(f, async () => {
      const url = f.url.value.trim();
      const row = {
        title: f.title.value.trim().slice(0, 160), url: url && !/^https?:\/\//i.test(url) ? "https://" + url : url.slice(0, 1000),
        price: num(f.price.value), note: f.note.value.trim().slice(0, 500), priority: +f.priority.value || 2
      };
      if (!row.title) throw new Error("Bitte eintragen, was du dir wünschst.");
      if (row.price != null) row.price = Math.round(row.price * 100) / 100;
      const q = gf.editId ? sb.from("gift_wishes").update(row).eq("id", gf.editId)
        : sb.from("gift_wishes").insert({ ...row, household_id: hid(), for_user: gf.editFor });
      const { data, error } = await q.select().single();
      if (error) throw new Error(sqlHint(error));
      gf.wishes = [...gf.wishes.filter(w => w.id !== data.id), data];
      closeSheets(); render(); refreshTile();
      toast(gf.editId ? "Gespeichert." : gf.editFor === me() ? "Wunsch eingetragen." : "Geheime Idee gespeichert. 🤫");
    });
  });

  $("#btn-gift-delete").addEventListener("click", async () => {
    const w = gf.wishes.find(x => x.id === gf.editId);
    if (!w || !confirm(`„${w.title}“ löschen?`)) return;
    const { error } = await sb.from("gift_wishes").delete().eq("id", w.id);
    if (error) { toast(sqlHint(error), true); return; }
    gf.wishes = gf.wishes.filter(x => x.id !== w.id);
    closeSheets(); render(); refreshTile();
  });
  $("#btn-gift-reopen").addEventListener("click", async () => {
    const { data, error } = await sb.from("gift_wishes").update({ received: false, received_at: null }).eq("id", gf.editId).select().single();
    if (error) { toast(sqlHint(error), true); return; }
    gf.wishes = gf.wishes.map(w => w.id === data.id ? data : w);
    closeSheets(); render();
  });

  // ---------- Klicks in der Liste ----------
  $("#view-gifts").addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.giftPerson) { gf.person = b.dataset.giftPerson; storageSet("pp_gift_person", gf.person); render(); window.scrollTo({ top: 0 }); return; }
    if (b.dataset.giftAdd) { openWish(null, b.dataset.giftAdd); return; }
    if (b.dataset.giftEdit) { openWish(b.dataset.giftEdit); return; }
    if (b.dataset.giftGot) {
      const pad = n => String(n).padStart(2, "0"), d = new Date();
      const { data, error } = await sb.from("gift_wishes").update({ received: true, received_at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }).eq("id", b.dataset.giftGot).select().single();
      if (error) { toast(sqlHint(error), true); return; }
      gf.wishes = gf.wishes.map(w => w.id === data.id ? data : w);
      render(); refreshTile(); toast("Schön! 🎉");
      return;
    }
    if (b.dataset.giftClaim) {
      const w = gf.wishes.find(x => x.id === b.dataset.giftClaim);
      const { data, error } = await sb.from("gift_claims").insert({ wish_id: w.id, household_id: hid() }).select().single();
      if (error) { toast(/duplicate|unique|pkey/i.test(error.message || "") ? "Das schenkt inzwischen schon jemand anderes." : sqlHint(error), true); await loadAll(); render(); return; }
      gf.claims.set(w.id, data);
      render();
      toast(`Notiert – ${memberName(w.for_user)} sieht das nicht. 🤫`);
      return;
    }
    if (b.dataset.giftBought) {
      const { data, error } = await sb.from("gift_claims").update({ bought: true }).eq("wish_id", b.dataset.giftBought).select().single();
      if (error) { toast(sqlHint(error), true); return; }
      gf.claims.set(data.wish_id, data); render(); return;
    }
    if (b.dataset.giftUnclaim) {
      const { error } = await sb.from("gift_claims").delete().eq("wish_id", b.dataset.giftUnclaim);
      if (error) { toast(sqlHint(error), true); return; }
      gf.claims.delete(b.dataset.giftUnclaim); render(); return;
    }
  });

  // ---------- Startseite ----------
  async function refreshTile() {
    const el = $("#tile-gift-status");
    if (!el || !state.household) return;
    const { count, error } = await sb.from("gift_wishes").select("id", { count: "exact", head: true }).eq("household_id", hid()).eq("received", false);
    el.textContent = error ? "Wunschliste" : count ? `${count} Wünsche` : "Wunschliste";
  }

  PP.modules.gifts = {
    async enter() {
      gf.active = true;
      try { await loadAll(); } catch (err) { console.error(err); toast(sqlHint(err), true); }
      render();
    },
    leave() { gf.active = false; closeSheets(); },
    async resume() { if (gf.active) { try { await loadAll(); render(); } catch { /* egal */ } } else refreshTile(); },
    refreshTile,
    reset() { gf.wishes = []; gf.claims = new Map(); }
  };
})();
