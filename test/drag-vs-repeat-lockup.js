/*
 * NOTES.md > "Dragging a program row can't shed its row mid-drag" documents
 * the bug this guards. The channel programming list (and the show/filler
 * content pickers) pair native HTML5 drag-and-drop (web/ext/dragdrop.js)
 * with vs-repeat virtualization. A drag that crosses vs-repeat's visible
 * window - exactly what the browser's own auto-scroll does near a
 * scrollable container's edge, or any ordinary scroll - makes Angular tear
 * the dragged row's own DOM node out of the document while the browser's
 * native drag session still references it. The browser has no way to
 * recover from that: the drop cursor gets stuck showing "not allowed"
 * everywhere until the whole browser is restarted.
 *
 * This drives a REAL native drag through Chrome DevTools Protocol
 * (puppeteer's page.mouse.drag/dragEnter/dragOver/drop, with
 * setDragInterception(true) - a genuine browser-level drag session, not a
 * scripted dragstart event) against the real vendored dragdrop.js and
 * angular-vs-repeat, mounted with the real container/row markup pulled
 * live from channel-config.html - not a transcription - the same "drive
 * the real thing" reasoning as test/support.js's liftSource and
 * program-row-heights.js's extractRowTemplate, so a future template change
 * either keeps passing here or fails loudly.
 *
 * Three checks:
 *  - "today's trap": the real tag with the fix's own attributes
 *    (vs-repeat-options, dnd-dragstart, dnd-dragend) stripped back out -
 *    scrolling the list mid-drag detaches the dragged row's node while the
 *    native drag is still open. Reproduces the lockup.
 *  - "fixed": the real, current tag - the same scroll mid-drag leaves the
 *    dragged row's node attached throughout.
 *  - "safety net": the one case the latch can't cover - the dragged item
 *    itself removed from channel.programs mid-drag (e.g. a lineup rebuild
 *    finishing while the user is still dragging). The row is legitimately
 *    torn down, and the fix's pinned vs-repeat-options state is expected to
 *    reset itself immediately rather than staying latched open forever.
 *
 * Needs a real Chromium-family browser (see program-row-heights.js's own
 * note) - skips, not fails, when none is found.
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./support');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_FILE = path.join(ROOT, 'web/public/templates/channel-config.html');
const STYLE_FILE = path.join(ROOT, 'web/public/style.css');
const ANGULAR_FILE = path.join(ROOT, 'node_modules/angular/angular.js');
const VS_REPEAT_FILE = path.join(ROOT, 'node_modules/angular-vs-repeat/dist/angular-vs-repeat.min.js');
const DRAGDROP_FILE = path.join(ROOT, 'web/ext/dragdrop.js');

const ROW_HEIGHT = 30;
const CONTAINER_HEIGHT = 400; // ~13 rows visible at once
const PROGRAM_COUNT = 2000;

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

// Pulls one element's real opening tag (attributes only, not its content or
// children) out of the real template, by marker + <div>/</div> depth from
// the marker back to the nearest unclosed <div - the same "drive the real
// thing" reasoning as liftSource/extractRowTemplate.
function extractOpeningTag(html, marker, file) {
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) {
        throw new Error(`${file} no longer has the expected element (marker not found: ${marker})`);
    }
    const start = html.lastIndexOf('<div', markerIdx);
    if (start === -1) {
        throw new Error(`could not find the opening <div before "${marker}" in ${file}`);
    }
    const end = html.indexOf('>', markerIdx);
    if (end === -1) {
        throw new Error(`unterminated opening tag for "${marker}" in ${file}`);
    }
    const tag = html.slice(start, end + 1);
    if (tag.slice(1).includes('<')) {
        throw new Error(`"${marker}"'s opening tag in ${file} contains a nested "<" - extraction is no longer safe`);
    }
    return tag;
}

// The fix adds exactly these three attributes to the real container/row
// tags. Stripping them back out of the real, current tag (rather than
// hand-writing a second "before" markup string that could silently drift)
// is what "today's trap" drives against.
function withoutFixAttributes(tag) {
    return tag
        .replace(/\svs-repeat-options="[^"]*"/, '')
        .replace(/\sdnd-dragstart="[^"]*"/, '')
        .replace(/\sdnd-dragend="[^"]*"/, '');
}

// The libraries' source is inlined rather than loaded via <script src> -
// page.setContent()'s page has no file:// origin of its own, and Chrome
// refuses a local-resource load from one that doesn't. angular.js's own
// source has a literal "</script>" inside a doc-comment's HTML example;
// unescaped, the HTML parser (not the JS parser) would close our <script>
// tag right there and dump the rest of the file as page markup.
function escapeForInlineScript(src) {
    return src.replace(/<\/script/gi, '<\\/script');
}
const ANGULAR_SRC = escapeForInlineScript(fs.readFileSync(ANGULAR_FILE, 'utf8'));
const VS_REPEAT_SRC = escapeForInlineScript(fs.readFileSync(VS_REPEAT_FILE, 'utf8'));
const DRAGDROP_SRC = escapeForInlineScript(fs.readFileSync(DRAGDROP_FILE, 'utf8'));

function buildHarnessHtml(containerTag, rowTag, styleCss) {
    const containerWithId = containerTag.replace('<div', '<div id="programList"');
    const rowWithId = rowTag.replace('<div', '<div id="row-{{$index}}"');
    return `<!doctype html><html><head><style>
${styleCss}
/* Test-only: give the extracted container a concrete scrollable size -
   production gets this from programmingHeight()/CSS this harness doesn't
   load; the vs-repeat/dnd mechanics under test don't depend on it. */
