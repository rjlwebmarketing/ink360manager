/* ============================================================
   All settings come from environment variables (set them in Railway →
   app service → Variables). Nothing secret is ever stored in the repo.
   ============================================================ */
'use strict';
const path = require('node:path');

const list = v => String(v || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

module.exports = {
  port: Number(process.env.PORT) || 3000,
  isProduction: process.env.NODE_ENV === 'production',

  // Database: mysql://… (Railway: ${{MySQL.MYSQL_URL}}) or postgres://…  Empty = local JSON file, development only.
  databaseUrl: process.env.DATABASE_URL || '',
  devDataFile: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'dev-store.json'),

  // Shared key WPForms sends in the X-Ink360-Key header.
  wpformsKey: process.env.WPFORMS_KEY || '',

  // Web addresses allowed to use the data API from a browser — the domain where index.html lives,
  // e.g. "https://app.ink360.com". Comma-separate several.
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),

  // Optional: also serve the app page from this server (local testing). Path to an index.html.
  appFile: process.env.APP_FILE || '',

  maxBodyBytes: 5 * 1024 * 1024,
  webhookRateLimitPerMinute: 30,
  version: require('../package.json').version
};
