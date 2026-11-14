# Live verification log

Host: teammate's Windows 11 laptop, Node 26.8.2, branch `windows-handoff`. Date: November 14, 2026 (America/New_York).
Each service was enabled **on its own** (all other credentials blanked in the shell), driven through the application's own modules, and then checked independently at the provider. Scripts were run from the repository root; they live outside the repository. All data is synthetic.

## Summary

| Service | Result | How it was checked |
|---|---|---|
| Nessie v2 | **Verified** | Seeded via app; paid a cleared invoice and an approved hold; read transactions, balances and bills back from the API |
| Gemini (`gemini-3.5-flash-lite`) | **Verified** | 7 scenarios through `agent.process`; fields, decisions and citations compared with expectations |
| Tiger Data | **Verified** | App created schema/policies; queried TimescaleDB catalog and app routes |
| Solana devnet | **Verified** | Ledger entries anchored by the app; memo, signer and hash checked by `verifyOnChain` against devnet |
| Photon v2 | **Outbound verified**; inbound decision pending | Thread opened from history; app sent one labelled test text; Photon reported `delivered` |
| MongoDB Atlas | **Blocked** | TLS alert 80 from Atlas: this host's public IP is not on the project's IP access list (see below). Code paths verified on a local mongod instead |
| Atlas Search | Code ready, not verified | Store creates `vendors_name` on `vendors.name` at startup once Atlas is reachable |

## Nessie

- Seeded operating account `acct_01m7e3kns56pyqdyedz0jp64qc` with $412,650.00 and six vendor payee accounts.
- Cleared invoice PR-1041 ($9,742.50) → transfer `txn_01m7e3kp7s6dxsqgphc7h7pv5q`.
- Held invoice PR-1042 approved → new payee account for the changed bank details → transfer `txn_01m7e3kpkfkm04r6gp2ryd12b2` ($31,870.00).
- **Finding:** `POST /transactions/{id}/settle` only moves `settle_at`; the hosted sweep completes transfers about a minute later. Both transfers were still `pending` immediately after settle. The app correctly reported `pay_pending` (the original code would have reported `paid`), then `reconcile()` moved both to `paid` once the bank said `completed`.
- Afterwards: operating balance at the bank $371,037.50 (= 412,650 − 9,742.50 − 31,870), app balance equal, both bills `completed`, the blocked case's bill `cancelled`, exactly two outgoing transfers, and a repeat approval refused.
- Account nickname limit confirmed as 40 characters from the live OpenAPI (`/openapi.json`); code fixed.
- Not verified: the decision webhook. It needs a public HTTPS URL; none exists.

## Gemini

All seven scenarios (3 PDF, 4 email): extractor `gemini`, invoice number, amount, routing and account last four correct; every decision identical to the deterministic expectation (the prompt-injection invoice was still held); every explanation accepted, every cited evidence id present in the case file. Explanations are now rejected if they cite unknown evidence or contradict the decision (`checkExplanation`).

## Tiger Data

TimescaleDB 2.32.0 over `sslmode=verify-full` with `certs/tiger-ca.crt`. After app startup: `payments` is a hypertable; `vendor_daily` is a continuous aggregate (`materialized_only=false`); refresh policy every 5 minutes and compression policy registered; 72 seeded paid rows; `/api/vendors/v-cascade/history` returned 12 daily buckets; a live payment appeared in today's bucket immediately; held/declined rows stayed out of baselines; only fingerprint and last four stored.

## Solana

Wallet `6fvEaXYGLin4cmZYDZVdxNecYa8J7DWfbC7miRGKvjMY` (0.5 devnet SOL before testing). Two entries anchored:
- `4nyAg1u91J1J4ChGokvruDtiawwYVxVXZPQMKRxWrj5NwSA7UMGiYbafb1Xxo3bhvSzG6KESX5deEGwUDmkYXqpZ`
- `58kqeayFuZNrSU2UvU4r9zWATZH1adjvhKE983YQGJvGEFDMvyfC4QxJbt1cvkb5zABBZkmdxVgSYCzBE6yafJgJ`

`verifyOnChain` (also `GET /api/ledger/:id/onchain` and the dashboard's verify button) confirmed hash, memo, signer and success for both. Rewriting an entry *and* recomputing its local hash was still caught by the on-chain memo.

## Photon

The approver's earlier "Hi" (before first start) opened the thread without triggering any action. One test text ("Countersign test from the new Windows host. No action needed.") was accepted (`dispatched`) and reported `delivered` 10 s later; the app now records Photon message ids and tracks delivery to `delivered`/`failed`.
Pending: the approver replying HOLD/APPROVE/ASK from the enrolled phone to the running server.

## MongoDB

- This host's public IPv4 rotates within a campus NAT pool (three different addresses in one evening), and Atlas allowed only the single address used at setup. No IPv6 egress. The connection string points at the intended cluster and scoped app user.
- Fix: in Atlas Network Access, add the range this host's NAT uses rather than one /32, which breaks when the address changes (the database still requires the scoped user's password). Exact addresses are in the private ACCESS.md. Re-run the checks after the entry shows Active.
- Meanwhile the MongoStore code was run against a local mongod (`mongodb-memory-server`): scoped reset left a foreign collection untouched; 20 concurrent `incr` calls gave 20 distinct numbers; of 5 simultaneous decisions exactly one won and money moved at most once; no full account numbers in stored cases; data and sequence persisted across reconnect.

## Accidental live boot

While preparing a demo-mode UI check, a PowerShell launch cleared variables by setting them to `''`, which *removes* them in PowerShell, so the server loaded the real `.env`. It was stopped within seconds. Effects: one extra set of Nessie sandbox customers/accounts, Tiger's synthetic `payments` table re-seeded, Photon polled; no invoices processed, so **no texts were sent and nothing was anchored**. Its startup report was accurate (MongoDB `degraded`, Tiger/Nessie/Photon `live`). To prevent this, the app now reads `COUNTERSIGN_DISABLE` (for example `COUNTERSIGN_DISABLE=photon,solana,nessie`), which switches the named integrations to their stand-ins regardless of `.env` and behaves the same in every shell.
