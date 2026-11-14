// The bank Countersign guards. Capital One Nessie v2 when NESSIE_API_KEY is set,
// otherwise a mock with the same shape. The company has one operating account;
// each vendor has a payee account that payments are transferred to.
//
// Contract (Nessie v2 OpenAPI, checked 2026-11-14): transaction status is one of
// pending | completed | declined | cancelled, and only `completed` means money moved.
// Account nicknames are at most 40 characters; bill payee/nickname at most 80.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cfg, noteHealth } from './config.js';

const cents = (dollars) => Math.round(dollars * 100);
const NICK = 40;
const TERMINAL = new Set(['completed', 'declined', 'cancelled']);
export const SIGNATURE_TOLERANCE_S = 300;

class MockBank {
  kind = 'mock';
  // nextStatus lets tests stand in for a bank that leaves transfers pending or declines them.
  constructor(store, { nextStatus = 'completed' } = {}) { this.store = store; this.nextStatus = nextStatus; this.txns = new Map(); }
  async #acct() { return (await this.store.col('meta').get('bank')) || { id: 'bank', balance: 0, accountId: 'mock-operating' }; }
  // Returns what to store; seed() writes it only after every remote step has succeeded.
  async setup(company, vendors, balance) {
    return { meta: { id: 'bank', balance, accountId: 'mock-operating', company }, vendors: vendors.map((v) => ({ ...v, payeeAccountId: `mock-payee-${v.id}` })) };
  }
  async balance() { return (await this.#acct()).balance; }
  async createBill(req) { return { billId: `mock-bill-${req.id}` }; }
  async closeBill() {}
  async newPayee(vendor) { return `mock-payee-${vendor.id}-${Date.now().toString(36)}`; }
  async #move(amount) {
    const a = await this.#acct();
    a.balance = Math.round((a.balance - amount) * 100) / 100;
    await this.store.col('meta').put(a);
  }
  async pay(req) {
    const ref = `mock-txn-${req.id}-${this.txns.size + 1}`;
    const status = this.nextStatus;
    if (status === 'declined' || status === 'cancelled') throw new Error(`transfer ${status}: mock bank`);
    this.txns.set(ref, { status, amount: req.extracted.amount });
    if (status === 'completed') await this.#move(req.extracted.amount);
    return { ref, rail: 'mock bank transfer', bankStatus: status };
  }
  async status(ref) { return this.txns.get(ref)?.status || 'unknown'; }
  // Test helper: the pending window closes.
  async settle(ref, status = 'completed') {
    const t = this.txns.get(ref);
    if (!t || t.status !== 'pending') return;
    t.status = status;
    if (status === 'completed') await this.#move(t.amount);
  }
}

class NessieBank {
  kind = 'nessie';
  constructor(store) { this.store = store; }
  async #call(method, path, body) {
    let res;
    try {
      res = await fetch(`${cfg.nessieBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.nessieKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
      });
    } catch (err) { noteHealth('nessie', false, err.message); throw err; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Nessie ${method} ${path} -> ${res.status} ${json.type || ''} ${json.detail || json.title || ''}`.trim());
      if (res.status >= 500 || res.status === 401 || res.status === 403) noteHealth('nessie', false, err.message);
      throw err;
    }
    noteHealth('nessie', true);
    return json;
  }
  async #acct() { return this.store.col('meta').get('bank'); }
  #address = { street_number: '20', street_name: 'Washington Rd', city: 'Princeton', state: 'NJ', zip: '08544' };

