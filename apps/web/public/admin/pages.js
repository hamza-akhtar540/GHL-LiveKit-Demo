"use strict";

/**
 * One renderer per page. Each takes (main, param, gen):
 *
 *   main  — the <main> element to render into
 *   param — the sub-route segment, e.g. a conversation id from #/conversations/<id>
 *   gen   — the navigation generation, passed to `mount` so an abandoned page's
 *           slow response can never paint over the page that replaced it
 *
 * Renderers own their own polling via `poll(fn, ms, gen)`, which stops itself on
 * navigation and skips ticks while the operator is typing.
 */

import {
  api,
  badge,
  confirmDanger,
  disabledBtn,
  fmtDateTime,
  fmtInZone,
  fmtTime,
  form,
  h,
  isCurrent,
  modal,
  mount,
  onActions,
  poll,
  post,
  runAction,
  stat,
  table,
  toast,
} from "./ui.js";

const loading = (title) => `<h1>${h(title)}</h1><p class="page-sub">Loading…</p>`;

// --------------------------------------------------------------- overview --

export async function renderOverview(main, _param, gen) {
  mount(main, loading("Overview"), gen);
  const o = await api("overview");
  const q = o.queues || {};

  mount(
    main,
    `
    <h1>Overview</h1>
    <p class="page-sub">Everything the agent has done, as of ${h(fmtTime(o.generatedAt))}.</p>

    <div class="card">
      <div class="head">Needs a human</div>
      <div class="body pad">
        <div class="grid" style="margin:0">
          ${stat(q.draftsAwaitingSend, "Emails awaiting send", {
            attention: true,
            sub: q.draftsAwaitingSend ? "composed but never sent" : undefined,
          })}
          ${stat(q.handoffConversations, "Asked for a person", { attention: true })}
          ${stat(q.stuckLeads, "Leads stuck mid-way", { attention: true, sub: q.stuckLeads ? "run leads:retry" : undefined })}
          ${stat(q.bookingsNext48h, "Bookings next 48h")}
        </div>
        ${
          q.draftsAwaitingSend
            ? `<p class="muted" style="margin:4px 0 0">
                 ${h(q.draftsAwaitingSend)} follow-up email(s) have been written and are sitting unsent —
                 automatic sending is currently switched off. <a href="#/emails">Review them →</a>
               </p>`
            : ""
        }
      </div>
    </div>

    <div class="grid">
      ${stat(o.conversations, "Conversations")}
      ${stat(o.bookings, "Bookings", {
        sub: o.bookingsIncludingCancelled > o.bookings ? `${o.bookingsIncludingCancelled} incl. cancelled` : undefined,
      })}
      ${stat(o.leads, "Leads captured")}
      ${stat(o.emailsSent, "Emails sent")}
      ${stat(o.opportunities, "Opportunities (GHL)")}
      ${stat(o.contacts, "Contacts (GHL)")}
      ${stat(o.socialPosts, "Social posts", {
        sub:
          o.socialPostsIncludingFailed > o.socialPosts
            ? `${o.socialPostsIncludingFailed - o.socialPosts} failed, not in GHL`
            : undefined,
      })}
    </div>
  `,
    gen,
  );
}

// ------------------------------------------------------------------- live --

export async function renderLive(main, _param, gen) {
  mount(main, loading("Live sessions"), gen);

  const draw = async () => {
    const { rooms, error } = await api("live");
    if (!isCurrent(gen)) return "stop";

    if (error) {
      mount(
        main,
        `<h1>Live sessions</h1><p class="page-sub">${h(error)}</p>
         <div class="empty">Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET to enable this page.</div>`,
        gen,
      );
      return "stop";
    }

    mount(
      main,
      `
      <h1>Live sessions <span class="live-pulse" style="margin-left:6px;"></span></h1>
      <p class="page-sub">Active LiveKit rooms right now — refreshes every 4 seconds.</p>
      ${rooms.length ? rooms.map(roomCard).join("") : `<div class="empty">No one is talking to the agent right now.</div>`}
    `,
      gen,
    );
    return undefined;
  };

  function roomCard(r) {
    const agent = r.participants.find((p) => !p.identity.startsWith("visitor-"));
    const caller = r.participants.find((p) => p.identity.startsWith("visitor-"));
    return `<div class="card">
      <div class="head">
        <span class="mono">${h(r.name)}</span>
        <span class="badge good">${h(r.numParticipants)} connected</span>
      </div>
      <div class="body pad">
        <div class="kv">
          <dt>Started</dt><dd>${h(fmtDateTime(r.createdAt))}</dd>
          <dt>Caller</dt><dd>${caller ? `${h(caller.identity)} ${caller.hasAudio ? "🎙️ voice" : "💬 chat"}` : "—"}</dd>
          <dt>Agent</dt><dd>${agent ? h(agent.identity) : "—"}</dd>
        </div>
      </div>
    </div>`;
  }

  await draw();
  poll(draw, 4000, gen);
}

// ---------------------------------------------------------- conversations --

export async function renderConversations(main, id, gen) {
  if (id) return renderConversationDetail(main, id, gen);

  mount(main, loading("Conversations"), gen);
  const rows = await api("conversations?limit=50");

  if (
    !mount(
      main,
      `
    <h1>Conversations</h1>
    <p class="page-sub">${rows.length} most recent, across chat and voice. Click one for the full transcript.</p>
    <div class="card"><div class="body">
      ${table(
        ["When", "Channel", "Who", "Outcome", "Turns", "Last message"],
        rows,
        (r) => `<tr class="clickable" data-action="open" data-id="${h(r.id)}">
          <td>${h(fmtTime(r.updatedAt))}</td>
          <td>${badge(r.channel)}</td>
          <td>${h(r.contact?.full_name || r.contactId || "anonymous")}</td>
          <td>${r.outcome ? badge(r.outcome) : '<span class="muted">in progress</span>'}</td>
          <td>${h(r.messageCount)}</td>
          <td class="muted">${h(r.lastMessage || "—")}</td>
        </tr>`,
        { empty: "No conversations yet — talk to the agent on the demo site to see one here." },
      )}
    </div></div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    open: (d) => {
      location.hash = `#/conversations/${encodeURIComponent(d.id)}`;
    },
  });
}

