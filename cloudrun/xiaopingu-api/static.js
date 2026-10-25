const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function isApiPath(pathname) {
  return pathname === '/health' || pathname === '/wechat/login' ||
    pathname.startsWith('/auth/') || pathname.startsWith('/rest/v1/') || pathname.startsWith('/v1/xg/');
}

function createStaticHandler(publicRoot, apiHandler) {
  const resolvedRoot = path.resolve(publicRoot);
  return async function combinedHandler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (isApiPath(url.pathname) || !['GET', 'HEAD'].includes(req.method || 'GET')) {
      await apiHandler(req, res);
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (_error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    if (pathname === '/' || pathname === '/admin') pathname = '/index.html';
    const candidate = path.resolve(resolvedRoot, `.${pathname}`);
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch (_error) {
      await apiHandler(req, res);
      return;
    }
    const filePath = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      await apiHandler(req, res);
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  };
}

module.exports = { createStaticHandler };
