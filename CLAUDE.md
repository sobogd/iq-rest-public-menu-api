# iq-rest-public-menu-api

NestJS + Prisma backend for the IQ Rest **public menu** — the guest-facing app served from `<slug>.iq-rest.com`. It serves restaurant + menu data by slug, accepts diner orders and reservations, and tracks anonymous page views. The same Postgres database is shared with `iq-rest-dashboard-api`.

## Build rule on this server (read first)

This server has ~3.7 GB RAM. **DO NOT run production builds here**:

- Forbidden: `npm run build`, `nest build`, `npm start:prod`.
- Allowed for type checks: `npx tsc --noEmit`.
- Allowed: `npm run dev` (NestJS watch — dev process may already be running under PM2), `npm run lint`, `prisma generate`, `prisma migrate deploy`.
- All production builds happen in GitHub Actions on push; artifacts are deployed to `/home/deploy/apps/iq-rest-public-menu-api/` and PM2 runs them as `public-menu-api`.

## Where it fits in IQ Rest

```
guest browser (<slug>.iq-rest.com)
        |
        v
[iq-rest-public-menu]   <-- guest-facing Vite/React PWA (sibling repo)
        |  fetch
        v
[iq-rest-public-menu-api]  <-- this repo (Nest, port 8131)
        |  Postgres + pg_notify('orders_events')
        v
[Postgres (shared)]  <--  [iq-rest-dashboard-api] (Nest, port 8130)
                                       ^
                                       | SSE
                              [iq-rest-dashboard-web] (Vite/React)
```

## Tech stack

- **NestJS 10** (`@nestjs/common/core/platform-express/config/throttler`)
- **Prisma 6** (`@prisma/client`) + raw `pg` Pool (only for `pg_notify`)
- **Zod** for request validation in controllers (NestJS `ValidationPipe` also active globally)
- **helmet**, **cookie-parser**, **ua-parser-js**
- **nodemailer** (transactional reservation emails)
- **TypeScript 5.7**, Node 22

## Repository layout

```
src/
  main.ts                       # bootstrap (helmet, cookies, CORS, ValidationPipe, global /api prefix)
  app.module.ts                 # root module + ThrottlerGuard wiring
  common/
    all-exceptions.filter.ts    # global error filter
  prisma/
    prisma.module.ts
    prisma.service.ts
  health/
    health.controller.ts        # GET /api/health
  menu/
    menu.module.ts
    menu.controller.ts          # GET /api/public/menu/:slug
    menu.service.ts
  orders/
    orders.module.ts
    orders.controller.ts        # POST /api/public/orders
    orders-notifier.service.ts  # pg_notify publisher (channel: orders_events)
  reservations/
    reservations.module.ts
    reservations.controller.ts  # GET /api/public/reservations/availability, POST /api/public/reservations
  analytics/
    analytics.module.ts
    analytics.controller.ts     # POST /api/analytics/track
  mail/
    mail.module.ts
    mail.service.ts             # nodemailer + per-locale email templates
    locales/<lang>.json         # 30+ locales (ar, bg, ca, cs, da, de, el, en, es, et, fa, fi, fr, ga, hr, hu, is, it, ja, ko, lt, lv, nl, no, pl, pt, ro, ru, sk, sl, ...)
prisma/
  schema.prisma                 # shared schema (synced with dashboard-api)
.env.example
nest-cli.json
tsconfig.json / tsconfig.build.json
```

## Commands

```bash
npm run dev              # nest start --watch  (dev mode)
npm run start            # nest start          (no watch)
npm run lint             # eslint --fix
npx tsc --noEmit         # type-check only (use this instead of build)
npm run prisma:generate  # prisma generate
npm run prisma:deploy    # prisma migrate deploy   (against the shared DB — be careful)
```

**FORBIDDEN on this server:** `npm run build`, `nest build`, `npm run start:prod`. GitHub Actions handles all builds.

## Environment variables

From `.env.example` and runtime reads (`ConfigService.get(...)` in `main.ts`, `mail.service.ts`, `orders-notifier.service.ts`):

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `8131` |
| `NODE_ENV` | env name | `development` |
| `DATABASE_URL` | Postgres DSN (shared with dashboard-api) | required |
| `CORS_ORIGINS` | comma-separated extra allowed origins (local dev URLs) | none |
| `CORS_PATTERN` | regex allowed in addition to `CORS_ORIGINS` | `^https?://([a-z0-9-]+\.)?iq-rest\.com(:\d+)?$` |
| `SMTP_HOST` | nodemailer host | none (mail disabled if missing) |
| `SMTP_PORT` | nodemailer port (`465` → TLS) | `587` |
| `SMTP_USER` | SMTP user | none |
| `SMTP_PASS` | SMTP pass | none |
| `FROM_EMAIL` | "From" header | falls back to `SMTP_USER` |
| `DASHBOARD_URL` | base URL embedded into owner-notification email links | `https://dashboard.iq-rest.com` |

