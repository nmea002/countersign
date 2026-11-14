# Application API reference

Source of truth: `src/app.js` (routes) and `src/server.js` (boot), branch `windows-handoff`. Sixteen current HTTP operations are listed below. Import [countersign.postman_collection.json](countersign.postman_collection.json) to use them outside this chat.

## Base URL and access

- On the Windows host: `http://127.0.0.1:3000` after startup.
- On a teammate client using SSH forwarding: the forwarded local address, normally `http://127.0.0.1:3000`.
- No public API deployment exists. `https://countersign.work` is not yet the application API.
- The server listens on `127.0.0.1` by default (`HOST`). It refuses to start on any other address unless `COUNTERSIGN_TOKEN` is set.
- With `COUNTERSIGN_TOKEN` set, every route except `POST /api/webhooks/nessie` needs it: `Authorization: Bearer <token>`, or the HttpOnly cookie set by opening `/login?token=<token>` once in the browser. Without a token, SSH forwarding plus the loopback bind is the boundary. This is one shared operator secret, not per-user roles.
- Every `POST /api/*` must be `Content-Type: application/json` (415 otherwise). Mutating routes are rate limited per client (30/min; reset 3/min; webhook 120/min), answering 429.
- Only one server may run per data folder: a second `npm start` exits with an error (`data/server.lock`).
- Provider keys stay on the server; clients must not send them to these app routes.
- No uniform success envelope, pagination or OpenAPI contract is currently implemented. Responses below describe the actual code. `POST` bodies use JSON; server limit is 12 MB including base64/JSON overhead.

## Endpoint inventory

| Method / path | Input | Success response | Notes / errors |
|---|---|---|---|
| `GET /api/state` | None | 200 `{company,approver,integrations,simulator,resetAllowed,scenarios,cases,stats,messages,ledger,ledgerCheck}` | Main dashboard bundle; `integrations` is the same object as `/api/health` |
| `GET /api/health` | None | 200 `{gemini,mongodb,tiger,nessie,solana,photon}`, each `{state,live,configured,detail}` | `state`: `demo` (no key, stand-in by design), `degraded` (key set but fallback running, or last call failed), `active` (live adapter, nothing verified yet), `live` (last real operation succeeded). Still not acceptance proof on its own |
| `POST /api/cases/:id/ask` | `{question}` (≤300 chars) | 200 `{answer,cites,by,rejected?}` | Answers only from the case file; Gemini citations must exist or a deterministic evidence search answers instead. Never changes a decision. 20/min |
| `GET /api/graph` | None | 200 `{nodes,edges}` | Cases joined to the IPs and account fingerprints they share; accounts shown as last four only |
| `GET /api/metrics/timeline` | Optional `?months=13` (1–36) | 200 `[{bucket,paid,held,declined}]`, each `{n,total}` | Monthly; TimescaleDB `time_bucket` when Tiger is live |
| `GET /api/ledger/:id/onchain` | Ledger id, e.g. `L3` | 200 `{ok,checks,signature,onChainMemo,expectedMemo,signer,slot,blockTime}` | Recomputes the hash and compares the devnet memo and signer |
| `GET /login?token=...` | Query token | 302 to `/` with cookie | Only when `COUNTERSIGN_TOKEN` is set; 401 on a wrong token |
| `GET /api/cases` | Optional `?status=held` | 200 array of case summaries | No pagination; exact status filter |
| `GET /api/cases/:id` | Case ID such as `PR-1041` | 200 `{case,vendor,baseline,ledger}` | 404 `{error:"not found"}` |
| `POST /api/invoices` | `{raw}`, `{pdfBase64,filename,sender}`, or `{scenario}`; optional `wait:true` | 201 full case when waiting; otherwise 202 `{accepted:true}` | Mutates cases/ledger and can pay/send messages; invalid input 400 |
| `POST /api/cases/:id/decision` | `{action:"approve"}` or `{action:"hold"}` | 200 case summary | APPROVE can pay; HOLD permanently blocks this request and blocklists its bank fingerprint; invalid action 400. Atomic: of simultaneous decisions exactly one wins, the rest get 400 |
| `GET /api/vendors` | None | 200 array of vendor summaries | Includes last payment, mean, open holds and blocked counts |
| `GET /api/vendors/:id/history` | Vendor ID, e.g. `v-cascade` | 200 array `{day,n,total,avg,max}` | Paid-only daily buckets; Tiger aggregate when selected, local fallback otherwise |
| `GET /api/metrics/overview` | None | 200 `{balance,paid,paidCount,pending,pendingCount,failed,failedCount,held,heldCount,blocked,blockedCount,byVerdict}` | Current case totals; `paid` counts only bank-completed transfers; no time buckets; balance may be null on failure |
| `GET /api/ledger/verify` | None | 200 `{ok:true,count,head}` or `{ok:false,brokenAt,count}` | Verifies local hash chain only, not Solana |
| `GET /api/events` | Persistent connection | 200 `text/event-stream` | SSE events: `request`, `message`, `ledger`, `reset`; initial retry 2000 ms |
| `POST /api/sms/reply` | `{text:"WHY 1041"}` | 200 `{answer}` | Simulator only; 403 when Photon selected. APPROVE/HOLD replies can mutate/pay |
| `POST /api/webhooks/nessie` | Raw signed Nessie JSON; `Nessie-Signature` header | 200 `{decision:"approve"}` or `{decision:"decline",reason}` | Provider callback, not a user command. 404 if Nessie absent. Fails closed: 401 when no hook secret is stored, the signature is missing/wrong, or its timestamp is more than 300 s off. Approves only a transfer matching a case Countersign is paying (same payee, amount in cents, and source account when sent) |
| `POST /api/seed` | `{"confirm":"reset"}` | 200 `{vendors,payments,signins}` | DESTRUCTIVE: creates bank resources first, then clears Countersign's own collections and truncates payment history. Keeps case numbering and Photon thread/cursor state; keeps texts when Photon is live. 400 without the confirm body; 403 when `ALLOW_RESET=0` |
| `GET /` | None | 200 dashboard HTML | Static app entry; not counted as a JSON API route |