#programList { height: ${CONTAINER_HEIGHT}px; overflow-y: auto; }
</style></head>
<body>
<div ng-app="dragLockupTest" ng-controller="MainCtrl">
${containerWithId}
${rowWithId}<span class="row-label">{{x.title}}</span></div>
</div>
<script>${ANGULAR_SRC}</script>
<script>${VS_REPEAT_SRC}</script>
<script>${DRAGDROP_SRC}</script>
<script>
angular.module('dragLockupTest', ['vs-repeat', 'dndLists'])
  .controller('MainCtrl', function ($scope) {
    $scope.programRowHeight = ${ROW_HEIGHT};
    $scope.channel = { programs: [] };
    for (var i = 0; i < ${PROGRAM_COUNT}; i++) {
      $scope.channel.programs.push({ title: 'Program ' + i, $index: i });
    }
    $scope.hasPrograms = function () { return $scope.channel.programs.length > 0; };
    $scope.programmingHeight = function () { return '${CONTAINER_HEIGHT}px'; };
    $scope.selectProgram = function () {};
    $scope.dropFunction = function () { return false; };
    $scope.setUpWatcher = function () {};
    // Only present when the fix's own attributes are: no-ops are fine
    // when the "before" markup never calls them.
    $scope.vsRepeatDragOptions = { latch: false, preserveLatchOnRefresh: false };
    $scope.startProgramDrag = function (event) {
      $scope.vsRepeatDragOptions.latch = true;
      $scope.vsRepeatDragOptions.preserveLatchOnRefresh = true;
      window.__draggedRow = event.currentTarget;
      if (window.MutationObserver && window.__draggedRow.parentNode) {
        window.__dragObserver = new MutationObserver(function () {
          if (window.__draggedRow && !window.__draggedRow.isConnected) {
            $scope.$applyAsync(function () {
              $scope.vsRepeatDragOptions.latch = false;
              $scope.vsRepeatDragOptions.preserveLatchOnRefresh = false;
            });
          }
        });
        window.__dragObserver.observe(window.__draggedRow.parentNode, { childList: true });
      }
    };
    $scope.endProgramDrag = function () {
      $scope.vsRepeatDragOptions.latch = false;
      $scope.vsRepeatDragOptions.preserveLatchOnRefresh = false;
      window.__draggedRow = null;
      if (window.__dragObserver) {
        window.__dragObserver.disconnect();
        window.__dragObserver = null;
      }
    };
  });
