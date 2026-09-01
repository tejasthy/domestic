# Domestic

Chores and shared costs, split fairly — for any house that runs it.

It is the paper chart on the fridge, with the counting done for you. The model
is deliberately the same: every chore owns a fixed rotation of roommates and a
turn counter. Turn *N* belongs to `members[N % members.length]`. Completing a
turn opens the next one. Nothing is ever "reassigned" behind your back, so the
order stays exactly as predictable as the printed sheet.

| From the chart | In the app |
|---|---|
| Floors — 2×/week, Sun & Fri | scheduled chore, `days_of_week: [0,5]` |
| Microwave — biweekly on weekends | scheduled, `days_of_week: [6]`, `interval_weeks: 2` |
| Trash — weekly, out Sunday for Monday pickup | scheduled, `days_of_week: [0]` |
| Dishes (per load), 16 numbered rows | on-demand queue, always 4 turns deep |
| Trash (when full), 16 numbered rows | on-demand queue |
| `AB BK TT NA` printed across each row | `chore_rotation.position` 0–3 |
| Crossing out / initialing a box | `complete_turn()` |

## Stack

- **Next.js 16** (App Router) as an installable PWA — phone first, tablet and
  laptop second, plus a dedicated kiosk view for the iPad on the wall
- **Supabase** — Postgres, magic-link auth, row-level security
- **Vercel** — hosting and the cron that materializes the schedule
- **Claude Opus 5** — receipt scanning (vision → structured JSON)
- **Web Push** — notifications, free, no App Store account needed

All of it fits inside the free tiers.

---

## Setup

### 1. Supabase

