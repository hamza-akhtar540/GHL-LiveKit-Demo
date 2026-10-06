import type { IndustryConfig } from "./types.js";

/**
 * The generalisation test. A hotel is the awkward case: two unrelated bookable
 * things (rooms and restaurant tables), a caller base that mostly wants answers
 * rather than reservations, and guests who call back to change something they
 * already booked. If that fits in a config with no new code, the boundary holds.
 */
export const hotel: IndustryConfig = {
  id: "hotel",
  business: {
    name: "The Fairmount",
    city: "Austin, TX",
    phone: "(512) 555-0188",
    blurb:
      "A 96-room boutique hotel on Rainey Street, walking distance to the convention centre. " +
      "Rooftop restaurant, Halcyon, open to the public.",
    timezone: "Asia/Karachi",
  },
  services: [
    "Room reservations",
    "Restaurant reservations at Halcyon",
    "Event and meeting space",
    "Airport shuttle",
  ],

  knowledge: [
    { topic: "check-in and check-out times", answer: "Check-in from 3pm, check-out by 11am. Early check-in is subject to availability on the day." },
    { topic: "parking", answer: "Valet only, $42 per night with in-and-out privileges. No self-park on site." },
    { topic: "pets", answer: "Dogs under 50lb are welcome, $75 per stay. No pets in the restaurant except service animals." },
    { topic: "breakfast", answer: "Halcyon serves breakfast 6:30–10:30am daily. Not included in the room rate unless booked on a package." },
    { topic: "wifi", answer: "Free throughout the property, no login needed." },
    { topic: "pool", answer: "Rooftop pool, open 7am–10pm, guests only." },
    { topic: "airport shuttle", answer: "Runs to and from Austin-Bergstrom every hour from 5am to 11pm, $15 per person, book at the desk." },
    { topic: "cancellation policy for rooms", answer: "Free cancellation up to 48 hours before arrival. Inside 48 hours is one night's charge." },
    { topic: "cancellation policy for the restaurant", answer: "Tables can be cancelled any time. Parties of 8 or more need 24 hours' notice." },
    { topic: "restaurant dress code", answer: "Smart casual. No beachwear at dinner." },
    { topic: "accessibility", answer: "Step-free throughout, six ADA rooms with roll-in showers, and the rooftop has lift access." },
    { topic: "event space", answer: "Two meeting rooms up to 40 people, and the rooftop terrace for up to 120. Events are quoted individually by the sales team." },
    { topic: "room types and typical rates", answer: "King (340 sq ft, ~$289/night), Double Queen (390 sq ft, ~$319), and six Terrace Suites (620 sq ft with a private terrace, ~$540). Rates move with the date — quote them as typical, not final." },
    { topic: "where the hotel is", answer: "88 Rainey Street, Austin, TX 78701. About a 5 minute walk to the Austin Convention Center and 10 minutes to Lady Bird Lake." },
    { topic: "restaurant hours", answer: "Halcyon serves breakfast 6:30–10:30am, lunch 11:30am–2:30pm, dinner 5–10pm. The bar runs 4pm to midnight." },
    { topic: "gym or fitness", answer: "Small fitness room on the second floor, open 24 hours to guests, with a Peloton and free weights." },
    { topic: "late check-out", answer: "Late check-out until 2pm is usually possible for $50, subject to availability on the day. Ask the front desk the morning of." },
    { topic: "smoking", answer: "The whole property is non-smoking, including the terraces. There's a $250 cleaning fee if a room is smoked in." },
    { topic: "room service", answer: "Available from the Halcyon menu 7am to 10pm, with a $6 delivery charge." },
    { topic: "age or ID to check in", answer: "You must be 21 or over to check in, with photo ID and the card used to book." },
    { topic: "extra beds and cribs", answer: "Cribs are free on request. Rollaway beds are $35 a night and fit in Double Queens and suites, not Kings." },
  ],

  intents: [
    {
      id: "general_enquiry",
      when: "They want to know something about the hotel or restaurant and haven't asked to book.",
      goal: "Answer it directly from what you know. Don't turn it into a booking attempt — offer only if it's a natural next step.",
    },
    {
      id: "room_reservation",
      when: "They want to stay at the hotel.",
      goal:
        "Find out the dates, who it's for, and which room type. Check availability for that " +
        "specific type — if it's full, offer the next type up or down rather than saying no.",
      books: "room_king, room_queen or room_suite — pick the one matching room_type",
      collect: [
        { key: "check_in", ask: "What night are you arriving?", required: true },
        { key: "nights", ask: "How many nights?", required: true },
        { key: "guests", ask: "How many people in the room?", required: true },
        { key: "room_type", ask: "Do you want a king or two queens?", required: false, options: ["king", "double_queen", "suite"] },
        { key: "occasion", ask: "Anything we're celebrating?", required: false },
      ],
    },
    {
      id: "table_reservation",
      when: "They want to eat at Halcyon. They may or may not be staying at the hotel.",
      goal: "Get the date, time and party size, check the table availability, and book it.",
      books: "table",
      collect: [
        { key: "party_size", ask: "How many people?", required: true },
        { key: "dining_date", ask: "Which night?", required: true },
        { key: "seating", ask: "Inside or on the terrace?", required: false, options: ["indoor", "terrace"] },
        { key: "dietary", ask: "Any allergies or dietary needs the kitchen should know about?", required: false },
      ],
    },
    {
      id: "modify_or_cancel",
      when: "They already have a reservation and want to change, confirm or cancel it.",
      goal: "Look it up by reference, read the details back, then do what they asked. Never cancel without confirming which booking first.",
    },
    {
      id: "group_enquiry",
      when:
        "More than one room, a party too big for a normal table, a wedding, a conference, " +
        "a block booking, or anything they describe as an event. Any hint of 'a few rooms' " +
        "or 'we're a group' belongs here, not in room_reservation.",
      goal:
        "You cannot book these yourself and must not imply you have. Collect the dates, how " +
        "many rooms or people, the occasion, and their contact details — then call " +
        "recordEnquiry. Only once that succeeds do you say it's been passed to the team. " +
        "Never quote a price for a group; those are always negotiated by a person.",
      collect: [
        { key: "group_type", ask: "What's the occasion?", required: true },
        { key: "rooms_needed", ask: "Roughly how many rooms do you need?", required: false },
        { key: "headcount", ask: "And how many people altogether?", required: false },
        { key: "arrival_date", ask: "What dates are you looking at?", required: true },
        { key: "nights", ask: "How many nights?", required: false },
        { key: "requirements", ask: "Anything else the team should know — meeting space, dining, anything like that?", required: false },
      ],
    },
  ],

  /**
   * One resource per thing that can run out independently, because each maps to
   * its own calendar and its own count.
   *
   * Rooms split by type: a King and a Suite are different inventory at
   * different prices, and "we have a King on the 26th" is a real answer where
   * "we have a room" is not.
   *
   * Tables deliberately do NOT split by seat count. Party size is recorded on
   * the booking and the restaurant seats accordingly — which is how SMB
   * restaurant booking actually works. Splitting into 2-tops and 4-tops would
   * add calendars to maintain for something no guest ever sees.
   *
   * This is not a property management system and shouldn't pretend to be. A
   * client running Mews or Cloudbeds gets a second BookingStore implementation
   * against their real inventory; GoHighLevel stays the CRM.
   */
  resources: [
    {
      id: "room_king",
      label: "a King room",
      // Check-in appointments. The stay length lives in `nights` on the booking.
      durationMin: 60,
      params: [
        { key: "nights", ask: "How many nights?", required: true },
        { key: "guests", ask: "How many guests?", required: true },
      ],
      hours: { open: "15:00", close: "22:00" },
    },
    {
      id: "room_queen",
      label: "a room with two queens",
      durationMin: 60,
      params: [
        { key: "nights", ask: "How many nights?", required: true },
        { key: "guests", ask: "How many guests?", required: true },
      ],
      hours: { open: "15:00", close: "22:00" },
    },
    {
      id: "room_suite",
      label: "a Terrace Suite",
      durationMin: 60,
      params: [
        { key: "nights", ask: "How many nights?", required: true },
        { key: "guests", ask: "How many guests?", required: true },
      ],
      hours: { open: "15:00", close: "22:00" },
    },
    {
      id: "table",
      label: "a table at Halcyon",
      durationMin: 90,
      params: [{ key: "party_size", ask: "How many people?", required: true }],
      // All-day service, not dinner-only: breakfast from 6:30, lunch, dinner,
      // and the bar until midnight. Must stay in step with the GHL calendar and
      // with the `restaurant hours` fact below, or the agent turns away a lunch
      // booking that the calendar would have taken.
      hours: { open: "08:00", close: "23:00" },
    },
  ],

  contact: [
    { key: "full_name", ask: "Whose name should it be under?", required: true },
    { key: "phone", ask: "Best number in case anything changes?", required: true },
    { key: "email", ask: "And an email for the confirmation?", required: false },
  ],

  scoring: {
    // A booked room is worth more than a table, and an event enquiry more than
    // either — it's the one a human should chase.
    hot: ["intent=event_enquiry", "intent=room_reservation", "nights>=3"],
    cold: ["intent=general_enquiry"],
  },

  persona: {
    voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
    tone:
      "Warm and unhurried, like a good front desk. Helpful before being useful — " +
      "answer the question first, sell nothing. Never gushing, never scripted.",
  },
};
