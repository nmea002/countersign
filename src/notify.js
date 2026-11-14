// Texts the approver and receives their replies. Photon (iMessage/SMS) when
// configured; otherwise the dashboard's on-screen phone plays the approver.
// Every message, either way, is kept in the `messages` collection.
import { randomUUID } from 'node:crypto';
import { cfg } from './config.js';

export class Notifier {
  kind = 'simulator';
  constructor(store, emit = () => {}) { this.store = store; this.emit = emit; this.onReply = async () => ''; }

  async log(dir, text, extra = {}) {
    const msg = { id: randomUUID(), ts: new Date().toISOString(), dir, text, channel: this.kind, ...extra };
    await this.store.col('messages').put(msg);
    this.emit('message', { id: msg.id });
    return msg;
  }
  async send(text, extra) { return this.log('out', text, { delivery: 'simulator', ...extra }); }

  // An approver reply, from Photon or from the simulator. Returns the agent's answer.
  async receive(text, actor, extra = {}) {
    await this.log('in', text, { actor, ...extra });
    const answer = await this.onReply(text, actor);
    if (answer) await this.send(answer);
    return answer;
  }
  health() { return { kind: this.kind, ok: true }; }
  start() {}
}

const SEEN_MAX = 500;
const OVERLAP_MS = 60_000; // listings are eventually consistent: re-read a minute back, dedupe by id
const MAX_PAGES = 20;
const MAX_ATTEMPTS = 5;

// State lives in meta, so a restart resumes where it left off:
//   photonState = { cursor, seen: [ids], actAfter }   photonSpace = { spaceId, agentId }
// Messages created before `actAfter` (first enrollment) only open the thread; they never
// approve or hold anything. Messages received while the server was down are processed.
export class PhotonNotifier extends Notifier {
  kind = 'photon';
  #photon; #running = false; #timer = null;
  lastPoll = null; lastError = null;

  constructor(store, emit, { client = null, now = () => Date.now() } = {}) {
    super(store, emit);
    this.#photon = client;
    this.now = now;
  }

