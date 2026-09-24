/*
 * The acceptance tests from docs/blocks-spec.md, driven straight through
 * createLineup. One table, ROWS, transcribed from the spec's "| Channel |
 * When | Expected |" markdown tables - each row names the stage it belongs
 * to, so stage 2 appends its own rows (and whatever fixtures/helpers they
 * need) to this same file and array rather than starting a parallel one.
 * A stage merges only when its rows pass, per the spec's own rule.
 */
const { helperFuncs, dayParts, MIN, HOUR, at, freshStore, clip, show, flex, mix, Suite } = require('./support');

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

const plain = channelOf(30, 'Plain', undefined);
delete plain.dayParts;
plain.fillerCollections = mix([['Powerhouse', 50], ['CN Groovies', 50]]);

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

    row(1, 'CCN | Sat 12:00am | Powerhouse 95% / CN Groovies 5% - the weekday day-part still running from Friday',
        ['Powerhouse', 'CN Groovies'],
        () => draw(ccn, at('2026-01-17T00:00:00'))),

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

    // --- Stage 2 rows go here. Add fixtures (Toonami, CCF, ...) above the ---
    // --- ROWS array, then row(2, ...) entries below, following the same  ---
    // --- draw()/breakEndingAt() pattern - or a new helper, if a stage 2  ---
    // --- scenario (an overrun, a break between two named shows) needs    ---
    // --- one, added next to draw() above.                                ---
];

module.exports = async function run() {
    const suite = new Suite('blocks-acceptance');
    let stage = null;
    for (const r of ROWS) {
        if (r.stage !== stage) {
            stage = r.stage;
            suite.log(`-- stage ${stage} --`);
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
