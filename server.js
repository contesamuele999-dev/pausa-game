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
    .map((p, i) => ({ pid: p.pid, name: p.name, score: p.score, rank: i + 1, on: p.ws ? 1 : 0 }));
}

function resetScores(room) {
  for (const p of room.players.values()) p.score = 0;
}

// ---------------------------------------------------------------- giochi

const GAMES = {};

// --- Quiz: domanda + 4 risposte, punti per correttezza e velocita'.
GAMES.quiz = {
  label: 'Quiz',
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
      ans: new Map()
    };
    resetScores(room);
  },

  tick(room, now) {
    const g = room.g;
    if (g.phase === 'fine') return false;
    // tutti hanno risposto: non far aspettare la sala
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
      g.phase = 'risposta';
      g.until = now + 6000;
      return true;
    }

    g.i++;
    if (g.i >= g.qs.length) {
      g.phase = 'fine';
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

  hostView(room, now) {
    const g = room.g;
    const q = g.qs[g.i];
    const v = { phase: g.phase, n: g.i + 1, tot: g.qs.length, left: Math.max(0, Math.ceil((g.until - now) / 1000)) };
    if (g.phase === 'via' || g.phase === 'fine') return v;
    v.q = q.q;
    v.o = q.o;
    v.answered = g.ans.size;
    if (g.phase === 'risposta') {
      v.c = q.c;
      v.counts = q.o.map((_, i) => [...g.ans.values()].filter((a) => a.pick === i).length);
    }
    return v;
  },

  playerView(room, p, now) {
    const g = room.g;
    const v = { phase: g.phase, n: g.i + 1, tot: g.qs.length, left: Math.max(0, Math.ceil((g.until - now) / 1000)) };
    if (g.phase === 'via' || g.phase === 'fine') return v;
    const q = g.qs[g.i];
    const a = g.ans.get(p.pid);
    v.q = q.q;
    v.o = q.o;
    v.pick = a ? a.pick : null;
    if (g.phase === 'risposta') {
      v.c = q.c;
      v.ok = a ? a.pick === q.c : false;
    }
    return v;
  }
};

// --- Riflessi: schermo rosso, poi verde. Chi tocca prima vince. Partenza anticipata = 0.
GAMES.riflessi = {
  label: 'Riflessi',

  start(room) {
    room.level = null;
    room.g = { round: 0, tot: 5, phase: 'attesa', until: Date.now() + rnd(2500, 6000), go: 0, taps: new Map() };
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
      g.until = now + 4500;
      return true;
    }
    // esito -> round successivo
    g.round++;
    if (g.round >= g.tot) {
      g.phase = 'fine';
      return true;
    }
    g.taps = new Map();
    g.phase = 'attesa';
    g.until = now + rnd(2500, 6000);
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

  hostView(room, now) {
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
  DECAY: 9, // punti barra persi al secondo
  TAP_MIN_MS: 50, // anti click-spam / autoclicker

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
    const now = Date.now();
    if (now - (p.lastTap || 0) < this.TAP_MIN_MS) return false;
    p.lastTap = now;
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
        p = { pid: Math.random().toString(36).slice(2, 10), name, score: 0, ws, lastTap: 0 };
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
      if (m.t === 'kick') {
        room.players.delete(m.pid);
        room.dirty = true;
      }
      return;
    }

    // --- input giocatore
    if (ws.role === 'player' && room.game) {
      const p = room.players.get(ws.pid);
      if (p && GAMES[room.game].input(room, p, m)) room.dirty = true;
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
    if (room.game && GAMES[room.game].tick(room, now)) room.dirty = true;
    if (room.game && ['domanda', 'play', 'verde'].includes(room.g.phase)) room.dirty = true; // countdown/barra live
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

module.exports = { GAMES, rooms, standings };
