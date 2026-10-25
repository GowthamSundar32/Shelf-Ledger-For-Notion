# Shelf Ledger for Notion (v2)

Add books to your Notion library by ISBN or title, browse and search the whole library inside the app,
edit each book's journal, download journals as PDF or Word, and export everything to CSV, Excel or Word.

There is no passcode. Your Notion secret and database ID are typed into the app's **Settings** screen and are
kept only in your browser. Run the app on your own computer so nobody else can reach it.

## 1. Get your Notion details (5 minutes)

1. Duplicate the Notion template (link on your purchase page). You get a database called **Book Journal Catalog**.
2. Go to https://www.notion.so/my-integrations, create an **Internal** integration, and copy its secret.
3. Open your book table in Notion, click **...** then **Connections**, and add your integration.
4. Copy the table's link from the address bar. You'll paste it into the app.

## 2. Run the app locally

### Node.js

Install Node.js 18 or newer, open a terminal in this folder, and run these two commands, in this order.
**Run `npm install` first, once.** It downloads the packages the app needs (this is the step that's easy to skip).

    npm install
    node server.js

Then open http://localhost:3000.

### C. Online (Vercel)

Upload this folder to a private GitHub repository and import it in Vercel. No settings are needed.
Anyone with the link can use the app but needs their own Notion details, so keep the link to yourself.
Vercel's free Hobby plan is for personal, non-commercial use.

## 3. First time in the app

The Settings screen opens by itself. Paste your secret and database link, then press **Test connection**.
If any columns are missing (Started, Finished, Rating, Pages and so on), press **Fix automatically**.
You only need to do this once per browser.

## Using it

- **Add books:** type an ISBN or a title. Turn on **Batch mode** to collect books in a list and save them in one go.
  **Search many** takes one book per line. Books already in your library are marked and can't be added twice.
  The only way to add a duplicate on purpose is **Add a book manually**.
- **Library:** every book in your Notion database, with search, filters and sorting. Click a book to read its
  journal, edit it (changes go back to Notion), download it as PDF or Word, or delete it (moves it to Notion's trash).
- **Export:** CSV, Excel or Word, from the Library screen.

## Troubleshooting

- **"Notion can't find that database":** the integration isn't connected to the table (step 1.3), or the link is wrong.
- **"Notion didn't accept that token":** copy the integration secret again.
- **Ratings:** the Rating column can be a Select with star options (⭐ to ⭐⭐⭐⭐⭐, like the template) or a Number. The app shows clickable stars and writes the matching option.
- **A column is flagged:** use **Fix automatically** in Settings. If a column has the wrong type (for example ISBN
  set to Number), change its type to Text in Notion.
- **Searches come back empty:** add a free Google Books API key in Settings.
- **Only English-language books are supported.**

Not affiliated with Notion.
