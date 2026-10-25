'use strict';
// .env accanto a server.js (es. GEMINI_API_KEY=...), se c'e'. Le variabili gia' impostate vincono.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch { /* nessun .env */ }
const http = require('http');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const QUESTIONS = require('./questions.json');
const store = require('./store');

const TICK_MS = 150;
const ROOM_TTL = 3 * 60 * 60 * 1000;
const ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ2345679'; // niente 0/O/1/I/B/8: si leggono male da lontano

// Il personaggio con cui si gioca. Niente immagini da caricare: sono emoji, si vedono
// su qualsiasi telefono e restano nitide proiettate.
const PERSONAGGI = ['🦊','🐼','🐸','🐵','🐙','🦄','🐯','🐨','🦁','🐧','🐢','🦖','🐝','🦉','🐬','🦩','🐳','🦔','🐰','🐻'];

// Il gioco da palco che l'host puo' girare ai telefoni. Fisso qui: l'host accende e
// spegne il link, non sceglie l'indirizzo, cosi' nessuno manda link strani alla sala.
const NPLUS_URL = 'https://contesamuele999-dev.github.io/n-arena-stickman/';

const rooms = new Map();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
  } while (rooms.has(c));
  return c;
}

function standings(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, i) => ({ pid: p.pid, name: p.name, ch: p.ch, score: p.score, rank: i + 1, on: p.ws ? 1 : 0 }));
}

function resetScores(room) {
  for (const p of room.players.values()) p.score = 0;
}

// Anti-autoclicker condiviso dai giochi a tocchi ripetuti.
function tooFast(p, ms) {
  const now = Date.now();
  if (now - (p.lastTap || 0) < ms) return true;
  p.lastTap = now;
  return false;
}

// ---------------------------------------------------------------- giochi
// Ogni gioco: start / tick / input / hostView / playerView.
// `live` elenca le fasi da ritrasmettere a ogni tick (barre e countdown che scorrono).
// `hostInput` opzionale: fasi che avanzano solo quando lo decide l'host.

const GAMES = {};

// --- Quiz: le risposte giuste NON si vedono durante la partita.
//     A fine giro l'host apre il ripasso e le scorre una per una davanti alla sala.
//     Due tipi di domanda: 'scelta' (da 2 a 4 risposte, una o piu' giuste) e 'aperta'
//     (si scrive la risposta; vale se combacia con una di quelle accettate, e se non
//     ce ne sono e' un sondaggio: niente punti, si guardano solo le risposte).
//     Le domande arrivano da questions.json (per fascia d'eta') o da un quiz salvato dall'host.

// "Perche'?" e "perche" valgono uguale: minuscole, niente accenti, niente punteggiatura
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