Create a project at [supabase.com](https://supabase.com) (free tier). Then in
**SQL Editor**, run every migration in `supabase/migrations/` in numeric order.
They are append-only — never edit one that has already been applied.

Under **Authentication → URL Configuration**, add both
`http://localhost:3000/auth/callback` and
`https://<your-app>.vercel.app/auth/callback` as redirect URLs.

Under **Authentication → Sign In / Providers → Email**, turn *Allow new users to
sign up* **on** — Domestic is meant for anyone to run their own house on, not
just one invited roster. Membership into a *specific* household is still gated
separately: by an invite code, or by being the one who starts it (see
[Households, invites, and modules](#households-invites-and-modules) below).
Signing up for an account and joining a house are two different steps.

### Sign-in providers

Any provider works; the first person to authenticate with a given address gets
a fresh profile with no household, and lands in onboarding to start one or
redeem an invite code.

**Google:**

1. [Google Cloud Console](https://console.cloud.google.com) → new project →
   **APIs & Services → OAuth consent screen**. External; publish it once you're
   ready for the public (not just test users).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`
   (Supabase shows the exact string on the Google provider page — copy it from
   there rather than typing it.)
3. Supabase → **Authentication → Sign In / Providers → Google** → paste the
   client ID and secret, enable.

**Apple** needs a paid Apple Developer account ($99/yr) to issue the Services ID
and signing key. Skip it; Google + email/password covers everyone else fine.

**Email + password** is on by default — Supabase handles it, nothing to
configure. It does need real SMTP, same as magic links below, because signup
confirmation and password-reset both send an email.

**Magic links** are opt-in (`NEXT_PUBLIC_ENABLE_MAGIC_LINK=true`) — an
alternative to typing a password, not a replacement for it.

**Both of the above need real SMTP.** Supabase's built-in sender is rate
limited to roughly **2 messages per hour**, which looks broken rather than
rate-limited the moment more than a couple of people try to sign up around the
same time. Set custom SMTP under **Project Settings → Authentication → SMTP
Settings** — [Resend](https://resend.com)'s free tier works well to start:
host `smtp.resend.com`, port `587`, user `resend`, password = your Resend API
key, sender an address on a domain you've verified with Resend (`onboarding@resend.dev`
works unverified, but Gmail and others are more likely to spam-box it). Then
raise **Authentication → Rate Limits → Emails per hour** to match. Resend's
free tier is 3,000 emails/month; move to a paid plan or SES once you outgrow it.

### CAPTCHA

Once signups are open to the public, bot signups are a real risk. Under
**Authentication → Attack Protection → Bot and Abuse Protection**, enable
**Cloudflare Turnstile**:

1. [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/turnstile)
   → **Turnstile** → add a widget, mode **Managed**, any domain (or your real
   one once you have it).
2. Copy the **site key** into `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
3. Paste the **secret key** into Supabase's Turnstile field and enable it.

Leave `NEXT_PUBLIC_TURNSTILE_SITE_KEY` unset to skip this entirely — fine for
local dev, not recommended once the app is publicly reachable.

### Analytics (optional)

Set `NEXT_PUBLIC_GA_MEASUREMENT_ID` to a GA4 Measurement ID (`G-XXXXXXX`) to
load Google Analytics on every page, marketing and app alike. Leave it unset
and nothing loads — no script, no cookie, no request.

### 2. Environment

```bash
cp .env.local.example .env.local
```

Fill in the Supabase URL, anon key, and service-role key from
**Project Settings → API**. Then generate the rest:

```bash
npm run gen:vapid
```

```bash
npm run gen:secrets
```

Paste both outputs into `.env.local`. `AI_CONFIG_ENCRYPTION_KEY` from
`gen:secrets` protects whichever receipt-scanning key an admin adds later —
that key itself is set per household, in the app (everything else works
without it either way).

> The VAPID keypair is permanent. Regenerating it silently invalidates every
> push subscription, and the only symptom is that notifications quietly stop.

### 3. Create your household

**In the app.** Sign in, and you'll be asked to start a house or join one. Pick
a name, choose which components you want, and you're the admin. Invite everyone
else from **Settings → Household → Invite someone**, which produces a code and a
ready-to-paste message with a join link.

**Or seed it,** if you want 526 Detroit St. exactly as it is on the paper chart —
rotation phases and all. Put everyone's email in `scripts/roommates.json` (the
first person listed becomes admin), then:

```bash
npm run seed
```

Idempotent: edit the JSON and re-run to change names, colors, or emails.

### 4. Run it

```bash
npm run dev
```

### 5. Deploy

Push to GitHub, import the repo at [vercel.com](https://vercel.com), and paste
every variable from `.env.local` into **Settings → Environment Variables**. Set
`NEXT_PUBLIC_SITE_URL` to the real deployed URL. `vercel.json` already registers
the two daily cron runs (9am and 6pm Eastern) that materialize upcoming turns
and send the "you're up" digest.

---

## Households, invites, and modules

**Anyone can run their own house.** There is no hardcoded household — the first
person to sign in creates one and becomes its admin. Everything is scoped by
`household_id` and enforced in row-level security, tested against a real
non-superuser role.

**Membership comes from invites, not from how you sign in.** An admin generates
a code (`AB3D-9XKM`) that carries an optional name, initials, and color, plus an
expiry and a use count. It can be locked to one email address or left open for
anyone with the link. Google, magic link, or anything added later all resolve
through the same roster.

Joining mid-cycle is safe: you're appended to the end of every active rotation
and all *pending* turns are re-derived. Completed turns are history and never
change — adding a roommate doesn't rewrite who did the dishes last Tuesday.
Removing someone closes the gap in the rotation so `turn % n` can't point at a
hole.

**Every house is different, so components are modular.** Admins choose what
their household tracks under **Settings → Household**. The registry lives in
[`src/lib/modules.ts`](src/lib/modules.ts); the database only stores which keys
are on, so shipping a new module is a code change plus its routes — not a
migration, and not a backfill for existing households.

Turning a module off hides it everywhere — navigation, the Today screen, the
kiosk, and the Home Assistant payload — and its routes return 404. Nothing is
deleted; switch it back on and the history is where you left it.

Adding a module means: add an entry to `MODULES`, build its pages under the
route prefix you declared, and call `requireModule('yourkey')` at the top of
each one.

---

## The kiosk iPad

An admin generates a pairing link under **Settings → Household → Wall display**,
then opens it once on the tablet. The token moves into an httpOnly cookie and
disappears from the address bar, so it isn't readable off the wall by anyone who
wanders past.

The link is shown once and never again — only its SHA-256 hash is stored. A
device token resolves to exactly the household that issued it, which is what
makes the kiosk safe to run for more than one house. The kiosk then loads
`/kiosk` with no login, refreshes itself every 45 seconds, and shows who is up,
what is coming, balances, and a live activity feed at across-the-room type size.

On the iPad: **Settings → Display & Brightness → Auto-Lock → Never**, then open
the page in Safari and **Share → Add to Home Screen** so it runs full-screen
without browser chrome. Guided Access (**Settings → Accessibility → Guided
Access**) locks it to that one app.

## Installing on a phone

Domestic is a web app you add to your Home Screen — no App Store, no developer
account, no review.

A prompt appears at the bottom of the screen on first visit. On Android and
desktop Chrome it triggers the browser's own install flow. iOS has no
programmatic install at all, so there it shows exactly where to tap: Share →
Add to Home Screen. Dismissal is remembered per device, since installing is a
per-device act.

New members get a short walkthrough on first sign-in, built from the modules
their household actually runs — nobody is taught a feature their house switched
off. It's replayable from **Settings → Help**, and the fact that you've seen it
lives on your profile, so it doesn't reappear when you open the app on a tablet.

## Notifications on iPhone

iOS only delivers web push to **installed** web apps, which is the main reason
the install prompt exists. Once Domestic is on your Home Screen, open it from
there and turn notifications on in Settings. The app detects the uninstalled
case and says so, rather than silently failing — which is what most PWAs do, and
why people assume iOS push doesn't work.

Quiet hours default to 10pm–8am per person and are enforced server-side.

## Receipt scanning

An admin adds a provider and API key under **Settings → Household → Receipt
scanning** — Claude or Gemini, whichever they have a key for. The key is
encrypted at rest and never sent back to any browser, including the admin's
own; nothing works until one is configured.

Tap **Scan a receipt** when adding an expense. The photo is downscaled in the
browser to 1568px (Claude's maximum useful resolution — this also converts
iPhone HEIC to JPEG on the way through), sent to `/api/receipt`, and read with
a strict output schema. Merchant, total, date, and category prefill the form.

It is prompted to report only what it can actually read and to flag illegible
photos rather than guess — the fields are always editable, and you should glance
at the total before saving. Roughly a cent per scan.

---

## Home Assistant → HomeKit

**HomeKit has no cloud API.** Nothing on the internet can create a HomeKit
accessory. The only route is a device on your LAN running Home Assistant (or
Homebridge) that publishes accessories over the local network. So the shape is:

```
Domestic (Vercel)  ──REST──▶  Home Assistant (Pi at the house)  ──▶  HomeKit
```

`/api/ha` is already built for this. Generate a Home Assistant device token
under **Settings → Household**, and send it as `Authorization: Bearer <token>`.
Like the kiosk token it resolves to one household — there is no global API key,
because a shared secret can't say which house it speaks for. A kiosk token will
not open the Home Assistant surface, or the reverse.

**`GET /api/ha`** returns a flat snapshot: `open_count`, `overdue_count`,
`due_today_count`, plus per-chore and per-person detail.

```yaml
# configuration.yaml
rest:
  - resource: https://<your-app>.vercel.app/api/ha
    scan_interval: 300
    headers:
      Authorization: !secret domestic_token
    sensor:
      - name: "Chores Overdue"
        value_template: "{{ value_json.overdue_count }}"
      - name: "Chores Due Today"
        value_template: "{{ value_json.due_today_count }}"
      - name: "Tejas Open Chores"
        value_template: >
          {{ value_json.people | selectattr('initials','eq','TT')
             | map(attribute='open_chores') | first }}
```

**`POST /api/ha`** accepts `{"action":"flag","chore":"dishes"}` or
`{"action":"complete","turn_id":"<uuid>"}` — so an HA script, a button on the
wall, or a HomeKit scene can flag the dishwasher.

```yaml
rest_command:
  domestic_flag_dishes:
    url: https://<your-app>.vercel.app/api/ha
    method: POST
    headers:
      Authorization: !secret domestic_token
      Content-Type: application/json
    payload: '{"action":"flag","chore":"dishes"}'
```

Expose the sensors to HomeKit with Home Assistant's **HomeKit Bridge**
integration, and "Hey Siri, are there chores overdue?" works.

**Hardware:** a Raspberry Pi 5 (8GB) booting from an **NVMe SSD**, not a microSD
card — SD cards die under database write cycles, and that is the single most
common way these setups fail. Pair it with Tailscale or Cloudflare Tunnel for
remote access. The Pi is purely additive: if it dies, the app is unaffected,
because the app doesn't live there.

---

## Layout

```
supabase/migrations/   schema, rotation engine (plpgsql), row-level security
src/lib/
  rotation.ts          pure turn-order logic
  money.ts             cent-safe splitting + minimum-cash-flow settle-up
  actions.ts           server actions
  data.ts              server-side reads
  push.ts              web push fan-out, quiet hours, dead-subscription pruning
  kiosk.ts             service-role reads for the wall display
src/app/
  (app)/               the authenticated app — today, chores, money, settings
  kiosk/               the wall iPad
  api/receipt          Claude vision receipt OCR
  api/cron             materialize schedule + daily digest
  api/ha               Home Assistant bridge
scripts/seed.mjs       household, roommates, and the five chores off the chart
```

## Tests

```bash
npm test
```

Covers the two places a bug costs real money or real arguments: cent-safe
splitting (splits always sum to the total; balances never drift) and rotation
order (turn *N* is always the same person, 4000 turns out).

```bash
npm run test:db
```

Runs the migrations against a throwaway Postgres 16 container and exercises what
only exists in SQL — the rotation engine, the balance views, and row-level
security (checked as a non-superuser, since `postgres` bypasses RLS and would
pass no matter what the policies said). Needs Docker. See
`supabase/tests/README.md`.

## Design

Ported from the U-M Modernist design system: Maize `#FFCB05` and Blue `#00274C`,
IBM Plex Sans/Mono with Oswald for display, a cool gray scale tied to blue's
hue, and the same radius/shadow/motion ramps. Tokens live at the top of
`src/app/globals.css`; the semantic layer under them is what every component
actually references, so re-theming is one block of variables. Light and dark
both ship.

## License

MIT — see [LICENSE](LICENSE). Run your own copy, change it, deploy it for your
own house. Nothing here is hardcoded to one household.
