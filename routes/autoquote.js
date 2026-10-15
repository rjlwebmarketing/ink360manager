/* ============================================================
   GET  /api/autoquote              is Claude connected? {enabled, auto, model}
   POST /api/autoquote/{leadId}     draft (or re-draft) this lead's quote with Claude
                                    body {text?: pasted customer email, replace?: true to overwrite existing lines}
   Login required (Owner or Builder). Answers when the draft is done (usually 5–20 s).
   ============================================================ */
'use strict';
const { send, readBody, parseBody } = require('../lib/http');
const { rateLimited } = require('../lib/rate-limit');
const autoquote = require('../lib/autoquote');

module.exports = async function autoquoteRoute(req, res, { store, url, session }){
  if(!session) return send(res, 401, { error:'Not logged in' });
  if(url.pathname === '/api/autoquote'){
    if(req.method !== 'GET') return send(res, 405, { error:'Method not allowed' });
    return send(res, 200, autoquote.status());
  }
  const m = url.pathname.match(/^\/api\/autoquote\/([A-Za-z0-9_\-.~:@+]{1,200})$/);
  if(!m) return send(res, 404, { error:'Not found' });
  if(req.method !== 'POST') return send(res, 405, { error:'Method not allowed' });
  if(rateLimited('autoquote:' + session.id, 30, 60 * 60 * 1000)) return send(res, 429, { error:'That’s a lot of drafts this hour. Try again later.' });
  const body = parseBody(await readBody(req), 'application/json') || {};
  const r = await autoquote.draftQuote(store, decodeURIComponent(m[1]), { text: body.text ? String(body.text) : '', replace: body.replace === true, by: session.role });
  if(!r.ok) return send(res, r.status || 500, { error: r.error });
  return send(res, 200, r);
};
