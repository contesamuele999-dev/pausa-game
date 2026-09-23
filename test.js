'use strict';
// Check minimo della logica di gioco: node test.js
const assert = require('assert');
const { GAMES, standings } = require('./server.js');

function room(names) {
  const players = new Map();
  names.forEach((n, i) => players.set('p' + i, { pid: 'p' + i, name: n, score: 0, ws: null, lastTap: 0 }));
  return { code: 'TEST', players, game: null, level: null, g: {}, dirty: false, seen: Date.now() };
}

// ---------------- quiz
{
  const r = room(['Ada', 'Bruno', 'Cleo']);
  r.game = 'quiz';
  GAMES.quiz.start(r, { level: 'adulti' });
  assert.equal(r.g.qs.length, 8, 'servono 8 domande');

  GAMES.quiz.tick(r, r.g.until); // via -> domanda 1
  assert.equal(r.g.phase, 'domanda');

  const q = r.g.qs[0];
  assert.ok(GAMES.quiz.input(r, r.players.get('p0'), { pick: q.c }), 'risposta accettata');
  assert.ok(!GAMES.quiz.input(r, r.players.get('p0'), { pick: 0 }), 'niente seconda risposta');
  assert.ok(!GAMES.quiz.input(r, r.players.get('p1'), { pick: 99 }), 'indice fuori range rifiutato');
  GAMES.quiz.input(r, r.players.get('p1'), { pick: (q.c + 1) % q.o.length });
  // p2 non risponde

  GAMES.quiz.tick(r, r.g.until); // chiude la domanda e assegna i punti
  assert.equal(r.g.phase, 'risposta');
  assert.ok(r.players.get('p0').score >= 500, 'chi risponde giusto prende almeno 500');
  assert.equal(r.players.get('p1').score, 0, 'risposta sbagliata = 0');
  assert.equal(r.players.get('p2').score, 0, 'nessuna risposta = 0');

  // velocita': risposta immediata vale piu' di una al fotofinish
  const fast = room(['F']), slow = room(['S']);
  for (const [rr, delay] of [[fast, 0], [slow, 19000]]) {
    rr.game = 'quiz';
    GAMES.quiz.start(rr, { level: 'adulti' });
    GAMES.quiz.tick(rr, rr.g.until);
    rr.g.ans.set('p0', { pick: rr.g.qs[0].c, at: rr.g.t0 + delay });
    GAMES.quiz.tick(rr, rr.g.until);
  }
  assert.ok(fast.players.get('p0').score > slow.players.get('p0').score, 'piu veloce = piu punti');

  // arriva fino in fondo senza incepparsi
  const end = room(['Z']);
  end.game = 'quiz';
  GAMES.quiz.start(end, {});
  let t = Date.now(), guard = 0;
  while (end.g.phase !== 'fine' && guard++ < 200) { t += 31000; GAMES.quiz.tick(end, t); }
  assert.equal(end.g.phase, 'fine', 'il quiz finisce');
  assert.equal(GAMES.quiz.tick(end, t + 99999), false, 'da fine non si muove piu');
}

// ---------------- riflessi
{
  const r = room(['Ada', 'Bruno', 'Cleo']);
  r.game = 'riflessi';
  GAMES.riflessi.start(r);
  assert.equal(r.g.phase, 'attesa');

  // falsa partenza: bloccato per il round
  GAMES.riflessi.input(r, r.players.get('p2'), { tap: 1 });
  assert.equal(r.g.taps.get('p2').early, true);

  GAMES.riflessi.tick(r, r.g.until); // attesa -> verde
  assert.equal(r.g.phase, 'verde');
  assert.ok(!GAMES.riflessi.input(r, r.players.get('p2'), { tap: 1 }), 'chi e partito prima non rientra');

  r.g.taps.set('p0', { ms: 220, early: false });
  r.g.taps.set('p1', { ms: 480, early: false });
  GAMES.riflessi.tick(r, r.g.until);
  assert.equal(r.g.phase, 'esito');
  assert.equal(r.players.get('p0').score, 600, 'il piu veloce prende il massimo');
  assert.ok(r.players.get('p1').score > 0 && r.players.get('p1').score < 600, 'il secondo prende meno');
  assert.equal(r.players.get('p2').score, 0, 'falsa partenza = 0');

  let t = Date.now(), guard = 0;
  while (r.g.phase !== 'fine' && guard++ < 200) { t += 7000; GAMES.riflessi.tick(r, t); }
  assert.equal(r.g.phase, 'fine', 'i 5 round finiscono');
}

// ---------------- insieme
{
  const r = room(['Ada', 'Bruno']);
  r.game = 'insieme';
  GAMES.insieme.start(r);
  const target = r.g.target;
  assert.ok(target > 0);

  // anti-spam: due tocchi nello stesso millisecondo contano uno
  const p0 = r.players.get('p0');
  assert.ok(GAMES.insieme.input(r, p0, { tap: 1 }));
  assert.ok(!GAMES.insieme.input(r, p0, { tap: 1 }), 'tocchi troppo ravvicinati ignorati');

  // la barra cala da sola se nessuno batte
  const before = r.g.prog;
  GAMES.insieme.tick(r, r.g.last + 1000);
  assert.ok(r.g.prog < before, 'la barra decade');

  // raggiungere il target premia tutti, di piu chi ha battuto di piu
  r.g.prog = target + 5; // il decay si applica prima del controllo: serve un filo di margine
  r.g.taps.set('p0', 100);
  r.g.taps.set('p1', 10);
  GAMES.insieme.tick(r, r.g.last + 1);
  assert.equal(r.g.phase, 'esito');
  assert.equal(r.g.won, true);
  assert.ok(r.players.get('p1').score > 0, 'anche chi batte poco prende punti');
  assert.ok(r.players.get('p0').score > r.players.get('p1').score, 'chi batte di piu prende di piu');

  let t = r.g.until, guard = 0;
  while (r.g.phase !== 'fine' && guard++ < 500) { t += 31000; GAMES.insieme.tick(r, t); }
  assert.equal(r.g.phase, 'fine', 'i 3 round finiscono');
}

// ---------------- classifica
{
  const r = room(['Ada', 'Bruno']);
  r.players.get('p0').score = 10;
  r.players.get('p1').score = 90;
  const s = standings(r);
  assert.deepEqual(s.map((p) => p.name), ['Bruno', 'Ada']);
  assert.equal(s[0].rank, 1);
}

console.log('OK — tutti i check passati');
process.exit(0);
