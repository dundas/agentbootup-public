const fs = require('fs');
const path = require('path');

fs.writeFileSync(path.join(__dirname, 'bad.txt'), 'bad', 'utf8');
