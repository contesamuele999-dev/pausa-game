'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const QUESTIONS = require('./questions.json');

const TICK_MS = 150;
const ROOM_TTL = 3 * 60 * 60 * 1000;
const ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ2345679'; // niente 0/O/1/I/B/8: si leggono male da lontano

// Il personaggio con cui si gioca. Niente immagini da caricare: sono emoji, si vedono
// su qualsiasi telefono e restano nitide proiettate.
const PERSONAGGI = ['🦊','🐼','🐸','🐵','🐙','🦄','🐯','🐨','🦁','🐧','🐢','🦖','🐝','🦉','🐬','🦩','🐳','🦔','🐰','🐻'];

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
GAMES.quiz = {
  label: 'Quiz',
  live: ['domanda'],
  levels: { bambini: 25, ragazzi: 20, adulti: 20 },

  start(room, opts) {
    const level = this.levels[opts.level] ? opts.level : 'adulti';
    const pool = shuffle(QUESTIONS[level].slice());
    room.level = level;
    room.g = {
      qs: pool.slice(0, Math.min(8, pool.length)),
      dur: this.levels[level] * 1000,
      i: -1,
      phase: 'via',
      until: Date.now() + 3000,
      t0: 0,
      ans: new Map(),
      log: [], // per ogni domanda: chi ha scelto cosa, serve al ripasso finale
      r: -1
    };
    resetScores(room);
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'ripasso' || g.phase === 'fine') return false; // da qui avanza solo l'host
    if (g.phase === 'domanda' && room.players.size > 0 && g.ans.size >= room.players.size) g.until = now;
    if (now < g.until) return false;

    if (g.phase === 'domanda') {
      const q = g.qs[g.i];
      for (const [pid, a] of g.ans) {
        const p = room.players.get(pid);
        if (!p || a.pick !== q.c) continue;
        const speed = 1 - clamp((a.at - g.t0) / g.dur, 0, 1);
        p.score += 500 + Math.round(500 * speed);
      }
      g.log.push({
        picks: new Map([...g.ans].map(([pid, a]) => [pid, a.pick])),
        counts: q.o.map((_, k) => [...g.ans.values()].filter((a) => a.pick === k).length)
      });
      g.phase = 'stacco';
      g.until = now + 2500;
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
    g.phase = 'domanda';
    g.until = now + g.dur;
    return true;
  },

  input(room, p, m) {
    const g = room.g;
    if (g.phase !== 'domanda') return false;
    if (g.ans.has(p.pid)) return false;
    const q = g.qs[g.i];
    if (!Number.isInteger(m.pick) || m.pick < 0 || m.pick >= q.o.length) return false;
    g.ans.set(p.pid, { pick: m.pick, at: Date.now() });
    return true;
  },

  hostInput(room, m) {
    const g = room.g;
    if (m.t !== 'next' || g.phase !== 'ripasso') return false;
    g.r++;
    if (g.r >= g.qs.length) g.phase = 'fine';
    return true;
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
        Object.assign(v, { n: g.r + 1, q: q.q, o: q.o, c: q.c, counts: g.log[g.r].counts });
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
    if (g.phase === 'domanda') {
      const q = g.qs[g.i];
      v.q = q.q;
      v.o = q.o;
    }
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
        const pick = g.log[g.r].picks.get(p.pid);
        Object.assign(v, { n: g.r + 1, q: q.q, o: q.o, c: q.c, pick: pick == null ? null : pick, ok: pick === q.c });
      }
      return v;
    }
    const v = { phase: g.phase, n: g.i + 1, tot: g.qs.length, left: Math.max(0, Math.ceil((g.until - now) / 1000)) };
    if (g.phase === 'domanda') {
      const q = g.qs[g.i];
      const a = g.ans.get(p.pid);
      v.q = q.q;
      v.o = q.o;
      v.pick = a ? a.pick : null;
    }
    return v;
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
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

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

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const room = ws.room ? rooms.get(ws.room) : null;
    if (room) room.seen = Date.now();

    // server riavviato: la vecchia stanza non c'e' piu', apri direttamente una nuova
    if (m.t === 'rehost' && !rooms.has(m.code)) m.t = 'host';

    // --- host apre la stanza
    if (m.t === 'host') {
      const code = newCode();
      const url = `${publicUrl(req)}/?r=${code}`;
      const r = {
        code,
        url,
        qr: await QRCode.toDataURL(url, { margin: 1, width: 560, color: { dark: '#0b1020', light: '#ffffff' } }),
        host: ws,
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
        room.game = m.game;
        GAMES[m.game].start(room, { level: m.level });
        room.dirty = true;
      }
      if (m.t === 'stop') {
        room.game = null;
        room.level = null;
        room.g = {};
        room.dirty = true;
      }
      if (m.t === 'next' && room.game && GAMES[room.game].hostInput) {
        if (GAMES[room.game].hostInput(room, m)) room.dirty = true;
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
  server.listen(port, () => console.log(`Pausa Game su http://localhost:${port}  (schermo: /host)`));
}

module.exports = { GAMES, rooms, standings, PERSONAGGI };