</script>
</body></html>`;
}

// Finishes a CDP native drag (dragOver/drop/up) under a bounded timeout: if
// the dragged node was really torn out of a live native drag session, a
// real browser can leave this unresolved - exactly the hang a stuck drag
// produces - so this is itself a (secondary) signal of the lockup, and
// without the bound a reproduction of the trap would hang `npm test`
// forever instead of failing it.
async function finishDrag(mouse, target, data, timeoutMs) {
    const finish = (async () => {
        await mouse.dragOver(target, data);
        await mouse.drop(target, data);
        await mouse.up();
        return 'resolved';
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timed out'), timeoutMs));
    return Promise.race([finish, timeout]);
}

async function runDragScrollScenario(puppeteer, executablePath, html, rowIndexToDrag) {
    const browser = await puppeteer.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 800, height: 700 });
        await page.setDragInterception(true);
        await page.setContent(html, { waitUntil: 'load' });
        // Let the initial digest (2000 fixture rows -> vs-repeat's first
        // measurement pass) settle before measuring anything.
        await new Promise((r) => setTimeout(r, 200));

        const rowId = `row-${rowIndexToDrag}`;
        // Captured independently of the fix's own dnd-dragstart wiring (the
        // "before" markup has none), so both scenarios are checked the same
        // way: the row's id is index-based (ng-repeat's $index), and a
        // removal/reorder can hand that same id to a different row's node -
        // so what's checked afterwards has to be the exact node reference
        // dragstart fired on, not a fresh getElementById lookup.
        const rowBoxBefore = await page.evaluate((id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            el.addEventListener('dragstart', (e) => { window.__draggedNode = e.currentTarget; }, { once: true });
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, rowId);
        if (!rowBoxBefore) {
            throw new Error(`${rowId} did not render - fixture/markup mismatch`);
        }

        const start = rowBoxBefore;
        const target = { x: start.x, y: start.y + ROW_HEIGHT };
        const data = await page.mouse.drag(start, target);
        await page.mouse.dragEnter(target, data);

        const draggedNodeCaptured = await page.evaluate(() => !!window.__draggedNode);

        // What the browser's own auto-scroll does near the container's
        // edge while a drag is in progress - vs-repeat reacts to this
        // exactly like any other scroll.
        await page.evaluate((id) => {
            const container = document.getElementById(id);
            container.scrollTop = container.scrollHeight * 0.6;
            container.dispatchEvent(new Event('scroll'));
        }, 'programList');
        await new Promise((r) => setTimeout(r, 100));

        const rowConnectedAfterScroll = await page.evaluate(() => !!(window.__draggedNode && window.__draggedNode.isConnected));

        const dragFinish = await finishDrag(page.mouse, target, data, 3000);

        return { draggedNodeCaptured, rowConnectedAfterScroll, dragFinish };
    } finally {
        await browser.close();
    }
}

async function runSafetyNetScenario(puppeteer, executablePath, html, rowIndexToDrag) {
    const browser = await puppeteer.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 800, height: 700 });
        await page.setDragInterception(true);
        await page.setContent(html, { waitUntil: 'load' });
        await new Promise((r) => setTimeout(r, 200));

        const rowId = `row-${rowIndexToDrag}`;
        // Same independent-capture reasoning as runDragScrollScenario: the
        // splice below hands row-N's id to the next item's node, so the
        // node reference has to be captured before that happens.
        const rowBox = await page.evaluate((id) => {
            const el = document.getElementById(id);
            el.addEventListener('dragstart', (e) => { window.__draggedNode = e.currentTarget; }, { once: true });
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, rowId);

        const start = rowBox;
        const target = { x: start.x, y: start.y + ROW_HEIGHT };
        const data = await page.mouse.drag(start, target);
        await page.mouse.dragEnter(target, data);

        const latchedDuringDrag = await page.evaluate(() => {
            const scope = angular.element(document.getElementById('programList')).scope();
            return !!scope.vsRepeatDragOptions.latch;
        });

        // The one case the latch can't cover: the dragged item itself
        // leaving channel.programs (not just scrolling out of view) - e.g.
        // a lineup rebuild finishing while the user is still dragging.
        await page.evaluate((index) => {
            const scope = angular.element(document.getElementById('programList')).scope();
            scope.$apply(function () {
                scope.channel.programs.splice(index, 1);
            });
        }, rowIndexToDrag);
        await new Promise((r) => setTimeout(r, 150));

        const rowConnectedAfterRemoval = await page.evaluate(() => !!(window.__draggedNode && window.__draggedNode.isConnected));
        const latchResetAfterRemoval = await page.evaluate(() => {
            const scope = angular.element(document.getElementById('programList')).scope();
            return !scope.vsRepeatDragOptions.latch && !scope.vsRepeatDragOptions.preserveLatchOnRefresh;
        });

        const dragFinish = await finishDrag(page.mouse, target, data, 3000);

        return { latchedDuringDrag, rowConnectedAfterRemoval, latchResetAfterRemoval, dragFinish };
    } finally {
        await browser.close();
    }
}

module.exports = async function run() {
    const suite = new Suite('drag vs-repeat lockup');

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

    const templateHtml = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    const styleCss = fs.readFileSync(STYLE_FILE, 'utf8');
    const containerTag = extractOpeningTag(templateHtml, 'id="channelConfigProgramList"', 'channel-config.html');
    const rowTag = extractOpeningTag(templateHtml, 'ng-repeat="x in channel.programs track by x.$index"', 'channel-config.html');

    suite.check('the real container tag carries the fix\'s vs-repeat-options wiring', containerTag.includes('vs-repeat-options="vsRepeatDragOptions"'));
    suite.check('the real row tag carries the fix\'s dnd-dragstart/dnd-dragend wiring',
        containerTag !== null && rowTag.includes('dnd-dragstart=') && rowTag.includes('dnd-dragend='));

    const beforeHtml = buildHarnessHtml(withoutFixAttributes(containerTag), withoutFixAttributes(rowTag), styleCss);
    const afterHtml = buildHarnessHtml(containerTag, rowTag, styleCss);

    suite.log('-- today\'s trap (fix\'s attributes stripped back out of the real tags)');
    try {
        const before = await runDragScrollScenario(puppeteer, executablePath, beforeHtml, 3);
        suite.check('a real native dragstart fired (this is a genuine CDP-level drag, not a no-op)', before.draggedNodeCaptured === true);
        suite.check('without the fix: the dragged row is torn out of the DOM by the auto-scroll-equivalent mid-drag (reproducing the lockup)',
            before.rowConnectedAfterScroll === false, JSON.stringify(before));
    } catch (err) {
        suite.check('today\'s trap scenario ran', false, err.message);
    }

    suite.log('-- fixed (the real, current template)');
    try {
        const after = await runDragScrollScenario(puppeteer, executablePath, afterHtml, 3);
        suite.check('with the fix: the dragged row stays in the DOM through the same scroll mid-drag',
            after.rowConnectedAfterScroll === true, JSON.stringify(after));
        suite.check('with the fix: the drag still finishes cleanly (drop/up resolve, not left hanging)',
            after.dragFinish === 'resolved', JSON.stringify(after));
    } catch (err) {
        suite.check('fixed scenario ran', false, err.message);
    }

    suite.log('-- safety net (the dragged item itself removed mid-drag, which the latch can\'t cover)');
    try {
        const net = await runSafetyNetScenario(puppeteer, executablePath, afterHtml, 3);
        suite.check('the latch is on while the drag is in progress', net.latchedDuringDrag === true, JSON.stringify(net));
        suite.check('the dragged row is torn down when the item itself leaves channel.programs (expected - not a bug)',
            net.rowConnectedAfterRemoval === false, JSON.stringify(net));
        suite.check('the safety net resets the latch immediately instead of leaving it pinned open forever',
            net.latchResetAfterRemoval === true, JSON.stringify(net));
        suite.check('the drag still finishes cleanly after the safety net fires',
            net.dragFinish === 'resolved', JSON.stringify(net));
    } catch (err) {
        suite.check('safety net scenario ran', false, err.message);
    }

    return suite;
};
