'use strict';
// Account degli host, quiz salvati e risultati delle partite.
// Tutto in file JSON dentro DATA_DIR: niente database da installare, si copia la
// cartella per fare un backup. Le password sono salvate con scrypt, mai in chiaro.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = 30;

const cache = {};

function file(name) {
  return path.join(DIR, name + '.json');
}

function load(name) {
  if (cache[name]) return cache[name];
  try {
    cache[name] = JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    cache[name] = {};
  }
  return cache[name];
}

// scrittura su file temporaneo e rename: se il processo muore a meta' il file vecchio resta intero
function save(name) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache[name], null, 1));
  fs.renameSync(tmp, file(name));
}

const newId = () => crypto.randomBytes(6).toString('base64url');

// ---------------------------------------------------------------- account

function secret() {
  const db = load('config');
  if (!db.secret) {
    db.secret = crypto.randomBytes(32).toString('hex');
    save('config');
  }
  return db.secret;
}

function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 64).toString('hex');
}

const USER_RE = /^[a-z0-9._-]{3,24}$/;

function register(user, pass) {
  user = String(user || '').trim().toLowerCase();
  pass = String(pass || '');
  if (!USER_RE.test(user)) return { err: 'Nome utente: da 3 a 24 caratteri, lettere minuscole, numeri, . _ -' };
  if (pass.length < 6) return { err: 'La password deve avere almeno 6 caratteri' };
  const users = load('users');
  if (users[user]) return { err: 'Nome utente gia\' preso' };
  const salt = crypto.randomBytes(16).toString('hex');
  users[user] = { salt, hash: hashPass(pass, salt), created: Date.now() };
  save('users');
  return { user };
}

function checkLogin(user, pass) {
  user = String(user || '').trim().toLowerCase();
  const u = load('users')[user];
  if (!u) return null;
  const h = Buffer.from(hashPass(String(pass || ''), u.salt), 'hex');
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex')) ? user : null;
}

function userCount() {
  return Object.keys(load('users')).length;
}

// Il token e' firmato, non salvato: riavviare il server non fa uscire nessuno.
function makeToken(user) {
  const body = Buffer.from(JSON.stringify({ u: user, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + sig;
}

function readToken(tok) {
  if (typeof tok !== 'string' || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return e > Date.now() && load('users')[u] ? u : null;
  } catch {
    return null;
  }
}

function userFromCookie(header) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(header || '');
  return m ? readToken(decodeURIComponent(m[1])) : null;
}

// ---------------------------------------------------------------- quiz

const LIM = { quiz: 200, domande: 100, testo: 200, opzione: 80, accettate: 10, risultati: 500 };
const TEMPI = [5, 10, 15, 20, 30, 45, 60, 90, 120];

const txt = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// Controlla e ripulisce un quiz arrivato dall'editor. Restituisce { quiz } o { err }.
function cleanQuiz(raw) {
  if (!raw || typeof raw !== 'object') return { err: 'Quiz non valido' };
  const title = txt(raw.title, 80);
  if (!title) return { err: 'Serve un titolo' };
  const list = Array.isArray(raw.qs) ? raw.qs : [];
  if (!list.length) return { err: 'Serve almeno una domanda' };
  if (list.length > LIM.domande) return { err: `Massimo ${LIM.domande} domande` };
  const qs = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i] || {};
    const n = `Domanda ${i + 1}: `;
    const q = txt(d.q, LIM.testo);
    if (!q) return { err: n + 'manca il testo' };
    const t = TEMPI.includes(+d.t) ? +d.t : 20;
    if (d.type === 'aperta') {
      const a = (Array.isArray(d.a) ? d.a : []).map((x) => txt(x, LIM.opzione)).filter(Boolean).slice(0, LIM.accettate);
      qs.push({ type: 'aperta', q, a, t });
      continue;
    }
    const o = (Array.isArray(d.o) ? d.o : []).map((x) => txt(x, LIM.opzione));
    if (o.length < 2 || o.length > 4) return { err: n + 'servono da 2 a 4 risposte' };
    if (o.some((x) => !x)) return { err: n + 'c\'e\' una risposta vuota' };
    const c = [...new Set((Array.isArray(d.c) ? d.c : []).filter((k) => Number.isInteger(k) && k >= 0 && k < o.length))].sort((x, y) => x - y);
    if (!c.length) return { err: n + 'segna almeno una risposta giusta' };
    qs.push({ type: 'scelta', q, o, c, t });
  }
  return { quiz: { title, desc: txt(raw.desc, 200), shuffle: !!raw.shuffle, qs } };
}

