// ── Sidebar toggle (mobile/tablet) ──────────────────────────
(function () {
  var toggle = document.getElementById('sidebar-toggle');
  var backdrop = document.getElementById('sidebar-backdrop');
  var sidebar = document.getElementById('sidebar');
  function openSidebar() {
    sidebar.classList.add('open');
    backdrop.classList.add('visible');
    toggle.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    backdrop.classList.remove('visible');
    toggle.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }
  toggle.addEventListener('click', function () {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });
  backdrop.addEventListener('click', closeSidebar);
  // Expose closeSidebar for use by element-select handler
  window._closeSidebar = closeSidebar;
})();

// ── Tooltip positioning helper ──────────────────────────────
function positionTooltip(tooltip, event) {
  var pad = 12;
  var rect = tooltip.getBoundingClientRect();
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var x = event.clientX + pad;
  var y = event.clientY + pad;
  if (x + rect.width > vw - pad) x = event.clientX - rect.width - pad;
  if (y + rect.height > vh - pad) y = event.clientY - rect.height - pad;
  if (x < pad) x = pad;
  if (y < pad) y = pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

// ── Config ──────────────────────────────────────────────────
const API_BASE = window.__API_BASE__ || '';
const POLL_INTERVAL = 5 * 60 * 1000;
const GEN_COLORS = [
  "#4ade80","#38bdf8","#fb923c","#f472b6","#a78bfa",
  "#facc15","#2dd4bf","#f87171","#818cf8","#34d399",
  "#e879f9","#fbbf24","#22d3ee","#fb7185","#a3e635",
  "#c084fc","#94a3b8"
];

// ── State ───────────────────────────────────────────────────
let state = { elements: 0, recipes: 0, first_discoveries: 0, generation_distribution: {}, last_run: null };
let discoveries = [];
let workerRuns = [];
let firstDiscoveries = [];
let currentView = 'graph';
let currentSort = 'name';
let sortAsc = true;
let searchTerm = '';
let nodeSizeMode = 'gen-asc'; // gen-asc | gen-desc | connections | recipes

// ── Safe DOM helpers ────────────────────────────────────────
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'textContent') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'className') e.className = v;
    else e.setAttribute(k, v);
  });
  if (children) children.forEach(c => { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}

function genColor(gen) {
  return GEN_COLORS[Math.min(gen, GEN_COLORS.length - 1)];
}

function timeAgo(iso) {
  if (!iso) return '--';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// ── API ─────────────────────────────────────────────────────
async function fetchJSON(path, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(API_BASE + path, { signal: controller.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + (text ? ': ' + text.substring(0, 200) : ''));
    }
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshState() {
  try {
    state = await fetchJSON('/api/state');
    updateStats();
    setStatus('ok', 'Updated ' + new Date().toLocaleTimeString());
  } catch (e) {
    setStatus('error', 'Failed: ' + e.message);
  }
}

async function refreshDiscoveries() {
  try {
    const data = await fetchJSON('/api/discoveries?limit=500');
    discoveries = data.discoveries || [];
    renderElementList();
    updateGraph(discoveries);
    if (currentView !== 'graph') renderContentPane();
  } catch (e) {
    console.error('Discoveries fetch failed:', e);
    setStatus('error', 'Discoveries load failed');
  }
}

async function refreshFirstDiscoveries() {
  try {
    const data = await fetchJSON('/api/first-discoveries');
    firstDiscoveries = data.discoveries || [];
    if (currentView === 'first-disc') renderContentPane();
  } catch (e) {
    console.error('First discoveries fetch failed:', e);
    setStatus('error', 'First discoveries load failed');
  }
}

async function refreshWorkers() {
  try {
    const data = await fetchJSON('/api/workers');
    workerRuns = data.runs || [];
    if (currentView === 'workers') renderContentPane();
  } catch (e) {
    console.error('Workers fetch failed:', e);
    setStatus('error', 'Worker runs load failed');
  }
}

async function refreshAll() {
  // Always refresh state and discoveries; only fetch view-specific data if that view is active
  const tasks = [refreshState(), refreshDiscoveries()];
  if (currentView === 'first-disc') tasks.push(refreshFirstDiscoveries());
  if (currentView === 'workers') tasks.push(refreshWorkers());
  await Promise.all(tasks);
}

// ── Status ──────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  dot.className = 'dot' + (type === 'error' ? ' error' : '');
  txt.textContent = text;
}

function updateStats() {
  document.getElementById('stat-elements').textContent = (state.elements || 0).toLocaleString();
  document.getElementById('stat-recipes').textContent = (state.recipes || 0).toLocaleString();
  document.getElementById('stat-firsts').textContent = (state.first_discoveries || 0).toLocaleString();
  const genDist = state.generation_distribution || {};
  const maxGen = Object.keys(genDist).length ? Math.max(...Object.keys(genDist).map(Number)) : 0;
  document.getElementById('stat-maxgen').textContent = maxGen;
  document.getElementById('stat-lastrun').textContent = state.last_run ? timeAgo(state.last_run.started_at) : '--';
}

// ── Element list (safe DOM) ─────────────────────────────────
function renderElementList() {
  const list = document.getElementById('element-list');
  list.replaceChildren(); // Clear safely

  // Use server search results if available, otherwise filter local discoveries
  let items;
  if (_serverSearchResults !== null && searchTerm.trim().length >= 2) {
    items = [..._serverSearchResults];
  } else {
    items = [...discoveries];
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      items = items.filter(d => (d.element || '').toLowerCase().includes(q));
    }
  }
  const dir = sortAsc ? 1 : -1;
  if (currentSort === 'name') items.sort((a,b) => dir * (a.element||'').localeCompare(b.element||''));
  else if (currentSort === 'gen') items.sort((a,b) => dir * ((a.generation||0) - (b.generation||0)));
  else if (currentSort === 'new') items.sort((a,b) => dir * ((a.is_new?1:0) - (b.is_new?1:0)));

  const frag = document.createDocumentFragment();
  items.forEach(d => {
    const gen = d.generation || 0;
    const row = el('div', {className: 'element-item'}, [
      el('span', {className: 'element-dot', style: {background: genColor(gen)}}),
      d.emoji ? el('span', {className: 'element-emoji', textContent: d.emoji}) : null,
      el('span', {className: 'element-name', textContent: d.element || ''}),
      d.is_new ? el('span', {className: 'element-new', textContent: 'FIRST'}) : null,
      el('span', {className: 'element-gen', textContent: 'G' + gen}),
    ]);
    row.dataset.id = d.element || '';
    frag.appendChild(row);
  });
  list.appendChild(frag);
}

// ── Graph ───────────────────────────────────────────────────
let simulation = null;
let _graphState = null; // shared graph state for selection/detail features
let selectedNode = null;
let focusTimeout = null;
const BASE_SET = new Set(['Water', 'Fire', 'Wind', 'Earth']);
let _prevDiscoveryKeys = new Set(); // tracks rendered discoveries for incremental updates

/**
 * The graph is the only part of the dashboard that needs d3. If the script
 * fails to load, say so in the graph pane and let the element list, analytics,
 * discoveries, and worker views carry on — previously a missing d3 threw out
 * of refreshDiscoveries() and left the whole page blank.
 */
let _graphUnavailableAnnounced = false;

function graphAvailable() {
  if (typeof d3 !== 'undefined') return true;
  showGraphUnavailable();
  return false;
}

/**
 * Renders the notice in place of the graph. This runs on every entry to the
 * graph view rather than once: the graph view hides #content-pane, and
 * switchView() re-renders that pane for the other three views, so a
 * write-once message would be both invisible and overwritten.
 */
function showGraphUnavailable() {
  const pane = document.getElementById('content-pane');
  if (pane && currentView === 'graph') {
    pane.textContent = 'The graph library failed to load, so the element graph is unavailable. The other views still work.';
    pane.classList.add('pane-notice', 'visible');
  }
  if (!_graphUnavailableAnnounced) {
    _graphUnavailableAnnounced = true;
    setStatus('error', 'Graph library unavailable');
  }
}

function updateGraph(newDiscoveries) {
  if (!newDiscoveries.length) return;
  if (!graphAvailable()) return;

  // Build set of current discovery keys
  const currentKeys = new Set(newDiscoveries.map(d => d.element));

  // If no graph exists yet, do a full render
  if (!_graphState) {
    renderGraph();
    return;
  }

  // Find genuinely new elements not yet rendered
  const newElements = newDiscoveries.filter(d => !_prevDiscoveryKeys.has(d.element));

  // Nothing new — skip to avoid jitter
  if (newElements.length === 0) return;

  const { svg, g, zoom, nodeMap, links, nodes, nodeEls, linkEls, width, height } = _graphState;

  // Add new nodes
  newElements.forEach(d => {
    if (!nodeMap.has(d.element)) {
      const node = { id: d.element, generation: d.generation||0, emoji: d.emoji||'', is_new: d.is_new||false, recipe: d.recipe||'base' };
      nodeMap.set(d.element, node);
      nodes.push(node);
    }
  });

  // Add new links for new elements
  newElements.forEach(d => {
    if (d.recipe && d.recipe !== 'base' && d.recipe.includes(' + ')) {
      const parts = d.recipe.split(' + ');
      if (parts.length === 2) {
        parts.forEach(p => {
          if (!nodeMap.has(p)) {
            const inferred = { id: p, generation: 0, emoji: '', is_new: false, recipe: 'base', _inferred: true };
            nodeMap.set(p, inferred);
            nodes.push(inferred);
          }
        });
        links.push({ source: nodeMap.get(parts[0]), target: nodeMap.get(d.element) });
        links.push({ source: nodeMap.get(parts[1]), target: nodeMap.get(d.element) });
      }
    }
  });

  // Recompute metrics
  const connCount = new Map();
  const resultCount = new Map();
  nodes.forEach(n => { connCount.set(n.id, 0); resultCount.set(n.id, 0); });
  links.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    connCount.set(src, (connCount.get(src)||0) + 1);
    connCount.set(tgt, (connCount.get(tgt)||0) + 1);
    resultCount.set(tgt, (resultCount.get(tgt)||0) + 1);
  });
  const maxConn = Math.max(1, ...connCount.values());
  const maxResult = Math.max(1, ...resultCount.values());
  const maxGen = Math.max(1, ...nodes.map(n => n.generation));
  nodes.forEach(n => { n._conn = connCount.get(n.id)||0; n._results = resultCount.get(n.id)||0; });

  function nodeRadius(d) {
    if (d._inferred) return 4;
    switch (nodeSizeMode) {
      case 'gen-desc':
        return 6 + Math.round(8 * (1 - d.generation / maxGen));
      case 'connections':
        return 5 + Math.round(12 * (d._conn / maxConn));
      case 'recipes':
        return 5 + Math.round(12 * (d._results / maxResult));
      case 'gen-asc':
      default:
        return d.generation === 0 ? 12 : 6 + Math.min(d.generation, 8);
    }
  }
  _graphState.nodeRadius = nodeRadius;

  // Use D3 join to add new DOM elements
  const updatedLinks = g.selectAll('.link-line').data(links);
  const newLinkEls = updatedLinks.enter().append('line').attr('class', 'link-line');
  const mergedLinks = updatedLinks.merge(newLinkEls);
  _graphState.linkEls = mergedLinks;

  const updatedNodes = g.selectAll('.node-g').data(nodes);
  const newNodeGs = updatedNodes.enter().append('g').attr('class', 'node-g');
  newNodeGs.append('circle')
    .attr('class', d => 'node-circle' + (d.generation===0 && !d._inferred?' base':''))
    .attr('r', nodeRadius)
    .attr('fill', d => d._inferred ? '#555' : genColor(d.generation))
    .attr('opacity', d => d._inferred ? 0.5 : 1);
  newNodeGs.append('text').attr('class','node-label')
    .attr('dy', d => d._inferred ? -6 : -(4 + nodeRadius(d)))
    .attr('font-size', d => d._inferred ? '8px' : '10px')
    .attr('opacity', d => d._inferred ? 0.5 : 1)
    .text(d => d.id);

  const mergedNodes = updatedNodes.merge(newNodeGs);
  _graphState.nodeEls = mergedNodes;

  // Tooltip on new nodes
  const tooltip = document.getElementById('tooltip');
  newNodeGs.on('mouseenter', (event, d) => {
    tooltip.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = d.id;
    tooltip.appendChild(strong);
    if (d.emoji) tooltip.appendChild(document.createTextNode(' ' + d.emoji));
    tooltip.appendChild(document.createElement('br'));
    tooltip.appendChild(el('span', {style: {color: '#a5b4fc'}, textContent: d.recipe}));
    tooltip.appendChild(document.createElement('br'));
    tooltip.appendChild(el('span', {style: {color: '#888'}, textContent: d._inferred ? 'Generation unknown' : 'Generation ' + d.generation}));
    if (d.is_new) { tooltip.appendChild(document.createElement('br')); tooltip.appendChild(el('span', {style: {color: '#f59e0b'}, textContent: 'First Discovery'})); }
    tooltip.classList.add('visible');
    positionTooltip(tooltip, event);
  }).on('mouseleave', () => tooltip.classList.remove('visible'));

  // Click on new nodes
  newNodeGs.on('click', (event, d) => {
    event.stopPropagation();
    selectElement(d.id);
  });

  // Re-apply dimming if a node is selected
  if (selectedNode) applyDimming(selectedNode);

  // Update simulation with new data
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.alpha(0.3).restart();

  // Update tick handler with merged selections
  simulation.on('tick', () => {
    mergedLinks.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    mergedNodes.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Update tracked keys
  _prevDiscoveryKeys = currentKeys;
}

function renderGraph() {
  if (!graphAvailable()) return;
  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();
  selectedNode = null;
  closeDetailPanel();
  if (!discoveries.length) return;

  const width = svg.node().getBoundingClientRect().width;
  const height = svg.node().getBoundingClientRect().height;

  const nodeMap = new Map();
  const links = [];
  discoveries.forEach(d => {
    nodeMap.set(d.element, { id: d.element, generation: d.generation||0, emoji: d.emoji||'', is_new: d.is_new||false, recipe: d.recipe||'base' });
  });
  discoveries.forEach(d => {
    if (d.recipe && d.recipe !== 'base' && d.recipe.includes(' + ')) {
      const parts = d.recipe.split(' + ');
      if (parts.length === 2) {
        parts.forEach(p => {
          if (!nodeMap.has(p)) nodeMap.set(p, { id: p, generation: 0, emoji: '', is_new: false, recipe: 'base', _inferred: true });
        });
        links.push({ source: parts[0], target: d.element });
        links.push({ source: parts[1], target: d.element });
      }
    }
  });
  const nodes = Array.from(nodeMap.values());

  // Compute connection counts (in+out degree) and recipe-result counts per node
  const connCount = new Map(); // total connections (edges in + out)
  const resultCount = new Map(); // how many recipes produce this element
  nodes.forEach(n => { connCount.set(n.id, 0); resultCount.set(n.id, 0); });
  links.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    connCount.set(src, (connCount.get(src)||0) + 1);
    connCount.set(tgt, (connCount.get(tgt)||0) + 1);
    resultCount.set(tgt, (resultCount.get(tgt)||0) + 1);
  });
  const maxConn = Math.max(1, ...connCount.values());
  const maxResult = Math.max(1, ...resultCount.values());
  const maxGen = Math.max(1, ...nodes.map(n => n.generation));
  nodes.forEach(n => { n._conn = connCount.get(n.id)||0; n._results = resultCount.get(n.id)||0; });

  function nodeRadius(d) {
    if (d._inferred) return 4;
    switch (nodeSizeMode) {
      case 'gen-desc': // oldest = biggest
        return 6 + Math.round(8 * (1 - d.generation / maxGen));
      case 'connections':
        return 5 + Math.round(12 * (d._conn / maxConn));
      case 'recipes':
        return 5 + Math.round(12 * (d._results / maxResult));
      case 'gen-asc': // newest = biggest (default)
      default:
        return d.generation === 0 ? 12 : 6 + Math.min(d.generation, 8);
    }
  }

  if (simulation) simulation.stop();
  const isLarge = nodes.length > 500;
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(isLarge ? 30 : 40).strength(0.3))
    .force('charge', d3.forceManyBody().strength(isLarge ? -30 : -60).distanceMax(isLarge ? 150 : 300))
    .force('center', d3.forceCenter(width/2, height/2))
    .force('collision', d3.forceCollide(isLarge ? 8 : 12))
    .alphaDecay(isLarge ? 0.05 : 0.03);

  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.1,5]).on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom);
  // Click on background to deselect
  svg.on('click', () => { if (selectedNode) { selectedNode = null; clearDimming(); closeDetailPanel(); } });

  const linkEls = g.selectAll('.link-line').data(links).join('line').attr('class','link-line');
  const nodeEls = g.selectAll('.node-g').data(nodes).join('g').attr('class','node-g');
  nodeEls.append('circle')
    .attr('class', d => 'node-circle' + (d.generation===0 && !d._inferred?' base':''))
    .attr('r', nodeRadius)
    .attr('fill', d => d._inferred ? '#555' : genColor(d.generation))
    .attr('opacity', d => d._inferred ? 0.5 : 1);
  nodeEls.append('text').attr('class','node-label')
    .attr('dy', d => d._inferred ? -6 : -(4 + nodeRadius(d)))
    .attr('font-size', d => d._inferred ? '8px' : '10px')
    .attr('opacity', d => d._inferred ? 0.5 : 1)
    .text(d => d.id);

  // Save graph state for selection features
  _graphState = { svg, g, zoom, nodeMap, links, nodes, nodeEls, linkEls, width, height, nodeRadius };

  // Reset incremental tracking after full rebuild
  _prevDiscoveryKeys = new Set(discoveries.map(d => d.element));

  // Tooltip on hover
  const tooltip = document.getElementById('tooltip');
  nodeEls.on('mouseenter', (event, d) => {
    tooltip.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = d.id;
    tooltip.appendChild(strong);
    if (d.emoji) tooltip.appendChild(document.createTextNode(' ' + d.emoji));
    tooltip.appendChild(document.createElement('br'));
    tooltip.appendChild(el('span', {style: {color: '#a5b4fc'}, textContent: d.recipe}));
    tooltip.appendChild(document.createElement('br'));
    tooltip.appendChild(el('span', {style: {color: '#888'}, textContent: d._inferred ? 'Generation unknown' : 'Generation ' + d.generation}));
    if (d.is_new) { tooltip.appendChild(document.createElement('br')); tooltip.appendChild(el('span', {style: {color: '#f59e0b'}, textContent: 'First Discovery'})); }
    tooltip.classList.add('visible');
    positionTooltip(tooltip, event);
  }).on('mouseleave', () => tooltip.classList.remove('visible'));

  // Click on node to select
  nodeEls.on('click', (event, d) => {
    event.stopPropagation();
    selectElement(d.id);
  });

  simulation.on('tick', () => {
    linkEls.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    nodeEls.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Auto-fit all nodes in viewport when simulation settles
  simulation.on('end', () => {
    if (!nodes.length || !width || !height) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(d => { if (d.x < minX) minX = d.x; if (d.y < minY) minY = d.y; if (d.x > maxX) maxX = d.x; if (d.y > maxY) maxY = d.y; });
    const pad = 60, bw = (maxX - minX + pad * 2) || 1, bh = (maxY - minY + pad * 2) || 1;
    const scale = Math.min(width / bw, height / bh, 1.5) || 1;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const tx = width / 2 - cx * scale, ty = height / 2 - cy * scale;
    if (isFinite(tx) && isFinite(ty) && isFinite(scale)) {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }
  });
}

// ── Node selection & detail panel ──────────────────────────
function selectElement(id) {
  if (!_graphState) return;
  const { nodeMap } = _graphState;
  if (selectedNode === id) { selectedNode = null; clearDimming(); closeDetailPanel(); return; }
  selectedNode = id;
  applyDimming(id);
  focusNode(id);
  showDetailPanel(id);
  // Highlight sidebar row
  document.querySelectorAll('.element-item').forEach(r => r.classList.toggle('selected', r.dataset.id === id));
}

function focusNode(id) {
  if (!_graphState) return;
  const { nodeMap, svg, zoom, nodeEls, width, height } = _graphState;
  const node = nodeMap.get(id);
  if (!node || node.x == null) return;
  svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(width/2 - node.x, height/2 - node.y));
  // Pulsing focus ring
  nodeEls.selectAll('.focus-ring').remove();
  nodeEls.selectAll('circle.node-circle').classed('focused', false);
  clearTimeout(focusTimeout);
  const nodeG = nodeEls.filter(d => d.id === id);
  nodeG.select('circle.node-circle').classed('focused', true);
  nodeG.insert('circle', 'circle').attr('class', 'focus-ring').attr('r', 18);
  focusTimeout = setTimeout(() => {
    nodeEls.selectAll('.focus-ring').remove();
    nodeEls.selectAll('circle.node-circle').classed('focused', false);
  }, 5000);
}

