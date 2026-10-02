/*
 * Stage 5, step 1: situations and assembly (src/transitions.js), and the
 * save-time warning for the stored shape. See docs/blocks-spec.md, Stage 5,
 * "Situations and assembly".
 *
 * Everything here is fixtures: no data folder, no server. The channel below is
 * built so that each of the four situations turns up at a known break, with the
 * contexts overlapping the lineup the way the spec's real channels do - a
 * day-part running all week and a block cutting into it.
 *
 *   Friday, the machine's own zone (like every fixture in this suite):
 *
 *     20:00  Alpha 1          day-part "Day"
 *     20:30  Flex 3m          break 1: same show  -> between episodes
 *     20:33  Alpha 2
 *     21:03  Flex 2m + 2m     break 2: Day -> Late (two Flex entries, one break)
 *     21:07  Beta             block "Late" (Fri 21:00-23:00)
 *     21:37  Flex 3m          break 3: different show, same context -> between shows
 *     21:40  Gamma
 *     22:10  Delta            (no Flex between Gamma and Delta: no break)
 *     22:59  Flex 3m          break 4: Late -> Day
 *     23:02  Short 1 (custom show)
 *     23:32  Flex 3m          break 5: two items of one custom show -> between episodes
 *     23:35  Short 2 (custom show)
 */
const { MIN, HOUR, at, flex, mix, Suite } = require('./support');
const transitions = require('../src/transitions');
const ChannelDB = require('../src/dao/channel-db');

function episode(show, n, mins) {
    return { title: `${show} ${n}`, key: `/e/${show}${n}`, type: 'episode', showTitle: show,
        season: 1, episode: n, duration: mins * MIN, serverKey: 'srv' };
}
function short(id, name, mins) {
    return { title: name, key: `/s/${name}`, type: 'episode', showTitle: 'Looney Tunes',
        customShowId: id, customShowName: 'Looney Tunes', duration: mins * MIN, serverKey: 'srv' };
}
function movie(title, mins) {
    return { title, key: `/m/${title}`, type: 'movie', duration: mins * MIN, serverKey: 'srv' };
}
function step(id, extra) {
    return Object.assign({ id, kind: 'list', listId: 'list-' + id, match: 'any',
        keyedOn: 'next', fallbackListId: null }, extra || {});
}
function situationsOf(spec) {
    // spec: { leaving: [out, in], ... } each side an array of step ids
    const out = {};
    for (const name of Object.keys(spec)) {
        out[name] = { out: spec[name][0].map((i) => step(i)), in: spec[name][1].map((i) => step(i)) };
    }
    return out;
}
const ids = (entries) => entries.map((e) => e.step.id);

function fixtureChannel() {
    const programs = [
        episode('Alpha', 1, 30), flex(3), episode('Alpha', 2, 30),
        flex(2), flex(2),
        episode('Beta', 1, 30), flex(3), episode('Gamma', 1, 30),
        episode('Delta', 1, 49),
        flex(3), short('shorts', 'Duck Dodgers', 30), flex(3), short('shorts', 'Rabbit Seasoning', 30),
    ];
    return {
        number: 7, name: 'Transitions', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
        fillerCollections: [],
        dayParts: [{
            id: 'day', name: 'Day', fillerCollections: mix([['A', 100]]),
            starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 6 * HOUR }],
            transitions: situationsOf({
                leaving: [['d-lv-out'], ['d-lv-in']],
                entering: [['d-en-out'], ['d-en-in']],
                betweenEpisodes: [['d-be-out'], ['d-be-in']],
            }),
        }],
        blocks: [{
            id: 'late', name: 'Late', fillerCollections: mix([['B', 100]]),
            airings: [{ days: [5], start: 21 * HOUR, end: 23 * HOUR }],
            transitions: situationsOf({
                leaving: [['l-lv-out'], ['l-lv-in']],
                entering: [['l-en-out'], ['l-en-in']],
                betweenShows: [['l-bs-out'], ['l-bs-in']],
            }),
        }],
        programs,
        duration: programs.reduce((a, p) => a + p.duration, 0),
        startTime: new Date(at('2026-10-02T20:00:00')).toISOString(),
    };
}

