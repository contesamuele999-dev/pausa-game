# Pausa Game

Giochi multiplayer da telefono per le pause delle conferenze. Il pubblico inquadra un QR,
entra e gioca insieme. Cinque meccaniche, una classifica per partita, premi ai primi.

## Come si usa in sala

1. Apri **`/host`** sul portatile collegato al proiettore. Compare un codice a 4 lettere + QR.
2. Le persone inquadrano il QR (o vanno sul sito e digitano il codice), scrivono il nome, entrano.
3. Scegli il gioco dai bottoni in basso a destra. A fine partita lo schermo mostra il podio.
4. Premia i primi tre, premi **Termina**, si torna al QR per il giro successivo.

Il refresh della pagina host non perde la stanza. Chi blocca il telefono rientra e ritrova i suoi punti.

## I cinque giochi

| Gioco | Per chi | Come funziona | Durata |
|---|---|---|---|
| **Quiz** | bambini / ragazzi / adulti (3 set separati) | 8 domande, 4 risposte. Punti per correttezza + velocità (500 + fino a 500 bonus). Le soluzioni si vedono solo nel ripasso finale. | ~3 min |
| **Riflessi** | tutti, ottimo per i bambini (non serve leggere) | 5 round. Schermo rosso, poi verde: chi tocca prima vince. Partenza anticipata = 0 punti. | ~1 min |
| **Insieme** | tutta la sala, cooperativo | 3 round da 30s. Tutti battono sul telefono per riempire una barra che si svuota da sola. Se ce la fate, punti a tutti (di più a chi ha battuto di più). | ~2 min |
| **Corsa** 🏎️ | dai 6 anni in su | Kart. Si avanza alternando i due pedali, sinistra-destra-sinistra. Martellare sempre lo stesso non porta da nessuna parte. Pedana turbo ogni 25 metri, podio ai primi tre al traguardo. | ~1 min |
| **Salta** 🦘 | tutti, a eliminazione | Arrivano ostacoli a tempo: 🌵 a terra si salta, 🦅 in alto si resta giù. Chi sbaglia esce e guarda gli altri. Gli ostacoli si avvicinano sempre di più. | ~30s |

### I personaggi

Entrando ognuno riceve un personaggio (emoji: niente immagini da caricare, si vedono su
qualsiasi telefono e restano nitide proiettate). In sala d'attesa si tocca per cambiarlo,
a partita iniziata è bloccato. Compare in classifica, nelle corsie della **Corsa** e tra
chi è ancora in pista su **Salta**.

Sul telefono non è decorativo: nella Corsa è il tuo kart che avanza sulla pista fino alla
bandiera a scacchi (e diventa 🚀 sulla pedana turbo), in Salta è il personaggio che scavalca
l'ostacolo in arrivo da destra — guardando il telefono capisci il tempo senza alzare gli occhi
allo schermo. Ampliali o cambiali nella lista `PERSONAGGI` in cima a `server.js`.

### Le risposte del quiz le decidi tu

Durante il quiz nessuno vede la soluzione: né lo schermo né i telefoni. Si risponde e si passa
avanti. Alla fine dell'ottava domanda lo schermo si ferma e compare **Mostra le risposte**:
da lì le scorri una alla volta con **Avanti**, con la soluzione evidenziata e quante persone
avevano scelto ciascuna opzione. Ogni telefono mostra in parallelo cosa aveva risposto il suo
proprietario. L'ultimo **Avanti** porta alla classifica.

## Le domande

Stanno in [`questions.json`](questions.json), tre liste: `bambini`, `ragazzi`, `adulti`.
Formato: `{ "q": "domanda", "o": ["a","b","c","d"], "c": 1 }` dove `c` è l'indice della risposta giusta (0-3).
Ne servono almeno 8 per livello, il gioco ne pesca 8 a caso. **Sostituiscile con le tue**:
quelle attuali sono sui meccanismi di memoria e apprendimento, a tema con le pause, ma generiche.

## Locale (Windows, doppio click)

- **`avvia.bat`** — installa le dipendenze la prima volta, trova l'IP del portatile sulla rete,
  avvia il server e apre lo schermo del proiettore. I telefoni sulla stessa wifi inquadrano il QR.
  Per fermare tutto: chiudi la finestra "Pausa Game - server".
