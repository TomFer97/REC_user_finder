const map = L.map('map').setView([45.54, 9.44], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);

let cabinLayer, membersLayer, selectedLayer, podLayer;
let osmResults = [];
let buildingsLayer, poiLayer;
const cabinsUrl = '/api/cabins';
const membersUrl = 'data/members.geojson';

function loadData(){
  Promise.all([fetch(cabinsUrl).then(r=>r.json()), fetch(membersUrl).then(r=>r.json())])
    .then(([cabins,members])=>{
      cabinLayer = L.geoJSON(cabins, {
        style: {color: '#ff7800', weight: 2, fillOpacity: 0.1},
        onEachFeature: (feature, layer) => {
          const label = feature.properties.COD_AC || feature.properties.RAG_SOC || 'Cabina';
          layer.bindPopup(`<strong>${label}</strong><br>${feature.properties.RAG_SOC || ''}`);
          layer.on('click', () => {
            const item = document.querySelector(`#cabinsList li[data-id='${feature.properties.COD_AC}']`);
            if (item) selectCabin(feature, item);
          });
        }
      }).addTo(map);

      membersLayer = L.geoJSON(members, {
        pointToLayer: (f, latlng) => L.circleMarker(latlng, {radius:6, fillColor:'#3388ff', color:'#fff', weight:1, fillOpacity:1}),
      }).addTo(map);

      populateList(cabins.features);
      // map.fitBounds(cabinLayer.getBounds());  // Commentato per mantenere vista su Vaprio d'Adda
    })
}

function populateList(features){
  const ul = document.getElementById('cabinsList');
  ul.innerHTML = '';
  features.forEach((f) => {
    const label = f.properties.COD_AC || f.properties.RAG_SOC || 'Cabina';
     // Skip the hardcoded AC buttons
     const acCode = f.properties.COD_AC;
     if (acCode && ['AC001E01397', 'AC001E01398', 'AC001E01364'].includes(acCode)) return;
     const li = document.createElement('li');
     li.textContent = label;
     li.dataset.id = acCode || label;
     li.onclick = () => { selectCabin(f, li); };
     ul.appendChild(li);
  });
}

function selectCabin(feature, li){
  document.querySelectorAll('#cabinsList li').forEach(n=>n.classList.remove('active'));
  li.classList.add('active');

  if (selectedLayer) {
    selectedLayer.remove();
  }

  selectedLayer = L.geoJSON(feature, {
    style: {color: '#00a5ff', weight: 3, fillOpacity: 0.15}
  }).addTo(map);

  const bounds = selectedLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.2));
  }

  const membersGeo = membersLayer.toGeoJSON();
  const inside = membersGeo.features.filter(m => turf.booleanPointInPolygon(m, feature));

  highlightMembers(inside);
  document.getElementById('info').textContent = `Membri trovati: ${inside.length}`;
}

function highlightMembers(features){
  membersLayer.clearLayers();
  membersLayer.addData(features.map(f=>({type:'Feature',geometry:f.geometry,properties:f.properties}))).addTo(map);
}

// loadData();  // Commentato per nascondere dati di Roma - la mappa rimane su Vaprio d'Adda

// POD search: call backend /api/pod-search using map center and given radius
async function podSearch(){
  const center = map.getCenter();
  const lat = center.lat;
  const lng = center.lng;
  const distance = document.getElementById('radiusInput').value || 500;
  const url = `/api/pod-search?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&distance=${encodeURIComponent(distance)}`;
  document.getElementById('info').textContent = 'Ricerca POD in corso...';
  try{
    const resp = await fetch(url);
    if(!resp.ok) throw new Error(`Errore server: ${resp.status}`);
    const geo = await resp.json();
    renderPodResults(geo);
  }catch(err){
    document.getElementById('info').textContent = 'Errore ricerca POD: '+err.message;
  }
}