function getConnected(id) {
  if (!_graphState) return new Set([id]);
  const connected = new Set([id]);
  _graphState.links.forEach(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    if (sid === id) connected.add(tid);
    if (tid === id) connected.add(sid);
  });
  return connected;
}

function applyDimming(focusId) {
  if (!_graphState) return;
  const connected = getConnected(focusId);
  _graphState.nodeEls.selectAll('circle.node-circle').classed('dimmed', n => !connected.has(n.id)).classed('highlighted', n => n.id === focusId);
  _graphState.nodeEls.selectAll('text').classed('dimmed', n => !connected.has(n.id));
  _graphState.linkEls.classed('dimmed', l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    return !connected.has(sid) || !connected.has(tid);
  }).classed('highlighted', l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    return sid === focusId || tid === focusId;
  });
}

function clearDimming() {
  if (!_graphState) return;
  _graphState.nodeEls.selectAll('circle.node-circle').classed('dimmed', false).classed('highlighted', false);
  _graphState.nodeEls.selectAll('text').classed('dimmed', false);
  _graphState.linkEls.classed('dimmed', false).classed('highlighted', false);
}

// ── Recipe chain & critical path ───────────────────────────
function computeCriticalPath(nodeMap, elementId) {
  const recipes = new Map();
  nodeMap.forEach((n, name) => {
    if (n.recipe && n.recipe !== 'base' && n.recipe.includes(' + ')) {
      const parts = n.recipe.split(' + ');
      if (parts.length === 2) recipes.set(name, [parts[0], parts[1]]);
    }
  });
  const depth = new Map();
  const critParent = new Map();
  function getDepth(name) {
    if (depth.has(name)) return depth.get(name);
    if (BASE_SET.has(name) || !recipes.has(name)) { depth.set(name, 0); return 0; }
    depth.set(name, -1);
    const [a, b] = recipes.get(name);
    const da = getDepth(a), db = getDepth(b);
    const d = 1 + Math.max(da, db);
    depth.set(name, d);
    critParent.set(name, da >= db ? a : b);
    return d;
  }
  getDepth(elementId);
  const criticalSet = new Set();
  let current = elementId;
  while (current) { criticalSet.add(current); current = critParent.get(current); }
  return { criticalSet, depth: depth.get(elementId) || 0 };
}

