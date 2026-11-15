/*
 * Step 5d (docs/blocks-spec.md): can a real click fail? Clicks one control many times, the way
 * scripts/editor-workflows.js clicks (the control found, scrolled into view, checked uncovered, a
 * real mouse click at its middle), and records each time where the control was when it was found,
 * just before the click and just after, what was under the pointer at the click, every layout
 * shift the browser reported around it, and whether the click did its job.
 *
 *   node scripts/click-probe.js --url http://localhost:18260 --what special-day|breaks-panel [--n 300] [--channel 3] [--out file.json]
 *
 * special-day: the channel editor's Time Slots dialog, "+ Add special day": did its form open?
 *   Each round opens Time Slots and clicks at once, as the special-day workflow does; Cancel
 *   throws the day away. Every 25 rounds the editor itself is opened afresh.
 * breaks-panel: the Breaks page, a show's name in the list: did its panel open? Each round loads
 *   the page, searches for the show and clicks it, as the breaks-page workflow does.
 * Runs only against a scratch server on a copy (refuses port 18000).
 */
const fs = require('fs');
const puppeteer = require('puppeteer-core');

function args(argv) {
    const o = { n: 300, channel: 3, what: null, url: null, out: null, headful: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--url') o.url = argv[++i];
        else if (a === '--what') o.what = argv[++i];
        else if (a === '--n') o.n = Number(argv[++i]);
        else if (a === '--channel') o.channel = Number(argv[++i]);
        else if (a === '--out') o.out = argv[++i];
        else if (a === '--headful') o.headful = true;
    }
    return o;
}
const chrome = () => [ 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' ].find( (p) => fs.existsSync(p) );
const sleep = (ms) => new Promise( (r) => setTimeout(r, ms) );

// Layout shifts, with what moved, kept on the page from the moment it loads.
const SHIFT_WATCH = () => {
    window.__shifts = [];
    try {
        new PerformanceObserver( (list) => {
            for (const e of list.getEntries()) {
                window.__shifts.push( { at: performance.now(), value: e.value, sources: (e.sources || []).map( (s) => ({
                    node: s.node ? (s.node.className || s.node.tagName || '').toString().slice(0, 60) : null,
                    from: s.previousRect ? [ Math.round(s.previousRect.y), Math.round(s.previousRect.height) ] : null,
                    to: s.currentRect ? [ Math.round(s.currentRect.y), Math.round(s.currentRect.height) ] : null,
                }) ) } );
            }
        } ).observe( { type: 'layout-shift', buffered: true } );
    } catch (e) {
        // no layout-shift entries in this browser
    }
};

(async () => {
    const o = args(process.argv.slice(2));
    if (! o.url || /:18000\b/.test(o.url) || ! [ 'special-day', 'breaks-panel' ].includes(o.what)) {
        console.error('usage: node scripts/click-probe.js --url <a scratch server, not 18000> --what special-day|breaks-panel [--n 300]');
        process.exit(2);
    }
    const browser = await puppeteer.launch( { executablePath: chrome(), headless: ! o.headful, defaultViewport: { width: 1400, height: 1000 } } );
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(SHIFT_WATCH);
    const rectOf = (h) => h.evaluate( (el) => { const r = el.getBoundingClientRect(); return [ Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height) ]; } );
    const under = (x, y) => page.evaluate( (px, py) => {
        const t = document.elementFromPoint(px, py);
        return t ? `${t.tagName.toLowerCase()}${t.className ? '.' + String(t.className).trim().split(/\s+/).slice(0, 3).join('.') : ''}${(t.textContent || '').trim() ? ' "' + t.textContent.trim().slice(0, 30) + '"' : ''}` : null;
    }, x, y );
    // The workflows' click, measured: found -> scrolled -> 150 ms -> checked -> clicked.
    const probeClick = async (find) => {
        const h = await find();
        if (h === null) {
            return { found: false };
        }
        const t0 = await page.evaluate( () => performance.now() );
        const atFind = await rectOf(h);
        await h.evaluate( (el) => el.scrollIntoView( { block: 'nearest', inline: 'nearest' } ) );
        await sleep(150);
        const atClick = await rectOf(h);
        const x = atClick[0] + atClick[2] / 2;
        const y = atClick[1] + atClick[3] / 2;
        const before = await under(x, y);
        await page.mouse.click(x, y);
        const t1 = await page.evaluate( () => performance.now() );
        const justAfter = await rectOf(h).catch( () => null );
        await sleep(300);
        const later = await rectOf(h).catch( () => null );
        const shifts = await page.evaluate( (a, b) => window.__shifts.filter( (s) => (s.at >= a - 1000) && (s.at <= b + 300) ), t0, t1 );
        return { found: true, atFind, atClick, justAfter, later, x: Math.round(x), y: Math.round(y), under: before, shifts };
    };

    const rounds = [];
    if (o.what === 'special-day') {
        const openEditor = async () => {
            await page.goto(o.url + '/#!/channels', { waitUntil: 'networkidle2' });
            await page.reload( { waitUntil: 'networkidle2' } );
            const cell = await page.waitForFunction( (n) => {
                const row = [ ...document.querySelectorAll('tr.channel-row') ].find( (r) => r.cells[0] && r.cells[0].textContent.trim() === String(n) );
                return row ? row.cells[2] : null;
            }, { timeout: 30000 }, o.channel );
            await cell.asElement().click();
            await page.waitForFunction( () => document.querySelector('#channelConfigProgramList .psr-row') !== null, { timeout: 120000, polling: 500 } );
            await sleep(1500);
        };
        const visibleButton = (sel, text) => page.evaluateHandle( (s, src) => [ ...document.querySelectorAll(s) ].find( (b) => b.getClientRects().length > 0 && new RegExp(src).test(b.textContent.trim()) ) || null, sel, text.source ).then( (h) => h.asElement() );
        const waitButton = async (sel, text, ms) => {
            for (let i = 0; i < ms / 100; i++) {
                const h = await visibleButton(sel, text);
                if (h) return h;
                await sleep(100);
            }
            return null;
        };
        for (let i = 0; i < o.n; i++) {
            if (i % 25 === 0) {
                await openEditor();
            }
            if (! await visibleButton('button[title="Time Slots..."]', /Time Slots\.\.\./)) {
                (await waitButton('button[ng-click="toggleTools()"]', /Tools/, 10000)).click();
            }
            const ts = await waitButton('button[title="Time Slots..."]', /Time Slots\.\.\./, 10000);
            await ts.click();
            await waitButton('.modal-footer button', /^Create Lineup$/, 180000);
            // the button where it is not usually found: what is above it, as a picture and as text
            const usual = rounds.length ? rounds.map( (x) => x.atFind && x.atFind[1] ).sort()[Math.floor(rounds.length / 2)] : null;
            const r = await probeClick( async () => {
                const h = await waitButton('button', /^\+ Add special day$/, 10000);
                const y = h ? await rectOf(h).then( (q) => q[1] ) : null;
                if ( (h !== null) && (usual !== null) && (Math.abs(y - usual) > 10) ) {
                    const shot = `${o.out || 'click-probe'}.round${i}.png`;
                    await page.screenshot( { path: shot } ).catch( () => {} );
                    const above = await page.evaluate( () => [ ...document.querySelectorAll('.modal-body > div') ].filter( (d) => d.getClientRects().length > 0 ).slice(0, 8)
                        .map( (d) => `${Math.round(d.getBoundingClientRect().height)}px ${d.textContent.replace(/\s+/g, ' ').trim().slice(0, 140)}` ) );
                    console.log(`round ${i}: button found at y ${y}, not ${usual}; screenshot ${shot}; above it:`, JSON.stringify(above));
                }
                return h;
            } );
            const opened = await page.waitForFunction( () => [ ...document.querySelectorAll('input[ng-model="day.name"]') ].some( (e) => e.getClientRects().length > 0 ), { timeout: 3000, polling: 100 } ).then( () => true, () => false );
            r.ok = opened;
            r.round = i;
            rounds.push(r);
            if (! opened) {
                console.log(`round ${i}: NO FORM`, JSON.stringify(r));
            }
            // Cancel: the Time Slots dialog's own, which throws the new day away
            const cancel = await page.evaluateHandle( () => {
                const m = [ ...document.querySelectorAll('.modal') ].find( (x) => { const t = x.querySelector('.modal-title'); return t && t.textContent.trim() === 'Time Slots' && x.getClientRects().length > 0; } );
                return m ? [ ...m.querySelectorAll('.modal-footer button') ].find( (b) => b.textContent.trim() === 'Cancel' ) || null : null;
            } );
            await cancel.asElement().click();
            await page.waitForFunction( () => ! [ ...document.querySelectorAll('.modal-title') ].some( (t) => t.textContent.trim() === 'Time Slots' && t.getClientRects().length > 0 ), { timeout: 10000, polling: 100 } ).catch( () => {} );
            await sleep(200);
        }
    } else {
        const shows = await (await fetch(o.url + '/api/breaks/shows')).json();
        const names = shows.shows.filter( (s) => s.needsClick && s.kind !== 'movie' && /^[ -~]+$/.test(s.name) ).slice(0, 30).map( (s) => s.name );
        for (let i = 0; i < o.n; i++) {
            const name = names[i % names.length];
            await page.goto(o.url + '/#!/breaks', { waitUntil: 'networkidle2' });
            await page.reload( { waitUntil: 'networkidle2' } );
            await page.waitForFunction( () => document.querySelector('.bk-show') !== null, { timeout: 30000, polling: 200 } );
            const box = await page.$('.bk-search');
            await box.evaluate( (el) => { el.focus(); el.select(); } );
            await page.keyboard.press('Backspace');
            await page.keyboard.type(name);
            await page.waitForFunction( (n) => [ ...document.querySelectorAll('.bk-show .bk-name a') ].some( (a) => a.textContent.trim() === n ), { timeout: 10000, polling: 100 }, name );
            const r = await probeClick( () => page.evaluateHandle( (n) => [ ...document.querySelectorAll('.bk-name a') ].find( (a) => a.getClientRects().length > 0 && a.textContent.trim() === n ) || null, name ).then( (h) => h.asElement() ) );
            const opened = await page.waitForFunction( () => document.querySelector('.bk-review') !== null, { timeout: 10000, polling: 100 } ).then( () => true, () => false );
            const state = await page.evaluate( () => { const s = angular.element(document.querySelector('.breaks-page')).scope(); return { openKey: s.openKey, detail: s.detail !== null, focus: s.focus !== null, error: s.error }; } );
            Object.assign(r, { ok: opened, round: i, name, state });
            rounds.push(r);
            if (! opened) {
                console.log(`round ${i}: NO PANEL`, JSON.stringify(r));
            }
        }
    }
    const failed = rounds.filter( (r) => ! r.ok );
    const moved = rounds.filter( (r) => r.found && (r.atFind.join() !== r.atClick.join()) );
    const shifted = rounds.filter( (r) => r.found && r.shifts.length > 0 );
    console.log(JSON.stringify( { what: o.what, rounds: rounds.length, failed: failed.length, movedBetweenFindAndClick: moved.length, roundsWithLayoutShifts: shifted.length,
        failedRounds: failed.map( (r) => r.round ) } ));
    if (o.out) {
        fs.writeFileSync(o.out, JSON.stringify(rounds, null, 1));
    }
    await Promise.race( [ browser.close(), sleep(10000) ] );
    process.exit(0);
})().catch( (err) => { console.error(err); process.exit(1); } );