async function renderConversationDetail(main, id, gen) {
  mount(main, `<p class="page-sub"><a href="#/conversations">← Conversations</a></p><div class="empty">Loading…</div>`, gen);

  const draw = async () => {
    const c = await api("conversations/" + encodeURIComponent(id));
    if (!isCurrent(gen)) return "stop";

    mount(
      main,
      `
      <p class="page-sub"><a href="#/conversations">← Conversations</a></p>
      <h1>${h(c.contact?.full_name || "Anonymous")} <span class="live-pulse" style="margin-left:6px; opacity:${c.outcome ? 0 : 1}"></span></h1>
      <p class="page-sub">
        ${h(c.channel)} · ${badge(c.outcome || "in progress")}
        ${c.bookingCode ? `· booking <span class="mono">${h(c.bookingCode)}</span>` : ""}
        ${c.contactId ? `· <a href="#/contacts/${h(c.contactId)}">open contact →</a>` : ""}
      </p>
      <div class="card">
        <div class="head">Transcript</div>
        <div class="transcript">
          ${
            c.messages.length
              ? c.messages
                  .map(
                    (m) => `
            <div class="msg ${roleClass(m.role)}">
              <div class="who">${h(m.role)} · ${h(fmtTime(m.at))}</div>
              ${h(m.text)}
            </div>`,
                  )
                  .join("")
              : '<div class="empty">No messages recorded.</div>'
          }
        </div>
      </div>
      <div class="card">
        <div class="head">Reply</div>
        <div class="body pad" id="replyBox">${replyComposer(c)}</div>
      </div>

      <div class="card"><div class="head">What we know</div><div class="body pad">
        <div class="kv">
          ${
            Object.entries(c.contact || {})
              .map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(v)}</dd>`)
              .join("") || "<dd class='muted'>Nothing collected yet.</dd>"
          }
        </div>
      </div></div>

      <div class="card">
        <div class="head">In GoHighLevel</div>
        <div class="body pad" id="ghlThread"><span class="muted">Loading…</span></div>
      </div>
    `,
      gen,
    );

    wireReply(main, c, () => draw());
    void loadThread(main, c, gen);

    // Nothing more will change once there's a final outcome, so stop hitting the
    // database.
    return c.outcome ? "stop" : undefined;
  };

  await draw();
  poll(draw, 3000, gen);
}

/**
 * The reply box.
 *
 * Deliberately NOT a "continue the chat" control, and the copy says so. Once a
 * web visitor closes the tab the LiveKit room is gone, so there is no channel
 * back to them except email or SMS — this is a cross-channel follow-up tool.
 *
 * Three states, and the disabled ones show their reason rather than being
 * hidden or, worse, enabled-but-inert.
 */
function replyComposer(c) {
  if (!c.contactId) {
    return `<p class="muted" style="margin:0">
      No reply possible — this person has no CRM contact record. GoHighLevel threads messages by contact,
      and an anonymous web visitor has no address or number we could reach them on.
    </p>`;
  }

  return `
    <p class="muted" style="margin:0 0 12px">
      This starts a new email to ${h(c.contact?.email || "this contact")} — it does not continue the live chat,
      which ended when they closed the tab.
    </p>
    <div class="field">
      <label for="replySubject">Subject</label>
      <input id="replySubject" value="Following up on your enquiry" />
    </div>
    <div class="field">
      <label for="replyBody">Message</label>
      <textarea id="replyBody" placeholder="Write your reply…"></textarea>
    </div>
    <div class="row-actions" style="justify-content:flex-start; gap:8px">
      <button class="btn primary" data-reply="email">Send email</button>
      ${disabledBtn("Send SMS", "No sending number is configured for this sub-account, so GoHighLevel would reject an SMS.")}
    </div>
    <div class="why">
      Email deliverability is unproven on this account — the sending domain is unverified, so GoHighLevel
      can report success for mail that never arrives.
    </div>
  `;
}

function wireReply(main, c, refresh) {
  const box = main.querySelector("#replyBox");
  if (!box) return;
  const btn = box.querySelector('[data-reply="email"]');
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const subject = box.querySelector("#replySubject").value.trim();
    const message = box.querySelector("#replyBody").value.trim();
    if (!message) return toast("Write a message first.", "bad");

    const ok = await confirmDanger({
      title: `Send this to ${c.contact?.full_name || "the customer"}?`,
      warning:
        "This sends a real email and cannot be recalled. The sending domain on this account is unverified, " +
        "so GoHighLevel may report success for mail that never arrives.",
      confirmLabel: "Send it",
    });
    if (!ok) return;

    await runAction({
      button: btn,
      label: "Send email",
      busyLabel: "Sending…",
      run: () =>
        post("conversations/reply", {
          conversationId: c.id,
          contactId: c.contactId,
          channel: "Email",
          subject,
          message,
        }),
      success: (r) =>
        "Sent." + (r.appended ? " Added to the transcript below." : " (Could not add it to the transcript.)"),
      refresh,
    });
  });
}

/**
 * GoHighLevel's thread, in its own panel next to ours — never merged.
 *
 * Loaded separately from the transcript so a slow or failing GHL read leaves the
 * conversation itself readable.
 */
async function loadThread(main, c, gen) {
  const el = main.querySelector("#ghlThread");
  if (!el) return;

  if (!c.contactId) {
    el.innerHTML = `<span class="muted">Nothing in GoHighLevel — this person has no contact record there.</span>`;
    return;
  }

  try {
    const t = await api(`conversations/${encodeURIComponent(c.id)}/thread?contactId=${encodeURIComponent(c.contactId)}`);
    if (!isCurrent(gen)) return;

    el.innerHTML = `
      <p class="muted" style="margin:0 0 10px">
        Emails and activity GoHighLevel has recorded for this contact. Separate from the transcript above,
        which is the live conversation and exists only here.
      </p>
      ${
        t.messages.length
          ? t.messages
              .map(
                (m) => `<div style="border-bottom:1px solid #141d34;padding:8px 0">
                  <div class="muted" style="font-size:.72rem">${h(m.type)} · ${h(m.direction)} · ${h(fmtDateTime(m.at))}</div>
                  <div style="font-size:.85rem;white-space:pre-wrap">${h(String(m.body).slice(0, 400))}</div>
                </div>`,
              )
              .join("")
          : `<span class="muted">No messages in GoHighLevel for this contact.</span>`
      }
      ${
        t.activity.length
          ? `<div class="why" style="margin-top:10px">${h(t.activity.length)} activity record(s) hidden —
             appointment and opportunity events generated by this system.</div>`
          : ""
      }
    `;
  } catch (err) {
    if (isCurrent(gen)) el.innerHTML = `<span class="why">Couldn't load the GoHighLevel thread: ${h(err.message)}</span>`;
  }
}

/**
 * Three distinct speakers, three distinct bubbles.
 *
 * An operator's own reply must not be styled as the caller's — showing your own
 * words as if the customer said them makes the transcript actively misleading,
 * which is worse than plain.
 */
function roleClass(role) {
  if (role === "agent") return "agent";
  if (role === "admin" || role === "human") return "admin";
  return "caller";
}

// ----------------------------------------------------------------- bookings --

export async function renderBookings(main, _param, gen) {
  mount(main, loading("Bookings"), gen);
  const [{ items, counts, timezone }, cal] = await Promise.all([
    api("bookings?limit=50"),
    api("calendars").catch(() => ({ calendars: [], resources: [] })),
  ]);

  const refresh = () => renderBookings(main, _param, gen);
  const bookable = cal.resources.filter((r) => cal.calendars.some((c) => c.resourceId === r.id));

  if (
    !mount(
      main,
      `
    <h1>Bookings</h1>
    <p class="page-sub">
      ${h(counts.total)} appointment(s) — GoHighLevel and our own records, merged.
      ${
        counts.ghlOnly
          ? `<strong>${h(counts.ghlOnly)}</strong> exist only in GoHighLevel (booked by a person, not the agent).`
          : ""
      }
      Times are shown in <strong>${h(timezone || "the calendar's own zone")}</strong>.
    </p>

    <div class="card">
      <div class="head">
        Appointments
        <button class="btn primary" data-action="new" ${bookable.length ? "" : 'disabled title="No resource has a calendar configured"'}>New booking</button>
      </div>
      <div class="body">
      ${table(
        ["Reference", "Who", "Resource", "When", "Status", "Source", ""],
        items,
        (r) => `<tr>
          <td class="mono">${r.code ? h(r.code) : '<span class="muted">—</span>'}</td>
          <td>
            ${
              r.contactId
                ? `<a href="#/contacts/${h(r.contactId)}">${h(r.fullName || "(unnamed)")}</a>`
                : h(r.fullName || "—")
            }
            <div class="muted">${h(r.email || r.phone || "")}</div>
          </td>
          <td>${h(r.resourceId || "—")}</td>
          <td>${h(fmtInZone(r.startTimeRaw, timezone))}</td>
          <td>
            ${badge(r.status)}
            ${r.replacedByCode ? `<div class="muted">moved → ${h(r.replacedByCode)}</div>` : ""}
            ${
              r.indexStatus && r.indexStatus !== r.status
                ? `<div class="muted">we had: ${h(r.indexStatus)}</div>`
                : ""
            }
          </td>
          <td>${sourceBadge(r.source)}</td>
          <td class="row-actions">
            ${
              r.canReschedule
                ? `<button class="btn sm" data-action="move" data-code="${h(r.code)}" data-resource="${h(r.resourceId || "")}">Move</button>`
                : ""
            }
            ${
              r.canCancel
                ? `<button class="btn sm danger" data-action="cancel" data-code="${h(r.code)}" data-who="${h(r.fullName || "this guest")}">Cancel</button>`
                : r.source === "ghl-only"
                  ? disabledBtn("Cancel", "Booked directly in GoHighLevel — we hold no reference for it, so it must be cancelled there.")
                  : ""
            }
          </td>
        </tr>`,
        { empty: "No appointments." },
      )}
      </div>
    </div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    new: () => newBookingDialog(cal, bookable, timezone, refresh),

    cancel: async (d, btn) => {
      const ok = await confirmDanger({
        title: `Cancel ${d.code}?`,
        warning: `This releases ${d.who}'s slot in GoHighLevel immediately and cannot be undone from here.`,
        confirmLabel: "Cancel the booking",
      });
      if (!ok) return;
      await runAction({
        button: btn,
        label: "Cancel",
        busyLabel: "Cancelling…",
        run: () => post("bookings/cancel", { code: d.code }),
        success: `Booking ${d.code} cancelled.`,
        refresh,
      });
    },

    move: (d) => moveBookingDialog(d.code, d.resource, timezone, refresh),
  });
}

function sourceBadge(source) {
  if (source === "ghl-only") return `<span class="badge ghlonly" title="Booked in GoHighLevel, not by the agent">GHL only</span>`;
  if (source === "index-only")
    return `<span class="badge warn" title="We have a record but GoHighLevel does not — it may have been deleted there">ours only</span>`;
  return `<span class="badge good">synced</span>`;
}

/** Slot options for a resource+date, showing how full each already is. */
async function slotOptions(resourceId, date) {
  // Distinguishes "the day is full" from "the lookup failed". They need opposite
  // responses from the operator, and rendering both as "no availability" sends
  // them hunting for a free day when the day was never the problem.
  try {
    const { slots, capacity } = await api(
      `bookings/slots?resourceId=${encodeURIComponent(resourceId)}&date=${encodeURIComponent(date)}`,
    );
    return {
      capacity,
      error: null,
      options: slots.map((s) => ({
        value: s.start,
        // Occupancy is shown because these are class calendars: GHL reports a slot
        // as free while it already holds other bookings, so "available" does not
        // mean "empty" and an operator who assumes it does will double-book.
        label:
          new Date(s.start).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) +
          (capacity > 1 ? `  —  ${s.taken}/${capacity} booked${s.full ? " (FULL)" : ""}` : s.full ? " (taken)" : ""),
      })),
    };
  } catch (err) {
    return { capacity: 1, options: [], error: err.message || "couldn't load availability" };
  }
}

/** The <option> list for a slot picker, in whichever of the three states applies. */
function slotOptionsHtml(loaded) {
  if (loaded.error) return `<option value="">— couldn't load availability: ${h(loaded.error)} —</option>`;
  if (!loaded.options.length) return `<option value="">— nothing free that day —</option>`;
  return loaded.options.map((o) => `<option value="${h(o.value)}">${h(o.label)}</option>`).join("");
}

