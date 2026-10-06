# Social DM leads (Instagram + Facebook Messenger)

Someone DMs the page → GHL creates the contact → a GHL workflow posts it to us →
we create a lead (tags, score, note, opportunity) → it shows in the admin.

## 1. In GHL — connect messaging
Settings → Integrations → Facebook & Instagram. The page needs permission to send
and receive messages; for Instagram, switch on the messages toggle. DMs then land
in Conversations.

## 2. Make the server reachable
GHL cannot call `localhost`. For a demo run a tunnel, e.g.
`cloudflared tunnel --url http://localhost:3000` (or ngrok), and use the HTTPS URL
it prints. Set `GHL_WEBHOOK_SECRET` in `.env` first (`openssl rand -hex 24`).

## 3. In GHL — one workflow
Automation → Workflows → Create:

- **Trigger:** *Customer Replied* → filter **Reply Channel** = Instagram DM and
  Facebook Messenger (one workflow per channel is clearest).
- **Action:** *Custom Webhook*
  - Method `POST`, URL `https://<your-tunnel>/webhooks/ghl`
  - Header `x-webhook-secret` = your `GHL_WEBHOOK_SECRET`
  - Body (JSON):
    ```json
    {
      "channel": "Instagram DM",
      "contact_id": "{{contact.id}}",
      "full_name": "{{contact.name}}",
      "email": "{{contact.email}}",
      "phone": "{{contact.phone}}",
      "message": "{{message.body}}"
    }
    ```
    For the Facebook workflow set `"channel": "Facebook Messenger"`.

## What to expect
- One lead per person: the first DM creates it, later messages from the same
  contact are recognised as the same lead.
- A DM contact usually has no email or phone, so there is **no email follow-up** —
  the lead is kept, identified by its GHL contact id.
- The payload shape has never been captured from a real account. If a field is
  empty, open the lead in the admin (Leads → row) — the original payload is stored
  and can be replayed after a parser fix.
- GHL's own DM reply action only works within 24 hours of the person's last
  message.
