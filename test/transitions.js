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
const { MIN, HOUR, DAY, at, flex, mix, Suite } = require('./support');
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
            && read.betweenShows.out[0].listId === 'L' && read.betweenShows.out[0].onlyIfNothingAbove === false);
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
        suite.check('"later" and a generated card step naming its template are accepted',
            warningsFor({ transitions: { leaving: { out: [step('a', { keyedOn: 'later' }),
                { id: 'g', kind: 'generated', templateId: 'tpl_1', keyedOn: 'later' }], in: [] } } }).length === 0);
        suite.check('a generated card step that names no template is warned about',
            warningsFor({ transitions: { leaving: { out: [{ id: 'g', kind: 'generated', keyedOn: 'later' }], in: [] } } }).length === 1);

        const lines = [];
        const real = console.error;
        console.error = (...args) => lines.push(args.join(' '));
        const channel = { blocks: [{ name: 'B', airings: [{ days: [1], start: 0, end: HOUR }], transitions: 7 }] };
        try { db.validateChannelJson(7, channel); } finally { console.error = real; }
        suite.check('a block\'s transitions are checked too, and the warning names the block',
            lines.filter((l) => /ransition/.test(l) && /block 0/.test(l)).length === 1, lines.join(' | '));
        suite.check('warning rewrites nothing', channel.blocks[0].transitions === 7);

        const mark = (value) => warningsFor({ transitions: { betweenShows: {
            out: [step('up'), step('w', { onlyIfNoMatch: value })], in: [] } } });
        suite.check('a step marked to watch a real step is not warned about', mark('up').length === 0);
        suite.check('an empty or false mark means "not marked", and is not warned about',
            mark('').length === 0 && mark(false).length === 0 && mark(null).length === 0);
        suite.check('a mark that is not a step id (true, a number) is warned about',
            mark(true).length === 1 && mark(3).length === 1);
        suite.check('a mark naming no step of the situation is warned about', mark('nope').length === 1);
        suite.check('a step that watches itself is warned about', mark('w').length === 1);
        suite.check('a step watching a step on the other side of its Flex is fine',
            warningsFor({ transitions: { betweenShows: { out: [step('up')], in: [step('w', { onlyIfNoMatch: 'up' })] } } }).length === 0);
        suite.check('a step watching a step of another situation is warned about',
            warningsFor({ transitions: { betweenShows: { out: [step('w', { onlyIfNoMatch: 'up' })], in: [] },
                betweenEpisodes: { out: [step('up')], in: [] } } }).length === 1);
        suite.check('a step watching a marked step is warned about',
            warningsFor({ transitions: { betweenShows: { out: [step('up'), step('a', { onlyIfNoMatch: 'up' }),
                step('b', { onlyIfNoMatch: 'a' })], in: [] } } }).length === 1);
        suite.check('a watched id used twice is warned about, once for each watcher',
            warningsFor({ transitions: { betweenShows: { out: [step('up'), step('up'), step('w', { onlyIfNoMatch: 'up' })], in: [] } } }).length === 1);

        // onlyIfNothingAbove: a cascade step names no step, so it has nothing to dangle.
        suite.check('a cascade step is not warned about, alone or first in its side',
            warningsFor({ transitions: { betweenShows: { out: [step('a', { onlyIfNothingAbove: true })], in: [] } } }).length === 0);
        suite.check('a cascade step later in its side is not warned about either',
            warningsFor({ transitions: { betweenShows: {
                out: [step('up'), step('a', { onlyIfNothingAbove: true }), step('b', { onlyIfNothingAbove: true })], in: [] } } }).length === 0);
        suite.check('a step cannot watch a cascade step by id either: it is conditional too',
            warningsFor({ transitions: { betweenShows: {
                out: [step('a', { onlyIfNothingAbove: true }), step('b', { onlyIfNoMatch: 'a' })], in: [] } } }).length === 1);
        suite.check('onlyIfNothingAbove wins over a leftover onlyIfNoMatch on the same (hand-edited) step',
            warningsFor({ transitions: { betweenShows: {
                out: [step('a', { onlyIfNothingAbove: true, onlyIfNoMatch: 'ghost' })], in: [] } } }).length === 0);
    }

    // ---- the show after the next one ----------------------------------------
    {
        const programs = [episode('Alpha', 1, 30), flex(5), episode('Beta', 1, 30), flex(5), episode('Beta', 2, 30),
            flex(5), flex(5), episode('Gamma', 1, 30), flex(5)];
        const channel = { number: 13, programs, dayParts: [], blocks: [],
            duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(start).toISOString() };
        const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
        suite.check('the show after the next one skips the next show\'s own other episodes and all Flex',
            transitions.showAfter(channel, brk) === 'tv.Gamma', String(transitions.showAfter(channel, brk)));
        const wrap = transitions.findBreak(channel, 8, start + 30 * MIN + 5 * MIN + 30 * MIN + 5 * MIN + 30 * MIN + 10 * MIN + 30 * MIN);
        suite.check('and wraps round the cyclic lineup', transitions.showAfter(channel, wrap) === 'tv.Beta',
            String(transitions.showAfter(channel, wrap)));
        const one = [episode('Alpha', 1, 30), flex(5), episode('Alpha', 2, 30), flex(5)];
        const lone = { number: 14, programs: one, dayParts: [], blocks: [], duration: 70 * MIN, startTime: new Date(start).toISOString() };
        suite.check('a lineup of one show has no show after it',
            transitions.showAfter(lone, transitions.findBreak(lone, 1, start + 30 * MIN)) === null);
        suite.check('a break with no next program has none either',
            transitions.showAfter(channel, Object.assign({}, brk, { next: null })) === null);
    }

    // ---- plans: which clip each step plays ----------------------------------
    {
        const T = 1000;
        const clipOf = (title, secs, names) => Object.assign({ title, key: '/c/' + title, serverKey: 'srv',
            duration: secs * T }, (typeof names === 'undefined') ? {} : { names });
        // Alpha -> Beta, and Gamma after Beta: P = tv.Alpha, N = tv.Beta, then = tv.Gamma.
        const programs = [episode('Alpha', 1, 30), flex(5), episode('Beta', 1, 30), flex(5), episode('Gamma', 1, 30), flex(5)];
        const channelWith = (situationSpec, situation) => ({
            number: 15, name: 'Plans', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
            dayParts: [{ id: 'd', name: 'D', fillerCollections: mix([['A', 100]]),
                starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }],
                transitions: { [situation || 'betweenShows']: situationSpec } }],
            programs: programs, duration: programs.reduce((a, p) => a + p.duration, 0),
            startTime: new Date(start).toISOString(),
        });
        const env = (lists, played) => ({
            getList: (id) => lists[id] || null,
            lastPlayed: (c) => (played || {})[c.title] || 0,
        });
        // out/in: arrays of steps. Returns the plan for the Alpha -> Beta break.
        function planFor(out, inn, lists, played) {
            const channel = channelWith({ out: out, in: inn });
            const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
            return transitions.buildPlan(channel, brk, env(lists, played));
        }
        const S = (id, listId, extra) => step(id, Object.assign({ listId: listId }, extra || {}));
        const titles = (side) => side.map((s) => s.clip.title).join(' | ');

        // -- show steps
        {
            const lists = { U: [clipOf('Up Alpha', 10, ['tv.Alpha']), clipOf('Up Beta', 10, ['tv.Beta']),
                clipOf('Up Gamma', 10, ['tv.Gamma']), clipOf('Generic', 10)] };
            const p = planFor([S('up', 'U', { match: 'show' })], [], lists);
            suite.check('a show step keyed on next plays the clip naming the next show, and no other',
                titles(p.out) === 'Up Beta' && p.out[0].via === 'show', titles(p.out));
            suite.check('a general clip is not "naming the show", so a show step does not take it',
                planFor([S('up', 'U', { match: 'show' })], [], { U: [clipOf('Generic', 10)] }).out.length === 0);
            const q = planFor([S('up', 'U', { match: 'show' })], [], { U: [clipOf('Up Gamma', 10, ['tv.Gamma'])] });
            suite.check('with no clip naming it and no fallback the step is skipped, and that is not a problem',
                q.out.length === 0 && q.skipped.length === 1 && q.skipped[0].problem === false && q.notes.length === 0,
                JSON.stringify(q.skipped));
            const now = planFor([S('gone', 'U', { match: 'show', keyedOn: 'now' })], [], lists);
            suite.check('keyed on now it plays the clip naming the show that just ended',
                titles(now.out) === 'Up Alpha', titles(now.out));
        }

        // -- fallback
        {
            const lists = {
                U: [clipOf('Up Gamma', 10, ['tv.Gamma'])],
                G: [clipOf('Up Gamma too', 10, ['tv.Gamma']), clipOf('Generic', 10)],
            };
            const p = planFor([S('up', 'U', { match: 'show', fallbackListId: 'G' })], [], lists);
            suite.check('the fallback list supplies a general clip, never one naming a different show',
                titles(p.out) === 'Generic' && p.out[0].via === 'fallback' && p.out[0].listId === 'G', titles(p.out));
            suite.check('the clip carries the list it came from, like a filler pick',
                p.out[0].clip.fillerId === 'G');
            const onlyOther = planFor([S('up', 'U', { match: 'show', fallbackListId: 'G' })], [],
                { U: lists.U, G: [clipOf('Up Gamma too', 10, ['tv.Gamma'])] });
            suite.check('a fallback holding only clips for other shows plays nothing',
                onlyOther.out.length === 0);
            const named = planFor([S('up', 'U', { match: 'show', fallbackListId: 'G' })], [],
                { U: lists.U, G: [clipOf('Up Beta late', 10, ['tv.Beta']), clipOf('Generic', 10)] });
            suite.check('a fallback clip that does name the keyed show is fine, and idle order decides',
                titles(named.out) === 'Up Beta late', titles(named.out));
            const missing = planFor([S('up', 'U', { match: 'show', fallbackListId: 'NOPE' })], [], { U: lists.U });
            suite.check('a missing fallback list is noted, and the step is skipped if nothing else fits',
                missing.out.length === 0 && missing.notes.length === 1 && /fallback list "NOPE"/.test(missing.notes[0]), missing.notes.join());
        }

        // -- clips naming several shows: the shows must air one after another, in that order
        {
            const long = [episode('Alpha', 1, 30), flex(5), episode('Beta', 1, 30), episode('Gamma', 1, 30), episode('Delta', 1, 30),
                episode('Epsilon', 1, 30), flex(5)];
            const channelOver = (progs, out, inn) => ({
                number: 16, name: 'Several', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
                dayParts: [{ id: 'd', name: 'D', fillerCollections: mix([['A', 100]]),
                    starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }],
                    transitions: { betweenShows: { out: out, in: inn } } }],
                programs: progs, duration: progs.reduce((a, p) => a + p.duration, 0), startTime: new Date(start).toISOString(),
            });
            const run = (progs, out, lists, played, inn) => {
                const channel = channelOver(progs, out, inn || []);
                const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
                return transitions.buildPlan(channel, brk, env(lists, played));
            };
            const up = (names) => ({ U: [clipOf('Bumper ' + names.join('-'), 10, names)] });
            const plays = (names, progs, extra) => run(progs || long, [S('up', 'U', Object.assign({ match: 'show' }, extra || {}))], up(names)).out.length === 1;

            suite.check('the shows from the one coming up, in order, each once: Beta, Gamma, Delta, Epsilon',
                JSON.stringify(transitions.showSequence(channelOver(long, [], []),
                    transitions.findBreak(channelOver(long, [], []), 1, start + 30 * MIN), 4)) === JSON.stringify(['tv.Beta', 'tv.Gamma', 'tv.Delta', 'tv.Epsilon']));
            suite.check('a clip naming the next three shows, in order, fits',
                plays(['tv.Beta', 'tv.Gamma', 'tv.Delta']));
            suite.check('... and so does one naming four', plays(['tv.Beta', 'tv.Gamma', 'tv.Delta', 'tv.Epsilon']));
            suite.check('two in order is the rule it always was', plays(['tv.Beta', 'tv.Gamma']));
            suite.check('the same shows in another order do not fit', ! plays(['tv.Beta', 'tv.Delta', 'tv.Gamma']) && ! plays(['tv.Gamma', 'tv.Beta']));
            suite.check('shows that are not one after another do not fit: a show between them is in the way',
                ! plays(['tv.Beta', 'tv.Gamma', 'tv.Epsilon']) && ! plays(['tv.Beta', 'tv.Delta']));
            suite.check('the first show named must be the one coming up',
                ! plays(['tv.Gamma', 'tv.Delta', 'tv.Epsilon']) && ! plays(['tv.Alpha', 'tv.Beta', 'tv.Gamma']));
            suite.check('a show that is not in the lineup after it does not fit', ! plays(['tv.Beta', 'tv.Gamma', 'tv.Zeta']));
            suite.check('several episodes of one show in a row are one show',
                plays(['tv.Beta', 'tv.Gamma', 'tv.Delta'], [episode('Alpha', 1, 30), flex(5), episode('Beta', 1, 30), episode('Beta', 2, 30),
                    episode('Gamma', 1, 30), episode('Gamma', 2, 30), episode('Delta', 1, 30), flex(5)]));
            suite.check('Flex between the shows is not a show',
                plays(['tv.Beta', 'tv.Gamma', 'tv.Delta'], [episode('Alpha', 1, 30), flex(5), episode('Beta', 1, 30), flex(5),
                    episode('Gamma', 1, 30), flex(5), episode('Delta', 1, 30), flex(5)]));
            suite.check('the lineup is a cycle: after the last show the first comes round',
                plays(['tv.Beta', 'tv.Gamma', 'tv.Alpha'], [episode('Alpha', 1, 30), flex(5), episode('Beta', 1, 30), episode('Gamma', 1, 30)]));
            suite.check('a step keyed on the show that just ended never plays a clip naming several',
                run(long, [S('up', 'U', { match: 'show', keyedOn: 'now' })], up(['tv.Alpha', 'tv.Beta', 'tv.Gamma'])).out.length === 0
                && run(long, [S('up', 'U', { match: 'show', keyedOn: 'now' })], up(['tv.Alpha', 'tv.Beta'])).out.length === 0);
            suite.check('a pair step reads two names as now then, and takes no clip of three',
                run(long, [S('pr', 'U', { match: 'pair' })], up(['tv.Alpha', 'tv.Beta'])).out.length === 1
                && run(long, [S('pr', 'U', { match: 'pair' })], up(['tv.Alpha', 'tv.Beta', 'tv.Gamma'])).out.length === 0);
            const viaFallback = (names) => run(long, [S('pr', 'U', { match: 'pair', fallbackListId: 'F' })],
                { U: [clipOf('Other', 10, ['tv.Zeta'])], F: [clipOf('Fallback ' + names.join('-'), 10, names)] }).out.length;
            suite.check('the fallback of a pair step takes a clip naming now then next, and not one that goes on past the next show',
                viaFallback(['tv.Alpha', 'tv.Beta']) === 1 && viaFallback(['tv.Alpha', 'tv.Beta', 'tv.Gamma']) === 0);
            suite.check('an "any" step takes a clip of several shows only when they fit, like every other step',
                plays(['tv.Beta', 'tv.Gamma', 'tv.Delta'], long, { match: 'any' }) && ! plays(['tv.Gamma', 'tv.Delta', 'tv.Epsilon'], long, { match: 'any' }));

            // One, two and three shows are one pool: whichever fit, the longest idle plays first.
            const pool = { U: [clipOf('One', 10, ['tv.Beta']), clipOf('Two', 10, ['tv.Beta', 'tv.Gamma']),
                clipOf('Three', 10, ['tv.Beta', 'tv.Gamma', 'tv.Delta']), clipOf('Wrong order', 10, ['tv.Beta', 'tv.Delta', 'tv.Gamma'])] };
            const mixed = run(long, [S('up', 'U', { match: 'show' })], pool, { One: 100, Two: 50 });
            suite.check('single, double and triple clips share one pool, the longest idle first, and the one out of order is not in it',
                titles(mixed.out) === 'Three' && mixed.out[0].fits.join(' | ') === 'Three | Two | One', mixed.out[0] && mixed.out[0].fits.join(' | '));
            const noThree = run([episode('Alpha', 1, 30), flex(5), episode('Beta', 1, 30), episode('Gamma', 1, 30), episode('Zeta', 1, 30)],
                [S('up', 'U', { match: 'show' })], pool, { One: 100, Two: 50 });
            suite.check('when the third show is another one, the triple is out and the pair is next',
                titles(noThree.out) === 'Two' && noThree.out[0].fits.join(' | ') === 'Two | One', noThree.out[0] && noThree.out[0].fits.join(' | '));
        }

        // -- every clip that fits a step
        {
            const lists = { U: [clipOf('Up Beta A', 10, ['tv.Beta']), clipOf('Up Beta B', 10, ['tv.Beta']), clipOf('Up Beta C', 10, ['tv.Beta']),
                clipOf('Up Gamma', 10, ['tv.Gamma']), clipOf('Generic', 10)] };
            const played = { 'Up Beta A': 50, 'Up Beta B': 5 };
            const fitsOf = (side, i) => side[i].fits.join(' | ');
            const p = planFor([S('up', 'U', { match: 'show' })], [], lists, played);
            suite.check('a step reports every clip that fits it, the one that plays first, then in the order they would take their turns',
                titles(p.out) === 'Up Beta C' && fitsOf(p.out, 0) === 'Up Beta C | Up Beta B | Up Beta A', fitsOf(p.out, 0));
            suite.check('a clip for another show and a clip naming no show do not fit a show step',
                ! p.out[0].fits.includes('Up Gamma') && ! p.out[0].fits.includes('Generic'));
            const twice = planFor([S('a', 'U', { match: 'show' })], [S('b', 'U', { match: 'show' })], lists, played);
            suite.check('a clip that has played in the plan cannot fit the next step: the in step lists what is left',
                titles(twice.out) === 'Up Beta C' && titles(twice.in) === 'Up Beta B' && fitsOf(twice.in, 0) === 'Up Beta B | Up Beta A', fitsOf(twice.in, 0));
            const fb = planFor([S('up', 'U', { match: 'show', fallbackListId: 'G' })], [], { U: [clipOf('Up Gamma', 10, ['tv.Gamma'])],
                G: [clipOf('Gen 1', 10), clipOf('Gen 2', 10), clipOf('Up Gamma too', 10, ['tv.Gamma'])] });
            suite.check('a fallback step lists the fallback list\'s clips that fit, not the main list\'s',
                fb.out[0].via === 'fallback' && fitsOf(fb.out, 0) === 'Gen 1 | Gen 2', fitsOf(fb.out, 0));
            const any = planFor([S('i', 'U', { match: 'any' })], [], lists, played);
            suite.check('an "any" step lists the general clips and the ones naming the next show, longest idle first and ties in list order',
                fitsOf(any.out, 0) === 'Up Beta C | Generic | Up Beta B | Up Beta A', fitsOf(any.out, 0));
            const pair = planFor([S('pr', 'P', { match: 'pair' })], [], { P: [clipOf('Alpha then Beta', 10, ['tv.Alpha', 'tv.Beta']),
                clipOf('Just Beta 1', 10, ['tv.Beta']), clipOf('Just Beta 2', 10, ['tv.Beta'])] });
            suite.check('only the clips of the tier that was used rotate: a pair clip is not mixed with the single-show clips behind it',
                titles(pair.out) === 'Alpha then Beta' && fitsOf(pair.out, 0) === 'Alpha then Beta', fitsOf(pair.out, 0));
            const none = planFor([S('up', 'U', { match: 'show' })], [], { U: [clipOf('Up Gamma', 10, ['tv.Gamma'])] });
            suite.check('a step that plays nothing has no clip and so no list of what fits', none.out.length === 0);
        }

        // -- any steps
        {
            const lists = { I: [clipOf('Ident', 5), clipOf('For Gamma', 5, ['tv.Gamma']), clipOf('For Beta', 5, ['tv.Beta'])] };
            const first = planFor([S('i', 'I', { match: 'any' })], [], lists, { 'For Beta': 9, 'Ident': 5 });
            suite.check('an any step needs no name: the longest-idle clip that fits plays',
                titles(first.out) === 'Ident', titles(first.out));
            const second = planFor([S('i', 'I', { match: 'any' })], [], { I: [clipOf('For Gamma', 5, ['tv.Gamma'])] });
            suite.check('but even an any step never plays a clip naming a show it is not keyed on',
                second.out.length === 0);
            const third = planFor([S('i', 'I', { match: 'any' })], [], { I: [clipOf('For Beta', 5, ['tv.Beta'])] });
            suite.check('and plays one naming exactly the show it is keyed on', titles(third.out) === 'For Beta');
        }

        // -- longest idle, ties, cooldowns
        {
            const U = [clipOf('B1', 10, ['tv.Beta']), clipOf('B2', 10, ['tv.Beta']), clipOf('B3', 10, ['tv.Beta'])];
            const pick = (played) => titles(planFor([S('u', 'U', { match: 'show' })], [], { U: U }, played).out);
            suite.check('the longest-idle clip plays first', pick({ B1: 300, B2: 100, B3: 200 }) === 'B2');
            suite.check('a clip that never played is the longest idle', pick({ B1: 300, B3: 200 }) === 'B2');
            suite.check('ties go to list order, so one break always builds one plan', pick({}) === 'B1');
            const the = planFor([S('u', 'U', { match: 'show' })], [], { U: [U[0]] }, { B1: Date.now() });
            suite.check('cooldowns are a preference: the only clip naming the show plays even if it just played',
                titles(the.out) === 'B1');
        }

        // -- a clip never plays twice in one plan
        {
            const two = { U: [clipOf('B1', 15, ['tv.Beta']), clipOf('B2', 10, ['tv.Beta'])] };
            const p = planFor([S('o', 'U', { match: 'show' })], [S('i', 'U', { match: 'show' })], two, { B1: 1, B2: 2 });
            suite.check('the out and in steps of one break take different clips of one list, longest idle first',
                titles(p.out) === 'B1' && titles(p.in) === 'B2', `${titles(p.out)} / ${titles(p.in)}`);
            const one = planFor([S('o', 'U', { match: 'show' })], [S('i', 'U', { match: 'show' })], { U: [two.U[0]] });
            suite.check('with one fitting clip the second step skips rather than repeat it',
                titles(one.out) === 'B1' && one.in.length === 0);
            const fb = planFor([S('o', 'U', { match: 'show' })], [S('i', 'U', { match: 'show', fallbackListId: 'G' })],
                { U: [two.U[0]], G: [clipOf('Generic', 5)] });
            suite.check('or falls through to its own fallback',
                titles(fb.in) === 'Generic');
            suite.check('total durations are summed per side',
                p.outMs === 15 * T && p.inMs === 10 * T);
        }

        // -- two-name clips in a step keyed on next
        {
            const lists = { U: [clipOf('Beta then Gamma', 10, ['tv.Beta', 'tv.Gamma']), clipOf('Beta then Alpha', 10, ['tv.Beta', 'tv.Alpha']),
                clipOf('Gamma then Beta', 10, ['tv.Gamma', 'tv.Beta']), clipOf('Gamma then Alpha', 10, ['tv.Gamma', 'tv.Alpha'])] };
            const p = planFor([S('u', 'U', { match: 'show' })], [], lists);
            suite.check('keyed on next, a clip naming two shows matches only when they are the next show and the one after, in order',
                titles(p.out) === 'Beta then Gamma', titles(p.out));
            const none = planFor([S('u', 'U', { match: 'show' })], [], { U: lists.U.slice(1) });
            suite.check('a two-name clip with the right first show and the wrong second plays nothing',
                none.out.length === 0);
            const mixed = planFor([S('u', 'U', { match: 'show' })], [],
                { U: [clipOf('Just Beta', 10, ['tv.Beta']), lists.U[0]] }, { 'Just Beta': 5 });
            suite.check('one-name and two-name clips share one pool, and idle order decides between them',
                titles(mixed.out) === 'Beta then Gamma', titles(mixed.out));
            const now = planFor([S('n', 'U', { match: 'show', keyedOn: 'now' })], [], lists);
            suite.check('keyed on now, a two-name clip is never read as "now, then"', now.out.length === 0);
        }

        // -- pair steps
        {
            const lists = {
                P: [clipOf('Alpha / Beta', 10, ['tv.Alpha', 'tv.Beta']), clipOf('Beta only', 10, ['tv.Beta']),
                    clipOf('Beta / Alpha', 10, ['tv.Beta', 'tv.Alpha']), clipOf('Alpha only', 10, ['tv.Alpha'])],
                G: [clipOf('Generic', 10)],
            };
            const run = (p, fallback) => planFor([S('p', 'P', { match: 'pair', fallbackListId: fallback || null })], [], { P: p, G: lists.G });
            suite.check('a pair step plays a clip naming now then next',
                titles(run(lists.P).out) === 'Alpha / Beta' && run(lists.P).out[0].via === 'pair');
            suite.check('and prefers it to a clip naming only the next show even if that one is idler',
                titles(planFor([S('p', 'P', { match: 'pair' })], [], { P: lists.P }, { 'Alpha / Beta': 99 }).out) === 'Alpha / Beta');
            const nextOnly = run([lists.P[1], lists.P[2], lists.P[3]]);
            suite.check('without one it takes a clip naming only the next show',
                titles(nextOnly.out) === 'Beta only' && nextOnly.out[0].via === 'next', titles(nextOnly.out));
            suite.check('the reversed pair and a clip naming only the show that ended never match',
                run([lists.P[2], lists.P[3]]).out.length === 0);
            suite.check('then it takes the fallback list, then skips',
                titles(run([lists.P[2]], 'G').out) === 'Generic' && run([lists.P[2]]).out.length === 0);
        }

        // -- things that cannot be played
        {
            const none = planFor([S('e', 'EMPTY', { match: 'show' }), S('m', 'MISSING', { match: 'show' }),
                { id: 'nolist', kind: 'list', match: 'any' }], [], { EMPTY: [] });
            suite.check('a step whose list is empty, missing or unnamed is skipped, with one note each',
                none.out.length === 0 && none.notes.length === 3 && none.skipped.every((s) => s.problem), none.notes.join(' | '));
            const stillUnbuilt = planFor([
                { id: 'g', kind: 'generated', template: 'up-next', durationMs: 5000 },
                S('x', 'U', { match: 'maybe' })], [], { U: [clipOf('B', 10, ['tv.Beta'])] });
            suite.check('the generated kind and an unknown match are skipped as problems, not played',
                stillUnbuilt.out.length === 0 && stillUnbuilt.notes.length === 2, stillUnbuilt.notes.join(' | '));
            const bad = planFor([S('u', 'U', { match: 'show' })], [], { U: [
                clipOf('Bad 1', 10, 'tv.Beta'), clipOf('Bad 2', 10, []), clipOf('Bad 3', 10, ['tv.Beta', 'tv.Gamma', 'tv.Alpha', 'tv.Delta', 'tv.Epsilon']),
                clipOf('Bad 4', 0, ['tv.Beta']), clipOf('Good', 10, ['tv.Beta'])] });
            suite.check('a clip whose names are unusable, or that has no length, is never chosen',
                titles(bad.out) === 'Good', titles(bad.out));
        }

        // -- keyedOn 'later' (step 8): the first program of the context's next
        // airing or start, not either neighbour of the break
        {
            // A block airing only Monday 10-11am, and a day-part covering the rest
            // of the week. Alpha (in the block) is followed by Beta (in the
            // day-part): a genuine boundary, leaving the block. The block's next
            // airing, a week on, opens with Gamma - found only by scanning past
            // Beta and the long Flex between them, not by looking at either
            // neighbour of this break.
            const mon = at('2026-10-05T10:00:00');
            const progs = [episode('Alpha', 1, 60), flex(5), episode('Beta', 1, 30), flex(9985), episode('Gamma', 1, 30)];
            const channel = {
                number: 18, name: 'Later', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
                dayParts: [{ id: 'd', name: 'D', fillerCollections: mix([['A', 100]]),
                    starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] }],
                blocks: [{ id: 'm', name: 'M', fillerCollections: mix([['B', 100]]),
                    airings: [{ days: [1], start: 10 * HOUR, end: 11 * HOUR }],
                    transitions: { leaving: { out: [S('l', 'U', { match: 'show', keyedOn: 'later' })], in: [] } } }],
                programs: progs, duration: progs.reduce((a, p) => a + p.duration, 0), startTime: new Date(mon).toISOString(),
            };
            const brk = transitions.findBreak(channel, 1, mon + 60 * MIN);
            suite.check('the break really is a boundary leaving the block, not a between-shows break inside it',
                transitions.assemble(channel, brk).situation === 'boundary', transitions.assemble(channel, brk).situation);
            const plan = (lists) => transitions.buildPlan(channel, brk, env(lists));
            const named = plan({ U: [clipOf('Next time: Gamma', 10, ['tv.Gamma']), clipOf('Next time: Beta', 10, ['tv.Beta'])] });
            suite.check('a step keyed on later plays the clip naming the show that opens the block\'s next airing a week on, not the show right after the break',
                titles(named.out) === 'Next time: Gamma', titles(named.out));
            const none = plan({ U: [clipOf('Next time: Beta', 10, ['tv.Beta'])] });
            suite.check('with no clip naming that show it is skipped, and that is not a problem',
                none.out.length === 0 && none.skipped.length === 1 && none.skipped[0].problem === false, JSON.stringify(none.skipped));
            // A fallback works for a `later` step exactly as it does for `now`/`next` - room
            // left for the generated stand-in bumpers planned as their own session.
            channel.blocks[0].transitions.leaving.out[0].fallbackListId = 'G';
            const withFallback = transitions.buildPlan(channel, brk,
                env({ U: [clipOf('Next time: Beta', 10, ['tv.Beta'])], G: [clipOf('Generic stand-in', 8)] }));
            suite.check('a fallback list stands in when nothing names the later show, like any other show step',
                titles(withFallback.out) === 'Generic stand-in' && withFallback.out[0].via === 'fallback', titles(withFallback.out));
        }

        // -- keyedOn 'afterNext' and 'tomorrow': channel 3's Disney Movies block, which airs
        // Friday and Saturday at 7:00 PM, next to a Sunday Movie block and a Saturday
        // morning one. A two-week lineup, so next Friday's movie is not Saturday's.
        {
            const week1 = at('2026-11-02T00:00:00');                    // a Monday
            const dayAt = (week, dow, hhmm) => {                        // dow 0 = Sunday .. 6 = Saturday
                const d = new Date(week1);
                d.setDate(d.getDate() + week * 7 + ((dow + 6) % 7));
                const [h, m] = hhmm.split(':').map(Number);
                d.setHours(h, m, 0, 0);
                return d.getTime();
            };
            const showings = [];
            [['Up', 'Cars', 'Moana', 'Frozen'], ['Brave', 'Luca', 'Coco', 'Soul']].forEach((names, week) => {
                showings.push([dayAt(week, 5, '19:00'), names[0]], [dayAt(week, 6, '11:30'), names[1]],
                    [dayAt(week, 6, '19:00'), names[2]], [dayAt(week, 0, '19:00'), names[3]]);
            });
            showings.sort((a, b) => a[0] - b[0]);
            const programs = [];
            const end = dayAt(1, 0, '23:59') + MIN;
            let t = week1;
            // Fill is cut where a day-part starts (midnight, 6 AM), as a generated lineup would
            const fill = (until) => {
                while (until > t) {
                    const d = new Date(t);
                    const cut = [0, 6].map( (h) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + (h === 0 ? 1 : 0), h).getTime() )
                        .filter( (c) => c > t ).concat([until]).sort( (a, b) => a - b )[0];
                    const stop = Math.min(cut, until);
                    programs.push({ title: 'Fill', key: '/e/fill' + t, type: 'episode', showTitle: 'Fill', season: 1, episode: 1,
                        duration: stop - t, serverKey: 'srv' });
                    t = stop;
                }
            };
            for (const [when, title] of showings) {
                fill(when - 9 * MIN);
                programs.push(flex(9), movie(title, 82), flex(8));
                t = when + 90 * MIN;
            }
            fill(end);
            const channel = {
                number: 3, name: 'Disney', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
                dayParts: [
                    { id: 'early', name: 'Early', fillerCollections: mix([['A', 100]]), starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] },
                    { id: 'day', name: 'Day', fillerCollections: mix([['A', 100]]), starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 6 * HOUR }] },
                ],
                blocks: [
                    { id: 'dm', name: 'Disney Movies', fillerCollections: mix([['B', 100]]),
                        airings: [{ days: [5, 6], start: 19 * HOUR, end: 20.5 * HOUR }] },
                    { id: 'sm', name: 'Disney Sunday Movie', fillerCollections: mix([['B', 100]]),
                        airings: [{ days: [0], start: 19 * HOUR, end: 20.5 * HOUR }] },
                    { id: 'at', name: 'AfterToon Movie', fillerCollections: mix([['B', 100]]),
                        airings: [{ days: [6], start: 11.5 * HOUR, end: 12.5 * HOUR }] },
                ],
                programs: programs, duration: programs.reduce((a, p) => a + p.duration, 0),
                startTime: new Date(week1).toISOString(),
            };
            const flexAt = (ms) => {
                let from = week1;
                for (let i = 0; i < programs.length; i++) {
                    if ( (from === ms) && (programs[i].isOffline === true) ) {
                        return transitions.findBreak(channel, i, from);
                    }
                    from += programs[i].duration;
                }
                throw new Error('no Flex entry at ' + new Date(ms));
            };
            const [movies, sunday] = channel.blocks;
            const titleOf = (found) => (found === null) ? null : found.program.title;
            const fri = dayAt(0, 5, '19:00');
            const sat = dayAt(0, 6, '19:00');
            const sun = dayAt(0, 0, '19:00');
            const friLeaving = flexAt(fri + 82 * MIN);
            const satLeaving = flexAt(sat + 82 * MIN);
            const friEntering = flexAt(fri - 9 * MIN);
            const satEntering = flexAt(sat - 9 * MIN);
            const sunLeaving = flexAt(sun + 82 * MIN);

            suite.check('the Friday movie\'s break is a boundary leaving Disney Movies, and the Saturday one\'s break before it enters it',
                transitions.assemble(channel, friLeaving).from === movies && transitions.assemble(channel, satEntering).to === movies);

            // (a) next week, from a Friday and a Saturday break
            suite.check('"later" after the Friday movie is Saturday\'s: the case it cannot do, next Friday\'s',
                titleOf(transitions.laterAiring(channel, friLeaving, movies)) === 'Moana');
            const nextFri = transitions.afterNextAiring(channel, friLeaving, movies);
            suite.check('"the airing after next" finds next Friday\'s movie, at its own start',
                titleOf(nextFri) === 'Brave' && nextFri.startTime === dayAt(1, 5, '19:00'), titleOf(nextFri));
            suite.check('after the Saturday movie it finds next Saturday\'s, where "later" finds next Friday\'s',
                titleOf(transitions.afterNextAiring(channel, satLeaving, movies)) === 'Coco'
                && titleOf(transitions.laterAiring(channel, satLeaving, movies)) === 'Brave');
            suite.check('before the Friday movie, "later" is that movie and "the airing after next" is Saturday\'s',
                titleOf(transitions.laterAiring(channel, friEntering, movies)) === 'Up'
                && titleOf(transitions.afterNextAiring(channel, friEntering, movies)) === 'Moana');
            suite.check('a context the lineup never airs has no airing after the next, and a break with no next program or no context has none either',
                transitions.afterNextAiring(channel, friLeaving, { id: 'ghost' }) === null
                && transitions.afterNextAiring(channel, Object.assign({}, friLeaving, { next: null }), movies) === null
                && transitions.afterNextAiring(channel, friLeaving, null) === null);

            // (b) and (c): tomorrow
            suite.check('after the Saturday movie "tomorrow" is the Sunday movie, which belongs to another block',
                titleOf(transitions.tomorrowAiring(channel, satLeaving, movies)) === 'Frozen');
            suite.check('before the Saturday movie it is the same one: tomorrow\'s, not tonight\'s',
                titleOf(transitions.tomorrowAiring(channel, satEntering, movies)) === 'Frozen');
            suite.check('on Friday it is Saturday evening\'s movie, not the Saturday morning one that opens first that day',
                titleOf(transitions.tomorrowAiring(channel, friLeaving, movies)) === 'Moana'
                && titleOf(transitions.tomorrowAiring(channel, friEntering, movies)) === 'Moana');
            suite.check('a step whose own block does not air tomorrow finds the first block to open that day',
                titleOf(transitions.tomorrowAiring(channel, friLeaving, sunday)) === 'Cars');
            suite.check('after the Sunday movie nothing opens on Monday: no show tomorrow',
                transitions.tomorrowAiring(channel, sunLeaving, sunday) === null);
            suite.check('a day-part\'s own start counts for its own step, but is never the fallback for another context',
                transitions.tomorrowAiring(channel, sunLeaving, channel.dayParts[0]).startTime === dayAt(1, 1, '00:00')
                && transitions.tomorrowAiring(channel, sunLeaving, movies) === null);
            suite.check('no next program, no tomorrow',
                transitions.tomorrowAiring(channel, Object.assign({}, satLeaving, { next: null }), movies) === null);

            // The owner's sequences through buildPlan
            const lists = {
                MOVIE: ['Brave', 'Coco', 'Frozen', 'Moana', 'Up'].map( (m) => clipOf('Promo ' + m, 10, ['movie.' + m]) ),
                GENERIC: [clipOf('Tonight at seven', 10), clipOf('Another at seven', 10)],
            };
            const keyed = (id, keyedOn, extra) => S(id, 'MOVIE', Object.assign({ match: 'show', keyedOn: keyedOn }, extra || {}));
            const withSteps = (situation, steps) => {
                movies.transitions = { [situation]: { out: steps, in: [] } };
            };
            const planAt = (brk, from) => transitions.buildPlan(channel, brk, env(from || lists));

            withSteps('leaving', [keyed('wk', 'afterNext'), keyed('tm', 'tomorrow')]);
            suite.check('after the Friday movie: a promo for next Friday\'s movie, then one for Saturday\'s',
                titles(planAt(friLeaving).out) === 'Promo Brave | Promo Moana', titles(planAt(friLeaving).out));
            suite.check('after the Saturday movie: next Saturday\'s, then Sunday\'s',
                titles(planAt(satLeaving).out) === 'Promo Coco | Promo Frozen', titles(planAt(satLeaving).out));

            withSteps('entering', [keyed('tm', 'tomorrow')]);
            suite.check('before the Saturday movie: tomorrow\'s, not tonight\'s',
                titles(planAt(satEntering).out) === 'Promo Frozen', titles(planAt(satEntering).out));
            const tonightOnly = planAt(satEntering, { MOVIE: [clipOf('Promo Moana', 10, ['movie.Moana'])] });
            suite.check('a clip naming tonight\'s movie is not one for tomorrow\'s: the step plays nothing, and that is no problem',
                tonightOnly.out.length === 0 && tonightOnly.skipped.length === 1 && tonightOnly.skipped[0].problem === false);
            withSteps('entering', [keyed('tm', 'tomorrow', { fallbackListId: 'GENERIC' })]);
            suite.check('a fallback list stands in when no clip names it, as for any show step',
                titles(planAt(satEntering, { MOVIE: [clipOf('Promo Moana', 10, ['movie.Moana'])], GENERIC: lists.GENERIC }).out) === 'Tonight at seven');

            sunday.transitions = { leaving: { out: [S('tm', 'GENERIC', { match: 'show', keyedOn: 'tomorrow' }),
                S('an', 'GENERIC', { match: 'any', keyedOn: 'afterNext' }), S('ok', 'GENERIC', { match: 'any', keyedOn: 'later' })], in: [] } };
            const nothing = planAt(sunLeaving);
            suite.check('with nothing on tomorrow a step keyed on it plays nothing, not even a clip that names no show - and that is no problem',
                nothing.skipped.filter( (x) => x.stepId === 'tm' ).length === 1 && ! nothing.out.some( (x) => x.stepId === 'tm' )
                && nothing.skipped.every( (x) => x.problem === false ) && nothing.notes.length === 0, JSON.stringify(nothing.skipped));
            suite.check('while one keyed on the next airing plays, as before',
                nothing.out.map( (x) => x.stepId ).join() === 'an,ok', nothing.out.map( (x) => x.stepId ).join());
            delete sunday.transitions;

            withSteps('leaving', [keyed('lt', 'later')]);
            suite.check('"later" is as it was: after the Friday movie, Saturday\'s',
                titles(planAt(friLeaving).out) === 'Promo Moana', titles(planAt(friLeaving).out));
            suite.check('all three are known keyedOn values',
                ['later', 'afterNext', 'tomorrow'].every( (k) => transitions.KEYED_ON.includes(k) ));
        }

        // -- purity
        {
            const lists = { U: [clipOf('B1', 10, ['tv.Beta'])] };
            const channel = channelWith({ out: [S('u', 'U', { match: 'show' })], in: [] });
            const beforeChannel = JSON.stringify(channel);
            const beforeLists = JSON.stringify(lists);
            const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
            const p = transitions.buildPlan(channel, brk, env(lists));
            suite.check('building a plan changes neither the channel nor the lists',
                JSON.stringify(channel) === beforeChannel && JSON.stringify(lists) === beforeLists);
            suite.check('the planned clip is a copy: tagging it with its list leaves the list\'s clip alone',
                p.out[0].clip !== lists.U[0] && typeof lists.U[0].fillerId === 'undefined' && p.out[0].clip.fillerId === 'U');
            suite.check('and the same inputs build the same plan',
                JSON.stringify(transitions.buildPlan(channel, brk, env(lists))) === JSON.stringify(p));
            let threw = false;
            try { transitions.buildPlan(channel, brk, {}); } catch (err) { threw = true; }
            suite.check('a plan cannot be built without somewhere to read lists from', threw);
            const bare = channelWith(undefined);
            delete bare.dayParts[0].transitions;
            const empty = transitions.buildPlan(bare, transitions.findBreak(bare, 1, start + 30 * MIN), env({}));
            suite.check('a channel with no transitions builds an empty plan',
                empty.out.length === 0 && empty.in.length === 0 && empty.skipped.length === 0 && empty.notes.length === 0);
        }

        // -- onlyIfNoMatch: a step that plays only when the step it names found nothing
        {
            const lists = {
                PROMOS: [clipOf('Promo Gamma', 10, ['tv.Gamma'])],            // names no one this break
                UP: [clipOf('Up Beta', 10, ['tv.Beta'])],
                UPG: [clipOf('Up Generic', 10)],
                WB: [clipOf('WBRB', 5)], BT: [clipOf('BTTS', 5)],
            };
            const seq = (upExtra, withPromo) => ({
                out: (withPromo ? [S('promo', 'PROMOS', { match: 'show' })] : []).concat([
                    S('up', 'UP', Object.assign({ match: 'show' }, upExtra || {})),
                    S('wbrb', 'WB', { onlyIfNoMatch: 'up' })]),
                in: [S('btts', 'BT', { onlyIfNoMatch: 'up' })],
            });
            const run = (spec, l) => planFor(spec.out, spec.in, Object.assign({}, lists, l || {}));
            const all = (p) => p.out.concat(p.in).map((s) => s.clip.title).join(' | ');

            suite.check('the watched step plays: the marked steps stay out',
                all(run(seq())) === 'Up Beta', all(run(seq())));
            const noUp = run(seq(), { UP: [clipOf('Up Gamma', 10, ['tv.Gamma'])] });
            suite.check('the watched step finds nothing: the marked steps play, out and in',
                titles(noUp.out) === 'WBRB' && titles(noUp.in) === 'BTTS', all(noUp));
            suite.check('a skipped marked step is a normal skip, not a problem',
                run(seq()).notes.length === 0 && run(seq()).skipped.length === 2);
            const viaFallback = run(seq({ fallbackListId: 'UPG' }), { UP: [clipOf('Up Gamma', 10, ['tv.Gamma'])] });
            suite.check('a clip from the watched step\'s fallback list counts as a match: the marked steps stay out',
                all(viaFallback) === 'Up Generic', all(viaFallback));

            // The reason the step is named: another optional step before the Up Next.
            const promoPlays = run(seq(null, true), { PROMOS: [clipOf('Promo Beta', 10, ['tv.Beta'])] });
            suite.check('a step before the Up Next that finds nothing does not bring the marked steps in when the Up Next plays',
                all(promoPlays) === 'Promo Beta | Up Beta', all(promoPlays));
            const promoMiss = run(seq(null, true));
            suite.check('with no promo for the show and an Up Next that plays, the marked steps stay out',
                all(promoMiss) === 'Up Beta', all(promoMiss));
            const promoOnly = run(seq(null, true), { PROMOS: [clipOf('Promo Beta', 10, ['tv.Beta'])], UP: [clipOf('Up Gamma', 10, ['tv.Gamma'])] });
            suite.check('a promo that plays does not stop the marked steps when the Up Next found nothing',
                titles(promoOnly.out) === 'Promo Beta | WBRB' && titles(promoOnly.in) === 'BTTS', all(promoOnly));
            const neither = run(seq(null, true), { UP: [clipOf('Up Gamma', 10, ['tv.Gamma'])] });
            suite.check('with neither a promo nor an Up Next the marked steps play',
                titles(neither.out) === 'WBRB' && titles(neither.in) === 'BTTS', all(neither));

            const before = planFor([S('wbrb', 'WB', { onlyIfNoMatch: 'up' }), S('up', 'UP', { match: 'show' })], [], lists);
            suite.check('where the marked step sits does not matter: it still reads the outcome of the step it names',
                titles(before.out) === 'Up Beta', titles(before.out));

            // Things that cannot be honoured fail closed.
            const absent = planFor([S('w', 'WB', { onlyIfNoMatch: 'nope' })], [], lists);
            suite.check('a mark naming a step that is not there skips the step as a problem',
                absent.out.length === 0 && absent.notes.length === 1 && /"nope"/.test(absent.notes[0]), absent.notes.join());
            const chained = planFor([S('up', 'UP', { match: 'show' }), S('a', 'WB', { onlyIfNoMatch: 'up' }),
                S('b', 'BT', { onlyIfNoMatch: 'a' })], [], Object.assign({}, lists, { UP: [] }));
            suite.check('a step cannot watch a marked step',
                titles(chained.out) === 'WBRB' && chained.skipped.filter((s) => s.stepId === 'b' && s.problem).length === 1);
            const sloppy = planFor([S('up', 'UP', { match: 'show' }), S('w', 'WB', { onlyIfNoMatch: true })], [], lists);
            suite.check('a mark of true, which names no step, is a problem and never plays',
                sloppy.out.length === 1 && sloppy.notes.length === 1);
            const blank = planFor([S('w', 'WB', { onlyIfNoMatch: '' })], [], lists);
            suite.check('an empty mark means "not marked", and the step plays as usual', titles(blank.out) === 'WBRB');

            // A sequence is one context's one situation: a boundary joins two contexts, and a step
            // does not watch across them.
            const channel = fixtureChannel();
            channel.blocks[0].transitions.entering = {
                out: [step('en-up', { listId: 'UP', match: 'show' })],
                in: [step('en-w', { listId: 'WB', onlyIfNoMatch: 'd-lv-out' })] };
            const brk = transitions.findBreak(channel, 3, start + 63 * MIN);
            const across = transitions.buildPlan(channel, brk, env({ UP: [clipOf('Up Beta', 10, ['tv.Beta'])], WB: [clipOf('WBRB', 5)],
                'list-d-lv-out': [clipOf('Leave', 5)] }));
            suite.check('across a boundary a step watches only steps of its own context\'s situation',
                across.skipped.some((s) => s.stepId === 'en-w' && s.problem && /not in this situation/.test(s.reason)),
                JSON.stringify(across.skipped));
        }

        // -- onlyIfNothingAbove: a cascade of steps on one side - the first that
        // finds a clip plays, and the rest are skipped, without naming a step by id
        {
            const lists = {
                UP: [clipOf('Up Beta', 10, ['tv.Beta'])], WB: [clipOf('WBRB', 5)], BT: [clipOf('BTTS', 5)],
                GEN: [clipOf('Generic', 5)], PROMO: [clipOf('Promo Beta', 10, ['tv.Beta'])],
            };

            const solo = planFor([S('a', 'WB', { onlyIfNothingAbove: true })], [], lists);
            suite.check('a cascade step with nothing above it on its side plays as if it were unconditional',
                titles(solo.out) === 'WBRB', titles(solo.out));

            const two = (upLists) => planFor(
                [S('up', 'UP', { match: 'show' }), S('wb', 'WB', { onlyIfNothingAbove: true })],
                [], Object.assign({}, lists, upLists || {}));
            suite.check('the step above it plays: the cascade step stays out',
                titles(two().out) === 'Up Beta' && two().skipped.filter((s) => s.stepId === 'wb' && ! s.problem).length === 1,
                JSON.stringify(two()));
            suite.check('the step above it finds nothing: the cascade step plays',
                titles(two({ UP: [] }).out) === 'WBRB', titles(two({ UP: [] }).out));

            // The chain the single-step choice could not build: a step that watches
            // one found nothing could not itself be watched, so "promo, else Up
            // Next, else bumper, else WBRB" needed a step conditional on a
            // conditional step. Position, not an id, settles it here.
            const chain = (promoLists, upLists) => planFor([
                S('promo', 'PROMO', { match: 'show' }),
                S('up', 'UP', { match: 'show', onlyIfNothingAbove: true }),
                S('bumper', 'GEN', { onlyIfNothingAbove: true }),
                S('wb', 'WB', { onlyIfNothingAbove: true }),
            ], [], Object.assign({}, lists, promoLists || {}, upLists || {}));
            suite.check('the promo plays: everything below it stays out',
                titles(chain().out) === 'Promo Beta'
                && chain().skipped.filter((s) => ['up', 'bumper', 'wb'].includes(s.stepId) && ! s.problem).length === 3,
                JSON.stringify(chain()));
            const noPromo = chain({ PROMO: [] });
            suite.check('the promo finds nothing, Up Next plays: the bumper and WBRB stay out',
                titles(noPromo.out) === 'Up Beta'
                && noPromo.skipped.filter((s) => ['bumper', 'wb'].includes(s.stepId) && ! s.problem).length === 2,
                JSON.stringify(noPromo));
            const neitherPromoNorUp = chain({ PROMO: [] }, { UP: [] });
            suite.check('neither the promo nor Up Next: the bumper plays, WBRB stays out',
                titles(neitherPromoNorUp.out) === 'Generic'
                && neitherPromoNorUp.skipped.filter((s) => s.stepId === 'wb' && ! s.problem).length === 1,
                JSON.stringify(neitherPromoNorUp));
            const allMiss = planFor([
                S('promo', 'PROMO', { match: 'show' }),
                S('up', 'UP', { match: 'show', onlyIfNothingAbove: true }),
                S('bumper', 'GEN', { onlyIfNothingAbove: true, listId: 'EMPTY' }),
                S('wb', 'WB', { onlyIfNothingAbove: true }),
            ], [], Object.assign({}, lists, { PROMO: [], UP: [], EMPTY: [] }));
            suite.check('every step above finds nothing (the bumper\'s own list is empty, which also counts as finding nothing): WBRB plays',
                titles(allMiss.out) === 'WBRB', JSON.stringify(allMiss));

            // A step left out by its day or its chance has found nothing - not played
            // - exactly like one that looked and found no clip. Ron's Miguzi setup:
            // Up Next at 75%, otherwise BTTS.
            const miguzi = (roll) => {
                const channel = channelWith({
                    out: [S('up', 'UP', { match: 'show', chance: 75 }), S('bt', 'BT', { onlyIfNothingAbove: true })], in: [],
                });
                const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
                return transitions.buildPlan(channel, brk, Object.assign(env(lists), { roll: () => roll }));
            };
            suite.check('the roll is under 75%: Up Next plays and BTTS, though it is a cascade step, stays out',
                titles(miguzi(0.1).out) === 'Up Beta' && miguzi(0.1).skipped.filter((s) => s.stepId === 'bt' && ! s.problem).length === 1);
            suite.check('the roll loses: Up Next was left out, not played, so BTTS plays - and that is not a problem',
                titles(miguzi(0.9).out) === 'BTTS' && miguzi(0.9).notes.length === 0, JSON.stringify(miguzi(0.9)));

            const dayGated = (days) => {
                const channel = channelWith({
                    out: [S('up', 'UP', { match: 'show', days: days }), S('bt', 'BT', { onlyIfNothingAbove: true })], in: [],
                });
                const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
                return transitions.buildPlan(channel, brk, env(lists));
            };
            suite.check('left out by day rather than chance: the same rule, BTTS plays',
                titles(dayGated([1]).out) === 'BTTS', JSON.stringify(dayGated([1])));
            suite.check('on a day it is not left out, Up Next plays and BTTS stays out',
                titles(dayGated([5]).out) === 'Up Beta');

            // A clip from a fallback list is still a clip: the step played.
            const viaFallback = planFor(
                [S('up', 'UP', { match: 'show', fallbackListId: 'GEN' }), S('bt', 'BT', { onlyIfNothingAbove: true })],
                [], Object.assign({}, lists, { UP: [clipOf('Up Gamma', 10, ['tv.Gamma'])] }));
            suite.check('a step that falls back still played: the cascade step below it stays out',
                titles(viaFallback.out) === 'Generic'
                && viaFallback.skipped.filter((s) => s.stepId === 'bt' && ! s.problem).length === 1, JSON.stringify(viaFallback));

            // Scope: this side only, and this context only.
            const sideTest = (upFinds) => planFor(
                [S('up', 'UP', { match: 'show' })],
                [S('bt', 'BT', { onlyIfNothingAbove: true })],
                upFinds ? lists : Object.assign({}, lists, { UP: [] }));
            suite.check('a cascade step only watches its own side: an out step finding a clip does not reach an in cascade step',
                titles(sideTest(true).in) === 'BTTS' && titles(sideTest(false).in) === 'BTTS');

            const boundary = fixtureChannel();
            boundary.blocks[0].transitions.entering = {
                out: [step('en-casc', { listId: 'WB', onlyIfNothingAbove: true })], in: [] };
            const brk2 = transitions.findBreak(boundary, 3, start + 63 * MIN);
            const acrossCascade = transitions.buildPlan(boundary, brk2, env({
                'list-d-lv-out': [clipOf('Leave', 5)], WB: [clipOf('WBRB', 5)],
            }));
            suite.check('a cascade step only watches its own context\'s side: the other context\'s step sharing the assembled "out" does not count',
                titles(acrossCascade.out) === 'Leave | WBRB', titles(acrossCascade.out));

            // A step cannot be watched by id if it is itself conditional - cascade included.
            const idWatchesCascade = planFor(
                [S('up', 'UP', { match: 'show' }), S('a', 'WB', { onlyIfNothingAbove: true }), S('b', 'BT', { onlyIfNoMatch: 'a' })],
                [], Object.assign({}, lists, { UP: [] }));
            suite.check('a step cannot watch a cascade step by id: it is conditional too, and that is a problem',
                idWatchesCascade.skipped.filter((s) => s.stepId === 'b' && s.problem).length === 1, JSON.stringify(idWatchesCascade.skipped));

            // A hand-edited step with both fields: onlyIfNothingAbove wins and the
            // stale onlyIfNoMatch is never consulted.
            const bothFields = planFor([S('w', 'WB', { onlyIfNothingAbove: true, onlyIfNoMatch: 'nope' })], [], lists);
            suite.check('onlyIfNothingAbove on a step overrides a leftover onlyIfNoMatch on the same step',
                titles(bothFields.out) === 'WBRB' && bothFields.notes.length === 0, JSON.stringify(bothFields));
        }

        // -- days: a step limited to some weekdays (the break starts Friday 20:30, local)
        {
            const lists = { U: [clipOf('Up Beta', 10, ['tv.Beta'])], W: [clipOf('WBRB', 5)] };
            const on = (days) => planFor([S('up', 'U', { match: 'show', days: days })], [], lists);
            suite.check('a step with no days plays on any day, and so does null', titles(on(undefined).out) === 'Up Beta' && titles(on(null).out) === 'Up Beta');
            suite.check('days [5] (Friday, Sunday being 0) plays on a Friday break', titles(on([5]).out) === 'Up Beta');
            suite.check('days that leave out Friday skip the step, and that is not a problem',
                on([0, 1, 2, 3, 4, 6]).out.length === 0 && on([0, 1, 2, 3, 4, 6]).notes.length === 0
                && on([4]).skipped[0].problem === false && /days/.test(on([4]).skipped[0].reason), JSON.stringify(on([4]).skipped));
            suite.check('Thursday and Saturday are not Friday (no off-by-one either way)', on([4]).out.length === 0 && on([6]).out.length === 0);
            const empty = on([]);
            suite.check('an empty days list plays on no day, and is noted as a problem',
                empty.out.length === 0 && empty.notes.length === 1 && empty.skipped[0].problem === true, empty.notes.join());
            suite.check('days that are not weekday numbers are a problem and skip the step',
                [7, -1, 5.5, '5', 'Fri'].every( (bad) => { const p = on([bad]); return p.out.length === 0 && p.notes.length === 1; })
                && on('Fri').out.length === 0 && on('Fri').notes.length === 1 && on(5).notes.length === 1);

            // the break's own local day is its start, even when the break runs past midnight
            const late = [episode('Alpha', 1, 30), flex(20), episode('Beta', 1, 30)];
            const lateChannel = Object.assign(channelWith({ out: [S('up', 'U', { match: 'show', days: [5] })], in: [] }), {
                programs: late, duration: 80 * MIN, startTime: new Date(at('2026-10-02T23:20:00')).toISOString() });
            const lateBrk = transitions.findBreak(lateChannel, 1, at('2026-10-02T23:50:00'));
            suite.check('the day is the local day the break starts: 23:50 Friday into Saturday counts as Friday',
                transitions.buildPlan(lateChannel, lateBrk, env(lists)).out.length === 1);
            lateChannel.dayParts[0].transitions.betweenShows.out[0].days = [6];
            suite.check('... and not Saturday', transitions.buildPlan(lateChannel, lateBrk, env(lists)).out.length === 0);

            // a day-skipped step has found nothing: a step watching it plays
            const gated = (days) => planFor([S('up', 'U', { match: 'show', days: days })], [S('b', 'W', { onlyIfNoMatch: 'up' })], lists);
            suite.check('a step watching a step skipped for its day plays', titles(gated([4]).in) === 'WBRB');
            suite.check('and stays out when the watched step plays that day', gated([5]).in.length === 0 && titles(gated([5]).out) === 'Up Beta');
        }

        // -- chance: a step that plays some of the time
        {
            const lists = { U: [clipOf('Up Beta', 10, ['tv.Beta'])] };
            const planWith = (chance, roll, inn) => {
                const channel = channelWith({ out: [S('up', 'U', { match: 'show', chance: chance })], in: inn || [] });
                const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
                return transitions.buildPlan(channel, brk, Object.assign(env(lists), { roll: () => roll }));
            };
            suite.check('with no chance, or null or 100, a step plays whatever the roll is',
                titles(planWith(undefined, 0.999).out) === 'Up Beta' && titles(planWith(null, 0.999).out) === 'Up Beta'
                && titles(planWith(100, 0.999).out) === 'Up Beta');
            suite.check('a roll under the percent plays, at the percent it does not',
                titles(planWith(50, 0.49).out) === 'Up Beta' && planWith(50, 0.5).out.length === 0 && planWith(50, 0.9).out.length === 0);
            suite.check('1 percent plays only on the lowest rolls', titles(planWith(1, 0.0).out) === 'Up Beta' && planWith(1, 0.01).out.length === 0);
            const lost = planWith(50, 0.9);
            suite.check('a step that lost its roll found nothing, and that is not a problem',
                lost.skipped.length === 1 && lost.skipped[0].problem === false && lost.notes.length === 0, JSON.stringify(lost.skipped));
            suite.check('a chance that is not a whole percent from 1 to 100 is a problem and skips the step',
                [0, -5, 101, 12.5, '50', NaN, true].every( (bad) => { const p = planWith(bad, 0.0); return p.out.length === 0 && p.notes.length === 1; }));

            // "Up Next before the break sometimes, otherwise right before the show"
            const both = (roll) => planWith(50, roll, [S('up2', 'U', { match: 'show', onlyIfNoMatch: 'up' })]);
            suite.check('a step marked to watch a chance step plays when that one lost',
                both(0.9).out.length === 0 && titles(both(0.9).in) === 'Up Beta');
            suite.check('and stays out when that one played',
                titles(both(0.1).out) === 'Up Beta' && both(0.1).in.length === 0);

            // the default roll is derived from the break, not random
            const channel = channelWith({ out: [S('up', 'U', { match: 'show', chance: 50 })], in: [] });
            const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
            const once = JSON.stringify(transitions.buildPlan(channel, brk, env(lists)).skipped);
            let same = true;
            for (let i = 0; i < 50; i++) {
                same = same && (JSON.stringify(transitions.buildPlan(channel, brk, env(lists)).skipped) === once);
            }
            suite.check('with no roll given, rebuilding one break always gives one answer', same);
            let under = 0;
            const N = 4000;
            for (let i = 0; i < N; i++) {
                if (transitions.defaultRoll({ number: 3 }, { startTime: start + i * 30 * MIN }, 'up') < 0.5) {
                    under++;
                }
            }
            suite.check('and across many breaks about half of the 50% rolls come up under', Math.abs(under / N - 0.5) < 0.03, `${under}/${N}`);
            let differ = 0;
            for (let i = 0; i < 200; i++) {
                const b = { startTime: start + i * 30 * MIN };
                if ( (transitions.defaultRoll({ number: 3 }, b, 'a') < 0.5) !== (transitions.defaultRoll({ number: 3 }, b, 'b') < 0.5) ) {
                    differ++;
                }
            }
            suite.check('two steps of one break roll independently', differ > 40 && differ < 160, String(differ));
            const rolls = [0, 1, 2, 3].map( (i) => transitions.defaultRoll({ number: 3 }, { startTime: start + i * 86400000 }, 'up') );
            suite.check('rolls stay in [0, 1)', rolls.every( (r) => r >= 0 && r < 1 ));
        }

        // -- times: a step limited to breaks starting inside a wall-clock window
        // (the break starts Friday 20:30, local - same break planFor always uses)
        {
            const lists = { U: [clipOf('Up Beta', 10, ['tv.Beta'])], W: [clipOf('WBRB', 5)] };
            const on = (times) => planFor([S('up', 'U', { match: 'show', times: times })], [], lists);
            suite.check('a step with no times plays at any time, and so does null',
                titles(on(undefined).out) === 'Up Beta' && titles(on(null).out) === 'Up Beta');
            suite.check('a window covering 20:30 plays', titles(on({ start: 20 * HOUR, end: 21 * HOUR }).out) === 'Up Beta');
            suite.check('a window not covering 20:30 skips the step, and that is not a problem',
                on({ start: 21 * HOUR, end: 22 * HOUR }).out.length === 0 && on({ start: 21 * HOUR, end: 22 * HOUR }).notes.length === 0
                && on({ start: 21 * HOUR, end: 22 * HOUR }).skipped[0].problem === false
                && /time/.test(on({ start: 21 * HOUR, end: 22 * HOUR }).skipped[0].reason));
            suite.check('the start is inside the window, the end is not (half-open)',
                titles(on({ start: 20 * HOUR + 30 * MIN, end: 21 * HOUR }).out) === 'Up Beta'
                && on({ start: 19 * HOUR, end: 20 * HOUR + 30 * MIN }).out.length === 0);

            // crossing midnight (the break's own day is tested separately below): a
            // window whose end is earlier than its start wraps, as a block airing does.
            const late = [episode('Alpha', 1, 30), flex(20), episode('Beta', 1, 30)];
            const lateChannel = Object.assign(channelWith({ out: [S('up', 'U', { match: 'show' })], in: [] }), {
                programs: late, duration: 80 * MIN, startTime: new Date(at('2026-10-02T23:20:00')).toISOString() });
            const lateBrk = transitions.findBreak(lateChannel, 1, at('2026-10-02T23:50:00'));
            const planAt2350 = (times) => {
                lateChannel.dayParts[0].transitions.betweenShows.out[0].times = times;
                return transitions.buildPlan(lateChannel, lateBrk, env(lists));
            };
            suite.check('23:50 falls inside a window crossing midnight (23:00-00:30)',
                planAt2350({ start: 23 * HOUR, end: 30 * MIN }).out.length === 1);
            suite.check('23:50 falls inside a window that starts just before it and ends just after midnight',
                planAt2350({ start: 23 * HOUR + 45 * MIN, end: 15 * MIN }).out.length === 1);
            suite.check('23:50 is not inside a same-day window of the small hours (00:00-06:00)',
                planAt2350({ start: 0, end: 6 * HOUR }).out.length === 0);
            suite.check('23:50 is not inside a non-crossing window that ends right at it (half-open)',
                planAt2350({ start: 22 * HOUR, end: 23 * HOUR + 50 * MIN }).out.length === 0);

            suite.check('times that are not a well-formed {start, end} are a problem and skip the step',
                [ null, undefined, {}, { start: 0 }, { end: 0 }, { start: '0', end: 10 }, { start: -1, end: 10 },
                    { start: 0, end: DAY }, { start: 1.5, end: 10 }, 'noon', 5 ]
                    .filter( (t) => (t !== null) && (typeof(t) !== 'undefined') )
                    .every( (bad) => { const p = on(bad); return p.out.length === 0 && p.notes.length === 1; }));
            const sameInstant = on({ start: 20 * HOUR + 30 * MIN, end: 20 * HOUR + 30 * MIN });
            suite.check('a start equal to its end plays at no time, and is noted as a problem',
                sameInstant.out.length === 0 && sameInstant.notes.length === 1 && /no time/.test(sameInstant.notes.join()));

            // a time-skipped step has found nothing: a step watching it plays
            const gated = (times) => planFor([S('up', 'U', { match: 'show', times: times })], [S('b', 'W', { onlyIfNoMatch: 'up' })], lists);
            suite.check('a step watching a step skipped for its times plays',
                titles(gated({ start: 21 * HOUR, end: 22 * HOUR }).in) === 'WBRB');
            suite.check('and stays out when the watched step plays at that time',
                titles(gated({ start: 20 * HOUR, end: 21 * HOUR }).out) === 'Up Beta' && gated({ start: 20 * HOUR, end: 21 * HOUR }).in.length === 0);

            // days and times are independent gates: both must allow it
            const both = planFor([S('up', 'U', { match: 'show', days: [5], times: { start: 21 * HOUR, end: 22 * HOUR } })], [], lists);
            suite.check('a step wrong on time but right on day still skips (both gates apply)', both.out.length === 0);
        }

        // -- lists whose clips feature shows
        {
            const T0 = { }; // no play times
            const feat = (ids) => (ids.length === 0) ? {} : { featuresShows: (id) => ids.includes(id) };
            const planOf = (step, lists, ids, played, inn) => {
                const channel = channelWith({ out: [step], in: inn || [] });
                const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
                return transitions.buildPlan(channel, brk, Object.assign(env(lists, played), feat(ids)));
            };
            const lists = { F: [clipOf('Bumper Gamma', 5, ['tv.Gamma']), clipOf('Bumper Beta', 5, ['tv.Beta']), clipOf('Bumper', 5)] };
            const show = S('s', 'F', { match: 'show' });

            suite.check('without the setting a show step never plays a clip naming a different show (and not an unnamed one)',
                titles(planOf(show, { F: [lists.F[0], lists.F[2]] }, [], T0).out) === '');
            suite.check('with the setting, a clip naming the next show plays first, even if another has idled longer',
                titles(planOf(show, lists, ['F'], { 'Bumper Beta': 9 }).out) === 'Bumper Beta'
                && planOf(show, lists, ['F'], { 'Bumper Beta': 9 }).out[0].via === 'show');
            const noBeta = { F: [lists.F[0], lists.F[2]] };
            suite.check('with no clip for the next show, any clip plays: the longest idle, named or not',
                titles(planOf(show, noBeta, ['F'], T0).out) === 'Bumper Gamma'
                && titles(planOf(show, noBeta, ['F'], { 'Bumper Gamma': 9 }).out) === 'Bumper'
                && planOf(show, noBeta, ['F'], T0).out[0].via === 'featured');
            suite.check('a list that is not marked beside one that is keeps its own rule',
                titles(planOf(S('s', 'N', { match: 'show' }), { N: noBeta.F }, ['F'], T0).out) === '');

            // as the fallback list of a step
            const withFallback = S('s', 'U', { match: 'show', fallbackListId: 'F' });
            const upNext = { U: [clipOf('Up Gamma', 10, ['tv.Gamma'])] };
            suite.check('a featuring fallback list supplies a clip for another show when nothing names the next one',
                titles(planOf(withFallback, Object.assign({ }, upNext, noBeta), ['F'], T0).out) === 'Bumper Gamma');
            suite.check('... and the next show\'s own clip wins there too',
                titles(planOf(withFallback, Object.assign({ }, upNext, lists), ['F'], { 'Bumper Beta': 9 }).out) === 'Bumper Beta');
            suite.check('... while a fallback list without the setting still plays only unnamed clips and the next show\'s',
                titles(planOf(withFallback, Object.assign({ }, upNext, noBeta), [], T0).out) === 'Bumper');
            suite.check('the step\'s own list is tried before the fallback, whatever the fallback holds',
                titles(planOf(S('s', 'U', { match: 'show', keyedOn: 'now', fallbackListId: 'F' }), Object.assign({ }, { U: [clipOf('Up Alpha', 10, ['tv.Alpha'])] }, lists), ['F'], T0).out) === 'Up Alpha');
            suite.check('a clip from a featuring fallback counts as a match for a step watching it',
                titles(planOf(withFallback, Object.assign({ }, upNext, noBeta), ['F'], T0, [S('b', 'W', { onlyIfNoMatch: 's' })]).in) === ''
                && planOf(withFallback, Object.assign({ }, upNext, noBeta), ['F'], T0, [S('b', 'W', { onlyIfNoMatch: 's' })]).out.length === 1);

            // pair and any steps
            const pair = S('p', 'F', { match: 'pair' });
            const pairs = { F: [clipOf('Bumper Gamma', 5, ['tv.Gamma']), clipOf('Bumper Alpha-Beta', 5, ['tv.Alpha', 'tv.Beta']), clipOf('Bumper Beta', 5, ['tv.Beta']), clipOf('Bumper', 5)] };
            suite.check('a pair step in a featuring list: the pair, then the next show alone, then any clip',
                titles(planOf(pair, pairs, ['F'], T0).out) === 'Bumper Alpha-Beta'
                && titles(planOf(pair, { F: pairs.F.filter( (c) => c.title !== 'Bumper Alpha-Beta') }, ['F'], T0).out) === 'Bumper Beta'
                && titles(planOf(pair, { F: [pairs.F[0], pairs.F[3]] }, ['F'], T0).out) === 'Bumper Gamma');
            const any = S('a', 'F', { match: 'any' });
            suite.check('an any step in a featuring list: clips naming the keyed show first, then any',
                titles(planOf(any, lists, ['F'], { 'Bumper Beta': 9 }).out) === 'Bumper Beta'
                && titles(planOf(any, noBeta, ['F'], { 'Bumper Gamma': 9 }).out) === 'Bumper');

            // the rules that stay
            suite.check('a clip with an unusable names field is still never chosen',
                titles(planOf(show, { F: [clipOf('Broken', 5, 'tv.Beta'), clipOf('Bumper', 5)] }, ['F'], T0).out) === 'Bumper');
            suite.check('a clip with no length is still never chosen',
                titles(planOf(show, { F: [Object.assign(clipOf('Empty', 0, ['tv.Beta']), { duration: 0 }), clipOf('Bumper', 5)] }, ['F'], T0).out) === 'Bumper');
            const twice = planOf(show, lists, ['F'], T0, [S('i', 'F', { match: 'show' })]);
            suite.check('a clip still plays at most once in a plan, out and in',
                twice.out.length === 1 && twice.in.length === 1 && twice.out[0].clip.title !== twice.in[0].clip.title, titles(twice.out) + ' / ' + titles(twice.in));
            suite.check('a list that does not exist is still skipped and noted, setting or not',
                planOf(S('s', 'NOPE', { match: 'show' }), lists, ['NOPE'], T0).notes.length === 1);
            suite.check('without env.featuresShows no list is featuring (the existing rules hold)',
                (() => {
                    const channel = channelWith({ out: [show], in: [] });
                    const brk = transitions.findBreak(channel, 1, start + 30 * MIN);
                    return titles(transitions.buildPlan(channel, brk, env({ F: [lists.F[0]] })).out) === '';
                })());
        }
    }

    // ---- the save-time warning for days and chance ---------------------------
    {
        const db = new ChannelDB('unused');
        const warnings = (extra) => {
            const lines = [];
            const real = console.error;
            console.error = (...args) => lines.push(args.join(' '));
            try {
                db.validateChannelJson(7, { dayParts: [{ name: 'D', starts: [{ days: [1], time: 0 }],
                    transitions: { betweenShows: { out: [step('a', extra)], in: [] } } }] });
            } finally {
                console.error = real;
            }
            return lines.filter((l) => /ransition/.test(l));
        };
        suite.check('days and chance that are fine, or absent, or null, are not warned about',
            warnings({}).length === 0 && warnings({ days: [1, 2], chance: 50 }).length === 0
            && warnings({ days: null, chance: null }).length === 0 && warnings({ chance: 100 }).length === 0
            && warnings({ days: [0, 6], chance: 1 }).length === 0);
        suite.check('an empty days list is warned about, and says it plays on no day',
            warnings({ days: [] }).length === 1 && /no day/.test(warnings({ days: [] })[0]), warnings({ days: [] }).join());
        suite.check('days that are not weekday numbers are warned about',
            warnings({ days: [7] }).length === 1 && warnings({ days: 'Mon' }).length === 1 && warnings({ days: [1.5] }).length === 1);
        suite.check('a chance outside 1 to 100, or not whole, or not a number, is warned about',
            [0, 101, -1, 12.5, '50'].every( (bad) => warnings({ chance: bad }).length === 1 ));
        suite.check('a step with both wrong is warned about twice', warnings({ days: [], chance: 0 }).length === 2);
        suite.check('times that are fine, or absent, or null, are not warned about',
            warnings({ times: { start: 0, end: 6 * HOUR } }).length === 0 && warnings({ times: null }).length === 0);
        suite.check('times with a start equal to its end are warned about, and say it plays at no time',
            warnings({ times: { start: 0, end: 0 } }).length === 1 && /no time/.test(warnings({ times: { start: 0, end: 0 } })[0]));
        suite.check('times that are not a well-formed {start, end} are warned about',
            warnings({ times: {} }).length === 1 && warnings({ times: { start: 0 } }).length === 1
            && warnings({ times: { start: -1, end: 10 } }).length === 1 && warnings({ times: { start: 0, end: 24 * HOUR } }).length === 1);
        suite.check('a step wrong in all three ways is warned about three times', warnings({ days: [], chance: 0, times: {} }).length === 3);
    }

    // ---- defaults: the new fields are off unless set -------------------------
    {
        const channel = { dayParts: [{ name: 'D', transitions: { betweenShows: { out: [{ id: 'a', listId: 'x' }], in: [] } } }] };
        const read = transitions.normalizeTransitions(channel.dayParts[0]).betweenShows.out[0];
        suite.check('a step saved before days and chance existed reads with both off', read.days === null && read.chance === null);
        suite.check('and reading wrote nothing', typeof channel.dayParts[0].transitions.betweenShows.out[0].days === 'undefined');
        const set = transitions.normalizeTransitions({ transitions: { betweenShows: { out: [{ id: 'a', days: [1], chance: 30 }], in: [] } } }).betweenShows.out[0];
        suite.check('a step that sets them keeps them', JSON.stringify(set.days) === '[1]' && set.chance === 30);

        suite.check('a step saved before times existed reads with it off, and reading wrote nothing',
            read.times === null && typeof channel.dayParts[0].transitions.betweenShows.out[0].times === 'undefined');
        const setTimes = transitions.normalizeTransitions({ transitions: { betweenShows: {
            out: [{ id: 'a', times: { start: 0, end: 6 * HOUR } }], in: [] } } }).betweenShows.out[0];
        suite.check('a step that sets times keeps it', JSON.stringify(setTimes.times) === JSON.stringify({ start: 0, end: 6 * HOUR }));
    }

    // ---- what playback asks before it builds any plan (step 4) -------------
    {
        const plain = Object.assign(fixtureChannel(), { dayParts: [], blocks: [] });
        suite.check('a channel with no day-parts or blocks has no steps', transitions.hasSteps(plain) === false);
        const emptyRows = Object.assign(fixtureChannel(), {
            dayParts: [{ name: 'Day', fillerCollections: [], starts: [{ days: [5], time: 0 }],
                transitions: { betweenShows: { out: [], in: [] }, leaving: { out: [] } } }],
            blocks: [],
        });
        suite.check('sequences that are there but empty: no steps', transitions.hasSteps(emptyRows) === false);
        const one = Object.assign(fixtureChannel(), {
            dayParts: [], blocks: [{ name: 'Late', fillerCollections: [], airings: [],
                transitions: { entering: { in: [step('a', { fallbackListId: 'list-generic' })] },
                    betweenShows: { out: [step('b'), step('c', { listId: 'list-a' })] } } }],
        });
        suite.check('one step on one block: the channel has steps', transitions.hasSteps(one) === true);
        suite.check('an on-demand channel never has steps, whatever is configured',
            transitions.hasSteps(Object.assign({}, one, { onDemand: { isOnDemand: true } })) === false);
        const listIds = transitions.stepListIds(one);
        suite.check('the lists its steps draw from, fallbacks included, each once',
            JSON.stringify(listIds.slice().sort()) === JSON.stringify(['list-a', 'list-b', 'list-generic']), JSON.stringify(listIds));
        suite.check('... and none for a channel with no steps', transitions.stepListIds(plain).length === 0);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
