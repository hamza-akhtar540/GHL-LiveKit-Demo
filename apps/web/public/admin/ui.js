"use strict";

/**
 * Shared UI primitives for the admin console.
 *
 * Six pages need the same modal, the same dirty-field form, the same
 * confirm-before-destroying dialog and the same request helpers. Every one of
 * these exists because doing it ad-hoc per page had a specific failure mode, and
 * the comments say which.
 *
 * Nothing here talks about a particular domain — no bookings, no contacts. Those
 * live in pages.js.
 */

// ------------------------------------------------------------------ escaping --

/** Escape for HTML text and attribute values. Every interpolation goes through this. */
export function h(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------------- format --

/**
 * Relative time, for the past.
 *
 * Explicitly handles the future, because it used to not: a post scheduled for
 * tomorrow produced a negative diff, fell through every branch and rendered as
 * "just now" — which is exactly wrong for the one thing the operator needs to
 * know about a scheduled post.
 */
export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);

  if (diffMin < 0) {
    const ahead = -diffMin;
    if (ahead < 60) return `in ${ahead}m`;
    if (ahead < 24 * 60) return `in ${Math.round(ahead / 60)}h`;
    return "on " + d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return diffMin + "m ago";
  if (diffMin < 24 * 60) return Math.round(diffMin / 60) + "h ago";
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * A wall-clock time in a NAMED timezone.
 *
 * Use this for anything the customer was told — an appointment, a scheduled post.
 * `fmtDateTime` renders in whatever timezone the operator's browser happens to
 * be in, which silently misreports every booking to anyone not sitting in the
 * business's own zone. Naming the zone in the output is part of the point: a bare
 * time with no zone is unactionable when the two differ.
 */
export function fmtInZone(iso, timeZone) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  if (!timeZone) return fmtDateTime(iso);
  const when = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  return `${when} (${timeZone.split("/").pop().replace(/_/g, " ")})`;
}

export function badge(text) {
  const cls = String(text ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return `<span class="badge ${h(cls)}">${h(text ?? "—")}</span>`;
}

// -------------------------------------------------------------------- toast --

export function toast(msg, kind) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (kind === "bad" ? " bad" : "");
  t.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.style.display = "none";
  }, kind === "bad" ? 7000 : 4000);
}

// ------------------------------------------------------------------ request --

/** An error that carries the HTTP status and the server's `detail`. */
export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * GET from the admin API.
 *
 * Throws ApiError carrying `status` and `detail`. It used to collapse everything
 * into `Error("HTTP " + status)`, which threw away the `detail` field that is the
 * only thing explaining a failed GHL write, and reported a 403 from the CSRF
 * guard as the uselessly opaque "HTTP 403".
 */
export async function api(path, opts) {
  const res = await fetch("/admin/api/" + path, opts);
  if (res.status === 401) {
    location.href = "/admin";
    throw new ApiError("not authenticated", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data.detail);
  }
  return data;
}

/**
 * POST to the admin API.
 *
 * Always sets `content-type: application/json`, which is REQUIRED — the server
 * rejects writes without it, deliberately, because a cross-site HTML form cannot
 * set that header and so cannot forge a write. Every write goes through here
 * rather than a hand-rolled fetch, so no call site can forget either the header
 * or the JSON.stringify.
 */
export function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// --------------------------------------------------------- nav generation --

/**
 * Guards against a stale render painting over a fresh page.
 *
 * Renderers `await` a request and then assign innerHTML. Pages that read live
 * from GoHighLevel routinely take seconds, so navigating away mid-fetch used to
 * let the abandoned page's response overwrite the new one. Every renderer
 * captures the generation at entry and mounts through `mount`, which no-ops if
 * the generation has moved on.
 */
let generation = 0;

export function newGeneration() {
  return ++generation;
}

export function isCurrent(gen) {
  return gen === generation;
}

/** Assign innerHTML only if `gen` is still the current navigation. */
export function mount(el, html, gen) {
  if (gen !== undefined && !isCurrent(gen)) return false;
  el.innerHTML = html;
  return true;
}

// ------------------------------------------------------------------ polling --

/**
 * Every interval the page starts, so navigation can clear ALL of them.
 *
 * This was a single variable, which meant the first page to start two intervals
 * orphaned one forever — and Contact 360 (aggregate cards plus a live transcript)
 * is exactly such a page.
 */
const timers = new Set();

export function stopPolling() {
  for (const t of timers) clearInterval(t);
  timers.clear();
}

/**
 * Poll `fn` every `ms`, until navigation moves on or `fn` returns "stop".
 *
 * Skips a tick entirely while the operator is busy — see `isBusy`. A refresh that
 * fires mid-typing destroys the input, and a management console is mostly typing.
 */