  async #space() { return this.store.col('meta').get('photonSpace'); }
  async #state() {
    const s = await this.store.col('meta').get('photonState');
    if (s) return s;
    const backfillH = Number(process.env.PHOTON_BACKFILL_HOURS ?? 72);
    const fresh = { id: 'photonState', cursor: new Date(this.now() - backfillH * 3600000).toISOString(), seen: [], actAfter: new Date(this.now()).toISOString() };
    await this.store.col('meta').put(fresh);
    return fresh;
  }

  // Outgoing texts are written first, then delivered; anything not accepted stays in the outbox.
  async send(text, extra) {
    const msg = await this.log('out', text, { ...extra, delivery: 'queued: not sent yet', attempts: 0 });
    return this.#deliver(msg);
  }
  async #deliver(msg) {
    const space = await this.#space();
    if (!space) {
      // A shared Photon line cannot send the first message; the approver texts the agent once to open the thread.
      msg.delivery = 'queued: approver has not texted the agent yet';
    } else {
      msg.attempts = (msg.attempts || 0) + 1;
      try {
        const sent = await this.#photon.projects.sendMessage({
          path: { id: cfg.photonProject },
          headers: { 'idempotency-key': msg.id }, // retries of the same message are de-duplicated by Photon
          body: { spaceId: space.spaceId, senderId: space.agentId, content: { type: 'text', format: 'plain', text: msg.text } },
        });
        msg.photonMessageId = sent?.id || null;
        msg.delivery = sent?.status === 'delivered' ? 'delivered' : `accepted by Photon${sent?.status ? ` (${sent.status})` : ''}`;
        msg.sentAt = new Date(this.now()).toISOString();
      } catch (err) {
        console.warn('[photon] send failed:', err.message);
        msg.delivery = msg.attempts >= MAX_ATTEMPTS ? `failed: ${err.message}` : `queued: retrying after error: ${err.message}`;
      }
    }
    await this.store.col('messages').put(msg);
    this.emit('message', { id: msg.id });
    return msg;
  }
  async flushOutbox() {
    if (!(await this.#space())) return 0;
    const out = (await this.store.col('messages').all())
      .filter((m) => m.dir === 'out' && m.channel === 'photon' && String(m.delivery || '').startsWith('queued'))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    for (const m of out) await this.#deliver(m);
    return out.length;
  }

  // Accepted is not delivered: follow recent sends until Photon reports delivered or failed.
  async trackDelivery() {
    const cutoff = this.now() - 30 * 60000;
    const open = (await this.store.col('messages').all())
      .filter((m) => m.dir === 'out' && m.photonMessageId && String(m.delivery).startsWith('accepted') && Date.parse(m.sentAt) >= cutoff)
      .slice(0, 10);
    for (const m of open) {
      try {
        const p = await this.#photon.projects.getMessage({ path: { id: cfg.photonProject, messageId: m.photonMessageId } });
        if (p.status === 'delivered') m.delivery = 'delivered';
        else if (p.status === 'failed') m.delivery = `failed: ${p.failure?.message || p.failure?.code || 'Photon reported failure'}`;
        else continue;
        m.deliveryCheckedAt = new Date(this.now()).toISOString();
        await this.store.col('messages').put(m);
        this.emit('message', { id: m.id });
      } catch (err) { console.warn('[photon] delivery check:', err.message); }
    }
    return open.length;
  }

  // One poll: every page since the cursor, each message processed once.
  async tick() {
    if (this.#running) return { skipped: true };
    this.#running = true;
    let handled = 0;
    try {
      const st = await this.#state();
      const seen = new Set(st.seen);
      let pageToken, pages = 0, newest = st.cursor;
      const since = new Date(Date.parse(st.cursor) - OVERLAP_MS).toISOString();
      do {
        const page = await this.#photon.projects.listMessages({
          path: { id: cfg.photonProject },
          query: { createdSince: since, direction: 'received', order: 'asc', pageSize: 100, platform: cfg.photonPlatform, ...(pageToken ? { pageToken } : {}) },
        });
        for (const m of page.items || []) {
          const at = Date.parse(m.createdAt);
          if (at > Date.parse(newest)) newest = new Date(at).toISOString();
          if (seen.has(m.id) || m.status !== 'received') continue;
          seen.add(m.id);
          // Only the configured approver's own number can approve or hold anything.
          if (m.sentBy?.kind !== 'human' || m.sentBy.handle !== cfg.photonApprover) continue;
          await this.store.col('meta').put({ id: 'photonSpace', spaceId: m.space.id, agentId: m.receivedBy.id });
          // Record it as seen before acting, so a crash mid-way never replays an approval.
          await this.#saveState(st, seen, newest);
          if (m.content?.type !== 'text') continue;
          if (!(at >= Date.parse(st.actAfter))) continue; // pre-enrollment history: thread only
          await this.receive(m.content.text.trim(), cfg.approverName, { photonId: m.id });
          handled++;
        }
        pageToken = page.nextPageToken;
      } while (pageToken && ++pages < MAX_PAGES);
      await this.#saveState(st, seen, newest);
      await this.flushOutbox();
      await this.trackDelivery();
      this.lastPoll = new Date(this.now()).toISOString();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      console.warn('[photon] poll failed:', err.message);
    } finally {
      this.#running = false;
    }
    return { handled };
  }
  async #saveState(st, seen, cursor) {
    st.seen = [...seen].slice(-SEEN_MAX);
    st.cursor = cursor;
    await this.store.col('meta').put(st);
  }

  health() { return { kind: this.kind, ok: !!this.lastPoll && !this.lastError, lastPoll: this.lastPoll, lastError: this.lastError }; }

  async start() {
    if (!this.#photon) {
      const { Photon } = await import('@photon-ai/api');
      this.#photon = new Photon({ headers: { Authorization: `Bearer ${cfg.photonKey}` } });
    }
    await this.tick();
    this.#timer = setInterval(() => this.tick(), 3000);
    this.#timer.unref();
    console.log(`[photon] polling ${cfg.photonPlatform} for replies from the configured approver`);
  }
}

export function initNotifier(store, emit) {
  const live = cfg.photonKey && cfg.photonProject && cfg.photonApprover;
  return live ? new PhotonNotifier(store, emit) : new Notifier(store, emit);
}
