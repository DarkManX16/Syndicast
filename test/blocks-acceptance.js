/*
 * The acceptance tests from docs/blocks-spec.md, driven straight through
 * createLineup. One table, ROWS, transcribed from the spec's "| Channel |
 * When | Expected |" markdown tables - each row names the stage it belongs
 * to, so stage 2 appends its own rows (and whatever fixtures/helpers they
 * need) to this same file and array rather than starting a parallel one.
 * A stage merges only when its rows pass, per the spec's own rule.
 */
const { helperFuncs, dayParts, MIN, HOUR, at, freshStore, clip, show, flex, mix, Suite } = require('./support');
const transitions = require('../src/transitions');

// ---------------------------------------------------------------- fixtures
//
// Filler lists. Every clip is named `<listId>#<n>` so a pick's true owner is
// never in doubt regardless of what fillerId says - see NOTES.md's testing
// notes on why that matters.
const LISTS = {};
function defineList(id, n) {
    const content = [];
    for (let i = 1; i <= n; i++) {
        content.push(clip(`${id}#${i}`, 2));
    }
    LISTS[id] = content;
}
function ownerOf(title) {
    return title.split('#')[0];
}
[
    '90s Nick', '90s Nick IDs', 'Nick at Nite',
    '2000s Nick', '2000s Nick IDs', 'music videos', 'Friday Nick at Nite',
    'Powerhouse', 'CN Groovies', 'Adult Swim', 'Toonami AcTN',
    'CN City Day', 'CN City Night',
    // --- Stage 2: block-only lists. Toonami and Miguzi also draw on
    // Powerhouse/CN City Day above - stage 2's "every rule fully specifies
    // its mix" decision means a block names a base list alongside its own
    // rather than inheriting it, so those lists appear in two different
    // mixes at two different weights.
    'Toonami promos', 'Miguzi', 'CCF',
].forEach((id) => defineList(id, 4));

// The union video.js would load: content for every list a channel can reach.
function fillersFor(channel) {
    return dayParts.allFillerCollections(channel).map((c) => ({
        id: c.id, content: LISTS[c.id] || [], weight: c.weight, cooldown: c.cooldown,
    }));
}

function channelOf(number, name, dayPartsList) {
    return {
        number, name, offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 30 * MIN,
        // The channel's own Flex tab. Left non-empty and distinct from every
        // day-part's mix, so a row that resolves to it by accident (the
        // resolver declining to intervene when it should not have) is caught
        // rather than passing by coincidence.
        fillerCollections: mix([['90s Nick', 100]]),
        dayParts: dayPartsList,
    };
}

const nickPicks = channelOf(10, 'Nick Picks', [
    { name: '90s Nick', fillerCollections: mix([['90s Nick', 70], ['90s Nick IDs', 30, 4 * MIN]]),
      starts: [{ days: [1, 2, 3, 4], time: 6 * HOUR }] },
    { name: 'Nick at Nite', fillerCollections: mix([['Nick at Nite', 100]]),
      starts: [{ days: [1, 2, 3, 4], time: 20 * HOUR }] },
    { name: '2000s Nick', fillerCollections: mix([['2000s Nick', 80], ['2000s Nick IDs', 20, 5 * MIN], ['music videos', 10, 30 * MIN]]),
      starts: [{ days: [5], time: 6 * HOUR }] },
    { name: 'Friday Nick at Nite', fillerCollections: mix([['Friday Nick at Nite', 100]]),
      starts: [{ days: [5], time: 20 * HOUR }] },
]);

const ccn = channelOf(20, 'CCN', [
    { name: 'Weekday', fillerCollections: mix([['Powerhouse', 95], ['CN Groovies', 5, 3000 * 1000]]),
      starts: [{ days: [1, 2, 3, 4, 5], time: 6 * HOUR }] },
    // Adult Swim starts Sunday 10pm but Monday-Thursday nights at 12am - by
    // calendar day that is days 2..5 at 0:00 plus day 0 at 22:00, which is
    // exactly why there is no Saturday start: Friday's day-part runs on.
    { name: 'Adult Swim', fillerCollections: mix([['Adult Swim', 100]]),
      starts: [{ days: [2, 3, 4, 5], time: 0 }, { days: [0], time: 22 * HOUR }] },
    { name: 'Toonami AcTN', fillerCollections: mix([['Toonami AcTN', 100]]),
      starts: [{ days: [0], time: 0 }] },
    { name: 'Saturday overnight', fillerCollections: mix([['Powerhouse', 100]]),
      starts: [{ days: [6], time: 3 * HOUR }] },
    { name: 'CN City Day', fillerCollections: mix([['CN City Day', 100]]),
      starts: [{ days: [6], time: 6 * HOUR }] },
    { name: 'CN City Night', fillerCollections: mix([['CN City Night', 100]]),
      starts: [{ days: [6], time: 19 * HOUR, shiftWithDst: true }] },
]);

