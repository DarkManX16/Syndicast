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
            const keptBefore = (await rowsInView()).filter((r) => r.kept).length;
            await click(await (await rowHandle(row.k)).$('button[title="Delete..."]'), `${row.show} at ${row.start}'s Delete`);
            await sleep(800);
            if (await modalOpen()) {
                throw new Check(`Delete asked something: "${await modalOpen()}"`);
            }
            const after = await rowsInView();
            if (after.some((r) => r.start === row.start && r.show === row.show)) {
                throw new Check(`${row.show} at ${row.start} is still in the list after Delete`);
            }
            if (after.filter((r) => r.kept).length > keptBefore) {
                throw new Check('Delete marked rows as kept');
            }
            const said = await lastChange();
            await closeWith('Cancel');
            return `${row.show} at ${row.start} went at once, nothing asked, nothing kept${said ? `; "${said}"` : ', nothing said'}; Cancel dropped it`;
        },
        'add-delete-create': async () => {
            // Ron, Oct 30: add a show at the end of the list, delete five of its episodes,
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
                // Delete's one sentence: a swap or insert of the episode Ron placed himself still
                // airs, and is named; nothing is said otherwise (Ron, Nov 12).
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
            // where Ron placed that very airing himself (his swaps and inserts, in the list or
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
                throw new Check(`Delete named ${handPlaced} of Ron's own swaps and inserts still ahead, but ${stay} air`);
            }
            if (keptCount(after) > keptCount(before)) {
                throw new Check(`kept rows went from ${keptCount(before)} to ${keptCount(after)}`);
            }
            return `${n} episodes of ${opts.show} added; 5 deleted, each gone from the list at once with nothing asked (${gone.join('; ')})`
                + `${said ? `, said "${said}"` : ', nothing said'}; the Time Slots dialog said ${notes.length === 0 ? 'nothing about kept rows' : `"${notes[0]}"`}; `
                + `Create Lineup and Update Channel saved ${after.programs.length} entries, none of the 5 anywhere in the lineup`
                + `${stay ? ` but the ${stay} Ron placed by hand` : ''}; all 5 on the never-air list (${added.length} added, ${5 - added.length} already there, left as they were); kept rows ${keptCount(before)} -> ${keptCount(after)}`;
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
            // Ron, Nov 6: a clip goes right before an airing, after the break in front of it -
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
            // feature 4, Ron Nov 8), then Cancel so nothing is kept. Far enough out (40 days) to stay clear of
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
