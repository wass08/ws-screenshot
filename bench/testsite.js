// Tiny test site: realistic pages + the failure modes that hit the error paths in shared.js
const http = require("http");
const big = (n) => Array.from({ length: n }, (_, i) =>
  `<tr><td>Row ${i}</td><td>${"Lorem ipsum dolor sit amet ".repeat(4)}</td><td><canvas id="c${i}" width="120" height="20"></canvas></td></tr>`).join("");
const page = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif}td{border:1px solid #ccc}</style></head><body>${body}<script>${script}</script></body></html>`;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ok") {            // ~10 page invoice-like document
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page(`<h1>Invoice</h1><table>${big(400)}</table>`,
      `for (const c of document.querySelectorAll('canvas')) { const x=c.getContext('2d'); x.fillStyle='#'+Math.floor(Math.random()*16777215).toString(16); x.fillRect(0,0,120,20); }`));
  }
  if (u.pathname === "/slow") {          // never finishes loading -> page.goto() times out after 30s
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<!doctype html><html><body><h1>loading...</h1>");
    const t = setTimeout(() => res.end("</body></html>"), 120000);
    return req.on("close", () => clearTimeout(t));
  }
  if (u.pathname === "/popup") {         // opens extra tabs the service never closes
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page(`<h1>popup</h1><table>${big(50)}</table>`, `window.open('/ok?p=1'); window.open('/ok?p=2');`));
  }
  if (u.pathname === "/heavy") {         // keeps allocating memory in the background
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page(`<h1>heavy</h1>`, `window.junk=[]; setInterval(()=>{ for(let i=0;i<50;i++) window.junk.push(new Array(100000).fill(Math.random())); }, 200);`));
  }
  res.writeHead(404); res.end("nope");
}).listen(8099, () => console.log("testsite on :8099"));
