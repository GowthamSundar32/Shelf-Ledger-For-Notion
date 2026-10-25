"use strict";
// Everything that talks to Notion. The Notion token and database ID come from the request
// (the user types them into the app's Settings), so the server stores nothing.
const { GENRES, isLatin, ENGLISH_ONLY, isbn10of13, lookup } = require("./books");

const NOTION = process.env.NOTION_API_BASE || "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s == null ? "" : s);

class AppError extends Error {
  constructor(message, code) { super(message); this.code = code || "ERROR"; }
}

// ---------- credentials and the low-level Notion call ----------
function credsFrom(req) {
  const token = clean(req.headers["x-notion-token"]).trim();
  const raw = clean(req.headers["x-notion-db"]).trim();
  const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || raw.match(/[0-9a-f]{32}/i);
  if (!token || !m) throw new AppError("Add your Notion token and database ID in Settings first.", "NO_CREDS");
  return { token, db: m[0].replace(/-/g, "").toLowerCase() };
}

function friendly(status, d) {
  const code = (d && d.code) || "";
  if (status === 401 || code === "unauthorized")
    return new AppError("Notion didn't accept that token. Copy the integration secret again in Settings.", "BAD_TOKEN");
  if (status === 404 || code === "object_not_found")
    return new AppError("Notion can't find that. Check the database ID, and connect your integration to the database (the ••• menu, then Connections).", "BAD_DB");
  if (code === "restricted_resource")
    return new AppError("Your integration doesn't have permission for that. Connect it to the database in Notion.", "BAD_DB");
  return new AppError((d && d.message) || "Notion error " + status, code || "NOTION");
}

async function notion(c, method, path, body) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(NOTION + path, {
      method,
      headers: { Authorization: "Bearer " + c.token, "Notion-Version": VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && i < 2) {
      await sleep((Number(r.headers && r.headers.get && r.headers.get("retry-after")) || 1) * 1000);
      continue;
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw friendly(r.status, d);
    return d;
  }
}

const pid = (id) => {
  id = clean(id);
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) throw new AppError("That page id isn't valid.", "INVALID");
  return id;
};

// ---------- text and block helpers ----------
const rt = (s) => {
  s = clean(s);
  const out = [];
  for (let i = 0; i < s.length; i += 1900) out.push({ type: "text", text: { content: s.slice(i, i + 1900) } });
  return out;
};
const block = (type, t) => ({ object: "block", type, [type]: { rich_text: rt(t) } });
const h2 = (t) => block("heading_2", t);
const para = (t) => block("paragraph", t || "");
const bullet = (t) => block("bulleted_list_item", t || "");
const callout = (t) => ({ object: "block", type: "callout", callout: { rich_text: rt(t), icon: { type: "emoji", emoji: "📖" } } });

// The journal every new book gets. Edit this list to change the template.
function journalBlocks(description) {
  const b = [callout("Book journal: fill in as you read. Change the status above when you start and finish.")];
  if (description) b.push(h2("About this book"), para(description));
  b.push(
    h2("Summary"), para(),
    h2("Characters"), bullet("Name: role and traits"),
    h2("Plot"), para(),
    h2("Themes"), bullet(),
    h2("Favourite quotes"), bullet(),
    h2("My thoughts"), para()
  );
  return b;
}

// ---------- database columns ----------
const SPEC = {
  "Book Name": "title", Author: "rich_text", Genre: "select", Price: "number", ISBN: "rich_text",
  Status: "select", Pages: "number", Started: "date", Finished: "date", Rating: "select",
};
const STATUSES = ["To Read", "Reading", "Finished"];
// Ratings are stored as star emoji in a Select column (1 to 5 stars), or as a plain number if the column is a Number.
const STAR = "\u2B50";
const RATING_OPTIONS = [["green", 5], ["default", 4], ["red", 3], ["blue", 2], ["brown", 1]].map(([color, n]) => ({ name: STAR.repeat(n), color }));
const starCount = (s) => (clean(s).match(/[\u2B50\u2605]/g) || []).length;
const schemaCache = new Map();

