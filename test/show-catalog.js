/*
 * src/show-catalog.js: what a show's full catalog adds, the pool a run draws
 * on, and the never-air list with its two reasons. See NOTES.md, Known
 * issues, "Full catalogs, and a never-air list".
 *
 * Fixtures only.
 */
const { MIN, Suite } = require('./support');
const catalog = require('../src/show-catalog');
const getShowData = require('../src/services/get-show-data')();

const SERVER = { name: 'srv', uri: 'http://plex', accessToken: 't' };
function episode(show, season, n, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: 22 * MIN, serverKey: 'srv', key: `/library/metadata/${show.length}${season}${String(n).padStart(3, '0')}`,
        showIcon: `http://plex/library/metadata/9${show.length}/thumb/1?X-Plex-Token=t`,
    }, extra || {});
}
function item(show, i, extra) {
    return Object.assign({ type: 'episode', showTitle: 'Part ' + i, title: `${show} item ${i}`, season: 1, episode: i,
        duration: 11 * MIN, serverKey: 'srv', key: `/library/metadata/77${i}` }, extra || {});
}
const keyOf = (p) => p.serverKey + '|' + p.key;
const titles = (list) => list.map((p) => p.title).join(',');
const NOW = Date.parse('2026-10-10T15:00:00Z');

