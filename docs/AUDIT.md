# n0ise audit (Phase 0)

Method: n0ise-document.js read in full. index.html and mobile.html surveyed via function outline, effect tables, state/serialize code and targeted greps (not every line). Render/effect bodies are one-liners (~60 chars of structure per fn); full parity review happens in Phase 2 per effect.

## Files
| file | lines | role |
|---|---|---|
| index.html | 2656 | desktop node editor + embedded "mobile" mode; canvas-2D only |
| mobile.html | 3057 | layer-stack editor; canvas-2D only |
| n0ise-document.js | 139 | DocumentCore (IDB `n0ise-documents`: `documents`, `assets`; key `recovery`) |

## State shapes
- **Desktop** `serializeProject()`: `{nodes, connections, groups, overlays, artboard, viewport, timeline, mobileStack, activeOutputId}`; media via `mediaId` (in-memory `mediaById`).
- **Mobile** `projectSnapshot()`: `{ratio, customW/H, mediaType, originalW/H, layers[] (paintData dataURL, assetId), stack[], activeLayer*, activeEffect, groups, export*, brush*}`.
- Node defs: sources (noise, solid, image, video, camera, text, gradient), effects (=EFFECTS minus none/gradient), composite (blend, transform, feedback, mask, merge), format (format, resizeCanvas, crop, letterbox, safeGuides), output (6 inputs).

## Effects
- Desktop EFFECTS: 27 (glitch vhs rgb pixelate dither halftone moire wave threshold duotone gradient datamosh pixelsort crt ascii kaleido lumaMesh film posterize edge mirror badtv scanDrift echo sharpen motion). All get `mix` + `intensity` prepended.
- Mobile EFFECTS: same base + bloom, y2k, acid, levels, hsl + EFFECT_PACK (table-driven: `[label, icon, params, category]`), with `category` used for filters.
- Impl: canvas 2D + `getImageData` loops on the main thread; `applyEffect` switch (mobile ~L1310-1700, desktop L1369-1443). `LIVE_EFFECTS`/`ANIMATED_LIVE_EFFECTS` sets decide per-frame redraw.
- Mobile has modulators (`modulatedParams`) not present on desktop.

## Bugs / gaps confirmed
1. Two schemas, one IDB key `recovery` -> cross-overwrite.
2. `exportProject` reads only `snapshot.layers[].assetId` -> node projects export without media (desktop uses `mediaId`, in-memory only; desktop recovery likely loses media on reload).
3. EFFECTS duplicated and drifted (above). Labels differ too (RGB vs RGB SPLIT).
4. Two undo systems on desktop (`historyStore` max 80 + `projectCore` checkpoints max 40); mobile separate (`MAX_UNDO` 20).
5. Dead UI in mobile.html: 14 `display:none` rules (some legitimate guide-lines; tabs, preset/play/text/bake/record/share/videoScrub to verify and delete).
6. Palette drift: 9 `rgba(0,255,170,...)` uses in mobile.html; mobile fonts Barlow Condensed + Space Mono; desktop JetBrains Mono + Syne.
7. Fonts from Google Fonts CDN; no manifest, no service worker.
8. Camera: only `<input capture>`; zero `getUserMedia` in either file.
9. Presets in localStorage (`n0ise_node_chain_presets_v1`, `noisePreset`) outside try/catch in places.
10. `user-scalable`: mobile.html has 1 occurrence (blocks zoom, a11y).
11. Export: MediaRecorder + canvas.captureStream, custom LZW GIF encoder; mp4 only if MediaRecorder reports support (Safari). Reusable.

## Reusable
Effect param tables (copy verbatim to keep old projects loading), effect pixel code, graph evaluator concept (`evalNode`, dirty/dependents/cycle in `ensureRenderLifecycle`), `validateProject`/`applyPatchProject`/`projectAiPackage`, GIF encoder, node-preset logic, seeded RNG, DocumentCore asset store.

## Perf hotspots (to confirm by profiling in Phase 2)
Main-thread `getImageData` loops (dither, pixelsort, glitch, ascii, halftone, mesh, datamosh); `cloneCanvas` per effect; `hsl()` allocates a canvas per call; no canvas pooling.