GAMES.quiz = {
  label: 'Quiz',
  live: ['domanda'],
  levels: { bambini: 25, ragazzi: 20, adulti: 20 },

  // le domande di questions.json hanno una sola risposta giusta, come numero
  _daFile(level) {
    return shuffle(QUESTIONS[level].slice()).slice(0, 8)
      .map((d) => ({ type: 'scelta', q: d.q, o: d.o, c: [d.c], t: this.levels[level] }));
  },

  start(room, opts) {
    let qs;
    if (opts.quiz) {
      qs = opts.quiz.qs.map((d) => Object.assign({}, d));
      if (opts.quiz.shuffle) shuffle(qs);
      room.level = opts.quiz.title;
    } else {
      const level = this.levels[opts.level] ? opts.level : 'adulti';
      qs = this._daFile(level);
      room.level = level;
    }
    room.g = {
      qs,
      quizId: opts.quiz ? opts.quiz.id : null,
      title: opts.quiz ? opts.quiz.title : 'Quiz ' + room.level,
      dur: 0,
      i: -1,
      phase: 'via',
      until: Date.now() + 3000,
      t0: 0,
      ans: new Map(),
      log: [], // per ogni domanda: chi ha risposto cosa, serve al ripasso e alle statistiche
      r: -1
    };
    resetScores(room);
  },

  // true/false; null per un'aperta senza risposte accettate (sondaggio)
  giusta(q, a) {
    if (q.type === 'aperta') return q.a.length ? q.a.some((x) => norm(x) === norm(a.text)) : null;
    return sameSet(a.picks, q.c);
  },

  _chiudi(room, now) {
    const g = room.g;
    const q = g.qs[g.i];
    const risposte = new Map();
    for (const [pid, a] of g.ans) {
      const ok = this.giusta(q, a);
      const speed = 1 - clamp((a.at - g.t0) / g.dur, 0, 1);
      const pts = ok ? 500 + Math.round(500 * speed) : 0;
      const p = room.players.get(pid);
      if (p) p.score += pts;
      risposte.set(pid, Object.assign({}, a, { ok, pts, ms: a.at - g.t0 }));
    }
    const voce = { answers: risposte };
    if (q.type === 'scelta') voce.counts = q.o.map((_, k) => [...g.ans.values()].filter((a) => a.picks.includes(k)).length);
    else voce.groups = this._gruppi([...risposte.values()]);
    g.log.push(voce);
    g.phase = 'stacco';
    g.until = now + 2500;
  },

  // risposte aperte raggruppate: "Roma", "roma " e "ROMA!" diventano una voce sola
  _gruppi(list) {
    const m = new Map();
    for (const a of list) {
      const k = norm(a.text);
      const x = m.get(k) || { text: a.text, n: 0, ok: a.ok };
      x.n++;
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'ripasso' || g.phase === 'fine') return false; // da qui avanza solo l'host
    if (g.phase === 'domanda' && room.players.size > 0 && g.ans.size >= room.players.size) g.until = now;
    if (now < g.until) return false;

    if (g.phase === 'domanda') {
      this._chiudi(room, now);
      return true;
    }

    g.i++;
    if (g.i >= g.qs.length) {
      g.phase = 'ripasso';
      g.r = -1;
      return true;
    }
    g.ans = new Map();
    g.t0 = now;
    g.dur = g.qs[g.i].t * 1000;
    g.phase = 'domanda';
    g.until = now + g.dur;
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (g.phase !== 'domanda') return false;
    if (g.ans.has(p.pid)) return false;
    const q = g.qs[g.i];
    const at = Date.now();
    if (q.type === 'aperta') {
      const text = String(m.text == null ? '' : m.text).replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!text) return false;
      g.ans.set(p.pid, { text, at });
      return true;
    }
    // una giusta sola: basta un tocco. Piu' giuste: si spuntano e si conferma.
    const picks = q.c.length > 1 ? m.picks : [m.pick];
    if (!Array.isArray(picks) || !picks.length || picks.length > q.o.length) return false;
    if (!picks.every((k) => Number.isInteger(k) && k >= 0 && k < q.o.length)) return false;
    if (new Set(picks).size !== picks.length) return false;
    g.ans.set(p.pid, { picks: picks.slice().sort((a, b) => a - b), at });
    return true;
  },

  hostInput(room, m) {
    const g = room.g;
    if (m.t !== 'next' || g.phase !== 'ripasso') return false;
    g.r++;
    if (g.r >= g.qs.length) g.phase = 'fine';
    return true;
  },

  // cosa si vede di una domanda mentre si risponde: mai la soluzione
  _testo(q) {
    const v = { type: q.type, q: q.q };
    if (q.type === 'scelta') Object.assign(v, { o: q.o, multi: q.c.length > 1 ? 1 : 0 });
    return v;
  },

  _soluzione(q) {
    return q.type === 'scelta' ? { c: q.c } : { a: q.a };
  },

  hostView(room, now) {
    const g = room.g;
    if (g.phase === 'via') return { phase: g.phase, tot: g.qs.length };
    if (g.phase === 'fine') return { phase: g.phase };
    if (g.phase === 'ripasso') {
      const v = {
        phase: g.phase,
        tot: g.qs.length,
        r: g.r,
        nextLabel: g.r < 0 ? 'Mostra le risposte' : g.r >= g.qs.length - 1 ? 'Classifica' : 'Avanti'
      };
      if (g.r >= 0) {
        const q = g.qs[g.r];
        const l = g.log[g.r];
        const tutte = [...l.answers.values()];
        Object.assign(v, this._testo(q), this._soluzione(q), {
          n: g.r + 1,
          risposte: tutte.length,
          giuste: tutte.filter((a) => a.ok).length
        });
        if (q.type === 'scelta') v.counts = l.counts;
        else v.groups = l.groups.slice(0, 12);
      }
      return v;
    }
    const v = {
      phase: g.phase,
      n: g.i + 1,
      tot: g.qs.length,
      left: Math.max(0, Math.ceil((g.until - now) / 1000)),
      answered: g.ans.size,
      players: room.players.size
    };
    if (g.phase === 'domanda') Object.assign(v, this._testo(g.qs[g.i]));
    return v;
  },

  playerView(room, p, now) {
    const g = room.g;
    if (g.phase === 'via') return { phase: g.phase, tot: g.qs.length };
    if (g.phase === 'fine') return { phase: g.phase };
    if (g.phase === 'ripasso') {
      const v = { phase: g.phase, tot: g.qs.length, r: g.r };
      if (g.r >= 0) {
        const q = g.qs[g.r];
        const a = g.log[g.r].answers.get(p.pid);
        Object.assign(v, this._testo(q), this._soluzione(q), {
          n: g.r + 1,
          picks: a && a.picks ? a.picks : null,
          text: a && a.text != null ? a.text : null,
          answered: a ? 1 : 0,
          ok: a ? a.ok : null
        });
      }
      return v;
    }
    const v = { phase: g.phase, n: g.i + 1, tot: g.qs.length, left: Math.max(0, Math.ceil((g.until - now) / 1000)) };
    if (g.phase === 'domanda') {
      const a = g.ans.get(p.pid);
      Object.assign(v, this._testo(g.qs[g.i]), {
        picks: a && a.picks ? a.picks : null,
        text: a && a.text != null ? a.text : null,
        answered: a ? 1 : 0
      });
    }
    return v;
  },

  // la partita come resta nello storico dell'host: chi ha risposto cosa, e quanto ci ha messo
  report(room) {
    const g = room.g;
    // k collega le risposte al giocatore: due "Marco" in sala restano due persone diverse
    const tutti = standings(room);
    const chi = new Map(tutti.map((p, k) => [p.pid, k]));
    const players = tutti.map((p, k) => ({
      k, name: p.name, ch: p.ch, score: p.score, rank: p.rank,
      ok: g.log.filter((l) => (l.answers.get(p.pid) || {}).ok).length
    }));
    const questions = g.log.map((l, k) => {
      const q = g.qs[k];
      const answers = [...l.answers].filter(([pid]) => chi.has(pid)).map(([pid, a]) => {
        const x = { k: chi.get(pid), name: players[chi.get(pid)].name, ok: a.ok, pts: a.pts, ms: a.ms };
        if (a.picks) x.picks = a.picks; else x.text = a.text;
        return x;
      });
      const out = Object.assign({}, q, { answers });
      if (l.counts) out.counts = l.counts;
      if (l.groups) out.groups = l.groups;
      return out;
    });
    const punteggiabili = questions.filter((q) => q.type === 'scelta' || q.a.length);
    const possibili = punteggiabili.length * players.length;
    const giuste = punteggiabili.reduce((n, q) => n + q.answers.filter((a) => a.ok).length, 0);
    return {
      owner: room.user,
      quizId: g.quizId,
      title: g.title,
      date: Date.now(),
      partial: g.log.length < g.qs.length,
      avg: possibili ? Math.round((giuste / possibili) * 100) : null,
      players,
      questions
    };
  }
};

// --- Riflessi: schermo rosso, poi verde. Chi tocca prima vince. Partenza anticipata = 0.
GAMES.riflessi = {
  label: 'Riflessi',
  live: [],

  start(room) {
    room.level = null;
    room.g = { round: 0, tot: 8, phase: 'attesa', until: Date.now() + rnd(2000, 5500), go: 0, taps: new Map() };
    resetScores(room);
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;
    if (g.phase === 'verde' && room.players.size > 0 && g.taps.size >= room.players.size) g.until = now;
    if (now < g.until) return false;

    if (g.phase === 'attesa') {
      g.phase = 'verde';
      g.go = now;
      g.until = now + 3000;
      return true;
    }
    if (g.phase === 'verde') {
      const times = [...g.taps.values()].filter((t) => t.ms != null).map((t) => t.ms);
      const best = times.length ? Math.min(...times) : null;
      for (const [pid, t] of g.taps) {
        const p = room.players.get(pid);
        if (!p || t.ms == null) continue; // falsa partenza o nessun tocco: 0
        p.score += t.ms === best ? 600 : clamp(600 - Math.round((t.ms - best) / 2), 50, 600);
      }
      g.best = best;
      g.phase = 'esito';
      g.until = now + 3500;
      return true;
    }
    g.round++;
    if (g.round >= g.tot) {
      g.phase = 'fine';
      return true;
    }
    g.taps = new Map();
    g.phase = 'attesa';
    g.until = now + rnd(2000, 5500);
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (m.tap !== 1) return false;
    if (g.taps.has(p.pid)) return false;
    if (g.phase === 'attesa') {
      g.taps.set(p.pid, { ms: null, early: true });
      return true;
    }
    if (g.phase === 'verde') {
      g.taps.set(p.pid, { ms: Date.now() - g.go, early: false });
      return true;
    }
    return false;
  },

  hostView(room) {
    const g = room.g;
    const v = { phase: g.phase, n: g.round + 1, tot: g.tot };
    if (g.phase === 'esito') {
      v.best = g.best;
      v.times = [...g.taps]
        .map(([pid, t]) => ({ name: room.players.get(pid) ? room.players.get(pid).name : '?', ms: t.ms, early: t.early }))
        .sort((a, b) => (a.ms == null) - (b.ms == null) || a.ms - b.ms)
        .slice(0, 8);
    }
    return v;
  },

  playerView(room, p) {
    const g = room.g;
    const t = g.taps.get(p.pid);
    return { phase: g.phase, n: g.round + 1, tot: g.tot, ms: t ? t.ms : null, early: t ? t.early : false };
  }
};

