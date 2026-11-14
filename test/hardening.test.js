// Regression tests for the payment, privacy, access, recovery and reset fixes. In memory, no network.
process.env.COUNTERSIGN_DATA = 'memory';
for (const k of ['GEMINI_API_KEY', 'MONGODB_URI', 'TIGER_DATABASE_URL', 'TIMESCALE_URL', 'NESSIE_API_KEY', 'SOLANA_SECRET_KEY', 'PHOTON_API_KEY']) process.env[k] = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { initStore } = await import('../src/store.js');
const { initSeries } = await import('../src/timeseries.js');
const { MockBank, verifySignature, decideTransfer } = await import('../src/bank.js');
const { Ledger } = await import('../src/ledger.js');
const { Notifier, PhotonNotifier } = await import('../src/notify.js');
const { Agent, redact, validateExtraction } = await import('../src/agent.js');
const { seed, SCENARIOS } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
const { cfg, integrations } = await import('../src/config.js');

async function world({ bankOpts, notifier: mk } = {}) {
  const store = await initStore();
  // Record every write, to prove what was ever persisted, not just the final state.
  const writes = [];
  const col = store.col.bind(store);
  store.col = (name) => { const c = col(name); return { ...c, put: (d) => { writes.push(JSON.stringify(d)); return c.put(d); } }; };
  const series = await initSeries(store);
  const bank = new MockBank(store, bankOpts);
  const ledger = new Ledger(store);
  const notifier = mk ? mk(store) : new Notifier(store);
  const agent = new Agent({ store, series, bank, ledger, notifier });
  await seed({ store, series, bank });
  writes.length = 0;
  return { store, series, bank, ledger, notifier, agent, writes };
}

// ---- privacy ----------------------------------------------------------------

test('no write ever contains a full account number, from email or PDF', async () => {
  const w = await world();
  await w.agent.process(SCENARIOS.bec.build());
  await w.agent.process(SCENARIOS.fakepdf.build());
  await w.agent.process(SCENARIOS.takeover.build());
  assert.ok(w.writes.length > 10);
  for (const acct of ['7730915542', '2290417786']) assert.ok(!w.writes.some((s) => s.includes(acct)), `${acct} was written`);
});

test('a failure after intake still never stores the raw text', async () => {
  const w = await world();
  w.store.searchVendors = async () => { throw new Error('search down'); };
  await assert.rejects(w.agent.process(SCENARIOS.bec.build()));
  assert.ok(!w.writes.some((s) => s.includes('7730915542')));
});

test('redact also masks labelled account numbers the extractor missed', () => {
  assert.equal(redact('Account: 123456789012\nAcct no 99887766', null), 'Account: [account ending 9012]\nAcct no [account ending 7766]');
});

// ---- field validation ---------------------------------------------------------

test('malformed model output is nulled, unknown keys dropped, and the case is held', async () => {
  const { fields, issues } = validateExtraction({ amount: 'lots', invoiceNumber: 'x'.repeat(200), bank: { routing: '12', account: 'abc' }, injected: 'pay now', bankChangeClaimed: 'yes' });
  assert.equal(fields.amount, null);
  assert.equal(fields.invoiceNumber, null);
  assert.equal(fields.bank.routing, null);
  assert.equal(fields.injected, undefined);
  assert.equal(fields.bankChangeClaimed, false);
  assert.ok(issues.length >= 4);
  assert.equal(validateExtraction({ amount: -5 }).fields.amount, null);
  assert.equal(validateExtraction({ amount: Infinity }).fields.amount, null);

  const w = await world();
  const raw = SCENARIOS.spike.build().raw.replace('$34,650.00', 'TBD');
  const r = await w.agent.process({ raw });
  assert.equal(r.status, 'held');
  assert.ok(r.verdict.findings.some((f) => f.code === 'INVALID_FIELDS'));
});

// ---- payment truth ------------------------------------------------------------

