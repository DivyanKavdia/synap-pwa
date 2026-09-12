'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};

/** Static localhost fixture. Callers own listen/close and their API routing. */
function createStaticServer(directory) {
  const root = path.resolve(directory);
  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || file.includes('\0')) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, bytes) => {
      if (error) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
    });
  });
}

function launchChromium() {
  const { chromium } = require('playwright');
  const executablePath = process.env.SYNAP_CHROMIUM_PATH;
  return chromium.launch({
    headless: true,
    ...(executablePath
      ? { executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
      : {}),
  });
}

module.exports = { createStaticServer, launchChromium };