// --- Stage 2: blocks, layered on top of the same CCN day-part chain above.
// Blocks are added as a property after construction, the same way `plain`
// below overrides its own fillerCollections - channelOf has no notion of
// blocks, by design: stage 1 shipped and is in use before blocks existed.
ccn.blocks = [
    { name: 'Toonami', fillerCollections: mix([['Powerhouse', 30], ['Toonami promos', 70]]),
      airings: [
          // The weekday afternoon run. Thursday is deliberately absent - the
          // spec's own acceptance row exists to prove day-filtering on an
          // airing, the same property a day-part start's `days` already has.
          { days: [1, 2, 3, 5], start: 14 * HOUR + 30 * MIN, end: 17 * HOUR },
          // The Saturday midnight run - the spec's own example of one block
          // with two airings sharing a single mix ("so the mix is edited in
          // one place"). Ends exactly where the existing 'Saturday overnight'
          // day-part above picks up, at 3am, so the two hand off cleanly.
          { days: [6], start: 1 * HOUR, end: 3 * HOUR },
      ] },
    // Cartoon Cartoons Friday. Starts the instant Friday's Toonami airing
    // ends, so the break between Toonami's last show and CCF's first
    // resolves to CCF via the ordinary incoming-neighbour rule, without
    // falling through to the Weekday day-part in between.
    { name: 'CCF', fillerCollections: mix([['CCF', 100]]),
      airings: [ { days: [5], start: 17 * HOUR, end: 20 * HOUR } ] },
    // Saturday afternoon, entirely inside CN City Day's day-part window.
    { name: 'Miguzi', fillerCollections: mix([['CN City Day', 70], ['Miguzi', 30]]),
      airings: [ { days: [6], start: 15 * HOUR, end: 16 * HOUR } ] },
];

const plain = channelOf(30, 'Plain', undefined);
delete plain.dayParts;
plain.fillerCollections = mix([['Powerhouse', 50], ['CN Groovies', 50]]);

// Supplementary: two blocks whose airings overlap - a state the editor (a
// later session) is meant to prevent, and channel-db.js's warnAboutBlocks
// complains about, but the resolver still needs a deterministic answer if one
// slips through regardless - a hand-edited channel file, say. The
// first-declared block wins, the same rule dayPartAt already uses when two
// day-part starts land on the same moment.
const overlapping = channelOf(50, 'Overlap', []);
overlapping.blocks = [
    { name: 'First', fillerCollections: mix([['Powerhouse', 100]]),
      airings: [ { days: [1], start: 10 * HOUR, end: 12 * HOUR } ] },
    { name: 'Second', fillerCollections: mix([['CN Groovies', 100]]),
      airings: [ { days: [1], start: 11 * HOUR, end: 13 * HOUR } ] },
];

// --- Stage 5: transitions. Every fixture below is built here - its own
// day-parts and blocks, its own lineups, its own times - and none reads
// channel 1 or the dev data folder, so a row holds whatever Ron's real block
// times are. Two layers carry the sequences: `ccnSeq` is the CCN fixture above
// with steps on its day-parts and blocks, and `nickSeq` is Nick Picks with the
// Nick at Nite sequence.
function sseq(id, listId, extra) {
    return Object.assign({ id, kind: 'list', listId, match: 'any', keyedOn: 'next', fallbackListId: null }, extra || {});
}
// A show step keyed on the next show, skipped when nothing names it.
function nextStep(id, listId, extra) {
    return sseq(id, listId, Object.assign({ match: 'show' }, extra || {}));
}
function withTransitions(channel, byName) {
    const attach = (list) => (list || []).map((c) => (byName[c.name] ? Object.assign({}, c, { transitions: byName[c.name] }) : c));
    return Object.assign({}, channel, { dayParts: attach(channel.dayParts), blocks: attach(channel.blocks) });
}

