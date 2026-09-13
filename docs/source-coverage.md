# Source coverage and setup

Run `npm run source-health` from the Crucix directory to check installed packages,
required credential names, and the last saved sweep. It does not make network
requests or print credential values. Coverage gaps refer to data availability;
they do not mean npm packages are missing.

## Credentials

Enter credentials locally in `.env`, then restart the running service with
`sudo systemctl restart crucix`. Allow the next sweep to finish before checking
the dashboard's Coverage Gaps panel.

| Feed | Required configuration |
| --- | --- |
| ACLED | `ACLED_EMAIL` and `ACLED_PASSWORD` for an account with API access |
| Reddit | `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` for an authorized API application |
| Cloudflare Radar | `CLOUDFLARE_API_TOKEN` with Account Analytics read access |
| Maritime | `AISSTREAM_API_KEY` **and further collector implementation**; the current connector only supplies static chokepoint locations |

Do not paste credentials into screenshots, issue reports, or chat. The health
command checks whether values are present; only a successful sweep establishes
that credentials work.

## Connector findings (September 6, 2026)

- **Bluesky:** `api.bsky.app` successfully serves anonymous post search from this
  machine. The connector now uses that direct AppView endpoint; the cached
  `public.api.bsky.app` search endpoint returned HTTP 403.
- **OpenSky:** a successful response with `states: null` means no aircraft
  observations were returned. It is distinguished from malformed responses and
  HTTP failures. Regions without observations remain coverage gaps: no reports
  do not establish an empty sky.
- **Safecast:** requests now filter `captured_after` (observation time), specify
  CPM units, and use the API's page-size parameter. Safecast's `since` parameter
  filters record update time, which can include old observations uploaded
  recently. Freshness and unit checks are still applied to the returned data.
  Empty responses or timeouts cannot establish current radiation conditions.
- **EPA:** its firewall rejects the shared custom Crucix User-Agent. Using the
  Node runtime's standard identifier restores the public API, including station
  metadata. A live check returned 100 laboratory readings; the newest result
  date was August 20, 2026. These are delayed laboratory results, not live
  radiation measurements. If HTTP 403 returns, the provider requests contact
  with `dmap@epa.gov`, including the request URL, time and public IP.
- **Patents:** the configured legacy search hostname does not resolve following
  the USPTO transition. Crucix now reports the connector as unavailable without
  repeatedly contacting that host or claiming zero patent activity. Migration
  requires a supported replacement service; adding a key alone is insufficient.
- **Comtrade:** the 22-second collection budget sometimes skipped the final
  trade pairs despite working responses. It now has 45 seconds to start paced
  queries, with a 75-second outer deadline for completion and retries. Request
  concurrency and pacing are unchanged.

References: [Safecast API source](https://github.com/Safecast/safecastapi),
[Bluesky API routing](https://docs.bsky.app/docs/advanced-guides/api-directory),
[OpenSky API](https://openskynetwork.github.io/opensky-api/rest.html),
[EPA web services](https://www.epa.gov/enviro/web-services), and
[USPTO transition](https://www.uspto.gov/subscription-center/2026/patentsview-migrating-uspto-open-data-portal-march-20).
