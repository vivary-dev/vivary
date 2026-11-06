import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { getDbExec, runMigrations } from '@agent-native/core/db';
import { addSession, getSessionEmail, removeSession } from '@agent-native/core/server';
import { z } from 'zod';

const OWNER = 'owner@local.vivary.test';
const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const GRANT_AGE = 30 * 24 * 60 * 60 * 1000;
export const browserConfiguration = z.object({
  origin: z.string().max(300).refine(value => {
    try { const url = new URL(value); return url.origin === value && url.protocol === 'https:' && !url.username && !url.password
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
  }, 'Use an exact private HTTPS origin without a path.'),
  preview: z.object({ origin: z.string().url().max(300), port: z.number().int().min(1024).max(65535) }).strict().nullable().default(null),
  port: z.number().int().min(1024).max(65535), label: z.string().trim().min(1).max(80),
}).strict().refine(config => {
  if (!config.preview) return true;
  const app = new URL(config.origin), preview = new URL(config.preview.origin);
  return preview.origin === config.preview.origin && preview.protocol === 'https:' && preview.hostname === app.hostname
    && preview.origin !== app.origin && !preview.username && !preview.password && config.preview.port !== config.port;
}, 'Use the same HTTPS hostname on a separate public port and a separate loopback ingress port.');
const migrate = runMigrations([{ version: 1, name: 'paired-browser-access', sql: `
CREATE TABLE IF NOT EXISTS vivary_browser_instance (
 slot INTEGER PRIMARY KEY, id TEXT NOT NULL, enabled INTEGER NOT NULL,
 origin TEXT, port INTEGER, label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vivary_browser_grants (
 id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, native_token TEXT NOT NULL,
 label TEXT NOT NULL, status TEXT NOT NULL, expires_at BIGINT NOT NULL
);` }, { version: 2, name: 'isolated-preview-configuration', sql: `ALTER TABLE vivary_browser_instance ADD COLUMN preview_origin TEXT;
ALTER TABLE vivary_browser_instance ADD COLUMN preview_port INTEGER;` }], { table: 'vivary_browser_migrations' });

export async function createBrowserAccess({ database = getDbExec(), sessions = { addSession, getSessionEmail, removeSession },
  migrateDatabase = migrate, now = Date.now } = {}) {
  await migrateDatabase();
  const execute = (sql, args = []) => database.execute({ sql, args });
  await execute('INSERT INTO vivary_browser_instance (slot,id,enabled,label) VALUES (1,?,0,?) ON CONFLICT (slot) DO NOTHING', [randomUUID(), 'This Vivary host']);
  const load = async () => (await execute('SELECT * FROM vivary_browser_instance WHERE slot=1')).rows[0];
  let instance = await load();
  let fault = false;
  let closed = false;
  let queue = Promise.resolve();
  const pending = new Map();
  const active = new Map();
  let recent = [];
  const serial = operation => { const result = queue.then(operation); queue = result.catch(() => undefined); return result; };
  const cancel = id => { for (const controller of active.get(id) ?? []) controller.abort(); active.delete(id); };
  const cancelAll = () => { for (const id of active.keys()) cancel(id); };
  const failClosed = () => { fault = true; cancelAll(); pending.clear(); };
  const prune = () => { for (const [key, request] of pending) if (request.expiresAt <= now()) pending.delete(key); };
  const enabled = () => !closed && !fault && Number(instance.enabled) === 1;
  // Only incomplete or expired grants are cleaned up; unrelated approved devices survive restart.
  for (const row of (await execute("SELECT id,native_token FROM vivary_browser_grants WHERE status <> 'active' OR expires_at <= ?", [now()])).rows) {
    await sessions.removeSession(row.native_token).catch(() => undefined);
  }

  async function register(grant, controller) {
      if (!grant || await sessions.getSessionEmail(grant.native_token) !== OWNER
        || !enabled() || controller.signal.aborted || Number(grant.expires_at) <= now()) return null;
      const controllers = active.get(grant.id) ?? new Set(); controllers.add(controller); active.set(grant.id, controllers);
      let timer;
      const release = () => {
        clearTimeout(timer); controllers.delete(controller);
        if (!controllers.size && active.get(grant.id) === controllers) active.delete(grant.id);
      };
      const expire = () => {
        const remaining = Number(grant.expires_at) - now();
        if (remaining <= 0) { controller.abort(); release(); }
        else { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); timer.unref(); }
      };
      expire();
      return { id: grant.id, release };
  }
  return {
    configuration() { return { enabled: enabled(), origin: instance.origin, port: Number(instance.port), instanceId: instance.id, label: instance.label, preview: instance.preview_origin ? { origin: instance.preview_origin, port: Number(instance.preview_port) } : null }; },
    async status() {
      prune();
      return { ...this.configuration(), fault, devices: (await execute('SELECT id,label,status,expires_at FROM vivary_browser_grants ORDER BY expires_at DESC')).rows,
        pending: [...pending.values()].map(({ id, label, code, expiresAt, approved }) => ({ id, label, code, expiresAt, approved })) };
    },
    configure(input) { return serial(async () => {
      const config = browserConfiguration.parse(input);
      if (closed) throw new Error('Desktop connection closed.');
      // An origin change invalidates earlier grants so a new host cannot inherit their authority.
      try {
        if (instance.origin && instance.origin !== config.origin) {
          await execute("UPDATE vivary_browser_grants SET status='revoked' WHERE status='active'");
          cancelAll(); pending.clear();
        }
        await execute('UPDATE vivary_browser_instance SET enabled=1,origin=?,port=?,label=?,preview_origin=?,preview_port=? WHERE slot=1', [config.origin, config.port, config.label, config.preview?.origin ?? null, config.preview?.port ?? null]);
        instance = await load(); fault = false;
      } catch { failClosed(); throw new Error('Remote access could not be saved. Admission is closed.'); }
    }); },
    requestPairing(label) {
      if (!enabled()) throw new Error('Remote access is disabled.');
      prune(); recent = recent.filter(time => time > now() - 60_000);
      if (recent.length >= 10 || pending.size >= 20) throw new Error('Too many pairing requests. Wait a minute.');
      recent.push(now());
      const credential = secret();
      const challenge = { id: randomUUID(), label: z.string().trim().min(1).max(80).parse(label),
        code: String(randomInt(100000, 1000000)), expiresAt: now() + 300_000, approved: false, lastPoll: 0 };
      pending.set(digest(credential), challenge);
      return { credential, id: challenge.id, code: challenge.code, expiresAt: challenge.expiresAt, label: instance.label, instanceId: instance.id };
    },
    approve(id) { return serial(async () => {
      prune();
      if (!enabled()) throw new Error('Remote access is disabled.');
      const challenge = [...pending.values()].find(item => item.id === id);
      if (!challenge) throw new Error('Pairing request expired.');
      challenge.approved = true;
    }); },
    completePairing(credential) { return serial(async () => {
      prune();
      const key = digest(credential);
      const challenge = pending.get(key);
      if (!enabled() || !challenge) throw new Error('Pairing request expired. Start again.');
      if (now() - challenge.lastPoll < 1000) throw new Error('Wait before checking again.');
      challenge.lastPoll = now();
      if (!challenge.approved) return { pending: true };
      pending.delete(key);
      const browserCredential = secret();
      const token = secret();
      const id = randomUUID();
      const expiresAt = now() + GRANT_AGE;
      // Preparing first makes a crash or uncertain Native write harmless to admission.
      try {
        await execute("INSERT INTO vivary_browser_grants (id,credential_hash,native_token,label,status,expires_at) VALUES (?,?,?,?,'preparing',?)",
        [id, digest(browserCredential), token, challenge.label, expiresAt]);
        if (!enabled()) throw new Error('Desktop connection closed.');
        await sessions.addSession(token, OWNER);
        if (!enabled()) throw new Error('Desktop connection closed.');
        await execute("UPDATE vivary_browser_grants SET status='active' WHERE id=? AND status='preparing'", [id]);
        if (!enabled()) throw new Error('Desktop connection closed.');
      } catch {
        await execute("UPDATE vivary_browser_grants SET status='revoked' WHERE id=?", [id]).catch(failClosed);
        await sessions.removeSession(token).catch(() => undefined);
        throw new Error('Pairing could not finish. Start a new request.');
      }
      return { pending: false, credential: browserCredential, expiresAt };
    }); },
    admit(credential, controller) { return serial(async () => {
      if (!enabled() || !credential) return null;
      const grant = (await execute("SELECT * FROM vivary_browser_grants WHERE credential_hash=? AND status='active' AND expires_at>?", [digest(credential), now()])).rows[0];
      return register(grant, controller);
    }); },
    admitPreviewGrant(id, controller) { return serial(async () => {
      if (!enabled()) return null;
      const grant = (await execute("SELECT * FROM vivary_browser_grants WHERE id=? AND status='active' AND expires_at>?", [id, now()])).rows[0];
      return register(grant, controller);
    }); },
    revoke(id) { return serial(async () => {
      const grant = (await execute('SELECT * FROM vivary_browser_grants WHERE id=?', [id])).rows[0];
      if (!grant) throw new Error('Device not found.');
      cancel(id);
      try { await execute("UPDATE vivary_browser_grants SET status='revoked' WHERE id=?", [id]); }
      catch { failClosed(); throw new Error('Revocation was not saved. All browser admission is closed. Retry before restarting.'); }
      await sessions.removeSession(grant.native_token).catch(() => undefined);
    }); },
    disable() { return serial(async () => {
      cancelAll(); pending.clear();
      try { await execute('UPDATE vivary_browser_instance SET enabled=0 WHERE slot=1'); instance = await load(); }
      catch { failClosed(); throw new Error('Disable was not saved. All browser admission is closed. Retry before restarting.'); }
    }); },
    close() { closed = true; cancelAll(); pending.clear(); },
  };
}