async function newBookingDialog(cal, bookable, timezone, refresh) {
  const today = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const first = bookable[0];
  if (!first) return;

  let loaded = await slotOptions(first.id, today);

  const f = form([
    { name: "resourceId", label: "What are they booking", type: "select", value: first.id, options: bookable.map((r) => ({ value: r.id, label: r.label })) },
    { name: "date", label: "Date", type: "date", value: today },
    {
      name: "start",
      label: "Time",
      type: "select",
      value: loaded.options[0]?.value ?? "",
      options: loaded.options.length ? loaded.options : [{ value: "", label: loaded.error ? `— couldn't load availability: ${loaded.error} —` : "— nothing free that day —" }],
      hint: timezone ? `Times are in ${timezone}.` : undefined,
    },
    { name: "full_name", label: "Guest name", required: true },
    { name: "email", label: "Email", type: "email" },
    { name: "phone", label: "Phone", hint: "Include the country code, e.g. +92… or +1…" },
  ]);

  await modal({
    title: "New booking",
    body: f.html,
    submitLabel: "Book it",
    onSubmit: async (dlg) => {
      f.validate(dlg);
      const get = (n) => dlg.querySelector(`[data-name="${n}"]`).value.trim();
      if (!get("start")) throw new Error("Pick a time — there was no availability for that day.");
      if (!get("email") && !get("phone")) throw new Error("Give an email or a phone number, or nobody can be contacted about this.");

      const booking = await post("bookings/create", {
        resourceId: get("resourceId"),
        start: get("start"),
        contact: { full_name: get("full_name"), email: get("email"), phone: get("phone") },
        details: {},
      });
      toast(`Booked. The guest's reference is ${booking.booking.code}.`);
      await refresh();
      return true;
    },
  });

  // Re-fetch availability whenever the resource or date changes.
  const dlg = document.getElementById("dlg");
  const reload = async () => {
    const resourceId = dlg.querySelector('[data-name="resourceId"]')?.value;
    const date = dlg.querySelector('[data-name="date"]')?.value;
    const sel = dlg.querySelector('[data-name="start"]');
    if (!resourceId || !date || !sel) return;
    sel.innerHTML = `<option>loading…</option>`;
    loaded = await slotOptions(resourceId, date);
    sel.innerHTML = slotOptionsHtml(loaded);
  };
  dlg.querySelector('[data-name="resourceId"]')?.addEventListener("change", reload);
  dlg.querySelector('[data-name="date"]')?.addEventListener("change", reload);
}

async function moveBookingDialog(code, resourceId, timezone, refresh) {
  const date = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  let loaded = await slotOptions(resourceId, date);

  await modal({
    title: `Move booking ${code}`,
    danger: true,
    warning:
      "Moving a booking issues a NEW reference and retires the old one. Tell the guest the new code — the old one will stop working.",
    submitLabel: "Move it",
    body: form([
      { name: "date", label: "New date", type: "date", value: date },
      {
        name: "start",
        label: "New time",
        type: "select",
        value: loaded.options[0]?.value ?? "",
        options: loaded.options.length ? loaded.options : [{ value: "", label: loaded.error ? `— couldn't load availability: ${loaded.error} —` : "— nothing free that day —" }],
        hint: timezone ? `Times are in ${timezone}.` : undefined,
      },
    ]).html,
    onSubmit: async (dlg) => {
      const start = dlg.querySelector('[data-name="start"]').value;
      if (!start) throw new Error("Pick a time — there was no availability for that day.");
      const res = await post("bookings/reschedule", { code, start });
      toast(`Moved. The guest's NEW reference is ${res.booking.code} — the old code ${code} no longer works.`);
      await refresh();
      return true;
    },
  });

  const dlg = document.getElementById("dlg");
  dlg.querySelector('[data-name="date"]')?.addEventListener("change", async () => {
    const sel = dlg.querySelector('[data-name="start"]');
    sel.innerHTML = `<option>loading…</option>`;
    loaded = await slotOptions(resourceId, dlg.querySelector('[data-name="date"]').value);
    sel.innerHTML = slotOptionsHtml(loaded);
  });
}

// -------------------------------------------------------------------- leads --

export async function renderLeads(main, param, gen) {
  if (param) return renderLeadDetail(main, param, gen);

  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const offset = Number(q.get("offset") || 0);
  const status = q.get("status") || "";
  const sort = q.get("sort") || "receivedAt";
  const dir = q.get("dir") === "asc" ? "asc" : "desc";
  const LIMIT = 50;

  mount(main, loading("Leads"), gen);
  const { items, total } = await api(
    `leads?limit=${LIMIT}&offset=${offset}&sort=${encodeURIComponent(sort)}&dir=${dir}` +
      (status ? `&status=${encodeURIComponent(status)}` : ""),
  );
  const refresh = () => renderLeads(main, param, gen);

  const filters = ["", "received", "created", "merged", "duplicate", "rejected", "failed"];
  const href = (over = {}) =>
    "#/leads?" +
    new URLSearchParams({
      offset: String(over.offset ?? offset),
      sort: over.sort ?? sort,
      dir: over.dir ?? dir,
      ...((over.status ?? status) ? { status: over.status ?? status } : {}),
    }).toString();
  const pageHref = (o, st) => href({ offset: o, status: st });

  /**
   * A sortable header. Sorting is done by the SERVER, so it orders the whole
   * result set rather than only the page already loaded — reordering 50 of 200
   * rows and calling it sorted would be worse than not offering it. Clicking the
   * active column flips direction.
   */
  const sortable = (key, label) => {
    const active = sort === key;
    const next = active && dir === "desc" ? "asc" : "desc";
    return `<a href="${h(href({ sort: key, dir: next, offset: 0 }))}" style="color:inherit;text-decoration:none">
      ${h(label)}${active ? (dir === "desc" ? " ↓" : " ↑") : ""}
    </a>`;
  };

  if (
    !mount(
      main,
      `
    <h1>Leads</h1>
    <p class="page-sub">
      ${h(total)} submission(s) from every source — forms, ads, chat and voice.
      Showing ${h(offset + 1)}–${h(Math.min(offset + LIMIT, total))}.
    </p>

    <div class="card">
      <div class="head" style="flex-wrap:wrap; gap:6px">
        <div style="display:flex; gap:6px; flex-wrap:wrap">
          ${filters
            .map(
              (f) =>
                `<a class="btn sm${f === status ? " primary" : ""}" href="${h(pageHref(0, f))}">${h(f || "all")}</a>`,
            )
            .join("")}
        </div>
      </div>
      <div class="body">
      ${table(
        [sortable("receivedAt", "Received"), "Who", sortable("source", "Source"), sortable("status", "Status"), "Tags", sortable("attempts", "Seen"), ""],
        items,
        (r) => `<tr class="clickable" data-action="open" data-id="${h(r.id)}">
          <td>${h(fmtTime(r.receivedAt))}</td>
          <td>
            ${h(r.name || "—")}
            <div class="muted">${h(r.email || r.phone || "no contact details")}</div>
          </td>
          <td>${h(r.source)}</td>
          <td>
            ${badge(r.status)}
            ${r.reason ? `<div class="muted">${h(r.reason)}</div>` : ""}
            ${r.attempts ? `<div class="muted">${h(r.attempts)} attempt(s)</div>` : ""}
          </td>
          <td>${(r.tags || []).slice(0, 3).map((t) => `<span class="badge" style="margin-right:4px">${h(t)}</span>`).join("") || "—"}</td>
          <td>${r.seenCount > 1 ? `<span class="muted">${h(r.seenCount)}×</span>` : "—"}</td>
          <td class="row-actions">
            ${
              r.retryable
                ? `<button class="btn sm" data-action="retry" data-id="${h(r.id)}">Retry</button>`
                : r.status === "duplicate"
                  ? disabledBtn("Retry", "A duplicate is a correct outcome, not a failure — the original submission was already processed.")
                  : r.attempts >= 6
                    ? disabledBtn("Retry", "Retried the maximum number of times already.")
                    : ""
            }
          </td>
        </tr>`,
        { empty: status ? `No ${status} leads.` : "No leads captured yet." },
      )}
      </div>
    </div>

    <div style="display:flex; gap:8px; justify-content:space-between">
      ${offset > 0 ? `<a class="btn" href="${h(pageHref(Math.max(0, offset - LIMIT), status))}">← Newer</a>` : "<span></span>"}
      ${offset + LIMIT < total ? `<a class="btn" href="${h(pageHref(offset + LIMIT, status))}">Older →</a>` : "<span></span>"}
    </div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    open: (d) => {
      location.hash = `#/leads/${encodeURIComponent(d.id)}`;
    },
    retry: async (d, btn) => {
      const ok = await confirmDanger({
        title: "Retry this lead?",
        warning:
          "This re-runs the CRM work for the submission. Contact and tag writes resume safely, but GoHighLevel notes have no duplicate protection, so a note may be added twice.",
        confirmLabel: "Retry it",
      });
      if (!ok) return;
      await runAction({
        button: btn,
        label: "Retry",
        busyLabel: "Retrying…",
        run: () => post("leads/retry", { id: d.id }),
        success: (r) => `Reprocessed — now ${r.status}.`,
        refresh,
      });
    },
  });
}