async function fetchAllRecipes(elementId) {
  try {
    const data = await fetchJSON('/api/discoveries/' + encodeURIComponent(elementId));
    return (data.recipes || []).map(r => r.first + ' + ' + r.second);
  } catch (e) {
    console.warn('Recipe fetch failed for', elementId, '- using local data:', e.message);
    const node = _graphState ? _graphState.nodeMap.get(elementId) : null;
    if (node && node.recipe && node.recipe !== 'base') return [node.recipe];
    return [];
  }
}

// ── Element card (partial, bottom of screen) ───────────────
let _chainGraphState = null;

function showDetailPanel(id) {
  if (!_graphState) return;
  const { nodeMap } = _graphState;
  const node = nodeMap.get(id);
  if (!node) return;

  // Close any open overlay first
  document.getElementById('chain-overlay').classList.remove('visible');

  const card = document.getElementById('element-card');
  card.replaceChildren();

  // Header
  const header = el('div', {className: 'card-header'}, [
    el('div', {className: 'card-name'}, [
      node.emoji ? el('span', {textContent: node.emoji}) : null,
      el('span', {textContent: node.id}),
      node.is_new ? el('span', {className: 'element-new', textContent: 'FIRST', style: {fontSize: '10px'}}) : null,
    ]),
    el('span', {className: 'card-close', textContent: '\u00d7'}),
  ]);
  header.querySelector('.card-close').addEventListener('click', () => { selectedNode = null; clearDimming(); closeDetailPanel(); });
  card.appendChild(header);

  // Meta
  card.appendChild(el('div', {className: 'card-meta'}, [
    el('div', null, ['Generation: ', el('span', {textContent: node._inferred ? 'unknown' : String(node.generation), style: {color: node._inferred ? '#555' : genColor(node.generation)}})]),
    el('div', null, ['Recipe: ', el('span', {textContent: node._inferred ? 'not loaded' : node.recipe})]),
  ]));

  // Action buttons → open full overlay
  const actions = el('div', {className: 'card-actions'});
  const graphBtn = el('button', {textContent: 'Full Graph'});
  const critBtn = el('button', {textContent: 'Critical Path'});
  actions.appendChild(graphBtn);
  actions.appendChild(critBtn);
  card.appendChild(actions);

  graphBtn.addEventListener('click', () => openChainOverlay(id, 'graph'));
  critBtn.addEventListener('click', () => openChainOverlay(id, 'critical'));

  card.classList.add('visible');
}

// ── Chain building via server-side endpoint ─────────────────
async function buildFullChain(targetId) {
  const data = await fetchJSON('/api/chain/' + encodeURIComponent(targetId));
  const chainNodes = new Map();
  (data.nodes || []).forEach(n => {
    chainNodes.set(n.element, {
      id: n.element, generation: n.generation || 0,
      recipe: n.recipe || 'base', emoji: n.emoji || '',
      isTarget: n.element === targetId,
    });
  });
  const chainEdges = (data.edges || []).map(e => ({ source: e.source, target: e.target }));
  return { chainNodes, chainEdges };
}

// ── Chain overlay (full screen) ────────────────────────────
let _currentChainTarget = null;
let _currentChainMode = null;
let _cachedChainData = null; // { chainNodes, chainEdges, criticalSet, depth, buildOrder }

