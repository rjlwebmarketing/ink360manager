/* ============================================================
   POST   /api/login          {code} → {token, role, expiresAt}
   GET    /api/session        who am I (checks the Bearer token)
   DELETE /api/session        log out (Lock button)
   POST   /api/auth/codes     {owner?, builder?} — Builder only; signs everyone else out
   ============================================================ */
'use strict';
const { send, readBody, parseBody, clientIp } = require('../lib/http');
const { rateLimited } = require('../lib/rate-limit');

const LOGIN_TRIES = 10;                 // per IP …
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // … per 15 minutes

module.exports = async function authRoute(req, res, { auth, url, session }){
  const p = url.pathname;

  if(p === '/api/login'){
    if(req.method !== 'POST') return send(res, 405, { error:'Method not allowed' });
    const ip = clientIp(req);
    if(rateLimited('login:' + ip, LOGIN_TRIES, LOGIN_WINDOW_MS)){
      console.warn(`[auth] too many login attempts from ${ip}`);
      return send(res, 429, { error:'Too many tries. Wait 15 minutes, then try again.' });
    }
    const body = parseBody(await readBody(req), 'application/json');
    const r = await auth.login(String(body.code || ''));
    if(r.error){ if(r.status === 401) console.warn(`[auth] wrong code from ${ip}`); return send(res, r.status, { error: r.error }); }
    console.log(`[auth] ${r.role} logged in from ${ip}`);
    return send(res, 200, r);
  }

  if(p === '/api/session'){
    if(req.method === 'GET') return session ? send(res, 200, { role: session.role, expiresAt: session.expiresAt }) : send(res, 401, { error:'Not logged in' });
    if(req.method === 'DELETE'){ await auth.logout(session); return send(res, 200, { ok:true }); }
    return send(res, 405, { error:'Method not allowed' });
  }

  if(p === '/api/auth/codes'){
    if(req.method !== 'POST') return send(res, 405, { error:'Method not allowed' });
    if(!session) return send(res, 401, { error:'Not logged in' });
    const body = parseBody(await readBody(req), 'application/json');
    const r = await auth.changeCodes(session, { owner: body.owner ? String(body.owner) : '', builder: body.builder ? String(body.builder) : '' });
    if(r.error) return send(res, r.status, { error: r.error });
    console.log(`[auth] access codes changed in the app; ${r.signedOut} other session(s) ended`);
    return send(res, 200, r);
  }

  return send(res, 404, { error:'Not found' });
};