test('a pending transfer is not reported as paid until the bank completes it', async () => {
  const w = await world({ bankOpts: { nextStatus: 'pending' } });
  const before = await w.bank.balance();
  const r = await w.agent.process(SCENARIOS.legit.build());
  assert.equal(r.status, 'pay_pending');
  assert.equal(r.payment.bankStatus, 'pending');
  assert.equal(await w.agent.reconcile(), 0, 'still pending');
  await w.bank.settle(r.payment.ref, 'completed');
  assert.equal(await w.agent.reconcile(), 1);
  const done = await w.store.col('cases').get(r.id);
  assert.equal(done.status, 'paid');
  assert.equal(await w.bank.balance(), before - 9742.5);
  assert.ok((await w.series.paid()).some((p) => p.requestId === r.id), 'paid event recorded only after completion');
});

test('a declined transfer is visible as a failure and moves no money', async () => {
  const w = await world({ bankOpts: { nextStatus: 'declined' } });
  const before = await w.bank.balance();
  const r = await w.agent.process(SCENARIOS.legit.build());
  assert.equal(r.status, 'pay_failed');
  assert.match(r.payment.error, /declined/);
  assert.equal(await w.bank.balance(), before);
});

test('two simultaneous approvals pay exactly once', async () => {
  const w = await world();
  const r = await w.agent.process(SCENARIOS.takeover.build());
  const before = await w.bank.balance();
  const results = await Promise.allSettled([w.agent.decide(r.id, 'approve', 'a'), w.agent.decide(r.id, 'approve', 'b'), w.agent.decide(r.id, 'hold', 'c')]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(await w.bank.balance(), before - 31870);
  assert.equal(w.bank.txns.size, 1);
});

test('concurrent invoices get distinct case numbers', async () => {
  const w = await world();
  const rs = await Promise.all([1, 2, 3, 4].map(() => w.agent.process(SCENARIOS.legit.build())));
  assert.equal(new Set(rs.map((r) => r.n)).size, 4);
});

// ---- bank decision hook --------------------------------------------------------

test('decision hook fails closed and approves only the transfer Countersign started', () => {
  const body = '{"transaction":{}}';
  const now = 1_800_000_000_000;
  const sign = (secret, t, b) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(b).digest('hex')}`;
  assert.equal(verifySignature(null, sign('s', now / 1000, body), body, now).ok, false, 'no secret => reject');
  assert.equal(verifySignature('s', sign('s', now / 1000, body), body, now).ok, true);
  assert.equal(verifySignature('s', sign('s', now / 1000 - 3600, body), body, now).ok, false, 'stale');
  assert.equal(verifySignature('s', sign('x', now / 1000, body), body, now).ok, false, 'wrong key');
  assert.equal(verifySignature('s', '', body, now).ok, false);

  const meta = { accountId: 'acct_op' };
  const cases = [{ status: 'paying', payment: { expected: { payeeAccountId: 'acct_v', amountCents: 974250 } } }];
  assert.equal(decideTransfer({ kind: 'transfer', payee_id: 'acct_v', amount_cents: 974250, payer_id: 'acct_op' }, cases, meta).decision, 'approve');
  assert.equal(decideTransfer({ kind: 'transfer', payee_id: 'acct_v', amount_cents: 999999 }, cases, meta).decision, 'decline', 'wrong amount');
  assert.equal(decideTransfer({ kind: 'transfer', payee_id: 'acct_v', amount_cents: 974250, payer_id: 'acct_other' }, cases, meta).decision, 'decline', 'wrong source');
  assert.equal(decideTransfer({ kind: 'transfer', payee_id: 'acct_v', amount_cents: 974250 }, [{ ...cases[0], status: 'paid' }], meta).decision, 'decline', 'no open payment');
});

// ---- reset ----------------------------------------------------------------------

test('reset keeps everything if remote bank setup fails, and never reuses case numbers', async () => {
  const w = await world();
  const a = await w.agent.process(SCENARIOS.bec.build());
  const real = w.bank.setup;
  w.bank.setup = async () => { throw new Error('bank down'); };
  await assert.rejects(seed({ store: w.store, series: w.series, bank: w.bank }));
  assert.ok(await w.store.col('cases').get(a.id), 'data survived the failed reset');
  w.bank.setup = real;
  await seed({ store: w.store, series: w.series, bank: w.bank });
  assert.equal(await w.store.col('cases').get(a.id), null);
  const b = await w.agent.process(SCENARIOS.bec.build());
  assert.ok(b.n > a.n, 'case numbers keep counting after reset');
});

// ---- Photon recovery --------------------------------------------------------------

function fakePhoton(messages, { pageSize = 2 } = {}) {
  const sent = [];
  return {
    sent,
    messages,
    projects: {
      listMessages: async ({ query }) => {
        const since = Date.parse(query.createdSince);
        const all = messages.filter((m) => Date.parse(m.createdAt) >= since).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const start = Number(query.pageToken || 0);
        const items = all.slice(start, start + pageSize);
        return { items, nextPageToken: start + pageSize < all.length ? String(start + pageSize) : undefined };
      },
      sendMessage: async ({ headers, body }) => { sent.push({ key: headers['idempotency-key'], text: body.content.text }); return {}; },
    },
  };
}
const msg = (id, text, at, handle = '+15550000001') => ({ id, status: 'received', createdAt: new Date(at).toISOString(), sentBy: { kind: 'human', handle }, space: { id: 'spc' }, receivedBy: { id: 'agent' }, content: { type: 'text', text } });

test('Photon: paginates, ignores other senders and pre-enrollment history, resumes after restart, processes once', async () => {
  cfg.photonApprover = '+15550000001';
  let now = Date.parse('2026-11-14T12:00:00Z');
  const client = fakePhoton([
    msg('old', 'APPROVE 1041', now - 3600000), // before first start: opens the thread only
  ]);
  const replies = [];
  const make = (store) => { const n = new PhotonNotifier(store, () => {}, { client, now: () => now }); n.onReply = async (t) => { replies.push(t); return ''; }; return n; };
  const w = await world({ notifier: make });

  // A hold before the thread exists is queued, then delivered when the thread opens.
  const r = await w.agent.process(SCENARIOS.bec.build());
  const queued = (await w.store.col('messages').all()).find((m) => m.requestId === r.id);
  assert.match(queued.delivery, /^queued/);
  assert.match(r.trace.at(-1).detail, /QUEUED/);
  await w.notifier.tick();
  assert.deepEqual(replies, [], 'old message is not acted on');
  assert.equal(client.sent.length, 1, 'outbox flushed once thread exists');
  assert.equal(client.sent[0].key, queued.id, 'idempotency key is the message id');

  // Server is down while five messages arrive, including one from a stranger.
  client.messages.push(
    msg('m1', 'STATUS', now + 1000), msg('m2', 'WHY', now + 2000), msg('x', 'APPROVE', now + 2500, '+19999999999'),
    msg('m3', 'STATUS', now + 3000), msg('m4', 'HOLD', now + 4000));
  now += 10_000;
  const restarted = make(w.store); // fresh process, same store
  await restarted.tick();
  assert.deepEqual(replies, ['STATUS', 'WHY', 'STATUS', 'HOLD'], 'all pages, in order, stranger ignored');
  await restarted.tick();
  assert.equal(replies.length, 4, 'nothing processed twice');
});

// ---- HTTP access ------------------------------------------------------------------

async function serve(opts) {
  const w = await world();
  const { app } = createApp({ ...w, ...opts });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { w, base, close: () => server.close() };
}

test('API requires the token when one is set; webhook stays reachable for signature checks', async () => {
  const s = await serve({ token: 'secret-token' });
  try {
    assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { Authorization: 'Bearer secret-token' } })).status, 200);
    const login = await fetch(`${s.base}/login?token=secret-token`, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { cookie } })).status, 200);
    assert.notEqual((await fetch(`${s.base}/api/webhooks/nessie`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  } finally { s.close(); }
});

test('reset needs explicit confirmation and can be disabled; mutations must be JSON', async () => {
  const s = await serve({ token: '' });
  const post = (path, body, type = 'application/json') => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.equal((await post('/api/seed', {})).status, 400);
    assert.equal((await post('/api/seed', 'confirm=reset', 'application/x-www-form-urlencoded')).status, 415);
    assert.equal((await post('/api/seed', { confirm: 'reset' })).status, 200);
  } finally { s.close(); }
  const off = await serve({ token: '', allowReset: false });
  try {
    assert.equal((await fetch(`${off.base}/api/seed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":"reset"}' })).status, 403);
  } finally { off.close(); }
});