## Bootstrap (`src/main.ts`)

- `bufferLogs: true`
- `helmet({ contentSecurityPolicy: false, strictTransportSecurity: false, crossOriginResourcePolicy: false })`
- `cookieParser()`
- CORS:
  - `credentials: true`
  - Accepts: any origin matching `CORS_PATTERN` (default any `*.iq-rest.com`), any origin in `CORS_ORIGINS`, and no-origin requests (curl / server-to-server).
- `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false })`
- Global `AllExceptionsFilter`
- Global prefix `api` → all routes below are exposed as `/api/<route>`
- Listens on `PORT` (default 8131)

## Throttling

Global `ThrottlerGuard` wired in `app.module.ts`: 600 requests / 60s per IP, scope `default`.

## Modules and endpoints

### Health (`src/health/health.controller.ts`)
- `GET /api/health` → `{ ok: true, time }`

### Menu (`src/menu/`)
- `GET /api/public/menu/:slug` (`menu.controller.ts`) → returns the bundle a diner needs:
  - `restaurant`: branding + flags (title, slug, accentColor, currency, hideTitle, menuLayout, contacts, languages/defaultLanguage, reservation* flags, order* flags, x/y/googlePlaceId, company {id, plan, subscriptionStatus, trialEndsAt})
  - `categories`: active + non-deleted, with `translations`, `isGroup`, `parentId`
  - `items`: active + non-deleted **and** whose category is non-deleted (defensive — orphans hidden); includes `translations`, `allergens`, `diets`, `imageUrl`; `price` cast to number
  - `tables`: active + non-deleted, with `translations` + `imageUrl`
- Throws `NotFoundException("restaurant not found")` if slug missing.

### Orders (`src/orders/`)
- `POST /api/public/orders` (`orders.controller.ts`):
  - Body (Zod):
    `{ slug, items?: object[] (≤500), total?, customerName?, customerPhone?, customerAddress?, comment?, tableNumber? }`
  - **In-memory rate limit** keyed by `<ip>:<slug>`: 10 requests / 1 hour. IP is resolved from `cf-connecting-ip`, then `x-forwarded-for`, then `req.socket.remoteAddress`. Beware: in-memory only — multiple instances would each have their own counter.
  - Reads `restaurant.{ordersEnabled, orderMode, currency, companyId}` by `slug`. 404 if missing or `ordersEnabled=false`.
  - For `orderMode ∈ {"internal", "both"}` and non-empty `items`:
    - Computes today's date in UTC and the next `dailyNumber` for the restaurant (`max(dailyNumber)+1`).
    - Retries up to 5 times on Prisma `P2002` (unique-violation race on `(restaurantId, orderDate, dailyNumber)`).
    - Fire-and-forget `OrdersNotifierService.publishCreated(restaurantId, order)`.
  - Returns `{ ok: true, mode }`. For `whatsapp`-only mode the client builds a `wa.me` deep link, server only logs/tracks (no DB row).

- **`OrdersNotifierService`** (`orders-notifier.service.ts`): owns a small `pg` Pool (`max: 2`). Publishes JSON payloads on channel `orders_events`. Payload shape:
  - `{ action: "created", restaurantId, order }`
  - `{ action: "booking-created", restaurantId, booking }`
  - If payload > 7800 chars, falls back to `{ action, restaurantId }` only (Postgres NOTIFY size limit ≈ 8 kB).
  - **Listener lives in `iq-rest-dashboard-api`**, which forwards events to dashboard SSE clients (KDS, waiter, reservation kiosks).

### Reservations (`src/reservations/`)
- `GET /api/public/reservations/availability?slug=&date=YYYY-MM-DD&time=HH:MM&guests=N`:
  - Returns 30-minute-step time slots within the day's open windows, with `availableTables` count per slot.
  - "Is slot in the past" is compared against the **restaurant's local clock** using its `timezone` (Intl.DateTimeFormat) — not the server's UTC clock.
  - Honors `reservationSchedule` (per-day array of `{closed, from, to, lunchFrom, lunchTo}`, index 0=Mon..6=Sun) or falls back to legacy `workingHoursStart/End`.
  - If `time` is provided, also returns `tables` array marking which tables are bookable at that exact time.
- `POST /api/public/reservations`:
  - Body (Zod): `{ restaurantId, tableId?, date (YYYY-MM-DD), startTime (HH:MM), guestName, guestEmail, guestPhone?, guestsCount, notes?, locale? }`
  - Computes slot duration from `restaurant.reservationSlotMinutes`.
  - Auto-picks a free suitable table if `tableId` not supplied; rejects with `table_not_suitable` / `table_taken` / `no_tables_at_time`.
  - Status = `"confirmed"` if `restaurant.reservationMode === "auto"`, else `"pending"`.
  - Fire-and-forget:
    - Guest email via `MailService.sendGuestEmail(...)`
    - Owner email via `MailService.sendOwnerEmail(...)` to every email under `restaurant.company.users[].user.email`
    - `OrdersNotifierService.publishBookingCreated(...)` → paired RESERVATION kiosk in dashboard-web receives it via SSE
  - Returns the created reservation row.

