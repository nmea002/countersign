# Service access and credential inventory

This file contains no API secrets. Source/API documents are shareable; credentials travel separately. The credentials already exist outside the chat in the Mac checkout's `.env`, with mode 600, and a Windows-ready private transfer copy. Do not regenerate keys/accounts simply because a new AI agent starts.

| Service | Console / documentation | App configuration | Verified and remaining |
|---|---|---|---|
| Nessie v2 | [Account](https://v2.nessieisreal.com/account), [OpenAPI](https://v2.nessieisreal.com/openapi.json) | `NESSIE_API_KEY`, `NESSIE_URL=https://v2-prod-api.nessieisreal.com`, later `PUBLIC_URL` | Authenticated customers read; app seed/transfer/balance/hook unverified |
| Gemini | [AI Studio keys](https://aistudio.google.com/apikey) | `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.5-flash-lite` | Model generation succeeded; app extraction/citations unverified |
| Photon v2 Beta | [Dashboard](https://app.beta.photon.codes/), [Beta guide](https://photon.codes/docs/beta/get-started/imessage) | `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM=imessage`, `PHOTON_APPROVER_HANDLE`; optional `PHOTON_AGENT_HANDLE` | Real inbound and delivered reply; app approval loop unverified |
| MongoDB Atlas | [Console](https://cloud.mongodb.com/) | `MONGODB_URI`, `MONGODB_DB=countersign`, later `ATLAS_SEARCH_INDEX` | Cluster Countersign; app login/ping works; collections/index unverified |
| Tiger Data | [Console](https://console.cloud.tigerdata.com), [TLS docs](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/security/strict-ssl) | `TIGER_DATABASE_URL` with verified TLS and CA path | Shared Free countersign service; SQL query works; schema/aggregate unverified |
| Solana devnet | [Faucet](https://faucet.solana.com), [Explorer](https://explorer.solana.com/?cluster=devnet) | `SOLANA_SECRET_KEY`, `SOLANA_RPC_URL=https://api.devnet.solana.com` | Existing wallet funded with 0.5 devnet SOL; app memo unverified |
| Porkbun / domain | [Domain management](https://porkbun.com/account/domains) | No domain API key required for current app; `PUBLIC_URL` only after reachable HTTPS deployment | countersign.work registered; expires 2027-11-14; auto-renew off; no app DNS |
| Vultr (optional) | [API access](https://console.vultr.com/user/apiaccess/) | No current app env requirement; deploy assets under `deploy/` | Account exists, API disabled until funded; no key/server |

## Photon: avoid the legacy-platform trap

The earlier Spectrum setup and the v2 Beta project are different platforms. The app uses `@photon-ai/api` and the v2 Beta project. The current application key is a genuine v2 project key; do not use the legacy Spectrum secret as `PHOTON_API_KEY`.

The current v2 assigned agent line is in `PHOTON_AGENT_HANDLE`; the verified approver is in `PHOTON_APPROVER_HANDLE`. A first message has already been received and an API test reply delivered. The key was created November 14, 2026 with a 90-day lifetime and five permissions: `messages:read`, `platforms:read`, `platforms:write`, `project:read`, `project:write`.

Old `SPECTRUM_PROJECT_ID`/`SPECTRUM_PROJECT_SECRET` remain only in the original local configuration; they are not used by the app and are deliberately excluded from the Windows transfer copy. Do not switch the repo to the legacy SDK. Preserve the authorized approver; new approvers require separate verification/assignment.

## Gemini model and key

The existing key was obtained from the Hackathon AI Studio project. A key beginning with `AQ.` is valid for this account; do not reject it based on older key-prefix assumptions. `gemini-2.5-flash` returned 404 for this account; `gemini-3.8-flash` attempts timed out. `gemini-3.5-flash-lite` returned a successful real generation. The app source's fallback default remains old; the saved environment and updated example explicitly select the verified model.

## MongoDB access boundary

The dedicated `countersign_app` database user has `readWrite` on the `countersign` database and is restricted to the Countersign cluster. The current network rule allows the original development egress IP. Recheck the Windows host's public egress; same LAN often shares it but is not proof. Add only the required address, keeping the app user scoped. The private ACCESS.md contains exact organization/project/host identifiers.

`ATLAS_SEARCH_INDEX` is empty. No live Search index or application data population is verified. Reset currently deletes all documents in all collections in the selected database; do not point it at any shared business database.

## Tiger TLS portability

The free service has a Timescale CA chain rather than a public CA-signed certificate. The saved URI enforces `sslmode=verify-full`. The local Mac CA is `/Users/marbin/.config/countersign/tiger-ca.crt`; the transfer copy is `certs/tiger-ca.crt` relative to the app root.

The CA was obtained from the service's presented chain on first connection, and the leaf hostname matched the service. This is trust on first connection, not an independently authenticated CA distribution. Preserve certificate verification and obtain an authoritative CA confirmation when possible. Do not use `rejectUnauthorized: false` or disable TLS verification to make migration appear successful.

For Docker later, mount/copy the certificate to the path referenced inside the container and update the URI accordingly. The current Dockerfile does not include this runtime certificate.

## Solana key continuity

The wallet is devnet-only, funded with faucet SOL. Preserve its existing private key in `.env`; the public address is recorded in private ACCESS.md. `scripts/solana-setup.js` generates a new key and prints its secret. It is not a harmless connectivity command and is unnecessary for this handoff.

## Credential handling and authorized scope

- Credentials can be used by the authorized team through the named Windows runtime. No value needs to appear in a chat or public document.
- The private folder is not part of the ZIP/patch or Git. Protect it with filesystem permissions and encrypted transfer.
- A copied key retains its original scope/expiry; transfer is not account ownership transfer. Console administration may still require Marvin's login or an explicit teammate invitation.
- Free databases and the $0 domain are authorized. There is no authorization to fund Vultr or start paid infrastructure.
- The domain's unused email trial is pending setup and does not auto-renew in that state. Configuring it changes renewal behavior; do not activate paid add-ons as part of a code handoff.
- Keep the actual host IP, usernames, account emails, resource IDs and private proofs in ACCESS.md. This repository file is intentionally sufficient to locate each service without publishing those details.