function renderPodResults(geojson){
  // clear existing layers
  if(podLayer) podLayer.remove();
  if(buildingsLayer) buildingsLayer.remove();
  if(poiLayer) poiLayer.remove();

  const features = (geojson && geojson.features) ? geojson.features : [];
  const polys = features.filter(f=> f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
  const points = features.filter(f=> f.geometry && f.geometry.type === 'Point');

  buildingsLayer = L.geoJSON(polys, {
    style: { color: '#d4a600', weight:1, fillColor: '#ddd', fillOpacity: 0.4 }
  }).addTo(map);

  poiLayer = L.geoJSON(points, {
    pointToLayer: (f,latlng) => L.circleMarker(latlng,{radius:6,fillColor:'#ff3333',color:'#fff',weight:1,fillOpacity:1}),
    onEachFeature: (f,layer)=>{
      const p = f.properties || {};
      layer.bindPopup(Object.keys(p).map(k=>`<strong>${k}</strong>: ${p[k]}`).join('<br>'));
    }
  }).addTo(map);

  // Highlight building polygons that contain POI features
  try{
    polys.forEach(polyF => {
      polyF._highlighted = false;
    });
    points.forEach(pt => {
      const point = pt.geometry;
      polys.forEach(polyF => {
        if(!polyF.geometry) return;
        const inside = turf.booleanPointInPolygon(point, polyF);
        if(inside) polyF._highlighted = true;
      });
    });

    // apply highlights
    buildingsLayer.eachLayer(layer => {
      const f = layer.feature;
      if(f && f._highlighted){
        layer.setStyle({ fillColor: '#ffeb3b', fillOpacity: 0.8, color: '#d4a600' });
      }
    });
  }catch(e){ console.warn('Highlight buildings error', e); }

  podLayer = L.featureGroup([buildingsLayer, poiLayer]).addTo(map);
  const count = points.length;
  document.getElementById('info').textContent = `Oggetti OSM trovati: ${features.length} (POI: ${count}, Edifici: ${polys.length})`;
  if(features.length>0){
    try{ map.fitBounds(podLayer.getBounds().pad(0.2)); }catch(e){}
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  const btn = document.getElementById('searchPodBtn');
  if(btn) btn.addEventListener('click', podSearch);
  // AC quick buttons
  document.querySelectorAll('.ac-btn').forEach(b=>{
    b.addEventListener('click', async (ev)=>{
      const code = b.dataset.code;
      document.getElementById('info').textContent = `Caricamento area ${code}...`;
      try{
        const resp = await fetch(`/api/area?code=${encodeURIComponent(code)}`);
        if(!resp.ok) throw new Error(`Server ${resp.status}`);
        const geo = await resp.json();
        if(!geo.features || !geo.features.length){ document.getElementById('info').textContent = 'Area non trovata'; return; }
        const feature = geo.features[0];
        // display selected area
        document.querySelectorAll('#cabinsList li').forEach(n=>n.classList.remove('active'));
        if (selectedLayer) selectedLayer.remove();
        selectedLayer = L.geoJSON(feature, { style: { color: '#00a5ff', weight:3, fillOpacity:0.15 } }).addTo(map);
        try{ map.fitBounds(selectedLayer.getBounds().pad(0.2)); }catch(e){}
        document.getElementById('info').textContent = `Area ${code} caricata. Ricerca OSM in corso...`;

        // call OSM search with polygon
        const searchResp = await fetch('/api/osm-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ geojson: feature.geometry.type === 'Polygon' ? { type: 'Polygon', coordinates: feature.geometry.coordinates } : feature })
        });
        if(!searchResp.ok){
          // try parse JSON error from server — use clone() to avoid consuming body twice
          let errText = '';
          try{
            const j = await searchResp.clone().json();
            if(j && j.error) errText = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
            else errText = JSON.stringify(j).slice(0,800);
          }catch(e){
            try{
              const t = await searchResp.clone().text();
              errText = (t || `OSM ${searchResp.status}`).toString().slice(0,800);
            }catch(e2){
              errText = `OSM ${searchResp.status}`;
            }
          }
          // simplify common Overpass HTML responses
          errText = errText.replace(/\s+/g,' ').replace(/<[^>]+>/g,'').trim();
          // suggest next actions to the user
          const suggestion = 'Se il problema persiste, riprova con OVERPASS_CONCURRENCY=1 o aumenta semplificazione poligono.';
          throw new Error(errText + ' — ' + suggestion);
        }
        const osm = await searchResp.json();
        // display meta info if present
        let metaMsg = '';
        if(osm && osm.meta){
          if(osm.meta.paging) metaMsg = ` (paging applicato, parti: ${osm.meta.parts})`;
          else if(osm.meta.simplified) metaMsg = ` (poligono semplificato: ${osm.meta.usedPointCount}/${osm.meta.originalPointCount})`;
        }
        document.getElementById('info').textContent = `Area ${code} caricata. Ricerca OSM completata${metaMsg}`;
        renderPodResults(osm);
        // also populate long list
        populateLongList(osm.features || []);
      }catch(err){
        document.getElementById('info').textContent = 'Errore: '+err.message;
      }
    });
  });
  const csvBtn = document.getElementById('exportCsvBtn');
  if(csvBtn) csvBtn.addEventListener('click', exportCSV);
  const pdfBtn = document.getElementById('exportPdfBtn');
  if(pdfBtn) pdfBtn.addEventListener('click', exportPDF);
});

