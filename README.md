# soareverix.com

The personal site of Michael Andrzejewski (Soareverix). It is now a single conversation with **Karyon**, an agent attempting CEV for Michael, beside gold-on-black ASCII art that changes with the topic.

1. **Intro.** Black, then two ASCII eyes open, look around the room, find the visitor, and blink. It's drawn live, so every load plays the same. It lasts about 4 seconds and a click skips it.
2. **Greeting.** Karyon's opening line types out beneath the eyes, then the chat bar and a few suggested questions fade in.
3. **Conversation.** At 1080px wide and up, the eyes move to a stage on the left and the conversation takes the right. When Karyon calls `paint_background`, the eyes rise and the painting decodes under them. Clicking the painting lets the visitor draw on it, and "Show Karyon" sends the drawing as a small block of text. Clicking the eyes clears the painting and brings them back. On narrower screens the eyes sit in a band at the top, and the art stays dim behind the text.
4. **Expressions.** The eyes are wide by default, narrow while Karyon thinks, and Karyon can set them with `set_eyes` (`wide`, `focused`, `suspicious`, `warm`, `surprised`).
5. **Lightning.** Karyon can end a conversation with `end_conversation`. A bolt strikes the chat, the eyes shut, and a static page replaces it. See "Ending a conversation" below.
6. **Static page.** Everything about Michael written out. "Read without chatting" in the footer opens the same page for anyone.

Every conversation is logged to Cloudflare D1, and API spend is capped at **$1.00 per UTC day**.

## How it fits together

```
public/                      static site (Cloudflare Pages output directory)
  index.html                 page shell
  assets/ascii.js            ASCII engine + the scene library
  assets/app.js              intro, chat client, lightning, static page
  assets/karyon.css
  admin.html                 log viewer (needs ADMIN_TOKEN)
functions/                   Cloudflare Pages Functions
  api/chat.js                POST /api/chat: Claude call, tool loop, streaming, logging
  api/status.js              GET /api/status: is Karyon awake / within budget
  api/admin/conversations/   GET log list and full transcripts (Bearer ADMIN_TOKEN)
  _lib/karyon.js             system prompt assembly, tool definitions, scene list
  _lib/closures.js           who Karyon has stopped talking with, and until when
  _lib/budget.js             D1 spend ledger with worst-case holds
  _lib/pricing.js            per-model prices
karyon/persona.txt           who Karyon is and how it behaves
karyon/context.txt           what Karyon knows about Michael (public!)
schema.sql                   D1 tables
wrangler.toml                bindings and settings
scripts/                     local mock API, end-to-end test, live smoke test
```

### The ASCII engine

