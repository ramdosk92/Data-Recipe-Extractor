/**
 * CRM Analytics Recipe Extractor
 * Adapted from AndrewMillerOnline/dataflow-extractor
 *
 * Supports CRM Analytics Data Recipe JSON (action-based nodes:
 * load / save / formula / join / filter / schema / aggregate /
 * computeRelative / extractGrains / typeCast / drop_fields etc.)
 *
 * Key structural decisions:
 *  - TRANSFORM ui nodes: graph values are objects {label, parameters}
 *  - AGGREGATE ui nodes: graph values are null (keys only)
 *  - Connectors reference TOP-LEVEL ui node names only
 *  - recipeToUi map bridges recipe node names → ui node names for connector filtering
 */

// ─── COMPOUND UI TYPES (wrap child recipe nodes inside graph) ─────────────────
const COMPOUND_UI_TYPES = new Set(['TRANSFORM', 'AGGREGATE']);

// ─── STATE ────────────────────────────────────────────────────────────────────
let recipeJson      = null;
let labelMap        = {};
let recipeToUi      = {};
let outputNodes     = [];
let selectedOutputs = new Set();
let extractedJson   = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  document.getElementById('fileInput').addEventListener('change', handleFileChange);
}

// ─── FILE HANDLING ────────────────────────────────────────────────────────────
function handleFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const json = JSON.parse(ev.target.result);
      loadRecipe(json, file.name);
    } catch (err) {
      showError('JSON parse error: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function loadRecipe(json, filename) {
  // Validate
  if (!json.nodes) {
    showError("No 'nodes' key found — is this a CRM Analytics Data Recipe JSON?");
    return;
  }

  // Reset state
  recipeJson      = json;
  extractedJson   = null;
  selectedOutputs = new Set();
  outputNodes     = [];

  // Build maps
  const maps = buildMaps(json);
  labelMap   = maps.lmap;
  recipeToUi = maps.r2ui;

  // Collect output (save) nodes
  for (const [name, node] of Object.entries(json.nodes)) {
    if (node.action === 'save') {
      const ds = (node.parameters && node.parameters.dataset) ? node.parameters.dataset : {};
      outputNodes.push({
        name,
        label:       (labelMap[name] && labelMap[name].label) ? labelMap[name].label : (ds.label || name),
        datasetName: ds.name       || '',
        folder:      ds.folderName || '',
      });
    }
  }

  // Show original JSON
  document.getElementById('fileContent').textContent = JSON.stringify(json, null, 2);

  // Reset result area
  document.getElementById('downloadButton').classList.add('invisible');
  document.getElementById('copyButton').classList.add('invisible');
  document.getElementById('resultJSON').textContent = '';

  // Render
  renderStats(json);
  renderNodePicker();

  const nodeCount = Object.keys(json.nodes).length;
  document.getElementById('results').innerHTML =
    `<div class="alert alert-success py-2">
       ✔ Loaded <strong>${escHtml(filename)}</strong> &mdash; version ${json.version || '?'},
       <strong>${nodeCount}</strong> recipe nodes,
       <strong>${outputNodes.length}</strong> output dataset(s).
     </div>`;
}

// ─── MAP BUILDING ─────────────────────────────────────────────────────────────
function buildMaps(json) {
  const lmap = {}, r2ui = {};
  const uiNodes     = (json.ui && json.ui.nodes) ? json.ui.nodes : {};
  const recipeNodes = json.nodes || {};

  for (const [uiName, unode] of Object.entries(uiNodes)) {
    if (!unode) continue;

    lmap[uiName] = {
      label:       unode.label || uiName,
      type:        unode.type  || '',
      parent:      null,
      parentLabel: null,
    };

    // Direct recipe ↔ ui name match
    if (uiName in recipeNodes) r2ui[uiName] = uiName;

    // Graph children (TRANSFORM has object values; AGGREGATE has null values)
    const graph = unode.graph || {};
    for (const [gname, gval] of Object.entries(graph)) {
      lmap[gname] = {
        label:       (gval && gval.label) ? gval.label : gname,
        type:        (gval && gval.parameters && gval.parameters.type) ? gval.parameters.type : '',
        parent:      uiName,
        parentLabel: unode.label || uiName,
      };
      r2ui[gname] = uiName;
    }
  }

  return { lmap, r2ui };
}

// ─── ANCESTOR TRAVERSAL ───────────────────────────────────────────────────────
function getAncestors(nodeName, nodes, visited) {
  if (!visited) visited = new Set();
  if (visited.has(nodeName)) return visited;
  visited.add(nodeName);
  const node = nodes[nodeName];
  if (!node) return visited;
  const sources = node.sources || [];
  for (let i = 0; i < sources.length; i++) {
    getAncestors(sources[i], nodes, visited);
  }
  return visited;
}

// ─── EXTRACTION ───────────────────────────────────────────────────────────────
function extractSubRecipe(selectedArr) {
  const nodes         = recipeJson.nodes || {};
  const ui            = recipeJson.ui    || {};
  const uiNodes       = ui.nodes         || {};
  const allConnectors = ui.connectors    || [];

  // 1. Walk sources to collect all needed recipe nodes
  const neededRecipe = new Set();
  for (let i = 0; i < selectedArr.length; i++) {
    getAncestors(selectedArr[i], nodes, neededRecipe);
  }

  // 2. Map each needed recipe node → its parent ui node
  const neededUi = new Set();
  neededRecipe.forEach(function(rn) {
    const uiName = recipeToUi[rn];
    if (uiName) neededUi.add(uiName);
  });

  // 3. Build new recipe.nodes
  const newNodes = {};
  neededRecipe.forEach(function(n) {
    if (nodes[n]) newNodes[n] = nodes[n];
  });

  // 4. Build new ui.nodes
  //    Compound types: filter graph to needed children only
  //    Simple types: include as-is
  const newUiNodes = {};
  neededUi.forEach(function(uiName) {
    const unode = uiNodes[uiName];
    if (!unode) return;

    if (COMPOUND_UI_TYPES.has(unode.type) && unode.graph) {
      const filteredGraph = {};
      for (const [gname, gval] of Object.entries(unode.graph)) {
        if (neededRecipe.has(gname)) filteredGraph[gname] = gval;
      }
      const newUnode = Object.assign({}, unode, { graph: filteredGraph });
      // AGGREGATE nodes also carry internal connectors
      if (Array.isArray(unode.connectors)) {
        newUnode.connectors = unode.connectors.filter(function(c) {
          return neededRecipe.has(c.source) && neededRecipe.has(c.target);
        });
      }
      newUiNodes[uiName] = newUnode;
    } else {
      newUiNodes[uiName] = unode;
    }
  });

  // 5. Filter top-level connectors (both endpoints must be in neededUi)
  const newConnectors = allConnectors.filter(function(c) {
    return neededUi.has(c.source) && neededUi.has(c.target);
  });

  const newUi = { nodes: newUiNodes, connectors: newConnectors };
  if (ui.hiddenColumns) newUi.hiddenColumns = ui.hiddenColumns;

  return {
    version: recipeJson.version,
    nodes:   newNodes,
    ui:      newUi,
    _meta: {
      recipeNodes: neededRecipe.size,
      uiNodes:     neededUi.size,
      connectors:  newConnectors.length,
    },
  };
}

// ─── RENDER: STATS ────────────────────────────────────────────────────────────
function renderStats(json) {
  const counts = {};
  for (const node of Object.values(json.nodes || {})) {
    const a = node.action || 'unknown';
    counts[a] = (counts[a] || 0) + 1;
  }
  const pills = Object.entries(counts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(e) { return '<span class="badge bg-secondary me-1">' + escHtml(e[0]) + ': ' + e[1] + '</span>'; })
    .join('');

  document.getElementById('statsRow').innerHTML =
    '<div class="mb-3"><strong>Node types:</strong> ' + pills + '</div>';
}

// ─── RENDER: NODE PICKER ──────────────────────────────────────────────────────
function renderNodePicker() {
  const picker = document.getElementById('nodePicker');
  if (!picker) return;

  if (outputNodes.length === 0) {
    picker.innerHTML = '<div class="alert alert-warning">No output (save) nodes found in this recipe.</div>';
    return;
  }

  const totalNodes = Object.keys(recipeJson.nodes || {}).length;
  let html = '<h5 class="mt-2 mb-3">Select output dataset(s) to extract:</h5>';
  html += '<div class="row g-3">';

  for (const o of outputNodes) {
    const deps    = getAncestors(o.name, recipeJson.nodes);
    const depCount = deps.size;
    const uiCount  = (function() {
      const s = new Set();
      deps.forEach(function(n) { const u = recipeToUi[n]; if (u) s.add(u); });
      return s.size;
    })();
    const pct = Math.round(depCount / totalNodes * 100);

    html +=
      '<div class="col-md-6 col-lg-4">' +
        '<div class="card h-100 node-card" id="card_' + o.name + '" onclick="toggleNode(\'' + o.name + '\')">' +
          '<div class="card-body p-3">' +
            '<div class="d-flex justify-content-between align-items-start">' +
              '<div class="me-2">' +
                '<h6 class="card-title mb-1">' + escHtml(o.label) + '</h6>' +
                '<code class="small text-muted">' + escHtml(o.datasetName) + '</code>' +
                (o.folder ? '<div class="text-muted small mt-1">&#128193; ' + escHtml(o.folder) + '</div>' : '') +
              '</div>' +
              '<input class="form-check-input flex-shrink-0 mt-1" type="checkbox" ' +
                     'id="chk_' + o.name + '" ' +
                     'onclick="event.stopPropagation()" ' +
                     'onchange="toggleNode(\'' + o.name + '\')">' +
            '</div>' +
            '<div class="mt-2 text-muted small">' + depCount + ' nodes (' + pct + '%) &middot; ' + uiCount + ' visual blocks</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  html += '</div>';
  html +=
    '<div class="mt-3 mb-2">' +
      '<button class="btn btn-primary" onclick="runExtraction()" id="extractBtn" disabled>Extract Selected</button>' +
      '<button class="btn btn-outline-secondary ms-2" onclick="selectAll()">Select All</button>' +
      '<button class="btn btn-outline-secondary ms-2" onclick="clearAll()">Clear All</button>' +
    '</div>';

  picker.innerHTML = html;
}

// ─── TOGGLE / SELECT / CLEAR ──────────────────────────────────────────────────
function toggleNode(name) {
  if (selectedOutputs.has(name)) {
    selectedOutputs.delete(name);
  } else {
    selectedOutputs.add(name);
  }
  const card = document.getElementById('card_' + name);
  const chk  = document.getElementById('chk_' + name);
  if (card) { card.classList.toggle('selected', selectedOutputs.has(name)); }
  if (chk)  { chk.checked = selectedOutputs.has(name); }
  const btn = document.getElementById('extractBtn');
  if (btn) btn.disabled = selectedOutputs.size === 0;
}

function selectAll() {
  for (const o of outputNodes) {
    selectedOutputs.add(o.name);
    const card = document.getElementById('card_' + o.name);
    const chk  = document.getElementById('chk_' + o.name);
    if (card) card.classList.add('selected');
    if (chk)  chk.checked = true;
  }
  const btn = document.getElementById('extractBtn');
  if (btn) btn.disabled = false;
}

function clearAll() {
  for (const o of outputNodes) {
    selectedOutputs.delete(o.name);
    const card = document.getElementById('card_' + o.name);
    const chk  = document.getElementById('chk_' + o.name);
    if (card) card.classList.remove('selected');
    if (chk)  chk.checked = false;
  }
  const btn = document.getElementById('extractBtn');
  if (btn) btn.disabled = true;
}

// ─── RUN EXTRACTION ───────────────────────────────────────────────────────────
function runExtraction() {
  if (!recipeJson || selectedOutputs.size === 0) return;

  extractedJson = extractSubRecipe(Array.from(selectedOutputs));
  const meta  = extractedJson._meta;
  const total = Object.keys(recipeJson.nodes || {}).length;
  const pct   = Math.round((1 - meta.recipeNodes / total) * 100);

  // Action count badges for result
  const counts = {};
  for (const node of Object.values(extractedJson.nodes || {})) {
    const a = node.action || 'unknown';
    counts[a] = (counts[a] || 0) + 1;
  }
  const pills = Object.entries(counts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(e) { return '<span class="badge bg-success me-1">' + escHtml(e[0]) + ': ' + e[1] + '</span>'; })
    .join('');

  const selLabels = Array.from(selectedOutputs)
    .map(function(n) { const o = outputNodes.find(function(x) { return x.name === n; }); return o ? o.label : n; })
    .join(', ');

  document.getElementById('results').innerHTML =
    '<div class="alert alert-success">' +
      '<strong>Extraction complete</strong> for: <em>' + escHtml(selLabels) + '</em><br>' +
      meta.recipeNodes + ' recipe nodes &middot; ' +
      meta.uiNodes + ' visual blocks &middot; ' +
      meta.connectors + ' connectors &mdash; ' +
      '<strong>' + pct + '% reduction</strong> from ' + total + ' total nodes.<br>' +
      '<div class="mt-2">' + pills + '</div>' +
    '</div>';

  const exportJson = buildExportJson();
  document.getElementById('resultJSON').textContent = JSON.stringify(exportJson, null, 2);
  document.getElementById('downloadButton').classList.remove('invisible');
  document.getElementById('copyButton').classList.remove('invisible');

  // Scroll to result accordion
  const collapseResult = document.getElementById('collapseResult');
  if (collapseResult) {
    const bsCollapse = bootstrap.Collapse.getOrCreateInstance(collapseResult);
    bsCollapse.show();
  }
}

// ─── DOWNLOAD / COPY ──────────────────────────────────────────────────────────
function buildExportJson() {
  if (!extractedJson) return null;
  return { version: extractedJson.version, nodes: extractedJson.nodes, ui: extractedJson.ui };
}

function download() {
  const json = buildExportJson();
  if (!json) return;
  const suffix = Array.from(selectedOutputs)
    .map(function(n) { const o = outputNodes.find(function(x) { return x.name === n; }); return o ? (o.datasetName || o.name) : n; })
    .join('_');
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'recipe_extracted__' + suffix + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function copyResult() {
  const json = buildExportJson();
  if (!json) return;
  navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(function() {
    const btn = document.getElementById('copyButton');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✔ Copied!';
      setTimeout(function() { btn.textContent = orig; }, 2000);
    }
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('results').innerHTML =
    '<div class="alert alert-danger">⚠ ' + escHtml(msg) + '</div>';
  document.getElementById('nodePicker').innerHTML = '';
  document.getElementById('statsRow').innerHTML   = '';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