function populateLongList(features){
  const div = document.getElementById('resultsList');
  div.innerHTML = '';
  osmResults = features || [];
  if(!osmResults.length){ div.textContent = 'Nessun risultato'; return; }
  osmResults.forEach(f=>{
    const p = f.properties || {};
    const name = p.name || p.shop || p.craft || p.amenity || '—';
    const cat = categorizeFeature(p);
    p.category_macro = cat.macro;
    p.category_sub = cat.sub;
    const el = document.createElement('div');
    el.style.padding='6px'; el.style.borderBottom='1px solid #eee';
    el.innerHTML = `<strong>${name}</strong><br><small>${(p.category_macro||'')} ${p.category_sub?('/ '+p.category_sub):''}<br>${Object.entries(p).slice(0,8).map(([k,v])=>`${k}: ${v}`).join(' | ')}</small>`;
    div.appendChild(el);
  });
}

function getSelectedColumns(){
  const preset = (document.getElementById('exportPreset') && document.getElementById('exportPreset').value) || 'withCategory';
  if(preset !== 'all') return null;
  const inputs = Array.from(document.querySelectorAll('#columnsSelector input[type=checkbox]'));
  const cols = inputs.filter(i=>i.checked).map(i=>i.dataset.col);
  return cols.length ? cols : null;
}

