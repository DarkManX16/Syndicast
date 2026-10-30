/*
 * What's left, after the re-lay worker, of making the Time Slots dialog and
 * its swaps fast: each show's seasons worked out once per pool, not once per
 * slot per redraw; the hidden dialog drawing and working out nothing while
 * it isn't shown; catalogs kept between re-lays; and the generator's own
 * throttle running with no `setImmediate`, as a browser Web Worker has none.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const getShowData = require('../web/services/get-show-data')();
const poolSeasons = require('../src/pool-seasons');
const catalogKeep = require('../src/catalog-keep');

const SEC = 1000;
const THU = new Date('2026-10-08T00:00:00').getTime();
const thu = (hour, minute, second) => THU + hour * HOUR + (minute || 0) * MIN + (second || 0) * SEC;

function episode(show, season, n, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    }, extra || {});
}
function pool() {
    const out = [];
    ['A', 'B', 'C'].forEach((show) => { for (let n = 1; n <= 30; n++) { out.push(episode(show, 1 + (n % 3), n)); } });
    return out;
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

    return suite;
};
