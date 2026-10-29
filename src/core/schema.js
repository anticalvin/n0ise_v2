/* The one n0ise project schema (v3): create, validate, migrate, patch. */
export const FORMAT = "n0ise-project";
export const VERSION = 3;
export const RATIOS = { "1:1":[1,1], "4:5":[4,5], "9:16":[9,16], "16:9":[16,9], "3:4":[3,4], "4:3":[4,3] };
export const MAX_DIM = 7680;
export const OUTPUT_ID = "output";

const clone = v => JSON.parse(JSON.stringify(v));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const uid = (p = "n") => p + (globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10));

export function artboardFor(ratio = "9:16", w, h) {
  const r = RATIOS[ratio];
  if (!r) return { width: clamp(Math.round(w) || 1080, 16, MAX_DIM), height: clamp(Math.round(h) || 1080, 16, MAX_DIM), ratio: "custom" };
  const long = 1080, k = long / Math.max(r[0], r[1]);
  return { width: Math.round(r[0] * k), height: Math.round(r[1] * k), ratio };
}

export function makeNode(type, extra = {}) {
  return { id: uid(), type, label: extra.label || type, x: 0, y: 0, params: {}, assetId: null, visible: true, locked: false, solo: false, ...extra };
}

export function createProject({ name = "Untitled", ratio = "9:16" } = {}) {
  const now = Date.now();
  return {
    format: FORMAT, version: VERSION, id: uid("p"), name, createdAt: now, updatedAt: now,
    artboard: artboardFor(ratio), timeline: { duration: 4, loop: true, fps: 24 },
    graph: { nodes: [makeNode("output", { id: OUTPUT_ID, label: "Output", x: 600, y: 120 })], connections: [], groups: [], outputId: OUTPUT_ID },
    stackView: { chainNodeIds: [] }, overlays: [], assets: [], ui: { viewport: {}, selection: [], lastView: "look" },
  };
}

/** Returns an array of human-readable errors; empty means valid. `knownTypes` (Set) is optional until the engine registry exists. */
export function validateProject(p, knownTypes = null) {
  const e = [];
  if (!p || typeof p !== "object") return ["This is not a project: expected a JSON object."];
  if (p.format !== FORMAT) e.push(`format must be "${FORMAT}".`);
  if (p.version !== VERSION) e.push(`version must be ${VERSION} (got ${p.version}).`);
  const g = p.graph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.connections)) return [...e, "graph.nodes and graph.connections must be arrays."];
  const ids = new Set();
  g.nodes.forEach((n, i) => {
    if (!n || typeof n !== "object" || !n.id) return e.push(`node #${i + 1} is missing an id.`);
    if (ids.has(n.id)) e.push(`duplicate node id "${n.id}".`);
    ids.add(n.id);
    if (typeof n.type !== "string") e.push(`node "${n.id}" has no type.`);
    else if (knownTypes && !knownTypes.has(n.type)) e.push(`node "${n.id}" has unknown type "${n.type}".`);
    if (n.params != null && typeof n.params !== "object") e.push(`node "${n.id}" params must be an object.`);
  });
  g.connections.forEach((c, i) => {
    if (!c || !ids.has(c.from)) e.push(`connection #${i + 1} starts at a node that does not exist.`);
    else if (!ids.has(c.to)) e.push(`connection #${i + 1} ends at a node that does not exist.`);
  });
  if (!ids.has(g.outputId)) e.push(`graph.outputId "${g.outputId}" is not a node.`);
  else if (g.nodes.find(n => n.id === g.outputId)?.type !== "output") e.push("graph.outputId must point at an output node.");
  const a = p.artboard;
  if (!a || !(a.width >= 1 && a.width <= MAX_DIM && a.height >= 1 && a.height <= MAX_DIM)) e.push(`artboard width/height must be 1-${MAX_DIM}.`);
  for (const id of p.stackView?.chainNodeIds || []) if (!ids.has(id)) e.push(`stackView references missing node "${id}".`);
  return e;
}

/* ---------- migrations ---------- */

