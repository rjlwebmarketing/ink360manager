/* ============================================================
   ink360 Management — server (entry point)
   Holds the app's data (Postgres) and receives website leads from WPForms.
   The app page itself is hosted on ink360's domain and calls this server.

   config/   settings from environment variables
   lib/      storage, HTTP helpers, WPForms → lead logic, rate limit
   routes/   one file per address the server answers
   tools/    tests and helper scripts (not used at runtime)
   ============================================================ */
'use strict';
const http = require('node:http');
const config = require('./config');
const { createStore, selfTest } = require('./lib/store');
const { send, applyCors } = require('./lib/http');

const routes = {
  health:  require('./routes/health'),
  docs:    require('./routes/docs'),
  wpforms: require('./routes/wpforms'),
  appPage: require('./routes/app-page')
};

const store = createStore(config);

async function route(req, res){
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ctx = { store, url };

  // Browser calls from the app on ink360's domain
  if(p.startsWith('/api/docs') || p === '/healthz'){
    const allowed = applyCors(req, res);
    if(req.method === 'OPTIONS'){ res.writeHead(allowed ? 204 : 403, res.extraHeaders || {}); return res.end(); }
  }

  if(p === '/healthz' && req.method === 'GET') return routes.health(req, res, ctx);
  if(p === '/api/docs' || p.startsWith('/api/docs/')) return routes.docs(req, res, ctx);
  if(p === '/api/hooks/wpforms') return routes.wpforms(req, res, ctx);
  if(req.method === 'GET' && (p === '/' || p === '/index.html')) return routes.appPage(req, res, ctx);
  return send(res, 404, { error:'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    const status = err.status || 500;
    if(status >= 500) console.error(err);
    if(!res.headersSent) send(res, status, { error: status >= 500 ? 'Server error' : err.message });
  });
});

store.init().then(async () => {
  try { store.selfTest = await selfTest(store); }
  catch(err){ store.selfTest = 'failed: ' + err.message; console.error('Database self-test failed:', err); }
  server.listen(config.port, () => console.log(
    `ink360 server v${config.version} on :${config.port} — storage: ${store.kind} (self-test ${store.selfTest}); webhook key ${config.wpformsKey ? 'set' : 'NOT set'}; allowed origins: ${config.allowedOrigins.join(', ') || 'none'}`
  ));
}).catch(err => { console.error('Storage failed to start:', err); process.exit(1); });
