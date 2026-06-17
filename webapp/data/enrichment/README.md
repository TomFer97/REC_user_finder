# Dataset locali per arricchimento

Questa cartella puo contenere dataset locali usati dal backend per arricchire nome e contatti dei target.

## Overture Places

Percorso default:

```text
webapp/data/enrichment/overture-places.geojson
```

Formato atteso: GeoJSON `FeatureCollection` con feature puntuali Overture Places. Il codice legge campi come:

- `properties.names.primary`
- `properties.websites[]`
- `properties.emails[]`
- `properties.phones[]`
- `properties.categories.primary`
- `properties.addresses[].freeform`

Puoi usare un percorso diverso impostando:

```bash
OVERTURE_PLACES_FILE=/percorso/overture-places-vaprio.geojson npm start
```

## IndicePA / enti pubblici

Percorso default:

```text
webapp/data/enrichment/indicepa-entities.json
```

Formato supportato: array JSON, `FeatureCollection`, oppure oggetto con `records`/`items`.

Campi letti quando presenti:

- `name`, `nome`, `denominazione`
- `email`, `mail`, `pec`, `email_pec`
- `phone`, `telefono`, `tel`
- `website`, `sito`, `url`
- `lat`/`lon` oppure geometria GeoJSON `Point`

Puoi usare un percorso diverso impostando:

```bash
INDICEPA_ENTITIES_FILE=/percorso/indicepa-vaprio.json npm start
```