const BLEND = { normal: "source-over" };
const blendOf = b => BLEND[b] || b || "source-over";
const PAINT = "image"; // paint layers become image sources whose pixels live in params.paintData until persisted as an asset

function normalizeV3(p) {
  const out = clone(p);
  out.assets ||= []; out.overlays ||= []; out.stackView ||= { chainNodeIds: [] };
  out.ui ||= { viewport: {}, selection: [], lastView: "look" };
  out.graph.groups ||= [];
  out.graph.nodes.forEach(n => { n.params ||= {}; n.assetId ??= null; n.visible = n.visible !== false; n.locked = !!n.locked; n.solo = !!n.solo; n.x = +n.x || 0; n.y = +n.y || 0; });
  return out;
}

/** Walk back from the output through single-input non-source nodes to find the linear chain shown in Look view. */
export function deriveChain(graph, isChainType = t => !["output", "blend", "mask", "merge", "noise", "solid", "image", "video", "camera", "text"].includes(t)) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const into = id => graph.connections.filter(c => c.to === id);
  const chain = []; let cur = into(graph.outputId)[0]?.from;
  const seen = new Set();
  while (cur && !seen.has(cur) && isChainType(byId.get(cur)?.type)) {
    seen.add(cur); chain.unshift(cur);
    const ins = into(cur); cur = ins.length === 1 ? ins[0].from : null;
  }
  return chain;
}

export function migrateDesktopV1(s) {
  const p = createProject({ name: "Desktop project" });
  const warnings = [];
  const ab = s.artboard || {};
  p.artboard = { width: clamp(+ab.width || 1280, 1, MAX_DIM), height: clamp(+ab.height || 720, 1, MAX_DIM), ratio: ab.ratio || "16:9" };
  if (s.timeline) p.timeline = { duration: +s.timeline.duration || 4, loop: s.timeline.loop !== false, fps: +s.timeline.fps || 24 };
  p.graph.nodes = (s.nodes || []).map(n => ({
    id: n.id, type: n.type, label: n.label || n.type, x: +n.x || 0, y: +n.y || 0, params: clone(n.params || {}),
    assetId: n.assetId || n.mediaId || null, visible: n.visible !== false, locked: !!n.locked, solo: !!n.solo,
  }));
  p.graph.connections = (s.connections || []).map(c => ({ id: c.id || uid("c"), from: c.from, fromPort: c.fromPort || "out", to: c.to, toPort: c.toPort || "in1" }));
  p.graph.groups = (s.groups || []).map(g => ({ id: g.id, name: g.name || "Group", nodeIds: [...(g.nodeIds || [])] }));
  const out = (s.activeOutputId && p.graph.nodes.find(n => n.id === s.activeOutputId)) || p.graph.nodes.find(n => n.type === "output");
  if (!out) { const o = makeNode("output", { id: OUTPUT_ID, label: "Output" }); p.graph.nodes.push(o); p.graph.outputId = o.id; warnings.push("No output node found; added one."); }
  else p.graph.outputId = out.id;
  p.overlays = clone(s.overlays || []);
  p.ui.viewport = clone(s.viewport || {});
  p.stackView.chainNodeIds = deriveChain(p.graph);
  if (p.graph.nodes.some(n => n.assetId && ["image", "video", "camera"].includes(n.type))) warnings.push("Desktop media was held in memory only; image/video nodes may need their media re-added.");
  return { project: p, warnings };
}

