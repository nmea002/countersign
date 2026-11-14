// HTTP routes. createApp() takes its adapters as arguments so tests can build it in memory.
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cfg, integrations } from './config.js';
import { seed, SCENARIOS } from './seed.js';

const safeEqual = (a, b) => {
  const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
};

// Fixed-window limiter per client address and bucket. Enough to stop a runaway script.
function limiter(perMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.route?.path || req.path}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > 60000) hits.set(key, { start: now, n: 1 });
    else if (++h.n > perMinute) return res.status(429).json({ error: 'too many requests, slow down' });
    if (hits.size > 5000) hits.clear();
    next();
  };
}

export function createApp({ store, series, bank, ledger, notifier, agent, token = cfg.adminToken, allowReset = cfg.allowReset }) {
  const app = express();
  app.disable('x-powered-by');
  // Keep the raw body: the Nessie webhook signature is computed over it.
  app.use(express.json({ limit: '12mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // ---- access -----------------------------------------------------------------
  // With COUNTERSIGN_TOKEN set, every route except the signed bank webhook needs it,
  // as a Bearer header or the cookie set by /login?token=... . Without it the server
  // only listens on loopback (see server.js), reached through SSH port forwarding.
  const authed = (req) => {
    if (!token) return true;
    const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const cookie = req.get('cookie')?.match(/(?:^|;\s*)cs_token=([^;]+)/)?.[1];
    return [bearer, cookie && decodeURIComponent(cookie)].some((t) => t && safeEqual(t, token));
  };
  app.get('/login', limiter(10), (req, res) => {
    if (!token) return res.redirect('/');
    if (!req.query.token || !safeEqual(req.query.token, token)) return res.status(401).send('Wrong or missing token.');
    res.set('Set-Cookie', `cs_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    res.redirect('/');
  });
  app.use((req, res, next) => {
    if (req.path === '/api/webhooks/nessie' || authed(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
    res.status(401).send('Countersign: open /login?token=YOUR_TOKEN first.');
  });
  // Mutations must be JSON: a cross-site form post cannot send it without a preflight.
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'send application/json' });
    next();
  });
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  // Server-sent events keep the dashboard live while the agent works.
  const clients = new Set();
  const emit = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(err); res.status(400).json({ error: err.message }); });
  const cases = async () => (await store.col('cases').all()).sort((a, b) => b.n - a.n);
  const summary = (r) => ({
    id: r.id, n: r.n, receivedAt: r.receivedAt, status: r.status, source: r.source?.kind, vendorId: r.vendorId, vendorName: r.vendorName,
    amount: r.extracted?.amount ?? null, invoiceNumber: r.extracted?.invoiceNumber ?? null,
    risk: r.verdict?.risk ?? null, verdict: r.verdict?.decision ?? null, top: r.verdict?.findings?.[0]?.title ?? null,
  });
  async function overview() {
    const all = await cases();
    const of = (st) => all.filter((r) => st.includes(r.status));
    const sum = (rows) => rows.reduce((a, r) => a + (r.extracted?.amount || 0), 0);
    return {
      balance: await bank.balance().catch(() => null),
      paid: sum(of(['paid'])), paidCount: of(['paid']).length,
      pending: sum(of(['paying', 'pay_pending'])), pendingCount: of(['paying', 'pay_pending']).length,
      failed: sum(of(['pay_failed'])), failedCount: of(['pay_failed']).length,
      held: sum(of(['held'])), heldCount: of(['held']).length,
      blocked: sum(of(['blocked'])), blockedCount: of(['blocked']).length,
      byVerdict: { clear: all.filter((r) => r.verdict?.decision === 'clear').length, hold: all.filter((r) => r.verdict?.decision === 'hold').length },
    };
  }
  async function health() {
    const meta = await store.col('meta').get('bank').catch(() => null);
    return integrations({
      store: store.kind, series: series.kind, bank: bank.kind, notifier: notifier.health(),
      ledger: ledger.health?.(), nessieHook: meta ? { registered: !!meta.hookId, error: meta.hookError || null } : null,
    });
  }

  const mutate = limiter(30);

  // ---- invoices and cases ----------------------------------------------------

  // A new payment request: {pdfBase64, filename, sender}, {raw} email text, or a demo {scenario}.
  // Add {wait: true} to get the finished case back instead of 202.
  app.post('/api/invoices', mutate, wrap(async (req, res) => {
    const b = req.body || {};
    const input = typeof b.pdfBase64 === 'string' ? { pdf: Buffer.from(b.pdfBase64, 'base64'), filename: String(b.filename || '').slice(0, 120) || undefined, sender: b.sender ? String(b.sender).slice(0, 200) : undefined }
      : typeof b.raw === 'string' ? { raw: b.raw } : SCENARIOS[b.scenario]?.build();
    if (!input) return res.status(400).json({ error: 'send {pdfBase64}, {raw} or a known {scenario}' });
    const p = agent.process(input);
    if (b.wait) return res.status(201).json(await p);
    p.catch((err) => console.error('[agent]', err));
    res.status(202).json({ accepted: true });
  }));

  app.get('/api/cases', wrap(async (req, res) => {
    const all = await cases();
    res.json(all.filter((r) => !req.query.status || r.status === req.query.status).map(summary));
  }));

  app.get('/api/cases/:id', wrap(async (req, res) => {
    const r = await store.col('cases').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const vendor = r.vendorId ? await store.col('vendors').get(r.vendorId) : null;
    res.json({
      case: r, vendor, baseline: vendor ? await series.baseline(vendor.id) : null,
      ledger: (await ledger.entries()).filter((e) => e.requestId === r.id),
    });
  }));

  app.post('/api/cases/:id/decision', mutate, wrap(async (req, res) => {
    if (!['approve', 'hold'].includes(req.body?.action)) return res.status(400).json({ error: 'action must be approve or hold' });
    res.json(summary(await agent.decide(req.params.id, req.body.action, `${cfg.approverName} via dashboard`)));
  }));

  // Grounded question about one case. Informational only: it never changes a decision.
  app.post('/api/cases/:id/ask', limiter(20), wrap(async (req, res) => {
    res.json(await agent.ask(req.params.id, String(req.body?.question || '')));
  }));

  // Cases linked by shared indicators (attacker IPs, bank-account fingerprints).
  app.get('/api/graph', wrap(async (_req, res) => {
    const all = (await cases()).filter((c) => c.indicators?.ips?.length || c.indicators?.fingerprint);
    const nodes = new Map(), edges = [];
    for (const c of all) {
      nodes.set(c.id, { id: c.id, kind: 'case', label: `${c.id} · ${c.vendorName || ''}`, status: c.status, risk: c.verdict?.risk ?? null });
      const inds = [...(c.indicators.ips || []).map((ip) => ({ id: `ip:${ip}`, kind: 'ip', label: ip })),
        ...(c.indicators.fingerprint ? [{ id: `acct:${c.indicators.fingerprint}`, kind: 'account', label: `account ••••${c.extracted?.bank?.last4 || '????'}` }] : [])];
      for (const i of inds) { if (!nodes.has(i.id)) nodes.set(i.id, { ...i, cases: 0 }); nodes.get(i.id).cases++; edges.push({ from: c.id, to: i.id }); }
    }
    res.json({ nodes: [...nodes.values()], edges });
  }));

  // ---- vendors and metrics ---------------------------------------------------

  app.get('/api/vendors', wrap(async (_req, res) => {
    const all = await cases();
    const out = [];
    for (const v of await store.col('vendors').all()) {
      const b = await series.baseline(v.id);
      out.push({
        id: v.id, name: v.name, domain: v.domain, bankLast4: v.bank.last4, bankVerifiedAt: v.bank.verifiedAt,
        lastPayment: b.rows.at(-1) ? { ts: b.rows.at(-1).ts, amount: b.rows.at(-1).amount } : null, averagePayment: b.mean,
        openHolds: all.filter((r) => r.vendorId === v.id && r.status === 'held').length,
        blocked: all.filter((r) => r.vendorId === v.id && r.status === 'blocked').length,
      });
    }
    res.json(out);
  }));

  // Daily totals, from the vendor_daily continuous aggregate when Tiger Data is live.
  app.get('/api/vendors/:id/history', wrap(async (req, res) => res.json(await series.daily(req.params.id))));
  app.get('/api/metrics/overview', wrap(async (_req, res) => res.json(await overview())));
  // Paid / held / declined per month (Tiger time_bucket when live).
  app.get('/api/metrics/timeline', wrap(async (req, res) => res.json(await series.buckets(Math.min(36, Math.max(1, Number(req.query.months) || 13))))));
  // What is actually running, not just which keys are present.
  app.get('/api/health', wrap(async (_req, res) => res.json(await health())));

  // Everything the dashboard needs in one call.
  app.get('/api/state', wrap(async (_req, res) => {
    res.json({
      company: cfg.company, approver: cfg.approverName, integrations: await health(),
      simulator: notifier.kind === 'simulator', resetAllowed: allowReset,
      scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, hint: s.hint })),
      cases: (await cases()).map(summary),
      stats: await overview(),
      messages: (await store.col('messages').all()).sort((a, b) => a.ts.localeCompare(b.ts)),
      ledger: (await ledger.entries()).reverse(),
      ledgerCheck: await ledger.verify(),
    });
  }));

  // ---- messaging, bank hook, ledger, seed ------------------------------------

  // The on-screen phone. Disabled once a real Photon line is connected.
  app.post('/api/sms/reply', mutate, wrap(async (req, res) => {
    if (notifier.kind !== 'simulator') return res.status(403).json({ error: 'Photon is live: reply from the approver\'s phone' });
    res.json({ answer: await notifier.receive(String(req.body?.text || '').slice(0, 500), cfg.approverName) });
  }));

  // Nessie decision hook: the bank asks before a transfer settles. Only a transfer that
  // matches a payment Countersign itself started is approved; everything else is declined.
  app.post('/api/webhooks/nessie', limiter(120), wrap(async (req, res) => {
    if (!bank.decideHook) return res.status(404).json({ error: 'Nessie is not configured' });
    const out = await bank.decideHook(req.rawBody?.toString('utf8') || '{}', req.get('Nessie-Signature'), await store.col('cases').all());
    res.status(out.status).json(out.body);
  }));

  app.get('/api/ledger/verify', wrap(async (_req, res) => res.json(await ledger.verify())));
  // One entry against Solana devnet: recomputed hash, on-chain memo and signer must all match.
  app.get('/api/ledger/:id/onchain', limiter(30), wrap(async (req, res) => res.json(await ledger.verifyOnChain(req.params.id))));

  // Reset needs an explicit confirmation, and can be disabled with ALLOW_RESET=0.
  app.post('/api/seed', limiter(3), wrap(async (req, res) => {
    if (!allowReset) return res.status(403).json({ error: 'reset is disabled on this server (ALLOW_RESET=0)' });
    if (req.body?.confirm !== 'reset') return res.status(400).json({ error: 'send {"confirm":"reset"} to reload demo data' });
    await seed({ store, series, bank, keepMessages: notifier.kind !== 'simulator' });
    emit('reset', {});
    res.json({ vendors: (await store.col('vendors').all()).length, payments: (await series.paid()).length, signins: (await store.col('signins').all()).length });
  }));

  return { app, emit };
}
