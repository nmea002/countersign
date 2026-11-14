# Windows teammate host: same Wi-Fi/LAN

This is the requested primary hosting arrangement. Nothing needs to run on Marvin's Mac after source/config transfer. The Windows laptop must remain powered, awake and connected for the app to stay available. No Windows host has been configured or tested by this handoff.

## Recommended arrangement

```text
Git repo / portable patch -> Windows host checkout
                              |
                         Node server :3000
                              |
                    outbound service API calls

Your VS Code / another agent -- authenticated SSH --> Windows filesystem/terminal
Your browser/API client ------ SSH port forward ---> server :3000
```

Use native Windows Node for this small project; Docker/WSL are not required for the first handoff. Start with one authoritative runtime and one Photon poller. Give each coding agent a branch/worktree, not simultaneous ownership of the same files.

**Live Share is optional for human pairing. Remote-SSH is the better primary route for running commands/agents on the actual host.** Microsoft documents Remote-SSH as remote filesystem, terminal and extension execution, including Windows OpenSSH hosts. Live Share's VS Code extension is in maintenance mode, with no new features planned. An arbitrary AI extension's support for Live Share guest files is not guaranteed. Sources, checked November 14, 2026: [Remote-SSH](https://code.visualstudio.com/docs/remote/ssh), [Live Share](https://learn.microsoft.com/en-us/visualstudio/liveshare/), [maintenance notice](https://learn.microsoft.com/en-us/visualstudio/liveshare/maintenance-mode).

## 1. Receive source without depending on this chat

Install Git, Node 24 and VS Code from their official distributions. Node 24 matches this repository's CI and Docker image. Use PowerShell commands below from the Windows laptop; placeholders must be replaced with real paths/users/IPs.

Preferred: clone the repository and apply the exported patch to the audited commit. The patch includes handoff files and the local dependency-lock change; it contains no private environment.

First extract the handoff bundle. From its directory, compare these SHA-256 values with `SHA256SUMS.txt` received through the trusted handoff channel; stop if either differs. Checksums detect changed/corrupted files, but a manifest received from the same untrusted source is not an authenticity proof.

```powershell
Get-FileHash .\countersign-source.zip -Algorithm SHA256
Get-FileHash .\countersign-handoff.patch -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

The commands below assume the patch was copied to Downloads. Otherwise replace that path with its location in the extracted bundle.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\source" | Out-Null
Set-Location "$env:USERPROFILE\source"
git clone https://github.com/nmea002/countersign.git
Set-Location countersign
git switch -c team/windows-handoff 9a3c689e115a245b83a4f55722222771cc87c806
git apply --check "$env:USERPROFILE\Downloads\countersign-handoff.patch"
git apply "$env:USERPROFILE\Downloads\countersign-handoff.patch"
git status --short
node --version
npm.cmd --version
npm.cmd ci
npm.cmd test
```

Use `npm.cmd` if PowerShell blocks `npm.ps1`; no execution-policy change is necessary. If the target checkout already has edits, do not overwrite them; apply on a clean branch/worktree and integrate deliberately.

Alternative: extract `countersign-source.zip`. It contains the current working source and docs but no `.git` history. Open its `countersign` folder and run `npm.cmd ci`. Prefer the clone+patch route for continued team development.

## 2. Transfer private configuration separately

Marvin has prepared `/Users/marbin/.config/countersign/teammate-transfer` on his Mac:

```text
.env                     real service credentials; PRIVATE
certs/tiger-ca.crt        Tiger TLS trust certificate
ACCESS.md                private account/project inventory and migration notes
README.txt               placement instructions
```

Transfer this folder through an encrypted channel such as an end-to-end encrypted password-manager share, or SCP/SFTP to the identified teammate's account after SSH is set up. Do not send its contents to an AI chat or commit/upload them with the source ZIP. Confirm the destination teammate/host before transmitting.

On Windows, copy `.env` into the repository root, copy the `certs` directory beside it, and keep `ACCESS.md`/`README.txt` outside the repository (for example in a private directory under the host user's profile). Enable hidden-file display if needed. Restrict `.env` and the private inventory to the runtime owner through Windows file Properties > Security; Git-ignore is not a Windows access-control mechanism.

The portable `.env`:

- Contains the six current application credential sets, current Photon v2 project/line, model choice and app settings.
- Sets `PORT=3000` and leaves `PUBLIC_URL` blank.
- Uses `sslmode=verify-full` with `sslrootcert=certs/tiger-ca.crt`; run Node from the repository root so the relative path resolves.
- Excludes unused legacy Spectrum credentials.

Confirm presence without displaying values:

```powershell
git check-ignore .env certs/tiger-ca.crt
node --env-file=.env -e "const names=['NESSIE_API_KEY','GEMINI_API_KEY','PHOTON_API_KEY','PHOTON_PROJECT_ID','PHOTON_APPROVER_HANDLE','MONGODB_URI','TIGER_DATABASE_URL','SOLANA_SECRET_KEY']; for (const n of names) console.log(n+': '+(process.env[n]?'set':'MISSING'));"
Test-Path .\certs\tiger-ca.crt
```

Migration details:

- **MongoDB:** Atlas currently allows the original development egress IP only. The same Wi-Fi may share that public IP, but VPNs and routing can differ. Check the Windows host's egress and add only that required IP/range in Atlas; do not open the cluster to the whole internet.
- **Tiger:** the original Mac URI uses an absolute Mac certificate path. Use the prepared portable copy. Do not disable TLS verification. The CA was captured from the service on first connection, not independently distributed; see SERVICE_ACCESS.md.
- **Photon:** the enrolled approver remains Marvin's verified phone. A teammate operating the server does not need to become the approver. Adding a different approver requires explicit enrollment/verification and first contact with its assigned line.
- **Solana:** transfer the existing funded development key; do not run `scripts/solana-setup.js` again, because it generates and prints a new secret.
- Each agent product may need its own sign-in on Windows. Application API keys do not sign an AI coding agent into its provider.

## 3. Set up authenticated team access

The server now binds to `127.0.0.1` by default and refuses a non-loopback `HOST` unless `COUNTERSIGN_TOKEN` is set; the token is one shared operator secret, not per-user roles. Same Wi-Fi does **not** mean all participants on that network should have payment/reset access. Prefer SSH forwarding and keep port 3000 closed to inbound network connections.

The Windows owner should enable the supported OpenSSH Server optional feature, start `sshd`, and configure a project-specific standard user or other appropriately restricted account. Use individual SSH keys where possible. Verify the host-key fingerprint with the owner before accepting the first connection. Microsoft's exact current setup steps are in [OpenSSH for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse).

In Windows Defender Firewall with Advanced Security:

1. Restrict the SSH inbound rule (TCP 22) to the team's specific source addresses and the appropriate trusted network profile. The installation may create a broader default rule; review it rather than leaving duplicate broad access.
2. Do not approve broad Node inbound access. Keep TCP 3000 blocked to network peers; SSH on the host reaches it locally.
3. Do not forward router ports or make a public tunnel for the full app. Authentication/authorization must be implemented before broad exposure.

Find the host's IPv4 address with `ipconfig`. On each client, use the actual Windows username and host IP:

```sh
ssh WINDOWS_USER@HOST_LAN_IP
```

In VS Code: install Remote-SSH, choose **Remote-SSH: Connect to Host**, connect to that user/IP, then open the Windows checkout. New integrated terminals run on the Windows host. Install/run the desired coding agent in that remote environment; verify the extension or CLI actually executes there. Do not assume a local desktop agent automatically gained remote shell access.

For browser/API access, keep this tunnel open on the client:

```sh
ssh -N -L 127.0.0.1:3000:127.0.0.1:3000 WINDOWS_USER@HOST_LAN_IP
```

Then open `http://127.0.0.1:3000` on the client. That address forwards to the teammate's machine: the Node server still runs entirely on Windows. If local port 3000 is busy, use `-L 127.0.0.1:3100:127.0.0.1:3000` and open port 3100. VS Code's Ports panel can do this too; use the displayed forwarded address.

**Verify the boundary from a second LAN machine:** direct access to `http://HOST_LAN_IP:3000/api/state` must fail, while the same read through the authenticated SSH-forwarded `http://127.0.0.1:3000/api/state` succeeds. On a Windows client, `Test-NetConnection HOST_LAN_IP -Port 3000` must report `TcpTestSucceeded: False`. Check every network interface/profile in use, and record the effective firewall rule/profile in private ACCESS.md. If direct access succeeds, stop serving and correct the firewall before continuing. The loopback bind is in code now (`HOST`, default `127.0.0.1`); keep the firewall rule anyway as a second layer.

If the team later chooses direct LAN HTTP, add app authentication/authorization first and restrict Windows firewall access to specific teammates. A URL such as `http://HOST_LAN_IP:3000` is not yet a verified deliverable. Campus Wi-Fi client isolation can block peer-to-peer connections even when both machines use the same SSID; a trusted team router/hotspot or an approved private network is then needed.

## 4. Start and verify on Windows

First address the critical defects in HANDOFF.md. Starting with an empty database automatically seeds; reset clears data and creates remote resources. Do not treat startup/reset as read-only checks.

The integration owner should enable and verify services one at a time. Shell environment variables take precedence over values loaded from `.env`, so an integration test process can deliberately disable unrelated adapters without deleting the stored credential file. Record which adapters were enabled; never pass a fallback off as live success.

After the readiness checks for the intended integration phase, prefer the supervised runner (restarts on crash, keeps the laptop awake, logs to `data\logs`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-windows.ps1
```

To keep some services off while testing, set `$env:COUNTERSIGN_DISABLE = 'photon,solana'` first (names: gemini, mongodb, tiger, nessie, solana, photon, all). Do **not** blank a key with `$env:KEY = ''`: PowerShell deletes the variable and the `.env` value then applies.

Or in the foreground:

```powershell
Set-Location "$env:USERPROFILE\source\countersign"
npm.cmd start
```

In a second terminal on the Windows host:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/state
Invoke-RestMethod http://127.0.0.1:3000/api/vendors
Invoke-RestMethod http://127.0.0.1:3000/api/ledger/verify
```

Those reads do not initiate a reset, though state reads expose synthetic case/message information. Verify actual adapter behavior independently; configuration badges are insufficient. Use API.md for mutating acceptance checks, one at a time.

Keep the host plugged in and prevent sleep while serving. The foreground Node process ends when its terminal/process ends; VS Code/Live Share is not a process supervisor. For a longer event run, have the Windows owner configure a dedicated process/service/task after startup and graceful restart behavior are verified. Do not run duplicate servers/pollers against the shared live configuration.

Before marking Windows hosting complete, record one runtime owner and the chosen supervised startup mechanism, repository working directory, environment and log locations in private ACCESS.md. Verify start after reboot, graceful stop/restart, and prevention of duplicate instances/Photon processing. Foreground startup alone is a development setup, not a completed event-server handover.

## 5. Team branches and runtime ownership

- One branch/worktree per coding agent; one maintainer integrates changes and restarts the authoritative server.
- If agents run on the same host, choose separate ports and avoid shared live credentials for test instances.
- Keep `.env` out of Git and give it only to operators who need it. No code agent should paste keys into a model prompt.
- When the repository owner grants push access, commit/push the handoff and completed fixes. Until then, authorized teammates can apply patches.
- Log host username/IP, active branch/commit, port, process owner and startup command in the **private** ACCESS.md, not public repository docs.

## LAN hosting does not activate the public domain

`countersign.work` remains registered but unconnected. A private LAN IP or SSH port forward cannot receive an internet-originated Nessie webhook. Domain/HTTPS/public webhook work needs a separate, deliberately secured ingress design. Vultr can remain blocked without preventing team development on Windows.
