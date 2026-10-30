# @otomaties/cookie-scanner

Scans a WordPress site with Playwright, finds the cookies it sets before and after consent, and adds the new ones to the otomaties-cookie-consent plugin through its REST API.

```sh
npx @otomaties/cookie-scanner --url https://example.be --user tom
```

The application password is asked for with a hidden prompt, so it stays out of your shell history. Leave out `--user` and the username is asked for too.

On first use, install the browser: `npx playwright install chromium`.

## Options

| Option | Default | |
| --- | --- | --- |
| `--url <url>` | (required) | Site to scan |
| `--user <name>` | | WordPress username; the application password is prompted for |
| `--auth <user:password>` | `$COOKIE_SCANNER_AUTH` | Username and application password in one, for CI or scripts. Ends up in shell history when typed |
| `--dry-run` | off | Print what would be created, push nothing |
| `--max-pages <n>` | 30 | Maximum pages to visit |
| `--per-type <n>` | 3 | Pages to sample per post type / taxonomy sitemap |
| `--json` | off | Print the report as JSON on stdout (progress stays on stderr) |
| `--headed` | off | Show the browser |
| `-y, --yes` | off | Accept Open Cookie Database suggestions; cookies it doesn't know are skipped |

### Credentials

In a terminal, credentials you didn't pass are prompted for (password hidden). `--dry-run` only prompts when `--user` is given; without credentials, a dry run treats every cookie as new because it can't read the existing list. Outside a terminal (CI), `--auth` or `COOKIE_SCANNER_AUTH` is required.

## How it works

1. **URLs**: reads `/wp-sitemap.xml` (falls back to `/sitemap_index.xml`). Takes the homepage, then up to `--per-type` URLs from each post type / taxonomy sitemap, round-robin, until `--max-pages`. User sitemaps are skipped.
2. **Pre-consent pass**: visits every page in a fresh browser context and records `context.cookies()`, including third-party and HttpOnly cookies. Everything found here is flagged *set before consent*.
3. **Accept-all pass**: in a new context, calls `acceptCategory('all')` on the cookieconsent v3 API, then visits every page again. The API is `window.CookieConsent` (the UMD build) or `document.cc` (where the plugin exposes it). Note that accepting triggers the plugin's consent tracking endpoint, the same as a real visitor's consent.
4. **Normalise**: name, domain, lifetime ("13 months", "session"), first page seen, set before consent. Cookies are merged by name because names are unique in the plugin.
5. **Sync**: `GET`s the existing definitions. A cookie counts as known if its name matches an entry exactly, or matches an entry with `regex: true` used as a `*` wildcard pattern (`_ga_*`). Only unknown cookies are `POST`ed. Existing entries are never updated or deleted.
6. **Categorise**: for each new cookie you choose a category, with a suggestion from the Open Cookie Database that also pre-fills the description and expiration. You can also skip the cookie, or skip all remaining ones. A `409` is reported as "already exists" and skipped.
7. **Report**: known, new (created), skipped, set before consent. Cookies set before consent that aren't categorised as necessary/security are marked with `!`.

Open Cookie Database category mapping: Necessary/Functional → `necessary`, Analytics → `analytics`, Marketing → `advertising`, Personalization → `personalization`, Security → `security`.

## Development

```sh
npm install   # also downloads the Open Cookie Database and builds
npx . --url https://example.be --dry-run   # or: node dist/cli.js ...
```

Inside this repo, `npx @otomaties/cookie-scanner` fails with `cookie-scanner: command not found`: npx picks up the local package but doesn't link its own bin. Use `npx .`, or `npm link` to get a global `cookie-scanner` command.

The Open Cookie Database isn't committed: `data/` is git-ignored and `scripts/fetch-cookie-database.mjs` downloads it from a pinned upstream commit during `npm install` / `npm run build`. The published npm package includes it. To update it, change `COMMIT` in that script and run `npm run fetch-data -- --force`.

## Licenses

MIT. The npm package bundles the [Open Cookie Database](https://github.com/jkwakman/Open-Cookie-Database) (Apache-2.0), with its license in `data/OPEN-COOKIE-DATABASE-LICENSE`.
