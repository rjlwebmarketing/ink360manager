/* ============================================================
   POST /api/hooks/wpforms?form=<name>
   WPForms Webhooks addon → new ink360 lead. Protected by the shared key
   in the X-Ink360-Key header (Railway variable WPFORMS_KEY).
   GET on the same address just confirms the endpoint is up.
   ============================================================ */
'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { send, readBody, parseBody, clientIp } = require('../lib/http');
const { rateLimited } = require('../lib/rate-limit');
const { handleWpforms } = require('../lib/leads-from-wpforms');

function keyMatches(given){
  const expected = config.wpformsKey;
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

module.exports = async function wpforms(req, res, { store, url }){
  if(req.method === 'GET') return send(res, 200, 'ink360 WPForms endpoint is running. Send entries here with POST.');
  if(req.method !== 'POST') return send(res, 405, { error:'Method not allowed' });

  const ip = clientIp(req);
  if(rateLimited(ip, config.webhookRateLimitPerMinute)) return send(res, 429, { error:'Too many requests' });
  if(!config.wpformsKey) return send(res, 503, { error:'WPFORMS_KEY is not set on the server' });
  if(!keyMatches(String(req.headers['x-ink360-key'] || ''))){
    console.warn(`[wpforms] rejected request from ${ip}: wrong or missing X-Ink360-Key`);
    return send(res, 401, { error:'Wrong or missing X-Ink360-Key header' });
  }

  const body = parseBody(await readBody(req), req.headers['content-type']);
  const result = await handleWpforms(store, body, { form: url.searchParams.get('form') || '' });
  console.log(`[wpforms] ${result.action}${result.leadId ? ' ' + result.leadId : ''}${result.reason ? ' — ' + result.reason : ''}`);
  return send(res, result.status || 200, result);
};
