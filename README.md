# MemberWebsocket Dev — Netlify

Copied from `yongshengchen0615/yongshengchen0615.github.io`, commit
`c1eb08e26a63862d88d91e57a4eda52a11246e5b`, directory `MemberWebsocket-dev`.
The original directory is preserved so existing application and test paths keep working.

## Build and serve

Node.js 24 is required. No dependency installation is needed for the static build.

```bash
node scripts/build-site.mjs
python -m http.server 8080 --directory dist
```

The build publishes only frontend assets. Supabase functions, migrations, tests,
internal documents and local Netlify state are excluded from `dist`.

## Netlify configuration

Use the recreated project `memberwebsocket-dev-netlify`
(`196e1d2c-8216-4ba8-aeb9-1706660adc2b`). The currently connected production branch is `master`. The `Integrated-Marketing-Platform` development branch uses a **native Netlify branch deploy**, published after exact-SHA CI succeeds, at `https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/platform/`. The GitHub release workflow validates the existing native deploy, reproduces its build artifact, verifies public files, CORS, and read-only Chromium E2E, and never uploads a competing branch ZIP. The production `master` deploy is unchanged.
Leave the base and package directories empty. The root `netlify.toml` sets:

- Build command: `node scripts/build-site.mjs`
- Publish directory: `dist`
- Node version: `24`

The project uses the existing Supabase project `dbuquirnaskrwcamdxki`.
The client config contains a public publishable key. Do not add a service-role key
or server secrets to frontend code or the publish directory.
`.netlify/` is ignored because linking writes local project state there.

## Branch-proof `config.json`

`MemberWebsocket-dev/config.json` is a shared authoring/local-development
configuration, **not** the release authority for environment-specific values.
Both Netlify and GitHub Actions generate a new `dist/config.json` on every
build. Merging a feature branch can change the source JSON, but cannot select
another Supabase database or replace the selected release's seven LIFF IDs.

| Release identity | Supabase project | LIFF source |
| --- | --- | --- |
| `master` (production) | `MemberWebsocket-main` | `PUBLIC_LIFF_CONFIG_PRODUCTION` |
| `Integrated-Marketing-Platform` (branch deploy) | `MemberWebsocket-test` | `PUBLIC_LIFF_CONFIG_TEST` |
| Other Netlify deploy previews | `MemberWebsocket-test` | `PUBLIC_LIFF_CONFIG_TEST` |

The Supabase URL, canonical API URL and publishable key are pinned to the
selected project in `scripts/preview-member-runtime.mjs`. The seven LIFF IDs
are loaded from the corresponding **site-level Netlify Build environment
variable**. If that variable has not yet been configured, the resolver uses
seven known-good IDs pinned separately from source `config.json`, preserving
existing behavior. A partially populated, invalid or unexpected JSON profile
fails the build rather than publishing a mixed configuration.

To configure independent LINE apps, go to Netlify → Project configuration →
Environment variables and add the following **two separate, non-secret,
Build-scope** variables. Set production to the production context and testing
to `branch:Integrated-Marketing-Platform` (or `branch-deploy` plus
`deploy-preview` if the same test IDs should be used for all previews):

- `PUBLIC_LIFF_CONFIG_PRODUCTION` — full seven-ID production JSON
- `PUBLIC_LIFF_CONFIG_TEST` — full seven-ID testing JSON

Each value must be valid compact JSON with **exactly** these seven keys:

```json
{
  "memberLiffId": "1234567890-ExampleA",
  "pointsLiffId": "1234567890-ExampleB",
  "adminLiffId": "1234567890-ExampleC",
  "platformLiffId": "1234567890-ExampleD",
  "eventLiffId": "1234567890-ExampleE",
  "calendarLiffId": "1234567890-ExampleF",
  "bookingLiffId": "1234567890-ExampleG"
}
```

Replace the example IDs with actual LIFF app IDs in LINE Developers.
Changing source `config.json` does **not** update either deployed LIFF
profile. The verified GitHub Actions release workflows read these same values
from Netlify using `env:get` before building, and fail on unrecognized provider
errors. Never store LINE Channel Secrets, Supabase service-role/secret keys,
Twilio tokens or other credentials in public config or these public LIFF vars.

**Current compatibility note:** the built-in test LIFF fallback still shares
the original production LIFF IDs; that does not prove LINE sign-in will work
on both origins. Create separate test LIFF apps and configure the test profile
and LINE endpoints before claiming end-to-end environment independence.
The configuration regression checks include poisoned-merge simulation,
unknown/partial profile rejection and cross-project asset scanning:

```bash
node --test scripts/branch-environment.test.mjs scripts/preview-member-runtime.test.mjs scripts/load-netlify-liff-profile.test.mjs
```

## LINE LIFF configuration

Before declaring real LINE sign-in verified on the new domain, inspect the existing
LINE Developers endpoint settings and test each enabled surface. If the same LIFF
IDs are moved to this domain, update their endpoint URLs to the matching paths.
Changing these shared LIFF endpoints also changes where existing LINE entry links open.

| Surface | Existing LIFF ID | Target endpoint |
| --- | --- | --- |
| Member | 2010787602-kaiSm2eq | https://memberwebsocket-dev-netlify.netlify.app/member/ |
| Points | 2010787602-eIzRN9l6 | https://memberwebsocket-dev-netlify.netlify.app/points/ |
| Event | 2010787602-tuapstY3 | https://memberwebsocket-dev-netlify.netlify.app/event/ |
| Calendar | 2010787602-4UKzslco | https://memberwebsocket-dev-netlify.netlify.app/calendar/ |
| Booking | 2010787602-sgiB0ETj | https://memberwebsocket-dev-netlify.netlify.app/booking/ |
| Admin | 2010791619-vhevCvvD | https://memberwebsocket-dev-netlify.netlify.app/admin/ |

Endpoint settings have not been verified or changed as part of preparing this copy.
No backend schema or production member records are changed by this static deployment.

## Backend origin allowlist

A live request from the target Netlify origin currently receives HTTP 403
`ORIGIN_NOT_ALLOWED`. Before enabling the new frontend, add the exact origin
`https://memberwebsocket-dev-netlify.netlify.app` to the Supabase Edge Function
`ALLOWED_ORIGINS` setting while preserving every existing allowed origin. Do not
replace the allowlist with `*`. Re-test preflight, unauthenticated rejection and
authorized application calls after the setting takes effect. This setting has not
been changed during preparation.

## Tests

```bash
node --test scripts/deploy.test.mjs MemberWebsocket-dev/tests/*.test.js
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/browser
```

The copied `.github/workflows/test-memberwebsocket-dev.yml` defines the full existing
DOM/database integration, browser E2E, JavaScript syntax, Edge Function and wiring
test lanes. `test-netlify-build.yml` checks the static publish output separately.
Browser fixture tests do not establish that external LINE login works on Netlify.

## Recovery

For an incorrect published version, revert the relevant Git commit and push the
correction to the currently configured production branch `master` so continuous deployment builds the correction. A failed
Netlify deploy leaves the previously published version in place.
