const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const useMockOsm = String(process.env.USE_MOCK_OSM || '').toLowerCase() === 'true';

const overpassUrls = (
  process.env.OVERPASS_URLS ||
  process.env.OVERPASS_URL ||
  'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter'
)
  .split(',')
  .map(url => url.trim())
  .filter(Boolean);

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'webapp')));

const allowedServices = {
  ac_comuni_21: 'https://services.arcgisonline.com/arcgis/rest/services/governance/infrastructure_governance/FeatureServer/21',
  pod_ac_12: 'https://services.arcgisonline.com/arcgis/rest/services/governance/infrastructure_governance/FeatureServer/12',
};

const allowedParams = new Set([
  'where', 'objectIds', 'time', 'geometry', 'geometryType', 'inSR', 'spatialRel',
  'relationParam', 'outFields', 'returnGeometry', 'maxAllowableOffset', 'outSR',
  'gdbVersion', 'returnIdsOnly', 'returnCountOnly', 'orderByFields', 'groupByFieldsForStatistics',
  'outStatistics', 'returnZ', 'returnM', 'multipatchOption', 'resultOffset',
  'resultRecordCount', 'returnTrueCurves', 'returnExceededLimitFeatures', 'quantizationParameters',
  'returnCentroid', 'distance', 'units', 'returnDistinctValues', 'f'
]);

const cache = {};

function cacheGet(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    delete cache[key];
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  cache[key] = { value, expiry: Date.now() + ttlMs };
}

function normalizeGeometry(input) {
  if (!input) return null;
  if (input.type === 'Feature') return input.geometry;
  if (input.type === 'Polygon' || input.type === 'MultiPolygon') return input;
  return null;
}

function getPolygonRings(geometry) {
  const geo = normalizeGeometry(geometry);
  if (!geo) return [];
  if (geo.type === 'Polygon') return [geo.coordinates[0]];
  if (geo.type === 'MultiPolygon') return geo.coordinates.map(poly => poly[0]).filter(Boolean);
  return [];
}

function ringToOverpassPoly(ring, maxPoints = 90) {
  if (!Array.isArray(ring) || ring.length < 4) return '';

  const step = Math.max(1, Math.ceil(ring.length / maxPoints));
  const sampled = ring.filter((_, idx) => idx % step === 0);

  const first = sampled[0];
  const last = sampled[sampled.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    sampled.push(first);
  }

  return sampled
    .map(([lon, lat]) => `${Number(lat).toFixed(7)} ${Number(lon).toFixed(7)}`)
    .join(' ');
}

function buildNonResidentialQuery(poly) {
  return `
[out:json][timeout:45];
(
  nwr["shop"](poly:"${poly}");
  nwr["craft"](poly:"${poly}");
  nwr["office"](poly:"${poly}");
  nwr["tourism"](poly:"${poly}");
  nwr["amenity"~"school|clinic|hospital|doctors|dentist|pharmacy|post_office|townhall|library|community_centre|restaurant|bar|cafe|fuel|bank|marketplace"](poly:"${poly}");
  nwr["building"~"commercial|industrial|retail|office|warehouse|supermarket|school|hospital"](poly:"${poly}");
  nwr["landuse"="industrial"](poly:"${poly}");
);
out center tags;
`;
}

async function fetchOverpassWithFallback(query) {
  const errors = [];

  for (const url of overpassUrls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: new URLSearchParams({ data: query })
      });

      if (response.ok) {
        return { data: await response.json(), url };
      }

      const text = await response.text();
      const clean = text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 220);

      errors.push(`${url} -> ${response.status}: ${clean}`);

      if (response.status !== 429 && response.status < 500) {
        break;
      }
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }

  throw new Error(
    'Overpass temporaneamente non disponibile o in rate limit. ' +
    'Riprova tra qualche minuto oppure avvia con USE_MOCK_OSM=true. ' +
    'Dettagli: ' + errors.join(' | ')
  );
}

function overpassElementToFeature(el) {
  const tags = el.tags || {};
  const lon = el.lon || (el.center && el.center.lon);
  const lat = el.lat || (el.center && el.center.lat);

  if (typeof lon !== 'number' || typeof lat !== 'number') return null;

  return {
    type: 'Feature',
    id: `${el.type}/${el.id}`,
    properties: Object.assign({}, tags, {
      _osm_type: el.type,
      _osm_id: el.id,
      source: 'OpenStreetMap / Overpass',
      confidence: estimateConfidence(tags)
    }),
    geometry: {
      type: 'Point',
      coordinates: [lon, lat]
    }
  };
}

