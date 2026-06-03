/**
 * CRM Analytics Recipe Extractor
 * Adapted from AndrewMillerOnline/dataflow-extractor
 *
 * Node counting uses UI-level (canvas) nodes as "total nodes":
 *   - LOAD_DATASET  → displayed as "Input"
 *   - OUTPUT        → displayed as "Output"
 *   - JOIN          → displayed as "Join"
 *   - TRANSFORM     → displayed as "Transform"
 *   - FILTER        → displayed as "Filter"
 *   - AGGREGATE     → displayed as "Aggregate"
 *
 * Child nodes inside TRANSFORM/AGGREGATE graphs (formula, schema, flatten, etc.)
 * are shown separately as a secondary breakdown.
 */

// ─── COMPOUND UI TYPES ────────────────────────────────────────────────────────
var COMPOUND_UI_TYPES = new Set(['TRANSFORM', 'AGGREGATE']);

// ─── FRIENDLY LABELS ─────────────────────────────────────────────────────────
var UI_TYPE_LABEL = {
  'LOAD_DATASET': 'Input',
  'OUTPUT':       'Output',
  'JOIN':         'Join',
  'TRANSFORM':    'Transform',
  'FILTER':       'Filter',
  'AGGREGATE':    'Aggregate',
};
var UI_TYPE_BADGE = {
  'LOAD_DATASET': 'bg-success',
  'OUTPUT':       'bg-warning text-dark',
  'JOIN':         'bg-primary',
  'TRANSFORM':    'bg-info text-dark',
  'FILTER':       'bg-danger',
  'AGGREGATE':    'bg-secondary',
};

function uiTypeLabel(type) {
  return UI_TYPE_LABEL[type] || type;
}
function uiTypeBadge(type) {
  return UI_TYPE_BADGE[type] || 'bg-secondary';
}

// ─── STATE ────────────────────────────────────────────────────────────────────
var recipeJson      = null;
var labelMap        = {};
var recipeToUi      = {};
var outputNodes     = [];
var selectedOutputs = new Set();
var extractedJson   = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  document.getElementById('fileInput').addEventListener('change', handleFileChange);
}

