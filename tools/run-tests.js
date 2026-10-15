/* Server tests — starts the server with a throwaway file store and checks the
   data API, cross-origin access and the WPForms endpoint. Run: npm test */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3900 + Math.floor(Math.random() * 90);
const KEY = 'test-key-123';
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ink360-')), 'store.json');
const base = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'https://app.ink360.example';
const OWNER = 'owner-code-1', BUILDER = 'builder-code-1';
const env = Object.assign({}, process.env, { PORT, WPFORMS_KEY: KEY, DATA_FILE: dataFile, ALLOWED_ORIGINS: ORIGIN + '/', OWNER_CODE: OWNER, BUILDER_CODE: BUILDER });
delete env.APP_FILE; delete env.RESET_CODES;
// Seed an old-style core doc with codes in it, to check the server removes them on start
fs.writeFileSync(dataFile, JSON.stringify({ seq:1, docs:{ 'app/core': { collection:'app', id:'core', data:{ settings:{ passcode:'ken', builderPasscode:'rob', boardLink:'' } }, version:1, seq:1, deleted:false } } }));
delete env.DATABASE_URL; delete env.NODE_ENV;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore','pipe','pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);

const hook = (body, { key = KEY, type = 'json', form = '' } = {}) => fetch(`${base}/api/hooks/wpforms${form ? '?form=' + encodeURIComponent(form) : ''}`, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' }, key ? { 'X-Ink360-Key': key } : {}),
  body: type === 'json' ? JSON.stringify(body) : new URLSearchParams(body).toString()
}).then(async r => ({ status: r.status, body: await r.json() }));

