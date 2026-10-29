// usage: node load.js <baseUrl> <totalRequests> <concurrency> <mix: ok,slow,popup,heavy weights e.g. 70,10,10,10>
const [base, total = 200, conc = 4, mix = "70,10,10,10"] = process.argv.slice(2);
const kinds = ["ok", "slow", "popup", "heavy"], w = mix.split(",").map(Number);
const pick = (i) => { let r = i % w.reduce((a, b) => a + b), k = 0; while (r >= w[k]) r -= w[k++]; return kinds[k]; };
const site = process.env.SITE || "http://host.docker.internal:8099";
let next = 0, stats = {};
async function worker() {
  while (next < +total) {
    const i = next++, kind = pick(i), t0 = Date.now();
    const url = `${base}/api/screenshot?outFormat=pdf&url=${encodeURIComponent(`${site}/${kind}?i=${i}`)}`;
    let status;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(240000) });
      const buf = Buffer.from(await r.arrayBuffer());
      status = r.status === 200 && buf.slice(0, 4).toString() === "%PDF" ? "pdf" : `bad(${r.status},${buf.length}b)`;
    } catch (e) { status = "err:" + (e.name || e.message); }
    const k = `${kind}:${status}`; stats[k] = (stats[k] || 0) + 1;
    if (i % 25 === 0) console.log(new Date().toISOString().slice(11, 19), `#${i}`, kind, status, Date.now() - t0, "ms");
  }
}
const t0 = Date.now();
Promise.all(Array.from({ length: +conc }, worker)).then(() => { console.log("DONE in", ((Date.now() - t0) / 1000).toFixed(0), "s", JSON.stringify(stats)); });
