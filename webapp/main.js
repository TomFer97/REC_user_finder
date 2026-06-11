const map = L.map('map').setView([45.576, 9.525], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);

let selectedLayer, resultsLayer;
let osmResults = [];
let selectedCabinCode = '';
let largeEnterpriseRules = [];
let excludedLargeEnterpriseResults = [];

const officialGseAreas = [
  {
    code: 'AC001E01364',
    label: 'Vaprioenergy area GSE 1 - AC001E01364',
    layer: 19,
    arcgisLayer: 21,
    objectId: 336,
    sourceRef: 'dataSource_3-190075c1b0d-layer-19:336'
  },
  {
    code: 'AC001E01397',
    label: 'Vaprioenergy area GSE 2 - AC001E01397',
    layer: 19,
    arcgisLayer: 21,
    objectId: 369,
    sourceRef: 'dataSource_3-190075c1b0d-layer-19:369'
  },
  {
    code: 'AC001E01398',
    label: 'Vaprioenergy area GSE 3 - AC001E01398',
    layer: 19,
    arcgisLayer: 21,
    objectId: 370,
    sourceRef: 'dataSource_3-190075c1b0d-layer-19:370'
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

async function loadLargeEnterpriseRules(){
  try{
    const data = await fetchJson('data/large-enterprises.json');
    largeEnterpriseRules = Array.isArray(data.rules) ? data.rules : [];
  }catch(err){
    console.warn('Filtro grandi imprese non caricato:', err.message);
    largeEnterpriseRules = [];
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
  const query = new URLSearchParams({
    code: area.code,
    layer: String(area.layer),
    serviceLayer: String(area.arcgisLayer),
    objectId: String(area.objectId)
  }).toString();

  const data = await fetchJson('/api/gse-area?' + query);

  if(!data.features || !data.features.length){
    throw new Error('Nessuna geometria GSE trovata per ' + area.sourceRef);
  }

  return data;
}

function largeEnterpriseMatch(feature){
  if(!window.LargeEnterpriseFilter) return null;
  return window.LargeEnterpriseFilter.findRule(feature.properties || {}, largeEnterpriseRules);
}

function filterLargeEnterprises(features){
  const kept = [];
  const excluded = [];

  features.forEach(feature => {
    const match = largeEnterpriseMatch(feature);
    if(match){
      excluded.push(Object.assign({}, feature, {
        properties: Object.assign({}, feature.properties || {}, {
          large_enterprise_match: match.label,
          large_enterprise_reason: match.reason
        })
      }));
    }else{
      kept.push(feature);
    }
  });

  return { kept, excluded };
}

async function selectOfficialGseArea(area, trigger){
  try{
    selectedCabinCode = area.code;
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
    const filteredResults = filterLargeEnterprises(enrichedResults);
    excludedLargeEnterpriseResults = filteredResults.excluded;
    osmResults = filteredResults.kept;
    renderResults(osmResults, osm.meta || {}, {
      excludedLargeEnterprises: excludedLargeEnterpriseResults.length
    });
  }catch(err){
    setInfo('Errore: ' + err.message);
  }
}

function enrichFeatures(features, code){
  return features
    .map(f => {
      const p = Object.assign({}, f.properties || {});
      const cat = categorizeFeature(p);
      const coords = getCoordinates(f);
      const address = formatAddress(p);
      const priority = calculateOutreachPriority(Object.assign({}, p, { address }), cat);
      const buildingArea = getBuildingArea(p);
      return Object.assign({}, f, {
        properties: Object.assign(p, {
          cabina_cod_ac: code,
          category_macro: cat.macro,
          category_sub: cat.sub,
          lat: coords.lat,
          lon: coords.lon,
          address,
          outreach_name: p.name || p.operator || p.brand || p.shop || p.craft || p.office || p.amenity || p.building || 'Da verificare',
          priorita_outreach: priority,
          building_area_m2: buildingArea || '',
          building_area_label: formatBuildingArea(buildingArea),
          note_verifica: buildVerificationNote(p, cat)
        })
      });
    })
    .filter(f => {
      const p = f.properties || {};
      return p.category_macro && (p.outreach_name !== 'Da verificare' || p.confidence !== 'bassa');
    })
    .sort((a,b) => priorityRank(a.properties.priorita_outreach) - priorityRank(b.properties.priorita_outreach) || getBuildingArea(b.properties) - getBuildingArea(a.properties) || String(a.properties.category_macro).localeCompare(String(b.properties.category_macro)) || String(a.properties.outreach_name).localeCompare(String(b.properties.outreach_name)));
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
  return 'Potenziale utenza non domestica identificata da tag OSM.';
}

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

function renderResults(features, meta, filterMeta = {}){
  if(resultsLayer) resultsLayer.remove();
  resultsLayer = L.geoJSON(features, {
    pointToLayer: (f, latlng) => L.circleMarker(latlng, markerStyleForFeature(f)),
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      layer.bindPopup('<strong>' + esc(p.outreach_name) + '</strong><br>' + esc(p.category_macro) + (p.category_sub ? ' / ' + esc(p.category_sub) : '') + '<br>' + esc(p.address || '') + '<br>Superficie: ' + esc(formatBuildingArea(p.building_area_m2)) + '<br>Priorita: ' + esc(p.priorita_outreach || '') + '<br>Confidenza: ' + esc(p.confidence || ''));
    }
  }).addTo(map);
  try{ if(features.length) map.fitBounds(resultsLayer.getBounds().pad(0.2)); }catch(e){}
  populateLongList(features);
  const source = meta.source === 'mock' ? 'mock' : 'OpenStreetMap/Overpass';
  const excluded = filterMeta.excludedLargeEnterprises || 0;
  const filterText = excluded ? ' Escluse ' + excluded + ' grandi imprese/insegne nazionali dal filtro CER.' : '';
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
    el.innerHTML = '<strong>' + esc(p.outreach_name) + '</strong><br><small>Priorita: ' + esc(p.priorita_outreach || 'n.d.') + '<br>Superficie: ' + esc(formatBuildingArea(p.building_area_m2)) + '<br>' + esc(p.category_macro) + (p.category_sub ? ' / ' + esc(p.category_sub) : '') + '<br>' + esc(p.address || 'Indirizzo non disponibile') + '<br>Confidenza: ' + esc(p.confidence || 'n.d.') + '</small>';
    div.appendChild(el);
  });
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
    return {
      Nome: p.outreach_name || '',
      Priorita: p.priorita_outreach || '',
      Superficie_mq: p.building_area_m2 || '',
      Categoria: [p.category_macro, p.category_sub].filter(Boolean).join(' / '),
      Indirizzo: p.address || '',
      Telefono: firstValue(p.phone, p['contact:phone']),
      Email: firstValue(p.email, p['contact:email']),
      Sito: firstValue(p.website, p.url, p['contact:website']),
      Latitudine: p.lat || '',
      Longitudine: p.lon || '',
      Confidenza: p.confidence || '',
      Note: p.note_verifica || '',
      OSM: osmReference(p)
    };
  });
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
  a.download = 'vaprio_potenziali_utenti_non_domestici_' + (selectedCabinCode || 'export') + '.csv';
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
    row.Priorita,
    row.Superficie_mq ? formatBuildingArea(row.Superficie_mq) : '',
    row.Categoria,
    row.Indirizzo,
    row.Telefono,
    row.Sito
  ]);
  doc.text('Potenziali utenze non domestiche - Vaprio d Adda', 40, 40);
  doc.autoTable({
    head: [['Nome','Priorita','Superficie','Categoria','Indirizzo','Telefono','Sito']],
    body,
    startY: 60,
    styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [26, 115, 232] },
    columnStyles: {
      0: { cellWidth: 120 },
      3: { cellWidth: 130 },
      4: { cellWidth: 160 },
      6: { cellWidth: 120 }
    }
  });
  doc.save('vaprio_potenziali_utenti_' + (selectedCabinCode || 'export') + '.pdf');
}

function categorizeFeature(p){
  const lower = (s) => (s || '').toString().toLowerCase();
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
  if(p.amenity){
    const v = lower(p.amenity);
    if(['restaurant','bar','cafe'].includes(v)) return { macro: 'Ristorazione', sub: p.amenity };
    if(['school','clinic','hospital','doctors','dentist','pharmacy','post_office','townhall','library','community_centre'].includes(v)) return { macro: 'Servizi pubblici o collettivi', sub: p.amenity };
    if(['bank','fuel','marketplace'].includes(v)) return { macro: 'Servizi e commercio', sub: p.amenity };
    return { macro: 'Servizi e commercio', sub: p.amenity };
  }
  if(p.landuse === 'industrial') return { macro: 'Aree produttive', sub: 'landuse=industrial' };
  if(['commercial','industrial','retail','office','warehouse','supermarket','school','hospital'].includes(lower(p.building))){
    return { macro: 'Edificio potenzialmente non domestico', sub: p.building };
  }
  return { macro: '', sub: '' };
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadLargeEnterpriseRules();
  loadCabins();
  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCSV);
  document.getElementById('exportPdfBtn')?.addEventListener('click', exportPDF);
});
