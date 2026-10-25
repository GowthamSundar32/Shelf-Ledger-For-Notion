"use strict";
// Book lookups (ISBN and title search) from free public sources. Nothing here touches Notion.
const gkey = (o) => {
  const k = (o && o.googleKey) || process.env.GOOGLE_BOOKS_KEY;
  return k ? "&key=" + encodeURIComponent(k) : "";
};

const GENRES = ["Fiction","Non-fiction","Science","Technology","History","Biography","Self-help","Business","Children","Fantasy","Mystery","Romance","Poetry","Religion","Textbook","Other"];

// English only: Latin letters (including accents), digits, punctuation and symbols.
// Anything in another script (Cyrillic, Arabic, Indic, CJK...) is rejected.
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\s]/u;
const isLatin = (s) => !NON_LATIN.test(String(s || ""));
const isEnglishLang = (code) => !code || /^en/i.test(code);
const englishRecord = (r) => isEnglishLang(r.lang) && isLatin(r.name) && isLatin(r.author);
const ENGLISH_ONLY = "Only English (Latin) letters are allowed.";

function guessGenre(cats) {
  if (!cats.length) return "";
  const t = cats.join(" ").toLowerCase();
  const map = [[/juvenile|children|young adult/,"Children"],[/fantasy/,"Fantasy"],[/mystery|detective|thriller|crime/,"Mystery"],[/romance/,"Romance"],[/poetry/,"Poetry"],[/biograph|memoir/,"Biography"],[/self-help|self help/,"Self-help"],[/business|economics|finance/,"Business"],[/computer|technology|engineering/,"Technology"],[/science fiction/,"Fiction"],[/science|mathematic|nature/,"Science"],[/history/,"History"],[/religio|spiritual|bible/,"Religion"],[/education|study aids|textbook/,"Textbook"],[/fiction|literary|classics|drama/,"Fiction"]];
  for (const [re, g] of map) if (re.test(t)) return g;
  return "Other";
}

async function getJson(url, headers = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers });
      if ((r.status === 429 || r.status >= 500) && attempt === 0) { await new Promise(x => setTimeout(x, 700)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(to); }
  }
  throw new Error("HTTP retry failed");
}

// Converts a 978... ISBN-13 into its ISBN-10 form (some catalogues only index the 10-digit number).
function isbn10of13(i13) {
  if (!/^978\d{10}$/.test(i13)) return "";
  const d = i13.slice(3, 12);
  let t = 0;
  for (let i = 0; i < 9; i++) t += Number(d[i]) * (10 - i);
  const c = (11 - (t % 11)) % 11;
  return d + (c === 10 ? "X" : String(c));
}

const notFound = (e) => /HTTP 404/.test(e.message);

async function fromGoogle(q, errors, opts) {
  const key = gkey(opts);
  try {
    const d = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1${key}`);
    const it = (d.items || [])[0];
    if (!it) return null;
    const v = it.volumeInfo || {}, lp = (it.saleInfo || {}).listPrice;
    return {
      name: [v.title, v.subtitle].filter(Boolean).join(": "),
      author: (v.authors || []).join(", "),
      genre: guessGenre(v.categories || []),
      price: lp ? lp.amount : "",
      cover: ((v.imageLinks || {}).thumbnail || "").replace("http://", "https://"),
      pages: v.pageCount || "",
      description: String(v.description || "").slice(0, 1200),
      lang: v.language || "",
    };
  } catch (e) { errors.push("Google Books " + e.message); return null; }
}

// Open Library edition record: covers many editions the other Open Library endpoints miss.
async function fromOpenLibraryEdition(isbn, errors) {
  try {
    const e = await getJson(`https://openlibrary.org/isbn/${isbn}.json`);
    if (!e || !e.title) return null;
    const nameOf = (key) => getJson(`https://openlibrary.org${key}.json`).then(x => x.name || "").catch(() => "");
    let keys = (e.authors || []).slice(0, 3).map(a => a.key);
    if (!keys.length && e.works && e.works[0]) {
      try {
        const w = await getJson(`https://openlibrary.org${e.works[0].key}.json`);
        keys = (w.authors || []).slice(0, 3).map(a => (a.author || {}).key).filter(Boolean);
      } catch (x) {}
    }
    const names = (await Promise.all(keys.map(nameOf))).filter(Boolean);
    const cv = (e.covers || [])[0];
    const desc = typeof e.description === "string" ? e.description : (e.description && e.description.value) || "";
    return {
      name: [e.title, e.subtitle].filter(Boolean).join(": "),
      author: names.join(", "),
      genre: guessGenre((e.subjects || []).slice(0, 5)),
      price: "",
      cover: cv && cv > 0 ? `https://covers.openlibrary.org/b/id/${cv}-M.jpg` : "",
      pages: e.number_of_pages || "",
      description: String(desc).slice(0, 1200),
      lang: e.languages && e.languages.length ? (e.languages.some(l => /\/eng$/.test(l.key)) ? "en" : "xx") : "",
    };
  } catch (err) { if (!notFound(err)) errors.push("Open Library edition " + err.message); return null; }
}

