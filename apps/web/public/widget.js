/**
 * Embeddable intake widget.
 *
 *   <script src="http://localhost:3000/widget.js"
 *           data-name="The Fairmount" data-initials="TF"
 *           data-phone="(512) 555-0188"
 *           data-nudge="Looking for a room or a table?"></script>
 *
 * Self-contained: injects its own styles and DOM, loads the LiveKit browser SDK
 * on demand, and derives the API base from its own <script src> so dropping it
 * onto a WordPress site is one line.
 *
 * Branding comes from data attributes, not the source — same rule as the
 * industry configs. A second vertical is a script tag, not a fork.
 *
 * The thing worth protecting here: chat and voice run over ONE LiveKit session.
 * "Talk to us" turns the microphone on mid-conversation — it does not start a
 * new call — so the agent keeps everything the visitor already told it. A
 * competitor's widget restarts qualification at that moment.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var d = (script && script.dataset) || {};
  var API = d.api || new URL(script.src).origin;
  var SDK = API + "/vendor/livekit-client.umd.js";

  var NAME = d.name || "The Fairmount";
  var INITIALS = d.initials || NAME.replace(/^The\s+/i, "").slice(0, 2).toUpperCase();
  var PHONE = d.phone || "(512) 555-0188";
  var NUDGE = d.nudge || "Questions about your stay?";
  var ACCENT = d.accent || "#b07d3f";

  /**
   * One reply arrives as several text streams; group them into one bubble
   * unless the speaker has gone quiet. Kept tight deliberately — the agent
   * sends transcripts unsynced from speech, so the fragments of a single reply
   * land within milliseconds of each other. A wide window here silently welds
   * two consecutive replies into one bubble.
   */
  var SETTLE_MS = 900;

  var css = `
.sp-w, .sp-w * { box-sizing: border-box; }
.sp-w {
  --ink: #14202e; --muted: #5c6b7a; --line: #e3e8ed;
  --accent: ${ACCENT}; --accent-ink: #fff; --bg: #fff;
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ink);
}
.sp-bubble {
  width: 60px; height: 60px; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--accent); color: var(--accent-ink);
  box-shadow: 0 6px 24px rgba(20,32,46,.28); display: grid; place-items: center;
  transition: transform .18s ease, box-shadow .18s ease;
}
.sp-bubble:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(20,32,46,.34); }
.sp-bubble svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 2; }
.sp-nudge {
  position: absolute; right: 74px; bottom: 12px; white-space: nowrap;
  background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
  padding: 9px 13px; font-size: 14px; box-shadow: 0 4px 16px rgba(20,32,46,.12);
  animation: sp-in .3s ease both;
}
.sp-panel {
  position: absolute; right: 0; bottom: 0; width: 380px; max-width: calc(100vw - 32px);
  height: 560px; max-height: calc(100vh - 40px);
  background: var(--bg); border-radius: 16px; overflow: hidden;
  box-shadow: 0 20px 60px rgba(20,32,46,.3); display: flex; flex-direction: column;
  animation: sp-in .22s ease both;
}
@keyframes sp-in { from { opacity: 0; transform: translateY(10px); } }
.sp-head {
  background: var(--ink); color: #fff; padding: 14px 16px;
  display: flex; align-items: center; gap: 11px; flex: none;
}
.sp-avatar {
  width: 36px; height: 36px; border-radius: 50%; background: var(--accent);
  display: grid; place-items: center; font-weight: 700; font-size: 14px; flex: none;
}
.sp-title { font-weight: 650; font-size: 15px; }
.sp-status { font-size: 12.5px; opacity: .72; display: flex; align-items: center; gap: 6px; }
.sp-dot { width: 7px; height: 7px; border-radius: 50%; background: #7d8894; flex: none; }
.sp-dot.on { background: #46c07a; }
.sp-dot.live { background: #ff5c5c; animation: sp-pulse 1.4s infinite; }
@keyframes sp-pulse { 50% { opacity: .35; } }
.sp-x {
  margin-left: auto; background: none; border: 0; color: #fff; opacity: .65;
  cursor: pointer; font-size: 22px; line-height: 1; padding: 4px 6px;
}
.sp-x:hover { opacity: 1; }
.sp-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.sp-msg { max-width: 84%; padding: 10px 13px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
.sp-msg.agent { background: #f1f4f7; border-bottom-left-radius: 5px; align-self: flex-start; }
.sp-msg.you { background: var(--ink); color: #fff; border-bottom-right-radius: 5px; align-self: flex-end; }
.sp-msg.sys { align-self: center; background: none; color: var(--muted); font-size: 13px; text-align: center; padding: 2px 0; }
.sp-typing { align-self: flex-start; display: flex; gap: 4px; padding: 13px; }
.sp-typing i { width: 7px; height: 7px; border-radius: 50%; background: #b6c0ca; animation: sp-bounce 1.2s infinite; }
.sp-typing i:nth-child(2) { animation-delay: .15s; } .sp-typing i:nth-child(3) { animation-delay: .3s; }
@keyframes sp-bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }
.sp-foot { border-top: 1px solid var(--line); padding: 10px 12px; flex: none; }
.sp-row { display: flex; gap: 8px; align-items: flex-end; }
.sp-in {
  flex: 1; border: 1px solid var(--line); border-radius: 11px; padding: 10px 12px;
  font: inherit; resize: none; max-height: 96px; outline: none; color: inherit; background: var(--bg);
}
.sp-in:focus { border-color: var(--accent); }
.sp-btn {
  border: 0; border-radius: 11px; cursor: pointer; padding: 0 14px; height: 41px;
  background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 600; flex: none;
}
.sp-btn:disabled { opacity: .45; cursor: default; }
.sp-mic {
  background: none; border: 1px solid var(--line); color: var(--muted);
  width: 41px; padding: 0; display: grid; place-items: center;
}
.sp-mic svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; }
.sp-mic.on { background: color-mix(in oklab, var(--accent) 12%, #fff); border-color: var(--accent); color: var(--accent); }
.sp-voice {
  width: 100%; margin-bottom: 9px; height: 40px; border-radius: 11px; cursor: pointer;
  border: 1px solid var(--line); background: none; color: var(--ink);
  font: inherit; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px;
}
.sp-voice:hover { border-color: var(--accent); color: var(--accent); }
.sp-voice svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2; }

.sp-form {
  position: absolute; inset: 0; z-index: 5; background: rgba(20,32,46,.55);
  display: flex; align-items: flex-end; animation: sp-fade .18s ease both;
}
@keyframes sp-fade { from { opacity: 0; } }
.sp-card {
  width: 100%; background: var(--bg); border-radius: 16px 16px 0 0; padding: 18px 18px 16px;
  max-height: 100%; overflow-y: auto; animation: sp-up .22s ease both;
}
@keyframes sp-up { from { transform: translateY(24px); opacity: .6; } }
.sp-card h3 { margin: 0 0 3px; font-size: 17px; }
.sp-card .sp-sub { margin: 0 0 14px; color: var(--muted); font-size: 13.5px; }
.sp-field { margin-bottom: 11px; }
.sp-field label { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 4px; color: var(--muted); }
.sp-field input {
  width: 100%; border: 1.5px solid var(--line); border-radius: 10px; padding: 10px 12px;
  font: inherit; color: inherit; background: var(--bg); outline: none;
}
.sp-field input:focus { border-color: var(--accent); }
.sp-field.bad input { border-color: #d64545; }
.sp-field.ok input { border-color: #46a373; }
.sp-err { color: #d64545; font-size: 12.5px; min-height: 0; margin-top: 3px; }
.sp-actions { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
.sp-actions .sp-btn { flex: 1; }
.sp-link { background: none; border: 0; color: var(--muted); cursor: pointer; font: inherit; padding: 8px 10px; }
.sp-link:hover { color: var(--ink); }
.sp-review { margin: 0 0 4px; border: 1.5px solid var(--line); border-radius: 12px; padding: 4px 14px; }
.sp-review dt { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-top: 9px; }
.sp-review dd { margin: 1px 0 9px; font-size: 14.5px; word-break: break-word; }
.sp-note { font-size: 12px; color: var(--muted); margin-top: 8px; }
.sp-hide { display: none !important; }
@media (max-width: 460px) {
  .sp-w { right: 12px; bottom: 12px; }
  .sp-panel { width: calc(100vw - 24px); height: calc(100vh - 24px); }
  .sp-nudge { display: none; }
}`;

  var ICON_CHAT =
    '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>';
  var ICON_MIC =
    '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>';

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function loadSdk() {
    return new Promise(function (res, rej) {
      if (window.LivekitClient) return res(window.LivekitClient);
      var s = document.createElement("script");
      s.src = SDK;
      s.onload = function () { res(window.LivekitClient); };
      s.onerror = function () { rej(new Error("Could not load the LiveKit SDK from " + SDK)); };
      document.head.appendChild(s);
    });
  }

  // ---- build DOM ------------------------------------------------------------
  var style = el("style");
  style.textContent = css;
  document.head.appendChild(style);

  var root = el("div", "sp-w");
  var bubble = el("button", "sp-bubble", ICON_CHAT);
  bubble.setAttribute("aria-label", "Chat with us");
  var nudge = el("div", "sp-nudge", NUDGE);

  var panel = el("div", "sp-panel sp-hide");
  var dot = el("span", "sp-dot");
  var statusText = el("span", null, "Usually replies instantly");
  var status = el("div", "sp-status");
  status.append(dot, statusText);

  var head = el("div", "sp-head");
  var headText = el("div");
  headText.append(el("div", "sp-title", NAME), status);
  var close = el("button", "sp-x", "&times;");
  close.setAttribute("aria-label", "Close");
  head.append(el("div", "sp-avatar", INITIALS), headText, close);

  var log = el("div", "sp-log");
  var voiceBtn = el("button", "sp-voice", ICON_MIC + "<span>Talk to us instead</span>");
  var input = el("textarea", "sp-in");
  input.rows = 1;
  input.placeholder = d.placeholder || "Ask us anything…";
  var send = el("button", "sp-btn", "Send");
  var mic = el("button", "sp-btn sp-mic", ICON_MIC);
  mic.classList.add("sp-hide");
  mic.setAttribute("aria-label", "Mute microphone");

  var row = el("div", "sp-row");
  row.append(input, mic, send);
  var foot = el("div", "sp-foot");
  foot.append(voiceBtn, row);

  panel.append(head, log, foot);
  root.append(nudge, bubble, panel);
  document.body.appendChild(root);

  // ---- state ----------------------------------------------------------------
  var room = null;
  var me = null;
  var connecting = false;
  var voiceOn = false;
  var typingEl = null;
  var active = null; // { who, textEl, at }

  function setStatus(text, kind) {
    statusText.textContent = text;
    dot.className = "sp-dot" + (kind ? " " + kind : "");
  }

  function scroll() { log.scrollTop = log.scrollHeight; }

  function say(who, text) {
    var m = el("div", "sp-msg " + who);
    m.textContent = text;
    log.appendChild(m);
    scroll();
    return m;
  }

  function showTyping(on) {
    if (on && !typingEl) {
      typingEl = el("div", "sp-typing", "<i></i><i></i><i></i>");
      log.appendChild(typingEl);
      scroll();
    } else if (!on && typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  /**
   * Render a transcript segment, replacing whatever that segment showed before.
   *
   * Speech-to-text emits a growing series of guesses for one utterance — "I
   * will", then "I will be arriving at twenty", then the final sentence — each
   * delivered as its own stream but sharing an `lk.segment_id`. They supersede
   * each other. Appending them is what produced the stuttering, duplicated
   * text; keyed replacement is what they're designed for.
   */
  var segments = Object.create(null);

  function renderSegment(who, segId, text) {
    var seg = segments[segId];
    if (!seg) {
      var m = el("div", "sp-msg " + who);
      var span = el("span");
      m.appendChild(span);
      log.appendChild(m);
      seg = segments[segId] = span;
    }
    seg.textContent = text;
    scroll();
  }

  /** Append streamed text, grouping fragments of one utterance into a bubble. */
  function stream(who, chunk) {
    showTyping(false);
    var now = Date.now();
    if (!active || active.who !== who || now - active.at > SETTLE_MS) {
      var m = el("div", "sp-msg " + who);
      var span = el("span");
      m.appendChild(span);
      log.appendChild(m);
      active = { who: who, textEl: span, at: now };
    }
    active.textEl.textContent += chunk;
    active.at = now;
    scroll();
  }


  // ---- contact-details form -------------------------------------------------
  //
  // The agent calls the `collectContact` RPC when it needs a name, email or phone
  // number. A name, an email address and a phone number are what speech
  // recognition and hurried typing both get wrong, and a wrong one means a
  // confirmation that goes nowhere and a lead nobody can reach. A field the
  // guest typed and checked themselves cannot be misheard.
  //
  // These rules mirror `contact-form.ts` on the server, which re-checks
  // everything — this copy is only here for instant feedback.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function cleanPhone(v) {
    var p = String(v || "").trim().replace(/[\s().-]/g, "");
    return p.indexOf("00") === 0 ? "+" + p.slice(2) : p;
  }

  var RULES = {
    full_name: {
      label: "Full name", type: "text", auto: "name", ph: "As it should appear on the booking",
      check: function (v) {
        var n = v.trim().replace(/\s+/g, " ");
        return n.length >= 2 && n.length <= 80 && /\p{L}/u.test(n) ? "" : "Enter your full name";
      },
    },
    email: {
      label: "Email", type: "email", auto: "email", ph: "name@example.com",
      check: function (v) { return EMAIL_RE.test(v.trim()) ? "" : "Enter a valid email address"; },
    },
    phone: {
      label: "Phone", type: "tel", auto: "tel", ph: "+44 7700 900123",
      check: function (v) { return /^\+?\d{8,15}$/.test(cleanPhone(v)) ? "" : "Enter a phone number, with country code"; },
    },
  };

  var formEl = null;
  var formResolve = null;

  function closeForm(result) {
    if (formEl) { formEl.remove(); formEl = null; }
    if (formResolve) { var r = formResolve; formResolve = null; r(result); }
  }

  function collectContact(payload) {
    // A second request replaces the first rather than stacking two forms.
    if (formEl) closeForm({ cancelled: true });

    var need = (payload.need || []).filter(function (k) { return RULES[k]; });
    if (!need.length) need = ["full_name", "email", "phone"];

    return new Promise(function (resolve) {
      formResolve = resolve;
      var overlay = el("div", "sp-form");
      var card = el("form", "sp-card");
      card.noValidate = true;
      card.append(el("h3", null, "Your details"));
      var sub = el("p", "sp-sub");
      sub.textContent = payload.reason || "Please check each one — this is exactly what we'll use for your confirmation.";
      card.append(sub);

      var fields = []; // { key, input, wrap, err, check() }

      function addField(key, label, rule, matchOf) {
        var wrap = el("div", "sp-field");
        var id = "sp-f-" + key + Math.random().toString(36).slice(2, 6);
        var lab = el("label"); lab.htmlFor = id; lab.textContent = label;
        var inp = el("input"); inp.id = id; inp.type = rule.type; inp.placeholder = rule.ph || "";
        inp.autocomplete = rule.auto || "off"; inp.spellcheck = false;
        if (key === "email" || key === "email2") { inp.autocapitalize = "off"; }
        var err = el("div", "sp-err");
        wrap.append(lab, inp, err);
        card.append(wrap);
        var f = { key: key, input: inp, wrap: wrap, err: err, touched: false };
        f.check = function () {
          var msg = matchOf
            ? (inp.value.trim().toLowerCase() === matchOf.input.value.trim().toLowerCase() && inp.value.trim() ? "" : "The two emails don't match")
            : rule.check(inp.value);
          return msg;
        };
        f.paint = function () {
          var msg = f.check();
          wrap.className = "sp-field" + (f.touched ? (msg ? " bad" : " ok") : "");
          err.textContent = f.touched ? msg : "";
          return !msg;
        };
        inp.addEventListener("input", function () { f.touched = f.touched || inp.value.length > 2; refresh(); });
        inp.addEventListener("blur", function () { f.touched = true; f.paint(); refresh(); });
        fields.push(f);
        return f;
      }

      var emailField = null;
      need.forEach(function (key) {
        var f = addField(key, RULES[key].label, RULES[key]);
        if (key === "email") emailField = f;
      });
      // Typing an address twice is the cheapest way to make a typo impossible.
      if (emailField) {
        addField("email2", "Confirm email", { type: "email", auto: "off", ph: "Type it once more", check: null }, emailField);
      }

      var actions = el("div", "sp-actions");
      var ok = el("button", "sp-btn", "Confirm details");
      ok.type = "submit"; ok.disabled = true;
      var skip = el("button", "sp-link", "Not now");
      skip.type = "button";
      actions.append(ok, skip);
      card.append(actions);
      card.append(el("div", "sp-note", "We only use these to confirm your booking and reply to you."));

      function refresh() {
        ok.disabled = !fields.every(function (f) { return !f.check(); });
        // The confirm box re-judges itself whenever the first email changes.
        fields.forEach(function (f) { if (f.touched) f.paint(); });
      }

      card.addEventListener("submit", function (e) {
        e.preventDefault();
        fields.forEach(function (f) { f.touched = true; });
        refresh();
        if (ok.disabled) {
          var firstBad = fields.filter(function (f) { return f.check(); })[0];
          if (firstBad) firstBad.input.focus();
          return;
        }
        var out = { ok: true };
        fields.forEach(function (f) {
          if (f.key === "email2") return;
          out[f.key] = f.key === "phone" ? cleanPhone(f.input.value) : f.input.value.trim();
        });
        say("sys", "Details confirmed ✓");
        closeForm(out);
      });
      skip.onclick = function () { closeForm({ cancelled: true }); };

      overlay.append(card);
      overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeForm({ cancelled: true }); });
      panel.append(overlay);
      formEl = overlay;
      panel.classList.remove("sp-hide");
      bubble.classList.add("sp-hide");
      fields[0].input.focus();
    });
  }

  // ---- booking review -------------------------------------------------------
  //
  // Shown by the agent just before it books. The guest sees the whole booking in
  // one place — what, when, and who it is for — and nothing is reserved until
  // they press Confirm. "Change something" sends them back to the conversation.
  function reviewBooking(payload) {
    if (formEl) closeForm({ cancelled: true });
    return new Promise(function (resolve) {
      formResolve = resolve;
      var overlay = el("div", "sp-form");
      var card = el("div", "sp-card");
      card.append(el("h3", null, "Review your booking"));
      var sub = el("p", "sp-sub");
      sub.textContent = "Nothing is reserved until you confirm.";
      card.append(sub);

      var list = el("dl", "sp-review");
      (payload.rows || []).forEach(function (r) {
        if (!r || !r.value) return;
        var dt = el("dt"); dt.textContent = r.label;
        var dd = el("dd"); dd.textContent = r.value;
        list.append(dt, dd);
      });
      card.append(list);

      var actions = el("div", "sp-actions");
      var ok = el("button", "sp-btn", "Confirm booking");
      ok.type = "button";
      var change = el("button", "sp-link", "Change something");
      change.type = "button";
      actions.append(ok, change);
      card.append(actions);

      ok.onclick = function () { say("sys", "Booking confirmed ✓"); closeForm({ confirmed: true }); };
      change.onclick = function () { closeForm({ confirmed: false }); };
      overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeForm({ confirmed: false }); });

      overlay.append(card);
      panel.append(overlay);
      formEl = overlay;
      panel.classList.remove("sp-hide");
      bubble.classList.add("sp-hide");
      ok.focus();
    });
  }

  async function connect() {
    if (room || connecting) return;
    connecting = true;
    setStatus("Connecting…");

    // Tracked so a failure says which step broke. "We couldn't start the chat"
    // on its own is unactionable — for us and for whoever embeds this.
    var step = "loading the SDK";
    try {
      var LK = await loadSdk();

      step = "reaching " + API + "/api/token";
      var res = await fetch(API + "/api/token?room=web-" + Math.random().toString(36).slice(2, 9));
      if (!res.ok) throw new Error("token endpoint returned HTTP " + res.status);
      var cfg = await res.json();
      me = cfg.identity;
      step = "connecting to " + cfg.url;

      room = new LK.Room({ adaptiveStream: true, dynacast: true });

      room.on(LK.RoomEvent.TrackSubscribed, function (track) {
        if (track.kind === LK.Track.Kind.Audio) {
          var a = track.attach();
          a.autoplay = true;
          a.style.display = "none";
          document.body.appendChild(a);
        }
      });

      room.registerRpcMethod("collectContact", async function (data) {
        var payload = {};
        try { payload = JSON.parse(data.payload || "{}"); } catch (e) { /* ask for everything */ }
        return JSON.stringify(await collectContact(payload));
      });

      room.registerRpcMethod("reviewBooking", async function (data) {
        var payload = {};
        try { payload = JSON.parse(data.payload || "{}"); } catch (e) { /* show what we have */ }
        return JSON.stringify(await reviewBooking(payload));
      });

      room.on(LK.RoomEvent.Disconnected, function () {
        closeForm({ cancelled: true });
        setStatus("Disconnected");
        room = null;
        voiceOn = false;
      });

      room.registerTextStreamHandler("lk.transcription", async function (reader, info) {
        // Our own transcript only matters once the mic is live — that's speech
        // coming back as text. Typed messages are already on screen.
        var mine = info.identity === me;
        if (mine && !voiceOn) return;

        var attrs = reader.info.attributes || {};

        if (mine) {
          // Interim results supersede each other — replace by segment, never
          // append. Without a segment id fall back to a per-stream key, which
          // is still correct, just without the live in-place refinement.
          var segId = attrs["lk.segment_id"] || "seg-" + reader.info.id;
          var buf = "";
          showTyping(false);
          for await (var chunk of reader) {
            buf += chunk;
            renderSegment("you", segId, buf);
          }
          // Our turn is over, so the agent's reply starts a fresh bubble
          // rather than being appended to whatever it was last saying.
          active = null;
          if (attrs["lk.transcription_final"] === "true") showTyping(true);
          return;
        }

        // The agent's reply arrives as several segments (roughly per sentence).
        // Those genuinely are one message, so they append into one bubble.
        for await (var c of reader) stream("agent", c);
      });

      await room.connect(cfg.url, cfg.token);
      setStatus("Connected", "on");
      showTyping(true);
    } catch (err) {
      console.error("[widget] failed while " + step, err);
      setStatus("Can't connect");
      say("sys", "We couldn't start the chat. Call us on " + PHONE + " and we'll help.");
      say("sys", "(" + step + " — " + (err && err.message ? err.message : err) + ")");
      room = null;
    } finally {
      connecting = false;
    }
  }

  async function submit() {
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    say("you", text);
    active = null; // the visitor's turn ends the agent's current bubble
    if (!room) await connect();
    if (!room) return;
    showTyping(true);
    try {
      await room.localParticipant.sendText(text, { topic: "lk.chat" });
    } catch (err) {
      console.error("[summit-peak widget]", err);
      showTyping(false);
      say("sys", "That didn't send. Try again, or call " + PHONE + ".");
    }
  }

  /** The differentiator: same session, second modality, nothing re-asked. */
  async function startVoice() {
    if (!room) await connect();
    if (!room) return;
    try {
      /**
       * Ask for these explicitly rather than trusting browser defaults.
       *
       * `echoCancellation` is the one that matters. Without it, a caller on
       * laptop speakers has the agent's own voice picked up by their microphone
       * and transcribed as if they had said it — which is what produced stray
       * words like "Level" and "I prefer" in the middle of a real call, each of
       * which then interrupted the agent mid-sentence.
       *
       * Headphones sidestep the problem entirely, but a demo has to work on
       * whatever the buyer happens to be using.
       */
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      voiceOn = true;
      voiceBtn.classList.add("sp-hide");
      mic.classList.remove("sp-hide");
      mic.classList.add("on");
      input.placeholder = "Or keep typing…";
      setStatus("Voice — go ahead", "live");
      say("sys", "You're on voice now. We've still got everything from the chat.");
    } catch (err) {
      console.error("[summit-peak widget]", err);
      say("sys", "We couldn't reach your microphone. Check the browser's permission and try again.");
    }
  }

  async function toggleMic() {
    if (!room) return;
    var on = room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!on);
    mic.classList.toggle("on", !on);
    setStatus(!on ? "Voice — go ahead" : "Microphone muted", !on ? "live" : "on");
  }

  function open() {
    panel.classList.remove("sp-hide");
    bubble.classList.add("sp-hide");
    nudge.classList.add("sp-hide");
    input.focus();
    connect();
  }

  function shut() {
    panel.classList.add("sp-hide");
    bubble.classList.remove("sp-hide");
  }

  bubble.onclick = open;
  nudge.onclick = open;
  close.onclick = shut;
  send.onclick = submit;
  voiceBtn.onclick = startVoice;
  mic.onclick = toggleMic;

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 96) + "px";
  });

  setTimeout(function () { nudge.classList.add("sp-hide"); }, 9000);

  // Debug handle. Useful when this is embedded on someone else's site and the
  // only thing you can reach is the console, and it lets the transcript
  // rendering be tested without a microphone.
  window.__intakeWidget = {
    renderSegment: renderSegment,
    stream: stream,
    open: open,
    collectContact: collectContact,
    reviewBooking: reviewBooking,
    get room() { return room; },
  };
})();
