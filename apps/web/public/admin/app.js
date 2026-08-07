"use strict";

/**
 * Router and boot.
 *
 * Hash routing, `#/route/param`. One level of sub-route is enough for every page
 * here — `#/conversations/<id>`, `#/contacts/<id>` — and a query string after the
 * route (`#/contacts?q=ali`) carries page state without inventing a second
 * mechanism.
 */

import { h, isCurrent, newGeneration, stopPolling } from "./ui.js";
import * as pages from "./pages.js";

const routes = {
  overview: pages.renderOverview,
  live: pages.renderLive,
  "needs-human": pages.renderNeedsHuman,
  conversations: pages.renderConversations,
  bookings: pages.renderBookings,
  leads: pages.renderLeads,
  opportunities: pages.renderOpportunities,
  contacts: pages.renderContacts,
  emails: pages.renderEmails,
  social: pages.renderSocial,
};

async function router() {
  // Every in-flight render is invalidated here. A renderer that awaited a slow
  // GHL read and then tries to paint will find its generation stale and no-op,
  // instead of overwriting whatever page the operator moved to.
  stopPolling();
  const gen = newGeneration();

  const raw = location.hash.replace(/^#\/?/, "") || "overview";
  const [pathPart] = raw.split("?");
  const [route, ...rest] = pathPart.split("/");
  const param = rest.map(decodeURIComponent).join("/");

  document.querySelectorAll("nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
  });

  const main = document.getElementById("main");
  const renderer = routes[route] || pages.notFound;

  try {
    await renderer(main, param, gen);
  } catch (err) {
    // Only report into a page the operator is still looking at. Must be the
    // read-only check — newGeneration() would bump the counter and invalidate
    // whatever render is legitimately in flight.
    if (isCurrent(gen)) {
      main.innerHTML = `<div class="empty">Couldn't load this page — ${h(err.message)}${
        err.detail ? `<div class="muted" style="margin-top:8px">${h(err.detail)}</div>` : ""
      }</div>`;
    }
  }
}

window.addEventListener("hashchange", router);

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/admin/logout", {
    method: "POST",
    // The server requires this on every write, including logout.
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  location.href = "/admin";
});

router();
