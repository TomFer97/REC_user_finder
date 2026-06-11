# REC_user_finding

Webapp preliminare per supportare Vaprioenergy nell'identificazione di potenziali utenti non domestici da coinvolgere nella comunita energetica.

L'app consente di:

- selezionare una delle tre aree ufficiali GSE di riferimento per Vaprioenergy;
- interrogare OpenStreetMap tramite Overpass per trovare potenziali utenze non domestiche;
- classificare i risultati per macro-categoria utile all'outreach;
- stimare la superficie dell'edificio quando OSM fornisce una geometria o un edificio associabile;
- escludere dalla mappa e dagli export i candidati riconducibili a grandi imprese/insegne nazionali;
- esportare una lista CSV/PDF per le successive verifiche manuali.

> Nota: le aree GSE vengono caricate tramite il proxy backend `/api/gse-area`, usando il layer ArcGIS reale `AC_Comuni/FeatureServer/21`.
> Le tre aree configurate sono `AC001E01364`, `AC001E01397` e `AC001E01398`.

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

Il test controlla la sintassi del backend e del JavaScript frontend principale.

## Modalita mock

Per evitare chiamate a Overpass durante demo o sviluppo:

```bash
USE_MOCK_OSM=true npm start
```

Di default l'app prova a usare Overpass reale.

## Dati principali

- `/api/gse-area`: proxy backend per le geometrie ufficiali GSE.
- `/api/osm-search`: ricerca Overpass su target non domestici e geometrie edificio.
- `webapp/data/large-enterprises.json`: lista configurabile di grandi imprese/insegne da escludere.
- `webapp/data/cabins.json` e `webapp/data/areas.json`: dati legacy non usati dalla UI principale.
- `webapp/data/osm-mock.json`: dati demo usati solo con `USE_MOCK_OSM=true`.

## Filtro grandi imprese

Le comunita energetiche non includono grandi imprese. La definizione operativa usata dal filtro segue la soglia indicata per lo screening: oltre 250 dipendenti e oltre 50 milioni di fatturato.

OpenStreetMap di norma non pubblica dipendenti e fatturato dei singoli esercizi. Per questo l'app applica due controlli:

- se un record contiene dati espliciti di dipendenti/fatturato, li usa per escludere il target;
- altrimenti esclude i risultati che combaciano con la lista locale `webapp/data/large-enterprises.json`, basata su brand, insegna, network o operatore.

Il filtro serve a rendere piu pulita la mappa e l'export, ma la qualificazione finale dell'impresa va verificata prima di contatti o valutazioni formali.

## Export

L'export usa un set fisso di colonne pensate per outreach CER, cosi resta semplice da usare e stabile tra CSV e PDF:

- nome target;
- priorita;
- superficie edificio stimata;
- categoria macro e sotto-categoria;
- indirizzo se disponibile;
- telefono, sito, email se disponibili in OSM;
- coordinate;
- livello di confidenza;
- note di verifica.

I dati OSM sono utili per screening preliminare, ma vanno verificati prima di qualsiasi contatto formale.
