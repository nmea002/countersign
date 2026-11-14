// Tamper-evident decision log. Every verdict and approver decision is a link in a
// SHA-256 hash chain; when a Solana key is configured each link's hash is also
// written to devnet in a memo transaction, so the log can be checked against a
// record Countersign cannot rewrite.
import { createHash } from 'node:crypto';
import { cfg, noteHealth } from './config.js';

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const GENESIS = '0'.repeat(64);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const memoFor = (e) => `countersign:v1:${e.seq}:${e.requestId}:${e.action}:${e.hash}`;
const digest = (e) => sha(JSON.stringify([e.seq, e.ts, e.requestId, e.action, e.actor, e.risk, e.summary, e.prevHash]));

export class Ledger {
  #queue = Promise.resolve();
  #web3 = null;
  constructor(store, emit = () => {}) { this.store = store; this.emit = emit; }

  async entries() { return (await this.store.col('ledger').all()).sort((a, b) => a.seq - b.seq); }

  append(fields) {
    const run = this.#queue.then(async () => {
      const all = await this.entries();
      const prev = all.at(-1);
      const e = { seq: (prev?.seq || 0) + 1, ts: new Date().toISOString(), ...fields, prevHash: prev?.hash || GENESIS };
      e.hash = digest(e);
      e.id = `L${e.seq}`;
      e.solana = null;
      await this.store.col('ledger').put(e);
      if (cfg.solanaSecret) this.#anchor(e).then(() => noteHealth('solana', true), (err) => { noteHealth('solana', false, err.message); console.warn('[solana] anchor failed:', err.message); });
      return e;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async verify() {
    let prevHash = GENESIS;
    for (const e of await this.entries()) {
      if (e.prevHash !== prevHash || digest(e) !== e.hash) return { ok: false, brokenAt: e.seq, count: e.seq };
      prevHash = e.hash;
    }
    return { ok: true, count: (await this.entries()).length, head: prevHash };
  }

  // Independent check of one entry against devnet: recompute its hash from the stored fields,
  // fetch the anchoring transaction, and compare the on-chain memo and signer.
  async verifyOnChain(id, conn = null) {
    const e = await this.store.col('ledger').get(id);
    if (!e) return { ok: false, reason: 'no such ledger entry' };
    const recomputed = digest(e);
    const expectedMemo = memoFor({ ...e, hash: recomputed });
    if (!e.solana?.signature) return { ok: false, reason: 'entry is not anchored on Solana', localHashOk: recomputed === e.hash };
    const web3 = (this.#web3 ??= await import('@solana/web3.js'));
    conn ??= new web3.Connection(cfg.solanaRpc, 'confirmed');
    const tx = await conn.getParsedTransaction(e.solana.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx) return { ok: false, reason: 'transaction not found on devnet', signature: e.solana.signature };
    const memoIx = tx.transaction.message.instructions.find((ix) => ix.programId?.toBase58?.() === MEMO_PROGRAM || ix.program === 'spl-memo');
    const onChainMemo = typeof memoIx?.parsed === 'string' ? memoIx.parsed : null;
    const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey?.toBase58();
    const expectedSigner = cfg.solanaSecret ? web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cfg.solanaSecret))).publicKey.toBase58() : null;
    const checks = {
      localHash: recomputed === e.hash,
      memo: onChainMemo === expectedMemo,
      signer: !expectedSigner || signer === expectedSigner,
      succeeded: tx.meta?.err == null,
    };
    return {
      ok: Object.values(checks).every(Boolean), checks, signature: e.solana.signature, url: e.solana.url,
      onChainMemo, expectedMemo, signer, slot: tx.slot, blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    };
  }

  async #anchor(entry) {
    const web3 = (this.#web3 ??= await import('@solana/web3.js'));
    const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cfg.solanaSecret)));
    const conn = new web3.Connection(cfg.solanaRpc, 'confirmed');
    const memo = memoFor(entry);
    const ix = new web3.TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      programId: new web3.PublicKey(MEMO_PROGRAM),
      data: Buffer.from(memo, 'utf8'),
    });
    const signature = await web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(ix), [payer]);
    const fresh = await this.store.col('ledger').get(entry.id);
    fresh.solana = { signature, url: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
    await this.store.col('ledger').put(fresh);
    this.emit('ledger', { id: entry.id });
  }
}
