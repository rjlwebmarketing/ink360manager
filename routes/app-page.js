/* ============================================================
   GET / — the app normally lives on ink360's domain (file manager).
   For local testing you can also let this server show it by setting
   APP_FILE to an index.html; otherwise "/" just says what this is.
   ============================================================ */
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = require('../config');
const { send } = require('../lib/http');

let cache = null;
function load(){
  const stat = fs.statSync(config.appFile);
  if(!cache || cache.mtime !== stat.mtimeMs){
    let html = fs.readFileSync(config.appFile, 'utf8');
    // Tell the page its data API is this same server.
    const flag = `<script>window.__INK360_SERVER__=${JSON.stringify({ version: config.version })};</script>`;
    html = html.includes('</head>') ? html.replace('</head>', flag + '</head>') : flag + html;
    cache = { mtime: stat.mtimeMs, html, etag: '"' + crypto.createHash('sha1').update(html).digest('hex').slice(0, 16) + '"' };
  }
  return cache;
}

module.exports = function appPage(req, res){
  if(!config.appFile || !fs.existsSync(config.appFile)){
    return send(res, 200, `ink360 Management server v${config.version}. The app itself is on ink360's website; this server holds its data and receives website leads.`);
  }
  const page = load();
  if(req.headers['if-none-match'] === page.etag){ res.writeHead(304); return res.end(); }
  res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache', 'ETag': page.etag, 'X-Content-Type-Options':'nosniff' });
  return res.end(page.html);
};
