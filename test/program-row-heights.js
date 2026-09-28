/*
 * NOTES.md > "Program rows show the episode title" documents the bug this
 * guards: a fixed vs-repeat size (`{size: 66}`) and a real per-row-type
 * rendered height that disagreed - Flex/redirect rows measured 53.39px
 * against a declared 66px, because an empty gauge label collapsed to 0px in
 * a flex layout. The channel programming list's row (web/public/templates/
 * channel-config.html) now sets its own height inline, bound to the exact
 * same scope value handed to vs-repeat (commonProgramTools.
 * programScheduleRowHeight), so the two can't drift apart by construction -
 * this test renders the real markup and the real CSS in a real browser and
 * fails if any row type's measured height isn't exactly that value.
 *
 * Real files, not transcriptions: the row's HTML is extracted from the real
 * template by tag-balance matching (the same reasoning as test/support.js's
 * liftSource - "so a test can drive the real thing instead of a
 * transcription that would go stale silently"), the CSS is the real
 * style.css loaded whole, and each field's text comes from the real
 * common-program-tools.js functions. Only a small, versioned Bootstrap
 * 4.4.1 shim is hand-written (box-sizing: border-box and the .list-group-
 * item base border) - the vendored bootstrap.min.css this app also loads
 * isn't checked into this repo, and box-sizing: border-box is exactly what
 * keeps that base border from silently adding to a row's declared height,
 * so it needs to be in the fixture's cascade for the measurement to mean
 * anything.
 *
 * Needs a real Chromium-family browser on the machine (puppeteer-core opens
 * it, but doesn't bundle one) - PUPPETEER_EXECUTABLE_PATH overrides the
 * search below. Skips (not fails) when none is found, so `npm test` stays
 * runnable on a machine without Chrome/Edge installed.
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./support');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_FILE = path.join(ROOT, 'web/public/templates/channel-config.html');
const STYLE_FILE = path.join(ROOT, 'web/public/style.css');
const commonProgramTools = require('../web/services/common-program-tools')(() => ({}));

function findChromeExecutable() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
}

// Pulls the programming list's one row out of the real template by counting
// <div>/</div> depth from its ng-repeat, the same "drive the real thing"
// reasoning liftSource uses for JS function bodies.
function extractRowTemplate(html) {
    const marker = 'ng-repeat="x in channel.programs track by x.$index"';
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) {
        throw new Error('channel-config.html no longer has the programming list row (marker not found)');
    }
    const start = html.lastIndexOf('<div', markerIdx);
    if (start === -1) {
        throw new Error('could not find the opening <div of the programming list row');
    }
    let pos = start;
    let depth = 0;
    while (pos < html.length) {
        if (html.startsWith('</div>', pos)) {
            depth--;
            pos += '</div>'.length;
            if (depth === 0) {
                return html.slice(start, pos);
            }
        } else if (html[pos] === '<' && html.slice(pos, pos + 4) === '<div' && /[\s>]/.test(html[pos + 4])) {
            depth++;
            pos += 4;
        } else {
            pos++;
        }
    }
    throw new Error('unbalanced <div> while extracting the programming list row template');
}

// The exact set of ng-if expressions and {{ }} calls the real row template
// uses today - kept short and explicit rather than a general expression
// evaluator, so an unrecognized one (the template grew a new conditional or
// field) throws loudly instead of silently mis-rendering a fixture.
function evalCondition(expr, x) {
    switch (expr) {
        case '!x.isOffline': return !x.isOffline;
        case 'x.isOffline': return !!x.isOffline;
        case 'rowTag(x)': return !!commonProgramTools.rowTag(x);
        case 'rowBreakAfter(x)': return !!commonProgramTools.rowBreakAfter(x);
        default:
            throw new Error(`program-row-heights.js doesn't know how to evaluate ng-if="${expr}" - update evalCondition`);
    }
}
function evalInterpolation(expr, x) {
    switch (expr) {
        case 'rowStartTime(x)': return commonProgramTools.rowStartTime(x);
        case 'rowShow(x)': return commonProgramTools.rowShow(x);
        case 'rowTag(x)': return commonProgramTools.rowTag(x);
        case 'rowTitle(x)': return commonProgramTools.rowTitle(x);
        case 'rowOfflineLabel(x)': return commonProgramTools.rowOfflineLabel(x);
        case 'rowDuration(x)': return commonProgramTools.rowDuration(x);
        case 'rowBreakAfter(x)': return commonProgramTools.rowBreakAfter(x);
        default:
            throw new Error(`program-row-heights.js doesn't know how to interpolate "{{ ${expr} }}" - update evalInterpolation`);
    }
}

// Resolves one row's real template against one fixture program: drops each
// top-level ng-if child whose condition is false for this fixture, and
// substitutes real computed text for every {{ }} left standing.
function resolveRow(rowTemplate, x, rowHeightPx) {
    let html = rowTemplate.replace('{{ programRowHeight }}', String(rowHeightPx));
    const openTagEnd = html.indexOf('>');
    const openTag = html.slice(0, openTagEnd + 1);
    const closeTag = '</div>';
    const body = html.slice(openTagEnd + 1, html.length - closeTag.length);

    const childRe = /<(span|button)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let resolvedBody = '';
    let match;
    while ((match = childRe.exec(body)) !== null) {
        const [, tag, attrs, inner] = match;
        const ifMatch = attrs.match(/ng-if="([^"]*)"/);
        if (ifMatch && !evalCondition(ifMatch[1], x)) {
            continue;
        }
        const resolvedInner = inner.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => evalInterpolation(expr, x));
        resolvedBody += `<${tag}${attrs}>${resolvedInner}</${tag}>`;
    }
    return openTag + resolvedBody + closeTag;
}

// Bootstrap 4.4.1's reboot box-sizing reset plus the one .list-group-item
// base rule (border: 1px solid rgba(0,0,0,.125)) this app's own style.css
// overrides the width of - not vendored in this checkout (web/public/
// bootstrap-4.4.1-dist isn't in the repo), so it's reproduced here from the
// pinned version index.html actually loads, just enough to make the real
// style.css's more specific overrides land on something real.
const BOOTSTRAP_SHIM_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: sans-serif; font-size: 1rem; line-height: 1.5; }
.list-group-item { border: 1px solid rgba(0,0,0,.125); }
`;

async function measureRowHeights(puppeteer, executablePath, rows, containerHeightPx) {
    const styleCss = fs.readFileSync(STYLE_FILE, 'utf8');
    const html = `<!doctype html><html><head><style>${BOOTSTRAP_SHIM_CSS}\n${styleCss}</style></head>
<body>
  <div id="scroller" style="display:flex; flex-direction:column; height:${containerHeightPx}px; overflow-y:auto;"
       class="list-group list-group-root list-group-root programming-programs">
    ${rows.map((r, i) => r.replace('class="list-group-item', `id="row-${i}" class="list-group-item`)).join('\n')}
  </div>
</body></html>`;

    const browser = await puppeteer.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        await page.setContent(html, { waitUntil: 'load' });
        const heights = [];
        for (let i = 0; i < rows.length; i++) {
            heights.push(await page.evaluate((id) => {
                const el = document.getElementById(id);
                return el ? el.getBoundingClientRect().height : null;
            }, `row-${i}`));
        }
        return heights;
    } finally {
        await browser.close();
    }
}

module.exports = async function run() {
    const suite = new Suite('programming list row heights');

    const executablePath = findChromeExecutable();
    if (!executablePath) {
        suite.log('SKIPPED: no Chrome/Edge executable found (set PUPPETEER_EXECUTABLE_PATH to run this check)');
        return suite;
    }
    let puppeteer;
    try {
        puppeteer = require('puppeteer-core');
    } catch (err) {
        suite.log('SKIPPED: puppeteer-core is not installed (npm install --save-dev puppeteer-core)');
        return suite;
    }

    const rowHeightPx = commonProgramTools.programScheduleRowHeight;
    suite.check('programScheduleRowHeight is a positive number', typeof rowHeightPx === 'number' && rowHeightPx > 0);

    const templateHtml = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    suite.check('the row still binds its own height to programRowHeight (not a separate hardcoded value)',
        templateHtml.includes('style="height: {{ programRowHeight }}px"'));
    suite.check('vs-repeat is still told the same programRowHeight value (not a separate hardcoded size)',
        templateHtml.includes('vs-repeat="{size: programRowHeight}"'));

    const rowTemplate = extractRowTemplate(templateHtml);

    const MIN = 60 * 1000;
    const programFixture = {
        isOffline: false, type: 'episode',
        start: new Date(2026, 8, 28, 14, 0, 5),
        showTitle: 'A Fairly Long Show Name That Might Wrap Without Truncation',
        season: 1, episode: 12,
        title: 'An Episode Title Long Enough To Need The Ellipsis Truncation Rule',
        duration: 23 * MIN + 47 * 1000,
        $breakAfterMs: 4 * MIN + 46 * 1000,
    };
    const flexFixture = {
        isOffline: true, type: 'flex',
        start: new Date(2026, 8, 28, 14, 24, 0),
        duration: 6 * MIN,
    };
    const redirectFixture = {
        isOffline: true, type: 'redirect', channel: 42,
        start: new Date(2026, 8, 28, 14, 30, 0),
        duration: 30 * MIN,
    };

    const fixtures = [
        ['program row', programFixture],
        ['Flex row', flexFixture],
        ['redirect row', redirectFixture],
    ];
    const resolvedRows = fixtures.map(([, x]) => resolveRow(rowTemplate, x, rowHeightPx));

    let heights;
    try {
        // Shorter than 3 real rows, on purpose: vs-repeat's real scroll
        // container is exactly this shape (flex-direction:column, real
        // rows outnumbering the visible space), and that's what squashes a
        // row lacking flex-shrink:0 below its declared height - see
        // NOTES.md's root-cause writeup.
        heights = await measureRowHeights(puppeteer, executablePath, resolvedRows, Math.round(rowHeightPx * 1.5));
    } catch (err) {
        suite.check('rendered the fixture rows in a real browser', false, err.message);
        return suite;
    }

    fixtures.forEach(([label], i) => {
        suite.check(`${label} renders at exactly ${rowHeightPx}px (vs-repeat is told ${rowHeightPx})`,
            heights[i] === rowHeightPx, `measured ${heights[i]}px`);
    });

    const allEqual = heights.every((h) => h === heights[0]);
    suite.check('every row type measures the same real height as every other', allEqual, JSON.stringify(heights));

    return suite;
};
