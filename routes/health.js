/* GET /healthz — quick check that the server, database and webhook key are set up. */
'use strict';
const config = require('../config');
const { send } = require('../lib/http');

module.exports = function health(req, res, { store }){
  const dbOk = store.selfTest === 'passed';
  return send(res, dbOk ? 200 : 503, {
    ok: dbOk,
    database: store.selfTest || 'not run',
    version: config.version,
    storage: store.kind,
    webhook: !!config.wpformsKey,
    allowedOrigins: config.allowedOrigins
  });
};
