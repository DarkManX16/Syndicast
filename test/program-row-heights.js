/*
 * NOTES.md > "Program rows show the episode title" documents the bug this
 * guards: a fixed vs-repeat size (`{size: 66}`) and a real per-row-type
 * rendered height that disagreed - Flex/redirect rows measured 53.39px
 * against a declared 66px, because an empty gauge label collapsed to 0px in
 * a flex layout. Every list that uses vs-repeat now sets its rows' height
 * inline, bound to the exact same scope value handed to vs-repeat, so the
 * two can't drift apart by construction. This test renders each list's real
 * markup and the real CSS in a real browser and fails if any row's measured
 * height isn't exactly that value:
 *
 * - the channel programming list (channel-config.html), at
 *   commonProgramTools.programScheduleRowHeight
 * - the custom show editor (show-config.html) and filler lists
 *   (filler-config.html), at commonProgramTools.contentListRowHeight
 *
 * Real files, not transcriptions: each row's HTML is extracted from the real
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
const TEMPLATES = path.join(ROOT, 'web/public/templates');
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

// Pulls one list's row out of its real template by counting <div>/</div>
// depth from its ng-repeat, the same "drive the real thing" reasoning
// liftSource uses for JS function bodies.
function extractRowTemplate(html, marker, file) {
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) {
        throw new Error(`${file} no longer has its list row (marker not found: ${marker})`);
    }
    const start = html.lastIndexOf('<div', markerIdx);
    if (start === -1) {
        throw new Error(`could not find the opening <div of the list row in ${file}`);
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
    throw new Error(`unbalanced <div> while extracting the list row from ${file}`);
}

// The exact set of ng-if expressions, {{ }} calls and ng-style bindings the
// real row templates use today - kept short and explicit rather than a
// general expression evaluator, so an unrecognized one (a template grew a
// new conditional or field) throws loudly instead of silently mis-rendering
// a fixture.
function evalCondition(expr, x) {
    switch (expr) {
        case '!x.isOffline': return !x.isOffline;
        case 'x.isOffline': return !!x.isOffline;
        case 'rowTag(x)': return !!commonProgramTools.rowTag(x);
        case 'rowBreakAfter(x)': return !!commonProgramTools.rowBreakAfter(x);
        case 'rowFlexTag(x)': return !!commonProgramTools.rowFlexTag(x);
        case 'rowSlotLabel(x)': return !!commonProgramTools.rowSlotLabel(x);
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
        case 'rowFlexTag(x)': return commonProgramTools.rowFlexTag(x);
        case 'rowFlexTagTitle(x)': return commonProgramTools.rowFlexTagTitle(x);
        case 'rowSlotLabel(x)': return commonProgramTools.rowSlotLabel(x);
        case 'rowFillerName(x)': return commonProgramTools.rowFillerName(x);
        default:
            throw new Error(`program-row-heights.js doesn't know how to interpolate "{{ ${expr} }}" - update evalInterpolation`);
    }
}
// ng-style="..." becomes a real style="..." where it matters to what is
// being measured (the gauge's fill width) and is dropped where it is purely
// cosmetic (the color square's background) - anything else throws.
function resolveNgStyle(attrs, x) {
    return attrs.replace(/\sng-style="([^"]*)"/, (_, expr) => {
        if (expr === 'rowSquareStyle(x)' || expr === 'programSquareStyle(x)') {
            return '';
        }
        if (expr === "{width: rowSlotFillPercent(x) + '%'}") {
            return ` style="width: ${commonProgramTools.rowSlotFillPercent(x)}%"`;
        }
        throw new Error(`program-row-heights.js doesn't know how to resolve ng-style="${expr}" - update resolveNgStyle`);
    });
}

// Resolves one row's real template against one fixture program: drops each
// top-level ng-if child whose condition is false for this fixture, and
// substitutes real computed text for every {{ }} left standing.
function resolveRow(rowTemplate, x, heightVar, rowHeightPx) {
    let html = rowTemplate.replace(`{{ ${heightVar} }}`, String(rowHeightPx));
    const openTagEnd = html.indexOf('>');
    const openTag = html.slice(0, openTagEnd + 1);
    const closeTag = '</div>';
    const body = html.slice(openTagEnd + 1, html.length - closeTag.length);

    // Row children are flat siblings - spans, and buttons with an <i> inside
    // - never nested spans, so a lazy match to the closing tag is exact.
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
        // {{ }} inside an attribute (the Flex tag's tooltip): the same lookup, escaped for an attribute.
        const resolvedAttrs = resolveNgStyle(attrs, x).replace(/\{\{\s*([^}]+?)\s*\}\}/g,
            (_, expr) => String(evalInterpolation(expr, x)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'));
        resolvedBody += `<${tag}${resolvedAttrs}>${resolvedInner}</${tag}>`;
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

// Narrower than the real modal on purpose: the fixtures' long titles have to
// not fit, so the truncation checks are about a row that is actually too
// narrow, not one with room to spare.
const SCROLLER_WIDTH_PX = 700;

async function measureRows(puppeteer, executablePath, list, rows, containerHeightPx) {
    const styleCss = fs.readFileSync(STYLE_FILE, 'utf8');
    const html = `<!doctype html><html><head><style>${BOOTSTRAP_SHIM_CSS}\n${styleCss}</style></head>
<body>
  <div id="scroller" style="display:flex; flex-direction:column; width:${SCROLLER_WIDTH_PX}px; height:${containerHeightPx}px; overflow-y:auto;"
       class="list-group list-group-root ${list.containerClass}">
    ${rows.map((r, i) => r.replace('class="list-group-item', `id="row-${i}" class="list-group-item`)).join('\n')}
  </div>
</body></html>`;

    const browser = await puppeteer.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        await page.setContent(html, { waitUntil: 'load' });
        const measured = [];
        for (let i = 0; i < rows.length; i++) {
            measured.push(await page.evaluate((id, textSelectors) => {
                const el = document.getElementById(id);
                if (!el) {
                    return null;
                }
                const rowRect = el.getBoundingClientRect();
                const text = {};
                textSelectors.forEach((sel) => {
                    const t = el.querySelector(sel);
                    if (t) {
                        text[sel] = {
                            width: t.getBoundingClientRect().width,
                            overflowing: t.scrollWidth > t.clientWidth,
                            textOverflow: getComputedStyle(t).textOverflow,
                        };
                    }
                });
                const buttons = el.querySelectorAll('button');
                const lastButton = buttons.length > 0 ? buttons[buttons.length - 1] : null;
                const track = el.querySelector('.lr-gauge-track');
                const fill = el.querySelector('.lr-gauge-fill');
                return {
                    height: rowRect.height,
                    text,
                    // How far the row's last button sticks out past its right edge (<= 0: inside).
                    lastButtonOverhang: lastButton ? lastButton.getBoundingClientRect().right - rowRect.right : null,
                    durationOverhang: el.querySelector('.psr-duration') ? el.querySelector('.psr-duration').getBoundingClientRect().right - rowRect.right : null,
                    // The gauge's distance above the row's bottom edge, and
                    // how much of the row's width its fill covers.
                    gaugeBottomGap: track ? rowRect.bottom - track.getBoundingClientRect().bottom : null,
                    gaugeHeight: track ? track.getBoundingClientRect().height : null,
                    gaugeFillFraction: fill ? fill.getBoundingClientRect().width / rowRect.width : null,
                };
            }, `row-${i}`, list.textSelectors));
        }
        return measured;
    } finally {
        await browser.close();
    }
}

const MIN = 60 * 1000;
const LONG_SHOW = 'A Fairly Long Show Name That Might Wrap Without Truncation Because It Just Keeps Going';
const LONG_TITLE = 'An Episode Title Long Enough To Need The Ellipsis Truncation Rule, And Then Some More Words After That';

const LONG_TAG = 'Nick at Nite Up Next Bumpers · The Fairly Long Show Name → Another Quite Long Show Name / (Nick at Nite WBRB Clips) / Nick Bumpers ? / Sign On';

const LISTS = [
    {
        name: 'channel programming list',
        file: 'channel-config.html',
        marker: 'ng-repeat="x in channel.programs track by x.$index"',
        heightVar: 'programRowHeight',
        heightPx: commonProgramTools.programScheduleRowHeight,
        containerClass: 'programming-programs',
        textSelectors: ['.psr-title', '.psr-show', '.psr-flex-tag'],
        longTextRows: ['program row', 'Flex row, a tag longer than the row'],
        noPushOut: ['Flex row, a tag longer than the row', 'Flex row with a short tag', 'Flex row', 'program row', 'redirect row'],
        fixtures: [
            ['program row', {
                isOffline: false, type: 'episode',
                start: new Date(2026, 8, 28, 14, 0, 5),
                showTitle: LONG_SHOW, season: 1, episode: 12, title: LONG_TITLE,
                duration: 23 * MIN + 47 * 1000,
                $breakAfterMs: 4 * MIN + 46 * 1000,
            }],
            ['Flex row', {
                isOffline: true, type: 'flex',
                start: new Date(2026, 8, 28, 14, 24, 0),
                duration: 6 * MIN,
            }],
            ['Flex row with a short tag', {
                isOffline: true, type: 'flex',
                start: new Date(2026, 8, 28, 14, 24, 0),
                duration: 4 * MIN + 12 * 1000,
                $$flexTag: { text: 'WBRB / BTTS', title: 'Before the break: WBRB\nAfter the break: BTTS' },
            }],
            ['Flex row, a tag longer than the row', {
                isOffline: true, type: 'flex',
                start: new Date(2026, 8, 28, 14, 24, 0),
                duration: 4 * MIN + 12 * 1000,
                $$flexTag: { text: LONG_TAG, title: 'Before the break: ' + LONG_TAG + '\n"quoted" & <odd>' },
            }],
            ['redirect row', {
                isOffline: true, type: 'redirect', channel: 42,
                start: new Date(2026, 8, 28, 14, 30, 0),
                duration: 30 * MIN,
            }],
        ],
    },
    {
        name: 'custom show editor list',
        file: 'show-config.html',
        marker: 'ng-repeat="x in filteredContent"',
        heightVar: 'contentRowHeight',
        heightPx: commonProgramTools.contentListRowHeight,
        containerClass: 'show-list',
        textSelectors: ['.lr-title', '.lr-show'],
        longTextRows: ['episode row, long names'],
        gaugeRows: ['episode row, long names', 'movie row', 'movie row without a year', 'track row', 'half-episode row'],
        fixtures: [
            ['episode row, long names', {
                type: 'episode', showTitle: LONG_SHOW, season: 12, episode: 104, title: LONG_TITLE,
                duration: 23 * MIN + 47 * 1000,
            }],
            ['movie row', {
                type: 'movie', title: 'A Movie', year: 1999,
                duration: 2 * 60 * MIN + 15 * MIN,
            }],
            ['movie row without a year', {
                type: 'movie', title: 'A Clip With Nothing Else To Say',
                duration: 12 * 1000,
            }],
            ['track row', {
                type: 'track', showTitle: 'An Album', season: 2, episode: 7, title: 'A Track',
                duration: 3 * MIN + 41 * 1000,
            }],
            ['half-episode row', {
                type: 'episode', showTitle: 'A Show', season: 1, episode: 2, title: 'Half A Half Hour',
                duration: 11 * MIN + 4 * 1000,
            }],
            ['row with no usable duration (no gauge)', {
                type: 'movie', title: 'No Duration', year: 2001,
                duration: 0,
            }],
        ],
    },
    {
        name: 'filler list',
        file: 'filler-config.html',
        marker: 'ng-repeat="x in filteredContent"',
        heightVar: 'contentRowHeight',
        heightPx: commonProgramTools.contentListRowHeight,
        containerClass: 'filler-list',
        textSelectors: ['.lr-name'],
        longTextRows: ['clip with a long title', 'episode in a filler list'],
        fixtures: [
            ['clip with a long title', {
                type: 'movie', title: LONG_SHOW + ' ' + LONG_TITLE,
                duration: 31 * 1000,
            }],
            ['short clip', {
                type: 'movie', title: 'Bump',
                duration: 4 * 1000,
            }],
            ['episode in a filler list', {
                type: 'episode', showTitle: LONG_SHOW, season: 3, episode: 9, title: LONG_TITLE,
                duration: 22 * MIN,
            }],
        ],
    },
];

module.exports = async function run() {
    const suite = new Suite('list row heights');

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

    for (const list of LISTS) {
        suite.log(`-- ${list.name}`);
        const rowHeightPx = list.heightPx;
        suite.check(`${list.name}: its row height constant is a positive number`, typeof rowHeightPx === 'number' && rowHeightPx > 0);

        const templateHtml = fs.readFileSync(path.join(TEMPLATES, list.file), 'utf8');
        suite.check(`${list.name}: the row binds its own height to ${list.heightVar} (not a separate hardcoded value)`,
            templateHtml.includes(`style="height: {{ ${list.heightVar} }}px"`));
        suite.check(`${list.name}: vs-repeat is told the same ${list.heightVar} value (not a separate hardcoded size)`,
            templateHtml.includes(`vs-repeat="{size: ${list.heightVar}}"`));

        const rowTemplate = extractRowTemplate(templateHtml, list.marker, list.file);
        const resolvedRows = list.fixtures.map(([, x]) => resolveRow(rowTemplate, x, list.heightVar, rowHeightPx));

        let measured;
        try {
            // Shorter than 3 real rows, on purpose: vs-repeat's real scroll
            // container is exactly this shape (flex-direction:column, real
            // rows outnumbering the visible space), and that's what squashes
            // a row lacking flex-shrink:0 below its declared height - see
            // NOTES.md's root-cause writeup.
            measured = await measureRows(puppeteer, executablePath, list, resolvedRows, Math.round(rowHeightPx * 1.5));
        } catch (err) {
            suite.check(`${list.name}: rendered the fixture rows in a real browser`, false, err.message);
            continue;
        }

        list.fixtures.forEach(([label], i) => {
            suite.check(`${list.name}: ${label} renders at exactly ${rowHeightPx}px (vs-repeat is told ${rowHeightPx})`,
                measured[i] && measured[i].height === rowHeightPx, `measured ${measured[i] && measured[i].height}px`);
        });
        const heights = measured.map((m) => m && m.height);
        suite.check(`${list.name}: every row measures the same real height as every other`,
            heights.every((h) => h === heights[0]), JSON.stringify(heights));

        // A long name ends in an ellipsis, and doesn't collapse to nothing
        // to get there (the .psr-show min-width bug: a flex item with
        // overflow:hidden has automatic min-width 0).
        list.fixtures.forEach(([label], i) => {
            if (!(list.longTextRows || []).includes(label)) {
                return;
            }
            Object.entries(measured[i].text).forEach(([sel, t]) => {
                suite.check(`${list.name}: ${label}: ${sel} still has real width`, t.width >= 40, `${t.width}px`);
                suite.check(`${list.name}: ${label}: ${sel} is cut off with an ellipsis`,
                    t.overflowing && t.textOverflow === 'ellipsis', JSON.stringify(t));
            });
        });

        // A tag may take the room it needs but never pushes the duration or the
        // buttons out of the row: it gives way (ellipsis) first.
        list.fixtures.forEach(([label], i) => {
            if (!(list.noPushOut || []).includes(label)) {
                return;
            }
            const m = measured[i];
            suite.check(`${list.name}: ${label}: the duration and the buttons stay inside the row`,
                (m.durationOverhang === null || m.durationOverhang <= 0.5) && (m.lastButtonOverhang === null || m.lastButtonOverhang <= 0.5),
                `duration ${m.durationOverhang}, button ${m.lastButtonOverhang}`);
        });

        // The slot-fit gauge: a thin bar flush with the row's bottom edge,
        // filled to the slot-fit percentage of the row's own width, and
        // absent when there's no gauge to show.
        if (list.gaugeRows) {
            list.fixtures.forEach(([label, x], i) => {
                const m = measured[i];
                if (list.gaugeRows.includes(label)) {
                    const expectFraction = commonProgramTools.rowSlotFillPercent(x) / 100;
                    suite.check(`${list.name}: ${label}: gauge bar sits flush on the row's bottom edge, 3px thin`,
                        m.gaugeBottomGap === 0 && m.gaugeHeight === 3, `gap ${m.gaugeBottomGap}, height ${m.gaugeHeight}`);
                    suite.check(`${list.name}: ${label}: gauge fill covers the slot-fit share of the row`,
                        m.gaugeFillFraction !== null && Math.abs(m.gaugeFillFraction - expectFraction) < 0.01,
                        `${m.gaugeFillFraction} vs ${expectFraction}`);
                } else {
                    suite.check(`${list.name}: ${label}: draws no gauge`, m.gaugeBottomGap === null);
                }
            });
        }
    }

    return suite;
};
