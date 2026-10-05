// Turns the pages in media/ into TypeScript modules in src/ so the webviews no longer depend on separate files
// being present next to the extension at run time. Runs before tsc (see "compile" in package.json).
//
// The Global Watch page also needs the pattern parser that the extension uses (src/patternSyntax.ts). Rather than keep
// two copies, this script transpiles that file to plain JavaScript and drops it into the page at {{PATTERN_JS}}.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function patternJs() {
    const ts = require('typescript');
    const src = fs.readFileSync(path.join(root, 'src', 'patternSyntax.ts'), 'utf8');
    const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.ESNext } }).outputText;
    return js.replace(/^export\s+/gm, '');
}

const pages = [
    { html: 'globalWatch.html', out: 'globalWatchHtml.ts', name: 'GLOBAL_WATCH_HTML', inject: { '{{PATTERN_JS}}': patternJs } },
    { html: 'globalViewer.html', out: 'globalViewerHtml.ts', name: 'GLOBAL_VIEWER_HTML' }
];
for (const pg of pages) {
    const src = path.join(root, 'media', pg.html);
    const out = path.join(root, 'src', pg.out);
    if (!fs.existsSync(src)) {
        if (fs.existsSync(out)) { console.log('embed-media: media/' + pg.html + ' not found, keeping the existing src/' + pg.out); continue; }
        console.error('embed-media: neither media/' + pg.html + ' nor src/' + pg.out + ' exists'); process.exit(1);
    }
    let html = fs.readFileSync(src, 'utf8');
    for (const marker of Object.keys(pg.inject || {})) {
        if (!html.includes(marker)) { console.error('embed-media: ' + marker + ' is missing in media/' + pg.html); process.exit(1); }
        const code = pg.inject[marker]();
        html = html.split(marker).join(code);
    }
    const body = '// GENERATED from media/' + pg.html + ' by scripts/embed-media.js - edit the .html file, then run "npm run compile".\n' +
        'export const ' + pg.name + ': string = ' + JSON.stringify(html) + ';\n';
    if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== body) fs.writeFileSync(out, body);
    console.log('embed-media: ok ' + pg.html + ' (' + html.length + ' chars)');
}
