# FJG-02 Integrated-Marketing-Platform acceptance

User target: a concrete Integrated-Marketing-Platform preview with exact source/CI/Edge/deploy evidence. Continue #156 and PR #167 from ad6f37a. Keep the existing tenant data and mature authentication; no new member system.

Decision: production and preview currently share Supabase. Overwriting api/member-profile-api risks blocking existing signups when the approved OA binding is absent. Use separate api-preview and member-profile-api-preview slugs, generated from the same reviewed source and protected by the same server authentication. Only the Integrated-Marketing-Platform build selects them; default/production routes retain their existing endpoints. No auth bypass or guessed binding. This isolates code, not database records.

1. RED→GREEN for explicit member-profile endpoint selection and preview-only build config. Keep production routing and existing config validation.
2. Exercise both real HTTP handlers plus the actual OA verifier/gate, stubbing only LINE transport and database boundary. Record that it is not a real Provider/remote DB acceptance. Add real PG17 referral/creation races to the existing disposable service.
3. Run final-SHA full CI; review the focused patch, resolve material findings. Prepare the preview functions from the complete exact-source import graph, deploy the new slugs, and verify HTTPS/CORS/auth rejection and exact source identity.
4. Integrate reviewed source into Integrated-Marketing-Platform through PRs; use native Netlify branch deploy and existing publish verification. Read back merge SHA, successful required CI, deploy ID, page badge/config/assets, and browser smoke.
5. Give the user the live merchant/member acceptance links and steps. Missing LINE Console linked OA approval and member LIFF configuration remain explicit blockers to real successful signup; never fake those values or call mocks real acceptance.

AC-001: direct API non-friend/token/channel/provider failure rejects with no activation. AC-002: real PG concurrent/replayed registration/referrals issue no duplicate records/reward. AC-003: IMP selects isolated candidate APIs; other contexts preserve endpoints. AC-004: same-source CI, merge, Edge and Netlify smoke evidence, safe recovery. Revert this increment and rebuild the prior verified branch; do not modify production deployment or delete data.

Runtime performance: endpoint selection adds no network round trips. OA first-activation cost remains three LINE calls; real p50/p95 requires approved LINE sandbox. Build/config tests must prove isolation. No guessed linked OA, no skipped checks, no increased timeout.