// ─── FILE HANDLING ────────────────────────────────────────────────────────────
function handleFileChange(e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var json = JSON.parse(ev.target.result);
      loadRecipe(json, file.name);
    } catch (err) {
      showError('JSON parse error: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function loadRecipe(json, filename) {
  if (!json.nodes) {
    showError("No 'nodes' key found — is this a CRM Analytics Data Recipe JSON?");
    return;
  }

  recipeJson      = json;
  extractedJson   = null;
  selectedOutputs = new Set();
  outputNodes     = [];

  var maps   = buildMaps(json);
  labelMap   = maps.lmap;
  recipeToUi = maps.r2ui;

  // Collect output (save) nodes
  for (var name in json.nodes) {
    var node = json.nodes[name];
    if (node.action === 'save') {
      var ds = (node.parameters && node.parameters.dataset) ? node.parameters.dataset : {};
      outputNodes.push({
        name:        name,
        label:       (labelMap[name] && labelMap[name].label) ? labelMap[name].label : (ds.label || name),
        datasetName: ds.name       || '',
        folder:      ds.folderName || '',
      });
    }
  }

  document.getElementById('fileContent').textContent = JSON.stringify(json, null, 2);
  document.getElementById('downloadButton').classList.add('invisible');
  document.getElementById('copyButton').classList.add('invisible');
  document.getElementById('resultJSON').textContent = '';

  renderStats(json);
  renderNodePicker();

  var uiCount = Object.keys((json.ui && json.ui.nodes) ? json.ui.nodes : {}).length;
  document.getElementById('results').innerHTML =
    '<div class="alert alert-success py-2">' +
      '&#10004; Loaded <strong>' + escHtml(filename) + '</strong> &mdash; ' +
      'version ' + (json.version || '?') + ', ' +
      '<strong>' + uiCount + '</strong> nodes, ' +
      '<strong>' + outputNodes.length + '</strong> output dataset(s).' +
    '</div>';
}

// ─── MAP BUILDING ─────────────────────────────────────────────────────────────
function buildMaps(json) {
  var lmap = {}, r2ui = {};
  var uiNodes     = (json.ui && json.ui.nodes) ? json.ui.nodes : {};
  var recipeNodes = json.nodes || {};

  for (var uiName in uiNodes) {
    var unode = uiNodes[uiName];
    if (!unode) continue;

    lmap[uiName] = {
      label:       unode.label || uiName,
      type:        unode.type  || '',
      parent:      null,
      parentLabel: null,
    };

    if (uiName in recipeNodes) r2ui[uiName] = uiName;

    var graph = unode.graph || {};
    for (var gname in graph) {
      var gval = graph[gname];
      lmap[gname] = {
        label:       (gval && gval.label) ? gval.label : gname,
        type:        (gval && gval.parameters && gval.parameters.type) ? gval.parameters.type : '',
        parent:      uiName,
        parentLabel: unode.label || uiName,
      };
      r2ui[gname] = uiName;
    }
  }

  return { lmap: lmap, r2ui: r2ui };
}

// ─── ANCESTOR TRAVERSAL ───────────────────────────────────────────────────────
function getAncestors(nodeName, nodes, visited) {
  if (!visited) visited = new Set();
  if (visited.has(nodeName)) return visited;
  visited.add(nodeName);
  var node = nodes[nodeName];
  if (!node) return visited;
  var sources = node.sources || [];
  for (var i = 0; i < sources.length; i++) {
    getAncestors(sources[i], nodes, visited);
  }
  return visited;
}

// ─── EXTRACTION ───────────────────────────────────────────────────────────────
function extractSubRecipe(selectedArr) {
  var nodes         = recipeJson.nodes || {};
  var ui            = recipeJson.ui    || {};
  var uiNodes       = ui.nodes         || {};
  var allConnectors = ui.connectors    || [];

  var neededRecipe = new Set();
  for (var i = 0; i < selectedArr.length; i++) {
    getAncestors(selectedArr[i], nodes, neededRecipe);
  }

  var neededUi = new Set();
  neededRecipe.forEach(function(rn) {
    var uiName = recipeToUi[rn];
    if (uiName) neededUi.add(uiName);
  });

  var newNodes = {};
  neededRecipe.forEach(function(n) {
    if (nodes[n]) newNodes[n] = nodes[n];
  });

  var newUiNodes = {};
  neededUi.forEach(function(uiName) {
    var unode = uiNodes[uiName];
    if (!unode) return;

    if (COMPOUND_UI_TYPES.has(unode.type) && unode.graph) {
      var filteredGraph = {};
      for (var gname in unode.graph) {
        if (neededRecipe.has(gname)) filteredGraph[gname] = unode.graph[gname];
      }
      var newUnode = Object.assign({}, unode, { graph: filteredGraph });
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

  var newConnectors = allConnectors.filter(function(c) {
    return neededUi.has(c.source) && neededUi.has(c.target);
  });

  var newUi = { nodes: newUiNodes, connectors: newConnectors };
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

// ─── HELPER: count child recipe node actions inside TRANSFORM/AGGREGATE graphs ─
function countChildActions(json) {
  var uiNodes     = (json.ui && json.ui.nodes) ? json.ui.nodes : {};
  var recipeNodes = json.nodes || {};
  var counts = {};
  for (var uiName in uiNodes) {
    var unode = uiNodes[uiName];
    if (!unode || !unode.graph) continue;
    for (var gname in unode.graph) {
      var rn = recipeNodes[gname];
      if (!rn) continue;
      var a = rn.action || 'unknown';
      counts[a] = (counts[a] || 0) + 1;
    }
  }
  return counts;
}

// ─── RENDER: STATS ────────────────────────────────────────────────────────────
function renderStats(json) {
  var uiNodes  = (json.ui && json.ui.nodes) ? json.ui.nodes : {};
  var uiCounts = {};
  var totalUi  = 0;

  for (var name in uiNodes) {
    var unode = uiNodes[name];
    if (!unode) continue;
    var t = unode.type || 'unknown';
    uiCounts[t] = (uiCounts[t] || 0) + 1;
    totalUi++;
  }

  var childCounts = countChildActions(json);

  var parentPills = Object.entries(uiCounts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(e) {
      return '<span class="badge ' + uiTypeBadge(e[0]) + ' me-1">' +
             escHtml(uiTypeLabel(e[0])) + ': ' + e[1] + '</span>';
    }).join('');

  var childPills = Object.entries(childCounts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(e) {
      return '<span class="badge bg-light text-dark border me-1">' +
             escHtml(e[0]) + ': ' + e[1] + '</span>';
    }).join('');

  document.getElementById('statsRow').innerHTML =
    '<div class="mb-1"><strong>Nodes (' + totalUi + '):</strong> ' + parentPills + '</div>' +
    (childPills
      ? '<div class="mb-3 small text-muted">Inside Transform blocks &mdash; ' + childPills + '</div>'
      : '<div class="mb-3"></div>');
}

// ─── RENDER: NODE PICKER ──────────────────────────────────────────────────────
function renderNodePicker() {
  var picker = document.getElementById('nodePicker');
  if (!picker) return;

  if (outputNodes.length === 0) {
    picker.innerHTML = '<div class="alert alert-warning">No output (save) nodes found in this recipe.</div>';
    return;
  }

  var allUiNodes  = (recipeJson.ui && recipeJson.ui.nodes) ? recipeJson.ui.nodes : {};
  var totalUiCount = Object.keys(allUiNodes).length;

  var html = '<h5 class="mt-2 mb-3">Select output dataset(s) to extract:</h5>';
  html += '<div class="row g-3">';

  for (var i = 0; i < outputNodes.length; i++) {
    var o       = outputNodes[i];
    var deps    = getAncestors(o.name, recipeJson.nodes);
    var uiSet   = new Set();
    deps.forEach(function(n) { var u = recipeToUi[n]; if (u) uiSet.add(u); });
    var uiCount = uiSet.size;
    var pct     = totalUiCount > 0 ? Math.round(uiCount / totalUiCount * 100) : 0;

    // Build per-type breakdown for the card footer
    var typeCounts = {};
    uiSet.forEach(function(uname) {
      var unode = allUiNodes[uname];
      if (!unode) return;
      var lbl = uiTypeLabel(unode.type || 'unknown');
      typeCounts[lbl] = (typeCounts[lbl] || 0) + 1;
    });
    var typeStr = Object.entries(typeCounts)
      .sort(function(a, b) { return b[1] - a[1]; })
      .map(function(e) { return e[0] + ': ' + e[1]; })
      .join(' &middot; ');

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
            '<div class="mt-2 text-muted small">' +
              uiCount + ' nodes (' + pct + '%) &mdash; ' + typeStr +
            '</div>' +
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
  var card = document.getElementById('card_' + name);
  var chk  = document.getElementById('chk_' + name);
  if (card) card.classList.toggle('selected', selectedOutputs.has(name));
  if (chk)  chk.checked = selectedOutputs.has(name);
  var btn = document.getElementById('extractBtn');
  if (btn) btn.disabled = selectedOutputs.size === 0;
}

function selectAll() {
  for (var i = 0; i < outputNodes.length; i++) {
    var name = outputNodes[i].name;
    selectedOutputs.add(name);
    var card = document.getElementById('card_' + name);
    var chk  = document.getElementById('chk_' + name);
    if (card) card.classList.add('selected');
    if (chk)  chk.checked = true;
  }
  var btn = document.getElementById('extractBtn');
  if (btn) btn.disabled = false;
}

function clearAll() {
  for (var i = 0; i < outputNodes.length; i++) {
    var name = outputNodes[i].name;
    selectedOutputs.delete(name);
    var card = document.getElementById('card_' + name);
    var chk  = document.getElementById('chk_' + name);
    if (card) card.classList.remove('selected');
    if (chk)  chk.checked = false;
  }
  var btn = document.getElementById('extractBtn');
  if (btn) btn.disabled = true;
}

// ─── RUN EXTRACTION ───────────────────────────────────────────────────────────
function runExtraction() {
  if (!recipeJson || selectedOutputs.size === 0) return;

  extractedJson = extractSubRecipe(Array.from(selectedOutputs));
  var meta         = extractedJson._meta;
  var totalUiCount = Object.keys((recipeJson.ui && recipeJson.ui.nodes) ? recipeJson.ui.nodes : {}).length;
  var pct          = totalUiCount > 0 ? Math.round((1 - meta.uiNodes / totalUiCount) * 100) : 0;

  // Count ui node types in the extracted result
  var extractedUiNodes = (extractedJson.ui && extractedJson.ui.nodes) ? extractedJson.ui.nodes : {};
  var uiCounts = {};
  for (var uname in extractedUiNodes) {
    var unode = extractedUiNodes[uname];
    if (!unode) continue;
    var t = uiTypeLabel(unode.type || 'unknown');
    uiCounts[t] = (uiCounts[t] || 0) + 1;
  }
  var pills = Object.entries(uiCounts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(e) {
      var rawType = Object.keys(UI_TYPE_LABEL).find(function(k) { return UI_TYPE_LABEL[k] === e[0]; }) || '';
      return '<span class="badge ' + uiTypeBadge(rawType) + ' me-1">' + escHtml(e[0]) + ': ' + e[1] + '</span>';
    }).join('');

  // Child breakdown for extracted result
  var childCounts = countChildActions(extractedJson);
  var childPills = Object.entries(childCounts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(e) {
      return '<span class="badge bg-light text-dark border me-1">' + escHtml(e[0]) + ': ' + e[1] + '</span>';
    }).join('');

  var selLabels = Array.from(selectedOutputs)
    .map(function(n) {
      var o = outputNodes.find(function(x) { return x.name === n; });
      return o ? o.label : n;
    }).join(', ');

  document.getElementById('results').innerHTML =
    '<div class="alert alert-success">' +
      '<strong>Extraction complete</strong> for: <em>' + escHtml(selLabels) + '</em><br>' +
      '<strong>' + meta.uiNodes + '</strong> nodes &middot; ' +
      '<strong>' + meta.connectors + '</strong> connectors &mdash; ' +
      '<strong>' + pct + '%</strong> reduction from ' + totalUiCount + ' total nodes.<br>' +
      '<div class="mt-2">' + pills + '</div>' +
      (childPills ? '<div class="mt-1 small text-muted">Inside Transform blocks &mdash; ' + childPills + '</div>' : '') +
    '</div>';

  var exportJson = buildExportJson();
  document.getElementById('resultJSON').textContent = JSON.stringify(exportJson, null, 2);
  document.getElementById('downloadButton').classList.remove('invisible');
  document.getElementById('copyButton').classList.remove('invisible');

  var collapseResult = document.getElementById('collapseResult');
  if (collapseResult) {
    bootstrap.Collapse.getOrCreateInstance(collapseResult).show();
  }
}

// ─── DOWNLOAD / COPY ──────────────────────────────────────────────────────────
function buildExportJson() {
  if (!extractedJson) return null;
  return { version: extractedJson.version, nodes: extractedJson.nodes, ui: extractedJson.ui };
}

function download() {
  var json = buildExportJson();
  if (!json) return;
  var suffix = Array.from(selectedOutputs)
    .map(function(n) {
      var o = outputNodes.find(function(x) { return x.name === n; });
      return o ? (o.datasetName || o.name) : n;
    }).join('_');
  var blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = 'recipe_extracted__' + suffix + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function copyResult() {
  var json = buildExportJson();
  if (!json) return;
  navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(function() {
    var btn = document.getElementById('copyButton');
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = '✔ Copied!';
      setTimeout(function() { btn.textContent = orig; }, 2000);
    }
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('results').innerHTML =
    '<div class="alert alert-danger">&#9888; ' + escHtml(msg) + '</div>';
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
