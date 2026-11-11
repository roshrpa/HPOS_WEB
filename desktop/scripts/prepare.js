// Builds desktop/app/index.html from the POS file in the repo root.
// The desktop app is the same POS with only the counter tabs shown, so both always share one code base.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', '..', 'index.html');
const out = path.join(__dirname, '..', 'app');
let h = fs.readFileSync(src, 'utf8');
if (h.indexOf('<head>') < 0) throw new Error('index.html has no <head>');
h = h.replace('<head>', '<head>\n<script>window.HP_DESKTOP = true;</script>');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), h);
console.log('desktop/app/index.html written (' + h.length + ' bytes)');
