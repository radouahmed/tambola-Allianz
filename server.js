const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const PRIZES = ['Porte-clés','Pare-soleil','Casquette','Support téléphone','Repose-tête','Pins'];

const dbFile = process.env.DB_PATH || path.join(__dirname, 'tombola.db');
const db = new sqlite3.Database(dbFile);

// === Utils: day string in Africa/Casablanca (YYYY-MM-DD) ===
function casablancaDayStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Casablanca',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const y = parts.find(p=>p.type==='year').value;
  const m = parts.find(p=>p.type==='month').value;
  const da = parts.find(p=>p.type==='day').value;
  return `${y}-${m}-${da}`;
}

function ensureTables(cb){
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      expiry_month TEXT,
      insurance_company TEXT,
      city TEXT,
      district TEXT,
      intermediary TEXT,
      zone TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER UNIQUE NOT NULL,
      prize TEXT NOT NULL,
      created_at TEXT NOT NULL,
      day TEXT,
      FOREIGN KEY(entry_id) REFERENCES entries(id)
    )`);
  });
  cb && cb();
}

// Add 'day' column if missing (ignore error if exists)
function addSpinsDayColumn(cb){
  db.run(`ALTER TABLE spins ADD COLUMN day TEXT`, [], (err) => {
    cb && cb(); // ignore duplicate column error
  });
}

// === Prize Weights (admin configurable) ===
function ensurePrizeWeights(cb){
  db.run(`CREATE TABLE IF NOT EXISTS prize_weights (
    prize TEXT PRIMARY KEY,
    weight REAL NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`, [], (e)=>{
    if (e) return cb && cb(e);
    const now = new Date().toISOString();
    const stmt = db.prepare(`INSERT OR IGNORE INTO prize_weights (prize, weight, updated_at) VALUES (?,?,?)`);
    PRIZES.forEach(p => stmt.run([p, 1, now]));
    stmt.finalize(cb);
  });
}

function fetchWeightMap(cb){
  db.all(`SELECT prize, weight FROM prize_weights`, [], (err, rows)=>{
    if (err) return cb(err);
    const map = {}; rows.forEach(r => map[r.prize] = Number(r.weight) || 0);
    cb(null, map);
  });
}

function pickPrizeWeighted(prizes, weightMap){
  const weights = prizes.map(p => Math.max(0, Number(weightMap[p] ?? 1)));
  const total = weights.reduce((a,b)=>a+b,0);
  if (!(total > 0)) return prizes[Math.floor(Math.random()*prizes.length)];
  let r = Math.random() * total;
  for (let i=0;i<prizes.length;i++){
    if (r < weights[i]) return prizes[i];
    r -= weights[i];
  }
  return prizes[prizes.length-1];
}

// === Daily caps per prize ===
function ensureDailyCaps(cb){
  db.run(`CREATE TABLE IF NOT EXISTS prize_daily_caps (
    prize TEXT PRIMARY KEY,
    cap INTEGER,
    updated_at TEXT NOT NULL
  )`, [], (e)=>{
    if (e) return cb && cb(e);
    const now = new Date().toISOString();
    const stmt = db.prepare(`INSERT OR IGNORE INTO prize_daily_caps (prize, cap, updated_at) VALUES (?,?,?)`);
    PRIZES.forEach(p => stmt.run([p, null, now])); // null => unlimited
    stmt.finalize(cb);
  });
}

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'), { index:false }));

function adminAuth(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== ADMIN_USER || user.pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm=\"Admin Area\"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

// Splash as home
app.get('/', (req,res)=> res.sendFile(path.join(__dirname, 'public', 'splash.html')));

// Create entry
app.post('/api/entries', (req, res) => {
  const { name, phone, expiry_month, insurance_company, city, district, intermediary, zone, consent } = req.body || {};
  if (!name || !phone || !expiry_month || !insurance_company || !city || !district || consent !== true) {
    return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  }
  const createdAt = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO entries 
    (name, phone, expiry_month, insurance_company, city, district, intermediary, zone, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run([
    String(name).trim(),
    String(phone).trim(),
    String(expiry_month).trim(),
    String(insurance_company).trim(),
    String(city).trim(),
    String(district).trim(),
    String(intermediary || '').trim(),
    String(zone || '').trim(),
    createdAt
  ], function(err){
    if (err) { console.error(err); return res.status(500).json({ error: 'Erreur serveur.' }); }
    res.json({ entry_id: this.lastID });
  });
});

// Spin once per entry with weights + daily caps
app.post('/api/spin', (req, res) => {
  const { entry_id } = req.body || {};
  if (!entry_id) return res.status(400).json({ error: 'entry_id manquant.' });

  db.get(`SELECT prize FROM spins WHERE entry_id = ?`, [entry_id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erreur serveur.' });
    if (row) return res.json({ prize: row.prize, already: true });

    const today = casablancaDayStr();

    db.all(`SELECT prize, COUNT(*) AS cnt FROM spins WHERE day = ? GROUP BY prize`, [today], (uErr, usedRows) => {
      if (uErr) return res.status(500).json({ error: 'Erreur serveur.' });
      const usedMap = {}; (usedRows||[]).forEach(r => usedMap[r.prize] = Number(r.cnt)||0);

      db.all(`SELECT prize, cap FROM prize_daily_caps`, [], (cErr, capsRows) => {
        if (cErr) return res.status(500).json({ error: 'Erreur serveur.' });
        const caps = {}; (capsRows||[]).forEach(r => caps[r.prize] = (r.cap==null ? null : Number(r.cap)));

        const eligible = PRIZES.filter(p => {
          const cap = caps[p];
          if (cap == null || cap <= 0) return true;
          const used = usedMap[p] || 0;
          return used < cap;
        });

        if (eligible.length === 0) {
          return res.status(429).json({ error: "Plus de lots disponibles aujourd'hui." });
        }

        fetchWeightMap((werr, wmap) => {
          const prize = werr ? eligible[Math.floor(Math.random()*eligible.length)]
                             : pickPrizeWeighted(eligible, wmap);

          const createdAt = new Date().toISOString();
          const day = today;
          const stmt = db.prepare(`INSERT INTO spins (entry_id, prize, created_at, day) VALUES (?, ?, ?, ?)`);
          stmt.run([entry_id, prize, createdAt, day], function(err2){
            if (err2) {
              if (String(err2).includes('UNIQUE constraint failed')) {
                db.get(`SELECT prize FROM spins WHERE entry_id = ?`, [entry_id], (err3, row2) => {
                  if (err3 || !row2) return res.status(500).json({ error: "Erreur d'attribution du lot." });
                  return res.json({ prize: row2.prize, already: true });
                });
              } else {
                console.error(err2);
                return res.status(500).json({ error: 'Erreur serveur.' });
              }
            } else {
              return res.json({ prize, already: false });
            }
          });
        });
      });
    });
  });
});

// Admin
app.get('/admin', adminAuth, (req,res)=> res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/admin/data', adminAuth, (req, res) => {
  const q = `SELECT e.id, e.name, e.phone, e.expiry_month, e.insurance_company, e.city, e.district, e.intermediary, e.zone, e.created_at,
                    s.prize, s.created_at AS prize_at, s.day
             FROM entries e LEFT JOIN spins s ON s.entry_id = e.id
             ORDER BY e.created_at DESC, e.id DESC`;
  db.all(q, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Erreur serveur.' });
    res.json({ rows });
  });
});

app.get('/admin/export', adminAuth, (req, res) => {
  const q = `SELECT e.id, e.name, e.phone, e.expiry_month, e.insurance_company, e.city, e.district, e.intermediary, e.zone, e.created_at,
                    COALESCE(s.prize, '') AS prize, COALESCE(s.created_at, '') AS prize_at, COALESCE(s.day,'') AS day
             FROM entries e LEFT JOIN spins s ON s.entry_id = e.id
             ORDER BY e.created_at DESC, e.id DESC`;
  db.all(q, [], (err, rows) => {
    if (err) return res.status(500).send('Erreur serveur.');
    const header = ['id','name','phone','expiry_month','insurance_company','city','district','intermediary','zone','created_at','prize','prize_at','day'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines = [ header.join(',') ];
    for (const row of rows) lines.push(header.map(h => esc(row[h])).join(','));
    const csv = '\uFEFF' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tombola_export.csv"');
    res.send(csv);
  });
});

// Admin: weights
app.get('/admin/weights', adminAuth, (req,res)=>{
  db.all(`SELECT prize, weight, updated_at FROM prize_weights ORDER BY prize`, [], (err, rows)=>{
    if (err) return res.status(500).json({ error: 'Erreur serveur.' });
    const total = rows.reduce((s,r)=> s + (Number(r.weight)||0), 0);
    const payload = rows.map(r=> ({
      prize: r.prize,
      weight: Number(r.weight)||0,
      percent: total>0 ? (Number(r.weight)/total*100) : 0,
      updated_at: r.updated_at
    }));
    res.json({ weights: payload, total });
  });
});

app.post('/admin/weights', adminAuth, (req,res)=>{
  const incoming = (req.body && req.body.weights) || {};
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE prize_weights SET weight = ?, updated_at = ? WHERE prize = ?`);
  PRIZES.forEach(p=>{
    let w = Number(incoming[p]);
    if (!Number.isFinite(w) || w < 0) w = 0;
    stmt.run([w, now, p]);
  });
  stmt.finalize(err=>{
    if (err) return res.status(500).json({ error: 'Erreur de mise à jour.' });
    db.all(`SELECT prize, weight FROM prize_weights ORDER BY prize`, [], (e2, rows)=>{
      if (e2) return res.status(500).json({ error: 'Erreur serveur.' });
      res.json({ ok: true, weights: rows });
    });
  });
});

