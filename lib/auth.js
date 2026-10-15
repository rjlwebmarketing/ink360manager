/* ============================================================
   Server-side logins.
   - Two access codes (Owner, Builder), stored only as scrypt hashes in the
     database (collection "auth", never served by /api/docs).
   - First start: codes come from Railway variables OWNER_CODE / BUILDER_CODE.
     After that, codes changed in the app win (RESET_CODES=true re-seeds from
     the variables if a code is ever lost).
   - Logging in creates a session: a random token the browser keeps and sends
     as "Authorization: Bearer <token>". Only a SHA-256 of the token is stored
     (collection "session"), so a database leak can't be replayed.
   - Sessions end 12 hours after last use (the browser also forgets the token
     when its tab closes). Changing the codes ends every other session.
   ============================================================ */
'use strict';
const crypto = require('node:crypto');

const SESSION_HOURS = 12;   // sliding: kept alive while the app is open (it checks in every 10 s)
const TOUCH_EVERY_MS = 15 * 60 * 1000;     // refresh "last used" at most every 15 minutes
const CACHE_MS = 60 * 1000;                // trust a looked-up session for a minute
const MIN_CODE_LENGTH = Math.max(1, Number(process.env.MIN_CODE_LENGTH) || 3);   // Rob's choice (10/15): short codes allowed; raise via MIN_CODE_LENGTH

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function hashCode(code){
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(code), salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function codeMatches(code, stored){
  if(!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(code), Buffer.from(saltHex, 'hex'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
function checkNewCode(code, label){
  const c = String(code || '');
  if(c.length < MIN_CODE_LENGTH) return `${label} code must be at least ${MIN_CODE_LENGTH} characters.`;
  if(/^\s|\s$/.test(c)) return `${label} code can't start or end with a space.`;
  return '';
}

function createAuth(store, env){
  const cache = new Map();   // tokenHash → { session, at }

  async function getCodes(){ const d = await store.get('auth', 'codes'); return d ? d.data : null; }

  /* Startup: make sure codes exist. Returns a short status for /healthz. */
  async function init(){
    // The old browser-only login kept the codes inside the app data (app/core). Remove them.
    const core = await store.get('app', 'core');
    if(core && core.data && core.data.settings && ('passcode' in core.data.settings || 'builderPasscode' in core.data.settings)){
      delete core.data.settings.passcode; delete core.data.settings.builderPasscode;
      await store.put('app', 'core', core.data);
      console.log('[auth] removed old access codes from the app data');
    }
    const existing = await getCodes();
    const reset = /^(1|true|yes)$/i.test(env.RESET_CODES || '');
    if(existing && !reset) return 'set';
    const owner = env.OWNER_CODE || '', builder = env.BUILDER_CODE || '';
    const problem = checkNewCode(owner, 'OWNER_CODE') || checkNewCode(builder, 'BUILDER_CODE') || (owner === builder ? 'OWNER_CODE and BUILDER_CODE must be different.' : '');
    if(problem){ console.warn('[auth] logins not set up: ' + problem); return existing ? 'set' : 'not set: ' + problem; }
    await store.put('auth', 'codes', { owner: hashCode(owner), builder: hashCode(builder), updatedAt: new Date().toISOString(), source: 'railway-variables' });
    if(reset) await endSessions(null);
    console.log(`[auth] access codes ${reset ? 'reset' : 'set'} from OWNER_CODE / BUILDER_CODE`);
    return 'set';
  }

  async function login(code){
    const codes = await getCodes();
    if(!codes) return { error: 'Logins aren’t set up on the server yet (OWNER_CODE / BUILDER_CODE).', status: 503 };
    let role = null;
    if(codeMatches(code, codes.builder)) role = 'builder';
    else if(codeMatches(code, codes.owner)) role = 'owner';
    if(!role) return { error: 'That code isn’t right.', status: 401 };
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const session = { role, createdAt: new Date(now).toISOString(), lastUsedAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_HOURS * 36e5).toISOString() };
    await store.put('session', sha256(token), session);
    return { token, role, expiresAt: session.expiresAt };
  }

  /* Look up the session behind an Authorization header. Returns {id, role, ...} or null. */
  async function sessionFrom(req){
    const m = String(req.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
    if(!m) return null;
    const id = sha256(m[1]);
    const hit = cache.get(id);
    if(hit && Date.now() - hit.at < CACHE_MS) return hit.session;
    const d = await store.get('session', id);
    if(!d){ cache.delete(id); return null; }
    const s = Object.assign({ id }, d.data);
    if(Date.parse(s.expiresAt) < Date.now()){ await store.del('session', id); cache.delete(id); return null; }
    if(Date.now() - Date.parse(s.lastUsedAt) > TOUCH_EVERY_MS){
      s.lastUsedAt = new Date().toISOString();
      s.expiresAt = new Date(Date.now() + SESSION_HOURS * 36e5).toISOString();
      const { id: _, ...body } = s; await store.put('session', id, body);
    }
    cache.set(id, { session: s, at: Date.now() });
    if(cache.size > 1000) cache.clear();
    return s;
  }

  async function logout(session){ if(session){ await store.del('session', session.id); cache.delete(session.id); } }

  /* End every session except keepId (null = all). */
  async function endSessions(keepId){
    const rows = await store.listCollection('session');
    for(const r of rows) if(r.id !== keepId){ await store.del('session', r.id); cache.delete(r.id); }
    return rows.filter(r => r.id !== keepId).length;
  }

  async function changeCodes(session, { owner, builder }){
    if(!session || session.role !== 'builder') return { error: 'Only the Builder code can change access codes.', status: 403 };
    if(!owner && !builder) return { error: 'Nothing to change.', status: 400 };
    const problem = (owner && checkNewCode(owner, 'Owner')) || (builder && checkNewCode(builder, 'Builder'));
    if(problem) return { error: problem, status: 400 };
    const codes = (await getCodes()) || {};
    if(owner && builder && owner === builder) return { error: 'The two codes must be different.', status: 400 };
    if(owner && codeMatches(owner, codes.builder) && !builder) return { error: 'The Owner code can’t be the same as the Builder code.', status: 400 };
    if(builder && codeMatches(builder, codes.owner) && !owner) return { error: 'The Builder code can’t be the same as the Owner code.', status: 400 };
    const next = Object.assign({}, codes, { updatedAt: new Date().toISOString(), source: 'app' });
    if(owner) next.owner = hashCode(owner);
    if(builder) next.builder = hashCode(builder);
    await store.put('auth', 'codes', next);
    const ended = await endSessions(session.id);
    return { ok: true, signedOut: ended };
  }

  return { init, login, sessionFrom, logout, changeCodes, endSessions };
}

module.exports = { createAuth, hashCode, codeMatches, MIN_CODE_LENGTH };