/**
 * One submission in full.
 *
 * The raw webhook payload is the point of this page. It is kept in the database
 * precisely so a parser can be fixed and the submission replayed rather than
 * lost, and it is the first thing worth looking at when a lead did not land the
 * way it should have — but nothing in the product ever showed it.
 */
async function renderLeadDetail(main, id, gen) {
  mount(main, `<p class="page-sub"><a href="#/leads">← Leads</a></p><div class="empty">Loading…</div>`, gen);
  const l = await api(`leads/${encodeURIComponent(id)}`);
  const refresh = () => renderLeadDetail(main, id, gen);

  const step = (done, label, detail) =>
    `<div style="display:flex;gap:9px;align-items:flex-start;padding:6px 0">
       <span class="badge ${done ? "good" : "warn"}" style="min-width:64px;text-align:center">${done ? "done" : "not yet"}</span>
       <div><div>${h(label)}</div>${detail ? `<div class="muted">${h(detail)}</div>` : ""}</div>
     </div>`;

  if (
    !mount(
      main,
      `
    <p class="page-sub"><a href="#/leads">← Leads</a></p>
    <h1>${h(l.lead?.fullName || l.lead?.email || l.lead?.phone || "Lead")}</h1>
    <p class="page-sub">
      ${h(l.source)} · ${badge(l.status)}
      ${l.reason ? `· ${h(l.reason)}` : ""}
      · received ${h(fmtDateTime(l.receivedAt))}
      ${l.contactId ? `· <a href="#/contacts/${h(l.contactId)}">open contact →</a>` : ""}
    </p>

    <div class="card">
      <div class="head">
        What happened to it
        ${
          ["received", "failed"].includes(l.status) && l.attempts < 6
            ? `<button class="btn" data-action="retry">Retry</button>`
            : ""
        }
      </div>
      <div class="body pad">
        ${step(true, "Claimed", `${l.seenCount} delivery/deliveries of this exact submission`)}
        ${step(!!l.contactId, "Contact in the CRM", l.contactId || "no contact was created")}
        ${step(l.tagsSynced, "Tags written to GoHighLevel", (l.tags || []).join(", ") || "none")}
        ${step(l.noteAdded, "Note written to the contact")}
        ${step(!!l.opportunityId, "Opportunity created", l.opportunityId || "")}
        ${step(!!l.conversationId, "Conversation opened", l.conversationId || "")}
        ${step(!!l.processedAt, "Finished", l.processedAt ? fmtDateTime(l.processedAt) : "still unfinished")}
        ${l.attempts ? `<div class="why">${h(l.attempts)} processing attempt(s).${l.lockedAt ? ` Locked at ${h(fmtDateTime(l.lockedAt))}.` : ""}</div>` : ""}
      </div>
    </div>

    <div class="card">
      <div class="head">What we understood</div>
      <div class="body pad">
        <div class="kv">
          ${Object.entries(l.lead || {})
            .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
            .map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(v)}</dd>`)
            .join("")}
        </div>
        ${
          l.lead?.fields && Object.keys(l.lead.fields).length
            ? `<div style="margin-top:12px"><div class="muted" style="font-size:.78rem;margin-bottom:4px">Form answers</div>
                 <div class="kv">${Object.entries(l.lead.fields).map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(v)}</dd>`).join("")}</div></div>`
            : ""
        }
      </div>
    </div>

    <div class="card">
      <div class="head">Original payload</div>
      <div class="body pad">
        <p class="muted" style="margin:0 0 8px">
          Exactly as it arrived, kept so a parser can be corrected and this submission replayed rather than lost.
        </p>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:.78rem;max-height:340px;overflow:auto">${h(
          JSON.stringify(l.raw ?? { note: "No raw payload was stored for this submission." }, null, 2),
        )}</pre>
      </div>
    </div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    retry: async (_d, btn) => {
      const ok = await confirmDanger({
        title: "Retry this lead?",
        warning:
          "This re-runs the CRM work for the submission. Contact and tag writes resume safely, but GoHighLevel notes have no duplicate protection, so a note may be added twice.",
        confirmLabel: "Retry it",
      });
      if (!ok) return;
      await runAction({
        button: btn,
        label: "Retry",
        busyLabel: "Retrying…",
        run: () => post("leads/retry", { id }),
        success: (r) => `Reprocessed — now ${r.status}.`,
        refresh,
      });
    },
  });
}

// ------------------------------------------------------------ opportunities --

export async function renderOpportunities(main, _param, gen) {
  mount(main, loading("Opportunities"), gen);
  const [{ items, total }, { pipelines }] = await Promise.all([
    api("opportunities?limit=50"),
    api("pipelines").catch(() => ({ pipelines: [] })),
  ]);
  const refresh = () => renderOpportunities(main, _param, gen);
  const stages = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipelineId: p.id, pipelineName: p.name })));

  if (
    !mount(
      main,
      `
    <h1>Opportunities</h1>
    <p class="page-sub">
      ${h(total ?? items.length)} in the pipeline — live from GoHighLevel, not cached.
      ${pipelines.length === 1 ? `One pipeline: <strong>${h(pipelines[0].name)}</strong>.` : ""}
    </p>
    <div class="card"><div class="body">
      ${table(
        ["Name", "Stage", "Status", "Value", "Updated", ""],
        items,
        (o) => `<tr>
          <td>${h(o.name)}${o.contactId ? `<div class="muted"><a href="#/contacts/${h(o.contactId)}">contact →</a></div>` : ""}</td>
          <td>
            <select class="search" style="width:auto;padding:4px 8px" data-action="stage" data-id="${h(o.id)}" data-pipeline="${h(o.pipelineId || "")}">
              ${stages
                .map((s) => `<option value="${h(s.id)}"${s.id === o.stageId ? " selected" : ""}>${h(s.name)}</option>`)
                .join("")}
            </select>
          </td>
          <td>
            <select class="search" style="width:auto;padding:4px 8px" data-action="status" data-id="${h(o.id)}" data-current="${h(o.status)}">
              ${["open", "won", "lost", "abandoned"]
                .map((s) => `<option value="${s}"${s === o.status ? " selected" : ""}>${s}</option>`)
                .join("")}
            </select>
          </td>
          <td>${o.monetaryValue ? "$" + h(o.monetaryValue) : "—"}</td>
          <td class="muted">${h(fmtTime(o.updatedAt))}</td>
          <td class="row-actions">
            <button class="btn sm" data-action="edit" data-id="${h(o.id)}" data-name="${h(o.name)}" data-value="${h(o.monetaryValue ?? 0)}">Edit</button>
          </td>
        </tr>`,
        { empty: "No opportunities in the pipeline yet." },
      )}
    </div></div>

    <div class="why">
      Assigned user and lost-reason are read-only: GoHighLevel exposes no users endpoint on this account to
      populate the first, and its update endpoint cannot write the second. A deal also cannot be moved to a
      different contact — that field does not exist on the update API.
    </div>
  `,
      gen,
    )
  ) {
    return;
  }

  // Selects fire on change, not click, so they are wired directly.
  main.querySelectorAll('[data-action="stage"]').forEach((sel) => {
    sel.addEventListener("change", async () => {
      const stage = stages.find((s) => s.id === sel.value);
      await runAction({
        label: "Move stage",
        run: () =>
          post("opportunities/update", {
            id: sel.dataset.id,
            // pipelineId always travels with the stage — a stage-only update can
            // leave the deal pointing at another pipeline's stage.
            patch: { pipelineStageId: sel.value, pipelineId: stage?.pipelineId || sel.dataset.pipeline },
          }),
        success: `Moved to ${stage?.name ?? "the new stage"}.`,
        refresh,
      });
    });
  });

  main.querySelectorAll('[data-action="status"]').forEach((sel) => {
    const original = sel.dataset.current;
    sel.addEventListener("change", async () => {
      const next = sel.value;
      const ok = await confirmDanger({
        title: `Mark this deal ${next}?`,
        warning:
          "Changing a deal's status fires GoHighLevel's status-changed automations. Setting it back afterwards does NOT un-fire them.",
        confirmLabel: `Mark ${next}`,
      });
      if (!ok) {
        sel.value = original;
        return;
      }
      await runAction({
        label: "Change status",
        run: () => post("opportunities/update", { id: sel.dataset.id, patch: { status: next } }),
        success: `Marked ${next}.`,
        refresh,
      });
    });
  });

  onActions(main, {
    edit: async (d) => {
      const f = form([
        { name: "name", label: "Deal name", value: d.name, required: true },
        { name: "monetaryValue", label: "Value", type: "number", value: d.value, hint: "0 is a real value and will be saved as such." },
      ]);
      await modal({
        title: "Edit deal",
        body: f.html,
        submitLabel: "Save",
        onSubmit: async (dlg) => {
          const dirty = f.dirty(dlg);
          if (!Object.keys(dirty).length) throw new Error("Nothing was changed.");
          const patch = {};
          if (dirty.name !== undefined) patch.name = dirty.name;
          // Number(), so clearing to 0 genuinely sets 0 rather than being
          // dropped as falsy.
          if (dirty.monetaryValue !== undefined) patch.monetaryValue = Number(dirty.monetaryValue);
          await post("opportunities/update", { id: d.id, patch });
          toast("Deal updated.");
          await refresh();
          return true;
        },
      });
    },
  });
}

// ----------------------------------------------------------------- contacts --

export async function renderContacts(main, param, gen) {
  if (param) return renderContact360(main, param, gen);
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  const query = qs.get("q") || "";
  const startAfter = qs.get("startAfter") || "";
  const startAfterId = qs.get("startAfterId") || "";

  mount(main, loading("Contacts"), gen);
  const { items, total, nextCursor } = await api(
    `contacts?limit=50${query ? `&q=${encodeURIComponent(query)}` : ""}` +
      (startAfter ? `&startAfter=${encodeURIComponent(startAfter)}&startAfterId=${encodeURIComponent(startAfterId)}` : ""),
  );

  if (
    !mount(
      main,
      `
    <h1>Contacts</h1>
    <p class="page-sub">${h(total ?? items.length)} in the CRM — live from GoHighLevel.</p>
    <div class="card">
      <div class="head">
        <input class="search" id="contactSearch" placeholder="Search name, email, phone…" value="${h(query)}" />
      </div>
      <div class="body">
      ${table(
        ["Name", "Email", "Phone", "Tags", "Added"],
        items,
        (c) => `<tr class="clickable" data-action="open" data-id="${h(c.id)}">
          <td>${h([c.firstName, c.lastName].filter(Boolean).join(" ") || "—")}</td>
          <td class="muted">${h(c.email || "—")}</td>
          <td class="muted">${h(c.phone || "—")}</td>
          <td>${(c.tags || []).slice(0, 3).map((t) => `<span class="badge" style="margin-right:4px">${h(t)}</span>`).join("") || "—"}</td>
          <td class="muted">${h(fmtTime(c.dateAdded))}</td>
        </tr>`,
        { empty: query ? `No contacts match "${query}".` : "No contacts yet." },
      )}
      </div>
    </div>

    <div style="display:flex; gap:8px; justify-content:space-between">
      ${startAfter ? `<a class="btn" href="#/contacts${query ? `?q=${encodeURIComponent(query)}` : ""}">← Back to the start</a>` : "<span></span>"}
      ${
        nextCursor
          ? `<a class="btn" href="#/contacts?${new URLSearchParams({
              ...(query ? { q: query } : {}),
              startAfter: nextCursor.startAfter,
              startAfterId: nextCursor.startAfterId,
            }).toString()}">More →</a>`
          : "<span></span>"
      }
    </div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    open: (d) => {
      location.hash = `#/contacts/${encodeURIComponent(d.id)}`;
    },
  });

  const box = main.querySelector("#contactSearch");
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = box.value.trim();
    location.hash = v ? `#/contacts?q=${encodeURIComponent(v)}` : "#/contacts";
    // Same hash with a different query still needs a re-render.
    if (!v && !query) renderContacts(main, param, gen);
  });
}

