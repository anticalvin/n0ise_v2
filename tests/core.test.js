import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProject, migrate, validateProject, applyPatch, deriveChain } from "../src/core/schema.js";
import { createStore } from "../src/core/store.js";
import { createPersistence, memoryBackend, blobToDataURL } from "../src/core/persistence.js";

const fx = n => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));
const lin = p => p.graph.nodes.every(n => n.id === p.graph.outputId || p.graph.connections.some(c => c.from === n.id)); // every node feeds something

test("desktop v1 migrates to a valid v3 graph with chain", () => {
  const { project: p } = migrate(fx("desktop-v1"));
  assert.deepEqual(validateProject(p), []);
  assert.equal(p.graph.outputId, "n4");
  assert.equal(p.graph.nodes.find(n => n.id === "n1").assetId, "m1");
  assert.deepEqual(p.stackView.chainNodeIds, ["n2", "n3"]);
  assert.equal(p.artboard.width, 1280);
  assert.ok(lin(p));
});

test("mobile v1 (export wrapper) migrates: layers -> sources, blend chain, stack view", () => {
  const { project: p, wrapperAssets } = migrate(fx("mobile-v1"));
  assert.deepEqual(validateProject(p), []);
  assert.equal(wrapperAssets.length, 1);
  const types = p.graph.nodes.map(n => n.type);
  for (const t of ["image", "text", "solid", "bloom", "vhs", "dither", "output"]) assert.ok(types.includes(t), t);
  assert.equal(types.filter(t => t === "blend").length, 3);
  const text = p.graph.nodes.find(n => n.type === "blend" && n.params.mode === "multiply");
  assert.equal(text.params.mix, 0.8);                    // opacity preserved
  assert.equal(p.graph.nodes.find(n => n.type === "image" && n.assetId === "asset-1").assetId, "asset-1");
  assert.equal(p.stackView.chainNodeIds.length, 2);      // vhs, dither
  assert.equal(p.graph.nodes.find(n => n.id === p.stackView.chainNodeIds[1]).visible, false);
  assert.equal(p.graph.groups[0].nodeIds.length, 2);
  assert.equal(p.artboard.height, 1080);
  assert.ok(lin(p));
});

test("bare snapshots and bad input give human errors", () => {
  assert.equal(migrate(fx("mobile-v1").snapshot).project.version, 3);
  assert.throws(() => migrate({ foo: 1 }), /not a n0ise project/);
  assert.throws(() => migrate(null), /not a n0ise project/);
  const p = createProject(); p.graph.connections.push({ id: "x", from: "nope", to: "output" });
  assert.match(validateProject(p)[0], /does not exist/);
});

test("v3 round trips through migrate unchanged", () => {
  const p = createProject({ name: "x" });
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(p))).project, p);
});

test("undo/redo across every action type, one history", () => {
  const s = createStore(createProject());
  const actions = [
    ["add node", d => d.graph.nodes.push({ id: "a", type: "glitch", label: "g", x: 0, y: 0, params: {}, assetId: null, visible: true, locked: false, solo: false })],
    ["connect", d => d.graph.connections.push({ id: "c", from: "a", fromPort: "out", to: "output", toPort: "in1" })],
    ["param", d => { d.graph.nodes[1].params.amount = 9; }],
    ["stack reorder", d => { d.stackView.chainNodeIds = ["a"]; }],
    ["artboard", d => { d.artboard.width = 500; }],
    ["rename", d => { d.name = "renamed"; }],
    ["group", d => { d.graph.groups.push({ id: "g", name: "G", nodeIds: ["a"] }); }],
    ["patch", null],
  ];
  const snaps = [JSON.stringify(s.project)];
  for (const [label, fn] of actions) {
    if (fn) s.update(label, fn); else s.patch({ nodes: [{ id: "a", params: { amount: 77 } }] });
    snaps.push(JSON.stringify(s.project));
  }
  for (let i = actions.length; i > 0; i--) { assert.ok(s.undo()); assert.equal(JSON.stringify(s.project).replace(/"updatedAt":\d+/, ""), snaps[i - 1].replace(/"updatedAt":\d+/, ""), "undo " + actions[i - 1][0]); }
  assert.equal(s.undo(), false);
  for (let i = 0; i < actions.length; i++) assert.ok(s.redo());
  assert.equal(s.project.graph.nodes[1].params.amount, 77);
  assert.equal(s.redo(), false);
});