export function poll(fn, ms, gen) {
  const id = setInterval(async () => {
    if (!isCurrent(gen)) {
      clearInterval(id);
      timers.delete(id);
      return;
    }
    if (isBusy()) return;
    try {
      if ((await fn()) === "stop") {
        clearInterval(id);
        timers.delete(id);
      }
    } catch {
      /* a transient failure shouldn't kill the loop */
    }
  }, ms);
  timers.add(id);
  return id;
}

/**
 * Is the operator mid-interaction, such that a re-render would lose their work?
 *
 * True when a dialog is open, or when focus is in any text input. Both cases end
 * with someone's half-typed reply or edit vanishing, which is worse than data
 * being a few seconds stale.
 */
export function isBusy() {
  if (document.querySelector("dialog[open]")) return true;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !["button", "submit", "checkbox", "radio"].includes(el.type);
}

// -------------------------------------------------------------------- table --

/**
 * Column headers are NOT escaped, because sortable columns pass an anchor.
 * Every header in this app is a developer-authored literal, never user data —
 * if that ever stops being true, escape at the call site.
 */
export function table(columns, rows, renderRow, opts) {
  if (!rows || !rows.length) return `<div class="empty">${h((opts && opts.empty) || "Nothing here yet.")}</div>`;
  return `<table>
    <thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(renderRow).join("")}</tbody>
  </table>`;
}

export function stat(n, label, opts) {
  const o = opts || {};
  return `<div class="stat${o.attention && n ? " attention" : ""}">
    <div class="n">${n === undefined || n === null ? "—" : h(n)}</div>
    <div class="l">${h(label)}</div>
    ${o.sub ? `<div class="sub">${h(o.sub)}</div>` : ""}
  </div>`;
}

/** A button that exists but cannot work, with the reason attached rather than hidden. */
export function disabledBtn(label, why) {
  return `<button class="btn sm" disabled data-why="${h(why)}" title="${h(why)}">${h(label)}</button>`;
}

// ------------------------------------------------------------------- dialog --

/**
 * Open a modal. Resolves to whatever `onSubmit` returns, or null if dismissed.
 *
 * `render` returns the body HTML; `onSubmit(root)` reads it back. The dialog
 * element is reused from the page shell and lives outside <main>, so a poll tick
 * cannot destroy an open form.
 */
export function modal({ title, body, submitLabel = "Save", danger = false, warning, onSubmit }) {
  const dlg = document.getElementById("dlg");
  return new Promise((resolve) => {
    dlg.innerHTML = `
      <form method="dialog" id="dlgForm">
        <div class="head">${h(title)}</div>
        <div class="body">
          ${warning ? `<div class="warning">${h(warning)}</div>` : ""}
          <div class="form-error" id="dlgError" style="display:none"></div>
          ${body}
        </div>
        <div class="foot">
          <button type="button" class="btn" id="dlgCancel">Cancel</button>
          <button type="submit" class="btn ${danger ? "danger" : "primary"}" id="dlgOk">${h(submitLabel)}</button>
        </div>
      </form>
    `;

    const form = dlg.querySelector("#dlgForm");
    const err = dlg.querySelector("#dlgError");
    const ok = dlg.querySelector("#dlgOk");
    let settled = false;

    const close = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.innerHTML = "";
      resolve(value);
    };

    dlg.querySelector("#dlgCancel").addEventListener("click", () => close(null));
    // Esc fires 'cancel' on <dialog>.
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    }, { once: true });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.style.display = "none";
      ok.disabled = true;
      const label = ok.textContent;
      ok.textContent = "Working…";
      try {
        const result = await onSubmit(dlg);
        // onSubmit returning false means "not valid, stay open".
        if (result === false) {
          ok.disabled = false;
          ok.textContent = label;
          return;
        }
        close(result ?? true);
      } catch (e2) {
        err.textContent = e2.detail ? `${e2.message} — ${e2.detail}` : e2.message;
        err.style.display = "block";
        ok.disabled = false;
        ok.textContent = label;
      }
    });

    dlg.showModal();
    const first = dlg.querySelector("input, textarea, select");
    if (first) first.focus();
  });
}

/**
 * Confirm something irreversible.
 *
 * `typed` requires the operator to type a specific word first — reserved for
 * writes that reach real customers and cannot be recalled, where a misplaced
 * click is not an acceptable trigger.
 */
export function confirmDanger({ title, warning, confirmLabel = "Yes, do it", typed }) {
  return modal({
    title,
    warning,
    danger: true,
    submitLabel: confirmLabel,
    body: typed
      ? `<div class="field">
           <label>Type <strong>${h(typed)}</strong> to confirm</label>
           <input id="typedConfirm" autocomplete="off" />
         </div>`
      : `<p class="muted" style="margin:0">This cannot be undone from here.</p>`,
    onSubmit: (dlg) => {
      if (typed) {
        const v = dlg.querySelector("#typedConfirm").value.trim();
        if (v !== typed) throw new Error(`Type "${typed}" exactly to confirm.`);
      }
      return true;
    },
  });
}

