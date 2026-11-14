# Countersign: current agent and teammate handoff

Audited November 14, 2026, America/New_York. This replaces the original planning-only handoff.

## Start here

Countersign screens synthetic business invoices for payment fraud, pays cleared invoices through the Nessie sandbox, and holds suspicious invoices for a human approver. It has a working local prototype and credentials for six external services. Individual service checks succeeded; the complete application has **not** been verified with those services together.

**The runtime host is a teammate's Windows laptop on the same Wi-Fi/LAN. Marvin's Mac must not be required to keep the app running.** Vultr is an optional later deployment/prize track, not a prerequisite for the Windows handoff.

Read these files in order:

1. [PROJECT_STATUS.md](PROJECT_STATUS.md): scoped aspects, estimated completion, evidence and remaining work.
2. [WINDOWS_TEAM_SERVER.md](WINDOWS_TEAM_SERVER.md): transfer, Windows startup and private team access.
3. [SERVICE_ACCESS.md](SERVICE_ACCESS.md): consoles, environment variables and migration caveats.
4. [API.md](API.md): every current application endpoint and examples.
5. [countersign.postman_collection.json](countersign.postman_collection.json): importable requests; mutating calls are separated.
6. [SUBMISSION.md](SUBMISSION.md): original submission draft, not proof of deployment or full live integration.

No chat history is needed to understand this handoff. Secret values are deliberately outside these documents.

## Repository and transfer provenance

- Repository: https://github.com/nmea002/countersign
- Audited source commit: `9a3c689e115a245b83a4f55722222771cc87c806` on `main`.
- Original checkout: `/Users/marbin/Desktop/homework/hackathon/countersign`.
- Suggested Windows location: `$env:USERPROFILE\source\countersign`.
- At audit time, GitHub account `itsnotmarvin` had pull access and **no push access**. Remote `main` matched the commit above.
- This session added service/account setup and checks, private environment configuration, handoff/API/Windows documentation, and export packages. The application source was inherited from the repository; this session did not implement the proposed advanced features.
- The pre-existing local `package-lock.json` change came from dependency installation. The export includes it to reproduce the current dependency tree.
- New handoff files are local/exported, **not pushed**. An authorized teammate must apply/commit the patch or the owner must grant write access. Do not claim GitHub contains this handoff until it does.

The export directory beside the checkout is `countersign-handoff-2026-11-14`. It contains a source ZIP, a patch against the audited commit, the documents under `docs/`, a START_HERE.md guide, and checksums. A sibling `countersign-team-handoff-2026-11-14.zip` bundles that directory for transfer. The source ZIP excludes `.env`, private configuration, runtime data, screenshots, `node_modules` and `.git`. See VALIDATION.md in the export for exact packaging checks. Prepared locally does not mean transferred: teammate receipt, recipient checksum verification, patch application and Windows execution are pending.

The separate private migration folder is `/Users/marbin/.config/countersign/teammate-transfer`. Transfer its `.env` and `certs/tiger-ca.crt` securely to the Windows host. That copy uses a relative certificate path and port 3000. The original Mac `.env` is unchanged. Never upload the private folder to GitHub, a chat, an issue or the public source ZIP.

## What has actually been verified

| Component | Evidence | Still unverified |
|---|---|---|
| Local core | Current 12 in-memory core checks pass | Browser/HTTP E2E, full live flow, Windows execution |
| Nessie v2 | Authenticated `GET /customers`: HTTP 200 | App seed, completed transfer and balance reconciliation |
| Gemini | Real generation succeeds with `gemini-3.5-flash-lite` | App PDF extraction and validated evidence citations |
| Photon v2 | Incoming Hi read through API; API reply shown Delivered | App hold, phone HOLD/APPROVE, restart/pagination |
| MongoDB Atlas | Free cluster/scoped app user; authenticated ping | App collections/restarts and Atlas Search |
| Tiger Data | Free service; authenticated SQL with TLS certificate verification | App schema, hypertable, aggregate, policies/history route |
| Solana | Existing devnet wallet funded with 0.5 devnet SOL | App-generated memo and independent verification |
| Domain | countersign.work registered for $0; expires 2027-11-14; auto-renew off | App DNS, HTTPS and public access |
| Vultr | Account exists | API/server blocked by funding requirement |

Verification command: `npm test -- --experimental-test-coverage`. It reported 80.26% line, 78.76% branch and 78.17% function coverage **of loaded files**. `src/server.js` is absent. This does not establish project-wide 80% coverage or live-service behavior. The tests disable credentials and use in-memory stand-ins; preserving them is a regression requirement, not the live-integration objective.

The UI's live badges check configuration presence (`src/config.js`), not health. MongoDB/Tiger can fall back locally while badges remain live. Do not use badges as acceptance evidence.

## Architecture and source map

```text
PDF or pasted/API email -> extraction -> vendor resolution
 -> deterministic checks/investigation -> clear or hold
      clear -> Nessie transfer
      hold -> Photon -> verified approver -> pay or block
 -> document store + time series + evidence + hash-chain ledger
```

