const META = {
  id: "083",
  title: "Without a license key, any page polls http://localhost:24278 for the licensing wizard, whatever its host",
  issue: "issues/083-license-wizard-localhost-polling-on-any-host.md",
  severity: "low",
  claim: "With no runtime key and no license cookie, applyLicense() starts fetching http://localhost:24278/license and retries every 5 s, up to 10 times. The only hostname test in licenseManager2D.js (hostname.startsWith(\"localhost\")) decides whether a console message is printed; the requests are sent on every host.",
  method: "<p>This page does <b>not</b> call SciChartSurface.UseCommunityLicense() (META.communityLicense = false), as a production page that never set a key would. It creates one chart, then for 11 s records every fetch() to localhost:24278 (time and outcome), every setTimeout(…, 5000), and every console message that mentions the licensing wizard. Then it calls SciChartSurface.UseCommunityLicense(), the workaround from the issue, and watches for another 6 s. The page's own hostname is shown next to the result of the library's only hostname check.</p><p>A request to a closed loopback port fails fast, so the retries come at about 5 s intervals. On a public host (for example JSFiddle) newer Chrome versions may hold the request behind a local-network permission prompt; the page then counts one pending request and no retries.</p>",
  communityLicense: false,
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, SciChartSurface } = P.SciChart;
  const WATCH_MS = 11000, AFTER_MS = 6000;
  const host = location.hostname;
  const libraryHostTest = host.startsWith("localhost"); // the test at licenseManager2D.js:842

  // Every request to the wizard port, with its outcome.
  const wizard = [];
  P.hookMethod(window, "fetch", {
    name: "fetch (any)",
    onCall(args, self, ret) {
      const url = String((args[0] && args[0].url) || args[0]);
      if (!/^https?:\/\/localhost:\d+\/license/.test(url)) return;
      const rec = { url, t: P.now(), outcome: "pending" };
      wizard.push(rec);
      Promise.resolve(ret).then(
        (r) => { rec.outcome = "HTTP " + r.status; },
        (e) => { rec.outcome = "failed: " + ((e && e.message) || e); },
      );
    },
  });
  P.hookMethod(window, "setTimeout", { name: "setTimeout (any)", onCall(a) { if (a[1] === 5000) P.count("setTimeout(…, 5000)"); } });
  P.hookMethod(console, "log", { name: "console.log", onCall(a) { if (/licens\w* wizard/i.test(String(a[0]))) P.count("console: wizard message"); } });

  P.status("Creating a chart without UseCommunityLicense()…");
  const t0 = P.now();
  const phase1 = await P.during(async () => {
    const { sciChartSurface, wasmContext } = await P.createSurface("chart");
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
    const xs = Array.from({ length: 200 }, (_, i) => i);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 15)), isSorted: true, containsNaN: false }),
      stroke: "#4e79a7", strokeThickness: 2,
    }));
    for (let s = 0; s < WATCH_MS / 1000; s++) {
      P.status(`Watching requests to localhost:24278… ${s} / ${WATCH_MS / 1000} s (${wizard.length} so far)`);
      await P.sleep(1000);
    }
  });
  const shipped = wizard.slice();
  shipped.forEach((r) => P.log(`+${((r.t - t0) / 1000).toFixed(2)} s  ${r.url}  -> ${r.outcome}`));
  const gaps = shipped.slice(1).map((r, i) => (r.t - shipped[i].t) / 1000);
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;

  P.status("Calling SciChartSurface.UseCommunityLicense() (workaround) and watching again…");
  const before = wizard.length;
  const phase2 = await P.during(async () => {
    SciChartSurface.UseCommunityLicense();
    await P.sleep(AFTER_MS);
  });
  const afterWorkaround = wizard.length - before;
  P.log(`after UseCommunityLicense(): ${afterWorkaround} request(s) in ${AFTER_MS / 1000} s`);

  const timers = phase1.total("setTimeout(…, 5000)");
  const messages = phase1.total("console: wizard message");
  const failedFast = shipped.filter((r) => r.outcome.startsWith("failed")).length;
  let verdict, headline;
  if (libraryHostTest) {
    verdict = "inconclusive";
    headline = `This page runs on "${host}", where probing for the wizard is the intended development behaviour (${shipped.length} request(s) seen). Open it from another host (JSFiddle, 127.0.0.1) to test the claim.`;
  } else if (shipped.length >= 1) {
    verdict = "reproduced";
    headline = `On host "${host}" the library sent ${shipped.length} request(s) to localhost:24278 in ${WATCH_MS / 1000} s` +
      (meanGap ? `, one every ${meanGap.toFixed(1)} s,` : "") +
      ` and scheduled ${timers} five-second retry timer(s), while printing ${messages} console message(s) about it. After UseCommunityLicense(): ${afterWorkaround} request(s).`;
  } else {
    verdict = "not-reproduced";
    headline = `No request to localhost:24278 was made in ${WATCH_MS / 1000} s on host "${host}".`;
  }

  P.report({
    verdict,
    headline,
    columns: ["No key (as shipped)", "After UseCommunityLicense()"],
    rows: [
      ["Page hostname", host, host],
      ["Library's hostname test: hostname.startsWith(\"localhost\")", String(libraryHostTest), String(libraryHostTest)],
      [`Requests to localhost:24278 (${WATCH_MS / 1000} s, then ${AFTER_MS / 1000} s)`, shipped.length, afterWorkaround],
      ["Requests that failed (nothing listening)", failedFast, null],
      ["Mean interval between requests, s", meanGap, null],
      ["setTimeout(…, 5000) retry timers scheduled", timers, phase2.total("setTimeout(…, 5000)")],
      ["Library console messages about the wizard", messages, phase2.total("console: wizard message")],
      ["Retry limit in the code (maxretries x retryTime)", "10 x 5 s", null],
    ],
    notes: [
      "The request count and the timers do not depend on hardware. The library prints its \"looking for the licensing wizard\" message only when the hostname starts with \"localhost\"; on other hosts the only trace is the browser's own network error for each failed request (net::ERR_CONNECTION_REFUSED in the console).",
      "The polling also runs in hidden tabs (setTimeout is throttled there but not stopped). Calling UseCommunityLicense() or setRuntimeLicenseKey() before the first create() avoids it from the start.",
    ],
    metrics: { host, libraryHostTest, requests: shipped.map((r) => ({ t: +((r.t - t0) / 1000).toFixed(2), outcome: r.outcome })), meanGap, timers, messages, afterWorkaround },
  });
}
