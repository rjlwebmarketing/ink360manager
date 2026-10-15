/* GET /healthz — quick check that the server, database and webhook key are set up. */
'use strict';
const config = require('../config');
const { send } = require('../lib/http');
const autoquote = require('../lib/autoquote');

module.exports = function health(req, res, { store }){
  const dbOk = store.selfTest === 'passed';
  const loginsOk = store.logins === 'set';
  return send(res, dbOk ? 200 : 503, {
    ok: dbOk && loginsOk,
    database: store.selfTest || 'not run',
    logins: store.logins || 'not run',
    version: config.version,
    storage: store.kind,
    webhook: !!config.wpformsKey,
    quickbooksItems: store.qbItems || 'not run',
    draftQuotes: (s => s.enabled ? (s.auto ? 'on' : 'manual only') : 'off (ANTHROPIC_API_KEY not set)')(autoquote.status()),
    allowedOrigins: config.allowedOrigins
  });
};
