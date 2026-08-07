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

      room.on(LK.RoomEvent.Disconnected, function () {
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
    get room() { return room; },
  };
})();
