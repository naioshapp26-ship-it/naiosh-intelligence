'use strict';
// Builds public/index.html from the single-file app (frontend/naiosh-app.html)
// and switches it into server mode (login, shared data, real uploads).
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'frontend', 'naiosh-app.html');
const app = fs.readFileSync(src, 'utf8');
const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B0B0D">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>window.NAIOSH_SERVER = true;</script>
<style>html,body{margin:0;background:#0B0B0D}</style>
</head>
<body>
${app}
</body>
</html>
`;
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'index.html'), html);
console.log('Built public/index.html (' + Math.round(html.length / 1024) + ' KB)');
