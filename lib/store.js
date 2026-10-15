/* ============================================================
   Document storage — MySQL or Postgres (chosen by DATABASE_URL), same model as the app: one document per
   (collection, id): app/core, leads/<id>, products/<id>.
   Every write takes the next value of a global sequence, so the
   browser can ask "what changed since seq N?" every few seconds.
   Deletes are kept as tombstones so other open browsers hear about them.
   ============================================================ */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS ink360_doc_seq;
CREATE TABLE IF NOT EXISTS ink360_docs (
  collection  text        NOT NULL,
  id          text        NOT NULL,
  data        jsonb,
  version     integer     NOT NULL DEFAULT 1,
  seq         bigint      NOT NULL DEFAULT nextval('ink360_doc_seq'),
  deleted     boolean     NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS ink360_docs_seq_idx ON ink360_docs (seq);
`;
const SQL = {
  list: `SELECT collection, id, data, version, seq, deleted FROM ink360_docs WHERE seq > $1 ORDER BY seq`,
  maxSeq: `SELECT COALESCE(MAX(seq), 0) AS seq FROM ink360_docs`,
  get: `SELECT collection, id, data, version, seq, deleted FROM ink360_docs WHERE collection = $1 AND id = $2`,
  put: `INSERT INTO ink360_docs (collection, id, data) VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (collection, id) DO UPDATE
          SET data = EXCLUDED.data, version = ink360_docs.version + 1,
              seq = nextval('ink360_doc_seq'), deleted = false, updated_at = now()
        RETURNING version, seq`,
  del: `UPDATE ink360_docs SET data = NULL, deleted = true, version = version + 1,
          seq = nextval('ink360_doc_seq'), updated_at = now()
        WHERE collection = $1 AND id = $2 AND deleted = false
        RETURNING version, seq`,
  listColl: `SELECT id, data, version FROM ink360_docs WHERE collection = $1 AND deleted = false`
};

function num(x){ return Number(x); }

function pgStore(url){
  const { Pool } = require('pg');
  const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? false : { rejectUnauthorized:false };
  const pool = new Pool({ connectionString: url, ssl, max: 5 });
  return {
    kind: 'postgres',
    async init(){ await pool.query(SCHEMA); },
    async list(since){
      const [rows, max] = await Promise.all([pool.query(SQL.list, [since]), pool.query(SQL.maxSeq)]);
      return { seq: num(max.rows[0].seq), docs: rows.rows.map(r => ({ collection:r.collection, id:r.id, data:r.data, version:r.version, seq:num(r.seq), deleted:r.deleted })) };
    },
    async get(c, id){ const r = await pool.query(SQL.get, [c, id]); const x = r.rows[0]; return x && !x.deleted ? { collection:x.collection, id:x.id, data:x.data, version:x.version, seq:num(x.seq) } : null; },
    async put(c, id, data){ const r = await pool.query(SQL.put, [c, id, JSON.stringify(data)]); return { version:r.rows[0].version, seq:num(r.rows[0].seq) }; },
    async del(c, id){ const r = await pool.query(SQL.del, [c, id]); return r.rows[0] ? { version:r.rows[0].version, seq:num(r.rows[0].seq) } : { version:0, seq:0 }; },
    async listCollection(c){ const r = await pool.query(SQL.listColl, [c]); return r.rows; }
  };
}

/* ---------- MySQL (Railway MySQL, same as the Lucas Industrial app) ----------
   A one-row counter table hands out the sequence number inside each write's
   transaction, so sequence order matches save order. */
const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ink360_seq (id TINYINT NOT NULL PRIMARY KEY, v BIGINT NOT NULL) ENGINE=InnoDB`,
  `INSERT IGNORE INTO ink360_seq (id, v) VALUES (1, 0)`,
  `CREATE TABLE IF NOT EXISTS ink360_docs (
     collection VARCHAR(32)  NOT NULL,
     id         VARCHAR(200) NOT NULL,
     data       LONGTEXT     NULL,
     version    INT          NOT NULL DEFAULT 1,
     seq        BIGINT       NOT NULL,
     deleted    TINYINT(1)   NOT NULL DEFAULT 0,
     updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     PRIMARY KEY (collection, id),
     KEY ink360_docs_seq (seq)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
];
function mysqlStore(url){
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ uri: url, connectionLimit: 5, waitForConnections: true, supportBigNumbers: true, dateStrings: true });
  const row = r => ({ collection: r.collection, id: r.id, data: r.data == null ? null : JSON.parse(r.data), version: Number(r.version), seq: Number(r.seq), deleted: !!Number(r.deleted) });
  async function tx(fn){
    const c = await pool.getConnection();
    try { await c.beginTransaction(); const out = await fn(c); await c.commit(); return out; }
    catch(e){ try { await c.rollback(); } catch(_){} throw e; }
    finally { c.release(); }
  }
  async function nextSeq(c){
    await c.query('UPDATE ink360_seq SET v = LAST_INSERT_ID(v + 1) WHERE id = 1');
    const [r] = await c.query('SELECT LAST_INSERT_ID() AS seq');
    return Number(r[0].seq);
  }
  return {
    kind: 'mysql',
    async init(){ for(const q of MYSQL_SCHEMA) await pool.query(q); },
    async list(since){
      const [rows] = await pool.query('SELECT collection, id, data, version, seq, deleted FROM ink360_docs WHERE seq > ? ORDER BY seq', [since]);
      const [max] = await pool.query('SELECT v FROM ink360_seq WHERE id = 1');
      return { seq: Number(max[0] ? max[0].v : 0), docs: rows.map(row) };
    },
    async get(c, id){
      const [rows] = await pool.query('SELECT collection, id, data, version, seq, deleted FROM ink360_docs WHERE collection = ? AND id = ?', [c, id]);
      const x = rows[0] && row(rows[0]); return x && !x.deleted ? x : null;
    },
    async put(c, id, data){
      return tx(async conn => {
        const seq = await nextSeq(conn);
        await conn.query(
          `INSERT INTO ink360_docs (collection, id, data, version, seq, deleted) VALUES (?, ?, ?, 1, ?, 0)
           ON DUPLICATE KEY UPDATE data = VALUES(data), version = version + 1, seq = VALUES(seq), deleted = 0`,
          [c, id, JSON.stringify(data), seq]);
        const [r] = await conn.query('SELECT version FROM ink360_docs WHERE collection = ? AND id = ?', [c, id]);
        return { version: Number(r[0].version), seq };
      });
    },
    async del(c, id){
      return tx(async conn => {
        const [r] = await conn.query('SELECT version FROM ink360_docs WHERE collection = ? AND id = ? AND deleted = 0 FOR UPDATE', [c, id]);
        if(!r[0]) return { version: 0, seq: 0 };
        const seq = await nextSeq(conn);
        await conn.query('UPDATE ink360_docs SET data = NULL, deleted = 1, version = version + 1, seq = ? WHERE collection = ? AND id = ?', [seq, c, id]);
        return { version: Number(r[0].version) + 1, seq };
      });
    },
    async listCollection(c){
      const [rows] = await pool.query('SELECT id, data, version FROM ink360_docs WHERE collection = ? AND deleted = 0', [c]);
      return rows.map(r => ({ id: r.id, data: r.data == null ? null : JSON.parse(r.data), version: Number(r.version) }));
    }
  };
}

/* Local development only: a JSON file (no DATABASE_URL). Not for production. */
function fileStore(file){
  let db = { seq:0, docs:{} };
  const key = (c, id) => c + '/' + id;
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); };
  return {
    kind: 'file (development only)',
    async init(){ if(fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); },
    async list(since){ return { seq: db.seq, docs: Object.values(db.docs).filter(d => d.seq > since).sort((a,b) => a.seq - b.seq).map(d => ({ ...d })) }; },
    async get(c, id){ const d = db.docs[key(c,id)]; return d && !d.deleted ? { ...d } : null; },
    async put(c, id, data){ const k = key(c,id); const prev = db.docs[k]; const d = { collection:c, id, data: JSON.parse(JSON.stringify(data)), version: prev ? prev.version + 1 : 1, seq: ++db.seq, deleted:false }; db.docs[k] = d; save(); return { version:d.version, seq:d.seq }; },
    async del(c, id){ const k = key(c,id); const prev = db.docs[k]; if(!prev || prev.deleted) return { version:0, seq:0 }; const d = { ...prev, data:null, deleted:true, version: prev.version + 1, seq: ++db.seq }; db.docs[k] = d; save(); return { version:d.version, seq:d.seq }; },
    async listCollection(c){ return Object.values(db.docs).filter(d => d.collection === c && !d.deleted).map(d => ({ id:d.id, data:d.data, version:d.version })); }
  };
}

/* Runs once at startup: write, read and delete a test document, so /healthz
   can show the database really works (not just that it connected). */
async function selfTest(store){
  const stamp = new Date().toISOString();
  await store.put('app', '_selftest', { stamp });
  const got = await store.get('app', '_selftest');
  if(!got || !got.data || got.data.stamp !== stamp) throw new Error('read back a different value');
  const d = await store.del('app', '_selftest');
  if(!d.seq) throw new Error('delete did not register');
  const after = await store.get('app', '_selftest');
  if(after) throw new Error('document still there after delete');
  return 'passed';
}

function createStore(config){
  const url = config.databaseUrl;
  if(/^mysql:\/\//i.test(url)) return mysqlStore(url);
  if(/^postgres(ql)?:\/\//i.test(url)) return pgStore(url);
  if(url) throw new Error('DATABASE_URL must start with mysql:// or postgres://');
  if(config.isProduction) throw new Error('DATABASE_URL is required in production (Railway: ${{MySQL.MYSQL_URL}})');
  return fileStore(config.devDataFile);
}

module.exports = { createStore, selfTest, SCHEMA, SQL, MYSQL_SCHEMA };
