"use strict";
// Builds downloadable files. Each builder returns { name, mime, base64 }.
// The export libraries are loaded only when a download is requested, so the rest of the app
// still works if `npm install` hasn't been run yet.
function need(name) {
  try { return require(name); } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      const err = new Error("Downloads need one extra setup step. Stop the app, run  npm install  in the app folder, then start it again.");
      err.code = "NEEDS_INSTALL";
      throw err;
    }
    throw e;
  }
}
const dx = () => need("docx");

const COLS = [
  ["Serial Number", "serial"], ["Book Name", "name"], ["Author", "author"], ["Genre", "genre"], ["Price", "price"],
  ["ISBN", "isbn"], ["Status", "status"], ["Pages", "pages"], ["Started", "started"], ["Finished", "finished"], ["Rating", "rating"],
];
const MIME = {
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};
const file = (name, ext, buf) => ({ name: name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) + "." + ext, mime: MIME[ext], base64: Buffer.from(buf).toString("base64") });
const today = () => new Date().toISOString().slice(0, 10);
const val = (b, k) => (b[k] === "" || b[k] == null ? "" : b[k]);

// ---------- CSV ----------
function csv(books) {
  const cell = (k, v) => {
    v = String(v == null ? "" : v);
    // stop spreadsheet programs from running text that starts like a formula
    if (["name", "author", "genre"].includes(k) && /^[=+\-@]/.test(v)) v = "'" + v;
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const rows = [COLS.map((c) => c[0]).join(",")].concat(books.map((b) => COLS.map(([, k]) => cell(k, val(b, k))).join(",")));
  return file("My Book Library " + today(), "csv", "\uFEFF" + rows.join("\r\n"));
}

// ---------- Excel ----------
async function xlsx(books) {
  const ExcelJS = need("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Library");
  ws.columns = COLS.map(([h, k]) => ({ header: h, key: k, width: k === "name" ? 38 : k === "author" ? 26 : k === "isbn" ? 17 : 14 }));
  for (const b of books) {
    const row = {};
    for (const [, k] of COLS) row[k] = val(b, k);
    ws.addRow(row);
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } };
  ws.getColumn("isbn").numFmt = "@"; // keep leading zeros
  return file("My Book Library " + today(), "xlsx", await wb.xlsx.writeBuffer());
}

// ---------- Word ----------
const p = (text, o = {}) => { const { Paragraph, TextRun } = dx(); return new Paragraph({ children: [new TextRun({ text: String(text), ...o })], spacing: { after: 100 } }); };
const stars = (n) => (n ? "★".repeat(n) + "☆".repeat(5 - n) + " (" + n + "/5)" : "");

function journalChildren(book, sections) {
  const { Paragraph, TextRun, HeadingLevel } = dx();
  const kids = [
    new Paragraph({ text: book.name || "Untitled", heading: HeadingLevel.TITLE }),
    p("by " + (book.author || "Unknown author"), { italics: true, size: 26 }),
  ];
  const meta = [
    ["Genre", book.genre], ["Status", book.status], ["Started", book.started], ["Finished", book.finished],
    ["Rating", stars(book.rating)], ["Pages", book.pages], ["ISBN", book.isbn],
  ].filter(([, v]) => v !== "" && v != null);
  for (const [k, v] of meta) kids.push(new Paragraph({ children: [new TextRun({ text: k + ": ", bold: true }), new TextRun({ text: String(v) })], spacing: { after: 40 } }));
  for (const s of sections || []) {
    kids.push(new Paragraph({ text: s.heading || "Notes", heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 80 } }));
    const lines = String(s.text || "").split("\n");
    if (!String(s.text || "").trim()) kids.push(p("(nothing written yet)", { italics: true, color: "888888" }));
    else for (const l of lines) kids.push(s.kind === "bullets" && l.trim() ? new Paragraph({ text: l, bullet: { level: 0 } }) : p(l));
  }
  return kids;
}

async function docxJournal(book, sections) {
  const { Document, Packer } = dx();
  const doc = new Document({ sections: [{ children: journalChildren(book, sections) }] });
  return file((book.name || "Book") + " - journal", "docx", await Packer.toBuffer(doc));
}

// The whole library as a table, optionally followed by each book's journal.
async function docxLibrary(books, journals) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, PageOrientation } = dx();
  const cells = (vals, bold) => new TableRow({
    children: vals.map((v) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(v), bold, size: 18 })] })] })),
  });
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [cells(COLS.map((c) => c[0]), true)].concat(books.map((b) => cells(COLS.map(([, k]) => val(b, k)), false))),
  });
  const sections = [{
    properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
    children: [new Paragraph({ text: "My Book Library", heading: HeadingLevel.TITLE }), p(books.length + " books · exported " + today(), { color: "666666" }), table],
  }];
  for (const j of journals || []) sections.push({ children: journalChildren(j.book, j.sections) });
  return file("My Book Library " + today(), "docx", await Packer.toBuffer(new Document({ sections })));
}

// ---------- PDF ----------
// The built-in PDF fonts only cover Latin-1, so curly quotes and dashes are simplified.
const MAP = { "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"', "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00A0": " " };
const safe = (s) => String(s == null ? "" : s).replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0]/g, (c) => MAP[c]).replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF\u2022]/g, "?");

function pdfJournal(book, sections) {
  const PDFDocument = need("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: safe(book.name) } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(file((book.name || "Book") + " - journal", "pdf", Buffer.concat(chunks))));
    doc.on("error", reject);
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#12362a").text(safe(book.name || "Untitled"));
    doc.moveDown(0.2).font("Helvetica-Oblique").fontSize(13).fillColor("#555555").text("by " + safe(book.author || "Unknown author"));
    const meta = [book.genre, book.status, book.started && "Started " + book.started, book.finished && "Finished " + book.finished,
      book.rating && "Rating " + book.rating + "/5", book.isbn && "ISBN " + book.isbn].filter(Boolean);
    if (meta.length) doc.moveDown(0.4).font("Helvetica").fontSize(10).fillColor("#777777").text(safe(meta.join("  |  ")));
    doc.moveDown(0.6).strokeColor("#dddddd").moveTo(56, doc.y).lineTo(539, doc.y).stroke();
    for (const s of sections || []) {
      doc.moveDown(1).font("Helvetica-Bold").fontSize(14).fillColor("#12362a").text(safe(s.heading || "Notes"));
      doc.moveDown(0.3).font("Helvetica").fontSize(11).fillColor("#222222");
      if (!String(s.text || "").trim()) { doc.fillColor("#999999").text("(nothing written yet)").fillColor("#222222"); continue; }
      for (const l of String(s.text).split("\n")) {
        if (s.kind === "bullets" && l.trim()) doc.text(safe("\u2022 " + l), { indent: 8, lineGap: 2 });
        else doc.text(safe(l) || " ", { lineGap: 2 });
      }
    }
    doc.end();
  });
}

module.exports = { csv, xlsx, docxJournal, docxLibrary, pdfJournal };