function listQuizzes(owner) {
  const res = load('results');
  const plays = {};
  for (const r of Object.values(res)) {
    if (r.owner !== owner || !r.quizId) continue;
    const p = plays[r.quizId] || (plays[r.quizId] = { n: 0, last: 0 });
    p.n++;
    p.last = Math.max(p.last, r.date);
  }
  return Object.values(load('quizzes'))
    .filter((q) => q.owner === owner)
    .sort((a, b) => b.updated - a.updated)
    .map((q) => ({ id: q.id, title: q.title, desc: q.desc, n: q.qs.length, updated: q.updated,
      plays: plays[q.id] ? plays[q.id].n : 0, lastPlay: plays[q.id] ? plays[q.id].last : null }));
}

function getQuiz(owner, id) {
  const q = load('quizzes')[id];
  return q && q.owner === owner ? q : null;
}

function saveQuiz(owner, id, raw) {
  const { quiz, err } = cleanQuiz(raw);
  if (err) return { err };
  const db = load('quizzes');
  if (id) {
    const old = db[id];
    if (!old || old.owner !== owner) return { err: 'Quiz non trovato' };
    Object.assign(quiz, { id, owner, created: old.created });
  } else {
    if (Object.values(db).filter((q) => q.owner === owner).length >= LIM.quiz) return { err: `Massimo ${LIM.quiz} quiz` };
    Object.assign(quiz, { id: newId(), owner, created: Date.now() });
  }
  quiz.updated = Date.now();
  db[quiz.id] = quiz;
  save('quizzes');
  return { quiz };
}

function deleteQuiz(owner, id) {
  const db = load('quizzes');
  if (!db[id] || db[id].owner !== owner) return false;
  delete db[id];
  save('quizzes');
  return true;
}

// ---------------------------------------------------------------- risultati

function addResult(rep) {
  const db = load('results');
  rep.id = newId();
  db[rep.id] = rep;
  // un tetto per host: oltre, si buttano le partite piu' vecchie
  const mine = Object.values(db).filter((r) => r.owner === rep.owner).sort((a, b) => b.date - a.date);
  for (const r of mine.slice(LIM.risultati)) delete db[r.id];
  save('results');
  return rep.id;
}

function listResults(owner, quizId) {
  return Object.values(load('results'))
    .filter((r) => r.owner === owner && (!quizId || r.quizId === quizId))
    .sort((a, b) => b.date - a.date)
    .map((r) => ({ id: r.id, quizId: r.quizId, title: r.title, date: r.date, partial: r.partial,
      players: r.players.length, nq: r.questions.length, avg: r.avg }));
}

function getResult(owner, id) {
  const r = load('results')[id];
  return r && r.owner === owner ? r : null;
}

function deleteResult(owner, id) {
  const db = load('results');
  if (!db[id] || db[id].owner !== owner) return false;
  delete db[id];
  save('results');
  return true;
}

module.exports = {
  register, checkLogin, userCount, makeToken, readToken, userFromCookie, SESSION_DAYS,
  cleanQuiz, listQuizzes, getQuiz, saveQuiz, deleteQuiz, TEMPI,
  addResult, listResults, getResult, deleteResult
};