// -------------------------------------------------------------- contact 360 --

/**
 * Everything about one person on one page.
 *
 * Fed by a single fan-out route, so a GHL hiccup blanks one card rather than the
 * whole page — each card checks `errors` for its own source and says so.
 */
async function renderContact360(main, id, gen) {
  mount(main, `<p class="page-sub"><a href="#/contacts">← Contacts</a></p><div class="empty">Loading…</div>`, gen);
  const d = await api(`contacts/${encodeURIComponent(id)}`);
  const c = d.contact;
  const refresh = () => renderContact360(main, id, gen);
  const failed = (key) => (d.errors?.[key] ? `<div class="why">Couldn't load: ${h(d.errors[key])}</div>` : "");

  const fullName = [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.name || "(unnamed contact)";

  if (
    !mount(
      main,
      `
    <p class="page-sub"><a href="#/contacts">← Contacts</a></p>
    <h1>${h(fullName)}</h1>
    <p class="page-sub">
      ${h(c?.email || "no email")} · ${h(c?.phone || "no phone")}
      ${c?.dnd ? ' · <span class="badge bad">do not disturb</span>' : ""}
      · in the CRM since ${h(fmtTime(c?.dateAdded))}
    </p>

    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:18px">
      <button class="btn" data-action="edit">Edit details</button>
      <button class="btn" data-action="tag">Add tag</button>
      <button class="btn" data-action="note">Add note</button>
    </div>

    <div class="card">
      <div class="head">Tags</div>
      <div class="body pad">
        ${
          (c?.tags ?? []).length
            ? c.tags
                .map(
                  (t) =>
                    `<span class="badge" style="margin:0 6px 6px 0">${h(t)}
                       <a href="#" data-action="untag" data-tag="${h(t)}" title="Remove this tag" style="text-decoration:none;opacity:.6">✕</a>
                     </span>`,
                )
                .join("")
            : '<span class="muted">No tags.</span>'
        }
        <div class="why">Tags drive GoHighLevel automations — removing one can change which workflows this person is in.</div>
      </div>
    </div>

    <div class="card">
      <div class="head">Details</div>
      <div class="body pad">
        <div class="kv">
          <dt>Company</dt><dd>${h(c?.companyName || "—")}</dd>
          <dt>Address</dt><dd>${h([c?.address1, c?.city, c?.state, c?.postalCode, c?.country].filter(Boolean).join(", ") || "—")}</dd>
          <dt>Website</dt><dd>${h(c?.website || "—")}</dd>
          <dt>Source</dt><dd>${h(c?.source || "—")}</dd>
          <dt>Timezone</dt><dd>${h(c?.timezone || "—")}</dd>
          <dt>Last updated</dt><dd>${h(fmtDateTime(c?.dateUpdated))}</dd>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="head">Bookings (${d.bookings.length}${d.unlinkedAppointments.length ? ` + ${d.unlinkedAppointments.length} in GHL only` : ""})</div>
      <div class="body">
        ${failed("bookings")}
        ${table(
          ["Reference", "What", "When", "Status"],
          d.bookings,
          (b) => `<tr>
            <td class="mono">${h(b.code)}</td>
            <td>${h(b.resourceId)}${
              Object.keys(b.details || {}).length
                ? `<div class="muted">${h(Object.entries(b.details).map(([k, v]) => `${k}: ${v}`).join(", "))}</div>`
                : ""
            }</td>
            <td>${h(fmtInZone(b.startsAt, d.timezone))}</td>
            <td>${badge(b.status)}${b.replacedByCode ? `<div class="muted">moved → ${h(b.replacedByCode)}</div>` : ""}</td>
          </tr>`,
          { empty: "No bookings on our side." },
        )}
        ${
          d.unlinkedAppointments.length
            ? `<div class="body pad"><p class="muted" style="margin:0">
                 ${h(d.unlinkedAppointments.length)} appointment(s) exist in GoHighLevel with no reference on our side —
                 booked by a person rather than the agent:
                 ${d.unlinkedAppointments.map((a) => `<br>· ${h(fmtInZone(a.startTime, d.timezone))} — ${h(a.status)}`).join("")}
               </p></div>`
            : ""
        }
      </div>
    </div>

    <div class="card">
      <div class="head">Conversations (${d.conversations.length})</div>
      <div class="body">
        ${failed("conversations")}
        ${table(
          ["When", "Channel", "Outcome", "Turns", "Last message"],
          d.conversations,
          (v) => `<tr class="clickable" data-action="convo" data-id="${h(v.id)}">
            <td>${h(fmtTime(v.updatedAt))}</td>
            <td>${badge(v.channel)}</td>
            <td>${v.outcome ? badge(v.outcome) : '<span class="muted">in progress</span>'}</td>
            <td>${h(v.messageCount)}</td>
            <td class="muted">${h(v.lastMessage || "—")}</td>
          </tr>`,
          { empty: "No conversations with this person." },
        )}
      </div>
    </div>

    <div class="card">
      <div class="head">Opportunities (${d.opportunities.length})</div>
      <div class="body">
        ${failed("opportunities")}
        ${table(
          ["Name", "Stage", "Status", "Value"],
          d.opportunities,
          (o) => `<tr>
            <td>${h(o.name)}</td><td>${badge(o.stageName)}</td>
            <td>${badge(o.status)}</td><td>${o.monetaryValue ? "$" + h(o.monetaryValue) : "—"}</td>
          </tr>`,
          { empty: "No deals for this person." },
        )}
      </div>
    </div>

    <div class="card">
      <div class="head">Emails (${d.emails.length})</div>
      <div class="body">
        ${table(
          ["Composed", "Subject", "Status"],
          d.emails,
          (e) => `<tr>
            <td>${h(fmtTime(e.composedAt))}</td><td>${h(e.subject)}</td><td>${badge(e.status)}</td>
          </tr>`,
          { empty: "Nothing composed for this person." },
        )}
      </div>
    </div>

    <div class="card">
      <div class="head">Tasks (${(d.tasks || []).length})</div>
      <div class="body">
        ${failed("tasks")}
        ${table(
          ["Task", "Due", "Status"],
          d.tasks || [],
          (t) => `<tr>
            <td>${h(t.title)}${t.body ? `<div class="muted">${h(String(t.body).slice(0, 120))}</div>` : ""}</td>
            <td class="muted">${h(t.dueDate ? fmtDateTime(t.dueDate) : "—")}</td>
            <td>${badge(t.completed ? "done" : "open")}</td>
          </tr>`,
          { empty: "No tasks. GoHighLevel tasks are the natural home for \"call them back\" — the agent currently writes that as a note instead." },
        )}
      </div>
    </div>

    <div class="card">
      <div class="head">Notes (${d.notes.length})</div>
      <div class="body pad">
        ${failed("notes")}
        ${
          d.notes.length
            ? d.notes
                .map(
                  (n) => `<div style="border-bottom:1px solid #141d34; padding:10px 0">
                    <div class="muted" style="font-size:.75rem">${h(fmtDateTime(n.at))}</div>
                    <div style="white-space:pre-wrap; font-size:.85rem">${h(n.body)}</div>
                  </div>`,
                )
                .join("")
            : '<span class="muted">No notes. This is where the agent records why it scored or handed off a caller.</span>'
        }
      </div>
    </div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    convo: (dd) => {
      location.hash = `#/conversations/${encodeURIComponent(dd.id)}`;
    },

    edit: async () => {
      // Prefilled from the DETAIL endpoint (this payload), never from a list
      // row — the list returns names lowercased, so prefilling from one and
      // saving would permanently downcase a real customer's name.
      const f = form([
        { name: "firstName", label: "First name", value: c.firstName ?? "" },
        { name: "lastName", label: "Last name", value: c.lastName ?? "" },
        { name: "email", label: "Email", type: "email", value: c.email ?? "" },
        { name: "phone", label: "Phone", value: c.phone ?? "", hint: "Include the country code, e.g. +92… or +1…" },
        { name: "companyName", label: "Company", value: c.companyName ?? "" },
        { name: "address1", label: "Address", value: c.address1 ?? "" },
        { name: "city", label: "City", value: c.city ?? "" },
        { name: "state", label: "State", value: c.state ?? "" },
        { name: "postalCode", label: "Postcode", value: c.postalCode ?? "" },
        { name: "website", label: "Website", value: c.website ?? "" },
      ]);

      await modal({
        title: `Edit ${fullName}`,
        body: `<p class="muted" style="margin:0 0 14px">Only the fields you actually change are sent. Tags are edited separately, because saving them here would replace the whole set.</p>${f.html}`,
        submitLabel: "Save changes",
        onSubmit: async (dlg) => {
          const patch = f.dirty(dlg);
          if (!Object.keys(patch).length) throw new Error("Nothing was changed.");
          await post("contacts/update", { id, patch });
          toast(`Saved ${Object.keys(patch).length} field(s).`);
          await refresh();
          return true;
        },
      });
      f.watch(document.getElementById("dlg"));
    },

    tag: async () => {
      await modal({
        title: "Add a tag",
        body: form([{ name: "tag", label: "Tag", required: true, hint: "Lowercased automatically. Tags can trigger GoHighLevel workflows." }]).html,
        submitLabel: "Add it",
        onSubmit: async (dlg) => {
          const tag = dlg.querySelector('[data-name="tag"]').value.trim();
          if (!tag) throw new Error("Type a tag first.");
          await post("contacts/tags/add", { id, tags: [tag] });
          toast(`Tagged "${tag.toLowerCase()}".`);
          await refresh();
          return true;
        },
      });
    },

    untag: async (dd) => {
      const ok = await confirmDanger({
        title: `Remove the tag "${dd.tag}"?`,
        warning: "Tags drive GoHighLevel automations, so removing one can change which workflows this person is in.",
        confirmLabel: "Remove it",
      });
      if (!ok) return;
      await runAction({
        label: "Remove tag",
        run: () => post("contacts/tags/remove", { id, tags: [dd.tag] }),
        success: `Removed "${dd.tag}".`,
        refresh,
      });
    },

    note: async () => {
      await modal({
        title: "Add a note",
        body: form([{ name: "body", label: "Note", type: "textarea", required: true, hint: "Saved against the contact in GoHighLevel and signed with your admin address." }]).html,
        submitLabel: "Save note",
        onSubmit: async (dlg) => {
          const body = dlg.querySelector('[data-name="body"]').value.trim();
          if (!body) throw new Error("Write something first.");
          await post("contacts/note", { id, body });
          toast("Note added.");
          await refresh();
          return true;
        },
      });
    },
  });
}

