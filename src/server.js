// Boots the one authoritative Countersign runtime: adapters, worker, Photon poller, HTTP.
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { cfg, integrations } from './config.js';
import { initStore } from './store.js';
import { initSeries } from './timeseries.js';
import { initBank } from './bank.js';
import { Ledger } from './ledger.js';
import { initNotifier } from './notify.js';
import { Agent } from './agent.js';
import { seed } from './seed.js';
import { createApp } from './app.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK.has(cfg.host) && !cfg.adminToken) {
  console.error(`Refusing to listen on ${cfg.host} without COUNTERSIGN_TOKEN: anyone on the network could approve payments. Use HOST=127.0.0.1 with SSH forwarding, or set a token.`);
  process.exit(1);
}

// One runtime per data directory, so two servers never poll the same Photon inbox or pay twice.
const lockFile = `${dirname(cfg.dataFile === 'memory' ? 'data/x' : cfg.dataFile)}/server.lock`;
function takeLock() {
  mkdirSync(dirname(lockFile), { recursive: true });
  try {
    const fd = openSync(lockFile, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(readFileSync(lockFile, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive && pid !== process.pid) {
      console.error(`Another Countersign server (pid ${pid}) is already running from this folder. Stop it first, or delete ${lockFile} if it is stale.`);
      process.exit(1);
    }
    unlinkSync(lockFile);
    return takeLock();
  }
  const release = () => { try { if (Number(readFileSync(lockFile, 'utf8')) === process.pid) unlinkSync(lockFile); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));
}
takeLock();

let forward = () => {};
const emit = (type, data) => forward(type, data);
const store = await initStore();
const series = await initSeries(store);
const bank = initBank(store);
const ledger = new Ledger(store, emit);
const notifier = initNotifier(store, emit);
const agent = new Agent({ store, series, bank, ledger, notifier, emit, stepDelayMs: Number(process.env.STEP_DELAY_MS ?? 450) });
const { app, emit: appEmit } = createApp({ store, series, bank, ledger, notifier, agent });
forward = appEmit;

if (!(await store.col('vendors').all()).length) {
  console.log('[seed] loading demo company, vendors and a year of payment history');
  await seed({ store, series, bank, keepMessages: true });
}
await notifier.start();
agent.startWorker(Number(process.env.REMIND_AFTER_MIN ?? 30) * 60000);

app.listen(cfg.port, cfg.host, () => {
  console.log(`Countersign guarding ${cfg.company} on http://${cfg.host}:${cfg.port}${cfg.adminToken ? ' (token required: open /login?token=...)' : ' (loopback only)'}`);
  const h = integrations({ store: store.kind, series: series.kind, bank: bank.kind, notifier: notifier.health() });
  for (const [k, v] of Object.entries(h)) console.log(`  ${v.state.padEnd(10)} ${k.padEnd(8)} ${v.detail}`);
});
