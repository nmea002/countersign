// The Countersign agent: invoice in -> read -> screen -> (investigate) -> verdict ->
// pay or hold-and-text -> approver replies -> pay or block. Every step is traced.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEmail, CaseFile } from './forensics.js';
import { extract, explain, answerQuestion } from './llm.js';
import { resolveVendor, screen, plan, tools, score } from './checks.js';
import { nextSeq } from './store.js';
import { bankKey, maskAcct, money, toBank } from './text.js';
import { pdfText } from './pdf.js';
import { cfg } from './config.js';

export class Agent {
  constructor({ store, series, bank, ledger, notifier, emit = () => {}, stepDelayMs = 0 }) {
    Object.assign(this, { store, series, bank, ledger, notifier, emit, stepDelayMs });
    notifier.onReply = (text, actor) => this.handleReply(text, actor);
  }

  async #blocklist() { return (await this.store.col('meta').get('blocklist'))?.keys || []; }
  async #save(req) { await this.store.col('cases').put(req); this.emit('request', { id: req.id }); }
  async #step(req, step, detail, tool) {
    req.trace.push({ ts: new Date().toISOString(), step, tool: tool || null, detail });
    await this.#save(req);
    if (this.stepDelayMs) await sleep(this.stepDelayMs);
  }

  // input: { raw } for an email, or { pdf: Buffer, filename, sender } for an uploaded invoice.
  async process(input) {
    const pdf = input.pdf || null;
    let raw = typeof input === 'string' ? input : input.raw;
    if (pdf) raw = `From: ${input.sender ? `<${input.sender}>` : ''}\nSubject: ${input.filename || 'invoice.pdf'}\n\n${await pdfText(pdf)}`;
    const n = await nextSeq(this.store, 'requestSeq', 1040);
    const req = {
      id: `PR-${n}`, n, receivedAt: new Date().toISOString(), raw: null, status: 'analysing',
      source: pdf ? { kind: 'pdf', filename: input.filename || 'invoice.pdf' } : { kind: 'email' },
      extracted: null, vendorId: null, vendorName: null, verdict: null, caseFile: null,
      trace: [], payment: null, decision: null, billId: null,
    };
    const cf = new CaseFile();

    // 1. Read
    const email = parseEmail(raw);
    req.email = { from: email.from, subject: email.subject, replyTo: email.replyTo, auth: email.auth };
    await this.#step(req, 'intake', pdf ? `PDF "${req.source.filename}"${email.from ? ` from ${email.from}` : ''}` : `Email from ${email.from}: "${email.subject}"`);
    const { fields: read, issues } = validateExtraction(await extract(email, pdf));
    // Privacy: the raw text is only ever stored redacted. Keep a fingerprint and the last four digits.
    req.raw = redact(raw, read.bank.account);
    req.extracted = { ...read, bank: toBank(read.bank.routing, read.bank.account, read.bank.bankName) };
    const x = req.extracted;
    await this.#step(req, 'read', `${x.extractor === 'gemini' ? 'Gemini' : 'Rule-based reader'} extracted ${x.invoiceNumber || 'no invoice #'}, ${money(x.amount || 0)}, account ${maskAcct(x.bank)}`, 'extract_invoice');

    // 2. Match to the vendor master
    const vendors = await this.store.col('vendors').all();
    const hits = await this.store.searchVendors(x.vendorName || email.fromName || '');
    const resolution = resolveVendor(vendors, email, x, hits);
    const vendor = resolution.vendor;
    req.vendorId = vendor?.id || null;
    req.vendorName = vendor?.name || x.vendorName || email.fromName;
    await this.#step(req, 'match', `${vendor ? `Matched to ${vendor.name} by ${resolution.how}` : 'No approved vendor matches this sender'} (name search: ${hits.via || 'in-app'})`, 'vendor_lookup');

    // 3. Screen
    const baseline = vendor ? await this.series.baseline(vendor.id) : { n: 0, rows: [], monthly: [] };
    const paid = await this.series.paid();
    const data = { req, email, vendor, resolution, vendors, baseline, blocklist: await this.#blocklist(), paid, cf };
    const findings = screen(data);
    if (issues.length) findings.push({ code: 'INVALID_FIELDS', points: 40, critical: true, evidence: [], title: 'Invoice fields failed validation', detail: issues.join('; ') });
    cf.event(req.receivedAt, pdf ? 'upload' : 'email-header', `Invoice ${x.invoiceNumber || ''} received${email.from ? ` from ${email.from}` : ' by upload'}`, { suspicious: findings.length > 0 });
    await this.#step(req, 'screen', findings.length ? `${findings.length} check(s) raised: ${findings.map((f) => f.code).join(', ')}` : 'All screening checks passed', 'screen');

    // 4. Investigate only what screening raised
    const todo = plan(findings);
    if (todo.length) {
      await this.#step(req, 'plan', `Investigating with: ${todo.join(' → ')}`);
      data.signins = vendor ? (await this.store.col('signins').all()).filter((s) => s.vendorId === vendor.id) : [];
      data.bankChanges = vendor ? (await this.store.col('bankChanges').all()).filter((c) => c.vendorId === vendor.id) : [];
      data.allSignins = (await this.store.col('signins').all()).sort((a, b) => a.ts.localeCompare(b.ts));
      data.otherCases = (await this.store.col('cases').all()).filter((c) => c.id !== req.id && c.indicators);
      data.findings = findings;
      for (const name of todo) {
        const r = tools[name](data);
        findings.push(...r.findings);
        await this.#step(req, 'investigate', r.note + (r.findings.length ? ` — ${r.findings.map((f) => f.code).join(', ')}` : ''), name);
      }
      req.caseFile = cf.toJSON();
    }

    // 5. Verdict
    findings.sort((a, b) => b.points - a.points);
    req.verdict = { ...score(findings), findings };
    const said = await explain(req);
    req.verdict.summary = said.text;
    req.verdict.explainedBy = said.by;
    await this.#step(req, 'verdict', `${req.verdict.decision.toUpperCase()} · risk ${req.verdict.risk}/100`);

    // 6. Act
    try { req.billId = (await this.bank.createBill(req)).billId; } catch (err) { console.warn('[bank] bill:', err.message); }
    await this.ledger.append({ requestId: req.id, action: req.verdict.decision, actor: 'countersign-agent', risk: req.verdict.risk, summary: `${req.vendorName} ${money(x.amount || 0)} -> ${maskAcct(x.bank)}` });
    if (req.verdict.decision === 'clear') {
      req.status = 'cleared';
      await this.#save(req);
      await this.#pay(req, vendor, 'cleared');
      await this.#step(req, 'act', payNote(req), 'bank_pay');
    } else {
      req.status = 'held';
      await this.#event(req, vendor, 'held');
      const msg = await this.notifier.send(this.#holdText(req, vendor), { requestId: req.id });
      await this.#step(req, 'act', `Payment held. ${deliveryNote(msg, cfg.approverName)}`, 'text_approver');
    }
    return req;
  }

  #holdText(req, vendor) {
    const top = req.verdict.findings.slice(0, 3).map((f) => `• ${f.title}`).join('\n');
    const call = vendor?.phone ? `\nVerify by calling ${vendor.name} on the number on file, ${vendor.phone}. Do not use a number from the invoice.` : '';
    return `Countersign HOLD · ${req.id}\n${req.vendorName} · ${money(req.extracted.amount || 0)}\nRisk ${req.verdict.risk}/100\n${top}${call}\nReply APPROVE ${req.n}, HOLD ${req.n} or WHY ${req.n}.`;
  }

  // One row per payment event in the time series: paid | held | declined.
  async #event(req, vendor, status, txnId = null) {
    if (!vendor || !req.extracted.amount) return;
    await this.series.record({
      ts: new Date().toISOString(), vendorId: vendor.id, amount: req.extracted.amount, status, txnId,
      invoiceNumber: req.extracted.invoiceNumber, requestId: req.id, bankKey: bankKey(req.extracted.bank), bankLast4: req.extracted.bank.last4,
    }).catch((err) => console.warn('[series]', err.message));
  }

  // Pays at most once: the case is atomically claimed out of `from` before the bank is called,
  // and it only becomes 'paid' when the bank reports the transfer completed.
  async #pay(req, vendor, from) {
    const ts = new Date().toISOString();
    const payment = { state: 'initiated', ts, amount: req.extracted.amount, toAccount: maskAcct(req.extracted.bank),
      expected: { payeeAccountId: vendor.payeeAccountId, amountCents: Math.round(req.extracted.amount * 100) } };
    const claimed = await this.store.col('cases').claim(req.id, from, { status: 'paying', payment });
    if (!claimed) throw new Error(`${req.id} is no longer ${from}; refusing to pay twice`);
    Object.assign(req, { status: 'paying', payment });
    try {
      const r = await this.bank.pay(req, vendor);
      req.payment = { ...payment, ...r };
      if (r.bankStatus === 'completed') await this.#settled(req, vendor);
      else { req.status = 'pay_pending'; req.payment.state = 'pending'; }
    } catch (err) {
      req.payment = { ...payment, state: 'failed', error: err.message };
      req.status = 'pay_failed';
    }
    await this.#save(req);
  }
  async #settled(req, vendor) {
    req.status = 'paid';
    req.payment.state = 'completed';
    req.payment.settledAt = new Date().toISOString();
    await this.bank.closeBill(req.billId, 'completed').catch((err) => console.warn('[bank] close bill:', err.message));
    await this.#event(req, vendor, 'paid', req.payment.ref);
  }

  // Pending transfers are checked against the bank until they complete, decline or cancel.
  async reconcile() {
    let changed = 0;
    for (const r of (await this.store.col('cases').all()).filter((c) => c.status === 'pay_pending' && c.payment?.ref)) {
      let st;
      try { st = await this.bank.status(r.payment.ref); } catch (err) { console.warn('[reconcile]', r.id, err.message); continue; }
      if (st === 'pending') continue;
      const ts = new Date().toISOString();
      const trace = [...r.trace, { ts, step: 'reconcile', tool: 'bank_status', detail: `Bank reports transfer ${r.payment.ref} ${st}` }];
      const patch = st === 'completed'
        ? { status: 'paid', payment: { ...r.payment, state: 'completed', settledAt: ts }, trace }
        : { status: 'pay_failed', payment: { ...r.payment, state: 'failed', error: `transfer ${st}` }, trace };
      const done = await this.store.col('cases').claim(r.id, 'pay_pending', patch);
      if (!done) continue; // another worker got there first
      if (st === 'completed') {
        const vendor = done.vendorId ? await this.store.col('vendors').get(done.vendorId) : null;
        await this.bank.closeBill(done.billId, 'completed').catch((err) => console.warn('[bank] close bill:', err.message));
        await this.#event(done, vendor, 'paid', done.payment.ref);
      }
      this.emit('request', { id: done.id });
      changed++;
    }
    return changed;
  }

  // Background worker: a hold nobody has answered gets one reminder, so it cannot sit unseen.
  async remindStale(afterMs) {
    const stale = (await this.store.col('cases').all())
      .filter((r) => r.status === 'held' && !r.remindedAt && Date.now() - Date.parse(r.receivedAt) >= afterMs)
      .sort((a, b) => a.n - b.n);
    let sent = 0;
    for (const r of stale) {
      const mins = Math.round((Date.now() - Date.parse(r.receivedAt)) / 60000);
      const at = new Date().toISOString();
      // Claim the reminder first: never overwrite a case that was decided in the meantime.
      const trace = [...r.trace, { ts: at, step: 'worker', tool: 'text_approver', detail: `No reply after ${mins} min. Reminder sent` }];
      const claimed = await this.store.col('cases').claim(r.id, 'held', { remindedAt: at, trace });
      if (!claimed || r.remindedAt) continue;
      this.emit('request', { id: r.id });
      sent++;
      await this.notifier.send(`Reminder · ${r.id} is still on hold after ${mins} min\n${r.vendorName} · ${money(r.extracted.amount || 0)} · risk ${r.verdict.risk}/100\nReply APPROVE ${r.n}, HOLD ${r.n} or WHY ${r.n}.`, { requestId: r.id });
    }
    return sent;
  }
  // Nessie's hosted sweep completes transfers about once a minute, so pending ones are checked often.
  startWorker(afterMs, everyMs = 60000, reconcileMs = 15000) {
    setInterval(() => this.remindStale(afterMs).catch((err) => console.warn('[worker]', err.message)), everyMs).unref();
    setInterval(() => this.reconcile().catch((err) => console.warn('[reconcile]', err.message)), reconcileMs).unref();
  }

  // The approver's decision on a held request: 'approve' releases it, 'hold' blocks it for good.
  async decide(id, action, actor = cfg.approverName) {
    if (!['approve', 'hold'].includes(action)) throw new Error('action must be approve or hold');
    const current = await this.store.col('cases').get(id);
    if (!current) throw new Error(`No request ${id}`);
    if (current.status !== 'held') throw new Error(`${id} is ${current.status}, not awaiting a decision`);
    const vendor = current.vendorId ? await this.store.col('vendors').get(current.vendorId) : null;
    if (action === 'approve' && !vendor) throw new Error(`${id}: sender is not an approved vendor. Onboard the vendor first; it cannot be approved by text.`);
    // One decision wins, even if the dashboard and a text arrive at the same moment.
    const decision = { action, actor, ts: new Date().toISOString() };
    const req = await this.store.col('cases').claim(id, 'held', { status: action === 'approve' ? 'approved' : 'blocked', decision });
    if (!req) throw new Error(`${id} was decided by someone else just now`);
    const key = bankKey(req.extracted.bank);

    if (action === 'approve') {
      // The approver vouches for the new details (after the phone call), so they become the vendor master.
      if (key && key !== bankKey(vendor.bank)) {
        let payee;
        try { payee = await this.bank.newPayee(vendor); } catch (err) {
          req.status = 'pay_failed';
          req.payment = { state: 'failed', error: `could not create the new payee account: ${err.message}` };
          await this.#step(req, 'decision', `${actor} approved, but the new payee could not be created. Nothing was paid`, 'bank_pay');
          return req;
        }
        vendor.bankHistory = [...(vendor.bankHistory || []), { ...vendor.bank, retiredAt: req.decision.ts }];
        vendor.bank = { ...req.extracted.bank, verifiedAt: req.decision.ts, verifiedBy: actor };
        vendor.payeeAccountId = payee;
        await this.store.col('vendors').put(vendor);
        await this.ledger.append({ requestId: req.id, action: 'bank-master-updated', actor, risk: req.verdict.risk, summary: `${vendor.name} -> ${maskAcct(vendor.bank)}` });
      }
      await this.ledger.append({ requestId: req.id, action: 'approve', actor, risk: req.verdict.risk, summary: `${req.vendorName} ${money(req.extracted.amount || 0)}` });
      await this.#pay(req, vendor, 'approved');
      await this.#step(req, 'decision', `${actor} approved. ${payNote(req)}`, 'bank_pay');
    } else {
      if (key) {
        const keys = await this.#blocklist();
        if (!keys.includes(key)) await this.store.col('meta').put({ id: 'blocklist', keys: [...keys, key] });
      }
      await this.bank.closeBill(req.billId, 'cancelled').catch(() => {});
      await this.#event(req, vendor, 'declined');
      await this.ledger.append({ requestId: req.id, action: 'block', actor, risk: req.verdict.risk, summary: `${req.vendorName} ${money(req.extracted.amount || 0)} · account ${maskAcct(req.extracted.bank)} blocklisted` });
      await this.#step(req, 'decision', `${actor} kept the hold. Payment blocked; account ${maskAcct(req.extracted.bank)} added to the blocklist`);
    }
    return req;
  }

  // Text replies: APPROVE 1042 · HOLD 1042 · WHY 1042 · STATUS (number optional when one item is waiting).
  // A question about one case, answered only from its own evidence, with checked citations.
  async ask(id, question) {
    const r = await this.store.col('cases').get(id);
    if (!r) throw new Error(`No request ${id}`);
    const q = String(question || '').trim().slice(0, 300);
    if (!q) throw new Error('Ask a question');
    if (!r.verdict) return { answer: 'This request is still being checked. Ask again in a moment.', cites: [], by: 'none' };
    return answerQuestion(r, q);
  }

  async handleReply(text, actor) {
    const all = (await this.store.col('cases').all()).sort((a, b) => a.n - b.n);
    const held = all.filter((r) => r.status === 'held');
    const t = text.trim().toLowerCase();
    const n = Number(t.match(/(\d{3,})/)?.[1]) || null;
    // ASK 1042 <question>: a grounded answer from that case file only. Never decides anything.
    const askm = text.trim().match(/^(?:ask|q)\s+(\d{3,})\s+(.+)$/is);
    if (askm) {
      const target = all.find((r) => r.n === Number(askm[1]));
      if (!target) return `I have no request ${askm[1]}.`;
      const a = await this.ask(target.id, askm[2]);
      return `${target.id}: ${a.answer}`.slice(0, 700);
    }
    if (/^(ask|q)\b/.test(t)) return 'Ask like this: ASK 1042 who changed the bank details?';
    const verb = /^(approve|yes|pay|release|ok)\b/.test(t) ? 'approve'
      : /^(hold|no|block|reject|stop|deny)\b/.test(t) ? 'hold'
      : /^(why|explain|details?)\b/.test(t) ? 'why'
      : /^(status|list|queue|hi|hello|start)\b/.test(t) ? 'status' : null;

    if (!verb) return 'I can take: APPROVE <number>, HOLD <number>, WHY <number>, ASK <number> <question>, or STATUS.';
    if (verb === 'status') {
      if (!held.length) return `Nothing is waiting on you. ${all.filter((r) => r.status === 'paid').length} payment(s) cleared.`;
      return `${held.length} payment(s) on hold:\n${held.map((r) => `${r.n} · ${r.vendorName} · ${money(r.extracted.amount || 0)} · risk ${r.verdict.risk}`).join('\n')}\nReply APPROVE, HOLD or WHY with the number.`;
    }
    const target = n ? all.find((r) => r.n === n) : held.length === 1 ? held[0] : null;
    if (!target) return n ? `I have no request ${n}.` : held.length ? `${held.length} are waiting. Which one? ${held.map((r) => r.n).join(', ')}` : 'Nothing is on hold right now.';
    if (verb === 'why') {
      return `${target.id} · ${target.vendorName}\n${target.verdict.findings.slice(0, 4).map((f) => `• ${f.title}: ${f.detail}`).join('\n') || 'No checks were raised.'}`;
    }
    if (target.status !== 'held') return `${target.id} is already ${target.status}.`;
    try {
      const r = await this.decide(target.id, verb, actor);
      if (verb === 'hold') return `${r.id} blocked. Nothing was paid, and account ${maskAcct(r.extracted.bank)} is now blocklisted for every vendor.`;
      if (r.status === 'paid') return `${r.id} released: ${money(r.extracted.amount)} paid to ${r.vendorName}, account ${maskAcct(r.extracted.bank)}. Logged as approved by you.`;
      if (r.status === 'pay_pending') return `${r.id} approved. The transfer of ${money(r.extracted.amount)} is submitted and waiting for the bank to settle it.`;
      return `${r.id} approved, but the bank rejected the payment: ${r.payment?.error}`;
    } catch (err) {
      return err.message;
    }
  }
}