// ------------------------------------------------------------------- emails --

export async function renderEmails(main, _param, gen) {
  mount(main, loading("Emails"), gen);
  const { composed, ghlThreads } = await api("emails?limit=40");
  const refresh = () => renderEmails(main, _param, gen);

  const isWaiting = (e) => e.status === "send_disabled" || e.status === "composed" || e.status === "failed";
  const waiting = composed.filter(isWaiting);
  const done = composed.filter((e) => !isWaiting(e));

  const queueRow = (e) => `<tr>
    <td>${h(fmtTime(e.composedAt))}</td>
    <td class="muted">${h(e.recipient || "—")}</td>
    <td>
      <a href="#" data-action="read" data-id="${h(e.id)}">${h(e.subject)}</a>
      ${e.sendError ? `<div class="muted">last error: ${h(String(e.sendError).slice(0, 90))}</div>` : ""}
    </td>
    <td>${badge(e.trigger)}</td>
    <td>${badge(e.status)}${e.reason ? `<div class="muted">${h(e.reason)}</div>` : ""}</td>
    <td class="row-actions">
      <button class="btn sm" data-action="read" data-id="${h(e.id)}">Read</button>
      ${
        e.contactId
          ? `<button class="btn sm primary" data-action="send" data-id="${h(e.id)}" data-to="${h(e.recipient || "")}">Send</button>`
          : disabledBtn("Send", "No CRM contact attached — GoHighLevel threads outbound mail by contact, so there is nowhere to send it from.")
      }
      <button class="btn sm" data-action="discard" data-id="${h(e.id)}">Discard</button>
    </td>
  </tr>`;

  if (
    !mount(
      main,
      `
    <h1>Emails</h1>
    <p class="page-sub">What the agent composed, and every email thread GoHighLevel knows about.</p>

    <div class="card">
      <div class="head">Awaiting a human (${waiting.length})</div>
      <div class="body">
        ${
          waiting.length
            ? `<div class="body pad" style="padding-bottom:0">
                 <p class="muted" style="margin:0">
                   The agent wrote these and <strong>did not send them</strong> — automatic sending is switched off,
                   which is the normal setting. Read one, then send or discard it.
                 </p>
               </div>
               ${table(["Composed", "To", "Subject", "Trigger", "Status", ""], waiting, queueRow)}`
            : `<div class="empty">Nothing waiting. Every composed email has been sent or discarded.</div>`
        }
      </div>
    </div>

    <div class="card">
      <div class="head">Already handled (${done.length})</div>
      <div class="body">
        ${table(
          ["Composed", "To", "Subject", "Trigger", "Status"],
          done,
          (e) => `<tr>
            <td>${h(fmtTime(e.composedAt))}</td>
            <td class="muted">${h(e.recipient || "—")}</td>
            <td><a href="#" data-action="read" data-id="${h(e.id)}">${h(e.subject)}</a></td>
            <td>${badge(e.trigger)}</td>
            <td>${badge(e.status)}${e.reason ? `<div class="muted">${h(e.reason)}</div>` : ""}</td>
          </tr>`,
          { empty: "Nothing sent or discarded yet." },
        )}
      </div>
    </div>

    <div class="card">
      <div class="head">Email threads in GoHighLevel (${ghlThreads.length})</div>
      <div class="body">
        ${table(
          ["Contact", "Last message", "When", "Unread"],
          ghlThreads,
          (t) => `<tr>
            <td>${
              t.contactId
                ? `<a href="#/contacts/${h(t.contactId)}">${h(t.contactName || t.contactId)}</a>`
                : h(t.contactName || "—")
            }</td>
            <td class="muted">${h(t.lastMessageBody || "—")}</td>
            <td>${h(fmtTime(t.lastMessageDate))}</td>
            <td>${t.unreadCount ? badge(t.unreadCount) : "—"}</td>
          </tr>`,
          { empty: "No email conversations in GoHighLevel yet." },
        )}
      </div>
    </div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    read: (d) => readEmailDialog(d.id, refresh),

    send: async (d, btn) => {
      const ok = await confirmDanger({
        title: `Send to ${d.to || "this contact"}?`,
        warning:
          "This sends a real email and cannot be recalled. Note the sending domain on this account is still unverified, " +
          "so GoHighLevel may report success for mail that never actually arrives.",
        confirmLabel: "Send it",
      });
      if (!ok) return;
      await runAction({
        button: btn,
        label: "Send",
        busyLabel: "Sending…",
        run: () => post("emails/send", { id: d.id }),
        success: `Sent to ${d.to}. GoHighLevel accepted it — delivery is not guaranteed while the sending domain is unverified.`,
        refresh,
      });
    },

    discard: async (d, btn) => {
      const ok = await confirmDanger({
        title: "Discard this draft?",
        warning:
          "The draft is kept for the record but marked discarded, and the agent will not compose another first-touch email for this person.",
        confirmLabel: "Discard it",
      });
      if (!ok) return;
      await runAction({
        button: btn,
        label: "Discard",
        busyLabel: "Discarding…",
        run: () => post("emails/discard", { id: d.id }),
        success: "Draft discarded.",
        refresh,
      });
    },
  });
}

/** The whole point of the queue: actually reading what the agent wrote. */
async function readEmailDialog(id, refresh) {
  const e = await api(`emails/${encodeURIComponent(id)}`);

  await modal({
    title: e.subject,
    submitLabel: "Close",
    body: `
      <div class="kv" style="margin-bottom:14px">
        <dt>To</dt><dd>${h(e.recipient || "—")}</dd>
        <dt>Status</dt><dd>${badge(e.status)} ${e.reason ? `<span class="muted">${h(e.reason)}</span>` : ""}</dd>
        <dt>Composed</dt><dd>${h(fmtDateTime(e.composedAt))}</dd>
        ${e.sentAt ? `<dt>Sent</dt><dd>${h(fmtDateTime(e.sentAt))}</dd>` : ""}
        ${e.attempts ? `<dt>Attempts</dt><dd>${h(e.attempts)}</dd>` : ""}
        ${e.contactId ? `<dt>Contact</dt><dd><a href="#/contacts/${h(e.contactId)}">open →</a></dd>` : ""}
      </div>
      ${e.sendError ? `<div class="warning">Last send failed: ${h(e.sendError)}</div>` : ""}
      <div class="field">
        <label>Message</label>
        <div style="white-space:pre-wrap; background:#0f1830; border:1px solid #2c3a5e; border-radius:8px; padding:12px; font-size:.87rem; max-height:320px; overflow-y:auto">${h(e.body)}</div>
      </div>
    `,
    onSubmit: () => true,
  });
  void refresh;
}

// ------------------------------------------------------------- needs human --

/**
 * The operator's actual job: people who asked for a person and were told
 * someone would ring them back.
 *
 * `CrmSync.flagForHuman` has been writing "Call them back — they asked for a
 * person and were told someone would ring" into GHL notes all along, and nothing
 * in the product surfaced it. Two sources, because neither is complete: our
 * conversations know the agent handed off and hold the transcript; the GHL tag is
 * what someone working in the CRM would see.
 */
export async function renderNeedsHuman(main, _param, gen) {
  mount(main, loading("Needs a human"), gen);
  const { items, counts } = await api("needs-human");

  if (
    !mount(
      main,
      `
    <h1>Needs a human</h1>
    <p class="page-sub">
      ${items.length} waiting — ${counts.fromConversations} handed off by the agent,
      ${counts.fromCrm} tagged in GoHighLevel.
      These people were told someone would get back to them.
    </p>
    <div class="card"><div class="body">
      ${table(
        ["When", "Who", "Reach them on", "Where", "What they last said", ""],
        items,
        (r) => `<tr>
          <td>${h(fmtTime(r.at))}</td>
          <td>${
            r.contactId ? `<a href="#/contacts/${h(r.contactId)}">${h(r.name || "(unnamed)")}</a>` : h(r.name || "(unnamed)")
          }</td>
          <td class="muted">${h(r.email || r.phone || "— no contact details —")}</td>
          <td>${badge(r.channel)}${r.source === "crm-tag" ? ' <span class="badge ghlonly">tag</span>' : ""}</td>
          <td class="muted">${h(r.lastMessage || "—")}</td>
          <td class="row-actions">
            ${
              r.conversationId
                ? `<button class="btn sm" data-action="open" data-id="${h(r.conversationId)}">Transcript</button>`
                : ""
            }
          </td>
        </tr>`,
        { empty: "Nobody is waiting on a callback. " },
      )}
    </div></div>
  `,
      gen,
    )
  ) {
    return;
  }

  onActions(main, {
    open: (d) => {
      location.hash = `#/conversations/${encodeURIComponent(d.id)}`;
    },
  });
}

