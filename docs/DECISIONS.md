# Decisions (proposed, pending approval)

1. **Build**: no build step. Native ES modules, static files, GitHub Pages as-is, CNAME untouched. Tests via a no-dependency HTML/Node runner (`node --test`), Playwright later as dev-only.
2. **Rendering**: canvas-2D remains the reference and export path (exact parity with old projects). WebGL2 shaders added only for ~6 costly live effects (glitch, vhs, rgb, crt, bloom, blur-based) in Phase 2b, with a tolerance test against 2D.
3. **Workers**: skip at first; move pixel-loop effects to an OffscreenCanvas worker only if profiling shows >50ms frames after WebGL.
4. **Schema v3**: single graph; mobile stack = `stackView.chainNodeIds`. Migrations for desktop v1, mobile v1 (snapshot v1), v2.
5. **Persistence**: IDB `n0ise-v3` with `projects`, `assets`; per-project key; old `n0ise-documents` read once for migration, never written.
6. **Fonts**: self-host JetBrains Mono + Syne woff2 (needs downloading; license OFL).