// ---- helpers ----------------------------------------------------------------

function payNote(req) {
  if (req.status === 'paid') return `Paid ${money(req.extracted.amount)} (${req.payment.rail}, bank status completed)`;
  if (req.status === 'pay_pending') return `Transfer ${req.payment.ref} submitted; bank status ${req.payment.bankStatus}. Not yet paid`;
  return `Payment failed: ${req.payment?.error}`;
}

export function deliveryNote(msg, who) {
  const d = msg?.delivery || '';
  if (!d || d === 'simulator') return `Shown to ${who} on the on-screen phone`;
  if (d === 'delivered') return `Text delivered to ${who}`;
  if (d.startsWith('accepted')) return `Text to ${who} accepted by Photon (delivery not confirmed)`;
  if (d.startsWith('queued')) return `Text to ${who} QUEUED, not sent: ${d.replace(/^queued:?\s*/, '')}`;
  return `Text to ${who} FAILED: ${d.replace(/^failed:?\s*/, '')}`;
}

// Replaces the extracted account number, and any number labelled as an account, before storage.
export function redact(raw, account) {
  let out = String(raw || '');
  if (account) out = out.split(String(account)).join(`[account ending ${String(account).slice(-4)}]`);
  return out.replace(/(\b(?:account|acct)\b[^\d\n]{0,20})(\d{4,17})\b/gi, (_, label, digits) => `${label}[account ending ${digits.slice(-4)}]`);
}

