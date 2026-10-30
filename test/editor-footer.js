/*
 * The channel editor's Cancel and Update Channel stay clickable on the
 * Programming tab. See NOTES.md, Resolved, "Cancel and Update Channel
 * covered after the first-open list".
 *
 * The Programming pane is capped at programmingHeight(), and the program
 * list inside it was capped at the same height. Every line above the list
 * on a Time Slots channel - "Go to", the sentence an edit leaves, the list of
 * edits still to air - pushed the list's bottom past the pane, over the
 * footer; list rows are position: relative, so they paint above the buttons
 * and take their clicks. Answering the first-open list adds the sentence,
 * which covered the buttons entirely.
 *
 * This mounts the real pane and the real footer, lifted from
 * channel-config.html, under Angular and vs-repeat with a stand-in scope, in
 * a real browser, and asks what is on top at every pixel row of each button.
 * Bootstrap is read from .dizquetv-dev when it is there (it isn't in the
 * repo); otherwise the few rules that matter here stand in for it.
 *
 * Needs a real Chromium-family browser (see program-row-heights.js) - skips,
 * not fails, when none is found.
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./support');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_FILE = path.join(ROOT, 'web/public/templates/channel-config.html');
const STYLE_FILE = path.join(ROOT, 'web/public/style.css');
const ANGULAR_FILE = path.join(ROOT, 'node_modules/angular/angular.js');
const VS_REPEAT_FILE = path.join(ROOT, 'node_modules/angular-vs-repeat/dist/angular-vs-repeat.min.js');
const BOOTSTRAP_FILE = path.join(ROOT, '.dizquetv-dev/bootstrap-4.4.1-dist/css/bootstrap.min.css');

// Bootstrap 4.4.1's rules for what this page is made of, when the real file isn't there.
const BOOTSTRAP_SHIM_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: sans-serif; font-size: 1rem; line-height: 1.5; }
.modal { position: fixed; top: 0; left: 0; z-index: 1050; width: 100%; height: 100%; overflow: hidden; outline: 0; }
.modal-dialog { position: relative; width: auto; margin: 1.75rem auto; max-width: 1140px; }
.modal-content { position: relative; display: flex; flex-direction: column; width: 100%; background-color: #fff; border: 1px solid rgba(0,0,0,.2); }
.modal-body { position: relative; flex: 1 1 auto; padding: 1rem; }
.modal-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; padding: .75rem; border-top: 1px solid #dee2e6; }
.row { display: flex; flex-wrap: wrap; margin-right: -15px; margin-left: -15px; }
.col { position: relative; width: 100%; padding-right: 15px; padding-left: 15px; flex-basis: 0; flex-grow: 1; max-width: 100%; }
.container { width: 100%; padding-right: 15px; padding-left: 15px; margin-right: auto; margin-left: auto; }
.list-group { display: flex; flex-direction: column; padding-left: 0; margin-bottom: 0; }
.list-group-item { position: relative; display: block; padding: .75rem 1.25rem; background-color: #fff; border: 1px solid rgba(0,0,0,.125); }
.d-flex { display: flex !important; }
.btn { display: inline-block; padding: .25rem .5rem; font-size: .875rem; line-height: 1.5; border: 1px solid transparent; }
.ng-hide { display: none !important; }
`;

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

// The whole <div ...>...</div> that starts at the last `opening` before `marker`, by div depth.
function liftDiv(html, opening, marker) {
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) {
        throw new Error(`channel-config.html no longer has ${marker}`);
    }
    const start = html.lastIndexOf(opening, markerIdx);
    if (start === -1) {
        throw new Error(`channel-config.html has no ${opening} before ${marker}`);
    }
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let depth = 0;
    for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
        depth += (m[0] === '</div>') ? -1 : 1;
        if (depth === 0) {
            return html.slice(start, m.index + m[0].length);
        }
    }
    throw new Error(`${opening} is not closed in channel-config.html`);
}

function escapeForInlineScript(src) {
    return src.replace(/<\/script/gi, '<\\/script');
}

function harnessHtml() {
    const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    const pane = liftDiv(template, '<div class="modal-body programming-panes"', 'class="modal-body programming-panes"');
    const footer = liftDiv(template, '<div class="modal-footer">', "{{ isNewChannel ? 'Add Channel' : 'Update Channel' }}");
    const bootstrap = fs.existsSync(BOOTSTRAP_FILE) ? fs.readFileSync(BOOTSTRAP_FILE, 'utf8') : BOOTSTRAP_SHIM_CSS;
    const css = fs.readFileSync(STYLE_FILE, 'utf8');
    return `<!doctype html><html><head><style>
${bootstrap}
${css}
</style></head>
<body>
<div ng-app="editorFooter" ng-controller="MainCtrl">
  <div class="modal" tabindex="-1" role="dialog" style="display: block;">
    <div class="modal-dialog modal-xl" role="document">
      <div class="modal-content">
        ${pane}
        ${footer}
      </div>
    </div>
  </div>
</div>
<script>${escapeForInlineScript(fs.readFileSync(ANGULAR_FILE, 'utf8'))}</script>
<script>${escapeForInlineScript(fs.readFileSync(VS_REPEAT_FILE, 'utf8'))}</script>
<script>
angular.module('editorFooter', ['vs-repeat'])
  .controller('MainCtrl', function ($scope) {
    window.__scope = $scope;
    $scope.tab = 'programming';
    $scope.isNewChannel = false;
    $scope.error = {};
    $scope.programRowHeight = 30;
    $scope.channel = { programs: [] };
    for (var i = 0; i < 500; i++) {
      $scope.channel.programs.push({ title: 'Program ' + i, duration: 1800000, $index: i });
    }
    // A break's filler tag, as long as channel 3's: one line that doesn't wrap.
    var tag = new Array(40).join('Jetix NEXT Promos · The Legend of Tarzan / ');
    $scope.rowFlexTag = function (x) { return (x.$index % 2 === 1) ? tag : ''; };
    $scope.hasPrograms = function () { return true; };
    $scope.hasTimeSlots = function () { return true; };
    $scope.programmingHeight = function () { return '30rem'; };
    $scope.lastChange = '';
    $scope.showPins = { open: false };
    $scope.pins = [];
    $scope.pinList = function () { return $scope.pins; };
    $scope.goTo = {};
    $scope.vsRepeatDragOptions = {};
    $scope.setUpWatcher = function () {};
    window.__clicked = [];
    $scope._onDone = function (channel) { window.__clicked.push(channel ? 'Update Channel' : 'Cancel'); };
  });
</script>
</body></html>`;
}

// What is on top across each button, every pixel row down its middle, and where the list ends.
async function measure(page) {
    return page.evaluate(() => {
        const footer = [...document.querySelectorAll('.modal-footer')].find((f) => /Update Channel/.test(f.textContent));
        const out = { buttons: {} };
        ['Cancel', 'Update Channel'].forEach((name) => {
            const b = [...footer.querySelectorAll('button')].find((x) => x.textContent.trim() === name);
            const r = b.getBoundingClientRect();
            let covered = 0;
            let by = null;
            for (let y = Math.ceil(r.top); y < r.bottom; y++) {
                const top = document.elementFromPoint(r.left + r.width / 2, y);
                if (!(top === b || b.contains(top))) {
                    covered++;
                    by = by || (top ? top.className : 'nothing');
                }
            }
            out.buttons[name] = { height: Math.round(r.height), covered, by };
        });
        const list = document.getElementById('channelConfigProgramList');
        const pane = list.closest('.modal-body');
        out.spill = Math.round(list.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom);
        out.listHeight = Math.round(list.clientHeight);
        out.paneHeight = Math.round(pane.getBoundingClientRect().height);
        out.listWider = Math.round(list.getBoundingClientRect().width - pane.getBoundingClientRect().width);
        return out;
    });
}

module.exports = async function run() {
    const suite = new Suite('editor-footer');
    const executablePath = findChromeExecutable();
    if (!executablePath) {
        suite.log('SKIP: no Chrome/Edge found (set PUPPETEER_EXECUTABLE_PATH)');
        return suite;
    }
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1000 });
        await page.setContent(harnessHtml(), { waitUntil: 'load' });
        await page.waitForSelector('#channelConfigProgramList .psr-row');

        const states = [
            { name: 'as the channel opens (Go to above the list)', set: {} },
            { name: 'after "Keep them" (the sentence it leaves)', set: { lastChange: 'Your swaps, inserts and moved rows are kept where they sit; Update Channel saves it.' } },
            { name: 'with the edits still to air listed', set: { lastChange: 'A sentence.', pins: [1, 2, 3, 4, 5, 6].map((n) => ({ at: n, text: 'Fri 1:0' + n + 'am An edit' })), showPins: { open: true } } },
        ];
        for (const state of states) {
            await page.evaluate((set) => {
                const s = window.__scope;
                s.$apply(() => Object.assign(s, set));
            }, state.set);
            await new Promise((r) => setTimeout(r, 100));
            const m = await measure(page);
            suite.log(`-- ${state.name}: list spills ${m.spill}px past its pane; list ${m.listHeight}px of a ${m.paneHeight}px pane --`);
            ['Cancel', 'Update Channel'].forEach((name) => {
                const b = m.buttons[name];
                suite.check(`${name} is clickable all the way across, ${state.name}`, b.covered === 0,
                    `${b.covered} of ${b.height}px rows covered by ${b.by}`);
            });
            suite.check(`the list ends inside its pane, ${state.name}`, m.spill <= 0, `${m.spill}px past`);
            suite.check(`the list is no wider than its pane, long filler tags and all, ${state.name}`, m.listWider <= 0, `${m.listWider}px wider`);
            suite.check(`the list still shows most of the pane, ${state.name}`, m.listHeight >= m.paneHeight - 200, `${m.listHeight}px`);
        }

        // A real click, through the browser's input, reaches each button's handler.
        for (const name of ['Cancel', 'Update Channel']) {
            const box = await page.evaluate((name) => {
                const footer = [...document.querySelectorAll('.modal-footer')].find((f) => /Update Channel/.test(f.textContent));
                const r = [...footer.querySelectorAll('button')].find((x) => x.textContent.trim() === name).getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }, name);
            await page.mouse.click(box.x, box.y);
        }
        const clicked = await page.evaluate(() => window.__clicked);
        suite.check('a real click on Cancel, then on Update Channel, reaches each', JSON.stringify(clicked) === JSON.stringify(['Cancel', 'Update Channel']),
            JSON.stringify(clicked));
    } finally {
        await browser.close();
    }
    return suite;
};
