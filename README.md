# REC_user_finding

Webapp preliminare per supportare Vaprioenergy nell'identificazione di potenziali utenti non domestici da coinvolgere nella comunita energetica.

L'app consente di:

- selezionare un'area cabina su Vaprio d Adda;
- interrogare OpenStreetMap tramite Overpass per trovare potenziali utenze non domestiche;
- classificare i risultati per macro-categoria utile all'outreach;
- esportare una lista CSV/PDF per le successive verifiche manuali.

> Nota: i poligoni `VAPRIO-NORD`, `VAPRIO-CENTRO` e `VAPRIO-SUD` sono placeholder preliminari. Devono essere sostituiti con le aree convenzionali/cabine primarie ufficiali GSE quando disponibili.

## Esecuzione locale

```bash
npm install
npm start
```

Aprire:

```bash
http://localhost:3000
```

## Test rapido

```bash
npm test
```

Il test attuale controlla la sintassi di `server.js`.

## Modalita mock

Per evitare chiamate a Overpass durante demo o sviluppo:

```bash
USE_MOCK_OSM=true npm start
```

Di default l'app prova a usare Overpass reale.

## Dati principali

- `webapp/data/cabins.json`: punti/aree selezionabili nella UI.
- `webapp/data/areas.json`: poligoni usati per limitare la ricerca Overpass.
- `webapp/data/osm-mock.json`: dati demo usati solo con `USE_MOCK_OSM=true`.

## Export

Il CSV include colonne pensate per outreach CER:

- cabina/area;
- nome target;
- categoria macro e sotto-categoria;
- indirizzo se disponibile;
- telefono, sito, email se disponibili in OSM;
- coordinate;
- livello di confidenza;
- note di verifica.

I dati OSM sono utili per screening preliminare, ma vanno verificati prima di qualsiasi contatto formale.