let TOKEN = '';
const login = code => fetch(base + '/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code }) }).then(async r => ({ status: r.status, body: await r.json() }));
const api = (path, opts = {}, token = TOKEN) => fetch(base + path, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}) }));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('health check incl. database self-test and logins', async () => { const r = await (await fetch(base + '/healthz')).json(); assert.equal(r.ok, true); assert.equal(r.database, 'passed'); assert.equal(r.logins, 'set'); assert.equal(r.webhook, true); });
test('data API refuses requests without a login', async () => {
  assert.equal((await fetch(base + '/api/docs?since=0')).status, 401);
  assert.equal((await fetch(base + '/api/docs/leads/x')).status, 401);
  assert.equal((await api('/api/docs?since=0', {}, 'not-a-real-token-xxxxxxxxxxxxxxxx')).status, 401);
});
test('wrong code is refused; Owner and Builder codes log in with the right role', async () => {
  assert.equal((await login('nope-nope')).status, 401);
  const o = await login(OWNER); assert.equal(o.status, 200); assert.equal(o.body.role, 'owner'); assert.ok(o.body.token.length > 30);
  const b = await login(BUILDER); assert.equal(b.body.role, 'builder'); TOKEN = b.body.token;
  const me = await (await api('/api/session')).json(); assert.equal(me.role, 'builder');
});
test('old access codes are removed from the app data; codes never appear in the data API', async () => {
  const all = await (await api('/api/docs?since=0')).json();
  const text = JSON.stringify(all);
  assert.ok(!all.docs.some(d => d.collection === 'auth' || d.collection === 'session'), 'auth/session rows leaked');
  assert.ok(!/scrypt\$|"passcode"|builderPasscode/.test(text), 'codes leaked');
  const core = all.docs.find(d => d.collection === 'app' && d.id === 'core'); assert.ok(core); assert.equal(core.data.settings.passcode, undefined);
  await api('/api/docs/app/core', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ data:{ settings:{ passcode:'x', builderPasscode:'y' } } }) });
  const c2 = await (await api('/api/docs/app/core')).json(); assert.equal(c2.data.settings.passcode, undefined); assert.equal(c2.data.settings.builderPasscode, undefined);
  assert.equal((await api('/api/docs/auth/codes')).status, 400); assert.equal((await api('/api/docs/session/x')).status, 400);
});
test('Owner can’t change codes; Builder can, and everyone else is signed out', async () => {
  const o = (await login(OWNER)).body.token;
  const denied = await api('/api/auth/codes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ owner:'new-owner-123' }) }, o);
  assert.equal(denied.status, 403);
  const short = await api('/api/auth/codes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ owner:'ab' }) });
  assert.equal(short.status, 400);
  const ok = await (await api('/api/auth/codes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ owner:'new-owner-123' }) })).json();
  assert.equal(ok.ok, true); assert.ok(ok.signedOut >= 1);
  assert.equal((await api('/api/docs?since=0', {}, o)).status, 401, 'owner session should be ended');
  assert.equal((await api('/api/docs?since=0')).status, 200, 'builder session stays');
  assert.equal((await login(OWNER)).status, 401); assert.equal((await login('new-owner-123')).body.role, 'owner');
});
test('logout ends the session', async () => {
  const t = (await login(BUILDER)).body.token;
  assert.equal((await api('/api/session', { method:'DELETE' }, t)).status, 200);
  assert.equal((await api('/api/session', {}, t)).status, 401);
});
test('root explains the server when no app file is set', async () => { const h = await (await fetch(base + '/')).text(); assert.match(h, /ink360 Management server/); });
test('app domain is allowed to call the data API (CORS)', async () => {
  const pre = await fetch(base + '/api/docs/leads/x', { method:'OPTIONS', headers:{ Origin: ORIGIN, 'Access-Control-Request-Method':'PUT' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const get = await api('/api/docs?since=0', { headers:{ Origin: ORIGIN } });
  assert.equal(get.headers.get('access-control-allow-origin'), ORIGIN);
});
test('other websites are not allowed (CORS)', async () => {
  const pre = await fetch(base + '/api/docs/leads/x', { method:'OPTIONS', headers:{ Origin:'https://evil.example', 'Access-Control-Request-Method':'PUT' } });
  assert.equal(pre.status, 403); assert.equal(pre.headers.get('access-control-allow-origin'), null);
});
test('webhook rejects a missing key', async () => { const r = await hook({ name:'X', email:'x@example.com' }, { key: '' }); assert.equal(r.status, 401); });
test('webhook rejects a wrong key', async () => { const r = await hook({ name:'X', email:'x@example.com' }, { key: 'nope-nope-nope' }); assert.equal(r.status, 401); });
test('JSON entry creates a New website lead', async () => {
  const r = await hook({ entry_id:'501', Name:'Jordan Avery', 'Company Name':'Harbor Ridge Distilling', Email:'Jordan@Example.com', Phone:'(555) 201-4400', Message:'6,000 round bottles, 2 colors', 'Bottle Size':'750ml' }, { form: 'Quote Request' });
  assert.equal(r.status, 200); assert.equal(r.body.action, 'created'); assert.equal(r.body.leadId, 'wp_501');
  const d = await (await api('/api/docs/leads/wp_501')).json();
  assert.equal(d.data.stage, 'new'); assert.equal(d.data.source, 'website');
  assert.equal(d.data.company, 'Harbor Ridge Distilling'); assert.equal(d.data.contact, 'Jordan Avery');
  assert.equal(d.data.email, 'jordan@example.com'); assert.match(d.data.notes, /6,000 round bottles/); assert.match(d.data.notes, /Bottle Size: 750ml/);
  assert.equal(d.data.web.formName, 'Quote Request'); assert.equal(d.data.web.fields['Company Name'], 'Harbor Ridge Distilling');
});
test('same entry again is ignored (no duplicate)', async () => { const r = await hook({ entry_id:'501', Name:'Jordan Avery', Email:'jordan@example.com' }); assert.equal(r.body.action, 'duplicate'); });
test('new entry from same email with an open lead is added as a note', async () => {
  const r = await hook({ entry_id:'502', Name:'Jordan Avery', Email:'jordan@example.com', Message:'Also need 375ml' });
  assert.equal(r.body.action, 'noted'); assert.equal(r.body.leadId, 'wp_501');
  const d = await (await api('/api/docs/leads/wp_501')).json();
  assert.match(d.data.activity[0].text, /Also need 375ml/); assert.equal(d.data.webEntries.length, 1);
  const again = await hook({ entry_id:'502', Email:'jordan@example.com' }); assert.equal(again.body.action, 'duplicate');
});
test('form-encoded entry with first/last name and address', async () => {
  const r = await hook({ entry_id:'503', first_name:'Sam', last_name:'Ortiz', company:'Copper Kettle', email:'sam@copperkettle.example', street:'1 Main St', city:'Fort Atkinson', state:'wi', zip:'53538' }, { type:'form' });
  assert.equal(r.body.action, 'created');
  const d = await (await api('/api/docs/leads/wp_503')).json();
  assert.equal(d.data.contact, 'Sam Ortiz'); assert.equal(d.data.shipTo.city, 'Fort Atkinson'); assert.equal(d.data.shipTo.state, 'WI');
});
test('WPForms "||" address and checkbox values', async () => {
  const r = await hook({ entry_id:'504', name:'Lee Park', email:'lee@park.example', address:'665 Wedgewood Ave||Suite 2||Nashville||TN||37203||US', 'Bottle Shapes':'Round||Square' });
  assert.equal(r.body.action, 'created');
  const d = await (await api('/api/docs/leads/wp_504')).json();
  assert.equal(d.data.shipTo.street, '665 Wedgewood Ave, Suite 2'); assert.equal(d.data.shipTo.city, 'Nashville'); assert.equal(d.data.shipTo.zip, '37203');
  assert.match(d.data.notes, /Bottle Shapes: Round, Square/);
});
test('entry without entry_id still de-duplicates by content', async () => {
  const a = await hook({ name:'No Id', phone:'555-0100' }); const b = await hook({ name:'No Id', phone:'555-0100' });
  assert.equal(a.body.action, 'created'); assert.equal(b.body.action, 'duplicate');
});
test('empty entry is rejected', async () => { const r = await hook({ Message:'' }); assert.equal(r.status, 422); });
test('data API: put, list since, delete tombstone', async () => {
  const before = await (await api('/api/docs?since=0')).json();
  const put = await (await api('/api/docs/products/pr_t', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ data:{ id:'pr_t', controlNo:'999.001' } }) })).json();
  assert.ok(put.seq > before.seq);
  const changed = await (await api('/api/docs?since=' + before.seq)).json();
  assert.deepEqual(changed.docs.map(d => d.id), ['pr_t']);
  await api('/api/docs/products/pr_t', { method:'DELETE' });
  const afterDel = await (await api('/api/docs?since=' + put.seq)).json();
  assert.equal(afterDel.docs[0].deleted, true);
  const bad = await api('/api/docs/secrets/x', { method:'PUT', headers:{'Content-Type':'application/json'}, body:'{"data":{}}' });
  assert.equal(bad.status, 400);
});

test('repeated wrong codes are blocked (runs last: it locks this IP out)', async () => {
  let last;
  for(let i = 0; i < 12; i++) last = await login('wrong-code-' + i);
  assert.equal(last.status, 429);
});

(async () => {
  for(let i = 0; i < 50; i++){ try{ await fetch(base + '/healthz'); break; }catch(e){ await new Promise(r => setTimeout(r, 100)); } }
  let failed = 0;
  for(const t of tests){
    try{ await t.fn(); console.log('  ✓ ' + t.name); }
    catch(e){ failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
  }
  srv.kill();
  if(failed){ console.log(`\n${failed} failed. Server log:\n${log}`); process.exit(1); }
  console.log(`\nAll ${tests.length} tests passed.`);
})();