// A clip is a filler item that may carry the shows it names. Its title is what
// a plan prints, so a row reads as the sequence it expects.
function named(title, secs, names) {
    return Object.assign({ title, key: '/c/' + title, serverKey: 'srv', duration: secs * 1000 },
        (typeof names === 'undefined') ? {} : { names });
}
const SEQ_LISTS = {
    'Toonami sign-off': [named('Toonami sign-off', 10)],
    'Toonami intro': [named('Toonami intro', 10)],
    'Weekday sign-off': [named('Weekday sign-off', 10)],
    'Weekday between shows': [named('Weekday between shows', 10)],
    'Toonami between shows': [named('Toonami between shows', 10)],
    'CCF Up Next': [named('CCF Up Next (Dexter)', 10, ['tv.Dexter']), named('CCF Up Next (Ed Edd n Eddy)', 10, ['tv.Ed Edd n Eddy'])],
    'CCF intro': [named('CCF intro', 10)],
    'CCF host intro': [named('CCF host intro', 10)],
    'CCF show intros': [named('CCF show intro (Dexter)', 10, ['tv.Dexter']), named('CCF show intro (Ed Edd n Eddy)', 10, ['tv.Ed Edd n Eddy'])],
    'CCF sign-off': [named('CCF sign-off', 10)],
    'CCF WBRB': [named('CCF WBRB', 10)],
    'CCF BTTS': [named('CCF BTTS', 10)],
    'Miguzi ending': [named('Miguzi ending', 10)],
    'CN City Miguzi outro': [named('CN City Miguzi outro', 10)],
    'CN Cinema bumper': [named('CN Cinema bumper', 10)],
    'Cartoon Theatre intro': [named('Cartoon Theatre intro', 10)],
    'Cartoon Theatre closing': [named('Cartoon Theatre closing', 10)],
    'CN City Grim bumper': [named('CN City Grim bumper', 10, ['tv.Grim'])],
    // "Grim / Foster's" names the next show and the one after it: coming up, in that order.
    'Now/Then': [named('Now/Then (Grim / Fosters)', 10, ['tv.Grim', 'tv.Fosters']),
        named('Now/Then (Foster\'s / Grim)', 10, ['tv.Fosters', 'tv.Grim'])],
    // Two NEXT clips for Space Ghost, so the out and in step each get one, and one for another show.
    'AS NEXT': [named('NEXT - Home Movies', 10, ['tv.Home Movies']),
        named('SGC2C NEXT promo', 15, ['tv.Space Ghost']), named('NEXT - SGC2C', 10, ['tv.Space Ghost'])],
    'NN Next Promos': [named('Next Promo (Cheers)', 10, ['tv.Cheers']), named('Next Promo (Wings)', 10, ['tv.Wings'])],
    'NN Up Next': [named('Up Next (Cheers)', 10, ['tv.Cheers']), named('Up Next (Taxi)', 10, ['tv.Taxi'])],
    'NN Up Next generic': [named('Up Next (generic)', 10)],
    'NN WBRB': [named('WBRB', 10)],
    'NN BTTS': [named('BTTS', 10)],
};
// The SGC2C promo has been idle longer than the other SGC2C clip, so which one
// plays first is decided by idleness and not by where it sits in the list.
const SEQ_PLAYED = { 'NEXT - SGC2C': 5 };
const seqEnv = {
    getList: (id) => SEQ_LISTS[id] || null,
    lastPlayed: (c) => SEQ_PLAYED[c.title] || 0,
};

const ccnSeq = withTransitions(Object.assign({}, ccn, {
    blocks: ccn.blocks.concat([
        // Saturday 4-6pm, inside CN City Day, straight after Miguzi.
        { name: 'Cartoon Theatre', fillerCollections: mix([['Powerhouse', 100]]),
          airings: [ { days: [6], start: 16 * HOUR, end: 18 * HOUR } ] },
    ]),
}), {
    'Weekday': {
        leaving: { out: [sseq('wd-leave', 'Weekday sign-off')], in: [] },
        betweenShows: { out: [sseq('wd-bs', 'Weekday between shows')], in: [] },
    },
    'Toonami': {
        leaving: { out: [sseq('tn-signoff', 'Toonami sign-off')], in: [] },
        entering: { out: [sseq('tn-intro', 'Toonami intro')], in: [] },
        betweenShows: { out: [sseq('tn-bs', 'Toonami between shows')], in: [] },
    },
    'CCF': {
        leaving: { out: [sseq('ccf-signoff', 'CCF sign-off')], in: [] },
        entering: { out: [nextStep('ccf-up', 'CCF Up Next')],
            in: [sseq('ccf-intro', 'CCF intro'), sseq('ccf-host', 'CCF host intro'), nextStep('ccf-show', 'CCF show intros')] },
        betweenEpisodes: { out: [sseq('ccf-wbrb', 'CCF WBRB')], in: [sseq('ccf-btts', 'CCF BTTS')] },
    },
    'Miguzi': {
        leaving: { out: [sseq('mg-end', 'Miguzi ending'), sseq('mg-outro', 'CN City Miguzi outro')], in: [] },
    },
    'Cartoon Theatre': {
        leaving: { out: [sseq('ct-closing', 'Cartoon Theatre closing')], in: [] },
        entering: { out: [], in: [sseq('ct-cinema', 'CN Cinema bumper'), sseq('ct-intro', 'Cartoon Theatre intro')] },
    },
    'CN City Day': {
        entering: { out: [nextStep('grim-bumper', 'CN City Grim bumper')], in: [nextStep('now-then', 'Now/Then')] },
    },
    'Adult Swim': {
        betweenShows: { out: [nextStep('as-out', 'AS NEXT')], in: [nextStep('as-in', 'AS NEXT')] },
    },
});