module.exports = async function run() {
    const suite = new Suite('transitions');
    const start = at('2026-10-02T20:00:00');

    // ---- show keys -----------------------------------------------------------
    {
        const key = transitions.showKey;
        suite.check('an episode is keyed by its show title', key(episode('Alpha', 1, 30)) === 'tv.Alpha');
        suite.check('two episodes of one show share a key', key(episode('Alpha', 1, 30)) === key(episode('Alpha', 9, 22)));
        suite.check('an item of a custom show is keyed by the custom show',
            key(short('shorts', 'Duck Dodgers', 7)) === 'custom.shorts');
        suite.check('a custom show counts as one show, whatever its items are called',
            key(short('shorts', 'Duck Dodgers', 7)) === key(short('shorts', 'Rabbit Seasoning', 7)));
        suite.check('the custom show wins over the item\'s own show title',
            key(short('shorts', 'x', 7)) !== 'tv.Looney Tunes');
        suite.check('a movie is keyed by its own title', key(movie('Heat', 120)) === 'movie.Heat');
        suite.check('two different movies are different shows', key(movie('Heat', 120)) !== key(movie('Ronin', 120)));
        suite.check('Flex has no show', transitions.showKey(flex(3)) === null);
    }

    // ---- finding a break -----------------------------------------------------
    {
        const channel = fixtureChannel();
        const brk = transitions.findBreak(channel, 3, start + 63 * MIN);   // the first of break 2's two Flex entries
        suite.check('a break of two adjacent Flex entries is one break',
            brk.firstFlex === 3 && brk.lastFlex === 4 && brk.flexCount === 2,
            JSON.stringify([brk.firstFlex, brk.lastFlex, brk.flexCount]));
        suite.check('its neighbours are the programs either side',
            brk.prev.index === 2 && brk.next.index === 5);
        suite.check('it starts where the show ends and ends where the next begins',
            brk.startTime === start + 63 * MIN && brk.endTime === start + 67 * MIN);
        suite.check('the neighbours carry their own start times',
            brk.prev.startTime === start + 33 * MIN && brk.next.startTime === start + 67 * MIN);

        const second = transitions.findBreak(channel, 4, start + 65 * MIN);   // the same break, entered from its second entry
        suite.check('entering a break from its second Flex entry finds the same break',
            second.firstFlex === 3 && second.startTime === brk.startTime && second.endTime === brk.endTime);

        let threw = false;
        try { transitions.findBreak(channel, 0, start); } catch (err) { threw = true; }
        suite.check('asking for the break around a real program is an error, not a guess', threw);
    }

    // ---- the lineup wraps ----------------------------------------------------
    {
        const programs = [flex(2), flex(2), episode('Alpha', 1, 30), episode('Beta', 1, 30)];
        const channel = { number: 8, programs, dayParts: [], blocks: [],
            duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(start).toISOString() };
        const brk = transitions.findBreak(channel, 0, start);
        suite.check('a break at the head of the lineup takes the last program as the one before it',
            brk.prev !== null && brk.prev.index === 3 && brk.next.index === 2,
            JSON.stringify([brk.prev && brk.prev.index, brk.next && brk.next.index]));
        suite.check('and counts the wrapped program\'s start back from the break',
            brk.prev.startTime === start - 30 * MIN);
        suite.check('Beta then Alpha are different shows, so that break is between shows',
            transitions.assemble(channel, brk).situation === 'betweenShows');
    }

    // ---- no real program at all ---------------------------------------------
    {
        const programs = [flex(10), flex(10)];
        const channel = { number: 9, programs, duration: 20 * MIN, startTime: new Date(start).toISOString() };
        const brk = transitions.findBreak(channel, 1, start + 10 * MIN);
        const plan = transitions.assemble(channel, brk);
        suite.check('an all-Flex channel has no neighbour on either side', brk.prev === null && brk.next === null);
        suite.check('and so no situation and nothing to play',
            plan.situation === 'none' && plan.out.length === 0 && plan.in.length === 0);
    }

    // ---- the four situations, and what each assembles -----------------------
    {
        const channel = fixtureChannel();
        const at1 = (index, minutes) => transitions.findBreak(channel, index, start + minutes * MIN);

        const b1 = transitions.assemble(channel, at1(1, 30));
        suite.check('break 1: the same show in one context is between episodes', b1.situation === 'betweenEpisodes', b1.situation);
        suite.check('break 1 plays the context\'s between-episodes steps, out then in',
            ids(b1.out).join() === 'd-be-out' && ids(b1.in).join() === 'd-be-in',
            `${ids(b1.out)} | ${ids(b1.in)}`);

        const b2 = transitions.assemble(channel, at1(3, 63));
        suite.check('break 2: a different context on each side is a boundary', b2.situation === 'boundary', b2.situation);
        suite.check('a boundary plays P.leaving.out, N.entering.out, Flex, P.leaving.in, N.entering.in',
            ids(b2.out).join() === 'd-lv-out,l-en-out' && ids(b2.in).join() === 'd-lv-in,l-en-in',
            `${ids(b2.out)} | ${ids(b2.in)}`);
        suite.check('and says which context each step came from',
            b2.out[0].context.name === 'Day' && b2.out[0].situation === 'leaving'
            && b2.out[1].context.name === 'Late' && b2.out[1].situation === 'entering');
        suite.check('a boundary never fires either context\'s between-shows or between-episodes steps',
            ids(b2.out).concat(ids(b2.in)).every((i) => !/-b[es]-/.test(i)));

        const b3 = transitions.assemble(channel, at1(6, 97));
        suite.check('break 3: a different show in one context is between shows', b3.situation === 'betweenShows', b3.situation);
        suite.check('break 3 plays the block\'s between-shows steps, and not the day-part\'s',
            ids(b3.out).join() === 'l-bs-out' && ids(b3.in).join() === 'l-bs-in', `${ids(b3.out)} | ${ids(b3.in)}`);

        const b4 = transitions.assemble(channel, at1(9, 179));
        suite.check('break 4: leaving a block into a day-part is a boundary', b4.situation === 'boundary', b4.situation);
        suite.check('break 4 plays the block\'s leaving then the day-part\'s entering',
            ids(b4.out).join() === 'l-lv-out,d-en-out' && ids(b4.in).join() === 'l-lv-in,d-en-in',
            `${ids(b4.out)} | ${ids(b4.in)}`);

        const b5 = transitions.assemble(channel, at1(11, 212));
        suite.check('break 5: two items of one custom show are between episodes, not between shows',
            b5.situation === 'betweenEpisodes', b5.situation);

        const noFlex = transitions.breaksBetween(channel, start, start + 100 * MIN)
            .filter((b) => b.prev && b.prev.index === 7);
        suite.check('two programs with no Flex between them make no break at all', noFlex.length === 0);
    }

    // ---- one side missing ----------------------------------------------------
    {
        const channel = fixtureChannel();
        // A lineup that is one show and a break: the show is both P and N across the wrap.
        const lone = { number: 11, programs: [episode('Alpha', 1, 30), flex(5)], dayParts: channel.dayParts,
            blocks: channel.blocks, duration: 35 * MIN, startTime: new Date(start).toISOString() };
        const brk = transitions.findBreak(lone, 1, start + 30 * MIN);
        suite.check('a lineup of one show wraps to that show on both sides',
            brk.prev.index === 0 && brk.next.index === 0);

        // Hand a break one neighbour to prove a missing side contributes nothing.
        const half = Object.assign({}, transitions.findBreak(channel, 3, start + 63 * MIN), { prev: null });
        const plan = transitions.assemble(channel, half);
        suite.check('with no program before it, a break fires only the incoming context\'s Entering',
            plan.situation === 'boundary' && ids(plan.out).join() === 'l-en-out' && ids(plan.in).join() === 'l-en-in',
            `${plan.situation} ${ids(plan.out)} | ${ids(plan.in)}`);
        const other = Object.assign({}, transitions.findBreak(channel, 3, start + 63 * MIN), { next: null });
        const plan2 = transitions.assemble(channel, other);
        suite.check('with no program after it, only the outgoing context\'s Leaving',
            plan2.situation === 'boundary' && ids(plan2.out).join() === 'd-lv-out' && ids(plan2.in).join() === 'd-lv-in');
    }

    // ---- breaks over a stretch of time --------------------------------------
    {
        const channel = fixtureChannel();
        const all = transitions.breaksBetween(channel, start, start + channel.duration);
        const kinds = all.map((b) => transitions.assemble(channel, b).situation);
        suite.check('one trip round the lineup finds all five breaks, in order',
            kinds.join() === 'betweenEpisodes,boundary,betweenShows,boundary,betweenEpisodes', kinds.join());
        suite.check('a break counts when it starts inside the window',
            transitions.breaksBetween(channel, start + 31 * MIN, start + 100 * MIN).length === 2);
        suite.check('a window that opens inside a break does not count that break',
            transitions.breaksBetween(channel, start + 31 * MIN, start + 62 * MIN).length === 0);
        const second = transitions.breaksBetween(channel, start + channel.duration, start + 2 * channel.duration);
        suite.check('the lineup repeats: a second trip round finds five breaks again', second.length === 5);
        suite.check('and its first break starts one full lineup later',
            second[0].startTime === all[0].startTime + channel.duration);
    }

    // ---- stored shape and its defaults --------------------------------------
    {
        const empty = transitions.normalizeTransitions(undefined);
        suite.check('no transitions field reads as four empty situations',
            transitions.SITUATIONS.every((s) => Array.isArray(empty[s].out) && empty[s].out.length === 0
                && Array.isArray(empty[s].in) && empty[s].in.length === 0)
            && Object.keys(empty).length === 4, Object.keys(empty).join());
        suite.check('a null context reads the same', Object.keys(transitions.normalizeTransitions(null)).length === 4);

        const a = transitions.normalizeTransitions(undefined);
        a.leaving.out.push('x');
        suite.check('every read hands back fresh arrays', transitions.normalizeTransitions(undefined).leaving.out.length === 0);

        const context = { name: 'X', transitions: { betweenShows: { out: [{ id: 's', listId: 'L' }], in: 'junk' }, nonsense: {} } };
        const before = JSON.stringify(context);
        const read = transitions.normalizeTransitions(context);
        suite.check('reading fills a step\'s missing fields with the spec\'s defaults',
            read.betweenShows.out[0].kind === 'list' && read.betweenShows.out[0].match === 'any'
            && read.betweenShows.out[0].keyedOn === 'next' && read.betweenShows.out[0].fallbackListId === null
            && read.betweenShows.out[0].listId === 'L');
        suite.check('a side that is not an array reads as empty, and an unknown situation is dropped',
            read.betweenShows.in.length === 0 && typeof read.nonsense === 'undefined');
        suite.check('reading rewrites nothing', JSON.stringify(context) === before);

        const bare = { number: 12, name: 'Bare', programs: fixtureChannel().programs, dayParts: [{ name: 'D', starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] }],
            duration: fixtureChannel().duration, startTime: new Date(start).toISOString() };
        const plans = transitions.breaksBetween(bare, start, start + bare.duration)
            .map((b) => transitions.assemble(bare, b));
        suite.check('a channel that has never heard of transitions assembles nothing at any break',
            plans.length === 5 && plans.every((p) => p.out.length === 0 && p.in.length === 0));
        suite.check('and has not been given a transitions field by being read', typeof bare.dayParts[0].transitions === 'undefined');
    }

    // ---- the save-time warning ----------------------------------------------
    {
        const db = new ChannelDB('unused');
        function warningsFor(contextFields) {
            const lines = [];
            const real = console.error;
            console.error = (...args) => lines.push(args.join(' '));
            try {
                db.validateChannelJson(7, { dayParts: [Object.assign({ name: 'D',
                    starts: [{ days: [1], time: 0 }] }, contextFields)] });
            } finally {
                console.error = real;
            }
            return lines.filter((l) => /ransition/.test(l));
        }
        suite.check('a context without transitions is not warned about', warningsFor({}).length === 0);
        suite.check('a good shape is not warned about',
            warningsFor({ transitions: situationsOf({ leaving: [['a'], ['b']] }) }).length === 0);
        suite.check('transitions that is not an object is warned about',
            warningsFor({ transitions: 'soon' }).length === 1);
        suite.check('an unknown situation is warned about',
            warningsFor({ transitions: { betweenAds: { out: [], in: [] } } }).length === 1);
        suite.check('a side that is not an array is warned about',
            warningsFor({ transitions: { leaving: { out: {}, in: [] } } }).length === 1);
        suite.check('a step with no list is warned about',
            warningsFor({ transitions: { leaving: { out: [{ id: 'a', kind: 'list', match: 'any' }], in: [] } } }).length === 1);
        suite.check('an unknown match is warned about',
            warningsFor({ transitions: { leaving: { out: [step('a', { match: 'sometimes' })], in: [] } } }).length === 1);
        suite.check('an unknown keyedOn is warned about',
            warningsFor({ transitions: { leaving: { out: [step('a', { keyedOn: 'never' })], in: [] } } }).length === 1);
        suite.check('an unknown kind is warned about',
            warningsFor({ transitions: { leaving: { out: [step('a', { kind: 'video' })], in: [] } } }).length === 1);
        suite.check('the reserved "later" and "generated" are accepted',
            warningsFor({ transitions: { leaving: { out: [step('a', { keyedOn: 'later' }),
                { id: 'g', kind: 'generated', template: 'up-next', durationMs: 5000 }], in: [] } } }).length === 0);

        const lines = [];
        const real = console.error;
        console.error = (...args) => lines.push(args.join(' '));
        const channel = { blocks: [{ name: 'B', airings: [{ days: [1], start: 0, end: HOUR }], transitions: 7 }] };
        try { db.validateChannelJson(7, channel); } finally { console.error = real; }
        suite.check('a block\'s transitions are checked too, and the warning names the block',
            lines.filter((l) => /ransition/.test(l) && /block 0/.test(l)).length === 1, lines.join(' | '));
        suite.check('warning rewrites nothing', channel.blocks[0].transitions === 7);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