async function fromOpenLibrary(isbn, errors) {
  try {
    const d = (await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`))["ISBN:" + isbn];
    if (d) return {
      name: d.title || "",
      author: (d.authors || []).map(a => a.name).join(", "),
      genre: guessGenre((d.subjects || []).slice(0, 5).map(x => x.name)),
      price: "",
      cover: (d.cover || {}).medium || "",
      pages: d.number_of_pages || "",
      description: "",
    };
  } catch (e) { errors.push("Open Library " + e.message); }
  try {
    const d = await getJson(`https://openlibrary.org/search.json?isbn=${isbn}&fields=title,author_name,subject,number_of_pages_median,cover_i&limit=1`);
    const x = (d.docs || [])[0];
    if (x) return {
      name: x.title || "",
      author: (x.author_name || []).join(", "),
      genre: guessGenre((x.subject || []).slice(0, 5)),
      price: "",
      cover: x.cover_i ? `https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg` : "",
      pages: x.number_of_pages_median || "",
      description: "",
    };
  } catch (e) { errors.push("Open Library search " + e.message); }
  return null;
}

// Optional paid source with the widest coverage. Active only when ISBNDB_KEY is set.
async function fromIsbndb(isbn, errors) {
  if (!process.env.ISBNDB_KEY) return null;
  try {
    const d = await getJson(`https://api2.isbndb.com/book/${isbn}`, { Authorization: process.env.ISBNDB_KEY });
    const b = d.book;
    if (!b || !b.title) return null;
    return {
      name: b.title_long || b.title,
      author: (b.authors || []).join(", "),
      genre: guessGenre(b.subjects || []),
      price: "",
      cover: b.image || "",
      pages: b.pages || "",
      description: String(b.synopsis || b.overview || "").slice(0, 1200),
      lang: b.language ? (/^en/i.test(b.language) ? "en" : "xx") : "",
    };
  } catch (e) { if (!notFound(e)) errors.push("ISBNdb " + e.message); return null; }
}

// Asks every source at once, takes the best match, and fills its gaps from the others.
async function lookup(isbn, opts) {
  isbn = String(isbn).replace(/[-\s]/g, "");
  const errors = [];
  const i10 = isbn10of13(isbn);
  const jobs = [
    fromIsbndb(isbn, errors),
    fromGoogle("isbn:" + isbn, errors, opts),
    i10 ? fromGoogle("isbn:" + i10, errors, opts) : null,
    fromOpenLibraryEdition(isbn, errors),
    fromOpenLibrary(isbn, errors),
  ];
  const all = (await Promise.all(jobs)).filter(r => r && r.name);
  const results = all.filter(englishRecord);
  if (!results.length) {
    if (all.length) errors.push("only non-English records exist for this ISBN");
    return { found: false, isbn, debug: errors.join("; ") };
  }
  const merged = { ...results[0] };
  for (const r of results.slice(1)) for (const k of Object.keys(merged)) if (!merged[k] && r[k]) merged[k] = r[k];
  delete merged.lang;
  return { found: true, isbn, ...merged };
}

// Title / author search. Returns up to 10 candidate books (each with an ISBN) for the user to pick from.
async function searchBooks(query, opts) {
  query = String(query || "").trim().slice(0, 200);
  if (!query) return { results: [] };
  if (!isLatin(query)) return { results: [], debug: "Search in English only" };
  const errors = [];
  const key = gkey(opts);
  const pickIsbn = (list) => list.find(x => /^97[89]\d{10}$/.test(x)) || list.find(x => /^\d{9}[\dX]$/.test(x)) || "";

  const google = getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&printType=books&langRestrict=en${key}`)
    .then(d => (d.items || []).map(it => {
      const v = it.volumeInfo || {}, lp = (it.saleInfo || {}).listPrice;
      const ids = (v.industryIdentifiers || []).map(x => x.identifier);
      return {
        isbn: pickIsbn(ids),
        name: [v.title, v.subtitle].filter(Boolean).join(": "),
        author: (v.authors || []).join(", "),
        year: (v.publishedDate || "").slice(0, 4),
        genre: guessGenre(v.categories || []),
        price: lp ? lp.amount : "",
        cover: ((v.imageLinks || {}).thumbnail || "").replace("http://", "https://"),
        pages: v.pageCount || "",
        description: String(v.description || "").slice(0, 1200),
        lang: v.language || "",
      };
    }))
    .catch(e => { errors.push("Google Books " + e.message); return []; });

  const openLib = getJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=title,author_name,first_publish_year,isbn,subject,cover_i,number_of_pages_median,language&limit=10`)
    .then(d => (d.docs || []).map(x => ({
      isbn: pickIsbn(x.isbn || []),
      name: x.title || "",
      author: (x.author_name || []).slice(0, 3).join(", "),
      year: x.first_publish_year || "",
      genre: guessGenre((x.subject || []).slice(0, 5)),
      price: "",
      cover: x.cover_i ? `https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg` : "",
      pages: x.number_of_pages_median || "",
      description: "",
      lang: x.language && x.language.length ? (x.language.includes("eng") ? "en" : "xx") : "",
    })))
    .catch(e => { errors.push("Open Library " + e.message); return []; });

  const [g, o] = await Promise.all([google, openLib]);
  const seen = new Set(), results = [];
  for (const r of g.concat(o)) {
    if (!r.name || !r.isbn || !englishRecord(r)) continue; // needs an ISBN to be saved and de-duplicated; English only
    const k1 = r.isbn, k2 = (r.name + "|" + r.author).toLowerCase();
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1); seen.add(k2);
    const { lang, ...clean } = r;
    results.push(clean);
    if (results.length >= 10) break;
  }
  return results.length ? { results } : { results, debug: errors.join("; ") };
}

// Searches many lines at once. A line is an ISBN (looked up) or a title / "title, author" (searched).
async function searchMany(queries, opts) {
  const list = (Array.isArray(queries) ? queries : []).map(q => String(q).trim()).filter(Boolean).slice(0, 20);
  const groups = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++, q = list[i], d = q.replace(/[-\s]/g, "");
      try {
        if (/^(\d{13}|\d{9}[\dXx])$/.test(d)) {
          const l = await lookup(d, opts);
          groups[i] = { query: q, results: [l.found ? l : { isbn: d, name: "", notFound: true }] };
        } else {
          const s = await searchBooks(q, opts);
          groups[i] = { query: q, results: s.results.slice(0, 5), debug: s.debug };
        }
      } catch (e) { groups[i] = { query: q, results: [], debug: e.message }; }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { groups };
}


module.exports = { GENRES, isLatin, ENGLISH_ONLY, isbn10of13, lookup, searchBooks, searchMany };