// Nick at Nite between shows: a Next Promos step, then the Up Next bumper, then
// a WBRB on the way out and a BTTS on the way in that play only when the Up Next
// step found no bumper. The promo comes first and most shows have none, which is
// why the marked steps name the Up Next step and not "any step".
function nickSequence(upNextExtra) {
    return withTransitions(nickPicks, {
        'Nick at Nite': {
            betweenShows: {
                out: [nextStep('promo', 'NN Next Promos'),
                    nextStep('up', 'NN Up Next', upNextExtra),
                    sseq('wbrb', 'NN WBRB', { onlyIfNoMatch: 'up' })],
                in: [sseq('btts', 'NN BTTS', { onlyIfNoMatch: 'up' })],
            },
        },
    });
}
const nickSeq = nickSequence();
const nickSeqFallback = nickSequence({ fallbackListId: 'NN Up Next generic' });

function episode(showTitle, n, mins) {
    return { title: `${showTitle} ${n}`, key: `/e/${showTitle}${n}`, type: 'episode', showTitle,
        season: 1, episode: n, duration: mins * MIN, serverKey: 'srv' };
}
function movie(title, mins) {
    return { title, key: `/m/${title}`, type: 'movie', duration: mins * MIN, serverKey: 'srv' };
}

// The plan for the break at programs[flexIndex], with programs[0] starting at
// `firstStart` (a local-time ISO string), as the lineup would lay it out.
function planOf(base, programs, firstStart, flexIndex) {
    const channel = Object.assign({}, base, { programs,
        duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(at(firstStart)).toISOString() });
    let t = at(firstStart);
    for (let i = 0; i < flexIndex; i++) {
        t += programs[i].duration;
    }
    return transitions.buildPlan(channel, transitions.findBreak(channel, flexIndex, t), seqEnv);
}
// What a plan plays, as a line a row can state: out steps, Flex, in steps.
function render(plan) {
    return plan.out.map((s) => s.clip.title).concat(['Flex'], plan.in.map((s) => s.clip.title)).join(' -> ');
}

// One day of 25-minute shows with a 5-minute break after each, seven days
// round, so the week is a plain 336-break cycle whose split can be worked out
// by hand. A day-part runs all week; a block airs 20:00-22:00 daily.
const weekChannel = {
    number: 60, name: 'Week', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
    dayParts: [{ name: 'Day', fillerCollections: mix([['Powerhouse', 100]]), starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] }],
    blocks: [{ name: 'Prime', fillerCollections: mix([['CCF', 100]]),
        airings: [{ days: [0, 1, 2, 3, 4, 5, 6], start: 20 * HOUR, end: 22 * HOUR }] }],
};
function weekSplit(channel) {
    const programs = [];
    for (let i = 0; i < 7 * 48; i++) {
        // the shows run A, A, B, A, A, B...; 48 cells a day is a multiple of 3, so the pattern is the same every day
        programs.push(episode(['A', 'A', 'B'][i % 3], i, 25), flex(5));
    }
    const full = Object.assign({}, channel, { programs,
        duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(at('2026-01-04T00:00:00')).toISOString() });
    const before = JSON.stringify(full);
    const counts = { betweenEpisodes: 0, betweenShows: 0, boundary: 0 };
    let notEmpty = 0;
    const breaks = transitions.breaksBetween(full, at('2026-01-04T00:00:00'), at('2026-01-11T00:00:00'));
    for (const brk of breaks) {
        const plan = transitions.buildPlan(full, brk, seqEnv);
        counts[plan.situation]++;
        if (plan.out.length > 0 || plan.in.length > 0 || plan.skipped.length > 0) {
            notEmpty++;
        }
    }
    return `${breaks.length} breaks: ${counts.betweenEpisodes} / ${counts.betweenShows} / ${counts.boundary}, `
        + `${notEmpty} with a plan, channel ${JSON.stringify(full) === before ? 'untouched' : 'CHANGED'}`;
}

// ------------------------------------------------------------------ runner
//
// Draws N picks for a break. By default the break sits between two real
// shows (`Before`/`After`), which is what puts the neighbour rule to work;
// `noNeighbour: true` runs the break to the end of time instead, for the
// "no program neighbour" fallback rows.
function draw(channel, breakStart, opts) {
    opts = opts || {};
    const breakMins = opts.breakMins || 60;
    const elapsedMins = opts.elapsedMins || 5;
    const programs = opts.noNeighbour
        ? [flex(breakMins)]
        : [show('Before', 30), flex(breakMins), show('After', 30)];
    const channelWithBreak = Object.assign({}, channel, { programs });
    const obj = {
        program: programs[opts.noNeighbour ? 0 : 1],
        timeElapsed: elapsedMins * MIN,
        programIndex: opts.noNeighbour ? 0 : 1,
    };
    const fillers = fillersFor(channelWithBreak);
    const t0 = breakStart + elapsedMins * MIN;
    const store = freshStore();
    const tally = {};
    for (let i = 0; i < (opts.n || 400); i++) {
        const item = helperFuncs.createLineup(store, obj, channelWithBreak, fillers, opts.isFirst === true, t0).shift();
        const key = (item.type === 'commercial') ? ownerOf(item.title) : `<${item.title}>`;
        tally[key] = (tally[key] || 0) + 1;
    }
    return tally;
}

