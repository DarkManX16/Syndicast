#!/usr/bin/env node
/*
 * The editor workflows that must keep working (NOTES.md, Rules for every
 * session, "Workflows that must keep working"), driven with real clicks in a
 * real browser against a running preview.
 *
 *   node scripts/editor-workflows.js --url http://localhost:18230 --channel 3
 *        [--only open-cancel,library-add,...] [--show "House of Mouse"] [--headful]
 *
 * Every click is a real mouse click at the control's middle, through the
 * browser's input, after checking that nothing covers it there - a covered
 * button fails with what covers it. It saves channels and a filler list on the
 * server it drives, so it runs only against a preview on a copy of
 * .dizquetv-dev; it refuses port 18000.
 *
 * Workflows, in order (each from a fresh page):
 *   first-open-silent    opening a channel whose list still holds pins from before kept
 *                        rows keeps them at once - no dialog, nothing said; Update Channel
 *                        saves it
 *   open-cancel          open the editor, Cancel
 *   open-update          open the editor, Update Channel: saved, the lineup as it was
 *   library-add          a show from the library at the end of the list: it joins the
 *                        channel, nothing in the lineup moves or is kept; saved
 *   delete               Delete an episode: it goes at once, nothing asked or kept; Cancel
 *   add-delete-create    a show added at the end, five of its episodes deleted, each gone
 *                        at once; the Time Slots dialog's one line; Create Lineup leaves
 *                        the five out (never air); saved
 *   swap-drag-put-back   Swap an airing, drag a row, Put back each; Cancel
 *   insert-before        a clip from a custom show put right before an airing that has a Flex
 *                        above it (its Insert before): the Flex shrinks by the clip, no airing
 *                        moves; Insert after, then the clip dropped just before the airing after
 *                        its Flex: it sits there, nothing moves; Put back each; Cancel
 *   create-lineup        Time Slots... (at most one short line about kept rows), Create
 *                        Lineup; kept rows stay; saved
 *   filler               a filler list: drag a clip, delete one, Done; saved
 *   breaks-page          the Breaks page: the scanner's line and Pause switch, the Midrolls switch
 *                        and the sentence at the top, a show approved automatically (Withdraw
 *                        kept over a reload, then Approve), Needs a click in next-airing order, a pattern approved and withdrawn (and the weaker
 *                        line), a show's list stepped through with the frames either side, a
 *                        nudge, a typed time, a kind, a break added and taken away, "these have
 *                        no breaks", theatrical on a movie never scanned, Scan next. Refuses a
 *                        server whose scanner is not paused by hand; changes the copy's breaks
 *   special-day          a date's own Time Slots: add a day, a row of its own shows,
 *                        Create Lineup, Update Channel; Delete on one of its airings
 *                        refused; the day deleted and regenerated clean after. SKIPs
 *                        itself, saying why, on a bundle with no Special days section -
 *                        safe to run on blocks before Special days lands there
 *
 * first-open-silent passes over a channel whose list has nothing from before kept
 * rows to answer for; every workflow's openEditor() fails loudly if the old
 * first-open dialog ever shows - it never should, on any channel, any more.
 */
const fs = require('fs');
const { customShowsWithMovies, movieIn } = require('./lib/custom-movie-show');