// --- Insieme: barra collettiva che si svuota da sola. Tutti battono, la sala urla.
GAMES.insieme = {
  label: 'Insieme',
  live: ['play'],
  DECAY: 9, // punti barra persi al secondo

  start(room) {
    room.level = null;
    room.g = { round: 0, tot: 3, phase: 'play', prog: 0, target: 0, taps: new Map(), last: Date.now(), until: 0, won: false };
    resetScores(room);
    this._round(room, Date.now());
  },

  _round(room, now) {
    const g = room.g;
    g.target = Math.max(40, room.players.size * 18) * (1 + g.round * 0.6);
    g.prog = 0;
    g.taps = new Map();
    g.phase = 'play';
    g.last = now;
    g.until = now + 30000;
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;

    if (g.phase === 'play') {
      const dt = (now - g.last) / 1000;
      g.last = now;
      g.prog = Math.max(0, g.prog - this.DECAY * dt);
      if (g.prog >= g.target || now >= g.until) {
        g.won = g.prog >= g.target;
        if (g.won) {
          const max = Math.max(1, ...[...g.taps.values()]);
          for (const p of room.players.values()) {
            p.score += 250 + Math.round(350 * ((g.taps.get(p.pid) || 0) / max));
          }
        }
        g.phase = 'esito';
        g.until = now + 5000;
      }
      return true;
    }

    if (now < g.until) return false;
    g.round++;
    if (g.round >= g.tot) {
      g.phase = 'fine';
      return true;
    }
    this._round(room, now);
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (m.tap !== 1 || g.phase !== 'play') return false;
    if (tooFast(p, 50)) return false;
    g.taps.set(p.pid, (g.taps.get(p.pid) || 0) + 1);
    g.prog += 1;
    return true;
  },

  hostView(room, now) {
    const g = room.g;
    return {
      phase: g.phase,
      n: g.round + 1,
      tot: g.tot,
      pct: Math.round(clamp(g.prog / g.target, 0, 1) * 100),
      left: Math.max(0, Math.ceil((g.until - now) / 1000)),
      won: g.won
    };
  },

  playerView(room, p, now) {
    const g = room.g;
    return {
      phase: g.phase,
      n: g.round + 1,
      tot: g.tot,
      pct: Math.round(clamp(g.prog / g.target, 0, 1) * 100),
      left: Math.max(0, Math.ceil((g.until - now) / 1000)),
      taps: g.taps.get(p.pid) || 0,
      won: g.won
    };
  }
};

