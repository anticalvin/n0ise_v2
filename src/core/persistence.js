/* Project library: one record per project, per-project autosave, media-embedded import/export, resilient to missing/full storage. */
import { migrate, FORMAT, VERSION, uid } from "./schema.js";

const DB_NAME = "n0ise-v3", LEGACY_DB = "n0ise-documents";
const STORES = ["projects", "assets", "meta"];
const clone = v => JSON.parse(JSON.stringify(v));

export function memoryBackend() {
  const s = Object.fromEntries(STORES.map(n => [n, new Map()]));
  return {
    kind: "memory",
    async get(st, k) { return s[st].get(k); },
    async put(st, k, v) { s[st].set(k, v); },
    async del(st, k) { s[st].delete(k); },
    async all(st) { return [...s[st].values()]; },
  };
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function idbBackend(factory = globalThis.indexedDB) {
  let dbp = null;
  const open = () => dbp ||= new Promise((res, rej) => {
    if (!factory) return rej(new Error("IndexedDB unavailable"));
    let r; try { r = factory.open(DB_NAME, 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => STORES.forEach(n => r.result.objectStoreNames.contains(n) || r.result.createObjectStore(n));
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("IndexedDB blocked"));
  });
  const os = async (st, mode) => (await open()).transaction(st, mode).objectStore(st);
  return {
    kind: "idb",
    async get(st, k) { return req((await os(st, "readonly")).get(k)); },
    async put(st, k, v) { return req((await os(st, "readwrite")).put(v, k)); },
    async del(st, k) { return req((await os(st, "readwrite")).delete(k)); },
    async all(st) { return req((await os(st, "readonly")).getAll()); },
    probe: open,
  };
}

/* ---------- base64 helpers (work in browsers and Node) ---------- */
export async function blobToDataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
}
export function dataURLToBlob(url) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url || "");
  if (!m) throw new Error("Embedded media is not a valid data URL.");
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || "application/octet-stream" });
}

