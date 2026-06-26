const map = L.map('map').setView([45.576, 9.525], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);

let selectedLayer, resultsLayer, searchPinLayer;
let osmResults = [];
let selectedCabinCode = '';
let excludedEntityConfig = { rules: [] };
let excludedEntityResults = [];
let featureLayerById = new Map();

const MIN_LARGE_ROOF_CANDIDATE_M2 = 750;

const officialGseAreas = [
  {
    code: 'AC253E00019',
    label: 'Vaprioenergy area GSE 2025-2027 - AC253E00019',
    arcgisLayer: 0,
    sourceRef: 'AC_Comuni_2025 layer 0 COD_AC AC253E00019'
  },
  {
    code: 'AC001E01397',
    label: 'Vaprioenergy area GSE 2025-2027 - AC001E01397',
    arcgisLayer: 0,
    sourceRef: 'AC_Comuni_2025 layer 0 COD_AC AC001E01397'
  },
  {
    code: 'AC001E01398',
    label: 'Vaprioenergy area GSE 2025-2027 - AC001E01398',
    arcgisLayer: 0,
    sourceRef: 'AC_Comuni_2025 layer 0 COD_AC AC001E01398'
  }
];

function setInfo(message){
  const el = document.getElementById('info');
  if(el) el.textContent = message;
}

