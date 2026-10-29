/* Single project store. Every edit goes through update(), so one history covers every surface. */
import { createHistory } from "./history.js";
import { applyPatch } from "./schema.js";

const clone = v => JSON.parse(JSON.stringify(v));

export function createStore(project, { historyLimit = 100, knownTypes = null } = {}) {
  let state = clone(project);
  const history = createHistory(historyLimit), subs = new Set();
  const emit = (kind, label) => subs.forEach(fn => { try { fn(state, { kind, label }); } catch (e) { console.error(e); } });
  const store = {
    get project() { return state; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** fn mutates a draft clone. No-op edits are not recorded. Returns true when something changed. */
    update(label, fn, { coalesceKey = null } = {}) {
      const draft = clone(state);
      fn(draft);
      draft.updatedAt = state.updatedAt;
      if (JSON.stringify(draft) === JSON.stringify(state)) return false;
      draft.updatedAt = Date.now();
      history.push(state, label, coalesceKey);
      state = draft; emit("update", label); return true;
    },
    /** Apply AI patch JSON as one undoable step. Throws a human-readable error and leaves the project untouched on failure. */
    patch(patchJson) {
      const next = applyPatch(state, patchJson, knownTypes);
      return store.update("AI patch", d => Object.assign(d, next, { updatedAt: d.updatedAt }));
    },
    undo() { const e = history.undo(state); if (!e) return false; state = clone(e.snap); emit("undo", e.label); return true; },
    redo() { const e = history.redo(state); if (!e) return false; state = clone(e.snap); emit("redo", e.label); return true; },
    /** Swap in another project (open from library). Clears history so undo never crosses projects. */
    load(next) { state = clone(next); history.clear(); emit("load", null); },
    get history() { return history; },
  };
  return store;
}
