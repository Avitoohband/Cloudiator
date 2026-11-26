# Cloudiator promotion links

Use these links after the 1.9.4 client is live and the campaign placement has Avi’s approval. Each opens the camp directly. The path label is public and identifies the placement for reporting.

| Placement | Code | Game link |
| --- | --- | --- |
| Indigo Labs YouTube channel profile | `yt-profile` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/yt-profile/) |
| Cloudiator trailer description | `yt-trailer` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/yt-trailer/) |
| Instagram bio | `ig-bio` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/ig-bio/) |
| TikTok bio, when available | `tiktok-bio` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/tiktok-bio/) |
| r/WebGames | `reddit-webgames-01` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/reddit-webgames-01/) |
| r/playmygame | `reddit-playmygame` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/reddit-playmygame/) |
| itch.io game page | `itch-page` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/itch-page/) |
| IndieDB game page | `indiedb-page` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/indiedb-page/) |
| First Reddit paid creative | `reddit-ad-01` | [Open Cloudiator](https://cloudiator-arena.pages.dev/game/p/reddit-ad-01/) |

Keep the trailing slash. Add a code to the [client registry](../../src/features/promo/source.ts) and deploy its export before using the new link. Use a different code per linkable creative. Never recycle a code for a different placement, put user data in a code, or make up a `?ref=` link. Share the registry with the 2.0 signup implementation before accepting its attribution.

**Decided 2026-11-26.** The trailer and channel profile have separate codes. Shorts that point to a shared trailer credit their game arrivals to the trailer link. Give a Short its own linked destination and game URL if a campaign specifically needs to measure that Short.

Report weekly **landing requests by exact path** only if Avi confirms that the production Pages project exposes the metric without a browser tracker. Filter to the live hostname and successful landing documents, and validate two distinct paths after deployment. Requests can include reloads, previews and bots. If the metric is unavailable, the welcome can still ship. Label platform outbound clicks as clicks and keep the weekly total of new human gladiators separate. Source-specific sign-ups are a 2.0 feature. [Design and acceptance](../superpowers/specs/2026-11-26-front-door-design.md)
