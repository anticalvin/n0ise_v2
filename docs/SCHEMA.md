# Project schema v3

`{format:"n0ise-project", version:3, id, name, createdAt, updatedAt, artboard{width,height,ratio}, timeline{duration,loop,fps}, graph{nodes[],connections[],groups[],outputId}, stackView{chainNodeIds[]}, overlays[], assets[{id,name,type}], ui{}}`

Node: `{id,type,label,x,y,params,assetId,visible,locked,solo}`. Connection: `{id,from,fromPort,to,toPort}`.

## Migration (`migrate()` in src/core/schema.js)
Accepts v3, export wrappers (v1 `snapshot`, v3 `project`) and bare desktop (`nodes`) / mobile (`layers`) snapshots. There is no "v2" shape in the shipped code; v2 files are handled by shape detection.
- Desktop: nodes/connections copied; `mediaId` -> `assetId` (the old ids were in-memory only, so warn); `activeOutputId` -> `outputId`; `stackView` derived by walking back from output.
- Mobile layers -> source nodes: base/image -> `image`, base video/video -> `video`, text -> `text`, blank/solid -> `solid`, paint -> `image` (pixels moved into an asset on import). Layer position becomes image params (x,y in -1..1, scale, rotation deg) or a `transform` node. Layer effects/adjustments become effect nodes after the source. Layers merge via a `blend` chain (A = accumulated, B = layer; `mix` = opacity, `mode` = blend). The global stack becomes effect nodes before the output and is `stackView.chainNodeIds`. Layer groups -> `graph.groups`.
- Not migrated (warned): layer masks.

## AI patch (`applyPatch`)
`{nodes:[{id,params,x,y,label,visible,locked,solo,assetId}], addNodes:[{type,id?,params,...}], removeNodeIds:[], connections:[{from,to,fromPort?,toPort?}], artboard, timeline, overlays, outputId}`. Validated as a whole; on failure nothing changes and the error is readable. One undo step.