async function schemaOf(c, fresh) {
  const k = c.db + ":" + c.token.slice(-6);
  const hit = schemaCache.get(k);
  if (!fresh && hit && Date.now() - hit.t < 60000) return hit;
  const d = await notion(c, "GET", "/databases/" + c.db);
  const props = {};
  for (const [n, p] of Object.entries(d.properties || {})) props[n] = { type: p.type, options: ((p[p.type] || {}).options || []).map((o) => o.name) };
  const out = { t: Date.now(), props, title: (d.title || []).map((x) => x.plain_text || "").join("") };
  schemaCache.set(k, out);
  return out;
}

async function check(c) {
  const { props, title } = await schemaOf(c, true);
  const titleName = Object.keys(props).find((n) => props[n].type === "title");
  const missing = [], wrong = [];
  for (const [n, t] of Object.entries(SPEC)) {
    if (n === "Book Name") {
      if (titleName !== "Book Name") wrong.push({ name: "Book Name", expected: "title", actual: `your title column is called "${titleName}"`, fixable: true });
      continue;
    }
    const allowed = n === "Rating" ? ["select", "number"] : [t];
    if (!props[n]) missing.push(n);
    else if (!allowed.includes(props[n].type)) wrong.push({ name: n, expected: allowed.join(" or "), actual: props[n].type });
  }
  return {
    ok: !missing.length && !wrong.length, database: title, missing, wrong,
    hasSerial: Object.values(props).some((p) => p.type === "unique_id"),
  };
}

// Adds the columns the app needs (and renames the title column). It never deletes anything.
async function setup(c) {
  const before = await check(c);
  const { props } = await schemaOf(c);
  const add = {};
  const titleName = Object.keys(props).find((n) => props[n].type === "title");
  if (titleName && titleName !== "Book Name") add[titleName] = { name: "Book Name" };
  for (const n of before.missing) {
    const t = SPEC[n];
    add[n] = t === "select" ? { select: { options: n === "Rating" ? RATING_OPTIONS : (n === "Genre" ? GENRES : STATUSES).map((name) => ({ name })) } }
      : t === "number" ? { number: { format: "number" } }
      : t === "date" ? { date: {} }
      : { rich_text: {} };
  }
  if (Object.keys(add).length) await notion(c, "PATCH", "/databases/" + c.db, { properties: add });
  return { ...(await check(c)), added: Object.keys(add) };
}

// ---------- page <-> book ----------
function pageToBook(pg) {
  const P = pg.properties || {};
  const txt = (a) => (a || []).map((x) => x.plain_text || (x.text && x.text.content) || "").join("");
  const titleProp = Object.values(P).find((v) => v.type === "title");
  const sel = (n) => { const p = P[n]; return p && p.type === "select" && p.select ? p.select.name : p && p.type === "status" && p.status ? p.status.name : ""; };
  const num = (n) => { const p = P[n]; return p && p.type === "number" && p.number != null ? p.number : ""; };
  const date = (n) => { const p = P[n]; return p && p.type === "date" && p.date ? String(p.date.start || "").slice(0, 10) : ""; };
  const rate = () => {
    const r = P.Rating;
    if (!r) return "";
    if (r.type === "number") return r.number == null ? "" : r.number;
    if (r.type === "select" && r.select) {
      const c = starCount(r.select.name);
      if (c) return c;
      const m = clean(r.select.name).match(/^\s*([1-5])\b/);
      return m ? Number(m[1]) : "";
    }
    return "";
  };
  const isbnP = P.ISBN;
  const serialP = Object.values(P).find((v) => v.type === "unique_id");
  const cov = pg.cover;
  return {
    id: pg.id, url: pg.url, created: pg.created_time || "",
    name: titleProp ? txt(titleProp.title) : "",
    author: P.Author && P.Author.type === "rich_text" ? txt(P.Author.rich_text) : "",
    genre: sel("Genre"), status: sel("Status"),
    price: num("Price"), pages: num("Pages"), rating: rate(),
    started: date("Started"), finished: date("Finished"),
    isbn: isbnP ? (isbnP.type === "rich_text" ? txt(isbnP.rich_text) : isbnP.type === "number" && isbnP.number != null ? String(isbnP.number) : "") : "",
    serial: serialP && serialP.unique_id ? ((serialP.unique_id.prefix ? serialP.unique_id.prefix + "-" : "") + serialP.unique_id.number) : "",
    cover: cov ? (cov.external ? cov.external.url : cov.file ? cov.file.url : "") : "",
  };
}