async function openChainOverlay(id, mode) {
  _currentChainTarget = id;
  _currentChainMode = mode;
  const overlay = document.getElementById('chain-overlay');
  const container = document.getElementById('chain-graph-area');
  const stepsEl = document.getElementById('build-order-steps');

  // Show overlay immediately with loading state
  overlay.classList.add('visible');
  container.replaceChildren(el('div', {className: 'loading', textContent: 'Building dependency tree...'}));
  stepsEl.replaceChildren(el('div', {style: {color: '#888', fontSize: '11px', padding: '8px'}, textContent: 'Loading...'}));

  // Header
  const node = (_graphState && _graphState.nodeMap.get(id)) || { id, generation: 0, emoji: '' };
  const titleEl = document.getElementById('chain-title');
  titleEl.replaceChildren(el('span', {textContent: (node.emoji || '') + ' ' + id}));

  // Close handler
  document.getElementById('chain-close-btn').onclick = () => closeChainOverlay();

  // Build full chain via server-side endpoint (single API call)
  let chainNodes, chainEdges;
  try {
    ({ chainNodes, chainEdges } = await buildFullChain(id));
  } catch (err) {
    container.replaceChildren(el('div', {className: 'loading', textContent: 'Failed to load dependency tree: ' + err.message}));
    stepsEl.replaceChildren(el('div', {style: {color: '#ef4444', fontSize: '11px', padding: '8px'}, textContent: 'Error: ' + err.message}));
    return;
  }

  // Update meta
  const metaEl = document.getElementById('chain-meta');
  metaEl.replaceChildren();
  metaEl.appendChild(el('span', {textContent: node._inferred ? 'Gen ?' : 'Gen ' + (node.generation || 0), style: {color: node._inferred ? '#555' : genColor(node.generation || 0)}}));
  metaEl.appendChild(el('span', {textContent: chainNodes.size + ' nodes'}));
  metaEl.appendChild(el('span', {textContent: chainEdges.length + ' edges'}));

  // Compute critical path from the full chain
  const { criticalSet, depth } = computeCriticalPathFromChain(chainNodes, id);
  const buildOrder = computeBuildOrder(chainNodes, id);

  // Cache for resize re-render without re-fetching
  _cachedChainData = { chainNodes, chainEdges, criticalSet, depth, buildOrder };

  // Controls
  const controlsEl = document.getElementById('chain-controls');
  controlsEl.replaceChildren();
  const allBtn = el('button', {className: mode === 'graph' ? 'active' : '', textContent: 'Full Graph'});
  const critBtn = el('button', {className: mode === 'critical' ? 'active' : '', textContent: 'Critical Path'});
  const recipesBtn = el('button', {className: mode === 'recipes' ? 'active' : '', textContent: 'All Recipes'});
  controlsEl.appendChild(allBtn);
  controlsEl.appendChild(critBtn);
  controlsEl.appendChild(recipesBtn);

  // Render build order sidebar
  function renderBuildOrderSidebar() {
    stepsEl.replaceChildren();
    buildOrder.forEach((step, i) => {
      const isCrit = criticalSet.has(step.element);
      const div = el('div', {className: 'build-step' + (isCrit ? ' step-highlight' : '')}, [
        el('div', {className: 'step-num', textContent: 'Step ' + (i + 1) + ' \u2022 Gen ' + step.generation}),
        el('div', null, [
          el('span', {className: 'step-recipe', textContent: step.recipe + ' = '}),
          el('span', {className: 'step-result', textContent: step.element}),
        ]),
      ]);
      div.addEventListener('mouseenter', () => highlightBuildStep(step));
      div.addEventListener('mouseleave', () => clearChainHighlight(false));
      stepsEl.appendChild(div);
    });
  }

  // Render graph
  container.replaceChildren();
  requestAnimationFrame(() => {
    renderChainGraph(chainNodes, chainEdges, id, criticalSet, depth);
    if (mode === 'critical') applyCriticalPathHighlight(criticalSet);
  });

  if (mode === 'recipes') {
    loadAllRecipesSidebar(id, stepsEl);
  } else {
    renderBuildOrderSidebar();
  }

  // Button handlers
  allBtn.addEventListener('click', () => {
    allBtn.classList.add('active'); critBtn.classList.remove('active'); recipesBtn.classList.remove('active');
    clearChainHighlight(true);
    renderBuildOrderSidebar();
  });
  critBtn.addEventListener('click', () => {
    critBtn.classList.add('active'); allBtn.classList.remove('active'); recipesBtn.classList.remove('active');
    applyCriticalPathHighlight(criticalSet);
    renderBuildOrderSidebar();
  });
  recipesBtn.addEventListener('click', () => {
    recipesBtn.classList.add('active'); allBtn.classList.remove('active'); critBtn.classList.remove('active');
    loadAllRecipesSidebar(id, stepsEl);
  });
}

async function loadAllRecipesSidebar(id, stepsEl) {
  stepsEl.replaceChildren(el('div', {style: {color: '#888', fontSize: '11px', padding: '8px'}, textContent: 'Loading all recipes...'}));
  const recipes = await fetchAllRecipes(id);
  stepsEl.replaceChildren();
  if (!recipes.length) {
    stepsEl.appendChild(el('div', {style: {color: '#666', fontSize: '11px', padding: '8px'}, textContent: 'Base element \u2014 no recipes'}));
  } else {
    stepsEl.appendChild(el('div', {style: {color: '#888', fontSize: '10px', padding: '4px 8px', marginBottom: '4px'}, textContent: recipes.length + ' recipe(s) produce ' + id}));
    recipes.forEach((r, i) => {
      stepsEl.appendChild(el('div', {className: 'build-step'}, [
        el('div', {className: 'step-num', textContent: '#' + (i + 1)}),
        el('div', null, [
          el('span', {className: 'step-recipe', textContent: r + ' = '}),
          el('span', {className: 'step-result', textContent: id}),
        ]),
      ]));
    });
  }
}

function computeCriticalPathFromChain(chainNodes, elementId) {
  return computeCriticalPath(chainNodes, elementId);
}

function rerenderChainOverlay() {
  if (!_cachedChainData || !_currentChainTarget) return;
  var { chainNodes, chainEdges, criticalSet, depth } = _cachedChainData;
  var container = document.getElementById('chain-graph-area');
  container.replaceChildren();
  renderChainGraph(chainNodes, chainEdges, _currentChainTarget, criticalSet, depth);
  if (_currentChainMode === 'critical') applyCriticalPathHighlight(criticalSet);
}

function closeChainOverlay() {
  document.getElementById('chain-overlay').classList.remove('visible');
  _chainGraphState = null;
  _currentChainTarget = null;
  _currentChainMode = null;
  _cachedChainData = null;
}

function renderChainGraph(chainNodes, chainEdges, targetId, criticalSet, depth) {
  const container = document.getElementById('chain-graph-area');
  container.replaceChildren();

  const W = container.clientWidth || 600;
  const H = container.clientHeight || 400;
  const margin = { top: 30, right: 30, bottom: 30, left: 60 };

  const svg = d3.select(container).append('svg').attr('width', W).attr('height', H);

  // Arrow marker
  const defs = svg.append('defs');
  defs.append('marker').attr('id', 'chain-arrow').attr('viewBox', '0 0 10 6').attr('refX', 10).attr('refY', 3)
    .attr('markerWidth', 8).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,0 L10,3 L0,6').attr('fill', '#3a3a5a');
  defs.append('marker').attr('id', 'chain-arrow-hl').attr('viewBox', '0 0 10 6').attr('refX', 10).attr('refY', 3)
    .attr('markerWidth', 8).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,0 L10,3 L0,6').attr('fill', '#f59e0b');

  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.3, 3]).on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom);

  // Group by generation for layered layout
  const nodeArr = Array.from(chainNodes.values());
  const genGroups = {};
  nodeArr.forEach(n => {
    const gen = n.generation || 0;
    if (!genGroups[gen]) genGroups[gen] = [];
    genGroups[gen].push(n);
  });
  const gens = Object.keys(genGroups).map(Number).sort((a, b) => a - b);

  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;
  const layerH = gens.length > 1 ? innerH / (gens.length - 1) : 0;

  // Position nodes: gen 0 at bottom, highest gen at top
  const positions = new Map();
  gens.forEach((gen, layerIdx) => {
    const group = genGroups[gen];
    group.sort((a, b) => a.id.localeCompare(b.id));
    const y = margin.top + innerH - layerIdx * layerH;
    const spacing = innerW / (group.length + 1);
    group.forEach((n, i) => {
      positions.set(n.id, { x: margin.left + spacing * (i + 1), y });
    });
  });

  // Generation guide lines
  gens.forEach((gen, layerIdx) => {
    const y = margin.top + innerH - layerIdx * layerH;
    g.append('line').attr('class', 'gen-line')
      .attr('x1', margin.left - 10).attr('y1', y)
      .attr('x2', W - margin.right + 10).attr('y2', y);
    g.append('text').attr('class', 'gen-label')
      .attr('x', margin.left - 15).attr('y', y + 4)
      .attr('text-anchor', 'end').text('Gen ' + gen);
  });

  // Edges (curved paths)
  const linkEls = g.selectAll('path.chain-link').data(chainEdges).enter().append('path')
    .attr('class', 'chain-link')
    .attr('marker-end', 'url(#chain-arrow)')
    .attr('d', d => {
      const s = positions.get(d.source);
      const t = positions.get(d.target);
      if (!s || !t) return '';
      const dy = (t.y - s.y) * 0.4;
      return `M${s.x},${s.y} C${s.x},${s.y + dy} ${t.x},${t.y - dy} ${t.x},${t.y}`;
    });

  // Nodes
  const nodeGroups = g.selectAll('g.chain-node').data(nodeArr, d => d.id).enter().append('g')
    .attr('class', d => 'chain-node' + (d.isTarget ? ' target' : ''))
    .attr('transform', d => {
      const p = positions.get(d.id);
      return `translate(${p.x},${p.y})`;
    });

  nodeGroups.append('circle')
    .attr('r', d => d.isTarget ? 14 : BASE_SET.has(d.id) ? 11 : 9)
    .attr('fill', d => genColor(d.generation));

  nodeGroups.append('text')
    .attr('dy', d => d.isTarget ? 24 : BASE_SET.has(d.id) ? 21 : 19)
    .text(d => d.id);

  // Recipe labels above non-base nodes
  nodeGroups.filter(d => d.recipe && d.recipe !== 'base')
    .append('text').attr('class', 'recipe-label')
    .attr('dy', d => -(d.isTarget ? 18 : 14))
    .text(d => d.recipe);

  // Save state for highlight functions
  _chainGraphState = { g, nodeGroups, linkEls, chainNodes, criticalSet };

  // Auto-fit
  const bounds = g.node().getBBox();
  if (bounds.width > 0 && bounds.height > 0) {
    const pad = 40;
    const scale = Math.min(W / (bounds.width + pad * 2), H / (bounds.height + pad * 2), 1.5);
    const tx = W / 2 - (bounds.x + bounds.width / 2) * scale;
    const ty = H / 2 - (bounds.y + bounds.height / 2) * scale;
    if (isFinite(tx) && isFinite(ty) && isFinite(scale)) {
      svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }
  }
}