  // Creates the company (customer + operating account) and one payee account per vendor.
  // Nothing is written locally here: seed() stores the result only after every call succeeded.
  async setup(company, vendors, balance) {
    const prior = await this.#acct();
    const co = await this.#call('POST', '/customers', { first_name: company.slice(0, 80), last_name: 'Accounts Payable', address: this.#address });
    const op = await this.#call('POST', `/customers/${co.id}/accounts`, { type: 'Checking', nickname: `${company} Operating`.slice(0, NICK), balance_cents: cents(balance) });
    const vc = await this.#call('POST', '/customers', { first_name: 'Approved', last_name: 'Vendors', address: this.#address });
    const meta = { id: 'bank', customerId: co.id, accountId: op.id, vendorCustomerId: vc.id, company };
    const out = [];
    for (const v of vendors) {
      const a = await this.#call('POST', `/customers/${vc.id}/accounts`, { type: 'Checking', nickname: v.name.slice(0, NICK), balance_cents: 0 });
      out.push({ ...v, payeeAccountId: a.id });
    }
    // Bank-side gate: with a public URL, Nessie asks Countersign before any transfer settles.
    // Nessie allows one decision hook per kind per key, so an existing hook is kept, not re-created.
    if (prior?.hookId && prior?.hookSecret) {
      Object.assign(meta, { hookId: prior.hookId, hookSecret: prior.hookSecret, hookUrl: prior.hookUrl });
    } else if (cfg.publicUrl) {
      try {
        const url = `${cfg.publicUrl}/api/webhooks/nessie`;
        const hook = await this.#call('POST', '/webhooks', { mode: 'decision', url, kinds: ['transfer'], on_error: 'decline' });
        Object.assign(meta, { hookId: hook.id, hookSecret: hook.secret, hookUrl: url });
      } catch (err) {
        meta.hookError = err.message;
        console.warn('[nessie] decision hook NOT registered:', err.message);
      }
    }
    return { meta, vendors: out };
  }
  async balance() {
    const a = await this.#acct();
    return a ? (await this.#call('GET', `/accounts/${a.accountId}`)).available_cents / 100 : 0;
  }
  async createBill(req) {
    const a = await this.#acct();
    const b = await this.#call('POST', `/accounts/${a.accountId}/bills`, {
      status: 'pending', payee: String(req.vendorName).slice(0, 80), nickname: String(req.extracted.invoiceNumber || req.id).slice(0, 80), payment_amount: req.extracted.amount,
    });
    return { billId: b.id };
  }
  async closeBill(billId, status) { // 'completed' | 'cancelled'
    if (billId) await this.#call('PATCH', `/bills/${billId}`, { status });
  }
  // A verified change of bank details means a new account to pay.
  async newPayee(vendor) {
    const a = await this.#acct();
    return (await this.#call('POST', `/customers/${a.vendorCustomerId}/accounts`, { type: 'Checking', nickname: `${vendor.name} (updated)`.slice(0, NICK), balance_cents: 0 })).id;
  }
  // Returns the bank's own status. Only 'completed' counts as paid; 'pending' must be reconciled.
  async pay(req, vendor) {
    const a = await this.#acct();
    const txn = await this.#call('POST', `/accounts/${a.accountId}/transfers`, {
      amount_cents: cents(req.extracted.amount), payee_id: vendor.payeeAccountId, description: `${req.id} ${req.extracted.invoiceNumber || ''}`.trim().slice(0, 200),
    });
    let done = txn;
    if (txn.status === 'pending') {
      // Ends the pending window early in the sandbox; a decision hook still gets its full time.
      done = await this.#call('POST', `/transactions/${txn.id}/settle`).catch(async (err) => {
        console.warn('[nessie] settle:', err.message);
        return this.#call('GET', `/transactions/${txn.id}`).catch(() => txn);
      });
    }
    if (done.status === 'declined' || done.status === 'cancelled') throw new Error(`transfer ${done.status}: ${done.decision_reason || 'no reason given'}`);
    return { ref: txn.id, rail: 'Nessie transfer', bankStatus: TERMINAL.has(done.status) || done.status === 'pending' ? done.status : `unknown:${done.status}` };
  }
  async status(ref) { return (await this.#call('GET', `/transactions/${ref}`)).status; }

  // Decision hook. Fails closed: no stored secret, a bad or stale signature, or a transfer
  // that does not match a payment Countersign itself started is declined or rejected.
  async decideHook(rawBody, signature, cases, now = Date.now()) {
    const meta = await this.#acct();
    const sig = verifySignature(meta?.hookSecret, signature, rawBody, now);
    if (!sig.ok) return { status: 401, body: { error: sig.error } };
    let txn;
    try { txn = JSON.parse(rawBody).transaction || {}; } catch { return { status: 400, body: { error: 'bad json' } }; }
    return { status: 200, body: decideTransfer(txn, cases, meta) };
  }
}

// Nessie-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "t." + body>
export function verifySignature(secret, header, rawBody, now = Date.now()) {
  if (!secret) return { ok: false, error: 'decision hook has no signing secret; refusing' };
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t)) return { ok: false, error: 'missing signature' };
  if (Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_S) return { ok: false, error: 'stale signature' };
  const want = createHmac('sha256', secret).update(`${parts.t}.`).update(rawBody).digest('hex');
  const ok = parts.v1.length === want.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(want));
  return ok ? { ok: true } : { ok: false, error: 'bad signature' };
}

// Approve only a transfer Countersign is paying right now: same source account, payee and amount.
export function decideTransfer(txn, cases, meta) {
  const decline = (reason) => ({ decision: 'decline', reason });
  if (txn.kind && txn.kind !== 'transfer') return decline('Not a transfer');
  if (txn.payer_id && meta?.accountId && txn.payer_id !== meta.accountId) return decline('Transfer is not from the Countersign operating account');
  const match = cases.find((c) => ['paying', 'pay_pending'].includes(c.status)
    && c.payment?.expected?.payeeAccountId === txn.payee_id
    && c.payment?.expected?.amountCents === txn.amount_cents
    && (!c.payment.ref || c.payment.ref === txn.id));
  return match ? { decision: 'approve' } : decline('No Countersign case is paying this payee this amount');
}

export function initBank(store) {
  return cfg.nessieKey ? new NessieBank(store) : new MockBank(store);
}
export { MockBank, NessieBank };