test("coalescing collapses slider drags; no-op edits are not recorded", () => {
  const s = createStore(createProject());
  s.update("add", d => d.graph.nodes.push({ id: "a", type: "t", label: "", x: 0, y: 0, params: { v: 0 }, assetId: null, visible: true, locked: false, solo: false }));
  for (let v = 1; v <= 5; v++) s.update("slide", d => { d.graph.nodes[1].params.v = v; }, { coalesceKey: "a.v" });
  assert.equal(s.update("noop", () => {}), false);
  s.undo(); assert.equal(s.project.graph.nodes[1].params.v, 0);
  s.undo(); assert.equal(s.project.graph.nodes.length, 1);
});

test("bad patch leaves project untouched with a clear error", () => {
  const s = createStore(createProject());
  assert.throws(() => s.patch({ nodes: [{ id: "ghost" }] }), /does not exist/);
  assert.throws(() => s.patch({ removeNodeIds: ["output"] }), /output node/);
  assert.throws(() => s.patch([]), /JSON object/);
  assert.equal(s.history.canUndo, false);
});

test("export embeds media for node projects; import round-trips identical bytes without overwriting", async () => {
  const per = createPersistence({ backend: memoryBackend() });
  const bytes = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
  const ref = await per.addAsset(new Blob([bytes], { type: "image/png" }));
  const p = createProject({ name: "node project" });
  p.graph.nodes.push({ id: "img", type: "image", label: "i", x: 0, y: 0, params: {}, assetId: ref.id, visible: true, locked: false, solo: false });
  p.assets.push(ref);
  await per.saveProject(p);
  const file = JSON.parse(JSON.stringify(await per.exportProject(p)));
  assert.equal(file.assets.length, 1);

  const per2 = createPersistence({ backend: memoryBackend() });
  const { project } = await per2.importProject(file);
  const got = new Uint8Array(await (await per2.getAsset(ref.id)).blob.arrayBuffer());
  assert.deepEqual(got, bytes);
  const again = await per2.importProject(file);               // same id already exists
  assert.notEqual(again.project.id, project.id);
  assert.equal((await per2.listProjects()).length, 2);
});

test("old mobile export imports with media and paint externalised", async () => {
  const per = createPersistence({ backend: memoryBackend() });
  const { project, warnings } = await per.importProject(fx("mobile-v1"));
  assert.ok(await per.getAsset("asset-1"));
  const paint = project.graph.nodes.find(n => n.label === "Paint");
  assert.ok(paint.assetId && !paint.params.paintData);
  assert.ok(await per.getAsset(paint.assetId));
  assert.ok(Array.isArray(warnings));
});

test("storage failure keeps the session alive in memory and reports once", async () => {
  const errors = [];
  const broken = { kind: "idb", get: async () => { throw new DOMException("full", "QuotaExceededError"); }, put: async () => { throw new DOMException("full", "QuotaExceededError"); }, del: async () => {}, all: async () => [] };
  const per = createPersistence({ backend: broken, onError: e => errors.push(e.kind) });
  const p = createProject();
  await per.saveProject(p);
  assert.equal(per.degraded, true);
  assert.deepEqual(errors, ["quota"]);
  assert.equal((await per.loadProject(p.id)).id, p.id);
});

test("per-project autosave never writes another project; delete is undoable; duplicate copies media", async () => {
  const per = createPersistence({ backend: memoryBackend(), autosaveMs: 5 });
  const a = createProject({ name: "A" }), b = createProject({ name: "B" });
  per.scheduleSave(a); per.scheduleSave(b); a.name = "A2"; per.scheduleSave(a);
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await per.loadProject(a.id)).name, "A2");
  assert.equal((await per.loadProject(b.id)).name, "B");
  const ref = await per.addAsset(new Blob(["hi"], { type: "text/plain" }));
  a.assets.push(ref); a.graph.nodes.push({ id: "i", type: "image", label: "", x: 0, y: 0, params: {}, assetId: ref.id, visible: true, locked: false, solo: false });
  await per.saveProject(a);
  const dup = await per.duplicateProject(a.id);
  assert.notEqual(dup.graph.nodes.find(n => n.id === "i").assetId, ref.id);
  const trash = await per.deleteProject(a.id);
  assert.equal(await per.loadProject(a.id), null);
  await per.restoreDeleted(trash);
  assert.equal((await per.loadProject(a.id)).name, "A2");
  assert.ok(await per.getAsset(ref.id));
});
