/* Small HTTP helpers shared by the routes (no framework). */
'use strict';
const config = require('../config');

function send(res, status, body, headers){
  const isJson = typeof body !== 'string';
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, Object.assign({
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, res.extraHeaders || {}, headers || {}));
  res.end(payload);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if(size > config.maxBodyBytes){ reject(httpError(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType){
  if(!raw) return {};
  const ct = String(contentType || '').toLowerCase();
  if(ct.includes('application/x-www-form-urlencoded')){
    const out = {};
    for(const [k, v] of new URLSearchParams(raw)){ out[k] = (k in out) ? [].concat(out[k], v) : v; }
    return out;
  }
  try { return JSON.parse(raw); }
  catch(e){ throw httpError(400, 'Body is not valid JSON'); }
}

function httpError(status, message){ return Object.assign(new Error(message), { status }); }

/* Cross-origin access for the app page hosted on ink360's domain (ALLOWED_ORIGINS). */
function applyCors(req, res){
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if(origin && config.allowedOrigins.includes(origin)){
    res.extraHeaders = Object.assign(res.extraHeaders || {}, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    });
    return true;
  }
  return false;
}

function clientIp(req){ return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

module.exports = { send, readBody, parseBody, httpError, applyCors, clientIp };
