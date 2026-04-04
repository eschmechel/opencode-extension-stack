import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  completePackInvocation,
  executePack,
  listPacks,
  listPackHistory,
  renderPack,
  showPack,
  showPackInvocation,
  validatePackOutput,
} from './index.js';

const STATIC_ROOT = fileURLToPath(new URL('../ui/', import.meta.url));

export async function servePacksUi(options = {}) {
  const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : '127.0.0.1';
  const port = Number.isInteger(Number(options.port)) && Number(options.port) >= 0 ? Number(options.port) : 0;
  const cwd = options.cwd;

  const server = http.createServer((request, response) => {
    handleRequest(request, response, { cwd }).catch((error) => {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const effectivePort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://${host}:${effectivePort}`;

  return {
    server,
    host,
    port: effectivePort,
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(request, response, options) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/') {
    return serveStatic(response, 'index.html', 'text/html; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/app.js') {
    return serveStatic(response, 'app.js', 'text/javascript; charset=utf-8');
  }
  if (request.method === 'GET' && pathname === '/styles.css') {
    return serveStatic(response, 'styles.css', 'text/css; charset=utf-8');
  }

  if (request.method === 'GET' && pathname === '/api/packs') {
    return writeJson(response, 200, { packs: listPacks() });
  }
  if (request.method === 'GET' && pathname.startsWith('/api/packs/')) {
    const packName = decodeURIComponent(pathname.slice('/api/packs/'.length));
    return writeJson(response, 200, showPack(packName));
  }
  if (request.method === 'GET' && pathname === '/api/history') {
    const limit = readIntegerQuery(url, 'limit');
    const packName = url.searchParams.get('pack') ?? undefined;
    const action = url.searchParams.get('action') ?? undefined;
    return writeJson(response, 200, await listPackHistory({ cwd: options.cwd, limit, packName, action }));
  }
  if (request.method === 'GET' && pathname.startsWith('/api/invocations/')) {
    const invocationId = decodeURIComponent(pathname.slice('/api/invocations/'.length));
    return writeJson(response, 200, await showPackInvocation(invocationId, { cwd: options.cwd }));
  }
  if (request.method === 'POST' && pathname === '/api/render') {
    const body = await readJsonBody(request);
    return writeJson(response, 200, renderPack(body.packName, body));
  }
  if (request.method === 'POST' && pathname === '/api/validate') {
    const body = await readJsonBody(request);
    return writeJson(response, 200, validatePackOutput(body.packName, body.output));
  }
  if (request.method === 'POST' && pathname === '/api/execute') {
    const body = await readJsonBody(request);
    return writeJson(response, 200, await executePack(body.packName, body, {
      cwd: options.cwd,
      channel: body.channel,
    }));
  }
  if (request.method === 'POST' && pathname === '/api/complete') {
    const body = await readJsonBody(request);
    return writeJson(response, 200, await completePackInvocation(body.invocationId, body.output, { cwd: options.cwd }));
  }

  writeJson(response, 404, { error: `Not found: ${pathname}` });
}

async function serveStatic(response, fileName, contentType) {
  const content = await fs.readFile(path.join(STATIC_ROOT, fileName), 'utf8');
  response.writeHead(200, { 'content-type': contentType });
  response.end(content);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function readIntegerQuery(url, key) {
  const value = url.searchParams.get(key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