export function createPersistence({ backend = null, onError = () => {}, autosaveMs = 650 } = {}) {
  let be = backend || idbBackend(), degraded = false;
  const mem = memoryBackend();
  const timers = new Map(), pending = new Map();

  /** Run on the main backend; if storage is unavailable/full, report once and keep the session alive in memory. */
  async function run(op, ...args) {
    if (!degraded) {
      try { return await be[op](...args); }
      catch (error) {
        degraded = true;
        onError({ kind: error?.name === "QuotaExceededError" ? "quota" : "unavailable", error });
      }
    }
    return mem[op](...args);
  }

  const api = {
    get degraded() { return degraded; },
    get backendKind() { return degraded ? "memory" : be.kind; },

    async listProjects() {
      const rows = (await run("all", "meta")).filter(m => m?.id);
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async loadProject(id) {
      const rec = await run("get", "projects", id);
      return rec ? clone(rec) : null;
    },
    async saveProject(project) {
      const prev = await run("get", "meta", project.id);
      await run("put", "projects", project.id, clone(project));
      await run("put", "meta", project.id, { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, thumb: prev?.thumb || null });
    },
    /** Debounced autosave keyed by project id: editing project A can never write project B. */
    scheduleSave(project) {
      pending.set(project.id, project);
      clearTimeout(timers.get(project.id));
      timers.set(project.id, setTimeout(() => api.flush(project.id), autosaveMs));
    },
    async flush(id = null) {
      for (const pid of id ? [id] : [...pending.keys()]) {
        clearTimeout(timers.get(pid)); timers.delete(pid);
        const p = pending.get(pid); pending.delete(pid);
        if (p) await api.saveProject(p);
      }
    },
    async setThumbnail(id, dataURL) {
      const m = await run("get", "meta", id); if (m) await run("put", "meta", id, { ...m, thumb: dataURL });
    },

    async addAsset(file) {
      const asset = { id: uid("a"), name: file.name || "source", type: file.type || "application/octet-stream", blob: file, addedAt: Date.now() };
      await run("put", "assets", asset.id, asset);
      return { id: asset.id, name: asset.name, type: asset.type };
    },
    async getAsset(id) { return id ? (await run("get", "assets", id)) || null : null; },

    async deleteProject(id) {
      const p = await api.loadProject(id);
      const trash = p ? { project: p, assets: (await Promise.all(assetIdsOf(p).map(a => api.getAsset(a)))).filter(Boolean) } : null;
      await run("del", "projects", id); await run("del", "meta", id);
      for (const a of trash?.assets || []) await run("del", "assets", a.id);
      return trash; // hand back to restoreDeleted() for the undo toast
    },
    async restoreDeleted(trash) {
      for (const a of trash.assets) await run("put", "assets", a.id, a);
      await api.saveProject(trash.project);
    },
    async duplicateProject(id) {
      const p = await api.loadProject(id); if (!p) return null;
      const map = new Map();
      for (const aid of assetIdsOf(p)) { const a = await api.getAsset(aid); if (!a) continue; const nid = uid("a"); map.set(aid, nid); await run("put", "assets", nid, { ...a, id: nid }); }
      p.id = uid("p"); p.name += " copy"; p.createdAt = p.updatedAt = Date.now();
      remapAssets(p, map);
      await api.saveProject(p); return p;
    },

    /** n0ise-project export with every referenced asset embedded (all project types). */
    async exportProject(project) {
      const assets = [];
      for (const id of assetIdsOf(project)) {
        const a = await api.getAsset(id);
        if (a?.blob) assets.push({ id: a.id, name: a.name, type: a.type, data: await blobToDataURL(a.blob) });
      }
      return { format: FORMAT, version: VERSION, exportedAt: Date.now(), project: clone(project), assets };
    },
    /** Accepts any supported file shape. Never overwrites an existing project: a colliding id gets a fresh one. */
    async importProject(raw) {
      const { project, warnings, wrapperAssets } = migrate(raw);
      for (const a of wrapperAssets) {
        if (!a?.id || !a.data) continue;
        const blob = dataURLToBlob(a.data);
        await run("put", "assets", a.id, { id: a.id, name: a.name || "source", type: a.type || blob.type, blob, addedAt: Date.now() });
      }
      await externalizePaint(project, api);
      if (await run("get", "projects", project.id)) project.id = uid("p");
      project.updatedAt = Date.now();
      await api.saveProject(project);
      return { project, warnings };
    },

    /** One-time import of the old single-slot recovery document (desktop or mobile shape). Never writes to the old DB. */
    async importLegacyRecovery(factory = globalThis.indexedDB) {
      if (await run("get", "meta", "__legacyImported")) return null;
      let rec = null, legacyAssets = new Map();
      try {
        const db = await new Promise((res, rej) => { const r = factory.open(LEGACY_DB); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        if (db.objectStoreNames.contains("documents")) {
          rec = await req(db.transaction("documents").objectStore("documents").get("recovery"));
          if (rec?.snapshot) for (const l of rec.snapshot.layers || []) if (l.assetId) { const a = await req(db.transaction("assets").objectStore("assets").get(l.assetId)); if (a) legacyAssets.set(l.assetId, a); }
        }
        db.close();
      } catch { return null; }
      await run("put", "meta", "__legacyImported", { id: "__legacyImported", updatedAt: 0 });
      if (!rec?.snapshot) return null;
      for (const a of legacyAssets.values()) await run("put", "assets", a.id, a);
      const res = await api.importProject(rec.snapshot);
      res.project.name = "Recovered project";
      await api.saveProject(res.project);
      return res;
    },
  };
  return api;
}

export function assetIdsOf(p) {
  const ids = new Set((p.assets || []).map(a => a.id));
  for (const n of p.graph?.nodes || []) if (n.assetId) ids.add(n.assetId);
  for (const o of p.overlays || []) if (o.assetId) ids.add(o.assetId);
  return [...ids];
}
function remapAssets(p, map) {
  p.graph.nodes.forEach(n => { if (map.has(n.assetId)) n.assetId = map.get(n.assetId); });
  (p.overlays || []).forEach(o => { if (map.has(o.assetId)) o.assetId = map.get(o.assetId); });
  p.assets = (p.assets || []).map(a => map.has(a.id) ? { ...a, id: map.get(a.id) } : a);
}
async function externalizePaint(project, api) {
  for (const n of project.graph.nodes) {
    const d = n.params?.paintData; if (typeof d !== "string") continue;
    delete n.params.paintData;
    if (!d.startsWith("data:")) continue;
    const ref = await api.addAsset(Object.assign(dataURLToBlob(d), { name: `${n.label || "paint"}.png` }));
    n.assetId = ref.id; project.assets.push(ref);
  }
}
