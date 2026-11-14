// Payment events as a time series. Tiger Data (TimescaleDB) when TIGER_DATABASE_URL
// is set: a `payments` hypertable plus a `vendor_daily` continuous aggregate that
// serves the per-vendor charts. Otherwise the document store's `payments` collection.
// Every event has a status: paid | held | declined. Baselines use paid events only.
import { cfg } from './config.js';

const DAY = 86400000;

export function stats(rows) {
  const amounts = rows.map((r) => r.amount);
  const n = amounts.length;
  const mean = n ? amounts.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const gaps = rows.slice(1).map((r, i) => (Date.parse(r.ts) - Date.parse(rows[i].ts)) / DAY).sort((a, b) => a - b);
  return {
    n, mean, sd,
    medianGapDays: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    lastTs: n ? rows[n - 1].ts : null,
    // floor the spread so a vendor billing an identical amount every month doesn't make z explode
    spread: Math.max(sd, mean * 0.05),
    rows,
  };
}

// [{bucket,status,n,total}] -> [{bucket, paid:{n,total}, held:{...}, declined:{...}}], oldest first.
function toBuckets(rows) {
  const m = new Map();
  for (const r of rows) {
    const b = m.get(r.bucket) || { bucket: r.bucket, paid: { n: 0, total: 0 }, held: { n: 0, total: 0 }, declined: { n: 0, total: 0 } };
    if (b[r.status]) { b[r.status].n += r.n; b[r.status].total = Math.round((b[r.status].total + r.total) * 100) / 100; }
    m.set(r.bucket, b);
  }
  return [...m.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

class LocalSeries {
  kind = 'local';
  constructor(store) { this.store = store; }
  async record(p) { await this.store.col('payments').put({ id: `${p.vendorId}:${p.ts}:${p.invoiceNumber}:${p.status}`, ...p }); }
  async paid() { return (await this.store.col('payments').all()).filter((p) => p.status === 'paid').sort((a, b) => a.ts.localeCompare(b.ts)); }
  async baseline(vendorId) { return stats((await this.paid()).filter((p) => p.vendorId === vendorId)); }
  async daily(vendorId) {
    const m = new Map();
    for (const p of (await this.paid()).filter((x) => x.vendorId === vendorId)) {
      const d = m.get(p.ts.slice(0, 10)) || { day: p.ts.slice(0, 10), n: 0, total: 0, max: 0 };
      d.n += 1; d.total += p.amount; d.max = Math.max(d.max, p.amount);
      m.set(d.day, d);
    }
    return [...m.values()].map((d) => ({ ...d, avg: d.total / d.n }));
  }
  async buckets(months = 13) {
    const since = new Date(Date.now() - months * 31 * DAY).toISOString();
    return toBuckets((await this.store.col('payments').all()).filter((p) => p.ts >= since).map((p) => ({ bucket: `${p.ts.slice(0, 7)}-01`, status: p.status, n: 1, total: p.amount })));
  }
  async refresh() {}
  async reset() {}
}

class TigerSeries {
  kind = 'tiger';
  constructor(pool) { this.pool = pool; }
  async init() {
    const q = (sql) => this.pool.query(sql);
    await q(`CREATE TABLE IF NOT EXISTS payments (
      ts timestamptz NOT NULL, vendor_id text NOT NULL, account_id text NOT NULL, amount_cents bigint NOT NULL,
      status text NOT NULL, invoice_id text, nessie_txn_id text, invoice_number text, bank_fp text, bank_last4 text)`);
    await q(`SELECT create_hypertable('payments', by_range('ts'), if_not_exists => TRUE)`);
    await q(`CREATE INDEX IF NOT EXISTS payments_vendor_ts ON payments (vendor_id, ts DESC)`);
    await q(`CREATE MATERIALIZED VIEW IF NOT EXISTS vendor_daily
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT time_bucket('1 day', ts) AS day, vendor_id, count(*) AS n, sum(amount_cents) AS total_cents,
             avg(amount_cents) AS avg_cents, max(amount_cents) AS max_cents
      FROM payments WHERE status = 'paid' GROUP BY day, vendor_id WITH NO DATA`);
    // Optional extras: a failure here must not stop the app.
    for (const sql of [
      `SELECT add_continuous_aggregate_policy('vendor_daily', start_offset => INTERVAL '90 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE)`,
      `ALTER TABLE payments SET (timescaledb.compress, timescaledb.compress_segmentby = 'vendor_id')`,
      `SELECT add_compression_policy('payments', INTERVAL '180 days', if_not_exists => TRUE)`,
    ]) await q(sql).catch((err) => console.warn('[tiger] optional step skipped:', err.message));
  }
  async record(p) {
    await this.pool.query(
      `INSERT INTO payments (ts, vendor_id, account_id, amount_cents, status, invoice_id, nessie_txn_id, invoice_number, bank_fp, bank_last4)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.ts, p.vendorId, p.accountId || 'operating', Math.round(p.amount * 100), p.status, p.requestId || null, p.txnId || null, p.invoiceNumber || null, p.bankKey || null, p.bankLast4 || null]);
  }
  #row = (r) => ({ ts: new Date(r.ts).toISOString(), vendorId: r.vendor_id, amount: Number(r.amount_cents) / 100, status: r.status, invoiceNumber: r.invoice_number, requestId: r.invoice_id, bankKey: r.bank_fp, bankLast4: r.bank_last4 });
  async paid() { return (await this.pool.query(`SELECT * FROM payments WHERE status = 'paid' ORDER BY ts`)).rows.map(this.#row); }
  async baseline(vendorId) {
    const { rows } = await this.pool.query(`SELECT * FROM payments WHERE status = 'paid' AND vendor_id = $1 ORDER BY ts`, [vendorId]);
    return stats(rows.map(this.#row));
  }
  async daily(vendorId) {
    const { rows } = await this.pool.query(`SELECT day, n, total_cents, avg_cents, max_cents FROM vendor_daily WHERE vendor_id = $1 ORDER BY day`, [vendorId]);
    return rows.map((r) => ({ day: new Date(r.day).toISOString().slice(0, 10), n: Number(r.n), total: Number(r.total_cents) / 100, avg: Number(r.avg_cents) / 100, max: Number(r.max_cents) / 100 }));
  }
  // Paid / held / declined per month, bucketed by TimescaleDB.
  async buckets(months = 13) {
    const { rows } = await this.pool.query(
      `SELECT time_bucket('1 month', ts) AS bucket, status, count(*)::int AS n, sum(amount_cents)::bigint AS total_cents
       FROM payments WHERE ts > now() - make_interval(months => $1) GROUP BY 1, 2 ORDER BY 1`, [months]);
    return toBuckets(rows.map((r) => ({ bucket: new Date(r.bucket).toISOString().slice(0, 10), status: r.status, n: r.n, total: Number(r.total_cents) / 100 })));
  }
  // The policy only covers the last 90 days; after seeding a year of history, materialise all of it.
  async refresh() { await this.pool.query(`CALL refresh_continuous_aggregate('vendor_daily', NULL, NULL)`).catch((err) => console.warn('[tiger] refresh:', err.message)); }
  async reset() { await this.pool.query('TRUNCATE payments'); }
}

export async function initSeries(store) {
  if (cfg.tigerUrl) {
    try {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: cfg.tigerUrl, max: 4, connectionTimeoutMillis: 8000 });
      const series = new TigerSeries(pool);
      await series.init();
      console.log('[tiger] hypertable and vendor_daily continuous aggregate ready');
      return series;
    } catch (err) {
      console.warn('[tiger] unavailable, using in-process series:', err.message);
    }
  }
  return new LocalSeries(store);
}