export function migrateMobileV1(s) {
  const p = createProject({ name: "Mobile project" });
  const warnings = [];
  p.artboard = s.ratio === "custom" || s.ratio === "CUSTOM" || !RATIOS[s.ratio] ? artboardFor("custom", s.customW, s.customH) : artboardFor(s.ratio);
  p.timeline = { duration: +s.exportDuration || 4, loop: s.exportLoop !== false, fps: +s.exportFps || 24 };
  const { nodes, connections } = p.graph;
  const out = nodes[0];
  let col = 0;
  const add = (type, extra, x, y) => { const n = makeNode(type, { x, y, ...extra }); nodes.push(n); return n; };
  const link = (a, b, toPort = "in") => connections.push({ id: uid("c"), from: a.id, fromPort: "out", to: b.id, toPort });
  const chainOf = (head, items, y, ids) => {
    let prev = head;
    for (const it of items || []) {
      if (!it?.key || it.key === "none") continue;
      const n = add(it.key, { params: clone(it.params || {}), visible: it.visible !== false, label: it.key }, 200 + 220 * ++col, y);
      link(prev, n); prev = n; ids?.push(n.id);
    }
    return prev;
  };
  const layerNodes = new Map();
  let acc = null;
  (s.layers || []).forEach((l, i) => {
    const y = 120 + i * 160; col = 0;
    const pos = { x: ((l.x ?? .5) - .5) * 2, y: ((l.y ?? .5) - .5) * 2, scale: l.scale ?? 1, rotation: (l.rotation || 0) * 180 / Math.PI };
    let src;
    if (l.kind === "base" || l.kind === "image" || l.kind === "video") {
      const isVideo = l.kind === "video" || (l.kind === "base" && s.mediaType === "video");
      src = add(isVideo ? "video" : l.assetId || s.mediaType === "image" || l.kind !== "base" ? "image" : "noise", { assetId: l.assetId || null, label: l.name || l.kind, params: { fit: l.fit || "cover", ...pos } }, 0, y);
      if (!l.assetId && l.kind !== "base") warnings.push(`Layer "${l.name}" had no stored media.`);
    } else if (l.kind === "text") {
      src = add("text", { label: l.name || "Text", params: { text: l.text || "n0ise", size: l.size || 96, color: l.color || "#d7ff39", x: l.x ?? .5, y: l.y ?? .5 } }, 0, y);
    } else if (l.kind === "paint") {
      src = add(PAINT, { label: l.name || "Paint", params: { fit: "stretch", x: 0, y: 0, scale: 1, rotation: 0, paintData: l.paintData || null } }, 0, y);
    } else {
      src = add("solid", { label: l.name || "Solid", params: { color: l.color || "#000000", opacity: l.color === "transparent" ? 0 : 1 } }, 0, y);
    }
    src.visible = l.visible !== false;
    if (!["base", "image", "video"].includes(l.kind) && (pos.scale !== 1 || pos.rotation)) {
      const t = add("transform", { params: { x: 0, y: 0, scale: pos.scale, rotation: pos.rotation } }, 200, y); link(src, t); src = t;
    }
    layerNodes.set(l.id, src);
    let head = chainOf(src, [...(l.effects || []), ...(l.adjustments || [])], y);
    if (l.mask && l.mask.type && l.mask.type !== "none") warnings.push(`Layer "${l.name}" mask (${l.mask.type}) was not migrated.`);
    if (!acc) acc = head;
    else {
      const b = add("blend", { label: "Blend", params: { mix: l.opacity ?? 1, mode: blendOf(l.blend) }, visible: l.visible !== false }, 200 * (col + 2), y);
      link(acc, b, "A"); link(head, b, "B"); acc = b;
    }
  });
  if (!acc) { acc = add("noise", { params: {} }, 0, 120); }
  // Global stack = the Look view chain.
  const stackY = 120; col = 0;
  const tail = chainOf(acc, s.stack, stackY, p.stackView.chainNodeIds);
  link(tail, out, "in1");
  out.x = 400 + 220 * (col + 2); out.y = stackY;
  p.graph.groups = (s.groups || []).filter(g => g.layerIds?.length).map(g => ({ id: g.id, name: g.name || "Group", nodeIds: g.layerIds.map(id => layerNodes.get(id)?.id).filter(Boolean) }));
  return { project: p, warnings };
}