// --- Corsa: kart. Si avanza alternando i due pedali, sinistra-destra-sinistra.
//     Pestare sempre lo stesso pedale fa sgommare e perdere terreno.
//     Ogni 25 metri c'e' una pedana turbo. Primi tre sul podio.
GAMES.corsa = {
  label: 'Corsa',
  live: ['gara'],
  META: 100,
  TURBO: 25,
  BOOST: 6,

  start(room) {
    room.level = null;
    room.g = {
      phase: 'via',
      until: Date.now() + 3500,
      pos: new Map(),
      exp: new Map(), // pedale atteso: 0 sinistra, 1 destra
      boost: new Map(),
      fin: []
    };
    resetScores(room);
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;

    if (g.phase === 'via') {
      if (now < g.until) return false;
      g.phase = 'gara';
      g.until = now + 75000;
      return true;
    }

    const quanti = Math.min(3, Math.max(1, room.players.size));
    if (g.fin.length < quanti && now < g.until) return false;

    const podio = [1000, 700, 500];
    g.fin.forEach((pid, i) => {
      const p = room.players.get(pid);
      if (p) p.score += podio[i] != null ? podio[i] : 400;
    });
    for (const p of room.players.values()) {
      if (g.fin.includes(p.pid)) continue;
      p.score += Math.round(clamp((g.pos.get(p.pid) || 0) / this.META, 0, 1) * 350);
    }
    g.phase = 'fine';
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (g.phase !== 'gara') return false;
    if (!Number.isInteger(m.lane) || m.lane < 0 || m.lane > 1) return false;
    if (g.fin.includes(p.pid)) return false;
    if (tooFast(p, 40)) return false;

    const exp = g.exp.get(p.pid) || 0;
    if (m.lane !== exp) return false; // pedale sbagliato: sgommi sul posto
    let pos = (g.pos.get(p.pid) || 0) + 1;
    g.exp.set(p.pid, 1 - exp);
    if (Math.floor(pos / this.TURBO) > Math.floor((pos - 1) / this.TURBO)) {
      pos += this.BOOST;
      g.boost.set(p.pid, Date.now() + 1200);
    }
    g.pos.set(p.pid, pos);
    if (pos >= this.META && !g.fin.includes(p.pid)) g.fin.push(p.pid);
    return true;
  },

  hostView(room, now) {
    const g = room.g;
    const piloti = [...room.players.values()]
      .map((p) => ({
        name: p.name,
        ch: p.ch,
        pct: Math.round(clamp((g.pos.get(p.pid) || 0) / this.META, 0, 1) * 100),
        turbo: (g.boost.get(p.pid) || 0) > now ? 1 : 0,
        fin: g.fin.indexOf(p.pid)
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 10);
    return {
      phase: g.phase,
      piloti,
      left: Math.max(0, Math.ceil((g.until - now) / 1000)),
      fin: g.fin.map((pid) => (room.players.get(pid) ? room.players.get(pid).name : '?'))
    };
  },

  playerView(room, p, now) {
    const g = room.g;
    const pos = g.pos.get(p.pid) || 0;
    const tutti = [...room.players.values()].map((x) => g.pos.get(x.pid) || 0).sort((a, b) => b - a);
    return {
      phase: g.phase,
      pct: Math.round(clamp(pos / this.META, 0, 1) * 100),
      exp: g.exp.get(p.pid) || 0,
      turbo: (g.boost.get(p.pid) || 0) > now ? 1 : 0,
      rank: tutti.indexOf(pos) + 1,
      of: tutti.length,
      fin: g.fin.indexOf(p.pid)
    };
  }
};

// --- Salta: ostacoli a tempo. Quello a terra si scavalca, quello in alto va schivato
//     restando giu'. Chi sbaglia esce. Vince chi resta in pista piu' a lungo.
GAMES.salto = {
  label: 'Salta',
  // Niente fase "live": telefono e schermo animano da soli tra un ostacolo e l'altro,
  // quindi si trasmette solo quando un ostacolo si risolve. Meno traffico e soprattutto
  // niente scatti da 150 millisecondi.
  live: [],
  TOT: 34,
  AIR: 600,  // quanto resti per aria dopo il tocco: corto, cosi' il salto e' scattante
  VITE: 3,   // tre errori prima di uscire: cosi' si gioca fino in fondo, non 20 secondi

  gap(beat) {
    return Math.max(1000, 2000 - beat * 100);
  },

  start(room) {
    room.level = null;
    room.g = { phase: 'via', until: Date.now() + 3500, beat: 0, tipo: 0, next: 0, vite: new Map(), aria: new Map(), fuori: new Map() };
    resetScores(room);
    for (const p of room.players.values()) room.g.vite.set(p.pid, this.VITE);
  },

  _vivi(g) {
    let n = 0;
    for (const v of g.vite.values()) if (v > 0) n++;
    return n;
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;

    if (g.phase === 'via') {
      if (now < g.until) return false;
      g.phase = 'corsa';
      g.tipo = Math.random() < 0.5 ? 0 : 1;
      g.next = now + 2000;
      return true;
    }

    if (now < g.next) return false;

    // arriva l'ostacolo: chi e' nello stato sbagliato perde una vita
    for (const [pid, vite] of g.vite) {
      if (vite <= 0) continue;
      const p = room.players.get(pid);
      const inAria = (g.aria.get(pid) || 0) > now;
      const salvo = g.tipo === 0 ? inAria : !inAria;
      if (salvo) {
        if (p) p.score += 100;
      } else {
        g.vite.set(pid, vite - 1);
        if (vite - 1 <= 0) g.fuori.set(pid, g.beat + 1);
      }
    }
    g.beat++;

    if (g.beat >= this.TOT || this._vivi(g) === 0) {
      for (const [pid, vite] of g.vite) {
        const p = room.players.get(pid);
        if (vite > 0 && p) p.score += 200 * vite; // bonus finale, piu' alto se arrivi intatto
      }
      g.phase = 'fine';
      return true;
    }
    g.tipo = Math.random() < 0.5 ? 0 : 1;
    g.next = now + this.gap(g.beat);
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (m.tap !== 1 || g.phase !== 'corsa') return false;
    if ((g.vite.get(p.pid) || 0) <= 0) return false;
    const now = Date.now();
    if ((g.aria.get(p.pid) || 0) > now) return false; // gia' per aria
    g.aria.set(p.pid, now + this.AIR);
    return false; // il salto si vede subito sul telefono: non serve ritrasmettere a tutti
  },

  hostView(room, now) {
    const g = room.g;
    const vivi = [...g.vite].filter(([, v]) => v > 0);
    return {
      phase: g.phase,
      beat: g.beat + 1,
      tot: this.TOT,
      tipo: g.tipo,
      into: Math.max(0, g.next - now),
      gap: this.gap(g.beat),
      vivi: vivi.length,
      nomi: vivi.slice(0, 14).map(([pid, v]) => {
        const p = room.players.get(pid);
        return { ch: p ? p.ch : 'X', name: p ? p.name : '?', vite: v };
      })
    };
  },

  playerView(room, p, now) {
    const g = room.g;
    const vite = g.vite.get(p.pid);
    return {
      phase: g.phase,
      beat: g.beat + 1,
      tot: this.TOT,
      tipo: g.tipo,
      into: Math.max(0, g.next - now),
      gap: this.gap(g.beat),
      airMs: this.AIR,
      vite: vite == null ? null : vite,
      viteMax: this.VITE,
      vivi: this._vivi(g),
      stato: vite == null ? 'spettatore' : vite > 0 ? 'vivo' : 'fuori',
      fuoriAl: g.fuori.get(p.pid) || null,
      aria: (g.aria.get(p.pid) || 0) > now ? 1 : 0
    };
  }
};

// --- Raccogli: il Token Rush della sala. Cadono oggetti su tre corsie, sposti il
//     cestino e prendi quelli buoni evitando i bug. Combo che cresce, tre vite.
//     A differenza dell'originale a schermo singolo le cadute le decide il server:
//     con i premi in palio il punteggio non puo' arrivare dal telefono.
GAMES.rush = {
  label: 'Raccogli',
  live: [],
  CORSIE: 3,
  TOT: 20,
  VITE: 3,
  COMBO_MAX: 5,
  OGGETTI: [
    { e: '🟢', p: 10, w: 50 },
    { e: '📝', p: 25, w: 14 },
    { e: '💎', p: 50, w: 8 },
    { e: '🐛', p: 0, w: 22, bug: true }
  ],

  gap(beat) {
    return Math.max(750, 1800 - beat * 70);
  },

  // Una corsia sola occupata rendeva il gioco gratis: bastava scansarsi e non si
  // perdeva mai una vita. Ora cade qualcosa in ogni corsia e bisogna scegliere,
  // ma almeno una e' sempre sicura: non si muore per sfortuna.
  _pescaCorsie() {
    const c = [];
    for (let i = 0; i < this.CORSIE; i++) c.push(this._pesca());
    if (c.every((o) => o.bug)) c[(Math.random() * this.CORSIE) | 0] = this.OGGETTI[0];
    return c;
  },

  _pesca() {
    const tot = this.OGGETTI.reduce((n, o) => n + o.w, 0);
    let r = Math.random() * tot;
    for (const o of this.OGGETTI) {
      r -= o.w;
      if (r <= 0) return o;
    }
    return this.OGGETTI[0];
  },

  _vivi(g) {
    let n = 0;
    for (const v of g.vite.values()) if (v > 0) n++;
    return n;
  },

  start(room) {
    room.level = null;
    room.g = {
      phase: 'via',
      until: Date.now() + 3500,
      beat: 0,
      caduta: [this.OGGETTI[0], this.OGGETTI[0], this.OGGETTI[0]],
      next: 0,
      cesto: new Map(), // corsia scelta da ogni giocatore
      vite: new Map(),
      combo: new Map(),
      preso: new Map(), // esito dell'ultimo oggetto, per il riscontro sul telefono
      fuori: new Map()
    };
    resetScores(room);
    for (const p of room.players.values()) {
      room.g.vite.set(p.pid, this.VITE);
      room.g.combo.set(p.pid, 1);
      room.g.cesto.set(p.pid, 1);
    }
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;

    if (g.phase === 'via') {
      if (now < g.until) return false;
      g.phase = 'gioco';
      g.caduta = this._pescaCorsie();
      g.next = now + 1800;
      return true;
    }

    if (now < g.next) return false;

    for (const [pid, vite] of g.vite) {
      if (vite <= 0) continue;
      const p = room.players.get(pid);
      const sotto = g.caduta[g.cesto.get(pid) || 0];
      if (sotto.bug) {
        g.vite.set(pid, vite - 1);
        g.combo.set(pid, 1);
        g.preso.set(pid, 'bug');
        if (vite - 1 <= 0) g.fuori.set(pid, g.beat + 1);
      } else {
        const combo = g.combo.get(pid) || 1;
        if (p) p.score += sotto.p * combo;
        g.combo.set(pid, Math.min(this.COMBO_MAX, combo + 1));
        g.preso.set(pid, 'preso');
      }
    }
    g.beat++;

    if (g.beat >= this.TOT || this._vivi(g) === 0) {
      for (const [pid, vite] of g.vite) {
        const p = room.players.get(pid);
        if (vite > 0 && p) p.score += 150 * vite;
      }
      g.phase = 'fine';
      return true;
    }
    g.caduta = this._pescaCorsie();
    g.next = now + this.gap(g.beat);
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (g.phase !== 'gioco') return false;
    if (!Number.isInteger(m.lane) || m.lane < 0 || m.lane >= this.CORSIE) return false;
    if ((g.vite.get(p.pid) || 0) <= 0) return false;
    g.cesto.set(p.pid, m.lane);
    return false; // il cestino si sposta subito sul telefono: non serve ritrasmettere
  },

  hostView(room, now) {
    const g = room.g;
    const vivi = [...g.vite].filter(([, v]) => v > 0);
    return {
      phase: g.phase,
      beat: g.beat + 1,
      tot: this.TOT,
      caduta: g.caduta.map((o) => ({ e: o.e, bug: o.bug ? 1 : 0, p: o.p })),
      corsie: this.CORSIE,
      into: Math.max(0, g.next - now),
      gap: this.gap(g.beat),
      vivi: vivi.length,
      nomi: vivi.slice(0, 14).map(([pid, v]) => {
        const p = room.players.get(pid);
        return { ch: p ? p.ch : 'X', name: p ? p.name : '?', vite: v, combo: g.combo.get(pid) || 1 };
      })
    };
  },

  playerView(room, p, now) {
    const g = room.g;
    const vite = g.vite.get(p.pid);
    return {
      phase: g.phase,
      beat: g.beat + 1,
      tot: this.TOT,
      caduta: g.caduta.map((o) => ({ e: o.e, bug: o.bug ? 1 : 0, p: o.p })),
      corsie: this.CORSIE,
      into: Math.max(0, g.next - now),
      gap: this.gap(g.beat),
      cesto: g.cesto.get(p.pid) || 0,
      combo: g.combo.get(p.pid) || 1,
      vite: vite == null ? null : vite,
      viteMax: this.VITE,
      esito: g.preso.get(p.pid) || null,
      vivi: this._vivi(g),
      stato: vite == null ? 'spettatore' : vite > 0 ? 'vivo' : 'fuori',
      fuoriAl: g.fuori.get(p.pid) || null
    };
  }
};

// --- Stop: il cronometro parte, dopo 3 secondi sparisce. Bisogna fermarlo al secondo
//     giusto contando a mente. Chi ci arriva piu' vicino prende di piu'.
GAMES.stop = {
  label: 'Stop',
  live: [], // il cronometro lo fa girare il browser, il server manda solo quanto e' passato
  TOT: 5,
  SHOW: 3000, // per quanto si vede il cronometro prima di sparire

  punti(diff) {
    const d = Math.abs(diff);
    return clamp(600 - Math.round(d / 4), 0, 600) + (d <= 50 ? 200 : 0); // +200 al colpo perfetto
  },

  start(room) {
    room.level = null;
    room.g = { round: 0, tot: this.TOT, phase: 'via', until: Date.now() + 3000, t0: 0, target: 0, stop: new Map() };
    resetScores(room);
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;
    if (g.phase === 'conta' && room.players.size > 0 && g.stop.size >= room.players.size) g.until = now;
    if (now < g.until) return false;

    if (g.phase === 'conta') {
      for (const [pid, ms] of g.stop) {
        const p = room.players.get(pid);
        if (p) p.score += this.punti(ms - g.target);
      }
      g.phase = 'esito';
      g.until = now + 4500;
      return true;
    }
    if (g.phase === 'esito' && ++g.round >= g.tot) {
      g.phase = 'fine';
      return true;
    }
    g.target = (5 + ((Math.random() * 6) | 0)) * 1000; // da 5 a 10 secondi tondi
    g.stop = new Map();
    g.t0 = now;
    g.phase = 'conta';
    g.until = now + g.target + 4000;
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (m.tap !== 1 || g.phase !== 'conta' || g.stop.has(p.pid)) return false;
    g.stop.set(p.pid, Date.now() - g.t0);
    return true;
  },

  hostView(room, now) {
    const g = room.g;
    const v = { phase: g.phase, n: g.round + 1, tot: g.tot, target: g.target, el: now - g.t0, show: this.SHOW,
      fermi: g.stop.size, players: room.players.size };
    if (g.phase === 'esito') {
      v.top = [...g.stop]
        .map(([pid, ms]) => ({ name: room.players.get(pid) ? room.players.get(pid).name : '?', ms, diff: ms - g.target }))
        .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))
        .slice(0, 8);
    }
    return v;
  },

  playerView(room, p, now) {
    const g = room.g;
    const ms = g.stop.get(p.pid);
    const v = { phase: g.phase, n: g.round + 1, tot: g.tot, target: g.target, el: now - g.t0, show: this.SHOW,
      fermo: ms != null ? 1 : 0 };
    // il tempo fatto si svela solo a round chiuso: nessun indizio durante il conteggio
    if (g.phase === 'esito') Object.assign(v, { ms: ms == null ? null : ms, diff: ms == null ? null : ms - g.target,
      pts: ms == null ? 0 : this.punti(ms - g.target) });
    return v;
  }
};