function esc(value){
  return String(value ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

async function fetchJson(url, options){
  const response = await fetch(url, options);
  if(!response.ok){
    let message = response.status + ' ' + response.statusText;
    try{
      const body = await response.json();
      if(body && body.error){
        message = body.error;
        if(Array.isArray(body.details) && body.details.length){
          message += ': ' + body.details.join(' | ');
        }
      }
    }catch(e){
      try{ message = await response.text(); }catch(e2){}
    }
    throw new Error(message);
  }
  return response.json();
}

async function loadExcludedEntityRules(){
  try{
    const data = await fetchJson('data/excluded-entities.json');
    excludedEntityConfig = data && Array.isArray(data.rules) ? data : { rules: [] };
  }catch(err){
    console.warn('Lista enti esclusi non caricata:', err.message);
    excludedEntityConfig = { rules: [] };
  }
}

function loadCabins(){
  const ul = document.getElementById('cabinsList');
  if(ul){
    ul.innerHTML = '';
    officialGseAreas.forEach(area => {
      const li = document.createElement('li');
      li.textContent = area.label;
      li.dataset.code = area.code;
      li.onclick = () => selectOfficialGseArea(area, li);
      ul.appendChild(li);
    });
  }
  setInfo('Seleziona una delle tre aree ufficiali GSE Vaprioenergy per avviare la ricerca.');
}

async function fetchOfficialGseArea(area){
  const params = {
    code: area.code,
    layer: String(area.layer || area.arcgisLayer || 0),
    serviceLayer: String(area.arcgisLayer || 0)
  };

  if(area.objectId !== undefined && area.objectId !== null){
    params.objectId = String(area.objectId);
  }

  const query = new URLSearchParams(params).toString();

  const data = await fetchJson('/api/gse-area?' + query);

  if(!data.features || !data.features.length){
    throw new Error('Nessuna geometria GSE trovata per ' + area.sourceRef);
  }

  return data;
}

function excludedEntityMatch(feature){
  const filter = window.EntityExclusionFilter || window.LargeEnterpriseFilter;
  if(!filter) return null;
  return filter.findRule(feature.properties || {}, excludedEntityConfig);
}

function filterExcludedEntities(features){
  const kept = [];
  const excluded = [];

  features.forEach(feature => {
    const match = excludedEntityMatch(feature);
    if(match){
      excluded.push(Object.assign({}, feature, {
        properties: Object.assign({}, feature.properties || {}, {
          excluded_entity_match: match.label,
          excluded_entity_reason: match.reason,
          excluded_entity_category: match.category
        })
      }));
    }else{
      kept.push(feature);
    }
  });

  return { kept, excluded };
}

function clearSearchSelection(){
  if(searchPinLayer){
    searchPinLayer.remove();
    searchPinLayer = null;
  }
  const input = document.getElementById('targetSearchInput');
  if(input) input.value = '';
  document.querySelectorAll('.result-item.active').forEach(el => el.classList.remove('active'));
  renderSearchSuggestions([]);
}

async function selectOfficialGseArea(area, trigger){
  try{
    selectedCabinCode = area.code;
    clearSearchSelection();
    document.querySelectorAll('#cabinsList li').forEach(n=>n.classList.remove('active'));
    if(trigger) trigger.classList.add('active');
    setInfo('Caricamento geometria ufficiale GSE (' + area.sourceRef + ')...');

    const geo = await fetchOfficialGseArea(area);
    const feature = geo.features && geo.features[0];
    if(!feature) throw new Error('Area GSE non trovata');

    if(selectedLayer) selectedLayer.remove();
    selectedLayer = L.geoJSON(feature, { style: { color: '#00a5ff', weight: 3, fillOpacity: 0.12 } }).addTo(map);
    try{ map.fitBounds(selectedLayer.getBounds().pad(0.2)); }catch(e){}

    setInfo('Area GSE caricata. Ricerca utenze non domestiche in corso...');
    const osm = await fetchJson('/api/osm-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geojson: feature.geometry })
    });
    const enrichedResults = enrichFeatures(osm.features || [], area.code);
    const filteredResults = filterExcludedEntities(enrichedResults);
    excludedEntityResults = filteredResults.excluded;
    osmResults = filteredResults.kept;
    renderResults(osmResults, osm.meta || {}, {
      excludedEntities: excludedEntityResults.length
    });
  }catch(err){
    setInfo('Errore: ' + err.message);
  }
}

function enrichFeatures(features, code){
  return features
    .map((f, idx) => {
      const p = Object.assign({}, f.properties || {});
      const cat = categorizeFeature(p);
      const coords = getCoordinates(f);
      const address = formatAddress(p);
      const scoreDetails = scoreOutreachCandidate(Object.assign({}, p, { address }), cat);
      const priority = priorityFromScore(scoreDetails.score);
      const buildingArea = getBuildingArea(p);
      const osmDisplayName = p.osm_display_name || p.name || p.operator || p.brand || p.shop || p.craft || p.office || p.amenity || p.leisure || p.tourism || p.healthcare || p.building || p.landuse || 'Da verificare';
      const enrichedName = firstValue(p.enriched_name, osmDisplayName);
      return Object.assign({}, f, {
        properties: Object.assign(p, {
          search_id: f.id || (p._osm_type && p._osm_id ? p._osm_type + '/' + p._osm_id : code + '-' + idx),
          cabina_cod_ac: code,
          category_macro: cat.macro,
          category_sub: cat.sub,
          lat: coords.lat,
          lon: coords.lon,
          address,
          osm_name_original: osmDisplayName,
          outreach_name: enrichedName,
          priorita_outreach: priority,
          outreach_score: scoreDetails.score,
          motivo_selezione: scoreDetails.reasons.join('; '),
          building_area_m2: buildingArea || '',
          building_area_label: formatBuildingArea(buildingArea),
          note_verifica: buildVerificationNote(p, cat)
        })
      });
    })
    .filter(f => {
      const p = f.properties || {};
      return p.category_macro && (p.outreach_name !== 'Da verificare' || p.confidence !== 'bassa' || isLargeRoofCandidate(p));
    })
    .sort((a,b) => Number(b.properties.outreach_score || 0) - Number(a.properties.outreach_score || 0) || getBuildingArea(b.properties) - getBuildingArea(a.properties) || String(a.properties.category_macro).localeCompare(String(b.properties.category_macro)) || String(a.properties.outreach_name).localeCompare(String(b.properties.outreach_name)));
}

function priorityRank(value){
  if(value === 'alta') return 0;
  if(value === 'media') return 1;
  return 2;
}

function getBuildingArea(properties){
  const value = properties && properties.building_area_m2;
  const area = Number(value);
  return Number.isFinite(area) && area > 0 ? area : 0;
}

function isLargeRoofCandidate(properties){
  return getBuildingArea(properties) >= MIN_LARGE_ROOF_CANDIDATE_M2;
}

function formatBuildingArea(area){
  const value = Number(area);
  if(!Number.isFinite(value) || value <= 0) return 'n.d.';
  return Math.round(value).toLocaleString('it-IT') + ' mq';
}

function markerStyleForFeature(feature){
  const area = getBuildingArea(feature.properties || {});
  if(!area){
    return { radius: 4, color: '#475569', fillColor: '#94a3b8', weight: 1, fillOpacity: 0.78 };
  }
  if(area < 250){
    return { radius: 4, color: '#166534', fillColor: '#22c55e', weight: 1, fillOpacity: 0.88 };
  }
  if(area < 750){
    return { radius: 5, color: '#3f6212', fillColor: '#84cc16', weight: 1, fillOpacity: 0.88 };
  }
  if(area < 1500){
    return { radius: 7, color: '#854d0e', fillColor: '#facc15', weight: 1, fillOpacity: 0.9 };
  }
  if(area < 3000){
    return { radius: 9, color: '#9a3412', fillColor: '#f97316', weight: 1, fillOpacity: 0.9 };
  }
  return { radius: 12, color: '#7f1d1d', fillColor: '#dc2626', weight: 1.5, fillOpacity: 0.92 };
}

function getCoordinates(feature){
  if(feature.geometry && feature.geometry.type === 'Point'){
    const [lon, lat] = feature.geometry.coordinates;
    return { lat, lon };
  }
  return { lat: '', lon: '' };
}

function formatAddress(p){
  return [p['addr:street'], p['addr:housenumber'], p['addr:postcode'], p['addr:city']].filter(Boolean).join(' ');
}

function buildVerificationNote(p, cat){
  if(!p.name && !p.operator && !p.brand) return 'Nome non disponibile in OSM: verificare manualmente prima del contatto.';
  if(cat.macro === 'Edificio potenzialmente non domestico') return 'Classificazione basata su tag edificio: verificare occupante/attivita.';
  if(['Istruzione e formazione','Sanita e assistenza','Spazi pubblici e collettivi','Sport e tempo libero'].includes(cat.macro)) return 'Target collettivo/pubblico: verificare gestore, POD e disponibilita della copertura.';
  return 'Potenziale utenza non domestica identificata da tag OSM.';
}

function addScorePart(parts, points, reason){
  if(points > 0) parts.push({ points, reason });
}

function hasUsefulTargetName(p){
  const value = firstValue(p.enriched_name, p.name, p.operator, p.brand);
  return value && normalizeSearchText(value) !== 'da verificare';
}

function hasContactInfo(p){
  return Boolean(firstValue(
    p.enriched_phone,
    p.phone,
    p['contact:phone'],
    p.enriched_email,
    p.email,
    p['contact:email'],
    p.enriched_website,
    p.website,
    p.url,
    p['contact:website']
  ));
}

function scoreOutreachCandidate(p, cat){
  const parts = [];
  let score = 0;
  const macro = (cat.macro || '').toLowerCase();
  const sub = (cat.sub || '').toLowerCase();
  const confidence = (p.confidence || '').toLowerCase();
  const area = getBuildingArea(p);

  if(['negozi e servizi locali','artigiani e laboratori','uffici e pmi','servizi pubblici e collettivi','spazi pubblici e collettivi','istruzione e formazione','sanita e assistenza','sport e tempo libero'].includes(macro)){
    addScorePart(parts, 20, 'categoria adatta a una longlist CER');
  }else if(macro === 'edificio potenzialmente non domestico'){
    addScorePart(parts, 10, 'edificio non domestico da qualificare');
  }

  if(sub.includes('supermercato') || sub.includes('alimentari') || sub.includes('macelleria') || sub.includes('panetteria') || sub.includes('farmacia')){
    addScorePart(parts, 15, 'attivita locale con consumo ricorrente');
  }else if(sub.includes('scuola') || sub.includes('university') || sub.includes('hospital')){
    addScorePart(parts, 15, 'servizio collettivo energivoro');
  }else if(sub.includes('sports') || sub.includes('sport')){
    addScorePart(parts, 12, 'impianto sportivo o tempo libero');
  }

  if(area >= 3000) addScorePart(parts, 25, 'tetto molto grande >= 3.000 mq');
  else if(area >= 1500) addScorePart(parts, 18, 'tetto grande >= 1.500 mq');
  else if(area >= MIN_LARGE_ROOF_CANDIDATE_M2) addScorePart(parts, 12, 'tetto interessante >= 750 mq');
  else if(area >= 250) addScorePart(parts, 6, 'superficie edificio disponibile');

  if(hasUsefulTargetName(p)) addScorePart(parts, 10, 'nome o gestore disponibile');
  if(p['addr:street'] || p.address) addScorePart(parts, 8, 'indirizzo disponibile');
  if(hasContactInfo(p)) addScorePart(parts, 10, 'contatto disponibile');
  if(p.enrichment_source && p.enrichment_source !== 'OpenStreetMap') addScorePart(parts, 7, 'arricchito da fonte esterna');
  if(confidence === 'alta') addScorePart(parts, 10, 'confidenza alta');
  else if(confidence === 'media') addScorePart(parts, 5, 'confidenza media');

  score = Math.min(100, parts.reduce((total, part) => total + part.points, 0));
  const reasons = parts
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map(part => part.reason);

  if(!reasons.length) reasons.push('segnale debole: verificare manualmente');
  return { score, reasons };
}

function priorityFromScore(score){
  const value = Number(score) || 0;
  if(value >= 70) return 'alta';
  if(value >= 40) return 'media';
  return 'bassa';
}

function renderResults(features, meta, filterMeta = {}){
  if(resultsLayer) resultsLayer.remove();
  featureLayerById = new Map();
  resultsLayer = L.geoJSON(features, {
    pointToLayer: (f, latlng) => L.circleMarker(latlng, markerStyleForFeature(f)),
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      featureLayerById.set(p.search_id, layer);
      const contactLine = firstValue(p.enriched_phone, p.phone, p['contact:phone'], p.enriched_email, p.email, p['contact:email'], p.enriched_website, p.website, p.url);
      layer.bindPopup('<strong>' + esc(p.outreach_name) + '</strong><br>' + esc(p.category_macro) + (p.category_sub ? ' / ' + esc(p.category_sub) : '') + '<br>' + esc(p.address || '') + '<br>Superficie: ' + esc(formatBuildingArea(p.building_area_m2)) + '<br>Score: ' + esc(p.outreach_score || 0) + '/100 (' + esc(p.priorita_outreach || '') + ')' + '<br>Motivo: ' + esc(p.motivo_selezione || 'n.d.') + '<br>Fonte arricchimento: ' + esc(p.enrichment_source || 'n.d.') + (contactLine ? '<br>Contatto: ' + esc(contactLine) : '') + '<br>Confidenza: ' + esc(p.confidence || ''));
    }
  }).addTo(map);
  try{ if(features.length) map.fitBounds(resultsLayer.getBounds().pad(0.2)); }catch(e){}
  populateLongList(features);
  renderSearchSuggestions([]);
  const source = meta.source === 'mock' ? 'mock' : 'OpenStreetMap/Overpass';
  const excluded = filterMeta.excludedEntities || 0;
  const filterText = excluded ? ' Esclusi ' + excluded + ' enti/insegne dalla lista scarti CER.' : '';
  setInfo('Trovati ' + features.length + ' potenziali utenti non domestici. Fonte area: GSE. Fonte target: ' + source + '.' + filterText);
}

