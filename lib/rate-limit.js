/* Simple in-memory per-IP limiter for the public website endpoint. */
'use strict';
const hits = new Map();

function rateLimited(ip, limit, windowMs = 60000){
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
  recent.push(now); hits.set(ip, recent);
  if(hits.size > 5000) hits.clear();
  return recent.length > limit;
}

module.exports = { rateLimited };