// --- Colori: la parola ROSSO scritta in blu. Si tocca il colore dell'inchiostro, o la
//     parola, a seconda di cosa chiede il round. Il cervello si inceppa, la sala ride.
GAMES.colori = {
  label: 'Colori',
  live: [],
  TOT: 10,
  NOMI: ['ROSSO', 'BLU', 'GIALLO', 'VERDE'], // stesso ordine dei colori --a --b --c --d

  dur(i) {
    return Math.max(2200, 4000 - i * 200);
  },

  start(room) {
    room.level = null;
    room.g = { i: -1, tot: this.TOT, phase: 'via', until: Date.now() + 3000, t0: 0, parola: 0, ink: 0, chiedi: 'colore', ans: new Map() };
    resetScores(room);
  },

  giusta(g) {
    return g.chiedi === 'colore' ? g.ink : g.parola;
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;
    if (g.phase === 'domanda' && room.players.size > 0 && g.ans.size >= room.players.size) g.until = now;
    if (now < g.until) return false;

    if (g.phase === 'domanda') {
      const ok = this.giusta(g);
      const dur = this.dur(g.i);
      for (const [pid, a] of g.ans) {
        const p = room.players.get(pid);
        if (p && a.pick === ok) p.score += 300 + Math.round(300 * (1 - clamp((a.at - g.t0) / dur, 0, 1)));
      }
      g.phase = 'stacco';
      g.until = now + 1500;
      return true;
    }

    if (++g.i >= g.tot) {
      g.phase = 'fine';
      return true;
    }
    g.parola = (Math.random() * 4) | 0;
    g.ink = (g.parola + 1 + ((Math.random() * 3) | 0)) % 4; // mai lo stesso colore della parola
    g.chiedi = g.i < 3 || Math.random() < 0.6 ? 'colore' : 'parola'; // i primi tre per imparare
    g.ans = new Map();
    g.t0 = now;
    g.phase = 'domanda';
    g.until = now + this.dur(g.i);
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (g.phase !== 'domanda' || g.ans.has(p.pid)) return false;
    if (!Number.isInteger(m.pick) || m.pick < 0 || m.pick > 3) return false;
    g.ans.set(p.pid, { pick: m.pick, at: Date.now() });
    return true;
  },

  _vista(g, now) {
    return { phase: g.phase, n: g.i + 1, tot: g.tot, parola: this.NOMI[g.parola], ink: g.ink, chiedi: g.chiedi,
      into: Math.max(0, g.until - now), gap: this.dur(Math.max(0, g.i)) };
  },

  hostView(room, now) {
    const g = room.g;
    const v = Object.assign(this._vista(g, now), { answered: g.ans.size, players: room.players.size });
    if (g.phase === 'stacco') {
      v.giusta = this.giusta(g);
      v.bravi = [...g.ans.values()].filter((a) => a.pick === v.giusta).length;
    }
    return v;
  },

  playerView(room, p, now) {
    const g = room.g;
    const a = g.ans.get(p.pid);
    const v = Object.assign(this._vista(g, now), { pick: a ? a.pick : null });
    if (g.phase === 'stacco') v.ok = a ? a.pick === this.giusta(g) : null;
    return v;
  }
};

