/* ============================================================
   QuickBooks product/service list
   Ken exports it from QuickBooks Online (Sales → Products and services →
   Export, CSV). It's stored as one document, app/qbitems:
     { source, importedAt, count, items: { "<Product/Service name>": [type, description, price|null] } }
   The app uses it to check that every quote line has a real QuickBooks item;
   the lead reader uses the bottle items to recognise the bottle a customer names.
   The same CSV parsing lives in the app (Import QuickBooks list) — keep them in step.
   ============================================================ */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* RFC 4180-ish CSV: quoted fields, "" escapes, newlines inside quotes. */
function parseCsv(text){
  const rows = []; let row = [], field = '', q = false;
  text = String(text || '').replace(/^﻿/, '');
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(q){
      if(c === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else q = false; }
      else field += c;
    } else if(c === '"') q = true;
    else if(c === ','){ row.push(field); field = ''; }
    else if(c === '\n' || c === '\r'){
      if(c === '\r' && text[i+1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if(field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows;
}

const money = v => { const s = String(v || '').replace(/[$,\s]/g, ''); return s === '' || isNaN(Number(s)) ? null : Number(s); };

/* CSV text → catalog. QuickBooks puts a few title lines above the header row. */
function catalogFromCsv(text, source){
  const rows = parseCsv(text);
  const h = rows.findIndex(r => r.some(c => /^product\/service/i.test(String(c).trim())) && r.some(c => /^(type|sales price|.*description)$/i.test(String(c).trim())));
  if(h < 0) throw new Error('This doesn’t look like the QuickBooks Products and services export (no "Product/Service" column).');
  const head = rows[h].map(c => String(c).trim().toLowerCase());
  const col = re => head.findIndex(c => re.test(c));
  const iName = col(/^product\/service/), iType = col(/^type$/), iDesc = col(/description/), iPrice = col(/sales price|^price|^rate/);
  const items = {};
  rows.slice(h + 1).forEach(r => {
    const name = String(r[iName] || '').trim(); if(!name) return;
    items[name] = [String(iType >= 0 ? r[iType] || '' : '').trim(), String(iDesc >= 0 ? r[iDesc] || '' : '').replace(/\s+/g, ' ').trim(), iPrice >= 0 ? money(r[iPrice]) : null];
  });
  const count = Object.keys(items).length;
  if(!count) throw new Error('No items found under the header row.');
  return { source: source || 'QuickBooks export', importedAt: new Date().toISOString(), count, items };
}

/* Bottle items (the glass itself, not the printing): used to recognise the bottle a lead mentions. */
const DECORATION = /^(RND|OVL|SQR)(TPR)?[0-9A-Z]+\.\d\.[\d.]+$/;
function isBottleItem(name, desc){
  if(DECORATION.test(name)) return false;
  return /\b\d+(\.\d+)?\s?(ml|oz|ltr|l)\b/i.test(desc) && /(bottle|decanter|flask|jar|can\b)/i.test(desc) && !/(ink|film|lamp|label|marker|liner|glove)/i.test(desc);
}
function bottleItems(catalog){
  if(!catalog || !catalog.items) return [];
  return Object.entries(catalog.items).filter(([n, v]) => isBottleItem(n, v[1])).map(([code, v]) => ({ code, desc: v[1] }));
}

/* Startup: if the database has no QuickBooks list yet, store the one shipped with the server (config/qb-items.json). */
async function seedCatalog(store){
  const have = await store.get('app', 'qbitems');
  if(have && have.data && have.data.items) return `${have.data.count || Object.keys(have.data.items).length} items (${have.data.source || 'imported'})`;
  const file = path.join(__dirname, '..', 'config', 'qb-items.json');
  if(!fs.existsSync(file)) return 'none';
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  await store.put('app', 'qbitems', seed);
  console.log(`[qb] stored the QuickBooks item list shipped with the server (${seed.count} items)`);
  return `${seed.count} items (${seed.source})`;
}

module.exports = { parseCsv, catalogFromCsv, bottleItems, isBottleItem, seedCatalog, DECORATION };