- **`firewall.bat`** — apre la porta 3000 verso la rete locale. Serve una volta sola, chiede conferma a Windows.
- **`pusha.bat`** — salva su GitHub. Chiede il messaggio (invio = "aggiornamenti"), e se il
  repository non esiste ancora lo crea privato. Serve [GitHub CLI](https://cli.github.com) loggato.

### Il telefono resta a caricare all'infinito

È il firewall di Windows, non il codice. Sulle reti con profilo "Public" Windows scarta
le connessioni in entrata: il telefono chiede, nessuno risponde, il browser gira a vuoto.

**Doppio click su `firewall.bat`**, conferma con "Sì" alla finestra di Windows. Una volta sola
per portatile. Apre la porta 3000 solo verso la rete locale (`remoteip=localsubnet`),
non verso internet. `avvia.bat` controlla che la regola ci sia e si ferma se manca.

Per verificare a mano:

```bash
netsh advfirewall firewall show rule name="Pausa Game 3000"
```

Altre due cose da controllare prima di dare la colpa al firewall:
telefono e portatile devono stare sulla **stessa** wifi (il telefono non deve essere su 4G),
e l'indirizzo va digitato per intero, `http://192.168.1.26:3000`, porta compresa.

Se dopo la regola il telefono ancora non entra, la wifi ha l'isolamento client attivo
(comune negli hotel e nei centri congressi): i dispositivi non possono parlarsi tra loro.
Lì l'unica strada è l'hotspot del tuo telefono, o il deploy online.

## Locale (da terminale)

```bash
npm install
npm start
```

Schermo su `http://localhost:3000/host`, telefoni su `http://localhost:3000`.
Sulla stessa wifi i telefoni usano l'IP del portatile (es. `http://192.168.1.20:3000`):
in quel caso avvia con `PUBLIC_URL=http://192.168.1.20:3000 npm start` così il QR punta all'indirizzo giusto.

```bash
npm test
```

## Deploy — perché non Netlify

Netlify serve file statici e funzioni serverless: **non tiene connessioni WebSocket aperte**.
Qui servono, perché lo stato della partita è condiviso e "Riflessi" misura millisecondi:
con polling serverless il gioco dei riflessi non funziona e gli altri diventano scattosi.

Serve un host che faccia girare un processo Node persistente. Tutti hanno un piano gratuito:

**Render** (consigliato, il più semplice)
1. Push del repo su GitHub.
2. Render → New → Web Service → collega il repo.
3. Build `npm install`, Start `npm start`. Le WebSocket funzionano senza configurare nulla.
4. Variabile d'ambiente `PUBLIC_URL` = l'URL finale (es. `https://gioco.tuodominio.it`), così il QR è corretto.

Alternative equivalenti: **Railway**, **Fly.io**, o una VPS con `pm2`.

> Nota sul piano gratuito Render: il servizio va in sleep dopo inattività e il primo accesso
> impiega ~30 secondi. Apri `/host` **cinque minuti prima** della pausa, non mentre la sala aspetta.

**Se vuoi tenere Netlify** per il sito principale: nessun problema, punta solo un sottodominio
(es. `gioco.tuodominio.it`) con un record CNAME verso l'app su Render. Netlify resta dov'è.
Un redirect/proxy Netlify **non** va bene: non inoltra l'upgrade WebSocket.

## Note pratiche di sala

- Il QR contiene già il codice: le persone non devono digitare nulla, solo il nome.
- I telefoni usano la **loro** connessione dati. Il wifi della sede non serve.
- Testato fino a 300 giocatori per stanza (limite impostato in `server.js`).
- Lo schermo del telefono resta acceso durante la partita (Wake Lock, dove il browser lo supporta).
- Le stanze vivono in memoria: riavviare il server azzera tutto. Voluto — è roba da 5 minuti.

## File

```
server.js        server + le cinque meccaniche di gioco
questions.json   le domande del quiz, per fascia d'età
public/host.html schermo grande (proiettore)
public/play.html telefono
test.js          check della logica di punteggio e dei round
avvia.bat        lancio rapido in locale
firewall.bat     apre la porta 3000 sulla rete locale (una volta sola)
pusha.bat        commit e push su GitHub
```
