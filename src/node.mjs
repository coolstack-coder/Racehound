// Node helpers shared by the CLI and scripts: a tiny static server and a
// headless Chrome page with the Racehound UI loaded.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Serves the racehound package under /racehound/ and the current directory at /.
export function serve(port = 0) {
  const cwd = process.cwd();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let root = cwd;
    if (p.startsWith('/racehound/')) { root = PKG; p = p.slice('/racehound'.length); }
    let file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.');
  return found;
}

export async function openUI(appDir) {
  const { default: puppeteer } = await import('puppeteer-core');
  const server = await serve(0);
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const app = '/' + path.relative(process.cwd(), path.resolve(appDir)).split(path.sep).join('/') + '/';
  await page.goto(`http://127.0.0.1:${port}/racehound/ui/index.html?app=${encodeURIComponent(app)}`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  return { page, close: async () => { await browser.close(); server.close(); } };
}

