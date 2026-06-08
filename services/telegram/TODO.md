# TODO(G): Module A — Telegram OSINT geoparse layer (DEFERRED)

Status: **not built.** Deferred by decision on 2026-06-08.

## Why it was not ported

The task brief said to port Module A verbatim from OSIRIS:

> Telegram → `src/app/api/telegram-feed/`
> Geoparse post text against the multilingual place dictionary ported from
> OSIRIS (EN + Cyrillic + Arabic). Port OSIRIS's dictionary verbatim into
> `services/telegram/places.mjs`.

**That source does not exist in the OSIRIS repo** (`github.com/simplifaisoul/osiris`,
cloned to `~/osiris-ref`). Verified absences:

- No `src/app/api/telegram-feed/` route (or any `telegram-*` route).
- No geoparse logic and no place/gazetteer dictionary anywhere in `src/`
  (`grep -ri "geoparse|gazetteer|placeDict"` → no matches).
- The only `telegram` hits in OSIRIS are unrelated mentions in news/markets/
  space-weather sources.

So there is nothing to port "verbatim," and the porting rules explicitly
forbid guessing schemas / inventing dictionaries. Rather than fabricate a
place dictionary and a t.me scraper schema, the module was deferred.

## What is needed to build it

Provide ONE of:

1. The real source location for the Telegram + geoparse code (a different
   repo, branch, or path) so it can be ported faithfully; **or**
2. A green light to build it from scratch as original work, accepting that:
   - the t.me/s post-parsing schema will be designed here (not ported), and
   - the EN/Cyrillic/Arabic place dictionary will be hand-authored.

## Planned shape (when unblocked)

Matches the additive pattern used for the CCTV and Sanctions modules:

- `services/telegram/telegramFeed.mjs` — fetch `https://t.me/s/<channel>`
  (unauthenticated web preview; no Bot API / no MTProto), parse text + ts +
  permalink, geoparse against `places.mjs`, 12-minute in-memory cache,
  skip dead channels gracefully.
- `services/telegram/places.mjs` — multilingual place → {lat,lon} dictionary.
- `services/telegram/telegramRouter.mjs` — `GET /api/telegram/posts`
  → `{ posts: [...], updated: <iso> }`.
- Env `CRUCIX_TELEGRAM_CHANNELS` (comma-separated handles).
- Frontend: a standalone page (e.g. `dashboard/public/telegram.html`) with a
  cyan Globe.gl points layer for geolocated posts — same isolated, standalone
  approach used for `cctv.html` (Crucix has no modular panel/layer registry
  to hook into, despite the brief assuming one).

Integration hooks in `server.mjs` would mirror the other two modules:
`import telegramRouter` + `app.use('/api/telegram', telegramRouter)`.
