# 044 · Every sub-chart copy of a pointermove keeps isMaster: true, so each sub-chart, active or not, re-broadcasts the move to every other top-level 2D surface for each modifier group

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Core/Mouse/MouseManager.js:654` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pointer move, pan/zoom), also INP for down/up |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/b18ab9f565ed5563ff6b5157fd8df34c/): reproduced on WebGL and WebGPU ([source](../demos/044-subchart-move-rebroadcast/)) |
| Rule | SC-42 (web-performance skill) |
| Effort to fix | small |

## Code

```js
            if (subEventType !== undefined) {
                const masterData = this.getMasterData(currentActiveSubChart, args);
                handledBySubchart =
                    handledBySubchart ||
                        this.processSubChartEvent(subEventType, scs, { ...args, isActiveSubChartEvent }, subCharts, masterData);
            }
```

## Call path and frequency

pointermove on the parent canvas -> MouseManager.onPointerMove (MouseManager.js:107-114) -> modifierMouseMove (:308) -> updateSubCharts (:334, :599). Every sub-chart with an offset that the pointer is not over still gets Move, with isActiveSubChartEvent=false (:647-651); the active one gets it with true -> processSubChartEvent (:658, :663) -> callEvent -> scs.mouseManager.modifierMouseMove(copy) (:702). The copy is `{ ...args, isActiveSubChartEvent }`, so isMaster stays true (set at ModifierMouseArgs.js:63) and the sub-chart's own fan-out block runs (:326-333): chartModifierGroups (:592-595) x sciChartSurface.otherSurfaces, recomputed per group from the global registry (SciChartSurfaceCore.js:75-88 -> Globals.js:87). Sub-surfaces are not registered but report a 2D surface type (SciChartSurface.js:395), so the list is every registered top-level 2D surface, the parent included -> ModifierMouseArgs.copy + other.mouseManager.modifierMouseMove for each. The receiving top-level surface is not a sub-surface, so the RolloverModifier/CursorModifier guard on isActiveSubChartEvent (RolloverModifier.js:254, CursorModifier.js:258) does not stop it. Inactive sub-charts receive only Move, Up and Cancel (:647-651), so Up and Cancel are duplicated the same way once per interaction; Move is the per-input-event case.

## Why it costs

Per pointermove, the work is O(S x groups x surfaces): S spread copies, S global-registry scans, and S dispatches into each other surface's modifier list. A RolloverModifier or CursorModifier on another chart in the same group runs its full update (hit test of every series, tooltip templates, SVG invalidation) S times. Only the last update is kept, and its point was mapped through the rect of the last sub-chart in iteration order, which is usually not the one under the pointer. Inactive sub-charts' own rollover and cursor modifiers return early (RolloverModifier.js:254), so this work buys nothing.

**Scale where it matters:** Multi-pane layouts built as sub-charts (SC-17 recommends them; 8-100 panes) whose cursor or rollover modifiers share a modifierGroup. The cost multiplies when another top-level chart shares that group. A Node mock that drives the real cjs MouseManager (counts dispatches only, no timing) gave the other chart's grouped modifier 8 full updates per pointermove with 8 sub-charts and 32 with 32. It should get 1.

## Fix (library side)

```diff
--- esm/Core/Mouse/MouseManager.js  modifierMouseMove (:326) only
-        if (args.isMaster) {
+        // A move copied from the parent into an inactive sub-chart (isActiveSubChartEvent === false) must not
+        // re-broadcast to every other top-level surface: only real master events and the active sub-chart fan out.
+        // Leave modifierMouseUp/modifierPointerCancel unchanged: a release outside every sub-chart has no active
+        // sub-chart, and grouped modifiers on other surfaces still need that Up/Cancel to end a drag.
+        if (args.isMaster && args.isActiveSubChartEvent !== false) {
             const masterData = this.getMasterData(this.sciChartSurface, args);
-            this.chartModifierGroups.forEach(modifierGroup => {
-                this.sciChartSurface.otherSurfaces.forEach(scs => {
+            const groups = this.chartModifierGroups;
+            const others = groups.length > 0 ? this.sciChartSurface.otherSurfaces : []; // one registry scan, not one per group
+            groups.forEach(modifierGroup => {
+                others.forEach(scs => {
```

**Trade-off:** Grouped modifiers on other surfaces get one move per pointermove, from the active sub-chart, in place of one per sub-chart. While the pointer is over the parent but over no sub-chart they get no move at all; the Leave that the sub-chart sends when the pointer leaves it is built from the parent's master args (isActiveSubChartEvent=true, MouseManager.js:624) and still fans out, so their tooltips are hidden as before. Up and Cancel keep the per-sub-chart duplicates, which run once per interaction. updateSubCharts inside the same block does nothing for sub-charts, which have no nested sub-charts.

## App-side workaround

Do not share a modifierGroup between sub-chart modifiers and modifiers on other top-level surfaces. Sync external charts through axis visibleRangeChanged or a single owner instead.

## Verify

measure.md#fps hover scenario: parent with 16 sub-charts, each with RolloverModifier({ modifierGroup: 'g' }), plus one separate surface with RolloverModifier({ modifierGroup: 'g' }); sweep the pointer for 5 s, 5 runs per side, with a dev counter of RolloverModifier.update calls per pointermove on the separate surface. Pass: the counter reads 1 per move (16 before), LoAF script time attributed to MouseManager.onPointerMove goes down, and frameP95Ms wins or is neutral.

## Other locations

- `esm/Core/Mouse/MouseManager.js:326` — isMaster fan-out block run by sub-chart copies
- `esm/Core/Mouse/MouseManager.js:592` — chartModifierGroups getter: filter + map + indexOf-unique per event
- `esm/Charting/Visuals/SciChartSurfaceCore.js:75` — getOtherSurfaces scans the global registry per call; sub-surfaces inherit it and see the parent
- `esm/Core/Globals.js:87` — getOtherDestinations filter + map per call

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Adversarial verification (corrected): Re-read MouseManager.js:599-662 (updateSubCharts), :663-682 (processSubChartEvent), :683-718 (callEvent), :308-335 (modifierMouseMove), ModifierMouseArgs.js:55-111, SciChartSurfaceCore.js:60-89, Globals.js:58-90, createMaster.js:292, SciChartSurface.js:395, RolloverModifier.js:252-255. Confirmed: the spread `{ ...args, isActiveSubChartEvent }` at MouseManager.js:658 keeps isMaster === true (fromPointerEvent sets it at ModifierMouseArgs.js:63; only copy/copyForSubChart at :89/:105 clear it). callEvent(Move) -> sub-chart mouseManager.modifierMouseMove(copy) -> the isMaster block at :326 runs on the sub-chart: chartModifierGroups (:592) x otherSurfaces. Sub-surfaces are never registered (addDestination only in createMaster.js:292 / createSingle.js:170) but report SciChartSurfaceType (SciChartSurface.js:395, 2D), so getOtherSurfaces (SciChartSurfaceCore.js:75-88 -> Globals.getOtherDestinations :87) returns every registered top-level 2D surface, the parent included, recomputed per group. Inactive sub-charts still get Move (:647-651, isActiveSubChartEvent=false) and their copies to another surface keep isActiveSubChartEvent=false, but the receiving top-level surface is not a sub-surface, so its RolloverModifier/CursorModifier guard (RolloverModifier.js:254, CursorModifier.js:258) does not stop the update. So a grouped modifier on another top-level chart runs S updates per pointermove. Corrections: (1) primary line 658 -> 654 so the quote starts at the cited line; (2) inactive sub-charts receive only Move, Up and Cancel (:647-651), so duplicates come from those three handlers, not 'every pointer event', and only Move is per-input-event; (3) the fix must not be applied to Up/PointerCancel: when the pointer is released outside every sub-chart there is no active sub-chart, all copies have isActiveSubChartEvent=false, and the proposed guard would drop the only Up/Cancel that grouped modifiers on other surfaces receive (stuck drag). Fix limited to modifierMouseMove; Leave is sent with isActiveSubChartEvent=true (leaveArgs built from the parent's master args, :624) so other surfaces still hide their tooltips when the pointer leaves a sub-chart. Severity stays medium: per pointermove, but the heavy part (S full rollover/cursor updates) needs sub-charts with grouped modifiers that share a group with another top-level surface; without that the extra work is S registry scans + copies + modifier-list loops. Evidence S: the dispatch count follows directly from the code.

