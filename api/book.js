"use strict";
// One endpoint for the whole app: POST /api/book  { action: "...", ... }
// Works on Vercel (serverless) and in the local / Docker server (server.js).
// The Notion token and database ID arrive in request headers from the app's Settings screen.
const books = require("../lib/books");
const N = require("../lib/notion");
const X = require("../lib/export");

async function exportLibrary(c, b) {
  const { books: all } = await N.list(c);
  const fmt = b.format;
  if (fmt === "csv") return X.csv(all);
  if (fmt === "xlsx") return X.xlsx(all);
  if (fmt === "docx") {
    let journals = [];
    if (b.includeJournals) {
      const subset = all.slice(0, 60);
      let next = 0;
      journals = new Array(subset.length);
      const worker = async () => {
        while (next < subset.length) {
          const i = next++;
          try { journals[i] = await N.getPage(c, subset[i].id); } catch (e) { journals[i] = { book: subset[i], sections: [] }; }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    }
    return X.docxLibrary(all, journals);
  }
  throw new N.AppError("Choose CSV, Excel or Word.", "INVALID");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const b = req.body || {};
  const gopts = { googleKey: String(req.headers["x-google-key"] || "").trim() || undefined };
  const send = (d) => res.status(200).json(d);
  try {
    // public book data: no Notion login needed
    if (b.action === "lookup") return send(await books.lookup(b.isbn, gopts));
    if (b.action === "search") return send(await books.searchBooks(b.query, gopts));
    if (b.action === "searchMany") return send(await books.searchMany(b.queries, gopts));

    const c = N.credsFrom(req);
    switch (b.action) {
      case "check": return send(await N.check(c));
      case "setup": return send(await N.setup(c));
      case "list": return send(await N.list(c));
      case "save": return send(await N.save(c, b, { manual: b.manual === true }));
      case "saveMany": return send(await N.saveMany(c, b.books, gopts));
      case "update": return send(await N.update(c, b));
      case "remove": return send(await N.remove(c, b.id));
      case "getPage": return send(await N.getPage(c, b.id));
      case "savePage": return send(await N.savePage(c, b.id, b.sections));
      case "addJournal": return send(await N.addJournal(c, b.id));
      case "exportLibrary": return send({ file: await exportLibrary(c, b) });
      case "exportJournal": {
        const page = await N.getPage(c, b.id);
        return send({ file: b.format === "pdf" ? await X.pdfJournal(page.book, page.sections) : await X.docxJournal(page.book, page.sections) });
      }
      default: return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    return res.status(e instanceof N.AppError ? 400 : 500).json({ error: e.message, code: e.code });
  }
};
