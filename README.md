# Pausa Game

Giochi multiplayer da telefono per le pause delle conferenze. Il pubblico inquadra un QR,
entra e gioca insieme. Tre meccaniche, una sola classifica per partita, premi ai primi.

## Come si usa in sala

1. Apri **`/host`** sul portatile collegato al proiettore. Compare un codice a 4 lettere + QR.
2. Le persone inquadrano il QR (o vanno sul sito e digitano il codice), scrivono il nome, entrano.
3. Scegli il gioco dai bottoni in basso a destra. A fine partita lo schermo mostra il podio.
4. Premia i primi tre, premi **Termina**, si torna al QR per il giro successivo.

Il refresh della pagina host non perde la stanza. Chi blocca il telefono rientra e ritrova i suoi punti.

## I tre giochi

| Gioco | Per chi | Come funziona | Durata |
|---|---|---|---|
| **Quiz** | bambini / ragazzi / adulti (3 set separati) | 8 domande, 4 risposte. Punti per correttezza + velocità (500 + fino a 500 bonus). | ~3 min |
| **Riflessi** | tutti, ottimo per i bambini (non serve leggere) | 5 round. Schermo rosso, poi verde: chi tocca prima vince. Partenza anticipata = 0 punti. | ~1 min |
| **Insieme** | tutta la sala, cooperativo | 3 round da 30s. Tutti battono sul telefono per riempire una barra che si svuota da sola. Se ce la fate, punti a tutti (di più a chi ha battuto di più). | ~2 min |

## Le domande

Stanno in [`questions.json`](questions.json), tre liste: `bambini`, `ragazzi`, `adulti`.
Formato: `{ "q": "domanda", "o": ["a","b","c","d"], "c": 1 }` dove `c` è l'indice della risposta giusta (0-3).
Ne servono almeno 8 per livello, il gioco ne pesca 8 a caso. **Sostituiscile con le tue**:
quelle attuali sono sui meccanismi di memoria e apprendimento, a tema con le pause, ma generiche.

## Locale (Windows, doppio click)

- **`avvia.bat`** — installa le dipendenze la prima volta, trova l'IP del portatile sulla rete,
  avvia il server e apre lo schermo del proiettore. I telefoni sulla stessa wifi inquadrano il QR.
  Per fermare tutto: chiudi la finestra "Pausa Game - server".
- **`pusha.bat`** — salva su GitHub. Chiede il messaggio (invio = "aggiornamenti"), e se il
  repository non esiste ancora lo crea privato. Serve [GitHub CLI](https://cli.github.com) loggato.

### Il telefono resta a caricare all'infinito

È il firewall di Windows, non il codice. Sulle reti con profilo "Public" Windows scarta
le connessioni in entrata: il telefono chiede, nessuno risponde, il browser gira a vuoto.
Da PowerShell **come amministratore**, una volta sola su questo portatile:

```powershell
New-NetFirewallRule -DisplayName "Pausa Game 3000" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Any -RemoteAddress LocalSubnet
```

`-RemoteAddress LocalSubnet` apre la porta solo verso la rete locale, non verso internet.
`avvia.bat` controlla che la regola esista e avvisa se manca.

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
server.js        server + le tre meccaniche di gioco
questions.json   le domande del quiz, per fascia d'età
public/host.html schermo grande (proiettore)
public/play.html telefono
test.js          check della logica di punteggio e dei round
```
