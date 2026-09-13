const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'web');
const destination = path.join(projectRoot, 'cloudrun', 'xiaopingu-api', 'public');

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });

console.log(`Prepared CloudRun Web bundle: ${destination}`);