// ---------- validation and property building ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(b, creating) {
  if (creating || b.name !== undefined) {
    if (!clean(b.name).trim()) throw new AppError("Book name is required.", "INVALID");
  }
  for (const k of ["name", "author", "genre", "genreOther", "status"]) {
    if (!isLatin(b[k])) throw new AppError(ENGLISH_ONLY + " Check the book name, author and genre.", "INVALID");
  }
  for (const k of ["started", "finished"]) {
    if (b[k] && !DATE_RE.test(b[k])) throw new AppError("Dates must look like 2026-10-31.", "INVALID");
  }
  if (b.started && b.finished && b.finished < b.started) throw new AppError("The finish date can't be before the start date.", "INVALID");
  if (b.rating !== undefined && b.rating !== "" && b.rating !== null) {
    const r = Number(b.rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) throw new AppError("Rating must be a whole number from 1 to 5.", "INVALID");
  }
}

function genreOf(b) {
  const g = clean(b.genre).trim();
  const other = clean(b.genreOther).replace(/[,\n]/g, " ").trim();
  if (g === "Other" && other) return other.slice(0, 60);
  return g ? g.replace(/,/g, " ").slice(0, 60) : "Other";
}

function buildProps(b, props, creating) {
  const ok = (n, t) => !props || (props[n] && props[n].type === t);
  const titleName = (props && Object.keys(props).find((n) => props[n].type === "title")) || "Book Name";
  const has = (k) => b[k] !== undefined;
  const p = {};
  if (has("name")) p[titleName] = { title: rt(clean(b.name).trim()) };
  if (has("author") && ok("Author", "rich_text")) p.Author = { rich_text: rt(clean(b.author).trim()) };
  if ((has("genre") || creating) && ok("Genre", "select")) p.Genre = { select: { name: genreOf(b) } };
  if (has("isbn") && ok("ISBN", "rich_text")) p.ISBN = { rich_text: rt(clean(b.isbn).replace(/[-\s]/g, "")) };
  const status = has("status") ? clean(b.status).replace(/,/g, " ").trim().slice(0, 60) : creating ? "To Read" : undefined;
  if (status !== undefined && ok("Status", "select")) p.Status = { select: status ? { name: status } : null };
  const num = (k, name) => {
    if (!has(k) || !ok(name, "number")) return;
    const v = b[k];
    p[name] = { number: v === "" || v == null || isNaN(Number(v)) ? null : Number(v) };
  };
  num("price", "Price"); num("pages", "Pages");
  if (has("rating")) {
    const rp = props && props.Rating;
    const r = b.rating === "" || b.rating == null ? null : Number(b.rating);
    if (!props || (rp && rp.type === "number")) p.Rating = { number: r };
    else if (rp && rp.type === "select") {
      // reuse the column's own star option (so its colour is kept); otherwise create it
      const existing = (rp.options || []).find((o) => starCount(o) === r);
      p.Rating = { select: r == null ? null : { name: existing || STAR.repeat(r) } };
    }
  }
  const dt = (k, name) => {
    if (!has(k) || !ok(name, "date")) return;
    p[name] = { date: b[k] ? { start: b[k] } : null };
  };
  dt("started", "Started"); dt("finished", "Finished");
  return p;
}

