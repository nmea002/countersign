// Document store. MongoDB Atlas when MONGODB_URI is set, otherwise a JSON file.
// Collections: vendors, cases, signins, bankChanges, messages, ledger, payments, meta.
// Only these collections are ever touched by reset(); nothing else in the database is.
export const COLLECTIONS = ['vendors', 'cases', 'signins', 'bankChanges', 'messages', 'ledger', 'payments', 'meta'];
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { cfg } from './config.js';
import { similarity } from './text.js';

class LocalStore {
  kind = 'local';
  #data = {};
  #timer = null;
  constructor(file) {
    this.file = file === 'memory' ? null : file;
    if (this.file && existsSync(this.file)) {
      try { this.#data = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.#data = {}; }
    }
  }
  #save() {
    if (!this.file || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.#data));
    }, 150);
    this.#timer.unref?.();
  }
  col(name) {
    const docs = (this.#data[name] ??= {});
    return {
      all: async () => Object.values(docs).map((d) => structuredClone(d)),
      get: async (id) => (docs[id] ? structuredClone(docs[id]) : null),
      put: async (doc) => { docs[doc.id] = structuredClone(doc); this.#save(); return doc; },
      // Atomic compare-and-set on status: only one caller can move a document out of `from`.
      claim: async (id, from, patch) => {
        const d = docs[id];
        if (!d || ![].concat(from).includes(d.status)) return null;
        Object.assign(d, structuredClone(patch));
        this.#save();
        return structuredClone(d);
      },
    };
  }
  async incr(key, start) {
    const meta = (this.#data.meta ??= {});
    const d = (meta[key] ??= { id: key, n: start });
    d.n += 1;
    this.#save();
    return d.n;
  }
  // Clears Countersign data, keeping any listed collections and meta documents.
  async reset({ keep = [], keepMeta = [] } = {}) {
    const old = this.#data;
    this.#data = {};
    for (const name of keep) if (old[name]) this.#data[name] = old[name];
    for (const id of keepMeta) if (old.meta?.[id]) (this.#data.meta ??= {})[id] = old.meta[id];
    this.#save();
  }
  async searchVendors(name) { return Object.assign(rankVendors(await this.col('vendors').all(), name), { via: 'in-app' }); }
}

class MongoStore {
  kind = 'mongodb';
  constructor(client, db) { this.client = client; this.db = db; }
  col(name) {
    const c = this.db.collection(name);
    const strip = (d) => { if (!d) return null; const { _id, ...rest } = d; return rest; };
    return {
      all: async () => (await c.find().toArray()).map(strip),
      get: async (id) => strip(await c.findOne({ _id: id })),
      put: async (doc) => { await c.replaceOne({ _id: doc.id }, { ...doc }, { upsert: true }); return doc; },
      claim: async (id, from, patch) => strip(await c.findOneAndUpdate({ _id: id, status: { $in: [].concat(from) } }, { $set: patch }, { returnDocument: 'after' })),
    };
  }
  async incr(key, start) {
    const d = await this.db.collection('meta').findOneAndUpdate(
      { _id: key },
      [{ $set: { id: key, n: { $add: [{ $ifNull: ['$n', start] }, 1] } } }],
      { upsert: true, returnDocument: 'after' });
    return d.n;
  }
  // Only Countersign's own collections, never every collection in the database.
  async reset({ keep = [], keepMeta = [] } = {}) {
    for (const name of COLLECTIONS) {
      if (keep.includes(name)) continue;
      await this.db.collection(name).deleteMany(name === 'meta' ? { _id: { $nin: keepMeta } } : {});
    }
  }
  // Look-alike vendor search: Atlas Search fuzzy match when an index exists, else in-app ranking.
  async searchVendors(name) {
    if (cfg.atlasSearchIndex) {
      try {
        const hits = await this.db.collection('vendors').aggregate([
          { $search: { index: cfg.atlasSearchIndex, text: { query: name, path: 'name', fuzzy: { maxEdits: 2 } } } },
          { $limit: 5 },
        ]).toArray();
        if (hits.length) return Object.assign(rankVendors(hits.map(({ _id, ...v }) => v), name), { via: 'atlas-search' });
      } catch (err) {
        console.warn('[mongodb] Atlas Search unavailable, ranking in-app:', err.message);
      }
    }
    return Object.assign(rankVendors(await this.col('vendors').all(), name), { via: 'in-app' });
  }
  // Creates the Atlas Search index on vendors.name if it is missing. Safe to call on every start.
  async ensureSearchIndex() {
    if (!cfg.atlasSearchIndex) return { skipped: 'ATLAS_SEARCH_INDEX not set' };
    const col = this.db.collection('vendors');
    if (!(await this.db.listCollections({ name: 'vendors' }).toArray()).length) await this.db.createCollection('vendors');
    const existing = await col.listSearchIndexes(cfg.atlasSearchIndex).toArray();
    if (existing.length) return { exists: true, status: existing[0].status, queryable: existing[0].queryable };
    await col.createSearchIndex({ name: cfg.atlasSearchIndex, definition: { mappings: { dynamic: false, fields: { name: { type: 'string' } } } } });
    return { created: true };
  }
}

function rankVendors(vendors, name) {
  return vendors
    .map((vendor) => ({ vendor, score: similarity(name, vendor.name) }))
    .filter((h) => h.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export async function initStore() {
  if (cfg.mongoUri) {
    try {
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(cfg.mongoUri, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      console.log('[mongodb] connected');
      const store = new MongoStore(client, client.db(cfg.mongoDb));
      store.ensureSearchIndex().then((r) => console.log('[mongodb] search index:', JSON.stringify(r)), (err) => console.warn('[mongodb] search index not ensured:', err.message));
      return store;
    } catch (err) {
      console.warn('[mongodb] connection failed, using local store:', err.message);
    }
  }
  return new LocalStore(cfg.dataFile);
}

// Atomic, so two invoices arriving together never share a number.
export async function nextSeq(store, key, start) {
  return store.incr(key, start);
}
