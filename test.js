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
  assert.equal(r.g.phase, 'stacco');
  assert.ok(r.players.get('p0').score >= 500, 'chi risponde giusto prende almeno 500');
  assert.equal(r.players.get('p1').score, 0, 'risposta sbagliata = 0');
  assert.equal(r.players.get('p2').score, 0, 'nessuna risposta = 0');

  // durante la partita nessuno deve vedere la risposta giusta
  const vistaGioco = GAMES.quiz.playerView(r, r.players.get('p0'), Date.now());
  assert.equal(vistaGioco.c, undefined, 'lo stacco non svela la soluzione');
  assert.equal(vistaGioco.ok, undefined, 'lo stacco non dice se hai indovinato');
  const vistaHost = GAMES.quiz.hostView(r, Date.now());
  assert.equal(vistaHost.c, undefined, 'nemmeno lo schermo la svela');

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

  // finite le domande si resta in attesa dell'host, non si svela niente da soli
  const end = room(['Z']);
  end.game = 'quiz';
  GAMES.quiz.start(end, {});
  let t = Date.now(), guard = 0;
  while (end.g.phase !== 'ripasso' && guard++ < 200) { t += 31000; GAMES.quiz.tick(end, t); }
  assert.equal(end.g.phase, 'ripasso', 'dopo l ultima domanda si apre il ripasso');
  assert.equal(GAMES.quiz.tick(end, t + 999999), false, 'il ripasso non avanza da solo');
  assert.equal(GAMES.quiz.hostView(end, t).r, -1, 'le risposte non sono ancora mostrate');
  assert.equal(GAMES.quiz.hostView(end, t).nextLabel, 'Mostra le risposte');

  // l'host le scorre una per una
  for (let k = 0; k < end.g.qs.length; k++) {
    assert.ok(GAMES.quiz.hostInput(end, { t: 'next' }), 'l host avanza');
    assert.equal(end.g.phase, 'ripasso');
    const hv = GAMES.quiz.hostView(end, t);
    assert.equal(hv.n, k + 1, 'mostra la domanda giusta');
    assert.equal(typeof hv.c, 'number', 'ora la soluzione c e');
    assert.equal(hv.counts.length, hv.o.length, 'con quante persone hanno scelto cosa');
  }
  GAMES.quiz.hostInput(end, { t: 'next' });
  assert.equal(end.g.phase, 'fine', 'l ultimo Avanti porta alla classifica');
  assert.equal(GAMES.quiz.tick(end, t + 999999), false, 'da fine non si muove piu');
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

// ---------------- corsa
{
  const r = room(['Ada', 'Bruno']);
  r.game = 'corsa';
  GAMES.corsa.start(r);
  GAMES.corsa.tick(r, r.g.until); // via -> gara
  assert.equal(r.g.phase, 'gara');

  const ada = r.players.get('p0');
  const sbagliato = (GAMES.corsa.input(r, ada, { lane: 1 - (r.g.exp.get('p0') || 0) }), r.g.pos.get('p0') || 0);
  assert.equal(sbagliato, 0, 'pedale sbagliato non fa avanzare');

  // alternando si avanza, pestando sempre lo stesso no
  ada.lastTap = 0;
  for (let i = 0; i < 10; i++) { ada.lastTap = 0; GAMES.corsa.input(r, ada, { lane: r.g.exp.get('p0') || 0 }); }
  assert.equal(r.g.pos.get('p0'), 10, 'dieci alternanze = dieci metri');

  const fermo = r.players.get('p1');
  for (let i = 0; i < 10; i++) { fermo.lastTap = 0; GAMES.corsa.input(r, fermo, { lane: 0 }); }
  assert.ok((r.g.pos.get('p1') || 0) <= 1, 'martellare un solo pedale non porta lontano');

  // la pedana turbo regala metri
  ada.lastTap = 0;
  const prima = r.g.pos.get('p0');
  for (let i = prima; i < 25; i++) { ada.lastTap = 0; GAMES.corsa.input(r, ada, { lane: r.g.exp.get('p0') || 0 }); }
  assert.ok(r.g.pos.get('p0') > 25, 'a 25 metri scatta il turbo');

  // arrivare alla meta chiude la gara e paga il podio
  while ((r.g.pos.get('p0') || 0) < GAMES.corsa.META) { ada.lastTap = 0; GAMES.corsa.input(r, ada, { lane: r.g.exp.get('p0') || 0 }); }
  assert.deepEqual(r.g.fin, ['p0'], 'chi taglia il traguardo viene registrato');
  assert.equal(GAMES.corsa.tick(r, Date.now()), false, 'si aspettano gli altri, o il tempo');
  GAMES.corsa.tick(r, r.g.until); // scade il tempo di gara
  assert.equal(r.g.phase, 'fine');
  assert.equal(ada.score, 1000, 'primo classificato');
  assert.ok(fermo.score >= 0 && fermo.score < 1000, 'gli altri prendono in base ai metri');
}

