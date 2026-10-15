/* ============================================================
   Data API used by the app (same document model as the app:
   app/core, leads/<id>, products/<id>).
   GET    /api/docs?since=N               documents changed after sequence N
   GET    /api/docs/{collection}/{id}     one document
   PUT    /api/docs/{collection}/{id}     save, body {"data": {...}}
   DELETE /api/docs/{collection}/{id}     delete (kept as a marker for other browsers)
   ============================================================ */
'use strict';
const { send, readBody, parseBody } = require('../lib/http');

const VALID_ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const COLLECTIONS = new Set(['app', 'leads', 'products']);

module.exports = async function docs(req, res, { store, url }){
  if(url.pathname === '/api/docs'){
    if(req.method !== 'GET') return send(res, 405, { error:'Method not allowed' });
    const since = Number(url.searchParams.get('since')) || 0;
    return send(res, 200, await store.list(since));
  }
  const m = url.pathname.match(/^\/api\/docs\/([^/]+)\/([^/]+)$/);
  if(!m) return send(res, 404, { error:'Not found' });
  const coll = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
  if(!COLLECTIONS.has(coll) || !VALID_ID.test(id)) return send(res, 400, { error:'Unknown collection or bad id' });

  if(req.method === 'GET'){ const d = await store.get(coll, id); return d ? send(res, 200, d) : send(res, 404, { error:'Not found' }); }
  if(req.method === 'PUT'){
    const body = parseBody(await readBody(req), 'application/json');
    if(!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return send(res, 400, { error:'Expected {"data": {...}}' });
    return send(res, 200, await store.put(coll, id, body.data));
  }
  if(req.method === 'DELETE') return send(res, 200, await store.del(coll, id));
  return send(res, 405, { error:'Method not allowed' });
};