// Admin: daily caps
app.get('/admin/caps', adminAuth, (req,res)=>{
  const today = casablancaDayStr();
  db.all(`SELECT prize, cap, updated_at FROM prize_daily_caps ORDER BY prize`, [], (e1, rows)=>{
    if (e1) return res.status(500).json({ error: 'Erreur serveur.' });
    db.all(`SELECT prize, COUNT(*) AS cnt FROM spins WHERE day = ? GROUP BY prize`, [today], (e2, used)=>{
      const usedMap = {}; (used||[]).forEach(r=> usedMap[r.prize]=Number(r.cnt)||0);
      const payload = rows.map(r=>{
        const cap = (r.cap==null ? null : Number(r.cap));
        const u = usedMap[r.prize]||0;
        const remaining = (cap==null || cap<=0) ? null : Math.max(0, cap - u);
        return { prize: r.prize, cap, used: u, remaining, updated_at: r.updated_at };
      });
      res.json({ today, caps: payload });
    });
  });
});

app.post('/admin/caps', adminAuth, (req,res)=>{
  const incoming = (req.body && req.body.caps) || {};
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE prize_daily_caps SET cap = ?, updated_at = ? WHERE prize = ?`);
  PRIZES.forEach(p=>{
    let v = incoming[p];
    if (v === '' || v === null || v === undefined) v = null;
    else { v = Number(v); if (!Number.isFinite(v) || v < 0) v = 0; }
    stmt.run([v, now, p]);
  });
  stmt.finalize(err=>{
    if (err) return res.status(500).json({ error: 'Erreur de mise à jour.' });
    res.json({ ok: true });
  });
});

// Fallback
app.get('*', (req,res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')));

ensureTables(() => {
  addSpinsDayColumn(() => {
    ensurePrizeWeights(() => {
      ensureDailyCaps(() => {
        app.listen(PORT, ()=> console.log(`Allianz Tombola running on http://localhost:${PORT}`));
      });
    });
  });
});
