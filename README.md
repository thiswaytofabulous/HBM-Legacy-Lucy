# Legacy Lucy

Haven Built Media's brand-story prep guide, rebuilt from the Legacy Lucy GPT on the Brand Bestie setup: a static page plus Netlify functions, auto-deployed from `main`.

Lucy walks a home care agency owner through one guided conversation before their shoot, then writes their **Legacy Story Summary**. The client gets it on screen, as a branded PDF download, and by email. Jessi gets an alert with the summary, internal team notes (an interview guide, a B-roll shotlist, and watch-outs), and the full conversation. The session also shows up on the TWTF Live Dashboard.

## One-time use, not a pocket strategist

Lucy is prep for a shoot, not an open chat. The server enforces this; it isn't just hidden in the page.

- **Before the summary:** the full interview, capped at 70 client messages (the real flow is about 35).
- **After the summary:** the interview is locked. The client can come back with the same email to read and download their summary, and use **Make an update** up to **3 times**. In update mode Lucy only revises the summary. She won't answer questions, give advice, or write anything else.
- **Each update round** gets up to 3 messages. A round that ends without a new summary still counts as an update, so the update box can't turn into a back-door chat.
- **When updates run out**, the session is fully locked, and the client is told to reply to their summary email.
- **Admin override:** open the session in the admin view and tap **Give 1 more update**.
- **Optional shoot code:** set `CLIENT_CODE` and the landing page asks for it. Send it to booked clients only, so the link can't be passed around.
- Both prompts tell Lucy to stay in her lane. Anything off-topic gets a warm one-line redirect back to the question.

The limits live at the top of `netlify/lib/lucy.js` (`MAX_UPDATES`, `MAX_INTERVIEW_TURNS`, `MAX_UPDATE_TURNS`, `MAX_MESSAGE_CHARS`).

## The flow

Same questions as the GPT's 9/5 expanded flow: welcome → quick context → the beginning → the decision → the impact → the audience → the takeaway → proof points (a story is required) → visual context (the people-on-camera question is asked word for word) → scheduling → anything else → summary. Lucy asks one bolded question at a time, reflects back what she heard, asks if it's right, and drops in Pro Tips. Name and email come from the landing page, so she confirms the email instead of asking for it.

## How it works

| File | Job |
|---|---|
| `index.html` | Landing page, progress bar, chat, summary with PDF/copy, next-steps card with **Make an update**, and the admin view. |
| `netlify/lib/lucy.js` | The brain: both system prompts (interview + update), the summary format, model settings, limits, and the API call. |
| `netlify/lib/gate.js` | The one-time-use lock. Its counters live in their own Blobs store, so page saves can't reset them. |
| `netlify/edge-functions/chat.js` | Streaming chat endpoint (`/api/chat`). Checks the gate, then streams Claude's reply. |
| `netlify/functions/assistant.js` | Non-streaming fallback, with the same gate. |
| `netlify/functions/store.js` | Save / load / gate / admin list / resend / grant, plus both emails. |
| `netlify/lib/summary-pdf.js`, `netlify/functions/pdf.js` | The branded HBM PDF (navy + dusty rose, Montserrat). |
| `netlify/functions/upload.js`, `download.js` | The paperclip, for photos of a space, logos, and inspiration. |

**Summary blocks.** Lucy writes `---BEGIN SUMMARY---`…`---END SUMMARY---` (client-facing), then `---BEGIN TEAM NOTES---`…`---END TEAM NOTES---` (team only). The page, PDF, and client email never show the team notes. Keep the delimiters exactly as they are.

**Sticky completion.** Once a session has a summary, it stays submitted, and a save that would shorten the conversation is ignored. Emails go out only when a save carries a new summary text, never on repeat saves.

**Model.** `claude-opus-5-5` at low effort, so chat stays quick. Server-side refusal fallbacks are on (`fallbacks: "default"`). If the API ever rejects that beta, the call retries once without it.

## Admin access

Type `ADMIN_CODE` into the **Email** field on the landing page. Each session shows the agency, takeaway, updates used and left, and whether both emails were delivered. Open one to copy the summary, team notes, or conversation, **Resend emails**, or **Give 1 more update**.

## Environment variables (set in Netlify, never in the repo)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Powers Lucy. Must be available to Functions (the edge function reads it too). |
| `RESEND_API_KEY` | Sends the emails. |
| `NOTIFY_EMAIL` | Where Jessi's alerts land. Client replies also go here. |
| `NOTIFY_FROM` | Sender, on a domain verified in Resend. Default: `Haven Built Media <noreply@havenbuiltmedia.com>`. |
| `ADMIN_CODE` | Unlocks the admin view and the dashboard feed. |
| `CLIENT_CODE` | Optional. Shoot code required to start or reopen a session. |
| `CLIENT_COPY_BCC` | Optional. Blind copy on every client email. |

## Live Dashboard

The TWTF Live Dashboard (`submission-dashboard` repo) reads sessions from this site's `store` function. On the dashboard site, set `HBM_LUCY_URL` (this site's URL) and `HBM_LUCY_CODE` (this site's `ADMIN_CODE`).

## Deploying

No build step. Open a PR to test on the Netlify deploy preview. Merging to `main` auto-deploys.
