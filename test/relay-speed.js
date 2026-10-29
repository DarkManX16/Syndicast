/*
 * Making a swap's re-lays fast, and keeping the page responsive while they run.
 * Ron, Oct 24: a swap took about 25 seconds and froze the page. Measured on a
 * copy of channel 2: every redraw of the page asked each of the Time Slots
 * schedule's 335 slots whether it can leave seasons out, and each answer
 * scanned all 14,347 catalog items (2.4 s a redraw); every re-lay read all 160
 * shows from Plex again (13 s); and each sent the server 20 MB and got 26 MB
 * back, three times for a pick that runs too long. See NOTES.md, "Swaps,
 * inserts and Flex that keeps time".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const getShowData = require('../web/services/get-show-data')();
const poolSeasons = require('../src/pool-seasons');
const catalogKeep = require('../src/catalog-keep');
const relayWorker = require('../src/relay-worker');
const timeSlotsService = require('../src/services/time-slots-service');
const pins = require('../src/pins');

const SEC = 1000;
const THU = new Date('2026-10-08T00:00:00').getTime();
const thu = (hour, minute, second) => THU + hour * HOUR + (minute || 0) * MIN + (second || 0) * SEC;

function episode(show, season, n, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    }, extra || {});
}
function schedule() {
    return {
        period: DAY, lateness: 24 * HOUR, maxDays: 60, flexPreference: 'distribute', pad: 5 * MIN,
        slots: [
            { time: 19 * HOUR, showId: 'tv.A', order: 'next' },
            { time: 19 * HOUR + 30 * MIN, showId: 'tv.B', order: 'next' },
            { time: 20 * HOUR, showId: 'tv.C', order: 'next' },
            { time: 20 * HOUR + 30 * MIN, showId: 'flex.', order: 'next' },
        ],
    };
}
function pool() {
    const out = [];
    ['A', 'B', 'C'].forEach((show) => { for (let n = 1; n <= 30; n++) { out.push(episode(show, 1 + (n % 3), n)); } });
    return out;
}
// The clock frozen, as test/pins-generator.js does.
async function frozen(now, fn) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try { return await fn(); } finally { global.Date = RealDate; }
}

module.exports = async function () {
    const suite = new Suite('relay-speed');

    suite.log('-- each show\'s seasons, once per pool --');
    {
        const p = pool().concat([ { type: 'movie', title: 'M', duration: 90 * MIN }, episode('A', undefined, 99) ]);
        let calls = 0;
        const counting = (x) => { calls++; return getShowData(x); };
        const seasonsOf = poolSeasons.memo(counting);
        const slots = 335;
        let a;
        for (let i = 0; i < slots; i++) {
            a = seasonsOf(p, ['tv.A', 'tv.B', 'tv.C'][i % 3]);
        }
        suite.check('the seasons a slot can choose from: each show\'s, sorted, an episode with no season counted as 0',
            a.join() === seasonsOf(p, 'tv.C').join() && seasonsOf(p, 'tv.A').join() === '0,1,2,3' && seasonsOf(p, 'tv.Z').length === 0,
            JSON.stringify({ A: seasonsOf(p, 'tv.A'), C: seasonsOf(p, 'tv.C') }));
        suite.check('...worked out once per pool, not once per slot per redraw', calls <= p.length, `${calls} lookups for ${p.length} items and ${slots} slots`);
        const q = p.concat([ episode('B', 9, 1) ]);
        suite.check('...and again when the pool is a different one', seasonsOf(q, 'tv.B').includes(9) && ! seasonsOf(p, 'tv.B').includes(9));
    }

    suite.log('-- the hidden Time Slots dialog works nothing out --');
    {
        // Every re-lay prepares the Time Slots dialog without showing it; its rows' "Next:"
        // lines then rebuilt the Episode start model (5 s on channel 2) for nobody to see.
        const src = require('fs').readFileSync(require.resolve('../web/directives/time-slots-schedule-editor.js'), 'utf8');
        const at = src.indexOf('scope.nextLineOf = ');
        let body = null;
        if (at !== -1) {
            let i = src.indexOf('{', at);
            for (let depth = 0; i < src.length; i++) {
                if (src[i] === '{') { depth++; } else if (src[i] === '}' && --depth === 0) { break; }
            }
            body = src.slice(at + 'scope.nextLineOf = '.length, i + 1);
        }
        let built = 0;
        const slot = { time: 0 };
        // eslint-disable-next-line no-new-func
        const make = (scope) => new Function('scope', 'ensureModel', 'slotInfo', `return (${body});`)(scope, () => { built++; }, new Map([[slot, { episode: 'x' }]]));
        const hidden = body && make({ visible: false });
        suite.check('a row\'s "Next:" line works nothing out while the dialog is hidden', body !== null && hidden(slot) === null && built === 0, `built ${built}`);
        const shown = body && make({ visible: true });
        suite.check('...and does once it is shown', body !== null && shown(slot).episode === 'x' && built === 1, `built ${built}`);

        // Drawn while hidden, its 335 slot rows were drawn again on every re-lay (3 s each).
        const tpl = require('fs').readFileSync(require.resolve('../web/public/templates/time-slots-schedule-editor.html'), 'utf8');
        suite.check('the hidden dialog draws nothing: its window exists only while shown',
            /<div class="modal"[^>]*\bng-if="visible"/.test(tpl), tpl.split('\n').slice(0, 3).join(' | '));
        suite.check('...and the slot filter, inside it, still reaches the dialog\'s own scope',
            /ng-model="\$parent\.slotFilter"/.test(tpl) && ! /ng-model="slotFilter"/.test(tpl));
    }

    suite.log('-- undo plans once --');
    {
        // Undo itself no longer re-lays: Put back is an edit to the list (src/kept-rows.js).
        const editor = require('fs').readFileSync(require.resolve('../web/directives/time-slots-schedule-editor.js'), 'utf8');
        const relayFn = editor.slice(editor.indexOf('let relay = async'), editor.indexOf('scope.linker('));
        suite.check('...and relay makes several pin sets from one plan and one worker session',
            (relayFn.match(/await plan\(/g) || []).length === 1 && /pinSets/.test(relayFn) && (relayFn.match(/relayWorker\.open\(/g) || []).length === 1);
    }

    suite.log('-- catalogs kept between re-lays --');
    {
        const keep = catalogKeep.keeper({ maxAge: 30 * MIN });
        const first = keep.catalogs(thu(19));
        first['tv.A'] = [ episode('A', 1, 1) ];
        first['tv.B'] = { error: 'Plex did not answer' };
        keep.keep(first, thu(19));
        const again = keep.catalogs(thu(19, 10));
        suite.check('a re-lay ten minutes later gets the catalogs the last one read', again['tv.A'] === first['tv.A'] && again['tv.A'].length === 1);
        suite.check('...but not a show that could not be read: it is asked for again', ! ('tv.B' in again));
        const stale = keep.catalogs(thu(19, 40));
        suite.check('...and after half an hour nothing is kept: Plex is read again', Object.keys(stale).length === 0);
        keep.clear();
        suite.check('...and clear forgets them', Object.keys(keep.catalogs(thu(19, 41))).length === 0);
    }

    suite.log('-- the generator runs where there is no setImmediate --');
    {
        const saved = global.setImmediate;
        delete require.cache[require.resolve('../src/services/throttle')];
        let threw = null;
        try {
            global.setImmediate = undefined;
            const throttle = require('../src/services/throttle');
            await throttle();
        } catch (err) {
            threw = err;
        } finally {
            global.setImmediate = saved;
            delete require.cache[require.resolve('../src/services/throttle')];
        }
        suite.check('throttle resolves in a browser worker, which has no setImmediate', threw === null, threw && threw.message);

        // Bundled, browserify hands the module its own setImmediate (a setTimeout of 0,
        // which a browser holds to 4 ms): 35,000 of them made a re-lay take minutes.
        const src = require('fs').readFileSync(require.resolve('../src/services/throttle'), 'utf8');
        const mod = { exports: null };
        let shimUsed = 0;
        // eslint-disable-next-line no-new-func
        new Function('module', 'process', 'setImmediate', src)(mod, { browser: true, versions: {} }, (fn) => { shimUsed++; setTimeout(fn, 4); });
        await mod.exports();
        suite.check('...nor waits on the bundle\'s own setImmediate, outside Node', shimUsed === 0, `${shimUsed} waits`);
    }

    suite.log('-- the re-lay worker --');
    {
        // What the editor plans once per dialog: the pool, the schedule with its places, history, the carry.
        const now = thu(12);
        const inputs = { pool: pool(), schedule: schedule(), history: [], carry: null };
        const generate = (pinList) => frozen(now, () => timeSlotsService(JSON.parse(JSON.stringify(inputs.pool)),
            JSON.parse(JSON.stringify(inputs.schedule)), [], pinList, null));
        const direct = await generate([]);
        const current = { programs: direct.programs, startTime: Date.parse(direct.startTime) };
        const handle = relayWorker.handler({ generate: (args) => frozen(now, () => timeSlotsService(args.pool, args.schedule, args.history, args.pins, args.carry)), getShowData });
        await handle({ type: 'open', session: 's', inputs, current });
        const base = await handle({ type: 'relay', session: 's', key: 'base', pins: [] });
        const result = await handle({ type: 'result', session: 's', key: 'base' });
        suite.check('a relay in the worker makes the same lineup as the generator called directly',
            JSON.stringify(result.programs) === JSON.stringify(direct.programs) && result.startTime === direct.startTime && base.programs === undefined,
            `${result.programs.length} vs ${direct.programs.length}`);
        const special = pins.makePin({ program: episode('Specials', 0, 1, { title: 'Special', duration: 24 * MIN + 6 * SEC }),
            at: thu(19, 30), kind: 'swap', then: 'take', slotShow: 'tv.B', now });
        const mine = await handle({ type: 'relay', session: 's', key: 'take', pins: pins.withPin([], special) });
        suite.check('...answers with whether the pin was placed, never the whole lineup', mine.placed === true && ! ('programs' in mine));
        const twice = await handle({ type: 'relay', session: 's', key: 'take', pins: pins.withPin([], special) });
        suite.check('...and a pick asked for again is not re-laid again', twice.cached === true && twice.placed === true);
        const b = await handle({ type: 'baseline', session: 's', key: 'base', now, at: thu(19, 30) });
        const o = await handle({ type: 'option', session: 's', key: 'take', base: 'base', now, at: thu(19, 30), item: special, kind: 'swap' });
        suite.check('...and says what the swap does, worked out off the page',
            /Special runs 24:06/.test(o.fitText) && /It fits: 5:54 of Flex after it/.test(o.fitText) && /airs Fri Oct 9, 7:30pm/.test(o.effects)
                && Array.isArray(o.alerts) && o.alerts.length === 0 && b.alerts.length === 0 && b.heldUntil === null,
            JSON.stringify({ fit: o.fitText, effects: o.effects, alerts: o.alerts }));
        // Handed over in slices, so the page never stops for the whole copy at once.
        await handle({ type: 'open', session: 'sliced', inputs: Object.assign({}, inputs, { pool: [] }), current: { programs: [], startTime: current.startTime } });
        for (let i = 0; i < inputs.pool.length; i += 25) {
            await handle({ type: 'add', session: 'sliced', part: 'pool', items: inputs.pool.slice(i, i + 25) });
        }
        for (let i = 0; i < current.programs.length; i += 100) {
            await handle({ type: 'add', session: 'sliced', part: 'current', items: current.programs.slice(i, i + 100) });
        }
        await handle({ type: 'relay', session: 'sliced', key: 'take', pins: pins.withPin([], special) });
        const sliced = await handle({ type: 'result', session: 'sliced', key: 'take' });
        const whole = await handle({ type: 'result', session: 's', key: 'take' });
        const so = await handle({ type: 'relay', session: 'sliced', key: 'base', pins: [] })
            .then(() => handle({ type: 'option', session: 'sliced', key: 'take', base: 'base', now, at: thu(19, 30), item: special, kind: 'swap' }));
        suite.check('...and a session handed over in slices makes and says the same',
            JSON.stringify(sliced.programs) === JSON.stringify(whole.programs) && so.effects === o.effects && so.fitText === o.fitText,
            `${sliced.programs.length} vs ${whole.programs.length}`);
        suite.check('relayWorker.slices cuts a list into slices of at most n, in order',
            JSON.stringify(relayWorker.slices([1, 2, 3, 4, 5], 2)) === '[[1,2],[3,4],[5]]' && relayWorker.slices([], 3).length === 0);

        await handle({ type: 'close', session: 's' });
        let gone = null;
        try { await handle({ type: 'result', session: 's', key: 'base' }); } catch (err) { gone = err; }
        suite.check('...and a closed session is gone', gone !== null && /session/.test(gone.message));
    }

    return suite;
};
