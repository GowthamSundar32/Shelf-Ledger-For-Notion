// Local server:  node server.js   (Node 18 or newer; run `npm install` once first)
// Serves the app from /public and runs the API from /api/book on http://localhost:3000
const http = require("http"), fs = require("fs"), path = require("path");

try { // optional .env (for example GOOGLE_BOOKS_KEY). Your Notion details are entered in the app instead.
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) { /* no .env file, that's fine */ }

for (const m of ["docx", "exceljs", "pdfkit"]) { // the libraries behind PDF / Word / Excel downloads
  try { require.resolve(m); } catch (e) {
    console.log("\nNOTE: the app's add-on packages aren't installed yet, so downloads and exports won't work.");
    console.log("Stop the app (Ctrl+C), run:  npm install   then start it again with:  node server.js\n");
    break;
  }
}

const handler = require("./api/book.js");
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};
const root = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // only this computer, unless HOST says otherwise (Docker sets it)

http.createServer((req, res) => {
  if (req.url.startsWith("/api/book")) {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on("end", () => {
      try { req.body = data ? JSON.parse(data) : {}; } catch (e) { req.body = {}; }
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
      handler(req, res);
    });
    return;
  }
  const file = path.join(root, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(root) || !types[path.extname(file)]) { res.statusCode = 404; return res.end("Not found"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", types[path.extname(file)]);
    res.end(buf);
  });
}).listen(PORT, HOST, () => console.log(`Shelf Ledger is running: http://localhost:${PORT}`));