// --- Come la sala: pizza o sushi? Non conta cosa preferisci tu, conta indovinare cosa
//     sceglie la maggioranza. Si vota, poi lo schermo mostra come si e' divisa la sala.
GAMES.sala = {
  label: 'Come la sala',
  live: ['voto'],
  TOT: 6,
  DUR: 10000,

  start(room) {
    room.level = null;
    room.g = { i: -1, qs: shuffle(QUESTIONS.dilemmi.slice()).slice(0, this.TOT), phase: 'via', until: Date.now() + 3000,
      voti: new Map(), conta: [0, 0], vince: [] };
    resetScores(room);
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;
    if (g.phase === 'voto' && room.players.size > 0 && g.voti.size >= room.players.size) g.until = now;
    if (now < g.until) return false;

    if (g.phase === 'voto') {
      g.conta = [0, 1].map((k) => [...g.voti.values()].filter((x) => x === k).length);
      const max = Math.max(...g.conta);
      g.vince = max ? [0, 1].filter((k) => g.conta[k] === max) : [];
      const premio = g.vince.length === 2 ? 250 : 500; // pareggio: mezzo premio a tutti
      for (const [pid, k] of g.voti) {
        const p = room.players.get(pid);
        if (p && g.vince.includes(k)) p.score += premio;
      }
      g.phase = 'esito';
      g.until = now + 5000;
      return true;
    }

    if (++g.i >= g.qs.length) {
      g.phase = 'fine';
      return true;
    }
    g.voti = new Map();
    g.phase = 'voto';
    g.until = now + this.DUR;
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (g.phase !== 'voto' || g.voti.has(p.pid)) return false;
    if (m.pick !== 0 && m.pick !== 1) return false;
    g.voti.set(p.pid, m.pick);
    return true;
  },

  _vista(g, now) {
    const v = { phase: g.phase, n: g.i + 1, tot: g.qs.length, left: Math.max(0, Math.ceil((g.until - now) / 1000)) };
    if (g.phase === 'voto' || g.phase === 'esito') v.o = g.qs[g.i];
    if (g.phase === 'esito') Object.assign(v, { conta: g.conta, vince: g.vince });
    return v;
  },

  hostView(room, now) {
    return Object.assign(this._vista(room.g, now), { votati: room.g.voti.size, players: room.players.size });
  },

  playerView(room, p, now) {
    const k = room.g.voti.get(p.pid);
    return Object.assign(this._vista(room.g, now), { pick: k == null ? null : k });
  }
};

// ---------------------------------------------------------------- stato

function hostState(room, now) {
  return {
    t: 'host',
    code: room.code,
    url: room.url,
    qr: room.qr,
    game: room.game,
    gameLabel: room.game ? GAMES[room.game].label : null,
    level: room.level,
    user: room.user || null,
    nplus: room.nplus ? 1 : 0,
    players: standings(room),
    view: room.game ? GAMES[room.game].hostView(room, now) : null
  };
}

