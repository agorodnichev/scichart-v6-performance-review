# 083 · Without a runtime key, every page on any hostname polls http://localhost:24278 for the licensing wizard, up to 10 times at 5 s intervals, also in hidden tabs

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/licenseManager2D.js:847` |
| Severity | **low** |
| Pipeline stage | Network (`network`) |
| Metric | network (also tasks) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/e71d1491235c13b7a622cbc5279b2d11/): reproduced on WebGL and WebGPU ([source](../demos/083-license-wizard-localhost-polling/)) |
| Rule | TASK-09 (also LIFE-06) (web-performance skill) |
| Effort to fix | small |

## Code

```js
        if (wizardTimer === undefined && useLicenseWizard) {
            checkStatus = LicenseCheckStatus.StartLookingForLicenseWizard;
            licenseManager2dState.isDev = true;
            getlicenseFromWizard(licenseContext);
        }
```

## Call path and frequency

createMaster (createMaster.js:330) or createSingleInternal (createSingle.js:72) -> licenseManager.applyLicense (licenseManager2D.js:638) -> no runtime key (:645-651) and no cookie (:680-698), so checkStatus stays NoLicense (:837-852) -> getlicenseFromWizard (:190) -> fetchFromWizard (:19-47) -> fetch('http://localhost:24278/license'). On connection failure: setTimeout(retry, 5000) until maxretries 10 (:180-181, :225-239). When the status changes, updateLicenseDisplayInternal runs for every surface (:240-244) and invalidates it (:1170). Runs once per page load, then every 5 s for about 50 s, also in hidden tabs.

## Why it costs

The page makes up to 10 cross-origin requests to a loopback address and schedules timer tasks that keep running in hidden tabs, and every surface redraws when the status changes (on the first failure and on giving up). The per-request main-thread cost is small; the waste is network activity and timers with no purpose on a non-development host. Browsers that gate loopback access from public sites may also block or prompt; that was not checked against support.md.

**Scale where it matters:** Every production page that uses the community edition without calling SciChartSurface.UseCommunityLicense() (or setRuntimeLicenseKey).

## Fix (library side)

```diff
-        if (wizardTimer === undefined && useLicenseWizard) {
+        const host = typeof location !== "undefined" ? location.hostname : "";
+        const isLocalDev = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
+        if (wizardTimer === undefined && useLicenseWizard && isLocalDev) {
```

**Trade-off:** Developers who serve the dev build on a custom hostname (a LAN IP or *.test) would have to opt in to the wizard, for example through the existing setUseLicenseWizard export plus a new opt-in, so this is a behaviour change for them. Production community pages stop probing.

## App-side workaround

Call SciChartSurface.UseCommunityLicense() (community) or SciChartSurface.setRuntimeLicenseKey(...) before the first create().

## Verify

measure.md#load on a non-localhost origin with no license key, with a 60 s trace. Pass: list_network_requests shows no request to localhost:24278, and the trace window has no 5 s timer tasks from licenseManager2D.

## Other locations

- `esm/Charting/Visuals/licenseManager2D.js:231` — retry timer: setTimeout(getlicenseFromWizard, 5000) until maxretries
- `esm/Charting/Visuals/licenseManager2D.js:19` — fetchFromWizard: fetch to http://localhost:<port>/license
- `esm/Charting/Visuals/licenseManager2D.js:842` — the only hostname check, which gates a console.log

## Review notes

- Found by reviewer slice `s02-init-loading`.
- Adversarial verification (corrected): Quote matches licenseManager2D.js:847-851. Re-traced applyLicense (:638-853): with no runtime key and no cookie, checkStatus stays NoLicense and the wizard probe starts regardless of hostname; :842's localhost test only controls the console message. UseCommunityLicense (SciChartSurfaceBase.js:167-169) sets runtime key 'community', which takes the licenseKey path and skips probing. Confirmed retry loop (retryTime 5, maxretries 10 at :180-181; catch branch :225-239) and the per-surface redraw on status change (:240-244 -> updateLicenseDisplayInternal -> invalidateElement at :1170). Corrected the reviewer's line references (:186 -> :190, :181-182 -> :180-181, :226-232 -> :225-239, :232-235 -> :240-244) and noted the fix is a behaviour change for non-localhost dev hosts. Low severity kept (once per page load, small per-call cost).

