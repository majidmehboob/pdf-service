const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'pc_dev_change_me_in_production';

const app = express();
app.use(express.text({ type: ['text/html', 'text/plain'], limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: '*',   // for development only
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
}));

function requireKey(req, res, next) {
  if (req.path === '/') return next();
  const key = req.header('X-API-Key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing X-API-Key' });
  }
  next();
}
app.use(requireKey);

// Auto-recovering browser holder
let browser = null;
let launching = null;

async function launchBrowser() {
  console.log('Launching Chromium...');
  const b = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });
  b.on('disconnected', () => {
    console.warn('Chromium disconnected — will relaunch on next request');
    browser = null;
  });
  console.log('Chromium ready');
  return b;
}

async function getBrowser() {
  // If a launch is in-flight, wait for it
  if (launching) return launching;
  // If we have a live browser, verify and return it
  if (browser && browser.connected) return browser;
  // Otherwise launch fresh
  launching = launchBrowser().then(b => {
    browser = b;
    launching = null;
    return b;
  }).catch(err => {
    launching = null;
    throw err;
  });
  return launching;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'pdf-service',
    version: '1.0.1',
    browserConnected: browser ? browser.connected : false,
  });
});

app.post('/pdf', async (req, res) => {
  const reqId = crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();
  let page = null;
  try {
    const html = (typeof req.body === 'string') ? req.body : (req.body && req.body.html);
    if (!html || html.length < 10) {
      return res.status(400).json({ error: 'No HTML body received' });
    }

    const filename = (req.query.filename || `document-${Date.now()}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const format = req.query.format || 'A4';
    const landscape = req.query.landscape === '1' || req.query.landscape === 'true';

    console.log(`[${reqId}] PDF request: ${html.length} bytes, format=${format}, landscape=${landscape}`);

    const b = await getBrowser();
    page = await b.newPage();

    await page.setContent(html, { waitUntil: ['load', 'networkidle0'] });
    await page.evaluateHandle('document.fonts.ready');

    const pdfBuffer = await page.pdf({
      format,
      landscape,
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });

    await page.close();
    page = null;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
      'X-Request-Id': reqId,
      'X-Render-Ms': Date.now() - t0,
    });
    res.send(pdfBuffer);
    console.log(`[${reqId}] PDF sent: ${pdfBuffer.length} bytes in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[${reqId}] ERROR:`, err.message);
    if (page) { try { await page.close(); } catch (_) {} }
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, requestId: reqId });
    }
  }
});

// Catch unhandled errors so Node doesn't die
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

async function shutdown() {
  console.log('Shutting down...');
  if (browser) { try { await browser.close(); } catch (_) {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`PDF service v1.0.1 listening on http://127.0.0.1:${PORT}`);
  console.log(`API key: ${API_KEY.substring(0, 10)}... (set env API_KEY to override)`);
});