// ---------------- salta
{
  const r = room(['Ada', 'Bruno', 'Cleo']);
  r.game = 'salto';
  GAMES.salto.start(r);
  GAMES.salto.tick(r, r.g.until); // via -> corsa
  assert.equal(r.g.phase, 'corsa');
  assert.equal(GAMES.salto._vivi(r.g), 3);
  assert.equal(r.g.vite.get('p0'), GAMES.salto.VITE, 'si parte con tutte le vite');

  // ostacolo a terra: chi salta passa, chi resta giu' perde una vita ma resta in gioco
  r.g.tipo = 0;
  r.g.next = Date.now() + 300;
  assert.ok(GAMES.salto.input(r, r.players.get('p0'), { tap: 1 }) === false, 'il salto non ritrasmette a tutti');
  assert.ok(r.g.aria.get('p0') > Date.now(), 'ma il salto e registrato');
  GAMES.salto.tick(r, r.g.next);
  assert.equal(r.g.vite.get('p0'), 3, 'chi salta non perde vite');
  assert.equal(r.g.vite.get('p1'), 2, 'chi sbaglia perde una vita');
  assert.equal(GAMES.salto._vivi(r.g), 3, 'ma resta in pista');
  assert.equal(r.players.get('p0').score, 100, 'ostacolo superato = 100');

  // in aria non si salta di nuovo
  r.g.next = Date.now() + 300;
  r.g.aria.set('p0', Date.now() + 500);
  GAMES.salto.input(r, r.players.get('p0'), { tap: 1 });
  assert.ok(r.g.aria.get('p0') < Date.now() + 600, 'il secondo tocco non prolunga il salto');

  // tre errori e si esce
  r.g.tipo = 1; // ostacolo alto: saltare e l errore, quindi spammare non paga
  for (let k = 0; k < 3; k++) {
    r.g.next = Date.now() + 300;
    r.g.aria.set('p1', 0);
    r.players.get('p1').lastTap = 0;
    GAMES.salto.input(r, r.players.get('p1'), { tap: 1 });
    r.g.tipo = 1;
    GAMES.salto.tick(r, r.g.next);
  }
  assert.equal(r.g.vite.get('p1'), 0, 'finite le vite');
  assert.equal(r.g.fuori.get('p1') > 0, true, 'segna a quale ostacolo e uscito');
  assert.ok(!GAMES.salto.input(r, r.players.get('p1'), { tap: 1 }), 'chi e fuori non tocca piu');

  // finisce quando non resta nessuno
  let t = r.g.next, guard = 0;
  while (r.g.phase !== 'fine' && guard++ < 200) { t += 3000; GAMES.salto.tick(r, t); }
  assert.equal(r.g.phase, 'fine', 'la corsa finisce');

  // un giro intero senza errori arriva in fondo con tutte le vite e prende il bonus pieno
  const r2 = room(['Solo']);
  r2.game = 'salto';
  GAMES.salto.start(r2);
  GAMES.salto.tick(r2, r2.g.until);
  let g2 = 0;
  while (r2.g.phase !== 'fine' && g2++ < 200) {
    const p = r2.players.get('p0');
    r2.g.next = Date.now() + 200;  // l ostacolo sta per arrivare
    r2.g.aria.set('p0', 0);        // a terra
    if (r2.g.tipo === 0) GAMES.salto.input(r2, p, { tap: 1 }); // salta solo se serve
    GAMES.salto.tick(r2, r2.g.next);
  }
  assert.equal(r2.g.vite.get('p0'), GAMES.salto.VITE, 'giocando bene non si perdono vite');
  assert.equal(r2.players.get('p0').score, GAMES.salto.TOT * 100 + 200 * GAMES.salto.VITE,
    'punti ostacoli piu bonus finale proporzionale alle vite rimaste');

  // la partita deve durare: almeno mezzo minuto di ostacoli
  let durata = 0;
  for (let b = 0; b < GAMES.salto.TOT; b++) durata += GAMES.salto.gap(b);
  assert.ok(durata > 40000, 'il giro dura piu di 40 secondi, era ' + Math.round(durata / 1000) + 's');
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
