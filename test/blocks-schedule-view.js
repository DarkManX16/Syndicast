/*
 * weeklySegments (src/day-parts.js) is what the channel editor's weekly
 * overview and the Block Schedule Manager both draw from - "what covers this
 * stretch of the week, and when" as spans, rather than one instant's answer.
 * It samples resolveContext rather than re-deriving precedence itself, so
 * these checks are really about the merge/boundary bookkeeping around that,
 * cross-checked against the exact Saturday timeline docs/blocks-spec.md's own
 * stage 2 acceptance table implies for CCN.
 *
 * A local, reduced fixture rather than importing blocks-acceptance.js's ccn -
 * every file in this suite builds its own, so one file's edit to a shared
 * fixture can never silently change what another file is asserting. The
 * January/July reference instants are the exact dates blocks-acceptance.js
 * already uses for CN City Night's daylight-saving row, reused here rather
 * than picked fresh, since that file already worked out which Saturdays land
 * correctly on either side of the transition.
 */
const { dayParts, MIN, HOUR, DAY, at, mix, Suite } = require('./support');

const ccn = {
    number: 20, name: 'CCN',
    fillerCollections: mix([['Powerhouse', 100]]),
    dayParts: [
        { name: 'Weekday', fillerCollections: mix([['Powerhouse', 95], ['CN Groovies', 5]]),
          starts: [{ days: [1, 2, 3, 4, 5], time: 6 * HOUR }] },
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
    ],
    blocks: [
        { name: 'Toonami', fillerCollections: mix([['Powerhouse', 30], ['Toonami promos', 70]]),
          airings: [
              { days: [1, 2, 3, 5], start: 14 * HOUR + 30 * MIN, end: 17 * HOUR },
              { days: [6], start: 1 * HOUR, end: 3 * HOUR },
          ] },
        { name: 'Miguzi', fillerCollections: mix([['CN City Day', 70], ['Miguzi', 30]]),
          airings: [ { days: [6], start: 15 * HOUR, end: 16 * HOUR } ] },
    ],
};

// Segments carry the actual dayPart/block object as `context` - reduced to a
// name (or 'Flex' for null) here so a failing check prints something legible
// instead of a circular object.
function names(segments) {
    return segments.map( (s) => ( {
        name: s.context ? s.context.name : 'Flex',
        from: s.startMs / HOUR,
        to: s.endMs / HOUR,
    } ) );
}

module.exports = async function () {
    const suite = new Suite('blocks-schedule-view');

    // A Saturday in January: no daylight-saving shift on CN City Night's 7pm start.
    const jan = dayParts.weeklySegments(ccn, at('2026-01-17T12:00:00'));

    suite.check('Tuesday: Adult Swim, Weekday, Toonami, Weekday',
        JSON.stringify(names(jan[2])) === JSON.stringify([
            { name: 'Adult Swim', from: 0, to: 6 },
            { name: 'Weekday', from: 6, to: 14.5 },
            { name: 'Toonami', from: 14.5, to: 17 },
            { name: 'Weekday', from: 17, to: 24 },
        ]), JSON.stringify(names(jan[2])));

    // The spec's own reason this row exists: Toonami's weekday airing
    // deliberately excludes Thursday, so Thursday should read as plain
    // Weekday straight through the block's hours with no carve-out.
    suite.check('Thursday: Toonami does not air, no carve-out',
        JSON.stringify(names(jan[4])) === JSON.stringify([
            { name: 'Adult Swim', from: 0, to: 6 },
            { name: 'Weekday', from: 6, to: 24 },
        ]), JSON.stringify(names(jan[4])));

    // Saturday chains through every kind of handoff this function has to get
    // right: a day-part carried over from Friday, a block overriding it, the
    // block handing back to a day-part exactly at its own boundary, a block
    // nested entirely inside a later day-part, and that day-part resuming.
    suite.check('Saturday (January): the full day-part/block handoff chain',
        JSON.stringify(names(jan[6])) === JSON.stringify([
            { name: 'Weekday', from: 0, to: 1 },
            { name: 'Toonami', from: 1, to: 3 },
            { name: 'Saturday overnight', from: 3, to: 6 },
            { name: 'CN City Day', from: 6, to: 15 },
            { name: 'Miguzi', from: 15, to: 16 },
            { name: 'CN City Day', from: 16, to: 19 },
            { name: 'CN City Night', from: 19, to: 24 },
        ]), JSON.stringify(names(jan[6])));

    // A Saturday in July: CN City Night is marked shiftWithDst, so its 7pm
    // standard-time start reads an hour later on the summer wall clock - the
    // same "7pm in winter, 8pm in summer" the day-part editor itself shows.
    const jul = dayParts.weeklySegments(ccn, at('2026-07-18T12:00:00'));
    suite.check('Saturday (July): CN City Night shifts to 8pm',
        names(jul[6])[names(jul[6]).length - 1].from === 20,
        JSON.stringify(names(jul[6])));

    // Every day covers the full 24 hours with no gap and no overlap,
    // regardless of how many segments it took to get there.
    let contiguous = true;
    for (let d = 0; d < 7; d++) {
        let segs = jan[d];
        if (segs.length === 0 || segs[0].startMs !== 0 || segs[segs.length - 1].endMs !== DAY) {
            contiguous = false;
        }
        for (let i = 1; i < segs.length; i++) {
            if (segs[i].startMs !== segs[i - 1].endMs) {
                contiguous = false;
            }
        }
    }
    suite.check('Every day is covered start to end with no gap or overlap', contiguous);

    // A channel with neither day-parts nor blocks resolves to null
    // everywhere, same as resolveContext itself - one all-day Flex segment
    // per day, not zero segments, so a caller can still draw something
    // rather than special-casing "no data".
    const plain = { number: 30, name: 'Plain', fillerCollections: mix([['Powerhouse', 100]]) };
    const none = dayParts.weeklySegments(plain, at('2026-01-17T12:00:00'));
    suite.check('No day-parts or blocks: one Flex segment per day',
        none.every( (segs) => (segs.length === 1) && (segs[0].context === null)
            && (segs[0].startMs === 0) && (segs[0].endMs === DAY) ),
        JSON.stringify(none.map(names)));

    return suite;
};

// Allow `node test/blocks-schedule-view.js` on its own during development.
if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