### Analytics (`src/analytics/`)
- `POST /api/analytics/track`:
  - Body (Zod): `{ slug, page, language, referrer? }`
  - Resolves restaurant by slug → silently returns `{success: false}` if unknown (intentional — no 4xx for tracking).
  - Reads/sets cookie `sqr_session_id` (UUID, httpOnly, sameSite=lax, secure when request is secure).
  - Persists `PageView { companyId, restaurantId, sessionId, page, language, referrer, userAgent, ip }`.
  - IP resolution: `cf-connecting-ip` → first of `x-forwarded-for` → null.

### Mail (`src/mail/`)
- `MailService` — singleton with a lazy pooled `nodemailer` transporter (`pool: true, maxConnections: 5`); `secure: true` only when port = 465.
- Closes the transporter in `onModuleDestroy`.
- Loads per-locale JSON from `src/mail/locales/<lang>.json` (35-ish locales — see directory listing). Falls back to `en.json` if a locale's file is missing.
- `sendGuestEmail(...)` — HTML + plaintext confirmation/pending email to the diner. Subject and body interpolate `{name}`, `{restaurant}`.
- `sendOwnerEmail(...)` — HTML + plaintext notification to all company owners (first as `To:`, the rest as `Bcc:`), with a deep link to `${DASHBOARD_URL}/dashboard/reservations?from=email`.
- If SMTP not configured (any of `SMTP_HOST/USER/PASS/FROM_EMAIL` missing), `sendGuestEmail` logs a warning and skips; `sendOwnerEmail` silently no-ops.

### Common
- `AllExceptionsFilter` (`src/common/all-exceptions.filter.ts`) — global error handler installed in `main.ts`.

## Prisma models (shared schema, `prisma/schema.prisma`)

The schema is intentionally mirrored with `iq-rest-dashboard-api` — both services read/write the same Postgres DB. Dashboard owns migrations; this service runs `prisma migrate deploy` against an already-migrated DB.

| Model | Purpose (only fields this service touches noted) |
|---|---|
| `User` | Owners — read indirectly via `restaurant.company.users[].user.email` for owner-notification emails |
| `Session` | Owner sessions — not read here (handled by dashboard-api) |
| `Company` | Plan / subscriptionStatus / trialEndsAt surfaced via `/menu/:slug` |
| `Restaurant` | Read for menu / reservations / orders / analytics resolution; many fields surfaced (branding, hours, schedule, modes, currency, contacts) |
| `Table` | Read for menu + reservation availability + table booking |
| `Reservation` | Read (availability) + Created (booking) |
| `Category` | Read for menu (`isGroup`, `parentId`, soft-delete aware) |
| `Item` | Read for menu (allergens, diets, options JSON, translations, soft-delete aware) |
| `UserCompany` | Read indirectly to gather owner emails |
| `PageView` | Created by analytics/track |
| `SupportMessage` | Not touched here |
| `UsageEvent` | Not touched here (SSR-driven from landing) |
| `Order` | Created when `orderMode ∈ {internal, both}` and `items` non-empty |
| `GoogleAdsExclusion` | Not touched here |

## Cross-service contract

- **Real-time order/reservation broadcast** uses Postgres `LISTEN/NOTIFY` on channel `orders_events`. This service is the **publisher only**; `iq-rest-dashboard-api` is the listener and fans events out over SSE.
- **Shared cookie domain** with the landing + dashboard apps: cookies need to interop within `*.iq-rest.com`.
- **Timezone-aware reservation logic** depends on `Restaurant.timezone` (IANA, e.g. `Europe/Rome`) being populated by dashboard-api.

## Deployment

GitHub Actions builds on push → uploads to `/home/deploy/apps/iq-rest-public-menu-api/` → PM2 process `public-menu-api` runs `node dist/main` from there on port 8131.

## Related repositories

- `iq-rest-public-menu` — guest-facing PWA that consumes this API
- `iq-rest-dashboard-api` — sibling backend (auth, dashboard ops, owns the same schema and migrations; SSE fan-out for orders_events)
- `iq-rest-dashboard-web` — dashboard UI + KDS / waiter / reservation kiosk web apps
- `iq-rest-landing` — marketing landing (`iq-rest.com`); not maintained

## Conventions

- Zod for request body validation; Nest `ValidationPipe` for class-validator DTOs is also active (currently used minimally).
- Soft-deletes via `deletedAt` on `Restaurant`, `Table`, `Category`, `Item`, `Order` — every diner-facing read filters them out.
- Decimal money fields (`price`, `total`) are cast to `Number()` on the way out of the menu endpoint; consumers must accept Decimal-or-number for orders.
- Never throw from background side effects (emails, `pg_notify`); always `.catch(...)` / `void` to avoid blocking the diner request.