module.exports = async function () {
    const suite = new Suite('show-catalog');

    suite.log('-- reading a catalog --');
    suite.check('showKeysOf reads the show key from showIcon',
        catalog.showKeysOf([episode('Doug', 1, 1), episode('Doug', 1, 2)]).join() === '94'
            && catalog.showKeysOf([Object.assign(episode('Doug', 1, 1), { showIcon: undefined })]).length === 0);
    {
        const fromLibrary = [Object.assign(episode('Doug (2001)', 1, 1), { server: SERVER, serverKey: undefined, durationStr: '0:22:00' })];
        const copied = catalog.fromPlex(fromLibrary, SERVER, 'Doug');
        suite.check('fromPlex copies items as the library adds them, with the channel\'s show title',
            copied.length === 1 && copied[0].server === undefined && copied[0].serverKey === 'srv' && copied[0].showTitle === 'Doug'
                && fromLibrary[0].server === SERVER, JSON.stringify(copied[0]));
    }
    {
        const show = { id: 'cs1', name: 'Double Dare', content: [item('DD', 1), item('DD', 2)] };
        const stamped = catalog.fromCustom(show);
        suite.check('fromCustom stamps items as addCustomShow does',
            stamped.map((p) => [p.customShowId, p.customShowName, p.customOrder].join('/')).join() === 'cs1/Double Dare/0,cs1/Double Dare/1'
                && show.content[0].customShowId === undefined);
    }

    suite.log('-- what a catalog adds --');
    const doug = [1, 2, 3, 4].map((e) => episode('Doug', 1, e)).concat([episode('Doug', 0, 1)]);
    const lineupDoug = [doug[0], doug[1]];
    {
        const state = catalog.applyOps(catalog.emptyState(), [{ neverAir: [catalog.neverAirEntry(doug[2], getShowData, 'deleted', 'never', undefined, NOW)] }], NOW);
        suite.check('toAdd leaves out what the lineup holds and the never-air list names',
            titles(catalog.toAdd({ items: doug, lineupItems: lineupDoug, state, specials: false })) === 'Doug S1E4');
        suite.check('...and season 0 unless specials',
            titles(catalog.toAdd({ items: doug, lineupItems: lineupDoug, state, specials: true })) === 'Doug S1E4,Doug S0E1'
                && catalog.specialsAllowed(lineupDoug) === false && catalog.specialsAllowed([doug[4]]) === true);
    }

    const wings = [1, 2, 3].map((e) => episode('Wings', 1, e)).concat([1, 2].map((e) => episode('Wings', 2, e)));
    const lineupPool = [doug[0], doug[1], wings[0], { type: 'redirect', channel: 4, duration: MIN, isOffline: true }];
    const catalogs = { 'tv.Doug': { items: doug, source: { plex: 'srv', shows: ['94'] } }, 'tv.Wings': { items: wings, source: { plex: 'srv', shows: ['95'] } } };
    {
        const list = catalog.reviewList({ lineupPool, catalogs, state: catalog.emptyState(), getShowData });
        suite.check('reviewList lists unreviewed shows with something to add, most first, by season',
            list.map((r) => r.showId + ' ' + r.count).join() === 'tv.Wings 4,tv.Doug 2'
                && list[0].seasons.map((s) => s.season + ':' + s.episodes.map((p) => p.episode).join('')).join(' ') === '1:23 2:12',
            JSON.stringify(list.map((r) => [r.showId, r.count])));
        const reviewed = catalog.applyOps(catalog.emptyState(), [{ review: { showId: 'tv.Wings', source: catalogs['tv.Wings'].source, specials: false, known: wings.map(keyOf), neverAir: [] } }], NOW);
        const complete = { 'tv.Doug': { items: lineupDoug, source: {} }, 'tv.Wings': catalogs['tv.Wings'] };
        suite.check('...not reviewed shows, not complete ones',
            catalog.reviewList({ lineupPool, catalogs: complete, state: reviewed, getShowData }).length === 0);
    }

    suite.log('-- the pool a run draws on --');
    const slotted = ['tv.Doug', 'tv.Wings'];
    {
        const state = catalog.applyOps(catalog.emptyState(), [{ neverAir: [catalog.neverAirEntry(doug[1], getShowData, 'deleted', 'never', undefined, NOW)] }], NOW);
        const run = catalog.poolFor({ lineupPool, slotted, catalogs, state, getShowData });
        suite.check('poolFor with nothing reviewed is the lineup pool, less the never-air list',
            run.pool.length === 3 && run.pool[0] === doug[0] && run.pool[1] === wings[0] && run.pool[2] === lineupPool[3]
                && Object.keys(run.fresh).length === 0, titles(run.pool));
    }
    {
        const state = catalog.applyOps(catalog.emptyState(), [{ review: { showId: 'tv.Doug', source: catalogs['tv.Doug'].source, specials: false, known: doug.map(keyOf), neverAir: [] } }], NOW);
        const fresh = doug.map((p) => Object.assign({}, p));
        const run = catalog.poolFor({ lineupPool, slotted, catalogs: Object.assign({}, catalogs, { 'tv.Doug': { items: fresh, source: {} } }), state, getShowData });
        const dougs = run.pool.filter((p) => p.showTitle === 'Doug');
        suite.check('poolFor keeps a reviewed Plex show\'s lineup copies and adds its other catalog episodes',
            dougs[0] === doug[0] && dougs[1] === doug[1] && titles(dougs) === 'Doug S1E1,Doug S1E2,Doug S1E3,Doug S1E4', titles(dougs));
    }
    {
        const old = [item('DD', 1), item('DD', 2)].map((p, i) => Object.assign(p, { customShowId: 'cs1', customShowName: 'DD', customOrder: i }));
        const now = catalog.fromCustom({ id: 'cs1', name: 'DD', content: [item('DD', 3), item('DD', 2), item('DD', 1)] });
        const state = catalog.applyOps(catalog.emptyState(), [{ review: { showId: 'custom.cs1', source: { custom: 'cs1' }, specials: true, known: now.map(keyOf), neverAir: [] } }], NOW);
        const run = catalog.poolFor({ lineupPool: old, slotted: ['custom.cs1'], catalogs: { 'custom.cs1': { items: now, source: { custom: 'cs1' } } }, state, getShowData });
        suite.check('poolFor takes a reviewed custom show\'s current list and order',
            run.pool.map((p) => p.title + '@' + p.customOrder).join() === 'DD item 3@0,DD item 2@1,DD item 1@2', run.pool.map((p) => p.title + '@' + p.customOrder).join());
    }
    {
        const state = catalog.applyOps(catalog.emptyState(), [{ review: { showId: 'tv.Doug', source: {}, specials: false, known: doug.map(keyOf), neverAir: [] } }], NOW);
        const run = catalog.poolFor({ lineupPool, slotted, catalogs: { 'tv.Doug': { error: 'Plex timed out' }, 'tv.Wings': catalogs['tv.Wings'] }, state, getShowData });
        suite.check('poolFor falls back to the lineup for a show it couldn\'t read, and names it',
            titles(run.pool.filter((p) => p.showTitle === 'Doug')) === 'Doug S1E1,Doug S1E2'
                && JSON.stringify(run.fellBack) === JSON.stringify([{ showId: 'tv.Doug', reason: 'Plex timed out' }]), JSON.stringify(run.fellBack));
    }
    {
        const state = catalog.applyOps(catalog.emptyState(), [{ review: { showId: 'tv.Wings', source: {}, specials: false, known: wings.slice(0, 4).map(keyOf), neverAir: [] } }], NOW);
        const run = catalog.poolFor({ lineupPool, slotted, catalogs: { 'tv.Doug': { items: lineupDoug, source: {} }, 'tv.Wings': catalogs['tv.Wings'] }, state, getShowData });
        suite.check('poolFor names new episodes of reviewed shows, and marks complete shows',
            titles(run.fresh['tv.Wings'] || []) === 'Wings S2E2' && run.pool.includes(wings[4])
                && run.complete.join() === 'tv.Doug' && run.known['tv.Wings'].length === 5 && run.known['tv.Doug'].length === 2,
            JSON.stringify({ fresh: Object.keys(run.fresh), complete: run.complete }));
    }

    {
        // A catalog read that came back short - Plex lost the show, or listed nothing - isn't "complete".
        const run = catalog.poolFor({ lineupPool, slotted, catalogs: { 'tv.Doug': { items: [], source: {} }, 'tv.Wings': { items: [wings[0]], source: {} } }, state: catalog.emptyState(), getShowData });
        suite.check('a show is complete only when its catalog holds its whole lineup', run.complete.join() === 'tv.Wings', run.complete.join());
    }
    {
        // A re-roll shows no notes: newcomers it didn't name stay new for the next dialog.
        const state = catalog.applyOps(catalog.emptyState(), [{ review: { showId: 'tv.Wings', source: {}, specials: false, known: wings.slice(0, 4).map(keyOf), neverAir: [] } }], NOW);
        const run = catalog.poolFor({ lineupPool, slotted, catalogs: { 'tv.Doug': { items: lineupDoug, source: {} }, 'tv.Wings': catalogs['tv.Wings'] }, state, getShowData });
        const shown = catalog.knownAfter(run, true), unshown = catalog.knownAfter(run, false);
        suite.check('knownAfter keeps newcomers new when they weren\'t named',
            shown['tv.Wings'].length === 5 && unshown['tv.Wings'].length === 4 && !unshown['tv.Wings'].includes(keyOf(wings[4])) && unshown['tv.Doug'].length === 2,
            JSON.stringify({ shown: shown['tv.Wings'].length, unshown: unshown['tv.Wings'].length }));
    }
    {
        // The Catalog page rebuilds its rows after every save; what Ron ticked on other shows survives.
        const state = catalog.emptyState();
        const before = catalog.reviewList({ lineupPool, catalogs, state, getShowData });
        const wingsRow = before.find((r) => r.showId === 'tv.Wings');
        const choices = { 'tv.Wings': { open: true, episodes: { [keyOf(wings[1])]: { ticked: false, touched: true, reason: 'holiday', holiday: 'Easter' } } } };
        const after = catalog.reviewList({ lineupPool, catalogs, state, getShowData });
        const carried = catalog.carryChoices(choices, after);
        const w = carried.find((r) => r.showId === 'tv.Wings');
        const e = w.seasons[0].episodes.find((p) => keyOf(p) === keyOf(wings[1]));
        suite.check('carryChoices keeps a row open and its unsaved choices across a rebuild',
            wingsRow && w.open === true && w.choices[keyOf(wings[1])].ticked === false && w.choices[keyOf(wings[1])].holiday === 'Easter' && e !== undefined,
            JSON.stringify(w && w.choices));
    }

    suite.log('-- the list --');
    {
        const ops = [
            { review: { showId: 'tv.Doug', source: { plex: 'srv', shows: ['94'] }, specials: false, known: doug.map(keyOf), neverAir: [catalog.neverAirEntry(doug[3], getShowData, 'review', 'holiday', 'Christmas', NOW)] } },
            { neverAir: [catalog.neverAirEntry(wings[1], getShowData, 'deleted', 'never', undefined, NOW)] },
            { restore: [keyOf(wings[1])] },
            { known: { 'tv.Doug': [keyOf(doug[0])] } },
            { reason: { key: keyOf(doug[3]), reason: 'never' } },
        ];
        const before = catalog.emptyState();
        const after = catalog.applyOps(before, ops, NOW);
        const e = after.neverAir[keyOf(doug[3])];
        suite.check('applyOps: review, never air, restore, known and reason, in order',
            after.shows['tv.Doug'].by === 'review' && after.shows['tv.Doug'].reviewedAt === new Date(NOW).toISOString()
                && after.shows['tv.Doug'].known.length === 1 && Object.keys(after.neverAir).length === 1
                && e.reason === 'never' && e.holiday === undefined && e.how === 'review' && e.season === 1 && e.episode === 4 && e.duration === 22 * MIN
                && Object.keys(before.neverAir).length === 0, JSON.stringify(after.neverAir));
        let threw = false;
        try { catalog.applyOps(before, [{ explode: true }], NOW); } catch (err) { threw = true; }
        suite.check('...an unknown op throws', threw);
        suite.check('stateOf is a copy, empty when a channel has none',
            JSON.stringify(catalog.stateOf({})) === JSON.stringify(catalog.emptyState()) && catalog.stateOf({ catalog: after }) !== after
                && catalog.isNeverAir(after, doug[3]) && ! catalog.isNeverAir(after, doug[0])
                && titles(catalog.withoutNeverAir(doug, after)) === 'Doug S1E1,Doug S1E2,Doug S1E3,Doug S0E1');
    }

    suite.log('-- holidays and long episodes --');
    {
        const found = ['A Rugrats Chanukah', 'Santa Claws', 'The Trick-or-Treaters', 'Be My Valentine', "New Year's Eve", 'The Thanksgiving Show',
            'Easter Egg Hunt', "St. Patrick's Day", 'The Fourth of July', "Mother's Day", 'Groundhog Day', 'April Fools'].map(catalog.holidayOf);
        suite.check('holidayOf finds each holiday by its words',
            found.join() === "Hanukkah,Christmas,Halloween,Valentine's,New Year,Thanksgiving,Easter,St. Patrick's,Fourth of July,Mother's Day,Groundhog Day,April Fools'", found.join());
        suite.check('...and not inside other words',
            ['Eastern Promise', 'Cupidity', 'Santana', 'Pilgrimage Road'].map(catalog.holidayOf).every((h) => h === null));
        suite.check('...curly apostrophes too', catalog.holidayOf('Mother’s Day') === "Mother's Day");
        // Titles from Ron's own review lists that the first words missed (final review, Oct 10).
        const missed = { 'Turkey Jerky': 'Thanksgiving', "Ed, Edd n Eddy's Jingle Jingle Jangle": 'Christmas', 'Road to the North Pole': 'Christmas',
            'The Futurama Holiday Spectacular': 'Christmas', 'Deck the Halls': 'Christmas', 'Deck the Malls': 'Christmas', 'For Whom the Jingle Bell Tolls': 'Christmas',
            'Home for the Holidays': 'Christmas', 'A Rugrats Kwanzaa': 'Kwanzaa', 'Seven Days of Kwanzaa': 'Kwanzaa', 'A London Carol': 'Christmas',
            "It's the Great Pumpkin, Juniper Lee": 'Halloween', 'Night of The Day of the Dead': 'Halloween', 'Labor Day': 'Labor Day',
            'The Turkey Who Came to Dinner': 'Thanksgiving', 'Krampus Night': 'Christmas', 'Passover Story': 'Passover', 'Memorial Day': 'Memorial Day' };
        const got = Object.keys(missed).filter((t) => catalog.holidayOf(t) !== missed[t]).map((t) => `${t} -> ${catalog.holidayOf(t)}`);
        suite.check('...and the words Ron\'s lists use', got.length === 0, got.join('; '));
        suite.check('...still not inside other words', ['Elfman Returns', 'Carolina Blues', 'Laborious', 'Deckhand'].map(catalog.holidayOf).every((h) => h === null));
        const xmasLong = episode('Doug', 1, 9, { title: "Doug's Christmas Story", duration: 44 * MIN });
        const long = episode('Doug', 1, 10, { title: 'Doug Takes the Case', duration: 31 * MIN + 20 * 1000 });
        const a = catalog.preUntick(xmasLong, catalog.DEFAULT_LIMIT_MS), b = catalog.preUntick(long, catalog.DEFAULT_LIMIT_MS);
        suite.check('preUntick: a holiday title before length; longer than the limit; neither',
            a.reason === 'holiday' && a.holiday === 'Christmas' && /Christmas/.test(a.why)
                && b.reason === 'never' && b.why === '31:20, longer than 30:00'
                && catalog.preUntick(doug[0], catalog.DEFAULT_LIMIT_MS) === null && catalog.preUntick(long, 45 * MIN) === null,
            JSON.stringify([a, b]));
    }
    {
        const ops = [{ neverAir: [
            catalog.neverAirEntry(episode('Doug', 1, 5, { title: 'Halloween' }), getShowData, 'review', 'holiday', 'Halloween', NOW),
            catalog.neverAirEntry(episode('Wings', 1, 5, { title: 'Wings Xmas' }), getShowData, 'review', 'holiday', 'Christmas', NOW),
            catalog.neverAirEntry(episode('Doug', 1, 6, { title: 'Doug Xmas' }), getShowData, 'review', 'holiday', 'Christmas', NOW),
            catalog.neverAirEntry(episode('Doug', 1, 7), getShowData, 'deleted', 'never', undefined, NOW),
        ] }];
        const groups = catalog.byHoliday(catalog.applyOps(catalog.emptyState(), ops, NOW));
        suite.check('byHoliday groups holiday entries by holiday, then show',
            groups.map((g) => g.holiday + ':' + g.shows.map((s) => s.showId + '=' + s.entries.length).join('+')).join(' ')
                === 'Christmas:tv.Doug=1+tv.Wings=1 Halloween:tv.Doug=1', JSON.stringify(groups.map((g) => [g.holiday, g.shows.map((s) => s.showId)])));
    }

    return suite;
};
