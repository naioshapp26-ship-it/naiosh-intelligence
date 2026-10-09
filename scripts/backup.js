'use strict';
// Consistent online backup of the database (safe while the server is running):
//   node scripts/backup.js [output-dir]
// Uploaded files live in DATA_DIR/uploads — back that folder up too.
const path = require('node:path');
const fs = require('node:fs');
const config = require('../src/config');
const db = require('../src/db');
const outDir = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'));
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(outDir, `naiosh-${stamp}.db`);
db.open();
db.db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log('Backup written:', out);