function exportCSV(){
  if(!osmResults || !osmResults.length){ alert('Nessun risultato da esportare'); return; }
  // determine preset
  const preset = (document.getElementById('exportPreset') && document.getElementById('exportPreset').value) || 'withCategory';
  let cols = [];
  if(preset === 'minimal') cols = ['name','category_macro','category_sub','_osm_type','_osm_id'];
  else if(preset === 'withCategory') cols = ['name','category_macro','category_sub','shop','craft','office','amenity','phone','website','addr:street','addr:city','_osm_type','_osm_id'];
  else cols = ['name','category_macro','category_sub','shop','craft','office','amenity','phone','website','addr:street','addr:city','_osm_type','_osm_id'];
  // allow custom selection when preset is 'all'
  const custom = getSelectedColumns();
  if(custom) cols = custom;
  const rows = osmResults.map(f=>{
    const p = f.properties || {};
    // ensure categories
    const cat = categorizeFeature(p);
    p.category_macro = cat.macro;
    p.category_sub = cat.sub;
    p.category = `${cat.macro}${cat.sub? ' / '+cat.sub : ''}`;
    return cols.map(c=>{
      const key = c;
      let v = p[key] || p[key.replace(':','_')] || '';
      if(typeof v === 'string') return `"${v.replace(/"/g,'""')}"`;
      return `"${v}"`;
    }).join(',');
  });
  const csv = [cols.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'osm_results.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportPDF(){
  if(!osmResults || !osmResults.length){ alert('Nessun risultato da esportare'); return; }
  const preset = (document.getElementById('exportPreset') && document.getElementById('exportPreset').value) || 'withCategory';
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  // columns according to preset
  let head = [];
  if(preset === 'minimal') head = ['Name','Macro','Sotto-categoria','OSM Type','OSM ID'];
  else head = ['Name','Macro','Sotto-categoria','Type','Phone','Website','Address','OSM ID'];

  // if preset 'all' and custom selected, build head accordingly
  const custom = getSelectedColumns();
  if(custom){
    head = custom.map(c => {
      if(c === 'name') return 'Name';
      if(c === 'category_macro') return 'Macro';
      if(c === 'category_sub') return 'Sotto-categoria';
      return c;
    });
  }

  const body = osmResults.map(f => {
    const p = f.properties || {};
    const name = p.name || p.shop || p.craft || p.amenity || '';
    const type = p._osm_type || '';
    const catObj = categorizeFeature(p);
    const cat = `${catObj.macro}${catObj.sub? ' / '+catObj.sub:''}`;
    const phone = p.phone || p['contact:phone'] || '';
    const website = p.website || p.url || '';
    const addr = [p['addr:street']||'', p['addr:city']||''].filter(Boolean).join(', ');
    const id = p._osm_id || '';
    if(custom){
      return custom.map(c=>{
        if(c === 'name') return name;
        if(c === 'category_macro') return catObj.macro;
        if(c === 'category_sub') return catObj.sub;
        if(c === '_osm_type') return type;
        if(c === '_osm_id') return id;
        if(c === 'phone') return phone;
        if(c === 'website') return website;
        if(c === 'addr:street') return p['addr:street']||'';
        if(c === 'addr:city') return p['addr:city']||'';
        return p[c] || '';
      });
    }
    if(preset === 'minimal') return [name, catObj.macro, catObj.sub, type, id];
    return [name, catObj.macro, catObj.sub, type, phone, website, addr, id];
  });
  doc.text('OSM Results', 40, 40);
  doc.autoTable({ head: [head], body, startY: 60, styles: { fontSize: 9 }, headStyles: { fillColor: [41,128,185] } });
  doc.save('osm_results.pdf');
}

function categorizeFeature(p){
  if(!p) return { macro: '', sub: '' };
  const lower = (s) => (s||'').toString().toLowerCase();

  // Artigiani e laboratori
  if(p.craft){
    const v = lower(p.craft);
    let sub = p.craft;
    if(v.includes('carpenter') || v.includes('carpentry') || v.includes('falegname')) sub = 'Falegname';
    else if(v.includes('plumber') || v.includes('idraul')) sub = 'Idraulico';
    else if(v.includes('electrician') || v.includes('elettric')) sub = 'Elettricista';
    else if(v.includes('mechanic') || v.includes('meccan')) sub = 'Officina meccanica';
    else if(v.includes('tailor') || v.includes('sarto')) sub = 'Sarto';
    return { macro: 'Artigiani e laboratori', sub };
  }

  // Negozi e servizi locali
  if(p.shop){
    const v = lower(p.shop);
    if(v.includes('bakery') || v.includes('panett') || v.includes('panificio')) return { macro: 'Negozi e servizi locali', sub: 'Panetteria / Pasticceria' };
    if(v.includes('butcher') || v.includes('macell')) return { macro: 'Negozi e servizi locali', sub: 'Macelleria' };
    if(v.includes('supermarket') || v.includes('supermercat') || v.includes('grocery')) return { macro: 'Negozi e servizi locali', sub: 'Supermercato' };
    if(v.includes('convenience')) return { macro: 'Negozi e servizi locali', sub: 'Minimarket' };
    if(v.includes('chem') || v.includes('pharmacy') || v.includes('farmacia')) return { macro: 'Negozi e servizi locali', sub: 'Farmacia' };
    if(v.includes('hairdresser') || v.includes('beauty') || v.includes('parrucchi')) return { macro: 'Negozi e servizi locali', sub: 'Parrucchiere / Estetica' };
    if(v.includes('bakery') || v.includes('cafe') || v.includes('bar')) return { macro: 'Negozi e servizi locali', sub: 'Bar / Caffè' };
    return { macro: 'Negozi e servizi locali', sub: p.shop };
  }

  // Terzo settore (charity / ngo / social)
  if(lower(p.office).includes('charity') || lower(p.nonprofit).length || lower(p['social_facility']).length || lower(p.volunteer).length){
    return { macro: 'Terzo settore', sub: p.office || p['social_facility'] || 'Organizzazione' };
  }

  // Uffici e PMI
  if(p.office){
    const v = lower(p.office);
    if(v.includes('estate') || v.includes('agent')) return { macro: 'PMI', sub: 'Agenzia immobiliare' };
    if(v.includes('company') || v.includes('business') || v.includes('private')) return { macro: 'PMI', sub: p.office };
    return { macro: 'PMI', sub: p.office };
  }

  // Aree industriali / PMI manifatturiere
  if(p['landuse'] === 'industrial' || lower(p.building).includes('industrial') || lower(p.industry)){
    return { macro: 'PMI', sub: p.industry || 'Azienda/Industriale' };
  }

  // Servizi pubblici o collettivi
  if(p.amenity){
    const v = lower(p.amenity);
    if(v.includes('school')) return { macro: 'Servizi pubblici o collettivi', sub: 'Scuola' };
    if(v.includes('hospital') || v.includes('clinic')) return { macro: 'Servizi pubblici o collettivi', sub: 'Sanità' };
    if(v.includes('post_office')) return { macro: 'Servizi pubblici o collettivi', sub: 'Ufficio postale' };
    if(v.includes('library')) return { macro: 'Servizi pubblici o collettivi', sub: 'Biblioteca' };
    if(v.includes('townhall') || v.includes('municip')) return { macro: 'Servizi pubblici o collettivi', sub: 'Municipio / Uffici pubblici' };
    if(v.includes('police') || v.includes('fire_station')) return { macro: 'Servizi pubblici o collettivi', sub: 'Sicurezza pubblica' };
    if(v.includes('community') || v.includes('social')) return { macro: 'Servizi pubblici o collettivi', sub: 'Centro comunitario / Servizi sociali' };
    return { macro: 'Servizi pubblici o collettivi', sub: p.amenity };
  }

  // fallback: if geometry type indicates area
  if(p._osm_type === 'way' || p._osm_type === 'relation') return { macro: 'Altro', sub: 'Edificio/Area' };
  return { macro: '', sub: '' };
}
