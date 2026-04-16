'use strict';
const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const cors      = require('cors');
const path      = require('path');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
const Database  = require('better-sqlite3');
const basicAuth = require('express-basic-auth');

puppeteer.use(Stealth());

const app = express();

// ─── Basic Auth (set AUTH_USER / AUTH_PASS env vars on Railway) ───────────────
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  app.use(basicAuth({
    users: { [process.env.AUTH_USER]: process.env.AUTH_PASS },
    challenge: true,
    realm: 'Price Tracker',
  }));
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SQLite ────────────────────────────────────────────────────────────────────
// DB_PATH env var → Railway persistent volume (/data/prices.db)
// Falls back to local file for development
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prices.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    brand        TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL DEFAULT '',
    sku          TEXT NOT NULL DEFAULT '',
    ram          TEXT NOT NULL DEFAULT '',
    storage      TEXT NOT NULL DEFAULT '',
    query        TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(brand, product_name, sku, ram, storage)
  );
  CREATE TABLE IF NOT EXISTS price_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    source     TEXT    NOT NULL,
    best_price REAL,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_snap_product ON price_snapshots(product_id);
  CREATE INDEX IF NOT EXISTS idx_snap_fetched  ON price_snapshots(fetched_at);
  CREATE INDEX IF NOT EXISTS idx_snap_source   ON price_snapshots(source);
`);

function upsertProduct({ brand, productName, sku, ram, storage, query }) {
  const [b,n,s,r,st] = [brand,productName,sku,ram,storage].map(v => (v||'').trim());
  db.prepare(`INSERT OR IGNORE INTO products (brand,product_name,sku,ram,storage,query)
              VALUES (?,?,?,?,?,?)`).run(b,n,s,r,st,query);
  return db.prepare(`SELECT id FROM products WHERE brand=? AND product_name=? AND sku=? AND ram=? AND storage=?`)
           .get(b,n,s,r,st).id;
}

function saveSnapshots(productId, entries) {
  const ins = db.prepare(`INSERT INTO price_snapshots (product_id,source,best_price) VALUES (?,?,?)`);
  db.transaction(() => entries.forEach(e => ins.run(productId, e.source, e.best_price)))();
}

// ─── Common browser headers ────────────────────────────────────────────────────
const HDRS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// ─── Amazon ───────────────────────────────────────────────────────────────────
async function scrapeAmazon(query) {
  try {
    const { data } = await axios.get(
      `https://www.amazon.com/s?k=${encodeURIComponent(query)}`,
      { headers: { ...HDRS, Referer: 'https://www.amazon.com/' }, timeout: 15000 }
    );
    const $ = cheerio.load(data);
    const products = [];
    $('[data-component-type="s-search-result"]').each((_, el) => {
      if (products.length >= 6) return false;
      const title = $(el).find('h2 span').first().text().trim();
      if (!title || title.length < 5) return;
      const href = $(el).find('h2 a').attr('href') || '';
      let priceText = $(el).find('.a-price .a-offscreen').first().text().trim();
      if (!priceText) {
        const w = $(el).find('.a-price-whole').first().text().replace(/[,.\s]/g,'').trim();
        const f = $(el).find('.a-price-fraction').first().text().trim();
        priceText = w ? `$${w}${f ? '.'+f : ''}` : '';
      }
      products.push({
        title, source: 'Amazon', condition: 'New / Various',
        price: priceText || 'N/A',
        priceValue: priceText ? (parseFloat(priceText.replace(/[^0-9.]/g,'')) || null) : null,
        link:  href.startsWith('http') ? href : `https://www.amazon.com${href}`,
        image: $(el).find('img.s-image').attr('src') || '',
        rating: $(el).find('[aria-label*="out of 5 stars"]').first().attr('aria-label') || 'N/A',
        reviews: $(el).find('.a-size-base.s-underline-text').first().text().trim() || '',
      });
    });
    return products;
  } catch (e) { return { error: e.message }; }
}

// ─── Back Market (Puppeteer + Stealth) ────────────────────────────────────────
let browserInst = null;
async function getBrowser() {
  if (browserInst?.connected) return browserInst;
  browserInst = await puppeteer.launch({
    headless: 'new',
    // In Docker (Railway) use system Chromium; locally use bundled
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
    ],
  });
  browserInst.on('disconnected', () => { browserInst = null; });
  return browserInst;
}