function playerState(room, p, now) {
  const all = standings(room);
  const me = all.find((x) => x.pid === p.pid);
  return {
    t: 'you',
    code: room.code,
    name: p.name,
    ch: p.ch,
    score: me ? me.score : 0,
    rank: me ? me.rank : 0,
    of: all.length,
    game: room.game,
    gameLabel: room.game ? GAMES[room.game].label : null,
    top: all.slice(0, 5),
    nplus: room.nplus ? NPLUS_URL : null,
    view: room.game ? GAMES[room.game].playerView(room, p, now) : null
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function push(room) {
  const now = Date.now();
  send(room.host, hostState(room, now));
  for (const p of room.players.values()) send(p.ws, playerState(room, p, now));
}

// ---------------------------------------------------------------- server

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---------------------------------------------------------------- account e quiz salvati
// Solo l'host ha un account: chi gioca dal telefono continua a entrare con nome e codice.

const api = express.Router();
const jsonPiccolo = express.json({ limit: '512kb' });
api.use((req, res, next) => (req.path === '/backup' ? next() : jsonPiccolo(req, res, next)));

// SIGNUP=chiusa: si registra solo il primo account, poi la porta si chiude.
// Utile online, dove chiunque trovi l'indirizzo potrebbe crearsi un account.
const signupOpen = () => process.env.SIGNUP !== 'chiusa' || store.userCount() === 0;

// tentativi di login sbagliati per IP: dieci ogni dieci minuti, poi si aspetta
const tentativi = new Map();
function troppiTentativi(ip) {
  const now = Date.now();
  const t = (tentativi.get(ip) || []).filter((x) => now - x < 10 * 60 * 1000);
  tentativi.set(ip, t);
  return t.length >= 10;
}

function setSession(req, res, user) {
  const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(store.makeToken(user))}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${store.SESSION_DAYS * 86400}${secure}`);
}

api.use((req, _res, next) => {
  req.user = store.userFromCookie(req.headers.cookie);
  next();
});

const auth = (req, res, next) => (req.user ? next() : res.status(401).json({ err: 'Devi accedere' }));

api.get('/me', (req, res) => res.json({ user: req.user, signup: signupOpen() }));

api.post('/register', (req, res) => {
  if (!signupOpen()) return res.status(403).json({ err: 'Le registrazioni sono chiuse' });
  const r = store.register(req.body.user, req.body.pass);
  if (r.err) return res.status(400).json(r);
  setSession(req, res, r.user);
  res.json({ user: r.user });
});

api.post('/login', (req, res) => {
  if (troppiTentativi(req.ip)) return res.status(429).json({ err: 'Troppi tentativi, riprova tra qualche minuto' });
  const user = store.checkLogin(req.body.user, req.body.pass);
  if (!user) {
    tentativi.get(req.ip).push(Date.now());
    return res.status(401).json({ err: 'Nome utente o password sbagliati' });
  }
  setSession(req, res, user);
  res.json({ user });
});

api.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

api.get('/quizzes', auth, (req, res) => res.json(store.listQuizzes(req.user)));

api.get('/quizzes/:id', auth, (req, res) => {
  const q = store.getQuiz(req.user, req.params.id);
  q ? res.json(q) : res.status(404).json({ err: 'Quiz non trovato' });
});

api.post('/quizzes', auth, (req, res) => {
  const r = store.saveQuiz(req.user, null, req.body);
  r.err ? res.status(400).json(r) : res.json(r.quiz);
});

api.put('/quizzes/:id', auth, (req, res) => {
  const r = store.saveQuiz(req.user, req.params.id, req.body);
  r.err ? res.status(400).json(r) : res.json(r.quiz);
});

api.delete('/quizzes/:id', auth, (req, res) => res.json({ ok: store.deleteQuiz(req.user, req.params.id) }));

api.get('/results', auth, (req, res) => res.json(store.listResults(req.user, req.query.quiz)));

api.get('/results/:id', auth, (req, res) => {
  const r = store.getResult(req.user, req.params.id);
  r ? res.json(r) : res.status(404).json({ err: 'Risultato non trovato' });
});

api.delete('/results/:id', auth, (req, res) => res.json({ ok: store.deleteResult(req.user, req.params.id) }));

api.get('/backup', auth, (req, res) => {
  const giorno = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="pausa-game-${req.user}-${giorno}.json"`);
  res.json(store.exportAccount(req.user));
});

// un backup con tanti risultati pesa: qui il limite e' piu' largo che per un quiz solo
api.post('/backup', auth, express.json({ limit: '20mb' }), (req, res) => {
  const r = store.importAccount(req.user, req.body);
  r.err ? res.status(400).json(r) : res.json(r);
});

// ---------------------------------------------------------------- quiz con l'IA (Gemini, piano gratuito)
// Chiave da https://aistudio.google.com/apikey in GEMINI_API_KEY. Senza chiave il bottone nell'editor sparisce.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    desc: { type: 'STRING' },
    qs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['scelta', 'aperta'] },
          q: { type: 'STRING' },
          o: { type: 'ARRAY', items: { type: 'STRING' } },
          c: { type: 'ARRAY', items: { type: 'INTEGER' } },
          a: { type: 'ARRAY', items: { type: 'STRING' } },
          t: { type: 'INTEGER' }
        },
        required: ['type', 'q', 't']
      }
    }
  },
  required: ['title', 'qs']
};
const AI_REGOLE = `Sei l'autore di quiz per giochi da telefono in sala (stile Kahoot), in italiano salvo richiesta diversa.
Formato di ogni domanda:
- type "scelta": "o" da 2 a 4 risposte brevi (max 80 caratteri), "c" gli indici (da 0) delle risposte giuste, di solito una sola.
  Vero o falso = scelta con o ["Vero","Falso"].
- type "aperta": "a" le risposte accettate (sinonimi e grafie alternative); "a" vuoto = sondaggio senza punti.
- "q" massimo 200 caratteri, "t" secondi per rispondere tra ${store.TEMPI.join(', ')} (di solito 20).
Massimo 100 domande. Fatti corretti e verificabili, risposte sbagliate plausibili, giuste in posizioni varie.`;

// ponytail: limite in memoria per account, si azzera al riavvio; basta a non bruciare la quota gratuita
const aiUso = new Map();
function aiTroppe(user) {
  const now = Date.now();
  const t = (aiUso.get(user) || []).filter((x) => now - x < 60 * 60 * 1000);
  aiUso.set(user, t);
  if (t.length >= 30) return true;
  t.push(now);
  return false;
}

api.get('/ai', auth, (_req, res) => res.json({ on: !!process.env.GEMINI_API_KEY }));

// { prompt, quiz? }: senza quiz ne crea uno nuovo, con il quiz lo modifica seguendo il prompt
api.post('/ai/quiz', auth, async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ err: 'IA non configurata: manca GEMINI_API_KEY' });
  const prompt = String(req.body.prompt || '').trim().slice(0, 2000);
  if (!prompt) return res.status(400).json({ err: 'Scrivi cosa vuoi' });
  if (aiTroppe(req.user)) return res.status(429).json({ err: 'Troppe richieste, riprova tra un po\'' });
  // un quiz a meta' (senza titolo, risposte vuote) non passa cleanQuiz ma va modificato lo stesso
  const quiz = req.body.quiz && (store.cleanQuiz(req.body.quiz).quiz || req.body.quiz);
  const testo = quiz
    ? `Quiz attuale:\n${JSON.stringify(quiz).slice(0, 100000)}\n\nModificalo cosi': ${prompt}\nRestituisci il quiz completo aggiornato; lascia invariato quello che la richiesta non tocca.`
    : `Crea un quiz: ${prompt}\nSe il numero di domande non e' indicato, fanne 10.`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: AI_REGOLE }] },
        contents: [{ role: 'user', parts: [{ text: testo }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: AI_SCHEMA }
      }),
      signal: AbortSignal.timeout(90000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Gemini:', r.status, j.error && j.error.message);
      return res.status(502).json({ err: r.status === 429 ? 'Quota gratuita di Gemini finita, riprova piu\' tardi' : 'Gemini non ha risposto bene' });
    }
    const out = j.candidates && j.candidates[0] && j.candidates[0].content;
    const raw = JSON.parse(((out && out.parts) || []).map((p) => p.text || '').join('') || 'null');
    const pulito = store.cleanQuiz(raw);
    if (pulito.err) return res.status(502).json({ err: 'L\'IA ha prodotto un quiz non valido (' + pulito.err + '), riprova' });
    res.json(pulito.quiz);
  } catch (e) {
    console.error('Gemini:', e.message);
    res.status(502).json({ err: 'Gemini non raggiungibile, riprova' });
  }
});