function populateLongList(features){
  const div = document.getElementById('resultsList');
  if(!div) return;
  div.innerHTML = '';
  if(!features.length){ div.textContent = 'Nessun risultato'; return; }
  features.forEach(f=>{
    const p = f.properties || {};
    const el = document.createElement('div');
    el.className = 'result-item';
    el.dataset.searchId = p.search_id || '';
    el.innerHTML = '<strong>' + esc(p.outreach_name) + '</strong><br><small>Score: ' + esc(p.outreach_score || 0) + '/100 - Priorita: ' + esc(p.priorita_outreach || 'n.d.') + '<br>Motivo: ' + esc(p.motivo_selezione || 'n.d.') + '<br>Superficie: ' + esc(formatBuildingArea(p.building_area_m2)) + '<br>' + esc(p.category_macro) + (p.category_sub ? ' / ' + esc(p.category_sub) : '') + '<br>' + esc(p.address || 'Indirizzo non disponibile') + '<br>Fonte arricchimento: ' + esc(p.enrichment_source || 'n.d.') + '<br>Confidenza: ' + esc(p.confidence || 'n.d.') + '</small>';
    el.addEventListener('click', () => focusFeatureOnMap(f));
    div.appendChild(el);
  });
}

function normalizeSearchText(value){
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchableText(feature){
  const p = feature.properties || {};
  return normalizeSearchText([
    p.outreach_name,
    p.osm_name_original,
    p.enriched_name,
    p.brand,
    p.operator,
    p.category_macro,
    p.category_sub,
    p.address,
    p['addr:street'],
    p['addr:housenumber'],
    p['addr:city'],
    p.enriched_website,
    p.website,
    p.url,
    osmReference(p)
  ].filter(Boolean).join(' '));
}

function scoreSearchMatch(feature, query){
  const p = feature.properties || {};
  const normalizedQuery = normalizeSearchText(query);
  if(!normalizedQuery) return 0;
  const text = searchableText(feature);
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  if(!tokens.every(token => text.includes(token))) return 0;

  let score = 1;
  const name = normalizeSearchText(p.outreach_name);
  const address = normalizeSearchText(p.address);
  if(name === normalizedQuery) score += 10;
  else if(name.startsWith(normalizedQuery)) score += 6;
  else if(name.includes(normalizedQuery)) score += 4;
  if(address.includes(normalizedQuery)) score += 3;
  if(p.enriched_name) score += 1;
  if(p.priorita_outreach === 'alta') score += 1;
  score += Math.min(3, getBuildingArea(p) / 1500);
  return score;
}

function findSearchMatches(query, limit = 6){
  return osmResults
    .map(feature => ({ feature, score: scoreSearchMatch(feature, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.feature.properties.outreach_name).localeCompare(String(b.feature.properties.outreach_name)))
    .slice(0, limit)
    .map(item => item.feature);
}

function renderSearchSuggestions(matches, message){
  const container = document.getElementById('searchSuggestions');
  if(!container) return;
  container.innerHTML = '';
  if(message){
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = message;
    container.appendChild(empty);
    return;
  }
  matches.forEach(feature => {
    const p = feature.properties || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-suggestion';
    btn.innerHTML = '<strong>' + esc(p.outreach_name || 'Target') + '</strong><small>' + esc([p.address, formatBuildingArea(p.building_area_m2), p.category_macro].filter(Boolean).join(' - ')) + '</small>';
    btn.addEventListener('click', () => focusFeatureOnMap(feature));
    container.appendChild(btn);
  });
}

function runTargetSearch(){
  const input = document.getElementById('targetSearchInput');
  const query = input ? input.value.trim() : '';
  if(!query){
    renderSearchSuggestions([]);
    return;
  }
  if(!osmResults.length){
    renderSearchSuggestions([], 'Carica prima una delle aree GSE.');
    return;
  }
  const matches = findSearchMatches(query);
  if(!matches.length){
    renderSearchSuggestions([], 'Nessun target trovato nei risultati caricati.');
    return;
  }
  renderSearchSuggestions(matches);
  focusFeatureOnMap(matches[0]);
}

function highlightResultItem(searchId){
  document.querySelectorAll('.result-item.active').forEach(el => el.classList.remove('active'));
  if(!searchId) return;
  const items = Array.from(document.querySelectorAll('.result-item'));
  const item = items.find(el => el.dataset.searchId === searchId);
  if(item){
    item.classList.add('active');
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function linkedBuildingLabel(p){
  if(!p.building_osm_type || !p.building_osm_id) return '';
  return p.building_osm_type + '/' + p.building_osm_id;
}

function focusFeatureOnMap(feature){
  const p = feature.properties || {};
  const coords = getCoordinates(feature);
  if(!Number.isFinite(Number(coords.lat)) || !Number.isFinite(Number(coords.lon))) return;
  const latlng = [Number(coords.lat), Number(coords.lon)];
  if(searchPinLayer) searchPinLayer.remove();
  searchPinLayer = L.circleMarker(latlng, {
    radius: 8,
    color: '#1d4ed8',
    weight: 2,
    opacity: 0.78,
    fillColor: '#ffffff',
    fillOpacity: 0.92,
    interactive: false
  }).addTo(map);
  map.setView(latlng, Math.max(map.getZoom(), 17), { animate: true });
  const layer = featureLayerById.get(p.search_id);
  if(layer) layer.openPopup();
  highlightResultItem(p.search_id);
  const building = linkedBuildingLabel(p);
  setInfo('Selezionato: ' + (p.outreach_name || 'target') + '. ' + (building ? 'Edificio collegato: ' + building + ', ' : '') + 'superficie ' + formatBuildingArea(p.building_area_m2) + '.');
}

function firstValue(...values){
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function osmReference(p){
  if(!p._osm_type || !p._osm_id) return '';
  return p._osm_type + '/' + p._osm_id;
}

function exportRows(){
  return osmResults.map(feature => {
    const p = feature.properties || {};
    const phone = firstValue(p.enriched_phone, p.phone, p['contact:phone']);
    const email = firstValue(p.enriched_email, p.email, p['contact:email']);
    const website = firstValue(p.enriched_website, p.website, p.url, p['contact:website']);
    return {
      Cabina: p.cabina_cod_ac || selectedCabinCode || '',
      Priorita: p.priorita_outreach || '',
      Score: p.outreach_score || '',
      Nome: p.outreach_name || '',
      Superficie_mq: p.building_area_m2 || '',
      Categoria: [p.category_macro, p.category_sub].filter(Boolean).join(' / '),
      Indirizzo: p.address || '',
      Telefono: phone,
      Email: email,
      Sito: website,
      Fonte_nome: p.enrichment_source || 'OpenStreetMap',
      Confidenza: p.confidence || '',
      Motivo_selezione: p.motivo_selezione || '',
      Note: [p.note_verifica, p.enrichment_note].filter(Boolean).join(' '),
      Lat: p.lat || '',
      Lon: p.lon || '',
      OSM: osmReference(p)
    };
  });
}

function exportDateStamp(){
  return new Date().toISOString().slice(0, 10);
}

function exportFileName(extension, prefix = 'longlist_CER'){
  const cabin = selectedCabinCode || 'export';
  return [prefix, cabin, exportDateStamp()].join('_') + '.' + extension;
}

function exportCSV(){
  if(!osmResults.length){ alert('Nessun risultato da esportare'); return; }
  const rows = exportRows();
  const headers = Object.keys(rows[0]);
  const csvRows = rows.map(row => headers.map(header => csvCell(row[header])).join(';'));
  const csv = '\ufeff' + [headers.join(';'), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName('csv');
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value){
  const v = String(value ?? '');
  return '"' + v.replace(/"/g,'""') + '"';
}

async function exportPDF(){
  if(!osmResults.length){ alert('Nessun risultato da esportare'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  const body = exportRows().map(row => [
    row.Nome,
    row.Score,
    row.Priorita,
    row.Superficie_mq ? formatBuildingArea(row.Superficie_mq) : '',
    row.Categoria,
    row.Indirizzo,
    firstValue(row.Telefono, row.Email, row.Sito),
    row.Motivo_selezione
  ]);
  doc.text('Longlist consumer CER - Vaprio d Adda', 40, 40);
  doc.setFontSize(9);
  doc.text('Cabina: ' + (selectedCabinCode || 'n.d.') + ' - Generato: ' + exportDateStamp() + ' - Risultati: ' + osmResults.length, 40, 55);
  doc.autoTable({
    head: [['Nome','Score','Priorita','Superficie','Categoria','Indirizzo','Contatto','Motivo']],
    body,
    startY: 72,
    styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [26, 115, 232] },
    columnStyles: {
      0: { cellWidth: 120 },
      1: { cellWidth: 38 },
      2: { cellWidth: 50 },
      4: { cellWidth: 115 },
      5: { cellWidth: 150 },
      6: { cellWidth: 110 },
      7: { cellWidth: 165 }
    }
  });
  doc.save(exportFileName('pdf', 'report_CER'));
}

function categorizeFeature(p){
  const lower = (s) => (s || '').toString().toLowerCase();
  const educationAmenities = ['school','kindergarten','college','university'];
  const healthAmenities = ['clinic','hospital','doctors','dentist','pharmacy'];
  const publicAmenities = ['post_office','townhall','library','community_centre','social_facility','nursing_home','fire_station','police','public_building'];
  const cultureAmenities = ['theatre','cinema','arts_centre','place_of_worship'];
  const serviceAmenities = ['bank','fuel','marketplace','charging_station','bus_station'];
  const educationBuildings = ['school','kindergarten','college','university'];
  const healthBuildings = ['hospital'];
  const publicBuildings = ['civic','public','government','fire_station'];
  const largeServiceBuildings = ['commercial','industrial','retail','office','warehouse','supermarket','sports_centre','stadium','train_station','transportation','hotel','church','religious','mosque','temple','synagogue','chapel'];

  if(p.craft){
    const v = lower(p.craft);
    if(v.includes('car_repair') || v.includes('mechanic')) return { macro: 'Artigiani e laboratori', sub: 'Officina / autoriparazione' };
    if(v.includes('electrician')) return { macro: 'Artigiani e laboratori', sub: 'Elettricista' };
    if(v.includes('plumber')) return { macro: 'Artigiani e laboratori', sub: 'Idraulico' };
    if(v.includes('carpenter')) return { macro: 'Artigiani e laboratori', sub: 'Falegname' };
    return { macro: 'Artigiani e laboratori', sub: p.craft };
  }
  if(p.shop){
    const v = lower(p.shop);
    if(v.includes('supermarket') || v.includes('grocery')) return { macro: 'Negozi e servizi locali', sub: 'Supermercato / alimentari' };
    if(v.includes('butcher')) return { macro: 'Negozi e servizi locali', sub: 'Macelleria' };
    if(v.includes('bakery')) return { macro: 'Negozi e servizi locali', sub: 'Panetteria / pasticceria' };
    if(v.includes('hairdresser') || v.includes('beauty')) return { macro: 'Negozi e servizi locali', sub: 'Cura persona' };
    return { macro: 'Negozi e servizi locali', sub: p.shop };
  }
  if(p.office) return { macro: 'Uffici e PMI', sub: p.office };
  if(p.tourism) return { macro: 'Ospitalita e turismo', sub: p.tourism };
  if(p.healthcare) return { macro: 'Sanita e assistenza', sub: p.healthcare };
  if(p.amenity){
    const v = lower(p.amenity);
    if(['restaurant','bar','cafe'].includes(v)) return { macro: 'Ristorazione', sub: p.amenity };
    if(educationAmenities.includes(v)) return { macro: 'Istruzione e formazione', sub: p.amenity };
    if(healthAmenities.includes(v)) return { macro: 'Sanita e assistenza', sub: p.amenity };
    if(publicAmenities.includes(v) || cultureAmenities.includes(v)) return { macro: 'Spazi pubblici e collettivi', sub: p.amenity };
    if(serviceAmenities.includes(v)) return { macro: 'Servizi e commercio', sub: p.amenity };
    return { macro: 'Servizi e commercio', sub: p.amenity };
  }
  if(p.leisure) return { macro: 'Sport e tempo libero', sub: p.leisure };
  if(p.public_transport === 'station' || p.railway === 'station') return { macro: 'Trasporti e servizi', sub: p.public_transport || p.railway };
  if(p.man_made === 'works') return { macro: 'Aree commerciali e produttive', sub: 'man_made=works' };
  if(['industrial','commercial','retail'].includes(lower(p.landuse))) return { macro: 'Aree commerciali e produttive', sub: 'landuse=' + p.landuse };
  if(educationBuildings.includes(lower(p.building))){
    return { macro: 'Istruzione e formazione', sub: p.building };
  }
  if(healthBuildings.includes(lower(p.building))){
    return { macro: 'Sanita e assistenza', sub: p.building };
  }
  if(publicBuildings.includes(lower(p.building))){
    return { macro: 'Spazi pubblici e collettivi', sub: p.building };
  }
  if(largeServiceBuildings.includes(lower(p.building))){
    return { macro: 'Edificio potenzialmente non domestico', sub: p.building };
  }
  return { macro: '', sub: '' };
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadExcludedEntityRules();
  loadCabins();
  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCSV);
  document.getElementById('exportPdfBtn')?.addEventListener('click', exportPDF);
  document.getElementById('targetSearchBtn')?.addEventListener('click', runTargetSearch);
  document.getElementById('targetSearchInput')?.addEventListener('keydown', event => {
    if(event.key === 'Enter'){
      event.preventDefault();
      runTargetSearch();
    }
  });
  document.getElementById('targetSearchInput')?.addEventListener('input', event => {
    const query = event.target.value.trim();
    if(query.length < 2){
      renderSearchSuggestions([]);
      return;
    }
    renderSearchSuggestions(findSearchMatches(query));
  });
});