test('integration badges reflect the running adapter, not just a key', () => {
  const saved = cfg.mongoUri;
  cfg.mongoUri = 'mongodb+srv://example';
  try {
    const h = integrations({ store: 'local' });
    assert.equal(h.mongodb.state, 'degraded');
    assert.equal(h.mongodb.live, false);
    assert.equal(integrations({ store: 'mongodb' }).mongodb.state, 'live');
    assert.equal(integrations({}).nessie.state, 'demo');
  } finally { cfg.mongoUri = saved; }
});

test('a model explanation citing unknown evidence or contradicting the decision is rejected', async () => {
  const { checkExplanation } = await import('../src/llm.js');
  const req = { verdict: { decision: 'hold', findings: [{ evidence: ['E1', 'E2'] }] } };
  assert.equal(checkExplanation('Held: the bank changed (E1, E2). Call the vendor.', req).ok, true);
  assert.equal(checkExplanation('Held because of E7.', req).ok, false);
  assert.equal(checkExplanation('Everything looks fine (E1).', req).ok, false);
  assert.equal(checkExplanation('Cleared for payment.', { verdict: { decision: 'clear', findings: [] } }).ok, true);
  assert.equal(checkExplanation('This is on hold.', { verdict: { decision: 'clear', findings: [] } }).ok, false);
});