Each scene is drawn with ordinary canvas calls in greyscale onto a small offscreen canvas (2 × 4 samples per character cell). Every frame the engine reads it back and picks glyphs: flat areas use a brightness ramp (` .:-=+;ilcueadLCUEAD#@`), and edges use `| / - \` chosen from the local gradient orientation, which gives the outlined look of the reference frames. Glyphs come from a pre-tinted gold atlas and a blurred copy adds the glow. A scene change "decodes" from the old picture to the new one along a noisy wavefront.

Scenes: `eyes`, `horizon`, `planet`, `eclipse`, `galaxy`, `fire` (Staravorix), `gears` (Vintage Story), `network` (alignment research), `fireworks`, `meadow`, `seed`, `city`, `library`, `lanterns`, and `custom`, where Karyon draws its own SVG and the engine turns it into ASCII. To add a scene, add `SCENES.name = { init, draw }` in `public/assets/ascii.js` and a one-line description under the same name in `SCENES` in `functions/_lib/karyon.js` (that description is what Karyon reads when choosing).

Test hooks for screenshots: `?skip=1` skips the intro, `?scene=planet&mode=chat` shows a scene, `&t=5&pause=1` freezes it at 5 seconds.

### Karyon

- **Models.** Claude Haiku 5.5 answers all day, at `medium` effort with adaptive thinking. `KARYON_MODEL` and `KARYON_ECONOMY_MODEL` are both Haiku 5.5, so the $0.50 switch changes nothing. To start on a stronger model, set `KARYON_MODEL` to it (for example `claude-opus-5-5`, which runs at `low` effort) and name it in `karyon/persona.txt`. Haiku then takes over after $0.50. Each reply is labelled with the model that wrote it.
- **Refusal fallback.** Haiku 5.5 has no server-side fallback, so a Haiku refusal gets a polite deflection. If `KARYON_MODEL` is an Opus-class model, its requests opt into the API's server-side fallback (`fallbacks: "default"`), so a declined request is retried on Anthropic's recommended model instead of failing. Set `KARYON_FALLBACKS = "off"` to disable it.
- **Prompt.** `persona.txt` + `context.txt`, cached across all visitors. A short note after each visitor message tells Karyon which scene is showing and today's date.
- **Tool loop.** If Karyon calls `paint_background` or `set_eyes`, the server validates the input (for `custom`, an SVG with no scripts, links, or images), streams a `scene` or `eyes` event to the browser, returns the tool result, and Karyon continues with its reply. That's at most three API calls per visitor message.
- **History.** Earlier turns come from D1, not the browser, as plain text. Visitors can't forge Karyon's side of the conversation.

### Ending a conversation

`end_conversation` takes a private `reason`, which is logged for Michael as an `ended: <reason>` event in `messages`. `karyon/persona.txt` says when Karyon may use it: sustained abuse, threats, or repeated attempts to make it say something false or harmful, with one warning first unless it's a serious threat.

Karyon then stops talking with that visitor for a day. A second ending within 90 days makes it a week, and a third makes it a month. `/api/status` tells the page, which goes straight to the static page, and `/api/chat` refuses before any API call.

- Visitors are identified by a hash of their IP, so everyone behind one address shares a closure.
- To lift a closure, delete that visitor's `ended:` rows from `messages`. To see them all:
  ```bash
  npx wrangler d1 execute karyon --remote --command "SELECT m.created_at, m.content, c.visitor FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'event' AND m.content LIKE 'ended:%' ORDER BY m.id DESC"
  ```

### Spend limit

`functions/_lib/budget.js` keeps a ledger in D1. Before each API call it places a hold for that call's worst case (every prompt token billed as a fresh cache write, the reply running to `max_tokens`). The insert and the limit check are one SQL statement, so concurrent visitors can't overshoot the day. After the call it books the real cost from the response's `usage` and releases the hold. Holds expire after 10 minutes, so a crashed request can't lock the budget. When the day is spent, Karyon says it's resting until midnight UTC and makes no API call.

Rough costs, with the ~8–9K-token cached prompt: a Haiku 5.5 reply is about $0.001, so $1 covers several hundred replies or more. For comparison, an Opus 5.5 reply is about $0.01–0.02 (plus about $0.04 when the cache is cold). Per-visitor limits (60 messages a day, 40 per conversation, 1,500 characters per message) keep one visitor from spending it all.

**Also set a spend limit on the API key's workspace in the [Anthropic Console](https://console.anthropic.com/)** (for example $35 a month) as a second backstop.

### Logs

Everything is in D1: each visitor message; each reply with the raw content blocks of every API response (thinking-block signatures, tool calls, fallback blocks), model, scene, token counts, and cost; every refusal, limit, and error. Visitors are identified by a salted hash of their IP, never the IP itself, plus country and user agent.

- Browse: open `/admin.html` and paste `ADMIN_TOKEN`. It can export everything as JSON.
- Command line: `npm run logs` (recent conversations) or `npm run logs:export` (full SQL dump).

## Setup (Cloudflare Pages)

The repo is already connected to Pages. After merging:

1. **Build settings:** set the build command to `npm ci`. `wrangler.toml` sets the output directory to `public`, and the dashboard value is ignored.
2. **D1:**
   ```bash
   npx wrangler d1 create karyon
   ```
   Paste the printed `database_id` into `wrangler.toml`, commit, then create the tables:
   ```bash
   npm run db:init
   ```
3. **Secrets** (Pages project → Settings → Variables and Secrets, or from the CLI):
   ```bash
   npx wrangler pages secret put ANTHROPIC_API_KEY --project-name soareverix-site
   ```
   ```bash
   npx wrangler pages secret put ADMIN_TOKEN --project-name soareverix-site
   ```
   ```bash
   npx wrangler pages secret put LOG_SALT --project-name soareverix-site
   ```
   `ADMIN_TOKEN` and `LOG_SALT` should each be a long random string (`openssl rand -hex 32`).
4. **Plan:** the Workers free plan allows 10 ms of CPU per request. A streamed reply usually fits, but if replies cut off with error 1102, move to Workers Paid.

## Settings

In `wrangler.toml` `[vars]`: `DAILY_LIMIT_USD`, `KARYON_MODEL`, `KARYON_ECONOMY_MODEL`, `KARYON_ECONOMY_AFTER_USD`, `KARYON_EFFORT`, `KARYON_ECONOMY_EFFORT`, `KARYON_FALLBACKS`, `MAX_MESSAGES_PER_VISITOR_PER_DAY`, `MAX_TURNS_PER_CONVERSATION`, `MAX_MESSAGE_CHARS`.

## Run locally

```bash
npm install
```
```bash
cp .dev.vars.example .dev.vars
```
```bash
npm run db:init:local
```
```bash
npm run dev
```

Then open http://localhost:8788.

- `npm run mock` starts a fake Messages API on port 4010 that streams real event shapes (repaint, then reply). Set `ANTHROPIC_BASE_URL=http://127.0.0.1:4010` in `.dev.vars` to use it.
- `npm run test:e2e` checks everything against the mock: intro, greeting, streamed reply, repaint, caption, expressions, lightning, the static page, D1 logging, the admin API, the switch to Haiku after $0.50, and the hard stop at $1. It pins Opus 5.5 as the primary model so the switch still gets tested.
- `npm run smoke` has a short live conversation with **Haiku 5.5** through the real site code. It needs a real key in `.dev.vars`, and `npm run smoke -- claude-opus-5-5` uses Opus instead.

## Privacy note

`karyon/context.txt` is everything Karyon knows about Michael. This repository is public, and a visitor can ask Karyon to repeat what it knows, so treat that file as published. It was assembled from the old site's copy, the resume, the Making Beautiful Things talk, and the Diversified Utopia and Code documents. Phone, email, family, relationships, and health were deliberately left out. Edit it freely: Karyon picks up changes on the next deploy.

## The Little Ones

An Easter egg. Their notes are in `karyon/littles.txt`, and their paintings are in `public/assets/ascii.js`. `functions/api/chat.js` gives Karyon the notes and paintings only after a visitor has typed one of their names in that conversation. The system prompt and static page don't mention them.
