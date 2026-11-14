import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const e = process.env;

// COUNTERSIGN_DISABLE=photon,solana,... forces those integrations to their stand-ins whatever
// .env says. Works the same from any shell (PowerShell deletes a variable set to '').
const DISABLE_KEYS = {
  gemini: ['GEMINI_API_KEY'], mongodb: ['MONGODB_URI'], tiger: ['TIGER_DATABASE_URL', 'TIMESCALE_URL'],
  nessie: ['NESSIE_API_KEY'], solana: ['SOLANA_SECRET_KEY'], photon: ['PHOTON_API_KEY'],
};
for (const name of String(e.COUNTERSIGN_DISABLE || '').toLowerCase().split(/[\s,]+/).filter(Boolean)) {
  if (name === 'all') { for (const keys of Object.values(DISABLE_KEYS)) for (const k of keys) e[k] = ''; continue; }
  if (!DISABLE_KEYS[name]) throw new Error(`COUNTERSIGN_DISABLE: unknown integration "${name}" (use ${Object.keys(DISABLE_KEYS).join(', ')} or all)`);
  for (const k of DISABLE_KEYS[name]) e[k] = '';
}

export const cfg = {
  port: Number(e.PORT || 3000),
  host: e.HOST || '127.0.0.1', // loopback by default; reach it through SSH port forwarding
  adminToken: e.COUNTERSIGN_TOKEN || '', // required for any non-loopback HOST
  allowReset: e.ALLOW_RESET !== '0',
  dataFile: e.COUNTERSIGN_DATA || 'data/db.json', // "memory" keeps everything in RAM
  company: e.COMPANY_NAME || 'Tidewater Brewing Co.',
  approverName: e.APPROVER_NAME || 'Dana (Controller)',

  geminiKey: e.GEMINI_API_KEY || '',
  geminiModel: e.GEMINI_MODEL || 'gemini-3.5-flash-lite',

  mongoUri: e.MONGODB_URI || '',
  mongoDb: e.MONGODB_DB || 'countersign',
  atlasSearchIndex: e.ATLAS_SEARCH_INDEX || '', // optional Atlas Search index on vendors.name

  tigerUrl: e.TIGER_DATABASE_URL || e.TIMESCALE_URL || '',

  nessieKey: e.NESSIE_API_KEY || '',
  nessieBase: e.NESSIE_URL || 'https://v2-prod-api.nessieisreal.com',
  publicUrl: (e.PUBLIC_URL || '').replace(/\/$/, ''), // set when deployed, enables the Nessie decision hook

  solanaSecret: e.SOLANA_SECRET_KEY || '', // JSON byte array, as written by scripts/solana-setup.js
  solanaRpc: e.SOLANA_RPC_URL || 'https://api.devnet.solana.com',

  photonKey: e.PHOTON_API_KEY || '',
  photonProject: e.PHOTON_PROJECT_ID || '',
  photonPlatform: e.PHOTON_PLATFORM || 'imessage',
  photonApprover: e.PHOTON_APPROVER_HANDLE || '', // the approver's own phone, E.164
  photonAgent: e.PHOTON_AGENT_HANDLE || '', // the number Photon assigned to the agent
};

// Per integration: configured (a key is present), the adapter actually running, and the
// result of its last real operation. state is one of:
//   demo      not configured; the stand-in is running, as intended
//   degraded  configured, but the stand-in is running or the last operation failed
//   active    the live adapter is running; no operation has succeeded yet
//   live      the live adapter is running and its last operation succeeded
// `live` is true only for state 'live'.
export const health = { gemini: null, nessie: null, solana: null }; // { ok, ts, error } of the last call

export function integrations(actual = {}) {
  const one = (configured, running, liveLabel, fallback, last) => {
    let state = !configured ? 'demo' : !running ? 'degraded' : !last ? 'active' : last.ok ? 'live' : 'degraded';
    const why = configured && !running ? ' (configured, but the fallback is running)' : last && !last.ok ? ` (last call failed: ${last.error})` : state === 'active' ? ' (no call verified yet)' : '';
    return { live: state === 'live', state, configured: !!configured, detail: (running ? liveLabel : fallback) + why };
  };
  const ok = (v) => (v === undefined ? null : v);
  const photonHealth = actual.notifier;
  const hook = actual.nessieHook;
  return {
    gemini: one(cfg.geminiKey, !!cfg.geminiKey, cfg.geminiModel, 'rule-based extractor', health.gemini),
    mongodb: one(cfg.mongoUri, actual.store === 'mongodb', `Atlas · ${cfg.mongoDb}`, 'local JSON store', actual.store === 'mongodb' ? { ok: true } : null),
    tiger: one(cfg.tigerUrl, actual.series === 'tiger', 'hypertable + continuous aggregate', 'in-process time series', actual.series === 'tiger' ? { ok: true } : null),
    nessie: one(cfg.nessieKey, actual.bank === 'nessie', `Capital One Nessie v2${hook ? (hook.registered ? ' · decision hook on' : hook.error ? ` · decision hook FAILED: ${hook.error}` : ' · no decision hook (no PUBLIC_URL)') : ''}`, 'mock bank', ok(health.nessie)),
    solana: one(cfg.solanaSecret, !!cfg.solanaSecret, 'devnet memo anchor', 'local hash chain only', ok(health.solana)),
    photon: one(cfg.photonKey && cfg.photonProject && cfg.photonApprover, photonHealth?.kind === 'photon', cfg.photonPlatform, 'on-screen phone simulator',
      photonHealth?.kind === 'photon' && (photonHealth.lastPoll || photonHealth.lastError) ? { ok: photonHealth.ok, error: photonHealth.lastError } : null),
  };
}
export function noteHealth(name, ok, error = null) { health[name] = { ok, error: error ? String(error).slice(0, 200) : null, ts: new Date().toISOString() }; }