// ------------------------------------------------------------------- social --

export async function renderSocial(main, _param, gen) {
  mount(main, loading("Social"), gen);
  const { accounts, posts, unmanageable, insights, duplicateSlots, timezone } = await api("social");
  const policy = await api("write-policy").catch(() => ({ risks: {} }));

  const maxScore = Math.max(1, ...insights.map((i) => i.score));
  const refresh = () => renderSocial(main, _param, gen);

  if (
    !mount(
      main,
      `
    <h1>Social</h1>
    <p class="page-sub">Connected accounts, recent posts, and what we've learned about when to post.</p>

    <div class="card">
      <div class="head">Accounts &amp; engagement</div>
      <div class="acct-tabs" id="acctTabs">
        ${accounts
          .map(
            (a, i) => `<button class="acct-tab" role="tab" aria-selected="${i === 0}"
                 data-action="pickAccount" data-profile="${h(a.profileId)}" data-platform="${h(a.platform)}">
                 <span class="pf pf-${h(a.platform)}"></span>${h(a.name)}
               </button>`,
          )
          .join("") || '<span class="muted">No accounts connected.</span>'}
      </div>
      <div id="acctPanel"><div class="empty">Loading engagement…</div></div>
    </div>

    <div class="card">
      <div class="head" style="flex-wrap:wrap;">
        Create posts
        <div style="display:flex; gap:8px;">
          <button class="btn" data-action="draft">Draft</button>
          <button class="btn" data-action="schedule">Schedule at best time</button>
          <button class="btn primary" data-action="publish">Publish now</button>
        </div>
      </div>
      <div class="body pad">
        <div class="acct-pick" id="acctPick">
          <span class="muted" style="font-size:.8rem">Post to:</span>
          ${["facebook", "instagram", "linkedin"]
            .filter((pf) => accounts.some((a) => a.platform === pf))
            .map((pf) => {
              const acct = accounts.find((a) => a.platform === pf);
              const blocked = pf === "instagram";
              return `<label${blocked ? ' title="Instagram rejects text-only posts"' : ""}>
                <input type="checkbox" value="${h(pf)}" ${blocked ? "" : "checked"} ${blocked ? "disabled" : ""} />
                <span class="pf pf-${h(pf)}"></span>
                ${h(acct?.name ?? pf)}
                ${blocked ? '<span class="note">— needs an image or video, which we don\'t generate yet</span>' : ""}
              </label>`;
            })
            .join("")}
        </div>
        <div class="why">Each selected account gets a DIFFERENT post, written from a different caller question — the same text on three networks is the clearest tell of automation there is.</div>
      </div>
    </div>

    <div class="card">
      <div class="head">Best day to post</div>
      <div class="body pad">
        ${
          insights.length
            ? `<div class="weekday-bar">${insights
                .slice()
                .sort((a, b) => a.weekday - b.weekday)
                .map(
                  (i) => `<div class="col">
                <div class="bar" style="height:${Math.max(4, (i.score / maxScore) * 90)}px"></div>
                <div class="name">${h(i.name.slice(0, 3))}</div>
              </div>`,
                )
                .join("")}</div>
             <p class="muted" style="margin:8px 0 0">Based on ${h(
               insights.reduce((n, i) => n + i.days, 0),
             )} days of data. Needs ~20 days before this is more than noise.</p>`
            : `<div class="empty">No engagement data collected yet — run the collector after posting for a while.</div>`
        }
      </div>
    </div>

    ${
      duplicateSlots.length
        ? `<div class="card"><div class="body pad">
             <div class="warning" style="margin:0">
               ${h(duplicateSlots.map((d) => `${d.count} posts share ${fmtInZone(d.at, timezone)}`).join("; "))}.
               "Schedule at best time" resolves to the same slot every click, so repeated clicks stack up.
               Delete the ones you don't want.
             </div>
           </div></div>`
        : ""
    }

    <div class="card">
      <div class="head">
        Posts in GoHighLevel (${posts.length})
        <span id="bulkBar" style="display:none; gap:8px; align-items:center">
          <span class="muted" id="bulkCount"></span>
          <button class="btn sm danger" data-action="deleteSelected">Delete selected</button>
        </span>
      </div>
      <div class="body">
        ${table(
          ["", "Platform", "Content", "Status", "When", ""],
          posts,
          (p) => `<tr>
            <td><input type="checkbox" class="pick" value="${h(p.id)}" /></td>
            <td>${badge(p.platform)}</td>
            <td>
              ${h(String(p.summary || "").slice(0, 90))}${String(p.summary || "").length > 90 ? "…" : ""}
              ${p.topic ? `<div class="muted">topic: ${h(p.topic)}${p.askedBy ? ` · asked by ${h(p.askedBy)}` : ""}</div>` : ""}
            </td>
            <td>${badge(p.status)}</td>
            <td class="muted">${h(fmtInZone(p.scheduleDate || p.publishedAt || p.createdAt, timezone))}</td>
            <td class="row-actions">
              ${
                p.editable
                  ? `<button class="btn sm" data-action="editPost" data-id="${h(p.id)}" data-summary="${h(p.summary)}" data-when="${h(p.scheduleDate || "")}">Edit</button>`
                  : disabledBtn("Edit", "Already published. Editing the GoHighLevel record would not change the post people have already seen.")
              }
              <button class="btn sm danger" data-action="deletePost" data-id="${h(p.id)}" data-status="${h(p.status)}">Delete</button>
            </td>
          </tr>`,
          { empty: "No posts in GoHighLevel." },
        )}
      </div>
    </div>

    ${
      unmanageable.length
        ? `<div class="card">
             <div class="head">Recorded here but not in GoHighLevel (${unmanageable.length})</div>
             <div class="body">
               ${table(
                 ["Platform", "Topic", "Status", "Why it can't be managed"],
                 unmanageable,
                 (p) => `<tr>
                   <td>${badge(p.platform)}</td>
                   <td>${h(p.topic)}</td>
                   <td>${badge(p.status)}${p.error ? `<div class="muted">${h(String(p.error).slice(0, 80))}</div>` : ""}</td>
                   <td class="muted">${h(p.reason)}</td>
                 </tr>`,
               )}
             </div>
           </div>`
        : ""
    }
  `,
      gen,
    )
  ) {
    return;
  }

  // The bulk bar only appears once something is selected — a permanently
  // visible "delete selected" with nothing selected is just a trap.
  const bar = main.querySelector("#bulkBar");
  const syncBulkBar = () => {
    const n = main.querySelectorAll("input.pick:checked").length;
    bar.style.display = n ? "flex" : "none";
    main.querySelector("#bulkCount").textContent = `${n} selected`;
  };
  main.querySelectorAll("input.pick").forEach((c) => c.addEventListener("change", syncBulkBar));

  const risk = (op) => policy.risks?.[op] || {};
  const chosenPlatforms = () =>
    [...main.querySelectorAll("#acctPick input:checked")].map((i) => i.value);

  // Engagement for whichever account is selected. Loaded after first paint so a
  // slow analytics call never delays the page.
  const showAccount = async (profileId, platform) => {
    const panel = main.querySelector("#acctPanel");
    panel.innerHTML = `<div class="empty">Loading engagement…</div>`;
    try {
      const a = await api(`social/analytics?profileId=${encodeURIComponent(profileId)}&platform=${encodeURIComponent(platform)}`);
      if (!isCurrent(gen)) return;
      panel.innerHTML = analyticsPanel(a);
    } catch (err) {
      panel.innerHTML = `<div class="body pad"><div class="why">Couldn't load engagement: ${h(err.message)}</div></div>`;
    }
  };

  if (accounts.length) void showAccount(accounts[0].profileId, accounts[0].platform);

  onActions(main, {
    pickAccount: (d, el) => {
      main.querySelectorAll(".acct-tab").forEach((t) => t.setAttribute("aria-selected", String(t === el)));
      void showAccount(d.profile, d.platform);
    },

    draft: (_d, btn) => {
      const platforms = chosenPlatforms();
      if (!platforms.length) return toast("Pick at least one account to post to.", "bad");
      return runAction({
        button: btn,
        label: "Draft",
        busyLabel: "Drafting…",
        run: () => post("social/draft", { platforms }),
        success: (r) => `Drafted ${r.results.length} post(s) — check GHL → Social Planner.`,
        refresh,
      });
    },

    schedule: async (_d, btn) => {
      const r = risk("social.schedule");
      if (r.gate === "confirm" && !(await confirmDanger({ title: "Schedule 3 posts?", warning: r.warning, confirmLabel: "Schedule them" }))) {
        return;
      }
      await runAction({
        button: btn,
        label: "Schedule at best time",
        busyLabel: "Scheduling…",
        run: () => post("social/schedule", { platforms: chosenPlatforms() }),
        success: (res) =>
          `Scheduled ${res.results.length} post(s) for ${res.scheduledForDisplay}` +
          (res.usedLearnedData ? "." : " (not enough data yet to know the best day — defaulted to tomorrow)."),
        refresh,
      });
    },

    deleteSelected: async (_d, btn) => {
      const ids = [...main.querySelectorAll("input.pick:checked")].map((i) => i.value);
      if (!ids.length) return;
      const ok = await confirmDanger({
        title: `Delete ${ids.length} post(s)?`,
        warning:
          "These are removed from GoHighLevel. Any that were already published may still be visible on Facebook or LinkedIn.",
        confirmLabel: `Delete ${ids.length}`,
      });
      if (!ok) return;
      await runAction({
        button: btn,
        label: "Delete selected",
        busyLabel: "Deleting…",
        run: () => post("social/delete-many", { ids }),
        // Reported per row rather than as one outcome — "3 of 4" is actionable,
        // "it failed" is not.
        success: (r) => {
          const okCount = r.results.filter((x) => x.ok).length;
          const bad = r.results.filter((x) => !x.ok);
          return `Deleted ${okCount}/${r.results.length}.` + (bad.length ? `\nFailed: ${bad.map((x) => x.error).join("; ")}` : "");
        },
        refresh,
      });
    },

    editPost: async (d) => {
      const f = form([
        { name: "summary", label: "Post content", type: "textarea", value: d.summary, required: true },
        ...(d.when
          ? [{ name: "scheduleDate", label: "Scheduled for (UTC)", value: String(d.when).slice(0, 16).replace("T", " "), hint: "Leave alone to keep the current time." }]
          : []),
      ]);
      await modal({
        title: "Edit post",
        body: `<p class="muted" style="margin:0 0 14px">GoHighLevel replaces the whole post on edit, so the unchanged parts are re-sent for you.</p>${f.html}`,
        submitLabel: "Save post",
        onSubmit: async (dlg) => {
          const dirty = f.dirty(dlg);
          if (!Object.keys(dirty).length) throw new Error("Nothing was changed.");
          const payload = { id: d.id };
          if (dirty.summary !== undefined) payload.summary = dirty.summary;
          if (dirty.scheduleDate !== undefined) {
            const iso = new Date(dirty.scheduleDate.replace(" ", "T") + "Z");
            if (Number.isNaN(iso.getTime())) throw new Error("That date could not be read. Use YYYY-MM-DD HH:MM.");
            payload.scheduleDate = iso.toISOString();
          }
          await post("social/edit", payload);
          toast("Post updated.");
          await refresh();
          return true;
        },
      });
    },

    deletePost: async (d, btn) => {
      const published = d.status === "published";
      const ok = await confirmDanger({
        title: "Delete this post?",
        warning: published
          ? "This removes the post from GoHighLevel. It may NOT remove it from Facebook or LinkedIn — people who have already seen it may still see it."
          : "This removes the post from GoHighLevel. If it was scheduled, it will not go out.",
        confirmLabel: "Delete it",
      });
      if (!ok) return;
      await runAction({
        button: btn,
        label: "Delete",
        busyLabel: "Deleting…",
        run: () => post("social/delete", { id: d.id }),
        success: "Post deleted.",
        refresh,
      });
    },

    publish: async (_d, btn) => {
      // The one irreversible action here. A live post cannot be pulled back from
      // anyone who has already seen it, so this asks the operator to type the word.
      const r = risk("social.publish");
      const ok = await confirmDanger({
        title: "Publish to real accounts now?",
        warning: r.warning || "This posts immediately and cannot be undone.",
        confirmLabel: "Publish now",
        typed: r.gate === "confirm-typed" ? "PUBLISH" : undefined,
      });
      if (!ok) return;

      await runAction({
        button: btn,
        label: "Publish now",
        busyLabel: "Publishing…",
        run: () => post("social/publish", { platforms: chosenPlatforms() }),
        success: (res) => {
          const ok2 = res.results.filter((x) => x.status === "published").length;
          const failed = res.results.filter((x) => x.status === "failed");
          return (
            `Published ${ok2}/${res.results.length} post(s).` +
            (failed.length ? `\nFailed: ${failed.map((f) => f.platform).join(", ")}` : "")
          );
        },
        refresh,
      });
    },
  });
}

