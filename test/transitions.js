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
            const later = planFor([S('l', 'U', { match: 'show', keyedOn: 'later' }),
                { id: 'g', kind: 'generated', template: 'up-next', durationMs: 5000 },
                S('x', 'U', { match: 'maybe' })], [], { U: [clipOf('B', 10, ['tv.Beta'])] });
            suite.check('keyedOn later, the generated kind and an unknown match are skipped as problems, not played',
                later.out.length === 0 && later.notes.length === 3, later.notes.join(' | '));
            const bad = planFor([S('u', 'U', { match: 'show' })], [], { U: [
                clipOf('Bad 1', 10, 'tv.Beta'), clipOf('Bad 2', 10, []), clipOf('Bad 3', 10, ['tv.Beta', 'tv.Gamma', 'tv.Alpha']),
                clipOf('Bad 4', 0, ['tv.Beta']), clipOf('Good', 10, ['tv.Beta'])] });
            suite.check('a clip whose names are unusable, or that has no length, is never chosen',
                titles(bad.out) === 'Good', titles(bad.out));
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