app.use('/api', api);

// Una partita a quiz finisce nello storico dell'host che ha fatto l'accesso.
// Una volta sola: alla fine delle domande, o a "Termina" se si e' interrotto prima.
function salvaQuiz(room) {
  const g = room.g;
  if (room.game !== 'quiz' || !room.user || g.saved || !g.log || !g.log.length) return;
  g.saved = true;
  try {
    store.addResult(GAMES.quiz.report(room));
  } catch (e) {
    console.error('Salvataggio risultati non riuscito:', e.message);
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.room = null;
  ws.user = store.userFromCookie(req.headers.cookie); // l'host che ha fatto l'accesso, se c'e'

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const room = ws.room ? rooms.get(ws.room) : null;
    if (room) room.seen = Date.now();

    // server riavviato: la vecchia stanza non c'e' piu', apri direttamente una nuova.
    // Stessa cosa se la stanza era di un altro account: i suoi risultati restano suoi.
    if (m.t === 'rehost' && (!rooms.has(m.code) || (rooms.get(m.code).user && rooms.get(m.code).user !== ws.user))) m.t = 'host';

    // --- host apre la stanza
    if (m.t === 'host') {
      const code = newCode();
      const url = `${publicUrl(req)}/?r=${code}`;
      const r = {
        code,
        url,
        qr: await QRCode.toDataURL(url, { margin: 1, width: 560, color: { dark: '#0b1020', light: '#ffffff' } }),
        host: ws,
        user: ws.user,
        players: new Map(),
        game: null,
        level: null,
        g: {},
        dirty: true,
        seen: Date.now()
      };
      rooms.set(code, r);
      ws.role = 'host';
      ws.room = code;
      push(r);
      return;
    }

    // --- host riaggancia una stanza esistente (refresh della pagina)
    if (m.t === 'rehost' && rooms.has(m.code)) {
      const r = rooms.get(m.code);
      r.host = ws;
      if (ws.user) r.user = ws.user; // accesso fatto dopo aver aperto la stanza
      ws.role = 'host';
      ws.room = m.code;
      push(r);
      return;
    }

    // --- giocatore entra (o rientra dopo blocco schermo)
    if (m.t === 'join') {
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: 'Codice non valido' });
      const name = String(m.name || '').trim().slice(0, 14) || 'Anonimo';
      let p = m.pid && r.players.get(m.pid);
      if (p) {
        p.ws = ws;
        p.name = name;
      } else {
        if (r.players.size >= 300) return send(ws, { t: 'err', msg: 'Stanza piena' });
        const presi = new Set([...r.players.values()].map((x) => x.ch));
        const liberi = PERSONAGGI.filter((c) => !presi.has(c));
        const ch = (liberi.length ? liberi : PERSONAGGI)[(Math.random() * (liberi.length || PERSONAGGI.length)) | 0];
        p = { pid: Math.random().toString(36).slice(2, 10), name, ch, score: 0, ws, lastTap: 0 };
        r.players.set(p.pid, p);
      }
      ws.role = 'player';
      ws.room = r.code;
      ws.pid = p.pid;
      send(ws, { t: 'joined', pid: p.pid, code: r.code });
      r.dirty = true;
      return;
    }

    if (!room) return;

    // --- comandi host
    if (ws.role === 'host') {
      if (m.t === 'start' && GAMES[m.game]) {
        const opts = { level: m.level };
        if (m.game === 'quiz' && m.quiz) {
          opts.quiz = ws.user && store.getQuiz(ws.user, String(m.quiz));
          if (!opts.quiz) return send(ws, { t: 'err', msg: 'Quiz non trovato: rifai l\'accesso' });
        }
        salvaQuiz(room);
        room.game = m.game;
        GAMES[m.game].start(room, opts);
        room.dirty = true;
      }
      if (m.t === 'stop') {
        salvaQuiz(room);
        room.game = null;
        room.level = null;
        room.g = {};
        room.dirty = true;
      }
      if (m.t === 'next' && room.game && GAMES[room.game].hostInput) {
        if (GAMES[room.game].hostInput(room, m)) room.dirty = true;
      }
      if (m.t === 'nplus') {
        room.nplus = !room.nplus;
        room.dirty = true;
      }
      if (m.t === 'kick') {
        room.players.delete(m.pid);
        room.dirty = true;
      }
      return;
    }

    // --- input giocatore
    if (ws.role === 'player') {
      const p = room.players.get(ws.pid);
      if (!p) return;
      // errore JavaScript sul telefono: solo i primi 5 per giocatore, cosi' nessuno inonda il log
      if (m.t === 'bug') {
        p.bugs = (p.bugs || 0) + 1;
        if (p.bugs <= 5) console.log(`[telefono ${p.name}, ${room.game || 'attesa'}] ${String(m.msg).slice(0, 200)}`);
        return;
      }
      // cambio personaggio: solo in sala d'attesa, cosi' nessuno ci gioca a partita in corso
      if (m.t === 'skin' && !room.game) {
        p.ch = PERSONAGGI[(PERSONAGGI.indexOf(p.ch) + 1) % PERSONAGGI.length];
        room.dirty = true;
        return;
      }
      if (room.game && GAMES[room.game].input(room, p, m)) room.dirty = true;
    }
  });

  ws.on('close', () => {
    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room) return;
    if (ws.role === 'host' && room.host === ws) room.host = null;
    if (ws.role === 'player') {
      const p = room.players.get(ws.pid);
      if (p && p.ws === ws) p.ws = null; // resta in classifica, puo' rientrare
      room.dirty = true;
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.game) {
      const G = GAMES[room.game];
      if (G.tick(room, now)) room.dirty = true;
      if (room.game === 'quiz' && room.g.phase === 'ripasso') salvaQuiz(room);
      if (G.live.includes(room.g.phase)) room.dirty = true; // countdown e barre che scorrono
    }
    if (room.dirty) {
      room.dirty = false;
      push(room);
    }
    if (now - room.seen > ROOM_TTL) rooms.delete(room.code);
  }
}, TICK_MS);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  wss.on('error', (e) => { // ws rilancia qui gli errori di listen del server http
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`\n  La porta ${port} e' occupata: c'e' gia' un Pausa Game acceso, probabilmente una versione vecchia.`);
    console.error(`  Chiudi la finestra "Pausa Game - server" e rilancia avvia.bat.\n`);
    process.exit(1);
  });
  server.listen(port, () => console.log(`Pausa Game su http://localhost:${port}  (schermo: /host)`));
}

module.exports = { GAMES, rooms, standings, PERSONAGGI, app };
