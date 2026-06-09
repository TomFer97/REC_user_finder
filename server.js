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

const gseFeatureLayerUrls = (
  process.env.GSE_FEATURE_LAYER_URLS ||
  process.env.GSE_FEATURE_LAYER_URL ||
  process.env.GSE_FEATURESERVER_URLS ||
  process.env.GSE_FEATURESERVER_URL ||
  'https://services2.arcgis.com/pROHh69WvVijk4nR/arcgis/rest/services/AC_Comuni/FeatureServer/21'
)
  .split(',')
  .map(url => url.trim())
  .filter(Boolean);

const defaultGseArcgisLayer = String(process.env.GSE_ARCGIS_LAYER || '21');

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'webapp')));

const allowedServices = {
  ac_comuni_21: 'https://services2.arcgis.com/pROHh69WvVijk4nR/arcgis/rest/services/AC_Comuni/FeatureServer/21',
  pod_ac_12: 'https://mappe.gse.it/srvf/rest/services/TIAD2/POD_AC/FeatureServer/12',
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

function normalizeGseLayerUrl(url, serviceLayer = defaultGseArcgisLayer) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (/\/(?:FeatureServer|MapServer)\/\d+$/i.test(clean)) return clean;
  return `${clean}/${serviceLayer}`;
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
)->.targets;
(
  way["building"](poly:"${poly}");
  relation["building"](poly:"${poly}");
)->.buildingCandidates;
(
  .targets;
  .buildingCandidates;
);
out center tags geom;
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

const nonResidentialAmenities = new Set([
  'school', 'clinic', 'hospital', 'doctors', 'dentist', 'pharmacy',
  'post_office', 'townhall', 'library', 'community_centre', 'restaurant',
  'bar', 'cafe', 'fuel', 'bank', 'marketplace'
]);

const nonResidentialBuildings = new Set([
  'commercial', 'industrial', 'retail', 'office', 'warehouse', 'supermarket',
  'school', 'hospital'
]);

function isTargetElement(el) {
  const tags = el.tags || {};
  if (tags.shop || tags.craft || tags.office || tags.tourism) return true;
  if (tags.amenity && nonResidentialAmenities.has(tags.amenity)) return true;
  if (tags.building && nonResidentialBuildings.has(tags.building)) return true;
  if (tags.landuse === 'industrial') return true;
  return false;
}

function isBuildingCandidate(el) {
  const tags = el.tags || {};
  return Boolean(tags.building);
}

function overpassGeometryToPolygon(el) {
  if (!Array.isArray(el.geometry) || el.geometry.length < 4) return null;

  const coordinates = el.geometry
    .map(point => [Number(point.lon), Number(point.lat)])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));

  if (coordinates.length < 4) return null;

  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coordinates.push(first);
  }

  return {
    type: 'Polygon',
    coordinates: [coordinates]
  };
}

function ringAreaSqMeters(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;

  const earthRadius = 6378137;
  let area = 0;

  for (let idx = 0; idx < ring.length - 1; idx += 1) {
    const lon1 = Number(ring[idx][0]) * Math.PI / 180;
    const lat1 = Number(ring[idx][1]) * Math.PI / 180;
    const lon2 = Number(ring[idx + 1][0]) * Math.PI / 180;
    const lat2 = Number(ring[idx + 1][1]) * Math.PI / 180;
    area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }

  return area * earthRadius * earthRadius / 2;
}

function polygonAreaSqMeters(geometry) {
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) return null;
  if (!geometry.coordinates.length) return null;

  const exterior = Math.abs(ringAreaSqMeters(geometry.coordinates[0]));
  const holes = geometry.coordinates
    .slice(1)
    .reduce((sum, ring) => sum + Math.abs(ringAreaSqMeters(ring)), 0);

  const area = exterior - holes;
  return Number.isFinite(area) && area > 0 ? area : null;
}

function polygonCentroid(geometry) {
  const ring = geometry && geometry.coordinates && geometry.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 2) return null;

  const totals = ring.reduce((acc, coord) => {
    acc.lon += Number(coord[0]);
    acc.lat += Number(coord[1]);
    acc.count += 1;
    return acc;
  }, { lon: 0, lat: 0, count: 0 });

  if (!totals.count) return null;
  return [totals.lon / totals.count, totals.lat / totals.count];
}

