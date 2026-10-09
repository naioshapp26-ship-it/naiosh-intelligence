'use strict';
// Joins frontend/src/*.html (in file-name order) into frontend/naiosh-app.html,
// then run `npm run build:frontend` to produce public/index.html.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '..', 'frontend', 'src');
const parts = fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort();
const out = parts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
fs.writeFileSync(path.resolve(dir, '..', 'naiosh-app.html'), out);
console.log('Assembled', parts.length, 'parts → frontend/naiosh-app.html');
