// Turns media/globalWatch.html into src/globalWatchHtml.ts so the Global Watch tab no longer depends on a
// separate file being present next to the extension at run time. Runs before tsc (see "compile" in package.json).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'media', 'globalWatch.html');
const out = path.join(root, 'src', 'globalWatchHtml.ts');
if (!fs.existsSync(src)) {
    if (fs.existsSync(out)) { console.log('embed-media: media/globalWatch.html not found, keeping the existing src/globalWatchHtml.ts'); process.exit(0); }
    console.error('embed-media: neither media/globalWatch.html nor src/globalWatchHtml.ts exists'); process.exit(1);
}
const html = fs.readFileSync(src, 'utf8');
const body = '// GENERATED from media/globalWatch.html by scripts/embed-media.js - edit the .html file, then run "npm run compile".\n' +
    'export const GLOBAL_WATCH_HTML: string = ' + JSON.stringify(html) + ';\n';
if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== body) fs.writeFileSync(out, body);
console.log('embed-media: ok (' + html.length + ' chars)');
