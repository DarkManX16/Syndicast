/*
 * A channel with neither day-parts nor blocks must behave exactly as it did
 * before either existed - the spec's own acceptance rule, unchanged by stage
 * 2 adding a second kind of overlay alongside the first. When this was first
 * verified (see NOTES.md), that meant diffing this code against the previous
 * commit's helperFuncs.js/channel-cache.js extracted with `git show`. That
 * one-time comparison isn't kept here: pinned to a commit, it would either
 * rot as history moves past it or break outright if that commit is ever
 * rewritten, for a guarantee that only needs proving once per change to this
 * code path, not replayed on every future `npm test`.
 *
 * What's kept is the same three guarantees, restated as self-contained
 * assertions instead of a diff, plus - added for stage 2 - the same identity
 * guarantee checked for blocks alone and for day-parts alone, so neither kind
 * of overlay can silently start intervening on a channel that only carries
 * the other:
 *   - a deterministic pick is byte-identical to what the picker has always
 *     produced (no randomness in play, so this is exact, not statistical)
 *   - the picker is handed the very same array object a channel with no
 *     overlay was always handed, not a copy or a rebuild
 *   - a realistic run's distribution is still governed by the configured
 *     list weights, not driven off course by the overlay machinery
 */
const { helperFuncs, dayParts, channelCache, MIN, freshStore, clip, show, mix, Suite } = require('./support');

function plainChannel(collections) {
    return {
        number: 77, name: 'Plain', offlineMode: 'pic', fallback: [],
        fillerRepeatCooldown: 30 * MIN, fillerCollections: collections,
        programs: [
            show('S', 30),
            { isOffline: true, duration: 60 * MIN },
            show('T', 30),
        ],
    };
}
function breakObj() {
    return { program: { isOffline: true, duration: 60 * MIN }, timeElapsed: 5 * MIN, programIndex: 1 };
}

module.exports = async function run() {
    const suite = new Suite('blocks-unchanged');

    // 1. Deterministic: one list, one clip shorter than the break, isFirst
    // false. Nothing about this pick is random, so the exact emitted item is
    // pinned rather than merely "some commercial from the right list".
    {
        const ch = plainChannel(mix([['L', 100]]));
        const fillers = [{ id: 'L', content: [clip('only', 2)], weight: 100, cooldown: 0 }];
        const [item] = helperFuncs.createLineup(freshStore(), breakObj(), ch, fillers, false, Date.now());
        suite.check('deterministic pick: type is commercial', item.type === 'commercial');
        suite.check('deterministic pick: the only clip in the only list', item.title === 'only' && item.fillerId === 'L');
        suite.check('deterministic pick: plays from its own start (not truncated for the break)',
            item.start === 0 && item.streamDuration === item.duration,
            `start=${item.start} streamDuration=${item.streamDuration} duration=${item.duration}`);
    }

    // 2. Identity: neither day-parts nor blocks means the resolver hands back
    // the channel's own array, unchanged, and declines to compute a mix at
    // all - stage 2's version of the guarantee stage 1 shipped.
    {
        const ch = plainChannel(mix([['L', 100]]));
        suite.check('allFillerCollections returns the channel\'s own array, by reference',
            dayParts.allFillerCollections(ch) === ch.fillerCollections);
        suite.check('resolveCollections declines to intervene when there is no overlay',
            dayParts.resolveCollections(ch, Date.now(), breakObj()) === null);
    }

    // 2b. Blocks alone, with no day-parts, must intervene exactly the way
    // day-parts alone always has - hasOverlay is the guard resolveCollections
    // and allFillerCollections actually use, not hasDayParts specifically. A
    // full-week airing sidesteps any dependence on when this test happens to
    // run.
    {
        const ch = plainChannel(mix([['L', 100]]));
        ch.blocks = [
            { name: 'B', fillerCollections: mix([['M', 100]]),
              airings: [ { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 * 60 * MIN } ] },
        ];
        suite.check('a channel with only blocks is not handed its own array by reference',
            dayParts.allFillerCollections(ch) !== ch.fillerCollections);
        suite.check('a channel with only blocks still has resolveCollections intervene',
            dayParts.resolveCollections(ch, Date.now(), breakObj()) !== null);
    }

    // 2c. Day-parts alone, with no blocks, must resolve exactly as they did
    // before blocks existed: blockContextAt (see day-parts.js) is a no-op
    // when channel.blocks is absent or empty, so resolveContext falls
    // straight through to the same day-part chain stage 1 shipped, and an
    // omitted blocks field and an explicitly empty one must agree.
    {
        const ch = plainChannel(mix([['L', 100]]));
        ch.dayParts = [
            { name: 'D', fillerCollections: mix([['M', 100]]),
              starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] },
        ];
        const t = new Date('2026-01-05T10:00:00').getTime();
        const withoutBlocksField = dayParts.resolveContext(ch, t);
        ch.blocks = [];
        const withEmptyBlocksField = dayParts.resolveContext(ch, t);
        suite.check('day-parts resolve the same whether blocks is absent or an empty array',
            (withoutBlocksField === withEmptyBlocksField) && (withoutBlocksField.name === 'D'));
    }

    // 3. Distribution: a realistic run, with cooldown contention and the
    // longest-idle branch both active (isFirst not forced), should still be
    // governed by the configured 70/30 weight rather than, say, splitting
    // evenly or starving one list. The tolerance is wide on purpose - this is
    // a smoke test that day-parts hasn't disturbed the existing picker, not a
    // re-statement of the picker's own statistical behaviour, which
    // test/blocks-acceptance.js already covers with isFirst forced off.
    {
        channelCache.clearPlayback(77);
        const ch = plainChannel(mix([['A', 70], ['B', 30, 4 * MIN]]));
        const fillers = [
            { id: 'A', content: [clip('A1', 2), clip('A2', 3), clip('A3', 1), clip('A4', 2)], weight: 70, cooldown: 0 },
            { id: 'B', content: [clip('B1', 2), clip('B2', 4), clip('B3', 1)], weight: 30, cooldown: 4 * MIN },
        ];
        const store = freshStore();
        const tally = { A: 0, B: 0 };
        let t0 = new Date('2026-01-05T10:00:00').getTime();
        const N = 6000;
        for (let i = 0; i < N; i++) {
            const obj = { program: { isOffline: true, duration: 600 * MIN },
                          timeElapsed: (i * 137) % (500 * MIN), programIndex: 1 };
            const item = helperFuncs.createLineup(store, obj, ch, fillers, false, t0).shift();
            if (item.type !== 'commercial') continue;
            tally[item.title[0]]++;
            channelCache.recordPlayback(store, ch.number, t0, item);
            t0 += item.streamDuration;
        }
        const total = tally.A + tally.B;
        const aShare = tally.A / total;
        suite.check('70/30 mix stays roughly weight-governed over a realistic run',
            aShare > 0.5 && aShare < 0.9, `A ${(100 * aShare).toFixed(1)}% / B ${(100 * (1 - aShare)).toFixed(1)}% over ${total} picks`);
        suite.check('the lighter list still gets picked at all',
            tally.B > 0, `B picked ${tally.B} times`);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