function parseArgs(argv) {
    const out = { channel: 3, show: 'House of Mouse', headful: false, only: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--url') out.url = argv[++i];
        else if (a === '--channel') out.channel = parseInt(argv[++i], 10);
        else if (a === '--show') out.show = argv[++i];
        else if (a === '--only') out.only = argv[++i].split(',');
        else if (a === '--headful') out.headful = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (!out.url) {
        throw new Error('--url http://localhost:<preview port> is required');
    }
    out.url = out.url.replace(/\/+$/, '');
    if (new URL(out.url).port === '18000') {
        throw new Error('port 18000 is the live server: run this only against a preview on a copy');
    }
    return out;
}

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
        '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find((p) => fs.existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

class Check extends Error {}
// A workflow that doesn't apply to this bundle - not a failure, named why.
class Skip extends Error {}

function makeRunner(opts, page) {
    const api = async (path) => {
        const r = await fetch(opts.url + path);
        if (!r.ok) {
            throw new Error(`${path}: HTTP ${r.status}`);
        }
        return r.json();
    };
    // A save, waited for until it has landed: the page's requests settle, then the server's
    // answer at `path` passes `landed` - never a fixed delay. The last answer either way,
    // for the caller's own check to say what went wrong.
    const waitForSave = async (path, landed, timeout = 60000) => {
        await page.waitForNetworkIdle({ idleTime: 500, timeout }).catch(() => {});
        const until = Date.now() + timeout;
        let last = await api(path);
        while (!landed(last) && Date.now() < until) {
            await sleep(300);
            last = await api(path);
        }
        return last;
    };

    // The first visible element matching selector whose text matches, waited for.
    const find = async (selector, text, what, timeout = 30000) => {
        const handle = await page.waitForFunction((selector, src, flags) => {
            const re = src === null ? null : new RegExp(src, flags);
            return [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length > 0
                && getComputedStyle(el).visibility !== 'hidden'
                && (re === null || re.test(el.textContent.trim()) || re.test(el.getAttribute('title') || ''))) || null;
        }, { timeout, polling: 200 }, selector, text === null ? null : (text instanceof RegExp ? text.source : `^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
            text instanceof RegExp ? text.flags : '').catch(() => null);
        if (handle === null) {
            throw new Check(`${what} didn't show`);
        }
        return handle.asElement();
    };

    // A real click at the middle of the element, after checking nothing covers it there.
    const click = async (handle, what) => {
        await handle.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        await sleep(150);
        // The server's notices (.dizque-toast) come and go on their own: wait them out, as a
        // person would. Anything else on top of the control fails.
        let at;
        for (let tries = 0; tries < 60; tries++) {
            at = await handle.evaluate((el) => {
                const r = el.getBoundingClientRect();
                const x = r.left + r.width / 2;
                const y = r.top + r.height / 2;
                const top = document.elementFromPoint(x, y);
                const covered = (top === el || el.contains(top)) ? null
                    : (top ? `${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/).slice(0, 4).join('.')}` : 'nothing (off the page)');
                return { x, y, covered, toast: !!(top && top.closest('.dizque-toast')), disabled: !!el.disabled };
            });
            if (!at.toast) {
                break;
            }
            await sleep(250);
        }
        if (at.disabled) {
            throw new Check(`${what} is disabled`);
        }
        if (at.covered !== null) {
            throw new Check(`${what} can't be clicked: ${at.covered} covers it`);
        }
        await page.mouse.click(at.x, at.y);
    };
    const clickText = async (selector, text, what, timeout) => click(await find(selector, text, what, timeout), what);

    const editorShowing = () => page.evaluate(() => [...document.querySelectorAll('.modal-footer button')]
        .some((b) => /^(Update Channel|Add Channel)$/.test(b.textContent.trim()) && b.getClientRects().length > 0));
    const firstOpenShowing = () => page.evaluate(() => [...document.querySelectorAll('.modal-title')]
        .some((t) => /kept where they sit/.test(t.textContent) && t.getClientRects().length > 0));
    const lastChange = () => page.evaluate(() => {
        const el = document.querySelector('.programming-head .text-info');
        return el ? el.textContent.trim() : '';
    });
    // The title of a dialog open over the editor, or null.
    const modalOpen = () => page.evaluate(() => {
        const t = [...document.querySelectorAll('.modal-title')].filter((x) => x.getClientRects().length > 0).map((x) => x.textContent.trim())
            .filter((x) => !/^\d+ - /.test(x));
        return t.length > 0 ? t.join(' / ') : null;
    });
    // What the Time Slots dialog says about kept rows: at most one short line of its own, or it
    // fails. A special day's row has its own line for the kept rows inside that day (Special days,
    // Oct 31); those are not the dialog's line, so they aren't counted, but each must still be short.
    const dialogNotes = async () => {
        const all = await page.evaluate(() => [...document.querySelectorAll('.modal-body .small, .modal-body .alert')]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => ({ text: el.textContent.replace(/\s+/g, ' ').trim(), day: el.closest('[ng-repeat^="day in schedule.specialDays"]') !== null }))
            .filter((x) => x.text && /kept|keeps|stays where|stay where|runs .* longer|will push/i.test(x.text)));
        const notes = all.filter((x) => !x.day).map((x) => x.text).filter((x, i, a) => a.indexOf(x) === i);
        const dayNotes = all.filter((x) => x.day).map((x) => x.text);
        const wordy = (x) => x.length > 100 || /runs .* longer|will push|kept in time/i.test(x);
        if (notes.length > 1 || notes.some(wordy)) {
            throw new Check(`the Time Slots dialog says more than one short line about kept rows: ${notes.map((x) => `"${x.slice(0, 120)}"`).join(' ')}`);
        }
        if (dayNotes.some(wordy)) {
            throw new Check(`a special day's kept-rows line isn't one short line: ${dayNotes.filter(wordy).map((x) => `"${x.slice(0, 120)}"`).join(' ')}`);
        }
        return notes;
    };
    const footerButton = (name) => find('.modal-footer button', name, `the editor's ${name}`);

    const openEditor = async () => {
        await page.goto(opts.url + '/#!/channels', { waitUntil: 'networkidle2' });
        await page.reload({ waitUntil: 'networkidle2' });
        const cell = await page.waitForFunction((n) => {
            const row = [...document.querySelectorAll('tr.channel-row')].find((r) => r.cells[0] && r.cells[0].textContent.trim() === String(n));
            return row ? row.cells[2] : null;
        }, { timeout: 30000 }, opts.channel).catch(() => null);
        if (cell === null) {
            throw new Check(`channel ${opts.channel} isn't on the Channels page`);
        }
        await click(cell.asElement(), `channel ${opts.channel} on the Channels page`);
        const opened = await page.waitForFunction(() => document.querySelector('#channelConfigProgramList .psr-row') !== null,
            { timeout: 120000, polling: 500 }).catch(() => null);
        if (opened === null) {
            throw new Check(`channel ${opts.channel}'s editor didn't open with its list`);
        }
        await sleep(1500);
        // The old first-open dialog is gone for good (NOTES.md, "What you see is what
        // airs"): hand edits from before kept rows are kept the moment the list is read,
        // never asked about.
        if (await firstOpenShowing()) {
            throw new Check('the first-open list showed: it should be kept silently now, never asked');
        }
    };
    const closeWith = async (name) => {
        await click(await footerButton(name), `the editor's ${name}`);
        for (let i = 0; i < 100 && (await editorShowing()); i++) {
            await sleep(300);
        }
        if (await editorShowing()) {
            throw new Check(`the editor stayed open after ${name}`);
        }
        if (name === 'Update Channel') {
            // the channel's save, sent as the editor closes, finished
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 120000 }).catch(() => {});
        }
    };

    // Each row of the list from now on for `days`: its instant, what it is, and its mark.
    const airings = (channel, days) => {
        const now = Date.now();
        const total = channel.programs.reduce((a, p) => a + p.duration, 0);
        let t = new Date(channel.startTime).getTime();
        const out = [];
        for (let k = 0; t < now + days * DAY && k < 3 * channel.programs.length; k++) {
            const p = channel.programs[k % channel.programs.length];
            if (t + p.duration > now) {
                // Tab-separated: a title can hold a "|" ("Babar | Babar's First Step: Ep. 1").
                out.push(`${t}\t${p.isOffline ? 'Flex' : (p.showTitle || '') + ' ' + p.title}\t${p.duration}\t${p.kept ? JSON.stringify(p.kept) : ''}`);
            }
            t += p.duration;
            if (total <= 0) break;
        }
        return out;
    };
    const keptCount = (channel) => channel.programs.filter((p) => p.kept).length;
    const sameAirings = (a, b, what) => {
        const i = a.findIndex((x, k) => x !== b[k]);
        if (i !== -1 || a.length !== b.length) {
            throw new Check(`${what}: the lineup changed, first at ${i === -1 ? 'its end' : new Date(parseInt(a[i], 10)).toLocaleString()} (${a[i]} -> ${b[i]})`);
        }
    };

    // A real HTML5 drag: Chrome's own drag session, started by the mouse and carried through
    // dragenter, dragover and drop (CDP drag interception, as test/drag-vs-repeat-lockup.js
    // does). Bounded: a drag that never starts or never lands fails instead of hanging.
    const realDrag = async (start, target, what) => {
        const steps = (async () => {
            const data = await page.mouse.drag(start, target);
            await page.mouse.dragEnter(target, data);
            await page.mouse.dragOver(target, data);
            await page.mouse.drop(target, data);
            await page.mouse.up();
            return 'done';
        })();
        const got = await Promise.race([steps, sleep(20000).then(() => 'timed out')]);
        if (got !== 'done') {
            await page.mouse.up().catch(() => {});
            throw new Check(`${what}: the drag didn't finish in 20 seconds`);
        }
    };

    // The editor's rows in view, read from the page.
    const rowsInView = () => page.evaluate(() => [...document.querySelectorAll('#channelConfigProgramList .psr-row')].map((r, k) => ({
        k,
        start: (r.querySelector('.psr-start') || {}).textContent,
        show: ((r.querySelector('.psr-show') || {}).textContent || '').trim(),
        flex: !r.querySelector('.psr-show'),
        // The row's length as shown (m:ss or h:mm:ss), in seconds.
        secs: ((((r.querySelector('.psr-duration') || {}).textContent || '').match(/\d+(:\d+)+/) || [ '0' ])[0]).split(':').reduce((a, n) => a * 60 + parseInt(n, 10), 0),
        kept: !!r.querySelector('.fa-thumbtack, .fa-clock'),
        canSwap: !!r.querySelector('button[title="Swap..."]'),
        top: r.getBoundingClientRect().top,
    })));
    const rowHandle = async (k) => (await page.$$('#channelConfigProgramList .psr-row'))[k];
    // A plain episode row a little way into the list, clear of the airing on air, with
    // `after` more plain rows below it in view. When the screen is all kept edits, the list
    // scrolls on a screen at a time until there is one.
    // `needs(all, row)` narrows it further, e.g. to a row with a Flex row right above it.
    const plainRow = async (skip, after = 0, needs = null) => {
        for (let screen = 0; screen < 80; screen++) {
            const box = await page.evaluate(() => {
                const r = document.getElementById('channelConfigProgramList').getBoundingClientRect();
                return { top: r.top, bottom: r.bottom };
            });
            const all = await rowsInView();
            const rows = all.filter((r) => r.canSwap && !r.kept && !r.flex && r.top >= box.top && r.top <= box.bottom - 40 && (needs === null || needs(all, r)));
            if (rows.length > skip + after) {
                return rows[skip];
            }
            const first = (await rowsInView())[0];
            const moved = await page.evaluate(() => {
                const el = document.getElementById('channelConfigProgramList');
                const was = el.scrollTop;
                el.scrollTop = was + Math.floor(el.clientHeight * 0.8);
                return el.scrollTop !== was;
            });
            if (!moved) {
                break;
            }
            // vs-repeat draws the rows for the new place
            await page.waitForFunction((start) => {
                const r = document.querySelector('#channelConfigProgramList .psr-row .psr-start');
                return r !== null && r.textContent !== start;
            }, { timeout: 10000, polling: 100 }, first ? first.start : '').catch(() => {});
        }
        throw new Check('no plain episode row in the list to use');
    };

    // Swap a plain episode a little way in for the first episode of its show that fits.
    const swapOne = async (after = 0) => {
        const row = await plainRow(2, after);
        await click(await (await rowHandle(row.k)).$('button[title="Swap..."]'), `${row.show} at ${row.start}'s Swap`);
        const fits = await page.waitForFunction(() => [...document.querySelectorAll('.modal .list-group button.list-group-item')]
            .find((b) => b.getClientRects().length > 0 && /fits/.test(b.textContent) && !b.querySelector('.text-success.ng-hide')) || null,
            { timeout: 60000, polling: 500 }).catch(() => null);
        if (fits === null) {
            throw new Check(`no episode of ${row.show} fits to swap in`);
        }
        await click(fits.asElement(), 'an episode that fits');
        await click(await find('.modal .card-body button.btn-primary', null, 'the swap\'s apply'), 'the swap\'s apply');
        await sleep(1000);
        const text = await lastChange();
        const swapped = (await rowsInView()).find((r) => r.start === row.start);
        if (!swapped || !swapped.kept) {
            throw new Check(`the swapped row at ${row.start} isn't marked kept`);
        }
        return { row, text };
    };

    // The library's add of opts.show "at the end of list", from the editor open on the
    // Programming tab: how many episodes it added, and the choice it showed.
    const addShowAtEnd = async () => {
        await click(await find('button[ng-click="showPlexLibrary()"]', null, 'the library button (+)'), 'the library button (+)');
        // The library dialog: the Plex origin's libraries, the show filtered, its plus.
        const choice = await page.waitForFunction(() => {
            const s = document.getElementById('position-selector');
            return (s && s.getClientRects().length > 0 && s.selectedIndex !== -1) ? s.options[s.selectedIndex].textContent.trim() : null;
        }, { timeout: 30000, polling: 300 }).catch(() => null);
        if (choice === null) {
            throw new Check('the library\'s position choice didn\'t show');
        }
        const choiceText = await choice.jsonValue();
        if (!/end of list/.test(choiceText)) {
            throw new Check(`the library's choice is "${choiceText}", not the end of the list`);
        }
        const libraries = await page.waitForFunction(() => {
            const items = [...document.querySelectorAll('.plex-panel > li.list-group-item')].filter((li) => li.getClientRects().length > 0);
            return items.length > 0 ? items.length : null;
        }, { timeout: 60000, polling: 500 }).catch(() => null);
        if (libraries === null) {
            throw new Check('the library showed no Plex libraries');
        }
        // Which library holds the show, asked of Plex itself, so only that one is opened.
        let library = null;
        for (const server of await api('/api/plex-servers')) {
            const plex = (path) => fetch(server.uri + path, { headers: { 'X-Plex-Token': server.accessToken, Accept: 'application/json' } }).then((r) => r.json());
            for (const d of (await plex('/library/sections')).MediaContainer.Directory.filter((x) => x.type === 'show')) {
                const found = (await plex(`/library/sections/${d.key}/all?title=${encodeURIComponent(opts.show)}`)).MediaContainer.Metadata || [];
                if (found.some((m) => m.title === opts.show)) {
                    library = d.title;
                    break;
                }
            }
            if (library !== null) {
                break;
            }
        }
        if (library === null) {
            throw new Check(`${opts.show} isn't a show in any Plex library`);
        }
        const head = await page.waitForFunction((name) => [...document.querySelectorAll('.plex-panel > li.list-group-item > div.library-item-hover')]
            .find((d) => d.textContent.trim() === name) || null, { timeout: 30000, polling: 500 }, library).catch(() => null);
        if (head === null) {
            throw new Check(`the ${library} library isn't in the library dialog (${await libraries.jsonValue()} shown)`);
        }
        await click(head.asElement(), `the ${library} library`);
        const showRow = await page.waitForFunction((title) => [...document.querySelectorAll('.plex-panel li.list-group-item-secondary > div.library-item-hover')]
            .find((d) => { const t = d.textContent.trim(); return t === title || t.startsWith(`${title} (`); }) || null,
            { timeout: 90000, polling: 500 }, opts.show).catch(() => null);
        if (showRow === null) {
            throw new Check(`${opts.show} didn't show in the ${library} library`);
        }
        const plus = await showRow.asElement().$('span.flex-pull-right');
        await click(plus, `${opts.show}'s plus`);
        // How many are picked, once the library has finished reading them (it shows the last 10).
        const pickedCount = () => page.evaluate(() => {
            const total = [...document.querySelectorAll('.text-info.small')]
                .find((d) => /elements added in total/.test(d.textContent) && d.getClientRects().length > 0);
            return total ? parseInt(total.textContent.trim(), 10)
                : document.querySelectorAll('button[ng-click="selection.splice(selection.length + x,1)"]').length;
        });
        let n = null;
        for (let i = 0, last = -1, steady = 0; i < 120 && steady < 6; i++) {
            await sleep(500);
            n = await pickedCount();
            steady = (n !== null && n > 0 && n === last) ? steady + 1 : 0;
            last = n;
        }
        if (!(n > 0)) {
            throw new Check(`${opts.show}'s episodes weren't picked`);
        }
        await clickText('.modal-footer button', 'Done', 'the library\'s Done');
        await sleep(1500);
        return { n, choiceText };
    };

    const workflows = {
        'first-open-silent': async () => {
            await openEditor();
            const kept = (await rowsInView()).filter((r) => r.kept);
            if (kept.length === 0) {
                return 'nothing to keep: this channel\'s list has nothing from before kept rows';
            }
            const said = await lastChange();
            if (said) {
                throw new Check(`kept silently was meant to say nothing, and said "${said}"`);
            }
            await closeWith('Update Channel');
            const saved = await api(`/api/channel/${opts.channel}`);
            if (typeof saved.handEditsKept !== 'string') {
                throw new Check('Update Channel didn\'t save the silent first open (handEditsKept)');
            }
            return `${kept.length} row(s) in view kept at once, nothing asked, nothing said; Update Channel saved it`;
        },
        'open-cancel': async () => {
            await openEditor();
            await closeWith('Cancel');
            return 'opened, Cancel closed it';
        },
        'open-update': async () => {
            const before = await api(`/api/channel/${opts.channel}`);
            await openEditor();
            await closeWith('Update Channel');
            const after = await api(`/api/channel/${opts.channel}`);
            sameAirings(airings(before, 14), airings(after, 14), 'Update Channel with nothing changed');
            return `opened, Update Channel saved; ${after.programs.length} entries, the next 14 days as they were`;
        },
        'library-add': async () => {
            const before = await api(`/api/channel/${opts.channel}`);
            await openEditor();
            const keptInView = async () => (await rowsInView()).filter((r) => r.kept).length;
            const keptBefore = await keptInView();
            // The library opened and cancelled first: nothing added, nothing said.
            const saidBefore = await lastChange();
            await click(await find('button[ng-click="showPlexLibrary()"]', null, 'the library button (+)'), 'the library button (+)');
            await clickText('.modal-footer button[ng-click="_onFinish([])"]', 'Cancel', 'the library\'s Cancel');
            await sleep(800);
            if ((await lastChange()) !== saidBefore) {
                throw new Check(`the library's Cancel said "${await lastChange()}"`);
            }
            const { n, choiceText } = await addShowAtEnd();
            const said = await lastChange();
            const keptNow = await keptInView();
            if (keptNow > keptBefore) {
                throw new Check(`the add went into the lineup: ${keptNow - keptBefore} rows in view became kept ("${said.slice(0, 160)}...")`);
            }
            await closeWith('Update Channel');
            const after = await api(`/api/channel/${opts.channel}`);
            sameAirings(airings(before, 14), airings(after, 14).slice(0, airings(before, 14).length), `adding ${opts.show} at the end`);
            if (after.programs.length !== before.programs.length + n) {
                throw new Check(`${n} picked, but the channel went from ${before.programs.length} to ${after.programs.length} entries`);
            }
            if (keptCount(after) !== keptCount(before)) {
                throw new Check(`kept rows went from ${keptCount(before)} to ${keptCount(after)}`);
            }
            const tail = after.programs.slice(-n).filter((p) => p.showTitle === opts.show || p.title).length;
            return `"${choiceText}": ${n} episodes of ${opts.show} joined the channel (${tail} at the end of the list); "${said}"; the next 14 days and the kept rows as they were`;
        },
        'delete': async () => {
            await openEditor();
            const row = await plainRow(3);
            // Row by row: a kept row that only scrolls into view once the list is one shorter is not Delete's.
            const others = (await rowsInView()).filter((r) => r.k !== row.k);
            await click(await (await rowHandle(row.k)).$('button[title="Delete..."]'), `${row.show} at ${row.start}'s Delete`);
            await sleep(800);
            if (await modalOpen()) {
                throw new Check(`Delete asked something: "${await modalOpen()}"`);
            }
            const after = await rowsInView();
            if (after.some((r) => r.start === row.start && r.show === row.show)) {
                throw new Check(`${row.show} at ${row.start} is still in the list after Delete`);
            }
            const marked = others.filter((r, i) => after[i] && after[i].show === r.show && after[i].kept && ! r.kept);
            if (marked.length > 0) {
                throw new Check(`Delete marked rows as kept: ${marked.map((r) => `${r.show} at ${r.start}`).join(', ')}`);
            }
            const scrolledIn = after.slice(others.length).filter((r) => r.kept).length;
            const said = await lastChange();
            await closeWith('Cancel');
            return `${row.show} at ${row.start} went at once, nothing asked, nothing kept${scrolledIn ? ` (${scrolledIn} kept row(s) scrolled into view)` : ''}${said ? `; "${said}"` : ', nothing said'}; Cancel dropped it`;
        },
        'add-delete-create': async () => {
            // DarkManX16, Oct 30: add a show at the end of the list, delete five of its episodes,
            // see them go, then Create Lineup.
            const before = await api(`/api/channel/${opts.channel}`);
            const neverBefore = (await api(`/api/channel/${opts.channel}/catalog`)).neverAir || {};
            await openEditor();
            const { n } = await addShowAtEnd();
            const rowText = (k) => rowHandle(k).then((h) => h.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim()));
            const gone = [];
            const sentences = [];
            let handPlaced = 0;
            const keptRows = require('../src/kept-rows');
            for (let i = 0; i < 5; i++) {
                await page.evaluate(() => document.getElementById('channelConfigProgramList').scrollTo(0, 1e9));
                await sleep(800);
                const box = await page.evaluate(() => {
                    const r = document.getElementById('channelConfigProgramList').getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom };
                });
                const mine = (await rowsInView()).filter((r) => r.show.startsWith(opts.show) && !r.kept && r.top >= box.top && r.top <= box.bottom - 30);
                if (mine.length < 2) {
                    throw new Check(`no ${opts.show} row in view at the end of the list to delete`);
                }
                const row = mine[mine.length - 2];
                const text = await rowText(row.k);
                await click(await (await rowHandle(row.k)).$('button[title="Delete..."]'), `"${text.slice(0, 60)}"'s Delete`);
                await sleep(800);
                if (await modalOpen()) {
                    throw new Check(`Delete asked something: "${await modalOpen()}"`);
                }
                const still = await page.evaluate((t) => [...document.querySelectorAll('#channelConfigProgramList .psr-row')]
                    .some((r) => r.textContent.replace(/\s+/g, ' ').trim() === t), text);
                if (still) {
                    throw new Check(`"${text.slice(0, 60)}" is still in the list after Delete`);
                }
                const title = (/ E\d+ (.*?) [\d:]+$/.exec(text) || [])[1] || text;
                gone.push(title);
                // Delete's one sentence: a swap or insert of the episode DarkManX16 placed himself still
                // airs, and is named; nothing is said otherwise (DarkManX16, Nov 12).
                const program = before.programs.find((p) => !p.isOffline && p.showTitle === opts.show && p.title === title);
                const placed = program ? keptRows.handPlacedAhead({ lineup: { programs: before.programs, startTime: new Date(before.startTime).getTime() },
                    program, now: Date.now(), schedule: before.scheduleBackup, same: require('../src/show-catalog').sameEpisode(program) }) : [];
                const expected = keptRows.stillAirs(placed);
                const heard = await lastChange();
                if (heard !== expected) {
                    throw new Check(`Delete on "${title}" said "${heard}", not "${expected}"`);
                }
                handPlaced += placed.length;
                if (expected) {
                    sentences.push(expected);
                }
            }
            const said = sentences.join(' / ');
            const timeSlotsShowing = await page.evaluate(() => [...document.querySelectorAll('button[title="Time Slots..."]')].some((b) => b.getClientRects().length > 0));
            if (!timeSlotsShowing) {
                await clickText('button[ng-click="toggleTools()"]', /Tools/, 'Tools');
            }
            await clickText('button[title="Time Slots..."]', /Time Slots\.\.\./, 'Time Slots...');
            await find('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            const notes = await dialogNotes();
            await clickText('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            const closed = await page.waitForFunction(() => ![...document.querySelectorAll('.modal-title')]
                .some((t) => t.textContent.trim() === 'Time Slots' && t.getClientRects().length > 0), { timeout: 300000, polling: 1000 }).catch(() => null);
            if (closed === null) {
                throw new Check('Create Lineup didn\'t finish in 5 minutes');
            }
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 60000 }).catch(() => {});
            await closeWith('Update Channel');
            const after = await api(`/api/channel/${opts.channel}`);
            const neverAir = (await api(`/api/channel/${opts.channel}/catalog`)).neverAir || {};
            const changed = Object.keys(neverBefore).filter((k) => JSON.stringify(neverAir[k]) !== JSON.stringify(neverBefore[k]));
            if (changed.length > 0) {
                throw new Check(`${changed.length} never-air entries already there changed, e.g. ${JSON.stringify(neverAir[changed[0]])}`);
            }
            const added = Object.keys(neverAir).filter((k) => !(k in neverBefore)).map((k) => neverAir[k]);
            const listed = gone.filter((t) => Object.values(neverAir).some((e) => e.title === t));
            if (listed.length !== 5 || added.some((e) => e.how !== 'deleted' || gone.indexOf(e.title) === -1)) {
                throw new Check(`of the 5 deleted (${gone.join(', ')}), ${listed.length} are on the never-air list; added: ${added.map((e) => e.title).join(', ')}`);
            }
            // None of the five airs again - anywhere on the channel, to the lineup's end - except
            // where DarkManX16 placed that very airing himself (his swaps and inserts, in the list or
            // inside a special day, and a day's picked item), which Delete named above.
            const back = [];
            let stay = 0;
            let t = new Date(after.startTime).getTime();
            for (const p of after.programs) {
                const start = t;
                t += p.duration;
                if (p.isOffline || start + p.duration <= Date.now() || p.showTitle !== opts.show || gone.indexOf(p.title) === -1) {
                    continue;
                }
                if (keptRows.handPlaced(p, after.scheduleBackup) !== null) {
                    stay++;
                } else {
                    back.push(`${new Date(start).toLocaleString()} ${p.title}`);
                }
            }
            if (back.length > 0) {
                throw new Check(`${back.length} airings of deleted episodes are still in the lineup, e.g. ${back[0]}`);
            }
            if (stay !== handPlaced) {
                throw new Check(`Delete named ${handPlaced} of DarkManX16's own swaps and inserts still ahead, but ${stay} air`);
            }
            if (keptCount(after) > keptCount(before)) {
                throw new Check(`kept rows went from ${keptCount(before)} to ${keptCount(after)}`);
            }
            // What the add marks at the end of the list (pins.asAired) never reaches the saved lineup.
            const marked = after.programs.filter((p) => p && Object.prototype.hasOwnProperty.call(p, 'addedAt'));
            if (marked.length > 0) {
                throw new Check(`${marked.length} saved rows still carry the add mark after Create Lineup, e.g. ${marked[0].title}`);
            }
            return `${n} episodes of ${opts.show} added; 5 deleted, each gone from the list at once with nothing asked (${gone.join('; ')})`
                + `${said ? `, said "${said}"` : ', nothing said'}; the Time Slots dialog said ${notes.length === 0 ? 'nothing about kept rows' : `"${notes[0]}"`}; `
                + `Create Lineup and Update Channel saved ${after.programs.length} entries, none of the 5 anywhere in the lineup`
                + `${stay ? ` but the ${stay} DarkManX16 placed by hand` : ''}; all 5 on the never-air list (${added.length} added, ${5 - added.length} already there, left as they were); kept rows ${keptCount(before)} -> ${keptCount(after)}`;
        },
        'swap-drag-put-back': async () => {
            await openEditor();
            const said = [];
            // with plain rows after it to drag
            const { row, text } = await swapOne(4);
            said.push(text);
            // Drag: a plain row dropped a few rows further on.
            // Both rows inside the list's visible part (vs-repeat also draws rows past it).
            const box = await page.evaluate(() => {
                const r = document.getElementById('channelConfigProgramList').getBoundingClientRect();
                return { top: r.top, bottom: r.bottom };
            });
            const shown = (await rowsInView()).filter((r) => r.top >= box.top && r.top <= box.bottom - 40);
            // A row after the swap: dragged from before it, the swap would sit between
            // the two places and shift with the playlist, and Put back below finds the
            // swap by where it sits.
            const swapAt = shown.findIndex((r) => r.start === row.start);
            const from = shown.find((r, i) => i >= 1 && i > swapAt && i <= shown.length - 4 && r.canSwap && !r.kept);
            if (!from) {
                throw new Check('no plain row in view to drag');
            }
            const onto = shown[Math.min(shown.indexOf(from) + 3, shown.length - 1)];
            const fromBox = await (await rowHandle(from.k)).boundingBox();
            const ontoBox = await (await rowHandle(onto.k)).boundingBox();
            const start = { x: fromBox.x + 40, y: fromBox.y + fromBox.height / 2 };
            const target = { x: ontoBox.x + 40, y: ontoBox.y + ontoBox.height * 0.75 };
            await realDrag(start, target, `dragging ${from.show} at ${from.start}`);
            await sleep(1000);
            const asked = await page.evaluate(() => [...document.querySelectorAll('.modal-title')].some((t) => /Move/.test(t.textContent) && t.getClientRects().length > 0));
            if (asked) {
                await clickText('.modal-footer button', 'Move it', 'the drag\'s Move it');
                await sleep(800);
            }
            said.push(await lastChange());
            const moved = (await rowsInView()).filter((r) => r.kept && r.show === from.show);
            if (moved.length === 0) {
                throw new Check(`the dragged ${from.show} row isn't marked kept`);
            }
            // Put back the swap, found by where it sits - not by its show, which swapping
            // changed: `row.show` is the airing's name from before swapOne() replaced it, so a
            // row.show match never finds anything once the swap has landed.
            const again = (await rowsInView()).find((r) => r.kept && r.start === row.start && r.canSwap);
            const back = await (await rowHandle(again.k)).$('button[title="Put back..."]');
            if (!back) {
                throw new Check(`the swapped ${row.show} row has no Put back`);
            }
            await click(back, `${row.show}'s Put back`);
            await clickText('.modal-footer button.btn-primary', 'Put it back', 'Put back\'s confirm');
            await sleep(1000);
            said.push(await lastChange());
            await closeWith('Cancel');
            return said.map((s) => `"${s}"`).join(' / ') + '; Cancel dropped them';
        },
        'insert-before': async () => {
            // DarkManX16, Nov 6: a clip goes right before an airing, after the break in front of it -
            // that break shrinks by the clip and nothing else moves - and a clip dropped between
            // a Flex and the airing after it sits there. Real clicks and a real drag; the lineup
            // is read from the editor's scope, so nothing is saved: Cancel at the end.
            const snap = () => page.evaluate(() => {
                const s = angular.element(document.getElementById('channelConfigProgramList')).scope();
                return { startTime: new Date(s.channel.startTime).getTime(), rows: s.channel.programs.map((p) => ({ d: p.duration, o: !!p.isOffline, t: p.title || '', kept: p.kept ? JSON.stringify(p.kept) : '' })) };
            });
            const airs = (s) => {
                let t = new Date(s.startTime).getTime();
                const out = [];
                for (const r of s.rows) {
                    if (!r.o) out.push(`${t}|${r.t}`);
                    t += r.d;
                }
                return out;
            };
            const startOf = (s, i) => s.rows.slice(0, i).reduce((t, r) => t + r.d, new Date(s.startTime).getTime());
            const total = (s) => s.rows.reduce((a, r) => a + r.d, 0);
            const sameList = (a, b, what) => {
                if (JSON.stringify(a.rows) !== JSON.stringify(b.rows)) {
                    const i = a.rows.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(b.rows[k]));
                    throw new Check(`${what}: the list isn't as it was, first at entry ${i} (${a.rows.length} entries -> ${b.rows.length})`);
                }
            };
            // The edit ids a list holds, to tell which row an edit just added.
            const idsOf = (s) => new Set(s.rows.flatMap((r) => (r.kept ? JSON.parse(r.kept).edits.map((e) => e.id) : [])));
            const newest = (before, after) => {
                const had = idsOf(before);
                const i = after.rows.findIndex((r) => r.kept && JSON.parse(r.kept).edits.some((e) => !had.has(e.id)));
                if (i === -1) throw new Check('no row carries the edit just made');
                return i;
            };
            const waitTitle = async (re, what) => {
                const ok = await page.waitForFunction((src) => [...document.querySelectorAll('.modal-title')]
                    .some((t) => new RegExp(src).test(t.textContent.trim()) && t.getClientRects().length > 0), { timeout: 15000, polling: 200 }, re.source).catch(() => null);
                if (ok === null) throw new Check(`${what} didn't open`);
            };
            // A clip from a custom show, in the dialog that is open: the first one that fits.
            const pickClip = async () => {
                // The dialog reads the row's own show first; switching while it is still reading
                // lets that answer land over the one asked for.
                await page.waitForFunction(() => ![...document.querySelectorAll('.modal .small.text-muted')]
                    .some((e) => /Reading/.test(e.textContent) && e.getClientRects().length > 0), { timeout: 120000, polling: 300 }).catch(() => {});
                await sleep(500);
                await clickText('.modal .btn-group button', 'Custom shows', 'Custom shows');
                const chose = await page.waitForFunction((name) => {
                    const sel = document.querySelector('.modal select[ng-model="pick.custom"]');
                    const opt = sel && [...sel.options].find((o) => o.textContent.trim() === name);
                    if (!opt) return null;
                    sel.value = opt.value;
                    angular.element(sel).triggerHandler('change');
                    return true;
                }, { timeout: 30000, polling: 300 }, 'Looney Tunes').catch(() => null);
                if (chose === null) throw new Check('the Looney Tunes custom show isn\'t offered');
                // One that fits with seconds to spare: the dialog's "fits" allows a few seconds over,
                // which an insert after takes by running the rows after it late.
                const fits = await page.waitForFunction(() => {
                    const title = [...document.querySelectorAll('.modal-title')].find((t) => t.getClientRects().length > 0 && /of Flex/.test(t.textContent));
                    const m = /(\d+):(\d+) of Flex/.exec(title ? title.textContent : '');
                    const room = m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0;
                    return [...document.querySelectorAll('.modal .list-group button.list-group-item')].find((b) => {
                        const len = /(\d+):(\d+)/.exec((b.querySelector('.float-right') || b).textContent);
                        return b.getClientRects().length > 0 && /fits/.test(b.textContent) && !b.querySelector('.text-success.ng-hide')
                            && len && (parseInt(len[1], 10) * 60 + parseInt(len[2], 10)) <= room - 10;
                    }) || null;
                }, { timeout: 60000, polling: 500 }).catch(() => null);
                if (fits === null) throw new Check('no clip of Looney Tunes fits the break with seconds to spare');
                const label = await fits.evaluate((b) => b.querySelector('span').textContent.trim());
                await click(fits.asElement(), 'a clip that fits');
                const said = await page.waitForFunction(() => {
                    const c = [...document.querySelectorAll('.modal .card-body')].find((x) => x.getClientRects().length > 0);
                    return c ? c.querySelector('.small').textContent.trim() : null;
                }, { timeout: 15000, polling: 200 }).catch(() => null);
                if (said === null) throw new Check('the dialog offered no Insert');
                await click(await find('.modal .card-body button.btn-primary', null, 'the Insert button'), 'the Insert button');
                await sleep(800);
                return { label, said: await said.jsonValue() };
            };
            const putBackRow = async (title) => {
                const k = await page.evaluate((t) => [...document.querySelectorAll('#channelConfigProgramList .psr-row')]
                    .findIndex((r) => r.textContent.includes(t)), title);
                if (k === -1) throw new Check(`${title} isn't in view to Put back`);
                await click(await (await rowHandle(k)).$('button[title="Put back..."]'), `${title}'s Put back`);
                await clickText('.modal-footer button.btn-primary', 'Put it back', 'Put back\'s confirm');
                await sleep(1000);
            };
            const sayings = [];

            await openEditor();
            const start = await snap();

            // A: Insert before, on an airing with a Flex right above it.
            // The clips are about 6 to 8 minutes: a Flex of 8:30 or more above the airing holds one.
            const roomy = (all, k) => all[k].flex && all[k].secs >= 510;
            const target = await plainRow(1, 0, (all, r) => r.k > 0 && roomy(all, r.k - 1));
            await click(await (await rowHandle(target.k)).$('button[title="Insert before..."]'), `${target.show} at ${target.start}'s Insert before`);
            await waitTitle(/^Insert before/, 'the Insert before dialog');
            const clipA = await pickClip();
            const said = await lastChange();
            sayings.push(said);
            if (!/goes in right before .* at .*; the break before it is .* now\.$/.test(said)) {
                throw new Check(`Insert before said "${said}"`);
            }
            const afterA = await snap();
            const iA = newest(start, afterA);
            const clipDur = afterA.rows[iA].d;
            const clipEntry = `${startOf(afterA, iA)}|${afterA.rows[iA].t}`;
            const wasAirs = airs(start);
            const nowAirs = airs(afterA).filter((a) => a !== clipEntry);
            if (nowAirs.join() !== wasAirs.join()) {
                const d = wasAirs.findIndex((a, k) => a !== nowAirs[k]);
                throw new Check(`Insert before moved an airing: ${wasAirs.length} airings -> ${nowAirs.length} without the clip; first difference at ${d}: "${wasAirs[d]}" -> "${nowAirs[d]}"; the clip row ${iA} is "${clipEntry}", kept ${afterA.rows[iA].kept.slice(0, 120)}`);
            }
            if (!afterA.rows[iA - 1].o || startOf(afterA, iA) + clipDur !== startOf(afterA, iA + 1) || afterA.rows[iA + 1].o) {
                throw new Check('the clip isn\'t right against the airing after the break before it');
            }
            if (total(afterA) !== total(start)) {
                throw new Check(`the list's length changed by ${(total(afterA) - total(start)) / 1000}s`);
            }
            if (!JSON.parse(afterA.rows[iA].kept).edits.some((e) => e.kind === 'insert')) {
                throw new Check('the clip isn\'t kept as an insert');
            }
            if (!(await rowsInView()).some((r) => r.kept)) {
                throw new Check('no row in view shows the kept mark');
            }
            await putBackRow(afterA.rows[iA].t);
            sameList(await snap(), start, 'Put back of Insert before');

            // B: Insert after puts a clip ahead of the break; dropped just before the airing it lands there.
            const target2 = await plainRow(1, 0, (all, r) => r.k > 1 && roomy(all, r.k - 1) && !all[r.k - 2].flex && all[r.k - 2].canSwap);
            const prevRow = (await rowsInView())[target2.k - 2];
            await click(await (await rowHandle(prevRow.k)).$('button[title="Insert after..."]'), `${prevRow.show} at ${prevRow.start}'s Insert after`);
            await waitTitle(/^Insert after/, 'the Insert after dialog');
            const clipB = await pickClip();
            sayings.push(await lastChange());
            const afterB = await snap();
            const iB = newest(start, afterB);
            if (afterB.rows[iB - 1].o || !afterB.rows[iB + 1].o) {
                throw new Check('Insert after didn\'t put the clip in the break after the airing, ahead of its Flex');
            }
            const clipTitle = afterB.rows[iB].t;
            const rowsB = await page.evaluate((t) => [...document.querySelectorAll('#channelConfigProgramList .psr-row')]
                .map((r, k) => ({ k, has: r.textContent.includes(t) })), clipTitle);
            const c = rowsB.find((r) => r.has);
            if (!c) throw new Check('the inserted clip isn\'t in view');
            const clipBox = await (await rowHandle(c.k)).boundingBox();
            const airingBox = await (await rowHandle(c.k + 2)).boundingBox();
            // the upper quarter of the airing after the Flex: between that Flex and the airing
            await realDrag({ x: clipBox.x + 40, y: clipBox.y + clipBox.height / 2 }, { x: airingBox.x + 40, y: airingBox.y + airingBox.height * 0.25 },
                `dragging the clip to just before the airing`);
            await sleep(1000);
            const dragSaid = await lastChange();
            sayings.push(dragSaid);
            const afterDrag = await snap();
            const iD = afterDrag.rows.findIndex((r) => r.t === clipTitle);
            if (!/moves past its .* of Flex, to .*; nothing else moves\.$/.test(dragSaid)) {
                throw new Check(`the drag said "${dragSaid}"`);
            }
            if (!afterDrag.rows[iD - 1].o || afterDrag.rows[iD + 1].o || startOf(afterDrag, iD) + afterDrag.rows[iD].d !== startOf(afterDrag, iD + 1)) {
                throw new Check('the clip isn\'t between the Flex and the airing after it');
            }
            const noClip = (s) => airs(s).filter((a) => !a.endsWith(`|${clipTitle}`));
            if (noClip(afterDrag).join() !== noClip(afterB).join() || total(afterDrag) !== total(afterB)) {
                throw new Check('the drop moved an airing');
            }
            await putBackRow(clipTitle);
            sameList(await snap(), afterB, 'Put back of the drop');
            await putBackRow(clipTitle);
            sameList(await snap(), start, 'Put back of Insert after');

            // C: Create Lineup keeps the clip where it sits, against the airing, and the airing at its time.
            const target3 = await plainRow(1, 0, (all, r) => r.k > 0 && roomy(all, r.k - 1));
            await click(await (await rowHandle(target3.k)).$('button[title="Insert before..."]'), `${target3.show} at ${target3.start}'s Insert before`);
            await waitTitle(/^Insert before/, 'the Insert before dialog');
            await pickClip();
            const beforeC = await snap();
            const iC = newest(start, beforeC);
            const idC = JSON.parse(beforeC.rows[iC].kept).edits.find((e) => e.kind === 'insert').id;
            const clipStart = startOf(beforeC, iC);
            const airingC = `${startOf(beforeC, iC + 1)}|${beforeC.rows[iC + 1].t}`;
            const timeSlotsShowing = await page.evaluate(() => [...document.querySelectorAll('button[title="Time Slots..."]')].some((b) => b.getClientRects().length > 0));
            if (!timeSlotsShowing) {
                await clickText('button[ng-click="toggleTools()"]', /Tools/, 'Tools');
            }
            await clickText('button[title="Time Slots..."]', /Time Slots\.\.\./, 'Time Slots...');
            await find('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            await clickText('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            const done = await page.waitForFunction(() => ![...document.querySelectorAll('.modal-title')]
                .some((t) => t.textContent.trim() === 'Time Slots' && t.getClientRects().length > 0), { timeout: 300000, polling: 1000 }).catch(() => null);
            if (done === null) throw new Check('Create Lineup didn\'t finish in 5 minutes');
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 60000 }).catch(() => {});
            const afterC = await snap();
            const jC = afterC.rows.findIndex((r) => r.kept && JSON.parse(r.kept).edits.some((e) => e.id === idC));
            if (jC === -1) throw new Check('Create Lineup lost the clip');
            if (startOf(afterC, jC) !== clipStart || `${startOf(afterC, jC + 1)}|${afterC.rows[jC + 1].t}` !== airingC || afterC.rows[jC + 1].o) {
                throw new Check(`Create Lineup moved the clip or the airing after it: the clip ${clipStart} -> ${startOf(afterC, jC)}, the airing ${airingC} -> ${startOf(afterC, jC + 1)}|${afterC.rows[jC + 1].t}`);
            }
            await closeWith('Cancel');
            return `Insert before ${target.show} at ${target.start}: "${clipA.label}" went in right against it, "${said}" - no airing moved, the list the same length, Put back gave the list back exactly; `
                + `Insert after, then a drop just before ${afterDrag.rows[iD + 1].t}: "${dragSaid}", nothing moved; both Put backs gave the list back exactly; `
                + `a clip put before ${target3.show} at ${target3.start} stayed against it, at the same second, through Create Lineup; Cancel`;
        },
        'create-lineup': async () => {
            const before = await api(`/api/channel/${opts.channel}`);
            await openEditor();
            // A kept row of its own first, so there is one for Create Lineup to keep.
            const swap = await swapOne();
            const swappedIn = (/^(.*) replaces /.exec(swap.text) || [])[1];
            if (!swappedIn) {
                throw new Check(`the swap said "${swap.text}"`);
            }
            const timeSlotsShowing = await page.evaluate(() => [...document.querySelectorAll('button[title="Time Slots..."]')].some((b) => b.getClientRects().length > 0));
            if (!timeSlotsShowing) {
                await clickText('button[ng-click="toggleTools()"]', /Tools/, 'Tools');
            }
            await clickText('button[title="Time Slots..."]', /Time Slots\.\.\./, 'Time Slots...');
            await find('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            const notes = await dialogNotes();
            await clickText('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            // Done when the Time Slots dialog has gone (while it generates, its buttons hide).
            const closed = await page.waitForFunction(() => ![...document.querySelectorAll('.modal-title')]
                .some((t) => t.textContent.trim() === 'Time Slots' && t.getClientRects().length > 0), { timeout: 300000, polling: 1000 }).catch(() => null);
            if (closed === null) {
                throw new Check('Create Lineup didn\'t finish in 5 minutes');
            }
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 60000 }).catch(() => {});
            const said = await lastChange();
            await closeWith('Update Channel');
            const after = await api(`/api/channel/${opts.channel}`);
            const keptBefore = airings(before, 21).filter((a) => a.endsWith('}'));
            const keptAfter = airings(after, 21).filter((a) => a.endsWith('}'));
            const lost = keptBefore.filter((a) => keptAfter.indexOf(a) === -1);
            if (lost.length > 0) {
                throw new Check(`${lost.length} kept rows moved or went: ${lost[0]}`);
            }
            const kept = keptAfter.find((a) => a.split('\t')[1].endsWith(` ${swappedIn}`));
            if (!kept) {
                throw new Check(`the swap (${swappedIn}, at ${swap.row.start}) isn't kept after Create Lineup and Update Channel`);
            }
            return `swapped first: "${swap.text}"; the dialog said ${notes.length ? `"${notes[0]}"` : 'nothing about kept rows'}; Create Lineup ran${said ? `, "${said}"` : ''}; saved ${after.programs.length} entries; `
                + `the swap still kept at ${new Date(parseInt(kept, 10)).toLocaleString()}; ${keptAfter.length} kept rows in the next 3 weeks, every earlier one where it was`;
        },
        'filler': async () => {
            const lists = await api('/api/fillers');
            const target = lists.filter((f) => f.count >= 3)[0];
            if (!target) {
                throw new Check('no filler list with 3 clips to edit');
            }
            const before = await api(`/api/filler/${target.id}`);
            await page.goto(opts.url + '/#!/filler', { waitUntil: 'networkidle2' });
            await page.reload({ waitUntil: 'networkidle2' });
            const row = await page.waitForFunction((name) => [...document.querySelectorAll('tr.filler-row')]
                .find((r) => r.textContent.includes(name)) || null, { timeout: 30000 }, target.name).catch(() => null);
            if (row === null) {
                throw new Check(`${target.name} isn't on the Filler page`);
            }
            // Its name, not the drag handle in the first cell.
            await click((await row.asElement().$$('td'))[1], `${target.name} on the Filler page`);
            const drawn = await page.waitForFunction(() => [...document.querySelectorAll('.lr-row')].filter((r) => r.getClientRects().length > 0).length >= 3,
                { timeout: 30000, polling: 300 }).catch(() => null);
            if (drawn === null) {
                throw new Check(`${target.name}'s clips didn't show`);
            }
            await sleep(800);
            // Drag the first clip below the third.
            const rows = await page.$$('.lr-row');
            const a = await rows[0].boundingBox();
            const b = await rows[2].boundingBox();
            const start = { x: a.x + 30, y: a.y + a.height / 2 };
            const target2 = { x: b.x + 30, y: b.y + b.height * 0.75 };
            await realDrag(start, target2, 'dragging the first clip');
            await sleep(800);
            // Delete the clip now first.
            const trash = await (await page.$$('.lr-row'))[0].$('button[ng-click*="deleteRow"]');
            await click(trash, 'the first clip\'s delete');
            await sleep(500);
            await clickText('.modal-footer button', 'Done', 'the filler list\'s Done');
            const after = await waitForSave(`/api/filler/${target.id}`, (f) => f.content.length === before.content.length - 1);
            const key = (c) => c.key || c.title;
            if (after.content.length !== before.content.length - 1) {
                throw new Check(`${before.content.length} clips, ${after.content.length} after deleting one`);
            }
            if (key(after.content[0]) === key(before.content[0]) || key(after.content[0]) !== key(before.content[2]) && key(after.content[0]) !== key(before.content[1])) {
                throw new Check('the drag didn\'t move the first clip');
            }
            return `${target.name}: the first clip dragged down, one deleted, Done saved ${after.content.length} of ${before.content.length}`;
        },
        'special-day': async () => {
            // Special days (NOTES.md, "Special days"): a day of its own in Time Slots,
            // a block for the day, This item, Create Lineup, Update Channel - and Delete on
            // one of its airings: never air, the day laid again without it (Event tools,
            // feature 4, DarkManX16 Nov 8), then Cancel so nothing is kept. Far enough out (40 days) to stay clear of
            // the other workflows' near-term kept-row checks; cleaned up after itself.
            const openTimeSlots = async () => {
                const timeSlotsShowing = await page.evaluate(() => [...document.querySelectorAll('button[title="Time Slots..."]')].some((b) => b.getClientRects().length > 0));
                if (!timeSlotsShowing) {
                    await clickText('button[ng-click="toggleTools()"]', /Tools/, 'Tools');
                }
                await clickText('button[title="Time Slots..."]', /Time Slots\.\.\./, 'Time Slots...');
                await find('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            };
            const runCreateLineup = async () => {
                await clickText('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
                const closed = await page.waitForFunction(() => ![...document.querySelectorAll('.modal-title')]
                    .some((t) => t.textContent.trim() === 'Time Slots' && t.getClientRects().length > 0), { timeout: 300000, polling: 1000 }).catch(() => null);
                if (closed === null) {
                    throw new Check('Create Lineup didn\'t finish in 5 minutes');
                }
                await page.waitForNetworkIdle({ idleTime: 500, timeout: 60000 }).catch(() => {});
            };

            await openEditor();
            await openTimeSlots();
            const hasSpecialDays = await page.evaluate(() => [...document.querySelectorAll('.modal-body button')]
                .some((b) => b.textContent.trim() === '+ Add special day'));
            if (!hasSpecialDays) {
                // footerButton/closeWith aren't scoped to one modal, and the channel
                // editor's own Cancel sits in the DOM too (stacked underneath): find the
                // Time Slots dialog's own Cancel specifically.
                const cancelHandle = await page.evaluateHandle(() => {
                    const modal = [...document.querySelectorAll('.modal')].find((m) => {
                        const t = m.querySelector('.modal-title');
                        return t && t.textContent.trim() === 'Time Slots' && m.getClientRects().length > 0;
                    });
                    return modal ? [...modal.querySelectorAll('.modal-footer button')].find((b) => b.textContent.trim() === 'Cancel') || null : null;
                });
                const cancelEl = cancelHandle.asElement();
                if (cancelEl === null) {
                    throw new Check('the Time Slots dialog\'s own Cancel wasn\'t found to back out of it');
                }
                await click(cancelEl, 'the Time Slots dialog\'s Cancel');
                await page.waitForFunction(() => ![...document.querySelectorAll('.modal-title')]
                    .some((t) => t.textContent.trim() === 'Time Slots' && t.getClientRects().length > 0), { timeout: 10000, polling: 200 }).catch(() => {});
                await closeWith('Cancel');
                throw new Skip('this bundle\'s Time Slots dialog has no Special days section (no "+ Add special day" button) - special-day skipped');
            }
            await clickText('button', '+ Add special day', 'Add special day');
            const nameField = await find('input[ng-model="day.name"]', null, 'the special day\'s Name field');
            await nameField.click();
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await nameField.type('Workflow test day');
            const named = await page.waitForFunction(() => [...document.querySelectorAll('input[ng-model="day.name"]')]
                .some((x) => x.value === 'Workflow test day'), { timeout: 10000, polling: 100 }).catch(() => null);
            if (named === null) {
                throw new Check('the special day\'s Name field didn\'t take "Workflow test day"');
            }
            // Pushed 40 days out, in the directive's own scope - away from the near-term
            // windows the other workflows check, well within usable()'s one-week limit.
            const dayId = await page.evaluate(() => {
                const el = [...document.querySelectorAll('input[ng-model="day.name"]')].find((x) => x.value === 'Workflow test day');
                const scope = angular.element(el).scope();
                const DAY = 24 * 60 * 60 * 1000;
                const d = new Date(Date.now() + 40 * DAY);
                const toStr = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
                scope.day.from.date = toStr(d);
                scope.day.to.date = toStr(new Date(d.getTime() + DAY));
                scope.$apply();
                return scope.day.id;
            });
            if (!dayId) {
                throw new Check('the special day\'s own scope wasn\'t found to set its dates');
            }
            await clickText('button', '+ Add row', 'Add row');
            const showName = await page.evaluate(() => {
                const el = [...document.querySelectorAll('select[ng-model="row.showId"]')][0];
                const opt = [...el.options].find((o) => o.value && !/^string:flex\.?$/.test(o.value));
                if (!opt) return null;
                el.value = opt.value;
                angular.element(el).triggerHandler('change');
                return opt.textContent.trim();
            });
            if (!showName) {
                throw new Check('no show to put in the special day\'s row');
            }
            await sleep(300);
            await runCreateLineup();
            await closeWith('Update Channel');

            const laid = await api(`/api/channel/${opts.channel}`);
            const day = (laid.scheduleBackup.specialDays || []).find((d) => d.id === dayId);
            if (!day) {
                throw new Check('the special day wasn\'t saved');
            }
            const tagged = laid.programs.filter((p) => p.specialDay === dayId);
            if (tagged.length === 0) {
                throw new Check('Create Lineup laid nothing for the special day');
            }

            // Delete on one of its airings: jump the list to the day's own start.
            await openEditor();
            const refusal = await page.evaluate((fromAt) => {
                const el = document.getElementById('channelConfigProgramList');
                const scope = angular.element(el).scope();
                scope.goTo.date = new Date(fromAt);
                scope.goTo.time = new Date(fromAt);
                scope.goToAiring();
                scope.$apply();
                return true;
            }, new Date(day.from.date + 'T00:00:00').getTime() + day.from.time);
            if (!refusal) {
                throw new Check('couldn\'t jump the list to the special day\'s start');
            }
            await sleep(800);
            const row = (await rowsInView()).find((r) => !r.flex);
            if (!row) {
                throw new Check('no airing in view at the special day\'s start');
            }
            const rowTextOf = async (k) => (await rowHandle(k)).evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
            const before = await rowTextOf(row.k);
            await click(await (await rowHandle(row.k)).$('button[title="Delete..."]'), `${row.show} at ${row.start}'s Delete`);
            // The day is laid again (15-60 s): one sentence, "... is left out; ... airs at ... instead."
            const settled = await page.waitForFunction(() => {
                const el = document.querySelector('.programming-head .text-info');
                const err = [...document.querySelectorAll('.text-danger.small')].map((e) => e.textContent.trim()).find((t) => t.length > 0);
                return (el && / is left out/.test(el.textContent)) || err;
            }, { timeout: 180000, polling: 1000 }).catch(() => null);
            const said = await lastChange();
            if ( (settled === null) || ! / is left out/.test(said) ) {
                throw new Check(`Delete on ${row.show} at ${row.start} (inside the special day) didn't leave it out: "${said}"`);
            }
            if (await modalOpen()) {
                throw new Check(`Delete inside the special day asked something: "${await modalOpen()}"`);
            }
            await sleep(500);
            const now = (await rowsInView()).find((r) => r.start === row.start && !r.flex);
            if (now && (await rowTextOf(now.k)) === before) {
                throw new Check(`${row.show} at ${row.start} still airs after Delete`);
            }
            await closeWith('Cancel');
            const unchanged = await api(`/api/channel/${opts.channel}`);
            if (unchanged.programs.length !== laid.programs.length) {
                throw new Check('Cancel after Delete inside the day still changed the saved list');
            }

            // Clean up: delete the day itself and regenerate, so later runs start clean.
            await openEditor();
            await openTimeSlots();
            await page.evaluate((id) => {
                const el = [...document.querySelectorAll('[ng-repeat="day in schedule.specialDays track by day.id"]')]
                    .find((x) => angular.element(x).scope().day.id === id);
                angular.element(el).scope().deleteSpecialDay(angular.element(el).scope().day);
                angular.element(el).scope().$apply();
            }, dayId);
            await runCreateLineup();
            await closeWith('Update Channel');
            const cleaned = await api(`/api/channel/${opts.channel}`);
            if ((cleaned.scheduleBackup.specialDays || []).some((d) => d.id === dayId)) {
                throw new Check('the special day was still there after cleanup');
            }
            return `"Workflow test day" (${showName}) added 40 days out, Create Lineup laid ${tagged.length} airings, saved; `
                + `Delete on ${row.show} at ${row.start}: "${said}", nothing asked; Cancel dropped it; deleted and regenerated clean`;
        },
        'breaks-page': async () => {
            // The Breaks page (NOTES.md, "Rules for every session", workflow 10): the scanner's mode and
            // its Pause switch, a pattern approved and withdrawn from its line (and the weaker second line),
            // sorted by when each show next airs, a show opened and its list stepped through with real
            // clicks and keys (approve, reject, nudge, a typed time, a kind, a break added), the frames
            // either side of a point, "these have no breaks", theatrical, and "Scan next". It changes the
            // breaks store of the copy it runs on (approvals, a nudge, a hand break it takes away again);
            // its scanner must be paused by hand, and it never lets it read a drive.
            // The frames come from the show's own drive: one that is busy is passed over for another, and
            // when all are busy the frame check says "skipped: drive busy" and the rest still runs.
            const scanner0 = await api('/api/breaks/scanner');
            if (!scanner0.pausedByHand) {
                throw new Check('this server\'s break scanner is running: pause it by hand first (the copy\'s break-scanner.json, {"paused":true,"skipDrives":["E:"]}); a scratch server must not read the real drives');
            }
            let list = await api('/api/breaks/shows');
            for (let i = 0; i < 120 && !list.ready; i++) {
                await sleep(1000);
                list = await api('/api/breaks/shows');
            }
            if (!list.ready) {
                throw new Check('the scanner never built its list of what airs (a minute after the server starts)');
            }
            const skipped = scanner0.skipDrives;
            const driveOf = (p) => /^[A-Za-z]:/.test(p) ? p.slice(0, 2).toUpperCase() : null;
            const detailOf = (key) => api(`/api/breaks/show?key=${encodeURIComponent(key)}`);
            const out = [];

            const openPage = async () => {
                await page.goto(opts.url + '/#!/breaks', { waitUntil: 'networkidle2' });
                await page.reload({ waitUntil: 'networkidle2' });
                const shown = await page.waitForFunction(() => document.querySelector('.bk-show') !== null, { timeout: 30000, polling: 200 }).catch(() => null);
                if (shown === null) {
                    throw new Check('the Breaks page showed no shows');
                }
            };
            // Types into the search box so the show is in the list, whatever the filter.
            const search = async (name) => {
                const box = await find('.bk-search', null, 'the search box');
                // typed in the box, as a person would (a title with a curly apostrophe is set in one go)
                await box.evaluate((el) => { el.focus(); el.select(); });
                await page.keyboard.press('Backspace');
                if (/^[ -~]+$/.test(name)) {
                    await page.keyboard.type(name);
                } else {
                    await box.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, name);
                }
                await page.waitForFunction((n) => [...document.querySelectorAll('.bk-show .bk-name a')].some((a) => a.textContent.trim() === n), { timeout: 10000, polling: 100 }, name)
                    .catch(() => { throw new Check(`${name} isn't in the list after searching for it`); });
            };
            const rowOf = (name) => page.evaluateHandle((n) => [...document.querySelectorAll('.bk-show')].find((r) => r.querySelector('.bk-name a').textContent.trim() === n) || null, name)
                .then((h) => h.asElement());
            // A button in a show's own line (not its opened panel) by its text; `nth` among the matches.
            const lineButton = async (name, text, nth = 0) => {
                const row = await rowOf(name);
                if (row === null) {
                    throw new Check(`${name} isn't in the list`);
                }
                const handle = await page.evaluateHandle((r, src, k) => [...r.querySelectorAll('.bk-line button')].filter((b) => new RegExp(src).test(b.textContent.trim()) && b.getClientRects().length > 0)[k] || null, row, text.source, nth);
                if (handle.asElement() === null) {
                    throw new Check(`${name} has no ${text} button in its line`);
                }
                return handle.asElement();
            };
            const panelButton = (text) => find('.bk-panel button', text, `the panel's ${text}`);
            const lineText = (name) => page.evaluate((n) => {
                const r = [...document.querySelectorAll('.bk-show')].find((x) => x.querySelector('.bk-name a').textContent.trim() === n);
                return r ? r.querySelector('.bk-line').textContent.replace(/\s+/g, ' ').trim() : '';
            }, name);
            const waitDetail = async (key, landed, what) => {
                let last = await detailOf(key);
                for (let i = 0; i < 40 && !landed(last); i++) {
                    await sleep(250);
                    last = await detailOf(key);
                }
                if (!landed(last)) {
                    throw new Check(`${what}: the server's show never showed it`);
                }
                return last;
            };
            const pointsOf = (d, path) => d.episodes.find((e) => e.path === path).points;

            // 1. the scanner's line, its details and its Pause switch (with every drive skipped, so a
            //    resume can't read anything), and the order of the list
            await openPage();
            const mode = await page.$eval('.bk-mode', (el) => el.textContent.trim());
            // with midrolls off (a copy of a server from before the switch) the line says that instead
            if (!/^(Paused by hand|Off: midrolls are off)$/.test(mode)) {
                throw new Check(`the scanner's line says "${mode}", not Paused by hand or Off: midrolls are off`);
            }
            await clickText('.bk-scanner a', 'Details', 'the scanner\'s Details');
            await find('.bk-details', null, 'the scanner\'s details');
            const allDrives = [ 'C:', 'D:', 'E:', 'F:', 'G:', 'H:', 'I:', 'J:', 'K:', 'L:', 'M:', 'N:' ];
            try {
                await fetch(opts.url + '/api/breaks/scanner', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skipDrives: allDrives }) });
                await clickText('.bk-scanner button', 'Resume', 'the Resume switch');
                await waitForSave('/api/breaks/scanner', (s) => s.pausedByHand === false, 15000);
                await clickText('.bk-scanner button', 'Pause', 'the Pause switch');
                const back = await waitForSave('/api/breaks/scanner', (s) => s.pausedByHand === true, 15000);
                if (!back.pausedByHand) {
                    throw new Check('Pause did not pause the scanner');
                }
            } finally {
                await fetch(opts.url + '/api/breaks/scanner', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skipDrives: skipped }) });
                await fetch(opts.url + '/api/breaks/scanner', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) });
            }
            out.push('scanner line, Details and the Pause / Resume switch');

            // 1b. the Midrolls switch and its sentence (step 5b): off, the scanner's line says so; on, Paused
            //     by hand still wins and nothing is read. Left as it was found.
            const SAYS = 'Midrolls only play at approved breaks: Syndicast approves the shows it is sure of, and anything you approve or reject here overrides it.';
            await openPage();
            const says = await page.$eval('.bk-midrolls-says', (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
            if (says !== SAYS) {
                throw new Check(`the sentence at the top of the Breaks page reads "${says}"`);
            }
            const midrolls0 = (await api('/api/breaks/scanner')).midrolls === true;
            try {
                if (midrolls0) {
                    await clickText('.bk-midrolls label', /^Midrolls (on|off)$/, 'the Midrolls switch');
                    await waitForSave('/api/breaks/scanner', (s) => s.midrolls === false, 15000);
                }
                await page.waitForFunction(() => /Off: midrolls are off/.test(document.querySelector('.bk-mode').textContent), { timeout: 15000, polling: 200 })
                    .catch(() => { throw new Check('with midrolls off, the scanner\'s line does not say "Off: midrolls are off"'); });
                await clickText('.bk-midrolls label', /^Midrolls (on|off)$/, 'the Midrolls switch');
                const on = await waitForSave('/api/breaks/scanner', (s) => s.midrolls === true, 15000);
                if ((on.midrolls !== true) || (on.pausedByHand !== true) || (on.reason !== 'Paused by hand') || (on.current !== null)) {
                    throw new Check(`turning midrolls on while paused by hand: ${JSON.stringify({ midrolls: on.midrolls, pausedByHand: on.pausedByHand, reason: on.reason, current: on.current })}`);
                }
                await page.waitForFunction(() => /Paused by hand/.test(document.querySelector('.bk-mode').textContent) && /Midrolls on/.test(document.querySelector('.bk-midrolls label').textContent), { timeout: 15000, polling: 200 })
                    .catch(() => { throw new Check('with midrolls on and the scanner paused by hand, the page does not say "Midrolls on" and "Paused by hand"'); });
            } finally {
                await fetch(opts.url + '/api/breaks/scanner', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ midrolls: midrolls0 }) });
            }
            out.push(`the Midrolls switch off and on (left ${midrolls0 ? 'on' : 'off'}) and its sentence`);

            // 1c. a show approved automatically: its line says so, with Withdraw and no Approve; it is out of
            //     Needs a click unless an episode of it is still listed; Withdraw is remembered, Approve after it is his
            const autoShows = (await api('/api/breaks/shows')).shows.filter((s) => s.autoApproved === true && s.kind !== 'movie');
            const auto = autoShows.find((s) => s.toCheck === 0) || autoShows[0];
            if (!auto) {
                throw new Check('no show is approved automatically on this copy');
            }
            if (autoShows.some((s) => s.needsClick)) {
                throw new Check(`a show approved automatically is in Needs a click: ${autoShows.filter((s) => s.needsClick).map((s) => s.name).slice(0, 3).join(', ')}`);
            }
            await search(auto.name);
            if (!/Approved automatically/.test(await lineText(auto.name))) {
                throw new Check(`${auto.name}'s line does not say "Approved automatically": ${await lineText(auto.name)}`);
            }
            if (await lineButton(auto.name, /^Approve$/).then(() => true, () => false)) {
                throw new Check(`${auto.name} is approved automatically but its line offers Approve`);
            }
            await click(await lineButton(auto.name, /^Withdraw$/), `${auto.name}'s Withdraw`);
            let ad = await waitDetail(auto.key, (x) => x.line.withdrawn === true, `${auto.name}'s Withdraw`);
            if (ad.line.autoApproved !== false) {
                throw new Check(`${auto.name}: withdrawn, but still approved automatically`);
            }
            await openPage();
            await search(auto.name);
            if (!/withdrawn/.test(await lineText(auto.name))) {
                throw new Check(`${auto.name}'s line does not say withdrawn after a reload`);
            }
            await click(await lineButton(auto.name, /^Approve$/), `${auto.name}'s Approve`);
            ad = await waitDetail(auto.key, (x) => x.line.approved === true, `${auto.name}'s Approve`);
            if ((ad.line.withdrawn !== false) || (ad.line.autoApproved !== false)) {
                throw new Check(`${auto.name}: Approve after Withdraw left ${JSON.stringify({ withdrawn: ad.line.withdrawn, autoApproved: ad.line.autoApproved })}`);
            }
            await click(await lineButton(auto.name, /^Withdraw$/), `${auto.name}'s Withdraw`);
            await waitDetail(auto.key, (x) => x.line.approved === false && x.line.withdrawn === true, `${auto.name}'s second Withdraw`);
            out.push(`${auto.name}: approved automatically (${autoShows.length} shows), Withdraw kept over a reload, Approve, Withdraw (left withdrawn)`);

            // The page's order against the server's, read back to back; a show can start or end between the
            // two (the half hour), so a difference is read again before it counts.
            let domOrder;
            let apiOrder;
            let fresh;
            for (let tries = 0; tries < 3; tries++) {
                await openPage();
                domOrder = await page.$$eval('.bk-show .bk-name a', (as) => as.slice(0, 12).map((a) => a.textContent.trim()));
                fresh = await api('/api/breaks/shows');
                apiOrder = fresh.shows.filter((s) => s.needsClick).slice(0, 12).map((s) => s.name);
                if (JSON.stringify(domOrder) === JSON.stringify(apiOrder)) {
                    break;
                }
            }
            if (JSON.stringify(domOrder) !== JSON.stringify(apiOrder)) {
                throw new Check(`Needs a click isn't in the order the shows next air: page ${domOrder.slice(0, 4).join(' | ')} ... , server ${apiOrder.slice(0, 4).join(' | ')} ...`);
            }
            const times = fresh.shows.filter((s) => s.needsClick && s.nextAt != null).map((s) => s.nextAt);
            if (times.some((t, i) => i > 0 && t < times[i - 1])) {
                throw new Check('the shows that air are not in order of when they next air');
            }
            // shows approved automatically have no Approve on their line (step 1c covers them)
            list = Object.assign({}, fresh, { shows: fresh.shows.filter((s) => s.autoApproved !== true) });
            out.push('Needs a click in next-airing order');

            // 2. a pattern approved from its line and withdrawn; then the weaker second line
            const plain = list.shows.find((s) => s.pattern !== null && !s.approved && s.weaker === null && s.kind !== 'movie' && s.toCheck === 0);
            const weakPick = require('./lib/weaker-line')(list.shows);
            const weakish = weakPick === null ? null : weakPick.show;
            if (!plain) {
                throw new Check('no show has a plain pattern on offer to approve');
            }
            await search(plain.name);
            await click(await lineButton(plain.name, /^Approve$/), `${plain.name}'s Approve`);
            let d = await waitDetail(plain.key, (x) => x.line.approved === true, `${plain.name}'s Approve`);
            const patternApproved = d.episodes.reduce((n, e) => n + e.points.filter((p) => p.status === 'approved' && p.by === 'pattern').length, 0);
            if (patternApproved === 0) {
                throw new Check(`${plain.name}: Approve approved no point`);
            }
            if (!/Approved/.test(await lineText(plain.name)) || !(await lineButton(plain.name, /^Withdraw$/))) {
                throw new Check(`${plain.name}'s line doesn't say Approved with a Withdraw`);
            }
            await click(await lineButton(plain.name, /^Withdraw$/), `${plain.name}'s Withdraw`);
            d = await waitDetail(plain.key, (x) => x.line.approved === false, `${plain.name}'s Withdraw`);
            if (d.episodes.some((e) => e.points.some((p) => p.status === 'approved' && p.by === 'pattern'))) {
                throw new Check(`${plain.name}: Withdraw left points approved`);
            }
            out.push(`${plain.name}: Approve (${patternApproved} points) and Withdraw from its line`);
            if (weakish) {
                await search(weakish.name);
                await click(await lineButton(weakish.name, /^Approve$/, weakPick.nth), `${weakish.name}'s weaker Approve`);
                d = await waitDetail(weakish.key, (x) => x.line.approvedWeaker === true, `${weakish.name}'s weaker Approve`);
                await click(await lineButton(weakish.name, /^Withdraw$/), `${weakish.name}'s Withdraw`);
                await waitDetail(weakish.key, (x) => x.line.approved === false, `${weakish.name}'s weaker Withdraw`);
                out.push(`${weakish.name}: the weaker line approved and withdrawn`);
            }

            // 3. a show opened: its list stepped through. The two frames either side of the first point
            //    are cut from the show's own drive on request, and a drive a viewer is using can take
            //    over 30 s to give one up. So the shows on offer are tried one drive at a time and the
            //    first drive that gives its two frames is the one used; when every drive is busy the
            //    frame check is skipped, with a note saying so, and the list is stepped through all the same.
            const candidates = [];
            for (const s of list.shows.filter((x) => x.needsClick && x.toCheck >= 2 && x.kind !== 'movie').slice(0, 60)) {
                const det = await detailOf(s.key);
                const todo = det.toCheck.flatMap((e) => e.points.filter((p) => p.status === 'found').map((p) => ({ path: e.path, at: p.at })));
                if (todo.length >= 7 && todo.slice(0, 7).every((t) => !skipped.includes(driveOf(t.path)))
                    && !candidates.some((c) => c.drive === driveOf(todo[0].path))) {
                    candidates.push({ show: s, det, todo, drive: driveOf(todo[0].path) });
                }
            }
            if (candidates.length === 0) {
                throw new Check('no show with seven points waiting on a drive that is not skipped');
            }
            const openShow = async (c) => {
                await openPage();
                await search(c.show.name);
                await click(await find('.bk-name a', c.show.name, `${c.show.name} in the list`), `${c.show.name}'s name`);
                await find('.bk-review', null, 'the point in front of you');
            };
            const busyDrives = [];
            let target = null;
            for (const c of candidates) {
                await openShow(c);
                const pictures = await page.waitForFunction(() => {
                    const imgs = [...document.querySelectorAll('.bk-frames img')];
                    return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
                }, { timeout: 90000, polling: 300 }).catch(() => null);
                if (pictures !== null) {
                    target = c;
                    break;
                }
                const said = await page.$$eval('.bk-frame-msg', (els) => els.map((e) => e.textContent.trim()).join(' | '));
                if (!/took too long|paused while a viewer/.test(said)) {
                    throw new Check(`the two frames either side of the point did not show${said ? ': ' + said : ''}`);
                }
                busyDrives.push(c.drive);
            }
            let framesSaid = 'two frames shown';
            if (target === null) {
                // Not asked for at all from here on: the page asks the server for two pictures at every point it
                // moves to, each held up to 30 s, and six of those waiting stop its own saves from getting through.
                await page.setRequestInterception(true);
                page.on('request', (req) => (/\/api\/breaks\/frame/.test(req.url()) ? req.abort() : req.continue()));
                target = candidates[0];
                await openShow(target);
                framesSaid = `frame check skipped: drive busy (${busyDrives.join(', ')})`;
            }
            const name = target.show.name;
            const key = target.show.key;
            const head = await page.$eval('.bk-review-head', (el) => el.textContent.replace(/\s+/g, ' ').trim());
            const waiting = parseInt((/of (\d+) waiting/.exec(head) || [])[1], 10);
            if (waiting !== target.todo.length) {
                throw new Check(`${name}: the page says ${waiting} points waiting, the server ${target.todo.length}`);
            }
            const first = target.todo[0];
            await click(await panelButton('Approve'), 'Approve');
            d = await waitDetail(key, (x) => pointsOf(x, first.path).some((p) => Math.abs(p.at - first.at) < 0.03 && p.status === 'approved' && p.by === 'owner'), 'Approve');
            if (d.toCheck.flatMap((e) => e.points.filter((p) => p.status === 'found')).length !== waiting - 1) {
                throw new Check('after Approve the number waiting did not drop by one');
            }
            const second = target.todo[1];
            await sleep(600);
            await click(await panelButton('Reject'), 'Reject');
            d = await waitDetail(key, (x) => pointsOf(x, second.path).some((p) => Math.abs(p.at - second.at) < 0.03 && p.status === 'rejected'), 'Reject');
            out.push(`${name}: the list stepped through (${waiting} waiting), ${framesSaid}, Approve and Reject`);

            // nudge a frame, type a time, change the kind - all on the third point
            const third = target.todo[2];
            await sleep(600);
            await click(await find('.bk-buttons button', /frame ›/, 'the frame later button'), 'a frame later');
            d = await waitDetail(key, (x) => pointsOf(x, third.path).some((p) => Math.abs(p.at - (third.at + 0.04)) < 0.03 && p.status === 'approved' && p.by === 'owner' && p.movedFrom !== null), 'a frame later');
            const shot = await page.evaluate(() => angular.element(document.querySelector('.breaks-page')).scope().focusPoint());
            if (!shot || Math.abs(shot.at - (third.at + 0.04)) > 0.03) {
                throw new Check('after a nudge the cursor did not stay on the moved point');
            }
            // Times well away from every point of the episode, so no neighbour within 15 s reads as one with them.
            const epLength = (await detailOf(key)).episodes.find((e) => e.path === third.path).durationMs / 1000;
            const have = pointsOf(await detailOf(key), third.path);
            const freeTimes = [];
            for (let t = 100; t < epLength - 200 && freeTimes.length < 2; t += 31) {
                if (have.every((p) => Math.abs(p.at - t) > 40) && freeTimes.every((u) => Math.abs(u - t) > 40)) {
                    freeTimes.push(t);
                }
            }
            if (freeTimes.length < 2) {
                throw new Check('no stretch of the episode is clear of its points to try a typed time and an added break in');
            }
            const [ moveTo, addAt ] = freeTimes;
            const clockOf = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
            const input = await find('.bk-buttons .bk-time input', null, 'the time box');
            await input.evaluate((el) => { el.focus(); el.select(); });
            await page.keyboard.type(clockOf(moveTo));
            await clickText('.bk-buttons button', 'Move there', 'Move there');
            d = await waitDetail(key, (x) => pointsOf(x, third.path).some((p) => Math.abs(p.at - Math.round(moveTo)) < 0.5 && p.status === 'approved'), 'Move there');
            await page.select('.bk-kind', 'story');
            d = await waitDetail(key, (x) => pointsOf(x, third.path).some((p) => Math.abs(p.at - Math.round(moveTo)) < 0.5 && p.kind === 'story'), 'the kind box');
            out.push('a frame later, a typed time and a kind change');

            // a break added by hand, then taken away
            const typed = (await page.$$('.bk-buttons .bk-time input'))[1];
            await typed.evaluate((el) => { el.focus(); el.select(); });
            await page.keyboard.type(clockOf(addAt));
            await clickText('.bk-buttons button', 'Add a break here', 'Add a break here');
            d = await waitDetail(key, (x) => pointsOf(x, third.path).some((p) => Math.abs(p.at - Math.round(addAt)) < 0.5 && p.status === 'hand'), 'Add a break here');
            await sleep(600);
            await click(await panelButton('Reject'), 'Reject (of the break just added)');
            d = await waitDetail(key, (x) => !pointsOf(x, third.path).some((p) => Math.abs(p.at - Math.round(addAt)) < 0.5), 'taking the added break away');
            out.push(`a break added at ${clockOf(addAt)} and taken away`);

            // the keys: A approves the point in front of you
            const fourth = (await page.evaluate(() => angular.element(document.querySelector('.breaks-page')).scope().focus));
            await page.mouse.click(5, 5);
            await page.keyboard.press('a');
            d = await waitDetail(key, (x) => pointsOf(x, fourth.path).some((p) => (fourth.at == null || Math.abs(p.at - fourth.at) < 0.03) && p.status === 'approved' && p.by === 'owner'), 'the A key');
            out.push('the A key approves');

            // 4. "these have no breaks": two ticked, then the whole show, then taken back
            const markedBefore = (await detailOf(key)).episodes.filter((e) => e.noBreaks).map((e) => e.path);
            await clickText('.bk-section a', /All episodes/, 'All episodes');
            const boxes = await page.$$('.bk-panel .bk-ep input[type=checkbox]');
            await boxes[boxes.length - 1].click();
            await boxes[boxes.length - 2].click();
            const ticked = await page.$$eval('.bk-panel .bk-ep input[type=checkbox]', (els) => els.filter((e) => e.checked).length);
            if (ticked < 2) {
                throw new Check('ticking two episodes ticked ' + ticked);
            }
            await clickText('.bk-tickbar button', /^These have no breaks/, 'These have no breaks');
            d = await waitDetail(key, (x) => x.episodes.filter((e) => e.noBreaks).length >= 1, 'These have no breaks');
            const marked = d.episodes.filter((e) => e.noBreaks).length;
            if (marked < 1) {
                throw new Check('These have no breaks marked nothing');
            }
            await clickText('.bk-panel button', 'No breaks in this show', 'No breaks in this show');
            d = await waitDetail(key, (x) => x.episodes.filter((e) => !e.unscanned).every((e) => e.noBreaks), 'No breaks in this show');
            if (d.line.noBreaksShow !== true) {
                throw new Check('No breaks in this show did not mark the show as a whole (files scanned later are meant to be marked as they arrive)');
            }
            if (d.line.toCheck !== 0) {
                throw new Check(`with every episode marked as having none, ${d.line.toCheck} are still on the list to check`);
            }
            await clickText('.bk-tickbar a', /the marked ones/, 'tick the marked ones');
            await clickText('.bk-tickbar button', /^Use their breaks again/, 'Use their breaks again');
            d = await waitDetail(key, (x) => x.episodes.every((e) => !e.noBreaks), 'Use their breaks again');
            if (d.line.noBreaksShow !== true) {
                throw new Check('taking back the ticked episodes cleared the whole-show mark: ticked episodes are meant to stay as they are');
            }
            await clickText('.bk-panel button', 'Breaks again in this show', 'Breaks again in this show');
            d = await waitDetail(key, (x) => x.line.noBreaksShow === false, 'Breaks again in this show');
            if (markedBefore.length > 0) {
                await fetch(opts.url + '/api/breaks/none', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, paths: markedBefore }) });
            }
            out.push(`${name}: These have no breaks (${marked} ticked), No breaks in this show (${d.episodes.length}), all taken back`);

            // 5. theatrical: a movie inside a custom show that was never scanned (First Kid, College Road Trip),
            //    marked from the show's own Movies list and taken back; and a movie's own line.
            //    The custom show is the first by name that has a movie it can use, not the first in the list,
            //    which is in the order the shows next air and so changes with the time of day. And the page is
            //    opened afresh: a click on the name of a show that is already open closes it, and step 3 may
            //    have left this very show open (Sunday Disney Movies, Nov 15, 2026 at 8:20pm).
            let inShow = null;
            for (const s of customShowsWithMovies(list.shows).slice(0, 30)) {
                const m = movieIn(await detailOf(s.key));
                if (m) {
                    inShow = { show: s, movie: m };
                    break;
                }
            }
            if (inShow) {
                await openPage();
                const { show: cs, movie } = inShow;
                await search(cs.name);
                await click(await find('.bk-name a', cs.name, `${cs.name} in the list`), `${cs.name}'s name`);
                const moviesRow = async () => (await page.evaluateHandle((n) => [...document.querySelectorAll('.bk-movies .bk-ep')].find((r) => r.textContent.includes(n)) || null, movie.name)).asElement();
                await find('.bk-movies', null, `${cs.name}'s Movies list`);
                const rowBefore = await moviesRow();
                if (rowBefore === null) {
                    throw new Check(`${movie.name} isn't in ${cs.name}'s Movies list`);
                }
                await click((await rowBefore.$$('button'))[0], `${movie.name}'s Theatrical`);
                d = await waitDetail(cs.key, (x) => x.episodes.find((e) => e.path === movie.path).theatrical === true, `${movie.name}'s Theatrical`);
                if (!/by hand/.test(await page.evaluate((r) => r.textContent, await moviesRow()))) {
                    throw new Check(`${movie.name}'s row doesn't say its breaks are only where added by hand`);
                }
                await click((await (await moviesRow()).$$('button'))[0], `${movie.name}'s Not theatrical`);
                d = await waitDetail(cs.key, (x) => x.episodes.find((e) => e.path === movie.path).theatrical === false, `${movie.name}'s Not theatrical`);
                out.push(`${movie.name} (in ${cs.name}${movie.unscanned ? ', never scanned' : ''}): marked theatrical and back; the custom show is the first by name with a movie to use, whatever airs next`);
            } else {
                out.push('no movie inside a custom show to mark theatrical');
            }
            const own = list.shows.find((s) => s.kind === 'movie' && s.moviePath && !s.theatrical && /^[\x20-\x7e]+$/.test(s.name));
            if (own) {
                await search(own.name);
                await click(await lineButton(own.name, /^Theatrical$/), `${own.name}'s Theatrical`);
                await waitDetail(own.key, (x) => x.line.theatrical === true, `${own.name}'s Theatrical`);
                if (!/theatrical/.test(await lineText(own.name))) {
                    throw new Check(`${own.name}'s line doesn't say theatrical`);
                }
                await click(await lineButton(own.name, /^Not theatrical$/), `${own.name}'s Not theatrical`);
                await waitDetail(own.key, (x) => x.line.theatrical === false, `${own.name}'s Not theatrical`);
                out.push(`${own.name}: its own line's Theatrical and back`);
            }
            let scanNext = null;
            for (const cand of list.shows.filter((s) => s.scanned < s.total && !s.theatrical && s.kind === 'tv').slice(0, 10)) {
                await search(cand.name);
                await click(await lineButton(cand.name, /^Scan next$/), `${cand.name}'s Scan next`);
                const asked = await waitDetail(cand.key, (x) => x.scanFirst !== null, `${cand.name}'s Scan next`);
                if (asked.scanFirst > 0) {
                    const queued = (await api('/api/breaks/scanner')).scanFirst.find((s) => s.key === cand.key);
                    if (!queued || queued.remaining < 1) {
                        throw new Check('the scanner does not list the show as next');
                    }
                    await click(await lineButton(cand.name, /^Next: \d+ left$/), `${cand.name}'s Next: n left`);
                    await waitDetail(cand.key, (x) => x.scanFirst === null, `${cand.name}'s Scan next taken back`);
                    scanNext = `${cand.name}: Scan next (${queued.remaining} left) and back`;
                    break;
                }
                // every file left is on a skipped drive: nothing to put first; take the request back
                await fetch(opts.url + '/api/breaks/scan-first', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: cand.key, value: false }) });
            }
            out.push(scanNext || 'no show with files the scanner can reach to put first');
            return out.join('; ');
        },
    };
    return workflows;
}