function getElementPoint(el) {
  if (typeof el.lon === 'number' && typeof el.lat === 'number') {
    return [el.lon, el.lat];
  }

  if (el.center && typeof el.center.lon === 'number' && typeof el.center.lat === 'number') {
    return [el.center.lon, el.center.lat];
  }

  const polygon = overpassGeometryToPolygon(el);
  return polygon ? polygonCentroid(polygon) : null;
}

function pointInRing(point, ring) {
  const [lon, lat] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi) / ((yj - yi) || Number.EPSILON)) + xi);
    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInPolygon(point, geometry) {
  const rings = geometry && geometry.coordinates;
  if (!Array.isArray(rings) || !rings.length) return false;
  if (!pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some(ring => pointInRing(point, ring));
}

function distanceMeters(a, b) {
  const toRad = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function buildBuildingCandidate(el) {
  const geometry = overpassGeometryToPolygon(el);
  if (!geometry) return null;

  const area = polygonAreaSqMeters(geometry);
  const centroid = polygonCentroid(geometry);
  if (!area || !centroid) return null;

  return {
    osmType: el.type,
    osmId: el.id,
    id: `${el.type}/${el.id}`,
    area,
    centroid,
    geometry
  };
}

function canUseOwnGeometryAsBuildingArea(el) {
  return isBuildingCandidate(el);
}

function buildingMatchFromElement(el, buildingCandidates) {
  const elementPolygon = overpassGeometryToPolygon(el);
  const elementArea = elementPolygon ? polygonAreaSqMeters(elementPolygon) : null;

  if (elementArea && canUseOwnGeometryAsBuildingArea(el)) {
    return {
      area: elementArea,
      source: isBuildingCandidate(el) ? 'osm_building_geometry' : 'osm_feature_geometry',
      osmType: el.type,
      osmId: el.id,
      distance: 0
    };
  }

  const point = getElementPoint(el);
  if (!point) return null;

  const containing = buildingCandidates
    .filter(candidate => pointInPolygon(point, candidate.geometry))
    .sort((a, b) => a.area - b.area);

  if (containing.length) {
    return Object.assign({}, containing[0], {
      source: 'containing_building',
      distance: 0
    });
  }

  const nearest = buildingCandidates
    .map(candidate => Object.assign({}, candidate, {
      distance: distanceMeters(point, candidate.centroid)
    }))
    .filter(candidate => candidate.distance <= 35)
    .sort((a, b) => a.distance - b.distance)[0];

  if (!nearest) return null;

  return Object.assign({}, nearest, {
    source: 'nearby_building'
  });
}

function overpassElementToFeature(el, buildingMatch) {
  const tags = el.tags || {};
  const point = getElementPoint(el);

  if (!point) return null;

  const [lon, lat] = point;
  const buildingArea = buildingMatch && buildingMatch.area
    ? Math.round(buildingMatch.area)
    : '';

  return {
    type: 'Feature',
    id: `${el.type}/${el.id}`,
    properties: Object.assign({}, tags, {
      _osm_type: el.type,
      _osm_id: el.id,
      source: 'OpenStreetMap / Overpass',
      confidence: estimateConfidence(tags),
      osm_geometry_type: overpassGeometryToPolygon(el) ? 'Polygon' : 'Point',
      building_area_m2: buildingArea,
      building_area_source: buildingMatch ? buildingMatch.source : '',
      building_osm_type: buildingMatch ? buildingMatch.osmType : '',
      building_osm_id: buildingMatch ? buildingMatch.osmId : '',
      building_match_distance_m: buildingMatch && Number.isFinite(buildingMatch.distance)
        ? Math.round(buildingMatch.distance)
        : ''
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

  const targetElements = [];
  const buildingCandidates = [];
  const usedEndpoints = [];

  for (const ring of rings) {
    const poly = ringToOverpassPoly(ring);
    if (!poly) continue;

    const query = buildNonResidentialQuery(poly);
    const result = await fetchOverpassWithFallback(query);
    usedEndpoints.push(result.url);

    (result.data.elements || []).forEach(el => {
      if (isBuildingCandidate(el)) {
        const candidate = buildBuildingCandidate(el);
        if (candidate) buildingCandidates.push(candidate);
      }

      if (isTargetElement(el)) {
        targetElements.push(el);
      }
    });
  }

  const seen = new Set();
  const uniqueElements = targetElements.filter(el => {
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const uniqueFeatures = uniqueElements
    .map(el => overpassElementToFeature(el, buildingMatchFromElement(el, buildingCandidates)))
    .filter(Boolean);

  return {
    type: 'FeatureCollection',
    features: uniqueFeatures,
    meta: {
      source: 'overpass',
      count: uniqueFeatures.length,
      buildingCandidates: buildingCandidates.length,
      overpassEndpointsTried: overpassUrls,
      overpassEndpointsUsed: Array.from(new Set(usedEndpoints)),
      generatedAt: new Date().toISOString()
    }
  };
}

function mockOsmToGeoJson() {
  const mockData = require('./webapp/data/osm-mock.json');
  const features = (mockData.elements || [])
    .filter(isTargetElement)
    .map(el => overpassElementToFeature(el, buildingMatchFromElement(el, [])))
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

app.get('/api/gse-area', async (req, res) => {
  try {
    const objectId = req.query.objectId;
    const code = req.query.code || 'VAPRIO-GSE-370';
    const sourceLayer = req.query.layer || '19';
    const serviceLayer = req.query.serviceLayer || req.query.arcgisLayer || defaultGseArcgisLayer;

    if (!objectId) {
      return res.status(400).json({ error: 'Parametro objectId obbligatorio' });
    }

    const errors = [];
    const tried = new Set();

    for (const candidate of gseFeatureLayerUrls) {
      const layerUrl = normalizeGseLayerUrl(candidate, serviceLayer);
      if (!layerUrl || tried.has(layerUrl)) continue;
      tried.add(layerUrl);

      try {
        const targetUrl = new URL(`${layerUrl}/query`);
        targetUrl.search = new URLSearchParams({
          objectIds: String(objectId),
          outFields: '*',
          returnGeometry: 'true',
          outSR: '4326',
          f: 'geojson'
        }).toString();

        const response = await fetch(targetUrl.href, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (REC user finding proxy)'
          }
        });

        if (!response.ok) {
          const text = await response.text();
          const clean = text
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 220);
          errors.push(`${layerUrl} -> ${response.status}: ${clean}`);
          continue;
        }

        const data = await response.json();

        if (data.error) {
          errors.push(`${layerUrl} -> ArcGIS error: ${data.error.message || JSON.stringify(data.error)}`);
          continue;
        }

        if (!data.features || !data.features.length) {
          errors.push(`${layerUrl} -> nessuna feature per objectId ${objectId}`);
          continue;
        }

        data.features = data.features.map((feature, idx) => {
          const properties = feature.properties || {};
          return {
            type: 'Feature',
            id: feature.id || properties.OBJECTID || `${code}-${idx}`,
            geometry: feature.geometry,
            properties: Object.assign({}, properties, {
              COD_AC: properties.COD_AC || code,
              NOME: properties.NOME || properties.RAG_SOC || 'Vaprio d Adda - area GSE ufficiale',
              COMUNE: properties.COMUNE || 'Vaprio d Adda',
              SOURCE_REF: `dataSource_3-190075c1b0d-layer-${sourceLayer}:${objectId}`,
              GSE_SOURCE_LAYER: sourceLayer,
              GSE_ARCGIS_LAYER: serviceLayer,
              GSE_OBJECTID: objectId,
              GSE_FEATURE_LAYER: layerUrl
            })
          };
        });

        data.meta = Object.assign({}, data.meta || {}, {
          source: 'gse',
          featureLayer: layerUrl,
          sourceLayer,
          arcgisLayer: serviceLayer,
          objectId: String(objectId)
        });

        return res.json(data);
      } catch (err) {
        errors.push(`${layerUrl} -> ${err.message}`);
      }
    }

    return res.status(502).json({
      error: 'Geometria GSE non caricata. Endpoint/layer/objectId da verificare.',
      details: errors
    });
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
