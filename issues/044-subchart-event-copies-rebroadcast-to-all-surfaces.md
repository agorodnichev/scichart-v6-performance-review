# 044 · Every sub-chart copy of a pointer event keeps isMaster: true, so each sub-chart, active or not, re-broadcasts the event to every other top-level 2D surface for each modifier group

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Core/Mouse/MouseManager.js:658` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pointer move, pan/zoom), also INP for down/up |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

pointermove on the parent canvas -> MouseManager.onPointerMove (MouseManager.js:107-114) -> modifierMouseMove (:308) -> updateSubCharts (:334, :599). For each of S sub-charts, Move is forwarded even when the pointer is not over that sub-chart (:648) -> processSubChartEvent (:663) -> callEvent -> scs.mouseManager.modifierMouseMove(copy) (:702). The copy still has isMaster === true, so the sub-chart's own fan-out block runs (:326-333): chartModifierGroups (:592-595) -> sciChartSurface.otherSurfaces, which is recomputed per group from the global registry (SciChartSurfaceCore.js:75-87 -> Globals.js:87) and returns every top-level 2D surface, the parent included -> ModifierMouseArgs.copy + other.mouseManager.modifierMouseMove for each one. This runs on every pointer event (move/down/up/wheel/leave/enter), and the same block is repeated in all 9 modifierX methods.

## Why it costs

Per pointermove, the work is O(S x groups x surfaces): S spread copies, S global-registry scans, and S dispatches into each other surface's modifier list. A RolloverModifier or CursorModifier on another chart in the same group runs its full update (hit test of every series, tooltip templates, SVG invalidation) S times. Only the last update is kept, and that point was mapped through the last sub-chart's rect, which is the wrong one. Inactive sub-charts' own rollover modifiers return early, so this work buys nothing.

**Scale where it matters:** Multi-pane layouts built as sub-charts (SC-17 recommends them; 8-100 panes) whose cursor or rollover modifiers share a modifierGroup. The cost multiplies when another top-level chart shares that group. A Node mock that drives the real cjs MouseManager (counts dispatches only, no timing) gave the other chart's grouped modifier 8 full updates per pointermove with 8 sub-charts and 32 with 32. It should get 1.

## Fix (library side)

```diff
--- esm/Core/Mouse/MouseManager.js (same change in modifierMouseMove/Down/Up/Wheel/DoubleClick/Leave/Enter/Drop/PointerCancel)
-        if (args.isMaster) {
+        // A sub-chart's copy of the parent's event (isActiveSubChartEvent === false) must not re-broadcast
+        // to every other top-level surface: only real master events and the active sub-chart fan out.
+        if (args.isMaster && args.isActiveSubChartEvent !== false) {
             const masterData = this.getMasterData(this.sciChartSurface, args);
-            this.chartModifierGroups.forEach(modifierGroup => {
-                this.sciChartSurface.otherSurfaces.forEach(scs => {
+            const groups = this.chartModifierGroups;
+            const others = groups.length > 0 ? this.sciChartSurface.otherSurfaces : []; // one registry scan, not one per group
+            groups.forEach(modifierGroup => {
+                others.forEach(scs => {
```

**Trade-off:** Grouped modifiers on other surfaces get one copy per event, from the active sub-chart, in place of one per sub-chart. Code that depended on inactive sub-charts re-broadcasting would change behavior, but that re-broadcast only left wrong positions. updateSubCharts inside the same block does nothing for sub-charts, which have no nested sub-charts.

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

