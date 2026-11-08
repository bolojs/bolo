// Classic worker for spike (b). On 'start', issues synchronous XHRs to
// /b/sync and measures round-trip latency at two payload sizes.
onmessage = (e) => {
  if (e.data !== "start") return;
  const N = 1000;
  const WARMUP = 25;
  const sizes = [16, 65536];
  const out = { sizes: {}, prefixes: {}, aborted: false };

  const syncCall = (size, i) => {
    const x = new XMLHttpRequest();
    x.open("GET", `/b/sync?size=${size}&i=${i}&r=${Math.random()}`, false);
    const t0 = performance.now();
    x.send();
    const dt = performance.now() - t0;
    return { dt, body: x.responseText ?? "", status: x.status };
  };

  const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

  try {
    // probe first: if the channel is broken (SW never answers, timeouts), bail early
    const probe = syncCall(16, -1);
    out.probe = { ms: probe.dt, prefix: probe.body.slice(0, 8), status: probe.status };
    if (probe.body.startsWith("TIMEOUT") || probe.status !== 200) {
      out.aborted = true;
      postMessage(out);
      return;
    }
    for (const size of sizes) {
      for (let i = 0; i < WARMUP; i++) syncCall(size, -i - 2);
      const ts = [];
      const pref = {};
      for (let i = 0; i < N; i++) {
        const { dt, body, status } = syncCall(size, i);
        ts.push(dt);
        const p = body.slice(0, body.indexOf(":") + 1);
        pref[p + (status === 200 ? "" : `(${status})`)] = (pref[p + (status === 200 ? "" : `(${status})`)] ?? 0) + 1;
      }
      ts.sort((a, b) => a - b);
      out.sizes[size] = {
        n: N,
        p50: quantile(ts, 0.5),
        p95: quantile(ts, 0.95),
        p99: quantile(ts, 0.99),
        min: ts[0],
        max: ts[N - 1],
        mean: ts.reduce((a, b) => a + b, 0) / N,
      };
      out.prefixes[size] = pref;
    }
  } catch (err) {
    out.error = String(err);
  }
  postMessage(out);
};
