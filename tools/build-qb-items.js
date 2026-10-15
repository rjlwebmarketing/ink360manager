/* Turn a QuickBooks "Products and services" CSV export into config/qb-items.json
   (the list the server stores on first start).
   Usage: node tools/build-qb-items.js path/to/export.csv */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { catalogFromCsv } = require('../lib/qb-items');

const file = process.argv[2];
if(!file){ console.error('Usage: node tools/build-qb-items.js <QuickBooks export .csv>'); process.exit(1); }
const cat = catalogFromCsv(fs.readFileSync(file, 'utf8'), path.basename(file));
cat.importedAt = new Date(fs.statSync(file).mtime).toISOString();
const out = path.join(__dirname, '..', 'config', 'qb-items.json');
fs.writeFileSync(out, JSON.stringify(cat));
console.log(`Wrote ${out}: ${cat.count} items`);