// The break ends exactly at `when` - i.e. the next real show starts at `when`
// - which is how every "break after/before a show" row in the spec is
// phrased.
function breakEndingAt(channel, when, opts) {
    opts = Object.assign({ breakMins: 8, elapsedMins: 3 }, opts || {});
    return draw(channel, when - opts.breakMins * MIN, opts);
}

function listsIn(tally) {
    return Object.keys(tally).sort();
}
function pct(tally) {
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    return Object.entries(tally).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${(100 * v / total).toFixed(0)}%`).join(' / ');
}

// One row = one line of a spec acceptance table. `run` returns a tally from
// draw()/breakEndingAt() (or any future helper stage 2 adds); `expect` is the
// set of lists that must appear, order-independent - the rows aren't asserting
// exact weights, since that's a separate, statistical concern handled below
// stage 1's table.
function row(stage, desc, expect, run) {
    return { stage, desc, expect: expect.slice().sort(), run };
}
// A stage 5 row: `run` returns a line (a rendered plan, a count), `expect` is
// that line, and order matters.
function planRow(stage, desc, expect, run) {
    return { stage, desc, plan: true, expect, run };
}

const ROWS = [
    // --- Stage 1: docs/blocks-spec.md "Stage 1 - resolver, day-parts only" ---
    row(1, 'Nick Picks | Mon 10:00am | 90s Nick 70% / 90s Nick IDs 30% (4 min cooldown)',
        ['90s Nick', '90s Nick IDs'],
        () => draw(nickPicks, at('2026-01-05T10:00:00'))),

    row(1, 'Nick Picks | Mon, break after the last 90s Nick show | Nick at Nite',
        ['Nick at Nite'],
        () => breakEndingAt(nickPicks, at('2026-01-05T20:00:00'))),

    row(1, 'Nick Picks | Fri 6:00am | 2000s Nick ~80% / IDs ~20% (5 min) / music videos remainder (30 min)',
        ['2000s Nick', '2000s Nick IDs', 'music videos'],
        () => draw(nickPicks, at('2026-01-09T06:00:00'))),

    row(1, 'Nick Picks | Fri, break after the last 2000s Nick show | Friday Nick at Nite',
        ['Friday Nick at Nite'],
        () => breakEndingAt(nickPicks, at('2026-01-09T20:00:00'))),

    row(1, 'CCN | Mon 6:00am | Powerhouse 95% / CN Groovies 5% (3000s)',
        ['Powerhouse', 'CN Groovies'],
        () => draw(ccn, at('2026-01-05T06:00:00'))),

    row(1, 'CCN | Tue 12:00am | Adult Swim [weekday]',
        ['Adult Swim'],
        () => draw(ccn, at('2026-01-06T00:00:00'))),

    row(1, 'CCN | Sat 7:00pm, January | CN City Night',
        ['CN City Night'],
        () => draw(ccn, at('2026-01-17T19:00:00'))),

    row(1, 'CCN | Sat 8:00pm, July | CN City Night',
        ['CN City Night'],
        () => draw(ccn, at('2026-07-18T20:00:00'))),

    row(1, 'CCN | Sun 12:00am | Toonami AcTN',
        ['Toonami AcTN'],
        () => draw(ccn, at('2026-01-04T00:00:00'))),

    // An explicit short break, not the 60-minute default: stage 2 gives
    // Toonami a midnight-run airing starting at 1:00am (below), so the
    // default would land this row's neighbour exactly on that boundary and
    // it would stop testing what it claims to - day-part carryover, clear of
    // any block. 15 minutes keeps the neighbour well before 1am.
    row(1, 'CCN | Sat 12:00am | Powerhouse 95% / CN Groovies 5% - the weekday day-part still running from Friday',
        ['Powerhouse', 'CN Groovies'],
        () => draw(ccn, at('2026-01-17T00:00:00'), { breakMins: 15 })),

    row(1, 'CCN | Sat 3:00am | Powerhouse only',
        ['Powerhouse'],
        () => draw(ccn, at('2026-01-17T03:00:00'))),

    row(1, 'Any channel without day-parts | Any time | Existing Flex tab, unchanged',
        ['Powerhouse', 'CN Groovies'],
        () => draw(plain, at('2026-01-05T10:00:00'))),

    // --- Supplementary stage 1 coverage: not literal spec rows, but ---
    // --- regression coverage for findings the spec text calls out.   ---

    // The daylight-saving option (spec: "shift with daylight saving ... 7:00
    // PM in winter, 8:00 PM in summer"), confirmed at the boundary itself
    // rather than only at the two spec-given snapshots, so a resolver that
    // got the shift direction backwards can't pass by landing on the same
    // hour from the wrong side.
    row(1, 'CCN | Sat 7:00pm, July | still CN City Day - the 7pm start has shifted to 8pm',
        ['CN City Day'],
        () => breakEndingAt(ccn, at('2026-07-18T19:30:00'))),
    row(1, 'CCN | Sat 8:00pm, January | CN City Night - started an hour ago',
        ['CN City Night'],
        () => breakEndingAt(ccn, at('2026-01-17T19:30:00'))),

    // Open question 2's finding: a break with no program neighbour has
    // nothing to anchor it and resolves from the clock, same as a channel
    // with no slots either side of a Flex stretch.
    row(1, 'All-Flex CCN at Sat 3:00am resolves from the clock',
        ['Powerhouse'],
        () => draw(ccn, at('2026-01-17T03:00:00'), { noNeighbour: true, breakMins: 600 })),
    row(1, 'All-Flex CCN at Tue 12:00am resolves from the clock',
        ['Adult Swim'],
        () => draw(ccn, at('2026-01-06T00:00:00'), { noNeighbour: true, breakMins: 600 })),

    // --- Stage 2: docs/blocks-spec.md "Stage 2" acceptance table ---
    //
    // Toonami's weekday airing is [14:30, 17:00) - see the ccn.blocks
    // fixture above. The first two rows below are the ones that actually
    // discriminate a neighbour-based resolver from a clock-based one, in
    // opposite directions: this one puts the neighbour *inside* the window
    // while the break itself sits outside it.
    row(2, 'CCN | Wed, break between the 2:30 and 3:00 shows | Toonami - Powerhouse 30% / Toonami promos 70%',
        ['Powerhouse', 'Toonami promos'],
        () => breakEndingAt(ccn, at('2026-01-07T15:00:00'))),

    row(2, 'CCN | Thu, same break | Weekday day-part - Toonami doesn\'t air Thursday',
        ['Powerhouse', 'CN Groovies'],
        () => breakEndingAt(ccn, at('2026-01-08T15:00:00'))),

    // The other direction: the break itself sits inside Toonami's clock
    // window (16:52-17:00), but the neighbour starts right on the window's
    // exclusive end, so the correct answer is the Weekday day-part - a
    // clock-based resolver evaluated at the break would wrongly say Toonami.
    row(2, 'CCN | Mon, break after the 4:30 show | Weekday day-part',
        ['Powerhouse', 'CN Groovies'],
        () => breakEndingAt(ccn, at('2026-01-05T17:00:00'))),

    // Same answer as the row above under this resolver, and also under a
    // clock-based one - the break has clearly moved past 17:00 either way,
    // so this row alone would not catch a clock-based implementation. It is
    // still transcribed because the spec's acceptance table lists it, and
    // because it confirms findNextProgram's duration-accumulation walk (which
    // is all "overrun" ever is, this far down the pipeline: a longer
    // recorded duration on whatever program came before) is not thrown off
    // by an unusually large one.
    row(2, 'CCN | Mon, 4:30 show overruns to 5:05, break after it | Weekday day-part',
        ['Powerhouse', 'CN Groovies'],
        () => breakEndingAt(ccn, at('2026-01-05T17:05:00'))),

    // Toonami's other airing - one block, two airings, one mix, per the spec.
    // Without it this moment would resolve to the Weekday day-part left
    // running over from Friday (stage 1's own "Sat 12:00am" row), so this
    // also proves a block outranks a day-part it would otherwise fall back to.
    row(2, 'CCN | Sat 1:00am | Toonami (midnight run airing)',
        ['Powerhouse', 'Toonami promos'],
        () => draw(ccn, at('2026-01-03T01:00:00'))),

    // A short break, not the 60-minute default: Miguzi's window is itself
    // only an hour wide, so the default would let the neighbour land past it.
    row(2, 'CCN | Sat 3:00pm | CN City Day 70% / Miguzi 30%',
        ['CN City Day', 'Miguzi'],
        () => draw(ccn, at('2026-01-03T15:00:00'), { breakMins: 15 })),

    // Block-to-block: the incoming context is CCF, not Toonami (which just
    // ended) and not the Weekday day-part (which never actually governs this
    // moment, since CCF's airing starts the instant Toonami's does).
    row(2, 'CCN | Fri, break between Toonami\'s last show and CCF\'s first | CCF',
        ['CCF'],
        () => breakEndingAt(ccn, at('2026-01-09T17:00:00'))),

    // --- Supplementary stage 2 coverage: not literal spec rows. ---

    // Two different blocks whose airings overlap - see the `overlapping`
    // fixture above. 11:30 sits inside both First [10,12) and Second [11,13);
    // the first-declared one wins.
    row(2, 'Two blocks with overlapping airings resolve to whichever is declared first',
        ['Powerhouse'],
        () => breakEndingAt(overlapping, at('2026-01-05T11:30:00'))),

    // --- Stage 5: docs/blocks-spec.md "Stage 5". Plans only - which clips a
    // break's steps choose. How a stream plays them (late, early, tuning in)
    // is step 4's cursor and is tested there. "Next Time" needs keyedOn
    // "later", which is step 8, so the Cartoon Theatre -> Grim row has no
    // Next Time step yet.
    //
    // Each row lays out its own lineup against the ccnSeq / nickSeq fixtures
    // above, so it holds whatever Ron's real block times are.
    planRow(5, 'Fri, Toonami -> CCF | Toonami sign-off -> CCF Up Next -> Flex -> CCF intro -> CCF host intro -> CCF show intro',
        'Toonami sign-off -> CCF Up Next (Ed Edd n Eddy) -> Flex -> CCF intro -> CCF host intro -> CCF show intro (Ed Edd n Eddy)',
        () => render(planOf(ccnSeq, [episode('Toonami Show', 1, 30), flex(5), episode('Ed Edd n Eddy', 1, 25)],
            '2026-01-09T16:30:00', 1))),

    planRow(5, 'Inside CCF, episodes of one show | WBRB -> Flex -> BTTS',
        'CCF WBRB -> Flex -> CCF BTTS',
        () => render(planOf(ccnSeq, [episode('Ed Edd n Eddy', 1, 25), flex(5), episode('Ed Edd n Eddy', 2, 25)],
            '2026-01-09T18:00:00', 1))),

    // The same show on both sides, as it would be when the last episode of the
    // night is followed by the next night's: it is a boundary all the same, so
    // the block's between-episodes steps do not fire.
    planRow(5, 'CCF\'s last show | no WBRB; the boundary sequence fires instead',
        'CCF sign-off -> Flex',
        () => render(planOf(ccnSeq, [episode('Ed Edd n Eddy', 3, 25), flex(5), episode('Ed Edd n Eddy', 4, 25)],
            '2026-01-09T19:35:00', 1))),

    planRow(5, 'Sat, Miguzi -> Cartoon Theatre | Miguzi ending -> CN City Miguzi outro -> Flex -> CN Cinema bumper -> Cartoon Theatre intro',
        'Miguzi ending -> CN City Miguzi outro -> Flex -> CN Cinema bumper -> Cartoon Theatre intro',
        () => render(planOf(ccnSeq, [episode('Miguzi Show', 1, 30), flex(5), movie('Cartoon Theatre Movie', 90)],
            '2026-01-17T15:30:00', 1))),

    // Grim's day-part has the Grim bumper before the Flex and, after it, a clip
    // naming Grim then Foster's: a step keyed on next reads two names as "coming
    // up: these two, in this order", so it plays only when the show after Grim
    // is Foster's.
    planRow(5, 'Sat, Cartoon Theatre -> Grim, followed by Foster\'s | closing -> Grim bumper -> Flex -> Now/Then (Grim / Fosters)',
        'Cartoon Theatre closing -> CN City Grim bumper -> Flex -> Now/Then (Grim / Fosters)',
        () => render(planOf(ccnSeq, [movie('Cartoon Theatre Movie', 90), flex(5), episode('Grim', 1, 25), flex(5), episode('Fosters', 1, 25)],
            '2026-01-17T16:30:00', 1))),

    planRow(5, 'Now/Then when Grim is followed by anything other than Foster\'s | skipped',
        'Cartoon Theatre closing -> CN City Grim bumper -> Flex',
        () => render(planOf(ccnSeq, [movie('Cartoon Theatre Movie', 90), flex(5), episode('Grim', 1, 25), flex(5), episode('Eddy', 1, 25)],
            '2026-01-17T16:30:00', 1))),

    planRow(5, 'Mon, weekday day-part -> Toonami block | Toonami entering fires with the day-part\'s leaving; between-shows steps on either context do not',
        'Weekday sign-off -> Toonami intro -> Flex',
        () => render(planOf(ccnSeq, [episode('Pokemon', 1, 30), flex(5), episode('Bleach', 1, 25)],
            '2026-01-05T14:00:00', 1))),

    // From channel 1's lineup: a between-shows sequence on the Adult Swim
    // day-parts, one show step keyed on next from a list of NEXT clips, skip if
    // none, on both sides.
    planRow(5, 'ATHF -> Space Ghost | 15s SGC2C NEXT promo -> Flex -> 10s NEXT - SGC2C',
        'SGC2C NEXT promo -> Flex -> NEXT - SGC2C',
        () => render(planOf(ccnSeq, [episode('ATHF', 1, 26), flex(4), episode('Space Ghost', 1, 15)],
            '2026-01-06T01:30:00', 1))),

    planRow(5, 'Space Ghost -> a show with no NEXT clip | Flex only; both steps skipped',
        'Flex',
        () => render(planOf(ccnSeq, [episode('Space Ghost', 2, 15), flex(5), episode('The Venture Bros', 1, 25)],
            '2026-01-06T02:00:00', 1))),

    // Nick at Nite: Next Promos, then Up Next, then WBRB / BTTS only if the Up
    // Next step found nothing. The promo step is why the marked steps name a
    // step: most shows have no promo, and that must not bring WBRB in when the
    // Up Next bumper played.
    planRow(5, 'Nick at Nite | the show has a promo and an Up Next: both play, no WBRB / BTTS',
        'Next Promo (Cheers) -> Up Next (Cheers) -> Flex',
        () => render(planOf(nickSeq, [episode('Frasier', 1, 25), flex(5), episode('Cheers', 1, 25)],
            '2026-01-05T21:00:00', 1))),

    planRow(5, 'Nick at Nite | the promo step finds nothing and the Up Next plays: WBRB and BTTS stay out',
        'Up Next (Taxi) -> Flex',
        () => render(planOf(nickSeq, [episode('Frasier', 1, 25), flex(5), episode('Taxi', 1, 25)],
            '2026-01-05T21:00:00', 1))),

    planRow(5, 'Nick at Nite | the Up Next finds nothing and so does the promo: WBRB out, BTTS in',
        'WBRB -> Flex -> BTTS',
        () => render(planOf(nickSeq, [episode('Frasier', 1, 25), flex(5), episode('Perfect Strangers', 1, 25)],
            '2026-01-05T21:00:00', 1))),

    planRow(5, 'Nick at Nite | the promo plays but the Up Next finds nothing: WBRB and BTTS still play',
        'Next Promo (Wings) -> WBRB -> Flex -> BTTS',
        () => render(planOf(nickSeq, [episode('Frasier', 1, 25), flex(5), episode('Wings', 1, 25)],
            '2026-01-05T21:00:00', 1))),

    planRow(5, 'Nick at Nite | the Up Next step falls back to its generic list: that counts as a match, WBRB and BTTS stay out',
        'Up Next (generic) -> Flex',
        () => render(planOf(nickSeqFallback, [episode('Frasier', 1, 25), flex(5), episode('Perfect Strangers', 1, 25)],
            '2026-01-05T21:00:00', 1))),

    // 7 days x 48 half-hours is 336 breaks. A show runs A, A, B on a repeating
    // cycle: 112 breaks follow an A that is followed by another A, and 224 are
    // one show handing to another. The day-part-to-block boundaries are the
    // break before 20:00 (after an A, so it would have been between episodes)
    // and the one before 22:00 (after an A going to a B, between shows), seven
    // days each: 14 boundaries, 105 between episodes (112 - 7) and 217 between
    // shows (224 - 7). With no sequences configured, no break has a plan at all.
    planRow(5, 'A week with no sequences configured | every break is classified and none has a plan',
        '336 breaks: 105 / 217 / 14, 0 with a plan, channel untouched',
        () => weekSplit(weekChannel)),
];

module.exports = async function run() {
    const suite = new Suite('blocks-acceptance');
    let stage = null;
    for (const r of ROWS) {
        if (r.stage !== stage) {
            stage = r.stage;
            suite.log(`-- stage ${stage} --`);
        }
        if (r.plan) {
            const line = r.run();
            suite.check(r.desc, line === r.expect, `-> ${line}`);
            continue;
        }
        const tally = r.run();
        const got = listsIn(tally);
        suite.check(r.desc, JSON.stringify(got) === JSON.stringify(r.expect), `-> ${pct(tally)}`);
    }

    // The configured weights should govern once the longest-idle branch is
    // disabled (isFirst: true) - measured, not just "some subset of lists
    // appeared", for the two rows in the spec that state percentages.
    suite.log('-- weights, isFirst so the longest-idle branch is off --');
    const nickWeights = draw(nickPicks, at('2026-01-05T10:00:00'), { isFirst: true, n: 4000 });
    const nickTotal = Object.values(nickWeights).reduce((a, b) => a + b, 0);
    suite.check('Nick Picks 90s mix lands near 70/30',
        Math.abs(nickWeights['90s Nick'] / nickTotal - 0.7) < 0.05, `-> ${pct(nickWeights)}`);

    const ccnWeights = draw(ccn, at('2026-01-05T06:00:00'), { isFirst: true, n: 4000 });
    const ccnTotal = Object.values(ccnWeights).reduce((a, b) => a + b, 0);
    suite.check('CCN weekday mix lands near 95/5',
        Math.abs(ccnWeights['Powerhouse'] / ccnTotal - 0.95) < 0.05, `-> ${pct(ccnWeights)}`);

    return suite;
};

// Allow `node test/blocks-acceptance.js` on its own during development.
if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