// ---------- duplicates ----------
function isbn13of10(i) {
  const d = "978" + i.slice(0, 9);
  let t = 0;
  for (let k = 0; k < 12; k++) t += Number(d[k]) * (k % 2 ? 3 : 1);
  return d + String((10 - (t % 10)) % 10);
}
function isbnVariants(i) {
  i = clean(i).replace(/[-\s]/g, "").toUpperCase();
  if (!i) return [];
  const v = new Set([i]);
  if (/^978\d{10}$/.test(i)) { const t = isbn10of13(i); if (t) v.add(t); }
  else if (/^\d{9}[\dX]$/.test(i)) v.add(isbn13of10(i));
  return [...v];
}

async function findDuplicate(c, props, b) {
  const isbns = isbnVariants(b.isbn);
  const titleName = Object.keys(props).find((n) => props[n].type === "title") || "Book Name";
  let filter;
  if (isbns.length && props.ISBN && props.ISBN.type === "rich_text") {
    const f = isbns.map((v) => ({ property: "ISBN", rich_text: { equals: v } }));
    filter = f.length === 1 ? f[0] : { or: f };
  } else {
    const f = [{ property: titleName, title: { equals: clean(b.name).trim() } }];
    if (clean(b.author).trim() && props.Author && props.Author.type === "rich_text")
      f.push({ property: "Author", rich_text: { equals: clean(b.author).trim() } });
    filter = f.length === 1 ? f[0] : { and: f };
  }
  const q = await notion(c, "POST", `/databases/${c.db}/query`, { filter, page_size: 1 });
  return (q.results || [])[0] || null;
}