There are **18 `/api/` operations plus `/login` and the dashboard GET**, 20 HTTP operations total. Case `status` is one of `analysing`, `cleared`, `paying`, `paid` (bank reported `completed`), `pay_pending` (submitted, reconciled every 15 s), `pay_failed`, `held`, `approved`, `blocked`.

## Request forms and schemas

Invoice input has precedence: `pdfBase64` first, then `raw`, then `scenario`. `wait:true` waits for core processing, but an asynchronous Solana anchor can finish later. Non-waiting submissions do not return a case ID; use case list/SSE to discover it. Do not blindly retry timed-out mutation requests: the app has no general request-idempotency mechanism.

Known synthetic scenario IDs: `legit`, `duplicate`, `fakepdf`, `bec`, `takeover`, `lookalike`, `spike`. Scenario generation creates synthetic data, but with credentials enabled it uses real service APIs and can send a real message or make a sandbox transfer.

Case summaries contain `id,n,receivedAt,status,source,vendorId,vendorName,amount,invoiceNumber,risk,verdict,top`. Intermediate/missing properties can be null or absent. Statuses currently include `analysing`, `cleared`, `held`, `paid`, `blocked`, `pay_failed`. A `paid` status is not yet trustworthy proof of Nessie settlement until the defect in HANDOFF.md is fixed.

Vendor summaries contain `id,name,domain,bankLast4,bankVerifiedAt,lastPayment,averagePayment,openHolds,blocked`. Monetary app values are dollars; the Nessie adapter converts transfers to cents. `byVerdict` contains `clear` and `hold` counts. A bank-change approval updates vendor bank details, creates a new payee when needed, and attempts payment; the app does not enforce a recorded callback verification step.

Most route promise errors currently return HTTP 400 `{error:err.message}`. This includes internal/provider errors and is not a production error policy. Malformed JSON/oversized body can be rejected by Express separately. Do not assume every error is JSON or safe to expose publicly.

## Read-only smoke checks (PowerShell)

```powershell
$base = 'http://127.0.0.1:3000'
Invoke-RestMethod "$base/api/state"
Invoke-RestMethod "$base/api/cases?status=held"
Invoke-RestMethod "$base/api/vendors"
Invoke-RestMethod "$base/api/vendors/v-cascade/history"
Invoke-RestMethod "$base/api/metrics/overview"
Invoke-RestMethod "$base/api/ledger/verify"
```

## Controlled synthetic integration check

Run only after the relevant defects are fixed and the operator has selected the intended integration test data. This request can create external records/messages; do not batch-run all mutation examples.

```powershell
$base = 'http://127.0.0.1:3000'
$body = @{ scenario='bec'; wait=$true } | ConvertTo-Json
$case = Invoke-RestMethod "$base/api/invoices" -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/api/cases/$($case.id)"
```

Use the actual returned ID. A held invoice can then be declined explicitly:

```powershell
$decision = @{ action='hold' } | ConvertTo-Json
Invoke-RestMethod "$base/api/cases/$($case.id)/decision" -Method Post -ContentType 'application/json' -Body $decision
```

PDF input from a synthetic local file:

```powershell
$bytes = [System.IO.File]::ReadAllBytes('C:\path\synthetic-invoice.pdf')
$body = @{ pdfBase64=[Convert]::ToBase64String($bytes); filename='synthetic-invoice.pdf'; sender='billing@northwind-paper.example'; wait=$true } | ConvertTo-Json
Invoke-RestMethod "$base/api/invoices" -Method Post -ContentType 'application/json' -Body $body
```

SSE from a terminal with curl:

```sh
curl -N http://127.0.0.1:3000/api/events
```

## Postman collection behavior

Set `baseUrl` to the Windows host's forwarded address, `caseId` to a real current case ID, and `vendorId` to a seeded vendor ID. Read-only calls, state-changing calls and destructive/provider-only calls are in separate folders. Importing does not execute requests.

All POST requests and the persistent SSE request are **skipped by default** by pre-request scripts. To deliberately send one, set the collection variable `allowRequestOnce` to that request's exact displayed name, then send that individual request. The script clears the opt-in before sending. Leave this variable empty during ordinary reads. This uses Postman's documented [pre-request skipRequest control](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-execution#pmexecutionskiprequest); use a current Postman runtime that supports it. These scripts are an operator safeguard, not server authorization, and the collection has not been exercised in the Postman UI.

**Do not batch-run live mutations or remove these guards.** Reset still deletes data, and the webhook request has no valid signature and exists only as a contract reference. Fix the corresponding application defects and construct a valid signed provider payload before deliberately enabling either.

## Provider APIs are a separate layer

Nessie/Gemini/Photon are outbound HTTP services; MongoDB and Tiger use database connections; Solana uses devnet RPC. Their secret values belong to the server's private configuration. See [SERVICE_ACCESS.md](SERVICE_ACCESS.md) for official consoles and variable names. The HTTP app API does not expose a key-download endpoint, and none should be added.