/**
 * Engagement for one account.
 *
 * Every metric carries its number as a direct label rather than relying on the
 * bar height or the hue — which is also what discharges the contrast relief rule
 * for the aqua series, whose fill sits below 3:1 on this light surface.
 *
 * One series per tile, so a colour identifies a metric and never a rank; the
 * seven bars are that metric over GoHighLevel's rolling week, labelled with the
 * weekdays it actually measured rather than dates we would be guessing at.
 */
function analyticsPanel(a) {
  const tile = (m) => {
    const max = Math.max(1, ...m.series);
    const arrow = m.change === null ? "" : m.change > 0 ? "▲" : m.change < 0 ? "▼" : "";
    const dir = m.change === null || m.change === 0 ? "" : m.change > 0 ? " up" : " down";
    return `<div class="metric" data-series="${h(m.slot)}">
      <div class="label">${h(m.label)}</div>
      <div class="value">${h(m.total.toLocaleString())}</div>
      <div class="delta${dir}">${
        m.change === null ? "over the last 7 days" : `${arrow} ${h(Math.abs(m.change))} vs the week before`
      }</div>
      ${
        m.series.length
          ? `<div class="spark">${m.series
              .map((v) => `<i style="height:${Math.max(2, Math.round((v / max) * 32))}px" title="${h(v)}"></i>`)
              .join("")}</div>
             <div class="spark-axis">${a.days.map((d) => `<span>${h(d.slice(0, 1))}</span>`).join("")}</div>`
          : `<div class="why" style="margin-top:8px">No daily series returned.</div>`
      }
    </div>`;
  };

  return `
    <div class="metrics">
      ${a.metrics.map(tile).join("")}
      <div class="metric">
        <div class="label">Posts</div>
        <div class="value">${h(a.posts)}</div>
        <div class="delta">published in the last 7 days</div>
      </div>
      <div class="metric">
        <div class="label">Reach</div>
        <div class="value">${h(Number(a.reach).toLocaleString())}</div>
        <div class="delta">unique people</div>
      </div>
    </div>
    <div class="body pad" style="padding-top:0">
      <div class="why">
        GoHighLevel reports these daily over a rolling 7 days — ${h(a.days.join(", "))}. There is no
        hour-of-day breakdown anywhere in its API, which is why the timing analysis below can answer
        "best day" and never "best hour".
      </div>
    </div>
  `;
}

export const notFound = (main, _p, gen) => mount(main, `<div class="empty">Unknown page.</div>`, gen);