(async () => {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    const executablePath = findChromeExecutable();
    if (!executablePath) {
        console.error('No Chrome or Edge found; set PUPPETEER_EXECUTABLE_PATH.');
        process.exit(2);
    }
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath, headless: !opts.headful, defaultViewport: { width: 1400, height: 1000 } });
    const page = await browser.newPage();
    // On before any page loads, as test/drag-vs-repeat-lockup.js has it: turned on later, Chrome
    // starts its own drag and the interception never sees it.
    await page.setDragInterception(true);
    page.on('dialog', (d) => d.dismiss());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const workflows = makeRunner(opts, page);
    const names = Object.keys(workflows).filter((n) => opts.only === null || opts.only.indexOf(n) !== -1);
    let failed = 0;
    let skipped = 0;
    console.log(`Editor workflows on ${opts.url}, channel ${opts.channel}, ${new Date().toLocaleString()}`);
    for (const name of names) {
        const t0 = Date.now();
        errors.length = 0;
        try {
            const said = await workflows[name]();
            console.log(`  PASS  ${name}  (${Math.round((Date.now() - t0) / 1000)}s)  ${said}`);
        } catch (e) {
            if (e instanceof Skip) {
                skipped++;
                console.log(`  SKIP  ${name}  ${e.message}`);
            } else {
                failed++;
                console.log(`  FAIL  ${name}  ${e instanceof Check ? e.message : e.stack}`);
                const shot = require('path').join(require('os').tmpdir(), `editor-workflows-${name}.png`);
                await page.screenshot({ path: shot }).then(() => console.log(`        screenshot: ${shot}`)).catch(() => {});
            }
        }
        // a workflow that held back requests (breaks-page, with every drive busy) lets them through again
        page.removeAllListeners('request');
        await page.setRequestInterception(false).catch(() => {});
        if (errors.length > 0) {
            console.log(`        page errors: ${errors.slice(0, 3).join(' | ')}`);
        }
    }
    const ran = names.length - skipped;
    console.log(`${ran - failed}/${ran} workflows passed${skipped ? `, ${skipped} skipped` : ''}.`);
    // browser.close() can hang after the last workflow; give it 10 s, then kill it.
    const closed = await require('./lib/close-browser')(browser, 10000);
    if (closed !== 'closed') {
        console.log(`        the browser did not close in 10 s (${closed})`);
    }
    process.exit(failed === 0 ? 0 : 1);
})();
