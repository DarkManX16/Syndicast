/*
 * NOTES.md > "Dragging a program row can't shed its row mid-drag" > "A drop
 * threw away the row still being dragged". A drop in the filler list editor
 * (and the custom show editor) used to remove the dragged clip from the list
 * and put back the drag library's JSON copy of it, then redraw on the next
 * tick. The list isn't keyed, so Angular deleted the dragged row's element -
 * the one the browser's drag still belongs to - and when that redraw beat the
 * browser's dragend, dragend went to a node no longer in the page: the drag
 * library never heard it, and the drag log said "Edge never ended it".
 *
 * This mounts the real filler-config and show-config directives (bundled
 * from source with the real dragdrop.js and angular-vs-repeat, their real
 * templates in $templateCache) in a real Chromium-family browser, and plays
 * a drag as events: dragstart on a row, dragenter/dragover/drop over another
 * row, then dragend - late, after the page's own timers have run, the way
 * Edge delivered it in Ron's log, and also promptly. Then a drop with no
 * dragend at all, for the fallback.
 *
 * Skips, not fails, when no Chromium-family browser is found.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Suite } = require('./support');

const ROOT = path.join(__dirname, '..');
const CLIP_COUNT = 300;

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

// The real directives with stand-in server calls: nothing here talks to a
// server, and the editors only call these when opened or saved.
const ENTRY = `
const angular = require('angular');
require('./web/ext/dragdrop');
require('angular-vs-repeat');
const app = angular.module('dragRowKept', ['vs-repeat', 'dndLists']);
app.service('getShowData', require('./web/services/get-show-data'));
app.service('commonProgramTools', require('./web/services/common-program-tools'));
app.service('dizquetv', function () {
    return {
        getPlexServers: () => Promise.resolve([]),
        getFillerMatch: () => Promise.resolve({ showNames: {}, clips: [] }),
        getFiller: () => Promise.resolve({ content: [] }),
        getAllFillersInfo: () => Promise.resolve(['A', 'B', 'C', 'D', 'E', 'F'].map((n) => ({ id: 'id-' + n, name: 'List ' + n, count: 1 }))),
        saveFillerOrder: (ids) => { window.__savedOrders.push(ids); return Promise.resolve(); },
    };
});
app.service('namesReview', function () { return { open: () => {} }; });
app.directive('fillerConfig', require('./web/directives/filler-config'));
app.directive('showConfig', require('./web/directives/show-config'));
app.controller('fillerCtrl', require('./web/controllers/filler'));
app.run(['$templateCache', function ($templateCache) {
    $templateCache.put('templates/filler-config.html', window.__templates.filler);
    $templateCache.put('templates/show-config.html', window.__templates.show);
}]);
app.controller('MainCtrl', ['$scope', function ($scope) {
    $scope.registerFiller = (feed) => { window.__openFiller = feed; };
    $scope.registerShow = (feed) => { window.__openShow = feed; };
    $scope.done = () => {};
}]);
`;

function bundle() {
    const browserify = require('browserify');
    return new Promise((resolve, reject) => {
        const b = browserify();
        b.add(Readable.from([ENTRY]), { basedir: ROOT, file: path.join(ROOT, 'drag-row-kept-entry.js') });
        b.bundle((err, buf) => (err ? reject(err) : resolve(buf.toString())));
    });
}

function escapeForInlineScript(src) {
    return src.replace(/<\/script/gi, '<\\/script');
}

function harnessHtml(bundleSrc) {
    const templates = {
        filler: fs.readFileSync(path.join(ROOT, 'web/public/templates/filler-config.html'), 'utf8'),
        show: fs.readFileSync(path.join(ROOT, 'web/public/templates/show-config.html'), 'utf8'),
    };
    // The Filler Lists page itself, under its real controller: a plain table
    // on the drag library's own insert-then-dnd-moved path.
    const fillersPage = fs.readFileSync(path.join(ROOT, 'web/public/views/filler.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'web/public/style.css'), 'utf8');
    return `<!doctype html><html><head><style>
${css}
/* Test-only: a concrete scrollable size for each editor's list. */
.filler-list, .show-list { height: 400px; overflow-y: auto; }
</style></head>
<body>
<div ng-controller="MainCtrl">
<filler-config linker="registerFiller" on-done="done"></filler-config>
<show-config linker="registerShow" on-done="done"></show-config>
</div>
<div id="fillersPage" ng-controller="fillerCtrl">${fillersPage}</div>
<script>window.__savedOrders = [];</script>
<script>window.__templates = ${escapeForInlineScript(JSON.stringify(templates))};</script>
<script>${escapeForInlineScript(bundleSrc)}</script>
<script>angular.bootstrap(document.body, ['dragRowKept']);</script>
</body></html>`;
}

function clips(prefix) {
    const out = [];
    for (let i = 0; i < CLIP_COUNT; i++) {
        out.push({ title: `${prefix} ${i}`, type: 'episode', showTitle: `${prefix} Show`, season: 1, episode: i + 1,
            duration: 30000 + i, key: `/k/${prefix}/${i}`, serverKey: 'srv', ratingKey: String(i) });
    }
    return out;
}

/*
 * Plays one drag in the page: row `from` dropped onto the lower half of row
 * `onto` (both visible-row positions). dragendAfter: 'late' (after the page's
 * timers ran), 'prompt' (straight after drop), or 'never'. lostData: the
 * drag-overs and the drop carry an empty DataTransfer, as Edge handed them
 * over in Ron's Oct 26 lockup ("types seen none") although the dragstart
 * had set the data. lostData 'none': they carry no DataTransfer at all.
 */
async function playDrag(page, listSelector, from, onto, dragendAfter, lostData) {
    return page.evaluate(async (listSelector, from, onto, dragendAfter, lostData) => {
        const tick = (ms) => new Promise((r) => setTimeout(r, ms));
        const list = document.querySelector(listSelector);
        const scope = angular.element(list).scope();
        const before = scope.content.slice();
        const rows = list.querySelectorAll('.lr-row');
        const src = rows[from];
        const target = rows[onto];
        const draggedText = src.textContent;
        const dragged = before[from];
        const report = { dragendSeen: [], windowSawDragend: false };
        // Capture: runs before the drag library's own dragend handler, so it
        // sees the row as the browser hands dragend over, not after the
        // library's handler has redrawn the list.
        src.addEventListener('dragend', () => {
            report.dragendSeen.push({ connected: src.isConnected, sameRow: src.textContent === draggedText });
        }, true);
        const onWindow = () => { report.windowSawDragend = true; };
        window.addEventListener('dragend', onWindow, true);

        const dt = new DataTransfer();
        // A script-made DataTransfer forgets effectAllowed; a real drag of these rows carries "move".
        Object.defineProperty(dt, 'effectAllowed', { value: 'move', writable: true });
        const r = target.getBoundingClientRect();
        const at = { clientX: r.left + 20, clientY: r.top + r.height * 0.75 };
        const overDt = lostData === 'none' ? null : (lostData ? new DataTransfer() : dt);
        const fire = (node, type, extra, transfer) => node.dispatchEvent(new DragEvent(type, Object.assign({ bubbles: true, cancelable: true, dataTransfer: transfer === undefined ? dt : transfer }, extra || {})));
        fire(src, 'dragstart');
        report.typesAfterStart = Array.from(dt.types);
        await tick(20);
        fire(target, 'dragenter', at, overDt);
        fire(target, 'dragover', at, overDt);
        report.overAccepted = !fire(target, 'dragover', at, overDt);
        report.dropAccepted = !fire(target, 'drop', at, overDt);
        report.placeholder = !!list.querySelector('.dndPlaceholder');
        report.connectedRightAfterDrop = src.isConnected;
        if (dragendAfter === 'late') {
            await tick(60);
        }
        report.connectedBeforeDragend = src.isConnected;
        report.orderChangedBeforeDragend = scope.content[from] !== before[from];
        if (dragendAfter !== 'never') {
            fire(src, 'dragend');
        }
        await tick(dragendAfter === 'never' ? 1500 : 60);
        window.removeEventListener('dragend', onWindow, true);
        const now = scope.content;
        report.movedTo = now.indexOf(dragged);
        report.sameObject = report.movedTo !== -1;
        report.copyInserted = now.some((c) => c !== dragged && c.title === dragged.title);
        report.length = now.length;
        report.lengthBefore = before.length;
        report.latch = scope.vsRepeatDragOptions.latch;
        report.titlesAround = now.slice(Math.max(0, onto - 2), onto + 3).map((c) => c.title);
        return report;
    }, listSelector, from, onto, dragendAfter, lostData || false);
}

/*
 * One drag on the Filler Lists table, by its grip: row `from` dropped on the
 * lower half of row `onto`, dragend straight after. lostData as above.
 * foreign: no dragstart in this page at all - a drag of selected text from
 * elsewhere, carrying text/plain. staleStart: an in-page dragstart whose
 * dragend never came, before that foreign drag.
 */
async function playTableDrag(page, from, onto, opts) {
    return page.evaluate(async (from, onto, opts) => {
        const tick = (ms) => new Promise((r) => setTimeout(r, ms));
        const names = () => Array.from(document.querySelectorAll('#fillersPage tr.filler-row')).map((tr) => tr.children[1].innerText.trim());
        const before = names();
        const rows = document.querySelectorAll('#fillersPage tr.filler-row');
        const handle = rows[from].querySelector('td[dnd-handle]');
        const target = rows[onto];
        const r = target.getBoundingClientRect();
        const at = { clientX: r.left + 40, clientY: r.top + r.height * 0.75 };
        const dt = new DataTransfer();
        Object.defineProperty(dt, 'effectAllowed', { value: 'move', writable: true });
        const fire = (node, type, extra, transfer) => node.dispatchEvent(new DragEvent(type, Object.assign({ bubbles: true, cancelable: true, dataTransfer: transfer === undefined ? dt : transfer }, extra || {})));
        window.__savedOrders.length = 0;
        if (opts.staleStart) {
            fire(rows[4].querySelector('td[dnd-handle]'), 'dragstart');
            await tick(20);
        }
        let overDt = dt;
        if (opts.foreign) {
            overDt = new DataTransfer();
            overDt.setData('text/plain', 'some selected text');
        } else {
            fire(handle, 'dragstart');
            await tick(20);
            if (opts.lostData) {
                overDt = opts.lostData === 'none' ? null : new DataTransfer();
            }
        }
        fire(target, 'dragenter', at, overDt);
        fire(target, 'dragover', at, overDt);
        const overAccepted = !fire(target, 'dragover', at, overDt);
        const dropAccepted = !fire(target, 'drop', at, overDt);
        if (!opts.foreign) {
            fire(handle, 'dragend');
        }
        await tick(100);
        return { before, after: names(), overAccepted, dropAccepted, saved: window.__savedOrders.length };
    }, from, onto, opts);
}

// web/services/deferred-drag-move.js on its own, with a hand-driven clock.
function helperChecks(suite) {
    const makeDeferredDragMove = require('../web/services/deferred-drag-move');
    const rig = () => {
        let t = 0;
        let timers = [];
        const r = {
            log: [],
            fallbacks: 0,
            advance(ms) {
                t += ms;
                const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at);
                timers = timers.filter((x) => x.at > t);
                due.forEach((x) => x.fn());
            },
        };
        r.mover = makeDeferredDragMove({
            later: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
            cancel: (x) => { timers = timers.filter((y) => y !== x); },
            fallbackMs: 1000,
            onFallback: () => { r.fallbacks++; },
        });
        return r;
    };
    suite.log('-- holding a drop until dragend --');
    {
        const r = rig();
        r.mover.drop(() => r.log.push('a'));
        r.advance(500);
        suite.check('a drop changes nothing by itself', r.log.length === 0 && r.mover.pending());
        r.mover.end();
        suite.check('...nor while dragend is still being dispatched', r.log.length === 0);
        r.advance(0);
        suite.check('...and the move runs straight after it', r.log.join() === 'a');
        r.advance(2000);
        suite.check('...once, with no fallback after it', r.log.join() === 'a' && r.fallbacks === 0);
    }
    {
        const r = rig();
        r.mover.drop(() => r.log.push('a'));
        r.advance(999);
        suite.check('no dragend: still held at 999 ms', r.log.length === 0);
        r.advance(1);
        suite.check('...run at 1 s, and the caller told so it can end its drag state', r.log.join() === 'a' && r.fallbacks === 1);
        r.mover.end();
        r.advance(10);
        suite.check('...and a dragend after that does not run it again', r.log.join() === 'a');
    }
    {
        const r = rig();
        r.mover.drop(() => r.log.push('a'));
        r.mover.drop(() => r.log.push('b'));
        suite.check('a second drop with no dragend between runs the first move first', r.log.join() === 'a');
        r.mover.end();
        r.advance(0);
        suite.check('...and holds its own until its dragend', r.log.join() === 'a,b');
    }
    {
        const r = rig();
        r.mover.end();
        r.advance(10);
        suite.check('a dragend with no drop (let go outside, Esc) does nothing', r.log.length === 0 && !r.mover.pending());
    }
}

module.exports = async function () {
    const suite = new Suite('drag-row-kept');
    helperChecks(suite);
    const executablePath = findChromeExecutable();
    if (!executablePath) {
        suite.log('SKIP: no Chromium-family browser found (set PUPPETEER_EXECUTABLE_PATH)');
        return suite;
    }
    const puppeteer = require('puppeteer-core');
    const html = harnessHtml(await bundle());
    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    try {
        for (const editor of [
            { name: 'filler list editor', open: '__openFiller', list: '.filler-list', feed: (c) => ({ id: 'f1', name: 'Test filler', mode: 'custom', content: c }) },
            { name: 'custom show editor', open: '__openShow', list: '.show-list', feed: (c) => ({ id: 's1', name: 'Test show', content: c }) },
        ]) {
            suite.log(`-- ${editor.name} --`);
            for (const dragendAfter of ['late', 'prompt', 'never']) {
                const page = await browser.newPage();
                page.on('pageerror', (e) => suite.log('page error: ' + e.message));
                await page.setContent(html, { waitUntil: 'load' });
                // Opened from inside a digest, as the pages that host these editors do.
                await page.evaluate((open, filler) => angular.element(document.body).injector().get('$rootScope').$apply(() => { window[open](filler); }), editor.open, editor.feed(clips(editor.name)));
                await page.waitForFunction((sel) => document.querySelectorAll(sel + ' .lr-row').length > 8, { timeout: 15000 }, editor.list);
                const r = await playDrag(page, editor.list, 2, 7, dragendAfter);
                const label = `dragend ${dragendAfter === 'never' ? 'never comes' : (dragendAfter === 'late' ? 'comes late' : 'comes straight after the drop')}`;
                if (dragendAfter !== 'never') {
                    suite.check(`${label}: the dragged row is still in the page, still showing its clip, when dragend fires`,
                        r.dragendSeen.length === 1 && r.dragendSeen[0].connected && r.dragendSeen[0].sameRow, JSON.stringify(r.dragendSeen));
                    suite.check(`${label}: ...so dragend reaches the page (the drag log's "never ended" can't happen here)`, r.windowSawDragend);
                    suite.check(`${label}: ...and the list doesn't change until it has`, !r.orderChangedBeforeDragend);
                } else {
                    suite.check(`${label}: the dragged row stays put while the browser might still send it`, r.connectedBeforeDragend && !r.orderChangedBeforeDragend);
                }
                suite.check(`${label}: the clip lands where it was dropped`, r.movedTo === 7, `at ${r.movedTo}: ${JSON.stringify(r.titlesAround)} types=${r.typesAfterStart} over=${r.overAccepted} drop=${r.dropAccepted}`);
                suite.check(`${label}: ...as the same clip, not a copy of it, and nothing lost or doubled`,
                    r.sameObject && !r.copyInserted && r.length === r.lengthBefore, `copy=${r.copyInserted} ${r.lengthBefore}->${r.length}`);
                suite.check(`${label}: ...and the list is free to redraw again`, r.latch === false);
                await page.close();
            }
            for (const lost of ['empty', 'none']) {
                const page = await browser.newPage();
                page.on('pageerror', (e) => suite.log('page error: ' + e.message));
                await page.setContent(html, { waitUntil: 'load' });
                await page.evaluate((open, filler) => angular.element(document.body).injector().get('$rootScope').$apply(() => { window[open](filler); }), editor.open, editor.feed(clips(editor.name)));
                await page.waitForFunction((sel) => document.querySelectorAll(sel + ' .lr-row').length > 8, { timeout: 15000 }, editor.list);
                const r = await playDrag(page, editor.list, 2, 7, 'prompt', lost);
                const label = lost === 'none' ? 'Edge hands the drag-overs and the drop no data object at all' : 'Edge hands the drag-overs and the drop no data';
                suite.check(`${label}: the page still takes the drag it started itself`, r.overAccepted && r.dropAccepted, `over=${r.overAccepted} drop=${r.dropAccepted}`);
                suite.check(`${label}: ...and the clip lands where it was dropped, the same clip`,
                    r.movedTo === 7 && r.sameObject && !r.copyInserted && r.length === r.lengthBefore, `at ${r.movedTo}: ${JSON.stringify(r.titlesAround)}`);
                suite.check(`${label}: ...with dragend reaching the row as before`, r.dragendSeen.length === 1 && r.dragendSeen[0].connected && r.windowSawDragend);
                await page.close();
            }
        }

        suite.log('-- Filler Lists table --');
        for (const c of [
            { label: 'an ordinary drag', opts: {}, moves: true },
            { label: 'Edge hands the drag-overs and the drop no data', opts: { lostData: 'empty' }, moves: true },
            { label: 'Edge hands the drag-overs and the drop no data object at all', opts: { lostData: 'none' }, moves: true },
            { label: 'a drag of text from elsewhere', opts: { foreign: true }, moves: false },
            { label: 'a drag of text after an in-page drag that never got its dragend', opts: { foreign: true, staleStart: true }, moves: false },
        ]) {
            const page = await browser.newPage();
            page.on('pageerror', (e) => suite.log('page error: ' + e.message));
            await page.setContent(html, { waitUntil: 'load' });
            await page.waitForFunction(() => document.querySelectorAll('#fillersPage tr.filler-row').length === 6, { timeout: 15000 });
            const r = await playTableDrag(page, 1, 4, c.opts);
            const expected = ['List A', 'List C', 'List D', 'List E', 'List B', 'List F'];
            if (c.moves) {
                suite.check(`${c.label}: List B lands below List E, and the order is saved`,
                    r.overAccepted && r.dropAccepted && JSON.stringify(r.after) === JSON.stringify(expected) && r.saved === 1,
                    `over=${r.overAccepted} drop=${r.dropAccepted} ${JSON.stringify(r.after)} saved=${r.saved}`);
            } else {
                suite.check(`${c.label}: still turned down, and nothing moves`,
                    !r.overAccepted && JSON.stringify(r.after) === JSON.stringify(r.before) && r.saved === 0,
                    `over=${r.overAccepted} ${JSON.stringify(r.after)} saved=${r.saved}`);
            }
            await page.close();
        }
    } finally {
        await browser.close();
    }
    return suite;
};
