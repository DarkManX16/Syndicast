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
 *   first-open-not-now   the first-open list answered Not now; Cancel closes the editor
 *   first-open-keep      answered Keep them; Update Channel saves the answer
 *   open-cancel          open the editor, Cancel
 *   open-update          open the editor, Update Channel: saved, the lineup as it was
 *   library-add          a show from the library at the end of the list: it joins the
 *                        channel, nothing in the lineup moves or is kept; saved
 *   delete               Remove this airing only on an episode; Cancel drops it
 *   swap-drag-put-back   Swap an airing, drag a row, Put back each; Cancel
 *   create-lineup        Time Slots..., Create Lineup; kept rows stay; saved
 *   filler               a filler list: drag a clip, delete one, Done; saved
 *
 * The first-open workflows answer only a channel whose list still asks; once
 * answered and saved they say so and pass over it.
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

function makeRunner(opts, page) {
    const api = async (path) => {
        const r = await fetch(opts.url + path);
        if (!r.ok) {
            throw new Error(`${path}: HTTP ${r.status}`);
        }
        return r.json();
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
    };
    // Waits out the first-open list when it shows, answered with `answer`; says whether it showed.
    const passFirstOpen = async (answer) => {
        for (let i = 0; i < 10 && !(await firstOpenShowing()); i++) {
            await sleep(300);
        }
        if (!(await firstOpenShowing())) {
            return false;
        }
        await clickText('.modal-footer button', answer, `the first-open list's ${answer}`);
        await sleep(500);
        if (await firstOpenShowing()) {
            throw new Check(`the first-open list stayed after ${answer}`);
        }
        return true;
    };
    const closeWith = async (name) => {
        await click(await footerButton(name), `the editor's ${name}`);
        for (let i = 0; i < 100 && (await editorShowing()); i++) {
            await sleep(300);
        }
        if (await editorShowing()) {
            throw new Check(`the editor stayed open after ${name}`);
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
                out.push(`${t}|${p.isOffline ? 'Flex' : (p.showTitle || '') + ' ' + p.title}|${p.duration}|${p.kept ? JSON.stringify(p.kept) : ''}`);
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
        kept: !!r.querySelector('.fa-thumbtack, .fa-clock'),
        canSwap: !!r.querySelector('button[title="Swap..."]'),
        top: r.getBoundingClientRect().top,
    })));
    const rowHandle = async (k) => (await page.$$('#channelConfigProgramList .psr-row'))[k];
    // A plain episode row a little way into the list, clear of the airing on air.
    const plainRow = async (skip) => {
        const rows = (await rowsInView()).filter((r) => r.canSwap && !r.kept && !r.flex);
        if (rows.length <= skip) {
            throw new Check('no plain episode row in view to use');
        }
        return rows[skip];
    };

    // Swap a plain episode a little way in for the first episode of its show that fits.
    const swapOne = async () => {
        const row = await plainRow(2);
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

    const workflows = {
        'first-open-not-now': async () => {
            await openEditor();
            if (!(await passFirstOpen('Not now'))) {
                return 'not shown: this channel\'s list was answered already';
            }
            await closeWith('Cancel');
            return 'Not now closed the list; Cancel closed the editor';
        },
        'first-open-keep': async () => {
            await openEditor();
            if (!(await passFirstOpen('Keep them'))) {
                return 'not shown: this channel\'s list was answered already';
            }
            const said = await lastChange();
            await closeWith('Update Channel');
            const saved = await api(`/api/channel/${opts.channel}`);
            if (typeof saved.handEditsKept !== 'string') {
                throw new Check('Update Channel didn\'t save the answer (handEditsKept)');
            }
            return `Keep them said "${said}"; Update Channel saved it`;
        },
        'open-cancel': async () => {
            await openEditor();
            await passFirstOpen('Not now');
            await closeWith('Cancel');
            return 'opened, Cancel closed it';
        },
        'open-update': async () => {
            const before = await api(`/api/channel/${opts.channel}`);
            await openEditor();
            await passFirstOpen('Not now');
            await closeWith('Update Channel');
            const after = await api(`/api/channel/${opts.channel}`);
            sameAirings(airings(before, 14), airings(after, 14), 'Update Channel with nothing changed');
            return `opened, Update Channel saved; ${after.programs.length} entries, the next 14 days as they were`;
        },
        'library-add': async () => {
            const before = await api(`/api/channel/${opts.channel}`);
            await openEditor();
            await passFirstOpen('Keep them');
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
            await passFirstOpen('Keep them');
            const row = await plainRow(3);
            const trash = await (await rowHandle(row.k)).$('button[title="Delete..."]');
            await click(trash, `${row.show} at ${row.start}'s Delete`);
            await clickText('.modal button', /^Remove this airing only/, 'Remove this airing only');
            await sleep(800);
            const said = await lastChange();
            if (!said) {
                throw new Check('Remove this airing only said nothing');
            }
            await closeWith('Cancel');
            return `${row.show} at ${row.start}: "${said}"; Cancel dropped it`;
        },
        'swap-drag-put-back': async () => {
            await openEditor();
            await passFirstOpen('Keep them');
            const said = [];
            const { row, text } = await swapOne();
            said.push(text);
            // Drag: a plain row dropped a few rows further on.
            // Both rows inside the list's visible part (vs-repeat also draws rows past it).
            const box = await page.evaluate(() => {
                const r = document.getElementById('channelConfigProgramList').getBoundingClientRect();
                return { top: r.top, bottom: r.bottom };
            });
            const shown = (await rowsInView()).filter((r) => r.top >= box.top && r.top <= box.bottom - 40);
            const from = shown.find((r, i) => i >= 1 && i <= shown.length - 4 && r.canSwap && !r.kept);
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
            // Put back the swap.
            const again = (await rowsInView()).find((r) => r.kept && r.show === row.show && r.canSwap);
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
        'create-lineup': async () => {
            const before = await api(`/api/channel/${opts.channel}`);
            await openEditor();
            await passFirstOpen('Keep them');
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
            await clickText('.modal-footer button', 'Create Lineup', 'Create Lineup', 180000);
            // Done when the Time Slots dialog has gone (while it generates, its buttons hide).
            const closed = await page.waitForFunction(() => ![...document.querySelectorAll('.modal-title')]
                .some((t) => t.textContent.trim() === 'Time Slots' && t.getClientRects().length > 0), { timeout: 300000, polling: 1000 }).catch(() => null);
            if (closed === null) {
                throw new Check('Create Lineup didn\'t finish in 5 minutes');
            }
            await sleep(2000);
            const said = await lastChange();
            await closeWith('Update Channel');
            const after = await api(`/api/channel/${opts.channel}`);
            const keptBefore = airings(before, 21).filter((a) => a.endsWith('}'));
            const keptAfter = airings(after, 21).filter((a) => a.endsWith('}'));
            const lost = keptBefore.filter((a) => keptAfter.indexOf(a) === -1);
            if (lost.length > 0) {
                throw new Check(`${lost.length} kept rows moved or went: ${lost[0]}`);
            }
            const kept = keptAfter.find((a) => a.split('|')[1].endsWith(` ${swappedIn}`));
            if (!kept) {
                throw new Check(`the swap (${swappedIn}, at ${swap.row.start}) isn't kept after Create Lineup and Update Channel`);
            }
            return `swapped first: "${swap.text}"; Create Lineup ran${said ? `, "${said}"` : ''}; saved ${after.programs.length} entries; `
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
            await sleep(1500);
            const after = await api(`/api/filler/${target.id}`);
            const key = (c) => c.key || c.title;
            if (after.content.length !== before.content.length - 1) {
                throw new Check(`${before.content.length} clips, ${after.content.length} after deleting one`);
            }
            if (key(after.content[0]) === key(before.content[0]) || key(after.content[0]) !== key(before.content[2]) && key(after.content[0]) !== key(before.content[1])) {
                throw new Check('the drag didn\'t move the first clip');
            }
            return `${target.name}: the first clip dragged down, one deleted, Done saved ${after.content.length} of ${before.content.length}`;
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
    console.log(`Editor workflows on ${opts.url}, channel ${opts.channel}, ${new Date().toLocaleString()}`);
    for (const name of names) {
        const t0 = Date.now();
        errors.length = 0;
        try {
            const said = await workflows[name]();
            console.log(`  PASS  ${name}  (${Math.round((Date.now() - t0) / 1000)}s)  ${said}`);
        } catch (e) {
            failed++;
            console.log(`  FAIL  ${name}  ${e instanceof Check ? e.message : e.stack}`);
            const shot = require('path').join(require('os').tmpdir(), `editor-workflows-${name}.png`);
            await page.screenshot({ path: shot }).then(() => console.log(`        screenshot: ${shot}`)).catch(() => {});
        }
        if (errors.length > 0) {
            console.log(`        page errors: ${errors.slice(0, 3).join(' | ')}`);
        }
    }
    await browser.close();
    console.log(`${names.length - failed}/${names.length} workflows passed.`);
    process.exitCode = failed === 0 ? 0 : 1;
})();