| Responsibility | Files |
|---|---|
| Routes, SSE, startup/config | `src/server.js`, `src/config.js` |
| Orchestration, decisions/reminders | `src/agent.js` |
| Policy, investigation/evidence | `src/checks.js`, `src/forensics.js` |
| Parsing, privacy helpers/PDF/model | `src/text.js`, `src/pdf.js`, `src/llm.js` |
| Bank / messaging | `src/bank.js`, `src/notify.js` |
| Documents/search / time series | `src/store.js`, `src/timeseries.js` |
| Ledger/devnet | `src/ledger.js` |
| Synthetic scenarios | `src/seed.js` |
| Dashboard | `public/index.html` |
| Core checks / CI | `test/core.test.js`, `.github/workflows/test.yml` |
| Optional Linux deployment | `Dockerfile`, `deploy/` |

## Live status (November 14, 2026, evening)

Nessie, Gemini, Tiger Data and Solana are verified live through the application; Photon outbound is verified to `delivered`. MongoDB Atlas is blocked only by the IP access list (this host's campus IP rotates; see [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md)). Dashboard extensions are in: linked-activity graph, ask-the-case, monthly paid/held/declined chart, Tiger-backed vendor chart, on-chain verify. Run the server with `scripts/run-windows.ps1`; use `COUNTERSIGN_DISABLE=...` to switch integrations off for testing.

## Priority defects

**Update, November 14, 2026 (Windows host, branch `windows-handoff`, not pushed):** items 1–9 below have code fixes with in-memory regression tests in `test/hardening.test.js` (26/26 pass). None has been exercised against the live services yet, because `.env` and the Tiger CA are not on the Windows host. Summary of what changed:

1. Privacy: the case's `raw` is null until redacted; extracted and labelled account numbers are masked; a test records every store write.
2. Payment truth: only Nessie status `completed` makes a case `paid`; `pending` becomes `pay_pending` and the worker reconciles it each minute; declines become `pay_failed`. Paying atomically claims the case first, so a second approval cannot pay twice.
3. Access: listens on `127.0.0.1` unless `HOST` is set; non-loopback requires `COUNTERSIGN_TOKEN`; per-client rate limits; JSON-only POSTs; single-instance lock file.
4. Webhook: rejects when no secret is stored, on bad/stale (>300 s) signatures; approves only a transfer matching an in-flight case (payee, cents, source). Registration errors are stored and shown in health. Existing hooks are reused across resets.
5. Photon: cursor, seen IDs and thread persisted in `meta`; all pages read; one poll at a time; outbox with idempotency key = message ID; messages from before first start only open the thread.
6. Reset: bank setup runs before anything is cleared; only Countersign collections are touched; case numbers and Photon state survive; requires `{"confirm":"reset"}`; `ALLOW_RESET=0` disables it.
7. Health: `/api/health` and the badges show demo/degraded/active/live; hold traces say queued/accepted/failed.
8. Concurrency/validation: atomic `claim` and `incr` in both stores; boundary schema on extracted fields.
9. Nessie contract: checked against the live OpenAPI (`/openapi.json`): account nickname max 40 (was 80), status enum `pending|completed|declined|cancelled`, signature `t=<s>,v1=hmac("t."+body)`.

Original findings, kept for reference:

1. **Privacy:** `src/agent.js:33–46` persists `raw` at intake before redaction. The test only checks the final case. Remove sensitive raw persistence or sanitize before every write, including error/evidence paths. Use an instrumented store to prove no write contains a full account number.
2. **Payment truth:** `src/bank.js:90–92` swallows settlement failure and accepts statuses other than declined/cancelled; `src/agent.js:124–135` marks any returned result paid. Require explicit terminal success, reconcile pending, make failures visible, and prevent duplicate payments.
3. **API access:** `src/server.js` has no login/authorization/rate limits. Reachable callers can read cases, approve payments and reset data. Keep team access behind SSH/private forwarding until protections exist; do not expose it broadly on a conference LAN or public tunnel.
4. **Webhook:** `src/bank.js:95–105` validates signatures only if a stored secret exists, with no timestamp/replay check. Registration errors are ignored. Approval only checks payee membership, not source account, amount or an authorized case. Fail closed and bind a decision to the expected transfer.
5. **Photon recovery:** `src/notify.js:31,59–76` starts five seconds before startup, never advances its cursor and fetches only 100 ascending messages. It misses downtime/old enrollment and can miss later pages. Deduplication is in memory. The queued status is only a log, not a durable outbox. Persist cursor/thread state, paginate, retry safely and process replies once.
6. **Reset:** `src/seed.js:23–30` clears state before remote setup succeeds. Mongo reset deletes documents from all collections in its configured database. Preserve the last good dataset and messaging/hook state; restrict reset to disposable Countersign data and make remote setup idempotent.
7. **Health/delivery:** badges reflect keys, not selected adapters or successful operations. A trace says texted even when delivery queued/failed. Show configured, healthy, degraded, pending and failed states honestly.
8. **Concurrency/validation:** sequence allocation and decisions lack atomicity across requests/processes. Model fields/amounts need boundary schemas. Test concurrent approvals and malformed model outputs.
9. **Nessie contract:** verify current OpenAPI, including nickname limits (source truncates to 80; previous API review found 40), bill fields, currency units and settlement semantics.

Do not treat these findings as a claim of a production incident. All project data must remain synthetic.

## Next-agent execution plan

### A. Windows handover and critical fixes

- Follow the Windows guide. Use Node 24 to match CI/Docker; the audited Mac used Node 25.9.0/npm 11.12.1. Windows execution is unverified.
- Run `npm ci` and regression checks before adapter changes. Validate variable presence without printing secrets, and resolve the Tiger CA path.
- Fix the priority money/privacy/access defects before live invoice scenarios. Keep one integration owner and one shared runtime/poller.
- Do not run multiple agents against reset or the same Photon inbox. Test stand-ins remain supported, but required live functionality must not silently degrade to demo behavior.

### B. Real integrations, one at a time

1. **Nessie:** seed synthetic operating/payee accounts; pay a cleared invoice; independently verify completed transfer and changed balance. Exercise pending/failure cases.
2. **Gemini:** submit a synthetic PDF through the application; prove `extractor: gemini`, valid fields and citations that resolve. Use `gemini-3.5-flash-lite`; the old default `gemini-2.5-flash` returned 404 for this account.
3. **Photon:** establish the application's thread state; produce a real hold; HOLD and APPROVE separate cases from the enrolled phone; confirm persistence/ledger/bank results and reject other senders.
4. **MongoDB:** verify vendors/cases/messages/ledger persist across restart; create a Search index on `vendors.name`; set `ATLAS_SEARCH_INDEX`; prove the look-alike case uses it.
5. **Tiger:** verify `payments` hypertable, populated `vendor_daily`, refresh/policies and `/api/vendors/v-cascade/history`. Do not count warning-only optional setup as proof.
6. **Solana:** use the existing funded key; create a ledger memo; open its devnet transaction and compare the memo/hash. Do not regenerate the key.

After each change, run regression checks, exercise the bank-change scenario against the intended service, record evidence and commit through an account with write access.

### C. Product extensions

- Link graph: indicators/links exist; graph view missing.
- Ask the case: add UI/API/phone syntax; answer only from evidence with validated citations. WHY currently returns fixed findings, not arbitrary Q&A.
- Tiger charts: consume daily aggregate and add paid/held/declined time buckets.
- On-chain verifier: fetch memo and compare; existing verify endpoint is local-chain-only.
- Public Nessie callback: private SSH forwarding does not make it reachable to Nessie. Expose only the reviewed callback over HTTPS; keep administrative routes private.

### D. Submission

The supplied assignment states **Sunday November 15, 2026, 8:00 AM Eastern** as the hard Devpost deadline and 7:00 AM as the internal target. These came from the handoff and were not independently reverified; check official event instructions.

Update submission claims with observed results, rehearse, record a short video, collect team details, submit, then publish the DEV post. No submission/video/public deployment is verified. Peri needs a real business/person/role/evidence; never invent it. SpaceXSI tool eligibility and ChatOverflow connection are unverified.

## Multi-agent coordination

- Use separate branches/worktrees and assign file ownership. One owner integrates overlapping changes in `agent.js`, `config.js`, `server.js`.
- Possible independent roles: bank/privacy; Photon; storage/Tiger; UI/graph. Merge and run shared services serially.
- Run agents on the Windows host (directly or through Remote-SSH) for real filesystem/terminal access. Live Share guest support varies by agent/extension; do not assume it provides a host terminal/runtime.
- Only integration operators need credentials. Other workers can submit patches tested against stand-ins.
- Update these docs with commands, evidence, remaining blockers and local-versus-pushed status.
- Never inspect `itsnotmarvin/hackprinceton` or `/Users/marbin/Desktop/hackprinceton`. This handoff is for `nmea002/countersign`, separate from `abayate/hackathonprinceton`; do not merge projects without instruction.
- Keep secrets out of Git/logs/prompts/screenshots. Preserve user tool/model/access preferences.

## Receiving-agent prompt

> Continue Countersign from docs/HANDOFF.md, PROJECT_STATUS.md, WINDOWS_TEAM_SERVER.md, SERVICE_ACCESS.md and API.md. Host it on this teammate's Windows laptop on the same LAN, not Marvin's Mac. Credentials are transferred separately to .env and the Tiger CA to certs/tiger-ca.crt; never print secrets. Fix the prioritized payment/privacy/access/recovery defects, then verify real services one at a time starting with Nessie. Preserve deterministic decisions and synthetic-only data. Use one shared runtime/poller, coordinate edits with Git, and update the handoff with evidence. Do not inspect the prohibited repository. Do not deploy paid infrastructure or claim deployment/submission without verification.
