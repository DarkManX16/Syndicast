/*
 * Saves never wait behind frames (docs/blocks-spec.md, Stage 6, build order 5c).
 *
 * The real Breaks page (web/public: index.html, the built bundle.js, the view) in a real
 * browser, against a stand-in server: the show lists and the show come from the real page
 * model (src/breaks-page.js) over a real show record, a point's change goes through the real
 * break-edit, and every frame request is held open, never answered - a drive that does not
 * answer. Stepping through six points with N and then pressing A must still put the approval
 * on the server at once; the page must never have more than two frame requests open, and none
 * for a point it has left.
 *
 * Needs a real Chromium-family browser - skips, not fails, when none is found - and a built
 * bundle.js (npm run build).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Suite } = require('./support');
const page = require('../src/breaks-page');
const edit = require('../src/break-edit');
const closeBrowser = require('../scripts/lib/close-browser');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'web', 'public');
const DEV = path.join(ROOT, '.dizquetv-dev');

function findChromeExecutable() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find( (p) => fs.existsSync(p) ) || null;
}

function pt(at, kind, strength = 0.5) {
    return { at, black: [ at - 1, at + 1 ], silence: [ at - 1, at + 1 ], kind, sources: [ 'blackSilence' ], strength, keyframe: null, status: 'found', approvedBy: null };
}

// One show, two episodes with four points waiting each: eight points to step through.
function showRecord(folder = 'Slow', name = 'Slow Show') {
    const files = {};
    for (let i = 1; i <= 2; i++) {
        files[`G:\\${folder}\\${name} S01E0${i}.mkv`] = { ratingKey: String(i), size: 1, mtimeMs: 1, durationMs: 22 * 60000, scannedAt: 1, scanner: 1, chapters: [],
            points: [ pt(200 + i, 'act'), pt(420 + i, 'act'), pt(640 + i, 'act'), pt(860 + i, 'act') ], noBreaks: false, error: null };
    }
    return { theatrical: false, pattern: null, files };
}

function stubServer() {
    const key = 'tv.Slow Show';
    const show = showRecord();
    // a second show, opened after the first one's frames hang (step 5d: the panel that did not open)
    const shows = { [key]: { show, name: 'Slow Show' }, 'tv.Other Show': { show: showRecord('Other', 'Other Show'), name: 'Other Show' } };
    const state = { frames: [], open: new Set(), maxOpen: 0, saves: [] };
    const app = express();
    app.use(express.json());
    app.get('/version.js', (req, res) => res.type('application/javascript').send(''));
    const detail = (k = key) => page.detail(k, shows[k].show, shows[k].name);
    const scanner = { ready: true, mode: 'off', reason: 'Paused by hand', pausedByHand: true, midrolls: true, working: false, current: null, queued: 0,
        counts: { week: { files: 2, scanned: 2 }, library: { files: 2, scanned: 2 }, skipped: { files: 0 } }, skipDrives: [], scanFirst: [], live: [], log: [], pace: [], diskPriority: { level: 'very low' } };
    app.get('/api/breaks/scanner', (req, res) => res.send(scanner));
    app.get('/api/breaks/shows', (req, res) => res.send( { ready: true, counts: { shows: 2 }, shows: Object.keys(shows).map( (k) => detail(k).line ) } ));
    app.get('/api/breaks/show', (req, res) => {
        state.showAsked = (state.showAsked || []).concat( [ { key: req.query.key, at: Date.now() } ] );
        res.send(detail(String(req.query.key)));
    } );
    app.post('/api/breaks/point', (req, res) => {
        const b = req.body || {};
        state.saves.push( { at: Date.now(), action: b.action, index: b.index } );
        const r = edit.editPoint(shows[b.key].show.files[b.path], Number(b.index), b.action, Number(b.value));
        if (r.ok === false) {
            return res.status(400).send( { error: r.error } );
        }
        res.send(detail(b.key));
    } );
    // A drive that never answers: every frame request is held open until the page lets go of it.
    app.get('/api/breaks/frame', (req, res) => {
        const f = { t: Number(req.query.t), at: Date.now(), closedAt: null };
        state.frames.push(f);
        state.open.add(f);
        state.maxOpen = Math.max(state.maxOpen, state.open.size);
        req.on('close', () => {
            f.closedAt = Date.now();
            state.open.delete(f);
        } );
    } );
    app.use('/api', (req, res) => res.send( (req.method === 'GET') ? [] : {} ));
    app.use(express.static(PUBLIC));
    for (const dir of [ 'bootstrap-4.4.1-dist', 'fontawesome-free-5.15.4-web' ]) {
        if (fs.existsSync(path.join(DEV, dir))) {
            app.use('/' + dir, express.static(path.join(DEV, dir)));
        }
    }
    return { app, state, show };
}

module.exports = async () => {
    const suite = new Suite('Breaks page: saves never wait behind frames');
    const executablePath = findChromeExecutable();
    if (executablePath === null) {
        suite.log('SKIP  no Chromium-family browser found');
        return suite;
    }
    if (! fs.existsSync(path.join(PUBLIC, 'bundle.js'))) {
        suite.log('SKIP  web/public/bundle.js is not built (npm run build)');
        return suite;
    }
    const { app, state, show } = stubServer();
    const server = http.createServer(app);
    await new Promise( (r) => server.listen(0, '127.0.0.1', r) );
    const url = `http://127.0.0.1:${server.address().port}`;
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch( { executablePath, headless: true } );
    try {
        const tab = await browser.newPage();
        await tab.setViewport( { width: 1280, height: 900 } );
        // The page's own count of frame requests open: started by the browser, not yet finished,
        // failed or cancelled. (The server hears of a cancel a moment later, over the socket.)
        const inBrowser = { open: new Set(), max: 0 };
        const isFrame = (r) => r.url().includes('/api/breaks/frame');
        tab.on('request', (r) => {
            if (isFrame(r)) {
                inBrowser.open.add(r);
                inBrowser.max = Math.max(inBrowser.max, inBrowser.open.size);
            }
        } );
        const ended = (r) => inBrowser.open.delete(r);
        tab.on('requestfinished', ended);
        tab.on('requestfailed', ended);
        await tab.goto(url + '/#!/breaks', { waitUntil: 'domcontentloaded' });
        await tab.waitForSelector('.bk-show .bk-name a', { timeout: 20000 });
        const nameLink = (n) => tab.evaluateHandle( (x) => [ ...document.querySelectorAll('.bk-show .bk-name a') ].find( (a) => a.textContent.trim() === x ) || null, n ).then( (h) => h.asElement() );
        await (await nameLink('Slow Show')).click();
        await tab.waitForFunction( () => document.querySelectorAll('breaks-frame').length === 2, { timeout: 10000 } );
        const sleep = (ms) => new Promise( (r) => setTimeout(r, ms) );
        await sleep(300);
        // Six points, one after another, as quickly as a person steps with N.
        for (let i = 0; i < 5; i++) {
            await tab.keyboard.press('n');
            await sleep(120);
        }
        const focusAt = await tab.evaluate( () => angular.element(document.querySelector('.breaks-page')).scope().focusPoint().at );
        const pressed = Date.now();
        await tab.keyboard.press('a');
        for (let i = 0; i < 50 && state.saves.length === 0; i++) {
            await sleep(100);
        }
        const waited = (state.saves.length > 0) ? state.saves[0].at - pressed : null;
        suite.check('after stepping through six points whose frames never come, A reaches the server within a second',
            (waited !== null) && (waited < 1000) && (state.saves[0].action === 'approve'), (waited === null) ? 'never arrived in 5 s' : `${waited} ms`);
        const savedIndex = state.saves.length ? state.saves[0].index : null;
        const savedAt = (savedIndex != null) ? Object.values(show.files).flatMap( (r) => r.points ).find( (p) => p.status === 'approved' ) : null;
        suite.check('...and it approved the point on screen', (savedAt != null) && (Math.abs(savedAt.at - focusAt) < 0.05), `${savedAt && savedAt.at} vs ${focusAt}`);
        suite.check('the page never had more than two frame requests open at once', inBrowser.max <= 2, `${inBrowser.max} at once in the browser, ${state.maxOpen} as the server saw it (${state.frames.length} asked for)`);
        await sleep(300);
        const now = await tab.evaluate( () => {
            const s = angular.element(document.querySelector('.breaks-page')).scope();
            const p = s.focusPoint();
            return p ? [ p.frames.before, p.frames.after ] : [];
        } );
        const stale = [ ...state.open ].filter( (f) => ! now.includes(f.t) );
        suite.check('...and none for a point it has left', stale.length === 0, `${stale.length} still open for other points (open now: ${[ ...state.open ].map( (f) => f.t ).join(', ')}; on screen: ${now.join(', ')})`);

        // Step 5d: the panel that did not open (Nov 14, breaks-page, right after special-day). With one
        // show's frames hanging, another show is clicked: its panel must open with its points, at once.
        const clicked = Date.now();
        await (await nameLink('Other Show')).click();
        const opened = await tab.waitForFunction( () => {
            const s = angular.element(document.querySelector('.breaks-page')).scope();
            return (s.openKey === 'tv.Other Show') && (s.detail !== null) && (s.detail.line.key === 'tv.Other Show') && (document.querySelector('.bk-review') !== null);
        }, { timeout: 5000, polling: 50 } ).then( () => Date.now() - clicked, () => null );
        const asked = (state.showAsked || []).filter( (a) => a.key === 'tv.Other Show' );
        suite.check('with one show\'s frames hanging, clicking another show opens its panel with its points at once',
            (opened !== null) && (opened < 2000), (opened === null) ? `not open in 5 s; the server was asked for it ${asked.length ? `${asked[0].at - clicked} ms after the click` : 'never'}` : `${opened} ms`);
    } finally {
        await closeBrowser(browser, 10000).catch( () => {} );
        server.closeAllConnections && server.closeAllConnections();
        await new Promise( (r) => server.close(r) );
    }
    return suite;
};