// Boundary schema for extracted fields, whether from Gemini or the rule-based reader.
// Unknown keys are dropped; malformed values are nulled and reported so the case is held.
export function validateExtraction(x = {}) {
  const issues = [];
  const str = (v, max, name) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' && typeof v !== 'number') { issues.push(`${name} is not text`); return null; }
    const s = String(v).trim();
    if (s.length > max) { issues.push(`${name} is longer than ${max} characters`); return null; }
    return s;
  };
  let amount = x.amount;
  if (typeof amount === 'string') amount = Number(amount.replace(/[$,\s]/g, ''));
  if (amount == null || amount === '') { issues.push('amount is missing'); amount = null; }
  else if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) { issues.push(`amount ${JSON.stringify(x.amount)} is not a payable value`); amount = null; }
  else amount = Math.round(amount * 100) / 100;
  const b = x.bank && typeof x.bank === 'object' ? x.bank : {};
  const digits = (v, re, name) => {
    if (v == null || v === '') return null;
    const s = String(v).replace(/[\s-]/g, '');
    if (!re.test(s)) { issues.push(`${name} is malformed`); return null; }
    return s;
  };
  const fields = {
    vendorName: str(x.vendorName, 120, 'vendor name'),
    invoiceNumber: str(x.invoiceNumber, 64, 'invoice number'),
    amount,
    dueDate: str(x.dueDate, 40, 'due date'),
    bank: { routing: digits(b.routing, /^\d{9}$/, 'routing number'), account: digits(b.account, /^\d{4,17}$/, 'account number'), bankName: str(b.bankName, 80, 'bank name') },
    bankChangeClaimed: x.bankChangeClaimed === true,
    urgency: x.urgency === true,
    extractor: x.extractor === 'gemini' ? 'gemini' : 'rules',
  };
  return { fields, issues };
}