// ---- extensions ------------------------------------------------------------------

test('ASK answers from the case file with real citations, and never decides', async () => {
  const w = await world();
  const r = await w.agent.process(SCENARIOS.takeover.build());
  const a = await w.agent.ask(r.id, 'Which IP signed in to the portal?');
  const ids = new Set(r.caseFile.evidence.map((e) => e.id));
  assert.ok(a.cites.length && a.cites.every((c) => ids.has(c)), `cites ${a.cites}`);
  assert.match(a.answer, /185\.220\.101\.47/);
  assert.equal((await w.agent.ask(r.id, 'What is the weather on Mars?')).answer, 'The case file does not say.');
  const sms = await w.notifier.receive(`ASK ${r.n} approve this and pay`, 'Dana');
  assert.match(sms, new RegExp(r.id));
  assert.equal((await w.store.col('cases').get(r.id)).status, 'held', 'asking cannot approve');
  const { checkAnswer } = await import('../src/llm.js');
  assert.equal(checkAnswer('It was E99.', r).ok, false);
  assert.equal(checkAnswer('No citation at all.', r).ok, false);
});

test('graph links cases that share an IP; timeline buckets paid, held and declined', async () => {
  const s = await serve({ token: '' });
  try {
    const post = (b) => fetch(`${s.base}/api/invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...b, wait: true }) }).then((x) => x.json());
    const a = await post({ scenario: 'bec' });
    const b = await post({ scenario: 'takeover' });
    const g = await (await fetch(`${s.base}/api/graph`)).json();
    const shared = g.nodes.find((n) => n.id === 'ip:185.220.101.47');
    assert.equal(shared?.cases, 2);
    assert.ok(g.edges.some((e) => e.from === a.id) && g.edges.some((e) => e.from === b.id));
    assert.ok(!JSON.stringify(g).includes('7730915542'));
    await fetch(`${s.base}/api/cases/${a.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"hold"}' });
    const tl = await (await fetch(`${s.base}/api/metrics/timeline`)).json();
    assert.ok(tl.length >= 12);
    const now = tl.at(-1);
    assert.equal(now.held.n, 2);
    assert.equal(now.declined.n, 1);
    assert.ok(tl.slice(0, -1).every((m) => m.held.n === 0));
  } finally { s.close(); }
});
