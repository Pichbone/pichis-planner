// =========================================================
// Pichis Planner – Familien-Nachrichten
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { sb, state, $, toast, escapeHtml, translateError, storageGet, storageSet, memberName } = PP;

  const ms = {
    active: false,
    messages: [],
    reads: new Map(),      // thread → last_read_at
    thread: storageGet("pp_msg_thread") || "family",
    channel: null
  };

  const me = () => state.session.user.id;

  function threadOf(m) {
    if (!m.recipient_id) return "family";
    return m.sender_id === me() ? m.recipient_id : m.sender_id;
  }

  function unreadCount(thread) {
    const last = ms.reads.get(thread) || "1970-01-01";
    return ms.messages.filter(m => threadOf(m) === thread && m.sender_id !== me() && m.created_at > last).length;
  }

  function totalUnread() {
    const threads = new Set(ms.messages.map(threadOf));
    let n = 0;
    threads.forEach(t => { n += unreadCount(t); });
    return n;
  }

  // ---------- Daten ----------
  async function loadAll() {
    const hid = state.household.id;
    const [msgs, reads] = await Promise.all([
      sb.from("messages").select("id, sender_id, recipient_id, body, created_at")
        .eq("household_id", hid).order("created_at", { ascending: false }).limit(400),
      sb.from("message_reads").select("thread, last_read_at").eq("user_id", me())
    ]);
    if (msgs.error) throw msgs.error;
    if (reads.error) throw reads.error;
    ms.messages = msgs.data.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    ms.reads = new Map(reads.data.map(r => [r.thread, r.last_read_at]));
  }

  async function markRead(thread) {
    if (!unreadCount(thread)) return;
    const now = new Date().toISOString();
    ms.reads.set(thread, now);
    await sb.from("message_reads").upsert({ user_id: me(), thread, last_read_at: now }, { onConflict: "user_id,thread" });
  }

  function subscribe() {
    unsubscribe();
    const hid = state.household.id;
    ms.channel = sb.channel("msg-" + hid)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `household_id=eq.${hid}` }, p => {
        if (!ms.messages.some(x => x.id === p.new.id)) {
          ms.messages.push(p.new);
          ms.messages.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        }
        if (ms.active && threadOf(p.new) === ms.thread && document.visibilityState === "visible") markRead(ms.thread);
        render(true);
        updateTile();
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, p => {
        ms.messages = ms.messages.filter(x => x.id !== (p.old && p.old.id));
        render();
      })
      .subscribe();
  }
  function unsubscribe() {
    if (ms.channel) { sb.removeChannel(ms.channel); ms.channel = null; }
  }

  // ---------- Darstellung ----------
  function dayLabel(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return "Heute";
    if (diff === 1) return "Gestern";
    return day.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  }

  function linkify(html) {
    return html.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  function render(scrollDown = false) {
    if (!ms.active) return;
    const others = state.members.filter(m => m.id !== me());
    if (ms.thread !== "family" && !others.some(m => m.id === ms.thread)) ms.thread = "family";

    // Gesprächs-Auswahl
    const chip = (id, label) => {
      const n = unreadCount(id);
      return `<button class="chip${ms.thread === id ? " active" : ""}" data-thread="${id}">${label}${n ? ` <span class="chip-count">${n}</span>` : ""}</button>`;
    };
    $("#msg-threads").innerHTML = chip("family", "👨‍👩‍👧 Familie") +
      others.map(m => chip(m.id, escapeHtml(m.name))).join("");

    // Nachrichten
    const list = ms.messages.filter(m => threadOf(m) === ms.thread);
    let html = "", lastDay = "", lastSender = "";
    for (const m of list) {
      const d = new Date(m.created_at);
      const day = d.toDateString();
      if (day !== lastDay) {
        html += `<li class="msg-day">${escapeHtml(dayLabel(d))}</li>`;
        lastDay = day;
        lastSender = "";
      }
      const mine = m.sender_id === me();
      const showName = !mine && ms.thread === "family" && lastSender !== m.sender_id;
      html += `<li class="msg ${mine ? "mine" : "theirs"}">
        <div class="bubble"${mine ? ` data-own="${m.id}"` : ""}>
          ${showName ? `<span class="msg-name">${escapeHtml(memberName(m.sender_id) || "?")}</span>` : ""}
          <span class="msg-body">${linkify(escapeHtml(m.body)).replace(/\n/g, "<br>")}</span>
          <span class="msg-time">${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </li>`;
      lastSender = m.sender_id;
    }
    const box = $("#msg-list");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = html || `<li class="empty"><div class="empty-icon">💬</div>
      <p><strong>${ms.thread === "family" ? "Noch keine Nachrichten in der Familie." : "Noch keine Nachrichten mit " + escapeHtml(memberName(ms.thread)) + "."}</strong></p>
      <p class="muted small">Schreib unten die erste Nachricht.</p></li>`;

    const to = ms.thread === "family" ? "die ganze Familie" : memberName(ms.thread);
    $("#msg-input").placeholder = `Nachricht an ${to}`;
    if (scrollDown === true || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- Senden ----------
  async function send() {
    const input = $("#msg-input");
    const body = input.value.trim();
    if (!body) return;
    const btn = $("#btn-msg-send");
    btn.disabled = true;
    try {
      const { data, error } = await sb.from("messages").insert({
        household_id: state.household.id,
        sender_id: me(),
        recipient_id: ms.thread === "family" ? null : ms.thread,
        body
      }).select("id, sender_id, recipient_id, body, created_at").single();
      if (error) throw error;
      input.value = "";
      autoGrow();
      if (!ms.messages.some(x => x.id === data.id)) ms.messages.push(data);
      render(true);
      if (PP.notify) PP.notify.message(data.id);
    } catch (err) {
      toast(translateError(err), true);
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  function autoGrow() {
    const el = $("#msg-input");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }

  $("#form-msg").addEventListener("submit", e => { e.preventDefault(); send(); });
  $("#msg-input").addEventListener("input", autoGrow);
  $("#msg-input").addEventListener("keydown", e => {
    // Auf dem Mac/PC: Enter sendet, Shift+Enter = neue Zeile
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      send();
    }
  });

  $("#view-messages").addEventListener("click", async e => {
    const t = e.target.closest("[data-thread], [data-own]");
    if (!t) return;
    if (t.dataset.thread) {
      ms.thread = t.dataset.thread;
      storageSet("pp_msg_thread", ms.thread);
      await markRead(ms.thread);
      render(true);
      return;
    }
    if (t.dataset.own && !e.target.closest("a")) {
      if (!confirm("Diese Nachricht löschen?")) return;
      const { error } = await sb.from("messages").delete().eq("id", t.dataset.own);
      if (error) { toast(translateError(error), true); return; }
      ms.messages = ms.messages.filter(x => x.id !== t.dataset.own);
      render();
    }
  });

  // ---------- Kachel ----------
  function updateTile() {
    const n = totalUnread();
    const el = $("#tile-msg-status");
    el.textContent = n ? `${n} ungelesen` : "Öffnen";
    el.classList.toggle("tile-badge", n > 0);
  }

  async function refreshTile() {
    if (!state.household) return;
    try {
      await loadAll();
      updateTile();
      if (!ms.channel) subscribe();
    } catch (err) { console.warn(err); }
  }

  PP.modules.messages = {
    async enter() {
      ms.active = true;
      try {
        await loadAll();
        subscribe();
        await markRead(ms.thread);
        render(true);
        updateTile();
      } catch (err) {
        console.error(err);
        toast(translateError(err), true);
      }
    },
    leave() {
      ms.active = false;
      // Live-Abgleich bleibt für den Ungelesen-Zähler auf der Startseite bestehen
    },
    async resume() {
      try {
        await loadAll();
        subscribe();
        if (ms.active) { await markRead(ms.thread); render(true); }
        updateTile();
      } catch (err) { console.error(err); }
    },
    refreshTile,
    reset() {
      ms.active = false;
      unsubscribe();
      ms.messages = [];
      ms.reads = new Map();
    }
  };
})();
