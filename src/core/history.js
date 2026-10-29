/* The one undo/redo system. Stores whole-project snapshots (projects hold asset references, not blobs, so they stay small). */
export function createHistory(limit = 100) {
  let past = [], future = [], lastKey = null, lastAt = 0;
  return {
    /** Record `before` as an undo point. Edits sharing a `coalesceKey` within 800ms (slider drags) collapse into one step. */
    push(before, label = "edit", coalesceKey = null, now = Date.now()) {
      const merge = coalesceKey && coalesceKey === lastKey && now - lastAt < 800 && past.length;
      lastKey = coalesceKey; lastAt = now; future = [];
      if (merge) return;
      past.push({ label, snap: before });
      if (past.length > limit) past.shift();
    },
    undo(current) { const e = past.pop(); if (!e) return null; future.push({ label: e.label, snap: current }); lastKey = null; return e; },
    redo(current) { const e = future.pop(); if (!e) return null; past.push({ label: e.label, snap: current }); lastKey = null; return e; },
    clear() { past = []; future = []; lastKey = null; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get undoLabel() { return past.at(-1)?.label || null; },
  };
}