// --------------------------------------------------------------------- form --

/**
 * Build a form and read back ONLY the fields the operator actually changed.
 *
 * The dirty-diff is not a nicety, it is the defence against silent data loss.
 * GHL's contact and opportunity updates are partial: an omitted key is
 * preserved, but a key sent as `""` is a deliberate erasure. So a form that
 * submits everything it rendered turns every untouched-but-empty input into a
 * wipe of that field. Only changed keys are ever transmitted.
 *
 * `fields`: [{ name, label, value, type, options, hint, required, maxLength }]
 */
export function form(fields) {
  const initial = new Map(fields.map((f) => [f.name, f.value ?? ""]));

  const html = fields
    .map((f) => {
      const id = `f_${f.name}`;
      const v = f.value ?? "";
      let input;
      if (f.type === "select") {
        input = `<select id="${id}" data-name="${h(f.name)}">${(f.options || [])
          .map((o) => `<option value="${h(o.value)}"${String(o.value) === String(v) ? " selected" : ""}>${h(o.label)}</option>`)
          .join("")}</select>`;
      } else if (f.type === "textarea") {
        input = `<textarea id="${id}" data-name="${h(f.name)}"${f.maxLength ? ` maxlength="${f.maxLength}"` : ""}>${h(v)}</textarea>`;
      } else {
        input = `<input id="${id}" data-name="${h(f.name)}" type="${h(f.type || "text")}" value="${h(v)}"${
          f.maxLength ? ` maxlength="${f.maxLength}"` : ""
        } autocomplete="off" />`;
      }
      return `<div class="field" data-field="${h(f.name)}">
        <label for="${id}">${h(f.label)}${f.required ? " *" : ""}</label>
        ${input}
        ${f.hint ? `<div class="hint">${h(f.hint)}</div>` : ""}
      </div>`;
    })
    .join("");

  return {
    html,

    /** Mark edited fields, so it's visible what will actually be sent. */
    watch(root) {
      root.querySelectorAll("[data-name]").forEach((el) => {
        el.addEventListener("input", () => {
          const changed = String(el.value) !== String(initial.get(el.dataset.name) ?? "");
          el.closest(".field").classList.toggle("changed", changed);
        });
      });
    },

    /** Only what changed. Empty object means "nothing to send". */
    dirty(root) {
      const out = {};
      root.querySelectorAll("[data-name]").forEach((el) => {
        const name = el.dataset.name;
        const before = String(initial.get(name) ?? "");
        const now = String(el.value);
        if (now !== before) out[name] = now;
      });
      return out;
    },

    /** Throws on the first missing required field. */
    validate(root) {
      for (const f of fields) {
        if (!f.required) continue;
        const el = root.querySelector(`[data-name="${f.name}"]`);
        if (el && !String(el.value).trim()) throw new Error(`${f.label} is required.`);
      }
      return true;
    },
  };
}

// ------------------------------------------------------------------- action --

/**
 * Run a write with the button disabled for its duration, then refresh.
 *
 * Disabling for the whole round-trip is the only thing standing between a
 * double-click and two real side effects — none of GHL's write endpoints offer
 * an idempotency key, so a second click genuinely sends a second message or
 * creates a second appointment.
 *
 * Previously a closure declared inside the social page, so no other page could
 * call it. Now takes the refresh explicitly.
 */
export async function runAction({ button, label, busyLabel, run, success, refresh }) {
  const siblings = button ? [...button.parentElement.querySelectorAll("button")] : [];
  siblings.forEach((b) => (b.disabled = true));
  const original = button ? button.textContent : "";
  if (button && busyLabel) button.textContent = busyLabel;

  try {
    const result = await run();
    toast(typeof success === "function" ? success(result) : success);
    if (refresh) await refresh();
    return result;
  } catch (err) {
    toast(`${label} failed: ${err.message}${err.detail ? `\n${err.detail}` : ""}`, "bad");
    siblings.forEach((b) => (b.disabled = false));
    if (button) button.textContent = original;
    return undefined;
  }
}

/**
 * Wire click handlers by `data-action`, delegated from a container.
 *
 * Deliberately not inline `onclick="…"`: building a handler out of data means
 * any apostrophe or angle bracket in a customer's name becomes executable, and
 * GHL data is attacker-influencable — a public lead form can put markup in a
 * name and it flows straight into these tables. Also, module scripts have module
 * scope, so inline handlers cannot see these functions at all.
 */
export function onActions(root, handlers) {
  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn(el.dataset, el);
  });
}
