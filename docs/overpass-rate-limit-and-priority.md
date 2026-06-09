# Fix: Overpass 429 e priorita outreach

## Problema

Overpass puo restituire HTTP 429 quando l'istanza pubblica e sovraccarica o sta limitando le richieste. La webapp non deve dipendere da un solo endpoint.

## Correzione consigliata backend

In `server.js`, sostituire la costante singola `overpassUrl` con una lista configurabile:

```js
const overpassUrls = (process.env.OVERPASS_URLS || process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',')
  .map(url => url.trim())
  .filter(Boolean);
```

Poi aggiungere una funzione helper:

```js
async function fetchOverpassWithFallback(query){
  const errors = [];
  for(const url of overpassUrls){
    try{
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ data: query })
      });
      if(response.ok) return { data: await response.json(), url };
      const text = await response.text();
      errors.push(`${url} -> ${response.status}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 180)}`);
      if(response.status !== 429 && response.status < 500) break;
    }catch(err){
      errors.push(`${url} -> ${err.message}`);
    }
  }
  throw new Error('Overpass temporaneamente non disponibile o in rate limit. Riprova tra qualche minuto oppure avvia con USE_MOCK_OSM=true. Dettagli: ' + errors.join(' | '));
}
```

Dentro `runOverpassSearch`, sostituire la chiamata `fetch(overpassUrl, ...)` con:

```js
const result = await fetchOverpassWithFallback(query);
const data = result.data;
```

E nella meta della risposta aggiungere:

```js
overpassEndpoints: overpassUrls
```

## Correzione frontend: priorita_outreach

In `webapp/main.js`, dentro `enrichFeatures`, aggiungere:

```js
priority_outreach: calculateOutreachPriority(p, cat)
```

Subito dopo `buildVerificationNote`, aggiungere:

```js
function calculateOutreachPriority(p, cat){
  let score = 0;
  const macro = (cat.macro || '').toLowerCase();
  const sub = (cat.sub || '').toLowerCase();
  const confidence = (p.confidence || '').toLowerCase();

  if(['negozi e servizi locali','artigiani e laboratori','uffici e pmi','servizi pubblici o collettivi'].includes(macro)) score += 2;
  if(sub.includes('supermercato') || sub.includes('alimentari') || sub.includes('macelleria') || sub.includes('panetteria') || sub.includes('farmacia') || sub.includes('scuola')) score += 2;
  if(p.name || p.operator || p.brand) score += 1;
  if(p['addr:street'] || p.address) score += 1;
  if(p.phone || p['contact:phone'] || p.email || p.website || p.url) score += 1;
  if(confidence === 'alta') score += 2;
  else if(confidence === 'media') score += 1;

  if(score >= 6) return 'alta';
  if(score >= 3) return 'media';
  return 'bassa';
}
```

In `getSelectedColumns`, aggiungere `priority_outreach` nelle colonne outreach:

```js
return ['cabina_cod_ac','outreach_name','priority_outreach','category_macro','category_sub','address','phone','contact:phone','email','website','lat','lon','confidence','note_verifica','source','_osm_type','_osm_id'];
```

E nel PDF aggiungere la colonna se utile.