/** Accepts v3 projects, export wrappers (v1/v3) and bare desktop/mobile snapshots. Returns { project, warnings, wrapperAssets }. */
export function migrate(raw) {
  if (!raw || typeof raw !== "object") throw new Error("This file is not a n0ise project (expected a JSON object).");
  if (raw.format === FORMAT && raw.version === VERSION && raw.graph) {
    const project = normalizeV3(raw), errs = validateProject(project);
    if (errs.length) throw new Error("Project is invalid: " + errs.slice(0, 3).join(" "));
    return { project, warnings: [], wrapperAssets: [] };
  }
  if (raw.format === FORMAT && raw.version === VERSION && raw.project) { const r = migrate(raw.project); r.wrapperAssets = raw.assets || []; return r; }
  if (raw.format === FORMAT && raw.snapshot) { const r = migrate(raw.snapshot); r.wrapperAssets = raw.assets || []; return r; }
  let r;
  if (Array.isArray(raw.layers)) r = migrateMobileV1(raw);
  else if (Array.isArray(raw.nodes)) r = migrateDesktopV1(raw);
  else throw new Error("This file is not a n0ise project: no layers, nodes or graph found.");
  const errs = validateProject(r.project);
  if (errs.length) throw new Error("Could not migrate this project: " + errs.slice(0, 3).join(" "));
  return { ...r, wrapperAssets: [] };
}

/* ---------- patches (AI round-trip) ---------- */

/** Applies the documented patch format to a clone of `project` and returns the new project; throws a human error on bad input. */
export function applyPatch(project, patch, knownTypes = null) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Patch must be a JSON object.");
  const p = clone(project), g = p.graph, byId = id => g.nodes.find(n => n.id === id);
  const arr = (k) => { if (patch[k] != null && !Array.isArray(patch[k])) throw new Error(`Patch "${k}" must be an array.`); return patch[k] || []; };
  for (const pn of arr("nodes")) {
    const n = byId(pn?.id); if (!n) throw new Error(`Patch updates node "${pn?.id}" which does not exist.`);
    if (pn.params && typeof pn.params === "object") n.params = { ...n.params, ...pn.params };
    for (const k of ["x", "y", "label", "visible", "locked", "solo", "assetId"]) if (k in pn) n[k] = pn[k];
  }
  const kill = new Set(arr("removeNodeIds"));
  if (kill.has(g.outputId)) throw new Error("Patch cannot remove the output node.");
  g.nodes = g.nodes.filter(n => !kill.has(n.id));
  g.connections = g.connections.filter(c => !kill.has(c.from) && !kill.has(c.to));
  g.groups.forEach(gr => gr.nodeIds = gr.nodeIds.filter(id => !kill.has(id)));
  for (const raw of arr("addNodes")) {
    if (!raw?.type) throw new Error("Patch addNodes entry has no type.");
    if (knownTypes && !knownTypes.has(raw.type)) throw new Error(`Patch adds unknown node type "${raw.type}".`);
    if (raw.id && byId(raw.id)) throw new Error(`Patch adds node "${raw.id}" but that id already exists.`);
    g.nodes.push(makeNode(raw.type, { ...raw, params: clone(raw.params || {}) }));
  }
  for (const c of arr("connections")) {
    if (!c?.from || !c?.to) throw new Error("Patch connection needs from and to.");
    if (!byId(c.from) || !byId(c.to)) throw new Error(`Patch connection ${c.from} -> ${c.to} uses a node that does not exist.`);
    const toPort = c.toPort || "in1";
    if (g.connections.some(x => x.from === c.from && x.to === c.to && x.toPort === toPort)) continue;
    g.connections.push({ id: c.id || uid("c"), from: c.from, fromPort: c.fromPort || "out", to: c.to, toPort });
  }
  if (patch.artboard) p.artboard = { ...p.artboard, ...patch.artboard };
  if (patch.timeline) p.timeline = { ...p.timeline, ...patch.timeline };
  if (Array.isArray(patch.overlays)) p.overlays = clone(patch.overlays);
  if (typeof patch.outputId === "string") g.outputId = patch.outputId;
  const errs = validateProject(p, knownTypes);
  if (errs.length) throw new Error("Patch would break the project: " + errs.slice(0, 3).join(" "));
  p.stackView.chainNodeIds = p.stackView.chainNodeIds.filter(id => byId(id));
  return p;
}
