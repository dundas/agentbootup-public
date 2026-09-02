const fs = require('fs');
const path = require('path');

const rwRoot = path.dirname(process.env.BRAIN_DB_PATH);
const stateDir = path.join(rwRoot, 'state');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'allowed.txt'), 'ok', 'utf8');
