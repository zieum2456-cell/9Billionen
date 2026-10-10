'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, ValidationError, NotFoundError } = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 5 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ValidationError('요청이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('JSON 형식이 올바르지 않습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'writing.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createApp(store) {
  const routes = [
    ['GET', /^\/api\/posts$/, (req, url) => store.listPosts(Object.fromEntries(url.searchParams))],
    ['POST', /^\/api\/posts$/, async (req) => [201, store.createPost(await readJson(req))]],
    ['GET', /^\/api\/posts\/([\w-]+)$/, (req, url, [id]) => store.getPost(id)],
    ['PUT', /^\/api\/posts\/([\w-]+)$/, async (req, url, [id]) => store.updatePost(id, await readJson(req))],
    ['DELETE', /^\/api\/posts\/([\w-]+)$/, (req, url, [id]) => [204, store.deletePost(id)]],
    [
      'POST',
      /^\/api\/posts\/([\w-]+)\/comments$/,
      async (req, url, [id]) => [201, store.addComment(id, await readJson(req))],
    ],
    [
      'PATCH',
      /^\/api\/posts\/([\w-]+)\/comments\/([\w-]+)$/,
      async (req, url, [id, cid]) => store.updateComment(id, cid, await readJson(req)),
    ],
    [
      'DELETE',
      /^\/api\/posts\/([\w-]+)\/comments\/([\w-]+)$/,
      (req, url, [id, cid]) => [204, store.deleteComment(id, cid)],
    ],
    ['GET', /^\/api\/tags$/, () => store.listTags()],
    ['GET', /^\/api\/stats$/, () => store.stats()],
  ];

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      serveStatic(req, res, url.pathname);
      return;
    }

    let pathMatched = false;
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      try {
        const result = await handler(req, url, m.slice(1));
        if (Array.isArray(result) && typeof result[0] === 'number') {
          sendJson(res, result[0], result[0] === 204 ? undefined : result[1]);
        } else {
          sendJson(res, 200, result);
        }
      } catch (err) {
        if (err instanceof ValidationError) sendJson(res, 400, { error: err.message });
        else if (err instanceof NotFoundError) sendJson(res, 404, { error: err.message });
        else {
          console.error(err);
          sendJson(res, 500, { error: '서버 오류가 발생했습니다.' });
        }
      }
      return;
    }
    sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? '허용되지 않는 요청입니다.' : '없는 경로입니다.' });
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  const store = new Store(dataFile);
  http.createServer(createApp(store)).listen(port, host, () => {
    console.log(`집필 기록이 http://${host}:${port} 에서 실행 중입니다. (데이터: ${dataFile})`);
  });
}

module.exports = { createApp };