// ---------- save / update / delete ----------
// Duplicates are refused unless the request is a manual entry that explicitly asks to force it.
async function save(c, b, opts = {}) {
  validate(b, true);
  const { props } = await schemaOf(c);
  const force = opts.manual === true && b.force === true;
  if (!force) {
    const d = await findDuplicate(c, props, b);
    if (d) return { duplicate: true, id: d.id, url: d.url, book: pageToBook(d) };
  }
  const body = { parent: { database_id: c.db }, properties: buildProps(b, props, true), children: journalBlocks(clean(b.description).slice(0, 1900)) };
  if (b.cover && /^https:\/\//.test(b.cover)) body.cover = { type: "external", external: { url: b.cover } };
  const d = await notion(c, "POST", "/pages", body);
  return { saved: true, id: d.id, url: d.url, book: pageToBook(d) };
}

// One request from the browser, many pages in Notion (Notion has no bulk-create call).
// Items can be full records or just { isbn }. Duplicates are always skipped here.
async function saveMany(c, list, gopts) {
  const items = (Array.isArray(list) ? list : []).slice(0, 30);
  const out = new Array(items.length);
  const seen = new Set();
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const b = items[i] || {};
      const isbn = clean(b.isbn).replace(/[-\s]/g, "");
      try {
        if (isbn && seen.has(isbn)) { out[i] = { isbn, duplicate: true, name: b.name || "" }; continue; }
        if (isbn) seen.add(isbn);
        let rec = { ...b, isbn, force: false };
        let notFound = false;
        if (!clean(rec.name).trim()) {
          const l = isbn ? await lookup(isbn, gopts) : { found: false };
          if (l.found) rec = { ...rec, ...l, status: rec.status, started: rec.started, finished: rec.finished, rating: rec.rating };
          else { rec.name = "Untitled (ISBN " + isbn + ")"; notFound = true; }
        }
        const r = await save(c, rec);
        out[i] = { isbn, name: rec.name, notFound, ...r };
      } catch (e) { out[i] = { isbn, error: e.message }; }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  out.forEach((o, i) => { if (o) o.key = items[i] && items[i].key; });
  return { results: out };
}

async function update(c, b) {
  const id = pid(b.id);
  validate(b, false);
  const { props } = await schemaOf(c);
  const properties = buildProps(b, props, false);
  const d = Object.keys(properties).length
    ? await notion(c, "PATCH", "/pages/" + id, { properties })
    : await notion(c, "GET", "/pages/" + id);
  return { updated: true, book: pageToBook(d) };
}

async function remove(c, id) {
  await notion(c, "PATCH", "/pages/" + pid(id), { archived: true });
  return { removed: true };
}

// ---------- the whole library ----------
async function list(c) {
  const books = [];
  let cursor, more = true, pages = 0;
  while (more && pages < 25) {
    const r = await notion(c, "POST", `/databases/${c.db}/query`, {
      page_size: 100, start_cursor: cursor, sorts: [{ timestamp: "created_time", direction: "descending" }],
    });
    for (const pg of r.results || []) books.push(pageToBook(pg));
    more = !!r.has_more; cursor = r.next_cursor; pages++;
  }
  return { books, truncated: more };
}

// ---------- journal content (the blocks inside a page) ----------
const SUPPORTED = new Set(["paragraph", "bulleted_list_item", "numbered_list_item", "to_do", "quote"]);
const plain = (b) => ((b[b.type] || {}).rich_text || []).map((x) => x.plain_text || "").join("");
const formatted = (b) => ((b[b.type] || {}).rich_text || []).some((x) =>
  x.href || Object.entries(x.annotations || {}).some(([k, v]) => (k === "color" ? v !== "default" : v === true)));

function parseSections(blocks) {
  const sections = [];
  let cur = null;
  for (const b of blocks) {
    if (["heading_1", "heading_2", "heading_3"].includes(b.type)) {
      cur = { heading: plain(b), headingId: b.id, blocks: [] };
      sections.push(cur);
    } else if (cur) cur.blocks.push(b);
  }
  return sections.map((s) => {
    const items = s.blocks.filter((b) => SUPPORTED.has(b.type) && !b.has_children);
    const locked = s.blocks.some((b) => !SUPPORTED.has(b.type) || b.has_children);
    const bullets = items.filter((b) => b.type === "bulleted_list_item" || b.type === "numbered_list_item").length;
    const kind = items.length ? (bullets > items.length / 2 ? "bullets" : "text") : (/character|theme|quote|cast/i.test(s.heading) ? "bullets" : "text");
    const lines = items.map(plain);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return {
      heading: s.heading, headingId: s.headingId, kind, text: lines.join("\n"),
      ids: s.blocks.map((b) => b.id), locked, formatted: items.some(formatted),
    };
  });
}

async function getPage(c, id) {
  id = pid(id);
  const pg = await notion(c, "GET", "/pages/" + id);
  let blocks = [], cursor;
  for (let i = 0; i < 5; i++) {
    const r = await notion(c, "GET", `/blocks/${id}/children?page_size=100` + (cursor ? "&start_cursor=" + cursor : ""));
    blocks = blocks.concat(r.results || []);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return { book: pageToBook(pg), sections: parseSections(blocks) };
}

// Rewrites only the sections the user changed. New text is added first and old blocks removed after,
// so a failure part-way never loses what was written.
async function savePage(c, id, sections) {
  id = pid(id);
  for (const s of sections || []) {
    if (!isLatin(s.text)) throw new AppError(ENGLISH_ONLY + " Check the journal text.", "INVALID");
    const lines = clean(s.text).replace(/\r/g, "").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length > 100) throw new AppError("A journal section can have at most 100 lines.", "INVALID");
    const bullets = s.kind === "bullets";
    const kids = (bullets ? lines.filter((l) => l.trim()) : lines).map((l) => (bullets ? bullet(l) : para(l)));
    if (!kids.length) kids.push(bullets ? bullet("") : para(""));
    await notion(c, "PATCH", `/blocks/${id}/children`, { children: kids, after: pid(s.headingId) });
    for (const oid of s.ids || []) await notion(c, "DELETE", "/blocks/" + pid(oid));
  }
  return { saved: true };
}

async function addJournal(c, id) {
  await notion(c, "PATCH", `/blocks/${pid(id)}/children`, { children: journalBlocks("") });
  return { added: true };
}

module.exports = {
  AppError, credsFrom, check, setup, list, save, saveMany, update, remove,
  getPage, savePage, addJournal, SPEC,
};
