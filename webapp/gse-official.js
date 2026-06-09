const GSE_OFFICIAL_AREAS = {
  'VAPRIO-GSE-370': {
    label: 'Vaprio d Adda - area GSE ufficiale',
    layer: 19,
    objectId: 370,
    serviceBase: 'https://services.arcgisonline.com/arcgis/rest/services/governance/infrastructure_governance/FeatureServer',
    sourceRef: 'dataSource_3-190075c1b0d-layer-19:370',
    sourceUrl: 'https://mappe.gse.it/portal/apps/experiencebuilder/experience/?data_id=dataSource_3-190075c1b0d-layer-19%3A370&id=7cdfc4cfb0bb4beead292e9290fdeebd'
  }
};

async function fetchOfficialGseArea(def){
  const url = `${def.serviceBase}/${def.layer}/query?` + new URLSearchParams({
    objectIds: String(def.objectId),
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  }).toString();

  const data = await fetchJson(url);
  if(!data.features || !data.features.length){
    throw new Error(`Nessuna geometria GSE trovata per ${def.sourceRef}`);
  }

  data.features = data.features.map((feature, idx) => ({
    type: 'Feature',
    id: feature.id || `${def.sourceRef}-${idx}`,
    geometry: feature.geometry,
    properties: Object.assign({}, feature.properties || {}, {
      COD_AC: 'VAPRIO-GSE-370',
      NOME: def.label,
      COMUNE: 'Vaprio d Adda',
      SOURCE_REF: def.sourceRef,
      SOURCE_URL: def.sourceUrl,
      GSE_LAYER: def.layer,
      GSE_OBJECTID: def.objectId
    })
  }));

  return data;
}

const fallbackSelectAreaByCode = selectAreaByCode;
selectAreaByCode = async function(code, li){
  const def = GSE_OFFICIAL_AREAS[code];
  if(!def) return fallbackSelectAreaByCode(code, li);

  try{
    selectedCabinCode = code;
    document.querySelectorAll('#cabinsList li,.ac-btn').forEach(n=>n.classList.remove('active'));
    if(li) li.classList.add('active');
    setInfo(`Caricamento geometria ufficiale GSE (${def.sourceRef})...`);

    const geo = await fetchOfficialGseArea(def);
    const feature = geo.features && geo.features[0];
    if(!feature) throw new Error('Area GSE non trovata');

    if(selectedLayer) selectedLayer.remove();
    selectedLayer = L.geoJSON(feature, { style: { color: '#00a5ff', weight: 3, fillOpacity: 0.12 } }).addTo(map);
    try{ map.fitBounds(selectedLayer.getBounds().pad(0.2)); }catch(e){}

    setInfo(`Area GSE caricata. Ricerca utenze non domestiche in corso...`);
    const osm = await fetchJson('/api/osm-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geojson: feature.geometry })
    });
    osmResults = enrichFeatures(osm.features || [], code);
    renderResults(osmResults, Object.assign({}, osm.meta || {}, { gseSource: def.sourceRef }));
  }catch(err){
    setInfo('Errore: ' + err.message);
  }
};