async function scrapeBackMarket(query) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`https://www.backmarket.com/en-us/search?q=${encodeURIComponent(query)}`,
      { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('article[data-spec="product-card-content"]', { timeout: 10000 }).catch(() => {});
    const products = await page.evaluate(() =>
      [...document.querySelectorAll('article[data-spec="product-card-content"]')].slice(0,6).map(card => {
        const title = card.querySelector('h3')?.textContent?.trim() || '';
        if (!title) return null;
        const cardText = card.textContent || '';
        const priceM  = cardText.match(/\$[\d,]+\.?\d*/);
        const ratingM = cardText.match(/([\d.]+)\/5/);
        const reviewM = cardText.match(/\(([\d,]+)\)/);
        return {
          title, source: 'Back Market', condition: 'Refurbished',
          price:      priceM ? priceM[0] : 'N/A',
          priceValue: priceM ? parseFloat(priceM[0].replace(/[^0-9.]/g,'')) : null,
          link:   card.querySelector('a')?.href || '',
          image:  card.querySelector('img')?.src || '',
          rating: ratingM ? `${ratingM[1]}/5` : 'N/A',
          reviews: reviewM ? `${reviewM[1]} reviews` : '',
        };
      }).filter(Boolean)
    );
    await page.close();
    return products.length ? products : { error: 'No Back Market results found' };
  } catch (e) {
    if (page) await page.close().catch(() => {});
    return { error: e.message };
  }
}