function estimateConfidence(tags) {
  if (tags.shop || tags.craft || tags.office || tags.amenity || tags.tourism) return 'alta';
  if (
    tags.building === 'commercial' ||
    tags.building === 'industrial' ||
    tags.building === 'retail' ||
    tags.building === 'office' ||
    tags.building === 'warehouse'
  ) return 'media';
  if (tags.landuse === 'industrial') return 'media';
  return 'bassa';
}

async function runOverpassSearch(geometry) {
  const rings = getPolygonRings(geometry);
  if (!rings.length) throw new Error('GeoJSON polygon or multipolygon required');

  const allFeatures = [];
  const usedEndpoints = [];

  for (const ring of rings) {
    const poly = ringToOverpassPoly(ring);
    if (!poly) continue;

    const query = buildNonResidentialQuery(poly);
    const result = await fetchOverpassWithFallback(query);
    usedEndpoints.push(result.url);

    (result.data.elements || []).forEach(el => {
      const feature = overpassElementToFeature(el);
      if (feature) allFeatures.push(feature);
    });
  }

  const seen = new Set();
  const uniqueFeatures = allFeatures.filter(feature => {
    if (seen.has(feature.id)) return false;
    seen.add(feature.id);
    return true;
  });

  return {
    type: 'FeatureCollection',
    features: uniqueFeatures,
    meta: {
      source: 'overpass',
      count: uniqueFeatures.length,
      overpassEndpointsTried: overpassUrls,
      overpassEndpointsUsed: Array.from(new Set(usedEndpoints)),
      generatedAt: new Date().toISOString()
    }
  };
}

function mockOsmToGeoJson() {
  const mockData = require('./webapp/data/osm-mock.json');
  const features = (mockData.elements || [])
    .map(overpassElementToFeature)
    .filter(Boolean);

  return {
    type: 'FeatureCollection',
    features,
    meta: {
      source: 'mock',
      count: features.length,
      message: 'Set USE_MOCK_OSM=false to query Overpass.'
    }
  };
}

app.get('/api/cabins', async (req, res) => {
  try {
    const key = 'cabins_geojson';
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const data = require('./webapp/data/cabins.json');
    cacheSet(key, data, 5 * 60 * 1000);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/pod-search', async (req, res) => {
  try {
    const { lat, lng, distance } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
    }

    const dist = distance || 500;
    const params = new URLSearchParams();
    params.set('geometry', `${lng},${lat}`);
    params.set('geometryType', 'esriGeometryPoint');
    params.set('distance', String(dist));
    params.set('units', 'esriSRUnit_Meter');
    params.set('outFields', '*');
    params.set('f', 'geojson');
    params.set('returnGeometry', 'true');

    const target = `${allowedServices.pod_ac_12}/query?${params.toString()}`;
    const response = await fetch(target, { headers: { Accept: 'application/json' } });

    if (!response.ok) return res.status(response.status).send(await response.text());

    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/area', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).json({ error: 'Parametro code obbligatorio' });
    }

    const areasData = require('./webapp/data/areas.json');
    const data = areasData[code];

    if (!data) {
      return res.status(404).json({ error: `Area con codice ${code} non trovata` });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/osm-search', async (req, res) => {
  try {
    const geo = req.body && req.body.geojson;
    if (!geo) {
      return res.status(400).json({ error: 'Body JSON con proprieta geojson obbligatoria' });
    }

    if (useMockOsm) {
      return res.json(mockOsmToGeoJson());
    }

    res.json(await runOverpassSearch(geo));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/query', async (req, res) => {
  try {
    const { service, ...query } = req.query;

    if (!service || !allowedServices[service]) {
      return res.status(400).json({ error: 'Service non consentito. Usa un service whitelisted.' });
    }

    const targetUrl = new URL(`${allowedServices[service]}/query`);
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (!allowedParams.has(key)) {
        return res.status(400).json({ error: `Parametro non valido: ${key}` });
      }
      params.set(key, value);
    }

    if (!params.has('f')) params.set('f', 'geojson');
    if (!params.has('outFields')) params.set('outFields', '*');
    if (!params.has('returnGeometry')) params.set('returnGeometry', 'true');

    targetUrl.search = params.toString();

    const response = await fetch(targetUrl.href, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) return res.status(response.status).send(await response.text());

    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
