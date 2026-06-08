const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

// basic app setup
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '2mb' }));
// serve static files from webapp (index.html, css, images, main.js)
app.use(express.static(path.join(__dirname, 'webapp')));

// GSE services and allowed parameters
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

// simple in-memory cache with TTL
const cache = {};
function cacheGet(key){
  const entry = cache[key];
  if(!entry) return null;
  if(Date.now() > entry.expiry){
    delete cache[key];
    return null;
  }
  return entry.value;
}
function cacheSet(key, value, ttlMs){
  cache[key] = { value, expiry: Date.now() + ttlMs };
}

// process boxes with limited concurrency to avoid overloading Overpass
// default 2 (faster) but can be overridden with env OVERPASS_CONCURRENCY
const concurrency = parseInt(process.env.OVERPASS_CONCURRENCY) || 2;

// geometry helpers used by simplifyCoords
function getPerpDistance(point, start, end){
  const x0 = point[0], y0 = point[1];
  const x1 = start[0], y1 = start[1];
  const x2 = end[0], y2 = end[1];
  const dx = x2 - x1, dy = y2 - y1;
  if(dx === 0 && dy === 0) return Math.hypot(x0 - x1, y0 - y1);
  const t = ((x0 - x1) * dx + (y0 - y1) * dy) / (dx*dx + dy*dy);
  const projx = x1 + t * dx;
  const projy = y1 + t * dy;
  return Math.hypot(x0 - projx, y0 - projy);
}

function douglasPeucker(points, epsilon){
  if(!Array.isArray(points) || points.length < 3) return points.slice();
  const start = points[0];
  const end = points[points.length - 1];
  let index = 0;
  let maxDist = 0;
  for(let i=1;i<points.length-1;i++){
    const d = getPerpDistance(points[i], start, end);
    if(d > maxDist){ index = i; maxDist = d; }
  }
  if(maxDist > epsilon){
    const left = douglasPeucker(points.slice(0, index+1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return left.slice(0, left.length-1).concat(right);
  } else {
    return [start, end];
  }
}

function simplifyCoords(coords, maxPoints=200){
  if(!Array.isArray(coords) || coords.length <= maxPoints) return coords;
  // coords are [lon,lat]
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  coords.forEach(c=>{ if(c[0]<minx) minx=c[0]; if(c[1]<miny) miny=c[1]; if(c[0]>maxx) maxx=c[0]; if(c[1]>maxy) maxy=c[1]; });
  const diag = Math.hypot(maxx-minx, maxy-miny) || 0.001;
  // start with small epsilon relative to bbox diagonal, increase until pointcount <= maxPoints
  let epsilon = diag / 500; // heuristic
  let simplified = douglasPeucker(coords, epsilon);
  let attempts = 0;
  while(simplified.length > maxPoints && attempts < 6){
    epsilon *= 2;
    simplified = douglasPeucker(coords, epsilon);
    attempts++;
  }
  // ensure closure
  if(simplified.length > 2){
    const first = simplified[0]; const last = simplified[simplified.length-1];
    if(first[0] !== last[0] || first[1] !== last[1]) simplified.push([first[0], first[1]]);
  }
  return simplified;
}

// Endpoint semplificato: restituisce tutte le cabine (GeoJSON)
app.get('/api/cabins', async (req, res) => {
  try {
    const key = 'cabins_geojson';
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    // Use local mock data for now
    const data = require('./webapp/data/cabins.json');
    cacheSet(key, data, 5 * 60 * 1000);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint per ricerca spaziale sui POD/AC: usa lat,lng,distance (m)
app.get('/api/pod-search', async (req, res) => {
  try {
    const { lat, lng, distance } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
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
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ottieni area AC per codice specifico (COD_AC)
app.get('/api/area', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Parametro code obbligatorio' });
    
    // Query GSE feature service for AC by COD_AC
    const serviceUrl = allowedServices.ac_comuni_21;
    const queryUrl = `${serviceUrl}/query?where=COD_AC='${encodeURIComponent(code)}'&outFields=*&returnGeometry=true&f=json`;
    
    const response = await fetch(queryUrl);
    if (!response.ok) throw new Error(`GSE service error: ${response.status}`);
    const data = await response.json();
    
    if (data.error) throw new Error(`GSE query error: ${data.error.message}`);
    if (!data.features || !data.features.length) {
      return res.status(404).json({ error: `AC con codice ${code} non trovato nel GSE` });
    }
    
    // Convert ArcGIS feature to GeoJSON FeatureCollection
    const features = data.features.map(feature => ({
      type: 'Feature',
      properties: feature.attributes,
      geometry: feature.geometry
    }));
    
    res.json({
      type: 'FeatureCollection',
      features: features
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search OpenStreetMap via Overpass within a polygon (POST with { geojson: <Polygon> })
app.post('/api/osm-search', async (req, res) => {
  try {
    const geo = req.body && req.body.geojson;
    if (!geo) return res.status(400).json({ error: 'Body JSON con proprietà geojson obbligatoria' });

    // For now, return mock data to avoid Overpass rate-limiting
    const mockData = require('./webapp/data/osm-mock.json');
    
    const poiFeatures = (mockData.elements || []).map(el => {
      if (el.type === 'node') {
        return {
          type: 'Feature',
          id: el.type + '/' + el.id,
          properties: Object.assign({ _osm_type: el.type, _osm_id: el.id }, el.tags || {}),
          geometry: { type: 'Point', coordinates: [el.lon, el.lat] }
        };
      } else if ((el.type === 'way' || el.type === 'relation') && el.center) {
        return {
          type: 'Feature',
          id: el.type + '/' + el.id,
          properties: Object.assign({ _osm_type: el.type, _osm_id: el.id }, el.tags || {}),
          geometry: { type: 'Point', coordinates: [el.center.lon, el.center.lat] }
        };
      }
      return null;
    }).filter(Boolean);

    const features = poiFeatures;
    return res.json({ 
      type: 'FeatureCollection', 
      features, 
      meta: { 
        mock: true,
        message: 'Using mock data - connect real Overpass API when ready'
      } 
    });
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
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json(data);
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
