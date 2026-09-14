/* n0ise document core — local-first persistence for both editor surfaces. */
(function (global) {
  "use strict";
  const DB_NAME = "n0ise-documents";
  const DB_VERSION = 1;
  const DOC_KEY = "recovery";
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = () => global.crypto?.randomUUID?.() || `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error("IndexedDB unavailable"));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("documents")) db.createObjectStore("documents");
        if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function requestResult(request) {
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async function readAsset(db, assetId) {
    return requestResult(db.transaction("assets", "readonly").objectStore("assets").get(assetId));
  }
  async function blobToDataURL(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  }
  async function dataURLToBlob(dataURL) { return (await fetch(dataURL)).blob(); }

  class DocumentCore {
    constructor(options) {
      this.getSnapshot = options.getSnapshot;
      this.applySnapshot = options.applySnapshot;
      this.maxHistory = options.maxHistory || 40;
      this.undoStack = [];
      this.redoStack = [];
      this.db = null;
      this.saveTimer = 0;
      this.initialized = false;
      this.dirty = false;
    }
    async open() { if (!this.db) this.db = await openDB(); return this.db; }
    initialize() { this.initialized = true; this.dirty = false; this.scheduleSave(); }
    checkpoint() {
      if (!this.initialized) return;
      const snapshot = clone(this.getSnapshot());
      const last = this.undoStack.at(-1);
      if (!last || JSON.stringify(last) !== JSON.stringify(snapshot)) {
        this.undoStack.push(snapshot);
        if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      }
      this.redoStack.length = 0;
      this.dirty = true;
      // Callers checkpoint immediately before an edit. Debouncing the read means
      // the recovery record captures the completed edit, rather than only the
      // previous undo state.
      this.scheduleSave();
    }
    async undo() {
      const snapshot = this.undoStack.pop();
      if (!snapshot) return false;
      this.redoStack.push(clone(this.getSnapshot()));
      await this.applySnapshot(clone(snapshot));
      this.scheduleSave();
      return true;
    }
    async redo() {
      const snapshot = this.redoStack.pop();
      if (!snapshot) return false;
      this.undoStack.push(clone(this.getSnapshot()));
      await this.applySnapshot(clone(snapshot));
      this.scheduleSave();
      return true;
    }
    async putAsset(file) {
      const db = await this.open();
      const asset = { id:id(), blob:file, name:file.name || "source", type:file.type || "application/octet-stream", updatedAt:Date.now() };
      await requestResult(db.transaction("assets", "readwrite").objectStore("assets").put(asset, asset.id));
      return asset;
    }
    async asset(assetId) { return assetId ? readAsset(await this.open(), assetId) : null; }
    scheduleSave() {
      if (!this.initialized) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveRecovery(), 650);
    }
    async saveRecovery() {
      try {
        const db = await this.open();
        const record = { version:1, savedAt:Date.now(), snapshot:clone(this.getSnapshot()) };
        await requestResult(db.transaction("documents", "readwrite").objectStore("documents").put(record, DOC_KEY));
      } catch (error) { console.warn("n0ise recovery save failed", error); }
    }
    async restoreRecovery() {
      try {
        const db = await this.open();
        const record = await requestResult(db.transaction("documents", "readonly").objectStore("documents").get(DOC_KEY));
        if (!record?.snapshot) return false;
        await this.applySnapshot(record.snapshot);
        this.dirty = false;
        return true;
      } catch (error) { console.warn("n0ise recovery unavailable", error); return false; }
    }
    async clearRecovery() {
      try {
        const db = await this.open();
        await requestResult(db.transaction("documents", "readwrite").objectStore("documents").delete(DOC_KEY));
      } catch (error) { console.warn("n0ise recovery clear failed", error); }
      this.dirty = false;
    }
    async exportProject() {
      const snapshot = clone(this.getSnapshot());
      const ids = [...new Set((snapshot.layers || []).map(layer => layer.assetId).filter(Boolean))];
      const assets = [];
      for (const assetId of ids) {
        const asset = await this.asset(assetId);
        if (asset?.blob) assets.push({ id:asset.id, name:asset.name, type:asset.type, data:await blobToDataURL(asset.blob) });
      }
      return { format:"n0ise-project", version:1, exportedAt:Date.now(), snapshot, assets };
    }
    async importProject(project) {
      if (!project || project.format !== "n0ise-project" || !project.snapshot) throw new Error("This is not a n0ise project.");
      const db = await this.open();
      for (const incoming of project.assets || []) {
        if (!incoming?.id || !incoming.data) continue;
        const blob = await dataURLToBlob(incoming.data);
        const asset = { id:incoming.id, name:incoming.name || "source", type:incoming.type || blob.type, blob, updatedAt:Date.now() };
        await requestResult(db.transaction("assets", "readwrite").objectStore("assets").put(asset, asset.id));
      }
      await this.applySnapshot(project.snapshot);
      this.undoStack.length = 0; this.redoStack.length = 0; this.scheduleSave();
    }
  }
  global.N0iseDocument = { DocumentCore };
})(window);
