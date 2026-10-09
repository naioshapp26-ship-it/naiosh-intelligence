'use strict';
// Apply pending database migrations and exit.
const db = require('../src/db');
db.open(); db.close();
console.log('Migrations up to date.');