// ─── eBay ─────────────────────────────────────────────────────────────────────
async function scrapeEbay(query) {
  try {
    const { data } = await axios.get(
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&_sop=12&LH_BIN=1&_ipg=10`,
      { headers: { ...HDRS, Referer: 'https://www.ebay.com/' }, timeout: 15000 }
    );
    const $ = cheerio.load(data);
    const products = [];

    // eBay updated their markup to li[data-viewport] with .s-card__* classes
    $('li[data-viewport]').each((_, el) => {
      if (products.length >= 6) return false;
      const rawTitle = $(el).find('.s-card__title').text().trim();
      if (!rawTitle || rawTitle === 'Shop on eBay') return;
      // Strip eBay's "Opens in a new window or tab" suffix
      const title = rawTitle.replace(/Opens in a new window or tab\.?/gi, '').trim();
      const priceText = $(el).find('[class*="s-card__price"]').first().text().trim();
      const priceM    = priceText.match(/\$[\d,]+\.?\d*/);
      const priceNum  = priceM ? parseFloat(priceM[0].replace(/[^0-9.]/g,'')) : null;
      // Skip suspiciously low prices (ad placeholders like $20)
      if (!priceNum || priceNum < 10) return;
      const link  = $(el).find('a[href*="ebay.com/itm"]').first().attr('href') || $(el).find('a').first().attr('href') || '';
      const image = $(el).find('img').first().attr('src') || '';
      // Condition: .s-card__subtitle but skip shipping/return policy text
      const condRaw = $(el).find('.s-card__subtitle').map((_, e) => $(e).text().trim()).get()
                           .find(t => t && !t.includes('shipping') && !t.includes('return') && !t.includes('day') && t.length < 40);
      const condition = condRaw || 'Used';
      products.push({
        title, source: 'eBay', condition,
        price:      priceM[0],
        priceValue: priceNum,
        link, image,
        rating: 'N/A',
        reviews: $(el).find('[class*="sold"], [class*="hotness"]').text().trim() || '',
      });
    });
    return products.length ? products : { error: 'No eBay results found' };
  } catch (e) { return { error: e.message }; }
}

// ─── Core: search one product on all 3 sources ─────────────────────────────────
function bestPrice(items) {
  if (!Array.isArray(items)) return null;
  const vals = items.map(p => p.priceValue).filter(v => v != null && v > 0);
  return vals.length ? Math.min(...vals) : null;
}

async function searchProduct(p) {
  const { brand='', productName='', sku='', ram='', storage='' } = p;
  const query = [brand, productName, ram, storage].map(s => s.trim()).filter(Boolean).join(' ');
  if (!query) return { product: p, query:'', error: 'Empty query' };
  console.log(`  [Search] "${query}"`);
  const [ar, br, er] = await Promise.allSettled([
    scrapeAmazon(query), scrapeBackMarket(query), scrapeEbay(query),
  ]);
  const amazon     = ar.status==='fulfilled' ? ar.value : { error: ar.reason?.message };
  const backmarket = br.status==='fulfilled' ? br.value : { error: br.reason?.message };
  const ebay       = er.status==='fulfilled' ? er.value : { error: er.reason?.message };
  try {
    const productId = upsertProduct({ brand, productName, sku, ram, storage, query });
    saveSnapshots(productId, [
      { source:'amazon',     best_price: bestPrice(amazon)     },
      { source:'backmarket', best_price: bestPrice(backmarket) },
      { source:'ebay',       best_price: bestPrice(ebay)       },
    ]);
  } catch (dbErr) { console.error('[DB]', dbErr.message); }
  return { product: p, query, amazon, backmarket, ebay, timestamp: new Date().toISOString() };
}

// ─── Bulk search job with SSE streaming ────────────────────────────────────────
const jobs = new Map();

async function runJob(job) {
  const q = [...job.products.entries()];
  const worker = async () => {
    while (q.length) {
      const [idx, prod] = q.shift();
      try {
        const result = await searchProduct(prod);
        job.results[idx] = result;
        job.broadcast('result', { index: idx, total: job.products.length, ...result });
      } catch (e) {
        const err = { index: idx, product: prod, error: e.message };
        job.results[idx] = err;
        job.broadcast('result', { index: idx, total: job.products.length, ...err });
      }
    }
  };
  // Up to 3 products searched concurrently
  await Promise.all(Array.from({ length: Math.min(3, job.products.length) }, worker));
  job.status = 'done';
  job.broadcast('complete', { total: job.products.length });
  job.clients.forEach(c => { try { c.end(); } catch(_){} });
  setTimeout(() => jobs.delete(job.id), 600_000);
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// Bulk search — start job, return jobId
app.post('/api/search/bulk', (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || !products.length)
    return res.status(400).json({ error: 'products[] required' });
  const id = `j${Date.now()}${Math.random().toString(36).slice(2,6)}`;
  const job = {
    id, products, status: 'running',
    results: new Array(products.length).fill(null),
    clients: [],
    broadcast(event, data) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      this.clients.forEach(c => { try { c.write(msg); } catch(_){} });
    },
  };
  jobs.set(id, job);
  runJob(job);
  res.json({ jobId: id });
});

// SSE stream for a job
app.get('/api/search/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Replay already-finished
  job.results.forEach((r, i) => {
    if (r !== null)
      res.write(`event: result\ndata: ${JSON.stringify({ index:i, total: job.products.length, ...r })}\n\n`);
  });
  if (job.status === 'done') {
    res.write(`event: complete\ndata: ${JSON.stringify({ total: job.products.length })}\n\n`);
    res.end(); return;
  }
  job.clients.push(res);
  req.on('close', () => { job.clients = job.clients.filter(c => c !== res); });
});

// History: products list
app.get('/api/history/products', (_req, res) => res.json(
  db.prepare(`
    SELECT p.id, p.brand, p.product_name, p.sku, p.ram, p.storage, p.query,
           MIN(s.fetched_at) first_seen, MAX(s.fetched_at) last_seen,
           COUNT(*) snapshot_count
    FROM products p LEFT JOIN price_snapshots s ON s.product_id = p.id
    GROUP BY p.id ORDER BY p.created_at DESC
  `).all()
));

// History: price snapshots with filters
app.get('/api/history/prices', (req, res) => {
  const { productIds, sources, startDate, endDate } = req.query;
  const where = ['1=1']; const params = [];
  if (productIds) {
    const ids = productIds.split(',').map(Number).filter(Boolean);
    if (ids.length) { where.push(`s.product_id IN (${ids.map(()=>'?').join(',')})`); params.push(...ids); }
  }
  if (sources) {
    const s = sources.split(',').filter(Boolean);
    if (s.length) { where.push(`s.source IN (${s.map(()=>'?').join(',')})`); params.push(...s); }
  }
  if (startDate) { where.push('date(s.fetched_at) >= ?'); params.push(startDate); }
  if (endDate)   { where.push('date(s.fetched_at) <= ?'); params.push(endDate); }
  res.json(db.prepare(`
    SELECT s.id, s.product_id, s.source, s.best_price, s.fetched_at,
           p.brand, p.product_name, p.sku, p.ram, p.storage
    FROM price_snapshots s JOIN products p ON p.id = s.product_id
    WHERE ${where.join(' AND ')} ORDER BY s.fetched_at ASC
  `).all(...params));
});

// Delete product + all its history
app.delete('/api/history/product/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

process.on('SIGINT', async () => {
  if (browserInst) await browserInst.close().catch(()=>{});
  db.close(); process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  Price Tracker → http://localhost:${PORT}\n`));