function applyCriticalPathHighlight(criticalSet) {
  if (!_chainGraphState) return;
  const { nodeGroups, linkEls } = _chainGraphState;
  nodeGroups.classed('path-highlight', d => criticalSet.has(d.id)).classed('path-dimmed', d => !criticalSet.has(d.id));
  linkEls.classed('path-highlight', d => criticalSet.has(d.source) && criticalSet.has(d.target))
    .classed('path-dimmed', d => !(criticalSet.has(d.source) && criticalSet.has(d.target)))
    .attr('marker-end', d => (criticalSet.has(d.source) && criticalSet.has(d.target)) ? 'url(#chain-arrow-hl)' : 'url(#chain-arrow)');
}

function highlightBuildStep(step) {
  if (!_chainGraphState) return;
  const { nodeGroups, linkEls } = _chainGraphState;
  const related = new Set([step.element, step.a, step.b]);
  nodeGroups.classed('path-highlight', d => related.has(d.id)).classed('path-dimmed', d => !related.has(d.id));
  linkEls.classed('path-highlight', d => d.target === step.element && (d.source === step.a || d.source === step.b))
    .classed('path-dimmed', d => !(d.target === step.element && (d.source === step.a || d.source === step.b)))
    .attr('marker-end', d => (d.target === step.element && (d.source === step.a || d.source === step.b)) ? 'url(#chain-arrow-hl)' : 'url(#chain-arrow)');
}

function clearChainHighlight(full) {
  if (!_chainGraphState) return;
  const { nodeGroups, linkEls } = _chainGraphState;
  nodeGroups.classed('path-highlight', false).classed('path-dimmed', false);
  linkEls.classed('path-highlight', false).classed('path-dimmed', false).attr('marker-end', 'url(#chain-arrow)');
}

function computeBuildOrder(chainNodes, targetId) {
  const recipes = new Map();
  chainNodes.forEach((n, name) => {
    if (n.recipe && n.recipe !== 'base' && n.recipe.includes(' + ')) {
      const parts = n.recipe.split(' + ');
      if (parts.length === 2) recipes.set(name, [parts[0], parts[1]]);
    }
  });
  const order = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    if (recipes.has(name)) {
      const [a, b] = recipes.get(name);
      visit(a);
      visit(b);
      order.push({ element: name, a, b, recipe: a + ' + ' + b, generation: chainNodes.get(name) ? chainNodes.get(name).generation : 0 });
    }
  }
  visit(targetId);
  return order;
}

function closeDetailPanel() {
  document.getElementById('element-card').classList.remove('visible');
  document.getElementById('chain-overlay').classList.remove('visible');
  document.querySelectorAll('.element-item').forEach(r => r.classList.remove('selected'));
  _chainGraphState = null;
}

// Sidebar element click → focus graph node
document.getElementById('element-list').addEventListener('click', (e) => {
  const row = e.target.closest('.element-item');
  if (row && row.dataset.id) {
    if (currentView !== 'graph') {
      currentView = 'graph';
      document.querySelectorAll('#view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === 'graph'));
      document.getElementById('graph-svg').style.display = '';
      document.getElementById('content-pane').classList.remove('visible');
    }
    selectElement(row.dataset.id);
    if (window.innerWidth < 1024) window._closeSidebar();
  }
});

// ── Content pane (analytics, first disc, workers) ───────────
function renderContentPane() {
  const pane = document.getElementById('content-pane');
  pane.replaceChildren();

  if (currentView === 'analytics') renderAnalyticsInto(pane);
  else if (currentView === 'first-disc') renderFirstDiscoveriesInto(pane);
  else if (currentView === 'workers') renderWorkerRunsInto(pane);
}

function analyticsChartDims(container) {
  const w = container.clientWidth || 380;
  return { w, h: 220, margin: { top: 10, right: 16, bottom: 30, left: 50 } };
}

function renderAnalyticsInto(pane) {
  const grid = el('div', {className: 'chart-grid'});

  function makeExpandableCard(title, renderFn) {
    const h3 = el('h3', {textContent: title, style: {cursor: 'pointer'}});
    const card = el('div', {className: 'chart-card'}, [h3]);
    const container = el('div');
    card.appendChild(container);

    h3.addEventListener('click', () => {
      if (card.classList.contains('chart-card-expanded')) {
        card.classList.remove('chart-card-expanded');
        container.replaceChildren();
        renderFn(container);
      } else {
        // Collapse any other expanded card first
        grid.querySelectorAll('.chart-card-expanded').forEach(c => {
          c.classList.remove('chart-card-expanded');
          const cont = c.querySelector('div');
          if (cont) { cont.replaceChildren(); }
        });
        card.classList.add('chart-card-expanded');
        container.replaceChildren();
        renderFn(container);
        // Add close button
        const closeBtn = el('span', {textContent: '\u2715', style: {
          position: 'absolute', top: '12px', right: '16px', cursor: 'pointer',
          fontSize: '18px', color: '#888', zIndex: '10',
        }});
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          card.classList.remove('chart-card-expanded');
          container.replaceChildren();
          renderFn(container);
        });
        card.style.position = 'relative';
        card.appendChild(closeBtn);
      }
    });
    return { card, container };
  }

  const gen = makeExpandableCard('Generation Distribution', renderGenDistChart);
  grid.appendChild(gen.card);

  const name = makeExpandableCard('Element Name Length Distribution', renderNameLengthChart);
  grid.appendChild(name.card);

  const ingred = makeExpandableCard('Top Ingredients', renderTopIngredientsChart);
  grid.appendChild(ingred.card);

  const first = makeExpandableCard('Recent First Discoveries', renderFirstDiscPreview);
  grid.appendChild(first.card);

  pane.appendChild(grid);

  // Render after DOM attachment so containers have width
  requestAnimationFrame(() => {
    renderGenDistChart(gen.container);
    renderNameLengthChart(name.container);
    renderTopIngredientsChart(ingred.container);
    renderFirstDiscPreview(first.container);
  });
}

function renderGenDistChart(container) {
  // Use full dataset from /api/state, not the 500-item discoveries sample
  const genDist = state.generation_distribution || {};
  const data = Object.entries(genDist).map(([g, c]) => ({ gen: +g, count: c })).sort((a, b) => a.gen - b.gen);
  if (!data.length) { container.appendChild(el('div', {className: 'loading', textContent: 'No data yet'})); return; }

  const dims = analyticsChartDims(container);
  const { w, h, margin } = dims;
  const iw = w - margin.left - margin.right;
  const ih = h - margin.top - margin.bottom;

  const svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${w} ${h}`);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand().domain(data.map(d => d.gen)).range([0, iw]).padding(0.3);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.count)]).nice().range([ih, 0]);

  g.selectAll('rect').data(data).enter().append('rect')
    .attr('x', d => x(d.gen)).attr('y', d => y(d.count))
    .attr('width', x.bandwidth()).attr('height', d => ih - y(d.count))
    .attr('fill', d => genColor(d.gen)).attr('rx', 2);

  g.selectAll('.bar-value').data(data).enter().append('text')
    .attr('class', 'bar-value').attr('x', d => x(d.gen) + x.bandwidth() / 2)
    .attr('y', d => y(d.count) - 4).attr('text-anchor', 'middle').text(d => d.count);

  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat(d => 'Gen ' + d))
    .selectAll('text').attr('fill', '#888').attr('font-size', '10px');
  g.append('g').call(d3.axisLeft(y).ticks(5)).selectAll('text').attr('fill', '#888').attr('font-size', '10px');
  g.selectAll('.domain, .tick line').attr('stroke', '#2a2a4a');
}

function renderNameLengthChart(container) {
  // Use full dataset from /api/state if available, otherwise fall back to discoveries sample
  const nameLenDist = state.name_length_distribution || null;
  let data;
  if (nameLenDist) {
    const order = ['1-4', '5-7', '8-10', '11-15', '16+'];
    data = order.filter(b => nameLenDist[b]).map(b => ({ bucket: b, count: nameLenDist[b] || 0 }));
  } else {
    const buckets = {};
    discoveries.forEach(d => {
      const len = (d.element || '').length;
      const bucket = len <= 4 ? '1-4' : len <= 7 ? '5-7' : len <= 10 ? '8-10' : len <= 15 ? '11-15' : '16+';
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    });
    const order = ['1-4', '5-7', '8-10', '11-15', '16+'];
    data = order.filter(b => buckets[b]).map(b => ({ bucket: b, count: buckets[b] || 0 }));
  }
  if (!data.length) { container.appendChild(el('div', {className: 'loading', textContent: 'No data yet'})); return; }

  const dims = analyticsChartDims(container);
  const { w, h, margin } = dims;
  const iw = w - margin.left - margin.right;
  const ih = h - margin.top - margin.bottom;

  const svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${w} ${h}`);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand().domain(data.map(d => d.bucket)).range([0, iw]).padding(0.3);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.count)]).nice().range([ih, 0]);

  const colors = ['#4ade80', '#38bdf8', '#fb923c', '#f472b6', '#a78bfa'];
  g.selectAll('rect').data(data).enter().append('rect')
    .attr('x', d => x(d.bucket)).attr('y', d => y(d.count))
    .attr('width', x.bandwidth()).attr('height', d => ih - y(d.count))
    .attr('fill', (d, i) => colors[i % colors.length]).attr('rx', 2);

  g.selectAll('.bar-value').data(data).enter().append('text')
    .attr('class', 'bar-value').attr('x', d => x(d.bucket) + x.bandwidth() / 2)
    .attr('y', d => y(d.count) - 4).attr('text-anchor', 'middle').text(d => d.count);

  g.append('g').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x))
    .selectAll('text').attr('fill', '#888').attr('font-size', '10px');
  g.append('g').call(d3.axisLeft(y).ticks(5)).selectAll('text').attr('fill', '#888').attr('font-size', '10px');
  g.selectAll('.domain, .tick line').attr('stroke', '#2a2a4a');

  g.append('text').attr('x', iw / 2).attr('y', ih + 26).attr('fill', '#666').attr('font-size', '10px').attr('text-anchor', 'middle').text('Characters');
}

