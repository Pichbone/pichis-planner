// =========================================================
// Pichis Planner – Wiederholungen (gemeinsam für Kalender und Aufgaben)
// Auswahl „Benutzerdefiniert …“: alle N Tage/Wochen/Monate/Jahre,
// Wochentage, Monat nach Datum oder z. B. „2. Dienstag“, Ende.
// =========================================================

(() => {
  "use strict";

  const PP = window.PP;
  const { escapeHtml } = PP;

  const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const RR = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const UNIT = {
    daily: ["Tag", "Tage"], weekly: ["Woche", "Wochen"], monthly: ["Monat", "Monate"], yearly: ["Jahr", "Jahre"]
  };
  const PRESET_TEXT = { daily: "täglich", weekdays: "werktags (Mo–Fr)", weekly: "wöchentlich", monthly: "monatlich", yearly: "jährlich" };

  const pad = n => String(n).padStart(2, "0");
  const parse = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const isoDow = d => (d.getDay() + 6) % 7 + 1;                       // 1 = Mo … 7 = So
  const shortDate = iso => parse(iso).toLocaleDateString("de-DE", { day: "numeric", month: "numeric", year: "numeric" });

  // n-ter Wochentag im Monat (1–5) und ob es der letzte ist
  function nthInfo(iso) {
    const d = parse(iso);
    const n = Math.ceil(d.getDate() / 7);
    const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return { n, last: d.getDate() + 7 > dim, dow: isoDow(d), day: d.getDate() };
  }

  // ---------------------------------------------------------
  // Textbeschreibung
  // ---------------------------------------------------------
  function describe(v, startIso) {
    if (!v || v.kind === "none") return "";
    let t;
    if (v.kind !== "custom") t = PRESET_TEXT[v.kind];
    else {
      const n = Math.max(1, v.interval || 1);
      const u = UNIT[v.unit] || UNIT.daily;
      t = n === 1 ? (v.unit === "daily" ? "täglich" : v.unit === "weekly" ? "jede Woche" : v.unit === "monthly" ? "jeden Monat" : "jedes Jahr")
        : `alle ${n} ${u[1]}`;
      if (v.unit === "weekly" && v.days && v.days.length) {
        const ds = [...v.days].sort();
        t += ds.join() === "1,2,3,4,5" ? " werktags (Mo–Fr)" : " am " + ds.map(x => WD[x - 1]).join(", ");
      }
      if (v.unit === "monthly" && startIso) {
        const ni = nthInfo(startIso);
        if (v.monthMode === "nth") t += ` am ${ni.n}. ${WD_LONG[ni.dow - 1]}`;
        else if (v.monthMode === "last") t += ` am letzten ${WD_LONG[ni.dow - 1]}`;
        else t += ` am ${ni.day}.`;
      }
    }
    if (v.end === "until" && v.until) t += ` bis ${shortDate(v.until)}`;
    if (v.end === "count" && v.count) t += `, ${v.count}×`;
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // ---------------------------------------------------------
  // Kalender: RRULE bauen
  // ---------------------------------------------------------
  function toRRule(v, startIso) {
    if (!v || v.kind === "none") return "";
    let parts;
    if (v.kind === "daily") parts = ["FREQ=DAILY"];
    else if (v.kind === "weekdays") parts = ["FREQ=WEEKLY", "BYDAY=MO,TU,WE,TH,FR"];
    else if (v.kind === "weekly") parts = ["FREQ=WEEKLY"];
    else if (v.kind === "monthly") parts = ["FREQ=MONTHLY"];
    else if (v.kind === "yearly") parts = ["FREQ=YEARLY"];
    else {
      parts = ["FREQ=" + { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }[v.unit]];
      if (v.interval > 1) parts.push("INTERVAL=" + Math.min(999, v.interval));
      if (v.unit === "weekly" && v.days && v.days.length) parts.push("BYDAY=" + [...v.days].sort().map(x => RR[x - 1]).join(","));
      if (v.unit === "monthly" && startIso && v.monthMode !== "day") {
        const ni = nthInfo(startIso);
        parts.push("BYDAY=" + (v.monthMode === "last" ? "-1" : ni.n) + RR[ni.dow - 1]);
      }
    }
    if (v.end === "until" && v.until) parts.push("UNTIL=" + v.until.replace(/-/g, ""));
    if (v.end === "count" && v.count) parts.push("COUNT=" + Math.min(999, v.count));
    return parts.join(";");
  }

  // ---------------------------------------------------------
  // Aufgaben: Felder in der Datenbank
  // ---------------------------------------------------------
  function toTodo(v) {
    const out = { repeat: "none", repeat_interval: 1, repeat_days: [], repeat_until: null };
    if (!v || v.kind === "none") return out;
    if (v.kind !== "custom") out.repeat = v.kind;
    else {
      out.repeat = v.unit;
      out.repeat_interval = Math.max(1, Math.min(999, v.interval || 1));
      if (v.unit === "weekly") out.repeat_days = [...(v.days || [])].sort();
      if (out.repeat === "weekly" && out.repeat_interval === 1 && out.repeat_days.join() === "1,2,3,4,5") {
        out.repeat = "weekdays";
        out.repeat_days = [];
      }
    }
    if (v.end === "until" && v.until) out.repeat_until = v.until;
    return out;
  }

  function fromTodo(item) {
    const v = { kind: item.repeat || "none", unit: "daily", interval: 1, days: [], monthMode: "day", end: "never", until: "", count: null };
    const interval = item.repeat_interval || 1;
    const days = item.repeat_days || [];
    if (v.kind !== "none" && v.kind !== "weekdays" && (interval > 1 || (v.kind === "weekly" && days.length))) {
      v.unit = v.kind;
      v.kind = "custom";
      v.interval = interval;
      v.days = days.slice();
    }
    if (item.repeat_until) { v.end = "until"; v.until = item.repeat_until; }
    return v;
  }

  // ---------------------------------------------------------
  // Bedienfeld unter der Auswahl „Wiederholen“
  // ---------------------------------------------------------
  // opts: { select, panel, startDate: () => iso, calendar: bool }
  function mount(opts) {
    const { select, panel } = opts;
    const cal = !!opts.calendar;
    if (!select.querySelector('option[value="custom"]')) {
      const o = document.createElement("option");
      o.value = "custom";
      o.textContent = "Benutzerdefiniert …";
      select.appendChild(o);
    }
    const id = select.closest("form").id + "-rp";
    panel.classList.add("rp");
    panel.innerHTML = `
      <div class="rp-custom">
        <div class="rp-line">
          <span>Alle</span>
          <input type="text" class="rp-interval" maxlength="3" value="1" inputmode="numeric" pattern="[0-9]*" aria-label="Abstand">
          <select class="rp-unit" aria-label="Einheit">
            <option value="daily">Tage</option><option value="weekly">Wochen</option>
            <option value="monthly">Monate</option><option value="yearly">Jahre</option>
          </select>
        </div>
        <div class="rp-days chip-wrap" role="group" aria-label="Wochentage">
          ${WD.map((d, i) => `<button type="button" class="chip rp-day" data-rp-day="${i + 1}" aria-pressed="false">${d}</button>`).join("")}
        </div>
        ${cal ? `<div class="rp-month">
          <label class="rp-radio"><input type="radio" name="${id}-mm" value="day" checked><span class="rp-mday"></span></label>
          <label class="rp-radio"><input type="radio" name="${id}-mm" value="nth"><span class="rp-mnth"></span></label>
          <label class="rp-radio rp-mlast-row"><input type="radio" name="${id}-mm" value="last"><span class="rp-mlast"></span></label>
        </div>` : `<p class="muted small rp-month-hint"></p>`}
      </div>
      <div class="rp-end">
        <label>Endet
          <select class="rp-endsel">
            <option value="never">Nie</option>
            <option value="until">Am Datum</option>
            ${cal ? `<option value="count">Nach Anzahl Terminen</option>` : ""}
          </select>
        </label>
        <input type="date" class="rp-until" aria-label="Endet am" hidden>
        <input type="text" class="rp-count" maxlength="3" value="10" inputmode="numeric" pattern="[0-9]*" aria-label="Anzahl Termine" hidden>
      </div>
      <p class="rp-summary"></p>`;

    const $p = s => panel.querySelector(s);
    let state = { kind: "none", unit: "weekly", interval: 1, days: [], monthMode: "day", end: "never", until: "", count: 10 };

    function read() {
      state.kind = select.value;
      state.interval = Math.max(1, Math.min(999, parseInt($p(".rp-interval").value, 10) || 1));
      state.unit = $p(".rp-unit").value;
      const mm = panel.querySelector(`input[name="${id}-mm"]:checked`);
      state.monthMode = mm ? mm.value : "day";
      state.end = $p(".rp-endsel").value;
      state.until = $p(".rp-until").value;
      state.count = Math.max(1, Math.min(999, parseInt($p(".rp-count").value, 10) || 1));
      return state;
    }

    function paint() {
      const start = opts.startDate() || "";
      const custom = state.kind === "custom";
      panel.hidden = state.kind === "none";
      $p(".rp-custom").hidden = !custom;
      $p(".rp-days").hidden = !(custom && state.unit === "weekly");
      panel.querySelectorAll("[data-rp-day]").forEach(b => {
        const on = state.days.includes(+b.dataset.rpDay);
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on);
      });
      if (start) {
        const ni = nthInfo(start);
        if (cal) {
          $p(".rp-month").hidden = !(custom && state.unit === "monthly");
          $p(".rp-mday").textContent = `Am ${ni.day}. jedes Monats`;
          $p(".rp-mnth").textContent = `Am ${ni.n}. ${WD_LONG[ni.dow - 1]}`;
          $p(".rp-mlast").textContent = `Am letzten ${WD_LONG[ni.dow - 1]}`;
          $p(".rp-mlast-row").hidden = !ni.last;
          if (!ni.last && state.monthMode === "last") { panel.querySelector(`input[name="${id}-mm"][value="day"]`).checked = true; state.monthMode = "day"; }
        } else {
          $p(".rp-month-hint").hidden = !(custom && state.unit === "monthly");
          $p(".rp-month-hint").textContent = `Immer am ${ni.day}. des Monats (wie das Fälligkeitsdatum).`;
        }
      }
      $p(".rp-until").hidden = state.end !== "until";
      $p(".rp-count").hidden = state.end !== "count";
      if (state.end === "until" && !state.until && start) {
        const d = parse(start); d.setMonth(d.getMonth() + 3);
        $p(".rp-until").value = state.until = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
      let text = describe(state, start);
      if (custom && state.unit === "weekly" && state.days.length && start && !state.days.includes(isoDow(parse(start)))) {
        text += ` – beginnt am ${firstMatching(start, state.days)}`;
      }
      $p(".rp-summary").textContent = text ? "🔁 " + text : "";
    }

    function firstMatching(start, days) {
      const d = parse(start);
      for (let i = 0; i < 7 && !days.includes(isoDow(d)); i++) d.setDate(d.getDate() + 1);
      return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
    }

    select.addEventListener("change", () => {
      read();
      if (state.kind === "custom" && !state.days.length && opts.startDate()) state.days = [isoDow(parse(opts.startDate()))];
      paint();
      if (opts.onChange) opts.onChange();
    });
    panel.addEventListener("input", () => { read(); paint(); if (opts.onChange) opts.onChange(); });
    panel.addEventListener("change", () => { read(); paint(); if (opts.onChange) opts.onChange(); });
    panel.addEventListener("click", e => {
      const b = e.target.closest("[data-rp-day]");
      if (!b) return;
      const d = +b.dataset.rpDay;
      state.days = state.days.includes(d) ? state.days.filter(x => x !== d) : [...state.days, d];
      if (!state.days.length) state.days = [d];         // mindestens ein Tag
      paint();
      if (opts.onChange) opts.onChange();
    });

    return {
      set(v) {
        state = { kind: "none", unit: "weekly", interval: 1, days: [], monthMode: "day", end: "never", until: "", count: 10, ...(v || {}) };
        select.value = state.kind;
        $p(".rp-interval").value = state.interval;
        $p(".rp-unit").value = state.unit;
        const mm = panel.querySelector(`input[name="${id}-mm"][value="${state.monthMode}"]`);
        if (mm) mm.checked = true;
        $p(".rp-endsel").value = state.end;
        $p(".rp-until").value = state.until || "";
        $p(".rp-count").value = state.count || 10;
        paint();
      },
      get() { read(); return { ...state, days: state.days.slice() }; },
      refresh() { read(); paint(); },
      validate() {
        read();
        const start = opts.startDate();
        if (state.kind !== "none" && state.end === "until" && state.until && start && state.until < start) {
          throw new Error("Das Ende der Wiederholung liegt vor dem ersten Termin.");
        }
      }
    };
  }

  PP.repeat = { mount, describe, toRRule, toTodo, fromTodo, nthInfo };
})();