function renderTopIngredientsChart(container) {
  // Use full dataset from /api/state if available, otherwise fall back to discoveries sample
  let data;
  if (state.top_ingredients && state.top_ingredients.length) {
    data = state.top_ingredients;
  } else {
    const usage = {};
    discoveries.forEach(d => {
      if (d.recipe && d.recipe !== 'base' && d.recipe.includes(' + ')) {
        const parts = d.recipe.split(' + ');
        parts.forEach(p => { usage[p] = (usage[p] || 0) + 1; });
      }
    });
    data = Object.entries(usage).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 15);
  }
  if (!data.length) { container.appendChild(el('div', {className: 'loading', textContent: 'No recipe data yet'})); return; }

  // Build generation lookup: prefer API data (has .generation), fall back to discoveries sample
  const elemGen = new Map();
  discoveries.forEach(d => elemGen.set(d.element, d.generation || 0));
  data.forEach(d => { if (d.generation !== undefined) elemGen.set(d.name, d.generation); });

  // Compute left margin based on longest label
  const maxLabelLen = Math.max(...data.map(d => d.name.length));
  const leftMargin = Math.max(80, Math.min(200, maxLabelLen * 7 + 16));

  const dims = analyticsChartDims(container);
  const h = Math.max(dims.h, data.length * 24 + dims.margin.top + dims.margin.bottom);
  const { w } = dims;
  const margin = { ...dims.margin, left: leftMargin };
  const iw = w - margin.left - margin.right;
  const ih = h - margin.top - margin.bottom;

  const svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${w} ${h}`);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const y = d3.scaleBand().domain(data.map(d => d.name)).range([0, ih]).padding(0.25);
  const x = d3.scaleLinear().domain([0, d3.max(data, d => d.count)]).nice().range([0, iw]);

  g.selectAll('rect').data(data).enter().append('rect')
    .attr('x', 0).attr('y', d => y(d.name))
    .attr('width', d => x(d.count)).attr('height', y.bandwidth())
    .attr('fill', d => genColor(elemGen.get(d.name) || 0)).attr('rx', 2);

  g.selectAll('.bar-value').data(data).enter().append('text')
    .attr('class', 'bar-value').attr('x', d => x(d.count) + 4)
    .attr('y', d => y(d.name) + y.bandwidth() / 2 + 4).text(d => d.count);

  g.append('g').call(d3.axisLeft(y)).selectAll('text').attr('fill', '#ccc').attr('font-size', '11px');
  g.selectAll('.domain, .tick line').attr('stroke', '#2a2a4a');
}

function renderFirstDiscPreview(container) {
  let firsts = [...firstDiscoveries];
  if (!firsts.length) firsts = discoveries.filter(d => d.is_new);

  // Sort by timestamp to assign discovery order, then show newest first
  const byTime = [...firsts].sort((a, b) => (new Date(a.timestamp||0)).getTime() - (new Date(b.timestamp||0)).getTime());
  byTime.forEach((d, i) => { d._discNum = i + 1; });
  firsts.sort((a, b) => (new Date(b.timestamp||0)).getTime() - (new Date(a.timestamp||0)).getTime());

  if (!firsts.length) { container.appendChild(el('div', {className: 'loading', textContent: 'No first discoveries yet'})); return; }

  const shown = firsts.slice(0, 10);

  const table = el('table', {className: 'analytics-table'});
  const thead = el('thead');
  const headRow = el('tr');
  ['#', '', 'Element', 'Recipe', 'Gen'].forEach(h => {
    const th = el('th', {textContent: h});
    if (h === '#' || h === 'Gen') th.style.textAlign = 'right';
    if (h === '') th.style.width = '24px';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  shown.forEach((d) => {
    const gen = d.generation || 0;
    const tr = el('tr', null, [
      el('td', {textContent: String(d._discNum || ''), style: {color: '#666', textAlign: 'right'}}),
      el('td', {textContent: d.emoji || '', style: {fontSize: '14px', textAlign: 'center'}}),
      el('td', null, [el('span', {className: 'badge', textContent: d.element || '', style: {background: genColor(gen), color: '#fff'}})]),
      el('td', {textContent: d.recipe || '', style: {color: '#a5b4fc'}}),
      el('td', {textContent: String(gen), style: {textAlign: 'right', color: '#888'}}),
    ]);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderFirstDiscoveriesInto(pane) {
  let firsts = [...firstDiscoveries];
  if (!firsts.length) {
    firsts.push(...discoveries.filter(d => d.is_new));
  }

  // Sort state for first discoveries table — newest first by default
  let fdSort = 'discovered';
  let fdAsc = false;

  // Assign persistent discovery order numbers based on timestamp
  const ordered = [...firsts].sort((a, b) => (new Date(a.timestamp||0)).getTime() - (new Date(b.timestamp||0)).getTime());
  ordered.forEach((d, i) => { d._discNum = i + 1; });

  const COLUMNS = [
    { key: 'num', label: '#', sortable: false },
    { key: 'emoji', label: '', sortable: false },
    { key: 'element', label: 'Element', sortable: true, defaultAsc: true },
    { key: 'recipe', label: 'Recipe', sortable: false },
    { key: 'gen', label: 'Gen', sortable: true, defaultAsc: false },
    { key: 'discovered', label: 'Discovered', sortable: true, defaultAsc: false },
  ];

  pane.appendChild(el('h2', {textContent: 'First Discoveries (' + firsts.length + ')', style: {fontSize:'16px', color:'#fff', marginBottom:'16px'}}));

  if (!firsts.length) { pane.appendChild(el('div', {className:'loading', textContent:'No first discoveries yet'})); return; }

  const table = el('table', {className: 'data-table'});
  const thead = el('thead');
  const tbody = el('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  pane.appendChild(table);

  function rebuildTable() {
    // Sort
    const dir = fdAsc ? 1 : -1;
    if (fdSort === 'element') firsts.sort((a,b) => dir * (a.element||'').localeCompare(b.element||''));
    else if (fdSort === 'gen') firsts.sort((a,b) => dir * ((a.generation||0) - (b.generation||0)));
    else if (fdSort === 'discovered') firsts.sort((a,b) => dir * ((new Date(a.timestamp||0)).getTime() - (new Date(b.timestamp||0)).getTime()));

    // Header
    thead.replaceChildren();
    const headRow = el('tr');
    COLUMNS.forEach(col => {
      const th = el('th', {style: col.sortable ? {cursor:'pointer'} : {}});
      const isActive = fdSort === col.key;
      const arrow = isActive ? (fdAsc ? ' \u2191' : ' \u2193') : '';
      th.textContent = col.label + arrow;
      if (col.sortable) {
        th.addEventListener('click', () => {
          if (fdSort === col.key) { fdAsc = !fdAsc; }
          else { fdSort = col.key; fdAsc = col.defaultAsc; }
          rebuildTable();
        });
      }
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    // Body
    tbody.replaceChildren();
    firsts.forEach((d, i) => {
      const gen = d.generation || 0;
      const tr = el('tr', null, [
        el('td', {textContent: String(d._discNum || (i+1)), style: {color:'#666'}}),
        el('td', {textContent: d.emoji || ''}),
        el('td', {textContent: d.element || '', style: {color:'#e0e0e0', fontWeight:'500'}}),
        el('td', {textContent: d.recipe || '', style: {color:'#a5b4fc'}}),
        el('td', null, [el('span', {className:'gen-badge', textContent: String(gen), style: {background: genColor(gen)}})]),
        el('td', {textContent: d.timestamp ? new Date(d.timestamp).toLocaleString() : '--', style: {color:'#666', fontSize:'11px'}}),
      ]);
      tbody.appendChild(tr);
    });
  }

  rebuildTable();
}

const ALGORITHM_DESCRIPTIONS = {
  bfs: 'Breadth-First Search \u2014 Systematically combines elements starting from the lowest generation, working outward layer by layer. Thorough but slower for deep discoveries.',
  random: 'Random Pairs \u2014 Randomly selects two elements from the pool and combines them. Fast and unpredictable, good for serendipitous finds.',
  anchor: 'Anchor Sweep \u2014 Picks a random element and combines it with everything else. Efficient for exhaustive coverage of a single element.',
};

function renderWorkerRunsInto(pane) {
  pane.appendChild(el('h2', {textContent: 'Worker Runs \u2014 Last 48 Hours', style: {fontSize:'16px', color:'#fff', marginBottom:'12px'}}));

  // Algorithm legend (collapsible)
  const legendWrap = el('div', {style: {marginBottom:'16px'}});
  const legendToggle = el('span', {className: 'view-all-link', textContent: 'Algorithms \u25B6', style: {marginBottom:'8px'}});
  const legendBody = el('div', {style: {display:'none', marginTop:'8px'}});
  Object.entries(ALGORITHM_DESCRIPTIONS).forEach(([key, desc]) => {
    const row = el('div', {style: {marginBottom:'8px', padding:'8px 12px', background:'#12122a', border:'1px solid #2a2a4a', borderRadius:'6px'}}, [
      el('div', {style: {fontWeight:'600', fontSize:'12px', color:'#a5b4fc', marginBottom:'4px'}, textContent: key.toUpperCase()}),
      el('div', {style: {fontSize:'11px', color:'#999', lineHeight:'1.4'}, textContent: desc}),
    ]);
    legendBody.appendChild(row);
  });
  let legendOpen = false;
  legendToggle.addEventListener('click', () => {
    legendOpen = !legendOpen;
    legendBody.style.display = legendOpen ? 'block' : 'none';
    legendToggle.textContent = legendOpen ? 'Algorithms \u25BC' : 'Algorithms \u25B6';
  });
  legendWrap.appendChild(legendToggle);
  legendWrap.appendChild(legendBody);
  pane.appendChild(legendWrap);

  // Upcoming scheduled runs (next 24 hours)
  const PULSE_INTERVAL = 4 * 3600000; // 4 hours in ms
  const upcomingWrap = el('div', {className:'scheduled-upcoming'});
  upcomingWrap.appendChild(el('h3', {textContent: 'Upcoming Scheduled Runs \u2014 Next 24 Hours'}));
  upcomingWrap.appendChild(el('div', {style:{fontSize:'11px', color:'#666', marginBottom:'8px'}, textContent: 'Each pulse picks an algorithm at random, so upcoming algorithms can\u2019t be predicted.'}));

  // Find the most recent scheduled run to anchor projections
  const scheduledRuns = workerRuns.filter(r => r.source === 'scheduled' && r.started_at);
  const nowMs = Date.now();

  let nextPulse;
  if (scheduledRuns.length > 0) {
    const lastScheduled = new Date(scheduledRuns[0].started_at).getTime();
    nextPulse = lastScheduled + PULSE_INTERVAL;
    while (nextPulse <= nowMs) nextPulse += PULSE_INTERVAL;
  } else {
    // No scheduled runs yet — estimate from the top of the next 4-hour window
    const hour = new Date().getUTCHours();
    const nextSlot = Math.ceil((hour + 1) / 4) * 4;
    const d = new Date();
    d.setUTCHours(nextSlot, 0, 0, 0);
    nextPulse = d.getTime();
    if (nextPulse <= nowMs) nextPulse += PULSE_INTERVAL;
  }

  let futureCount = 0;
  for (let t = nextPulse; t < nowMs + 24 * 3600000; t += PULSE_INTERVAL) {
    const dt = new Date(t);
    const diffMs = t - nowMs;
    const diffH = Math.floor(diffMs / 3600000);
    const diffM = Math.floor((diffMs % 3600000) / 60000);
    const countdown = diffH > 0 ? diffH + 'h ' + diffM + 'm' : diffM + 'm';

    const row = el('div', {className:'scheduled-row'}, [
      el('span', {className:'sched-time', textContent: dt.toLocaleString(undefined, {weekday:'short', hour:'2-digit', minute:'2-digit', hour12:true})}),
      el('span', {className:'sched-strategy', textContent: 'RANDOMIZED'}),
      el('span', {className:'sched-countdown', textContent: 'in ' + countdown}),
    ]);
    upcomingWrap.appendChild(row);
    futureCount++;
  }

  if (futureCount === 0) {
    upcomingWrap.appendChild(el('div', {style:{fontSize:'11px', color:'#666'}, textContent: 'No upcoming runs projected.'}));
  }
  pane.appendChild(upcomingWrap);

  if (!workerRuns.length) {
    pane.appendChild(el('div', {className:'loading', textContent:'No worker runs yet. The next scheduled pulse fires every 4 hours.'}));
    return;
  }

  // Filter to last 48h by default
  const now = Date.now();
  const HOUR = 3600000;
  let filterHours = 48;
  const filterRuns = () => workerRuns.filter(r => r.started_at && (now - new Date(r.started_at).getTime()) < filterHours * HOUR);
  let filtered = filterRuns();

  // Time filter buttons
  const filterBar = el('div', {className:'time-filter'});
  [12, 24, 48, 168].forEach(h => {
    const label = h < 48 ? h + 'h' : h < 168 ? h/24 + 'd' : '7d';
    const btn = el('button', {textContent: label, className: h === 48 ? 'active' : ''});
    btn.addEventListener('click', () => {
      filterHours = h;
      filtered = filterRuns();
      filterBar.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      rebuildRuns();
    });
    filterBar.appendChild(btn);
  });
  const allBtn = el('button', {textContent: 'All'});
  allBtn.addEventListener('click', () => {
    filtered = workerRuns;
    filterBar.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    allBtn.classList.add('active');
    rebuildRuns();
  });
  filterBar.appendChild(allBtn);
  pane.appendChild(filterBar);

  // Aggregate summary
  const summaryEl = el('div', {className:'worker-summary'});
  const runsContainer = el('div');
  pane.appendChild(summaryEl);
  pane.appendChild(runsContainer);

  function rebuildRuns() {
    // Summary stats
    summaryEl.replaceChildren();
    const totals = filtered.reduce((acc, r) => ({
      runs: acc.runs + 1,
      apiCalls: acc.apiCalls + (Number(r.api_calls)||0),
      discoveries: acc.discoveries + (Number(r.discoveries)||0),
      firsts: acc.firsts + (Number(r.first_discoveries)||0),
      errors: acc.errors + (Number(r.errors)||0),
      duration: acc.duration + (Number(r.duration_seconds)||0),
      nothing: acc.nothing + (Number(r.nothing_count)||0),
    }), {runs:0, apiCalls:0, discoveries:0, firsts:0, errors:0, duration:0, nothing:0});

    const summaryItems = [
      ['Runs', String(totals.runs), ''],
      ['API Calls', totals.apiCalls.toLocaleString(), ''],
      ['Discoveries', String(totals.discoveries), 'highlight'],
      ['First Disc.', String(totals.firsts), 'highlight'],
      ['Errors', String(totals.errors), totals.errors > 0 ? 'error' : 'success'],
      ['Total Time', Math.round(totals.duration/60) + 'm', ''],
    ];
    summaryItems.forEach(([label, value, cls]) => {
      summaryEl.appendChild(el('div', {className:'stat-card'}, [
        el('div', {className:'stat-card-value ' + cls, textContent: value}),
        el('div', {className:'stat-card-label', textContent: label}),
      ]));
    });

    // Run cards
    runsContainer.replaceChildren();
    if (!filtered.length) {
      runsContainer.appendChild(el('div', {className:'loading', textContent:'No runs in this time window.'}));
      return;
    }

    filtered.forEach(r => {
      const card = el('div', {className:'run-card'});

      // Source badge
      const src = r.source || 'manual';
      const srcBadge = el('span', {className:'source-badge ' + (src === 'scheduled' ? 'source-scheduled' : 'source-manual'), textContent: src});

      // Strategy badge
      const stratBadge = el('span', {className:'strategy-badge', textContent: 'Algorithm: ' + (r.strategy || 'unknown').toUpperCase()});

      // Discovery count pill
      const discCount = Number(r.discoveries) || 0;
      const firstCount = Number(r.first_discoveries) || 0;
      const discText = discCount + ' disc' + (firstCount > 0 ? ' (' + firstCount + ' first)' : '');
      const discPill = el('span', {style: {fontSize:'11px', color: discCount > 0 ? '#f59e0b' : '#666'}, textContent: discText});

      // Duration
      const dur = Number(r.duration_seconds) || 0;
      const durText = dur >= 60 ? Math.floor(dur/60) + 'm ' + (dur%60) + 's' : dur + 's';

      // Header
      const header = el('div', {className:'run-card-header'}, [
        el('div', {style:{display:'flex', gap:'8px', alignItems:'center'}}, [
          el('span', {className:'run-card-id', textContent: r.run_id || ''}),
          stratBadge,
          srcBadge,
        ]),
        el('div', {className:'run-card-meta'}, [
          discPill,
          el('span', {style:{fontSize:'11px', color:'#888'}, textContent: durText}),
          el('span', {className:'run-card-time', textContent: formatTime(r.started_at)}),
        ]),
      ]);

      // Body (expandable)
      const body = el('div', {className:'run-card-body'});

      const apiCalls = Number(r.api_calls) || 0;
      const pairsTried = Number(r.pairs_tried) || 0;
      const errors = Number(r.errors) || 0;
      const nothingCount = Number(r.nothing_count) || 0;
      const elemTotal = Number(r.elements_total) || 0;
      const finalDelay = Number(r.final_delay) || 0;

      // Detail grid
      const grid = el('div', {className:'run-detail-grid'});
      const details = [
        ['API Calls', apiCalls.toLocaleString(), ''],
        ['Pairs Tried', pairsTried.toLocaleString(), ''],
        ['Discoveries', String(discCount), discCount > 0 ? 'highlight' : ''],
        ['First Discoveries', String(firstCount), firstCount > 0 ? 'highlight' : ''],
        ['Nothing Results', nothingCount.toLocaleString(), ''],
        ['Errors', String(errors), errors > 0 ? 'error' : 'success'],
        ['Total Elements', elemTotal.toLocaleString(), ''],
        ['Final Delay', finalDelay.toFixed(2) + 's', ''],
        ['Duration', durText, ''],
        ['Source', src, ''],
      ];
      details.forEach(([label, value, cls]) => {
        grid.appendChild(el('div', {className:'run-detail-item'}, [
          el('div', {className:'run-detail-label', textContent: label}),
          el('div', {className:'run-detail-value ' + cls, textContent: value}),
        ]));
      });
      body.appendChild(grid);

      // Efficiency stats
      const eff = el('div', {className:'run-efficiency'});
      if (apiCalls > 0) {
        const discoveryRate = ((discCount / apiCalls) * 100).toFixed(1);
        const nothingRate = ((nothingCount / apiCalls) * 100).toFixed(1);
        const errorRate = ((errors / apiCalls) * 100).toFixed(1);
        eff.appendChild(el('div', null, [
          document.createTextNode('Discovery rate: '), el('span', {textContent: discoveryRate + '%'}),
          document.createTextNode('  \u00b7  Nothing rate: '), el('span', {textContent: nothingRate + '%'}),
          document.createTextNode('  \u00b7  Error rate: '), el('span', {textContent: errorRate + '%'}),
        ]));
      }
      if (r.started_at && r.finished_at) {
        eff.appendChild(el('div', {style:{marginTop:'4px'}}, [
          document.createTextNode('Started: '), el('span', {textContent: new Date(r.started_at).toLocaleString()}),
          document.createTextNode('  \u2192  Finished: '), el('span', {textContent: new Date(r.finished_at).toLocaleString()}),
        ]));
      }
      body.appendChild(eff);

      // Discovery yield bar
      if (apiCalls > 0) {
        const yieldPct = Math.min(100, (discCount / apiCalls) * 100 * 5); // scale up for visibility
        const bar = el('div', {className:'run-bar'});
        bar.appendChild(el('div', {className:'run-bar-fill', style:{width: yieldPct + '%', background: discCount > 0 ? '#f59e0b' : '#333'}}));
        body.appendChild(bar);
      }

      header.addEventListener('click', () => body.classList.toggle('open'));
      card.appendChild(header);
      card.appendChild(body);
      runsContainer.appendChild(card);
    });
  }

  rebuildRuns();
}

function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  if (s < 172800) return 'Yesterday ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  return d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

// ── View switching ──────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll('#view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('graph-svg').style.display = view === 'graph' ? '' : 'none';
  document.getElementById('legend').style.display = view === 'graph' ? '' : 'none';
  // Pause simulation when leaving graph view to save CPU
  if (view !== 'graph' && simulation) simulation.stop();
  const contentPane = document.getElementById('content-pane');
  if (view === 'graph') {
    contentPane.classList.remove('visible');
    if (!graphAvailable()) return;
    if (simulation) simulation.restart();
  } else {
    contentPane.classList.remove('pane-notice');
    contentPane.classList.add('visible');
    renderContentPane();
    // Fetch view-specific data on switch
    if (view === 'first-disc') refreshFirstDiscoveries();
    else if (view === 'workers') refreshWorkers();
  }
}

// ── Sort bar ────────────────────────────────────────────────
const SORT_OPTIONS = [
  { key: 'name', label: 'Name', defaultAsc: true },
  { key: 'gen', label: 'Generation', defaultAsc: false },
  { key: 'new', label: 'First Disc.', defaultAsc: false },
];

function buildSortBar() {
  const bar = document.getElementById('sort-bar');
  bar.replaceChildren();
  SORT_OPTIONS.forEach(opt => {
    const isActive = currentSort === opt.key;
    const arrow = isActive ? (sortAsc ? ' \u2191' : ' \u2193') : '';
    const btn = el('button', {
      className: isActive ? 'active' : '',
      textContent: opt.label + arrow,
    });
    btn.addEventListener('click', () => {
      if (currentSort === opt.key) {
        sortAsc = !sortAsc;
      } else {
        currentSort = opt.key;
        sortAsc = opt.defaultAsc;
      }
      buildSortBar();
      renderElementList();
    });
    bar.appendChild(btn);
  });
}
buildSortBar();

// ── Event handlers ──────────────────────────────────────────
let _searchDebounce = null;
let _serverSearchResults = null; // null = use local discoveries
document.getElementById('search-input').addEventListener('input', e => {
  searchTerm = e.target.value;
  clearTimeout(_searchDebounce);
  if (searchTerm.trim().length >= 2) {
    // Debounce server search
    _searchDebounce = setTimeout(async () => {
      try {
        const resp = await fetch(API_BASE + '/api/discoveries?search=' + encodeURIComponent(searchTerm.trim().substring(0, 100)) + '&limit=200');
        const data = await resp.json();
        _serverSearchResults = data.discoveries || [];
        renderElementList();
      } catch (err) { console.warn('Server search failed, using local filter:', err.message); _serverSearchResults = null; }
    }, 300);
    // Show local filter immediately while waiting
    _serverSearchResults = null;
    renderElementList();
  } else {
    _serverSearchResults = null;
    renderElementList();
  }
});
document.querySelectorAll('#view-toggle button').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

// ── Legend ───────────────────────────────────────────────────
function renderLegend() {
  const legend = document.getElementById('legend');
  legend.replaceChildren();

  // Node size section
  const sizeLabel = el('div', {className: 'legend-section', textContent: 'Node Size'});
  legend.appendChild(sizeLabel);

  const SIZE_MODES = [
    { key: 'gen-asc', label: 'Newer = Larger' },
    { key: 'gen-desc', label: 'Older = Larger' },
    { key: 'connections', label: 'Connections' },
    { key: 'recipes', label: 'Recipe Results' },
  ];
  SIZE_MODES.forEach(m => {
    const opt = el('div', {className: 'size-option' + (nodeSizeMode === m.key ? ' active' : '')}, [
      el('span', {className: 'radio'}),
      document.createTextNode(m.label),
    ]);
    opt.addEventListener('click', () => {
      nodeSizeMode = m.key;
      renderLegend();
      updateNodeSizes();
    });
    legend.appendChild(opt);
  });

  // Generation colors section
  const genLabel = el('div', {className: 'legend-section', textContent: 'Generation'});
  legend.appendChild(genLabel);

  const genDist = state.generation_distribution || {};
  const maxGen = Math.max(0, ...Object.keys(genDist).map(Number));
  for (let i = 0; i <= maxGen; i++) {
    const count = genDist[String(i)] || genDist[i] || 0;
    const row = el('div', {className:'legend-row'}, [
      el('span', {className:'legend-dot', style:{background: genColor(i)}}),
      document.createTextNode('Gen ' + i),
      el('span', {style: {color: '#555', marginLeft: 'auto', fontSize: '10px'}, textContent: count ? String(count) : ''}),
    ]);
    legend.appendChild(row);
  }
}

function updateNodeSizes() {
  if (!_graphState) return;
  const { nodeEls, nodeRadius: oldRadiusFn } = _graphState;
  // Recompute with current mode — nodeRadius closes over nodeSizeMode
  nodeEls.selectAll('circle.node-circle')
    .transition().duration(400)
    .attr('r', _graphState.nodeRadius);
  nodeEls.selectAll('text.node-label')
    .transition().duration(400)
    .attr('dy', d => d._inferred ? -6 : -(4 + _graphState.nodeRadius(d)));
}

// ── Init ────────────────────────────────────────────────────
(async function init() {
  setStatus('ok', 'Loading...');
  try {
    await refreshAll();
  } catch (e) {
    setStatus('error', 'Initial load failed: ' + e.message);
    console.error('Init error:', e);
  }
  renderLegend();

  // The graph is the landing view, so say why it is empty at load rather than
  // waiting for the first data refresh to reach a d3 call.
  graphAvailable();

  // Poll with visibility-aware backoff — pause when tab is hidden
  let pollTimer = setInterval(refreshAll, POLL_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearInterval(pollTimer);
      pollTimer = null;
    } else if (!pollTimer) {
      refreshAll();
      pollTimer = setInterval(refreshAll, POLL_INTERVAL);
    }
  });

  let _resizeTimer = null;
  function handleResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (currentView === 'graph') renderGraph();
      else renderContentPane();
      if (_currentChainTarget && document.getElementById('chain-overlay').classList.contains('visible')) {
        rerenderChainOverlay();
      }
    }, 300);
  }
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);
})();
