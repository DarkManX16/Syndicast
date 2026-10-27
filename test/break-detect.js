/*
 * The pure break-point detector (src/break-detect.js): black touching a
 * silence, chapters as a second opinion, kind and strength
 * (docs/blocks-spec.md, Stage 6, "Detection" and "A break point").
 */
const { Suite } = require('./support');
const detect = require('../src/break-detect');

// A chapter list, one chapter between each boundary (and one before the first
// and after the last), so chapterBoundaries(...) comes back as exactly `bounds`.
function chapters(bounds) {
    const marks = [0, ...bounds, bounds[bounds.length - 1] + 60];
    const out = [];
    for (let i = 0; i < marks.length - 1; i++) {
        out.push( { s: marks[i], e: marks[i + 1], t: `Chapter ${String(i + 1).padStart(2, '0')}` } );
    }
    return out;
}

module.exports = async () => {
    const suite = new Suite('break detect');

    // ---- reading ffmpeg's own text -------------------------------------------------
    suite.check('silence_start/end pairs are read, clamped at 0',
        JSON.stringify(detect.parseSilence('silence_start: -0.01\nsome other line\nsilence_end: 1.071562 | silence_duration: 1.08\n'))
            === JSON.stringify([[0, 1.071562]]));
    suite.check('a silence still open at the chunk\'s end closes at the fallback',
        JSON.stringify(detect.parseSilence('silence_start: 598.2\n', 600)) === JSON.stringify([[598.2, 600]]));
    suite.check('no fallback and no end: dropped, not left dangling',
        JSON.stringify(detect.parseSilence('silence_start: 598.2\n')) === JSON.stringify([]));
    suite.check('black_start/end pairs are read',
        JSON.stringify(detect.parseBlack('black_start:30.730563 black_end:31.464563\nblack_start:41.275437 black_end:42.442437\n'))
            === JSON.stringify([[30.730563, 31.464563], [41.275437, 42.442437]]));

    // ---- silence grouping -----------------------------------------------------------
    suite.check('a blip under 0.4s never opens a black window',
        JSON.stringify(detect.significantSilences([[1, 1.1], [5, 5.5]])) === JSON.stringify([[5, 5.5]]));
    suite.check('silences under 1s apart merge into one group',
        JSON.stringify(detect.mergeSilences([[10, 10.5], [10.8, 11.2], [20, 20.5]])) === JSON.stringify([[10, 11.2], [20, 20.5]]));
    suite.check('a short group scans whole, padded by 1s',
        JSON.stringify(detect.windowsForSilences([[10, 11.2]])) === JSON.stringify([[9, 12.2]]));
    suite.check('a silence over 6s is scanned at its two ends only',
        JSON.stringify(detect.windowsForSilences([[10, 20]])) === JSON.stringify([[9, 11], [19, 21]]));
    suite.check('a window never reaches past 0 or the file\'s end',
        JSON.stringify(detect.windowsForSilences([[0, 0.5], [10, 20]], { duration: 20.3 })) === JSON.stringify([[0, 1.5], [9, 11], [19, 20.3]]));

    // ---- black touching a silence -----------------------------------------------------
    suite.check('black touching a short silence becomes one point, at the black\'s middle',
        (() => {
            const pts = detect.pointsFromBlack([[30.5, 31.6]], [[30.73, 31.46]]);
            return (pts.length === 1) && (pts[0].black[0] === 30.73) && (pts[0].black[1] === 31.46)
                && (Math.abs(pts[0].at - 31.095) < 1e-9) && (pts[0].silence[0] === 30.5) && (pts[0].sources[0] === 'blackSilence');
        })());
    suite.check('black nowhere near the silence finds nothing',
        detect.pointsFromBlack([[30.5, 31.6]], [[50, 50.2]]).length === 0);
    suite.check('a long silence with black at both ends makes two points, each keeping the full silence span',
        (() => {
            const pts = detect.pointsFromBlack([[100, 115]], [[99.8, 100.2], [114.9, 115.3]]);
            return (pts.length === 2) && (pts[0].silence[0] === 100) && (pts[0].silence[1] === 115) && (pts[1].silence[1] === 115);
        })());
    suite.check('a long silence with black only in its dead middle (not either end) finds nothing',
        detect.pointsFromBlack([[100, 115]], [[107, 107.5]]).length === 0);
    suite.check('several black runs touching one group merge into one span',
        (() => {
            const pts = detect.pointsFromBlack([[30, 32]], [[30.1, 30.3], [30.4, 30.6], [31.8, 32.1]]);
            return (pts.length === 1) && (pts[0].black[0] === 30.1) && (pts[0].black[1] === 32.1);
        })());

    // ---- chapters as a second opinion --------------------------------------------------
    suite.check('a chapter near a point adds a chapter source',
        (() => {
            const pts = [ { at: 706, black: [705.5, 706.5], silence: [705, 707], sources: ['blackSilence'] } ];
            const out = detect.correlateChapters(pts, [ { s: 0, e: 705.8, t: 'Chapter 01' }, { s: 705.8, e: 1400, t: 'Chapter 02' } ], 1400);
            return (out.length === 1) && out[0].sources.includes('chapter');
        })());
    suite.check('a chapter boundary with nothing nearby becomes its own weak point',
        (() => {
            const out = detect.correlateChapters([], [ { s: 0, e: 370, t: 'Chapter 01' }, { s: 370, e: 1400, t: 'Chapter 02' } ], 1400);
            return (out.length === 1) && (out[0].black === null) && (out[0].sources[0] === 'chapter') && (out[0].at === 370);
        })());
    suite.check('a ripper\'s evenly-spaced, whole-minute chapters are ignored outright',
        (() => {
            const chs = chapters([300, 600, 900, 1200]);
            const out = detect.correlateChapters([], chs, 1400);
            return out.length === 0;
        })());
    suite.check('...but chapters on the minute that are NOT evenly spaced still count',
        (() => {
            const chs = chapters([60, 180, 600]);
            const out = detect.correlateChapters([], chs, 1400);
            return out.length === 3;
        })());
    suite.check('a scene list (more than 8 chapters) adds no weak points, only agrees with what\'s already found',
        (() => {
            const bounds = [97, 211, 338, 452, 561, 688, 799, 915, 1030];
            const chs = chapters(bounds);
            const pts = [ { at: 97.4, black: [97.1, 97.7], silence: [96.9, 98], sources: ['blackSilence'] } ];
            const out = detect.correlateChapters(pts, chs, 1200);
            return (out.length === 1) && out[0].sources.includes('chapter');
        })());

    // ---- kind, in order credits > story > opening > act --------------------------------
    suite.check('the earliest point inside the opening window is "opening", not every early point',
        (() => {
            const pts = [ { at: 74, sources: [] }, { at: 150, sources: [] }, { at: 706, sources: [] } ];
            const out = detect.classifyKinds(pts, 1400, 'Happy Days');
            return (out[0].kind === 'opening') && (out[1].kind === 'act') && (out[2].kind === 'act');
        })());
    suite.check('a point within 90s of the end is credits',
        (() => {
            const out = detect.classifyKinds([ { at: 1340, sources: [] } ], 1400, 'Show');
            return out[0].kind === 'credits';
        })());
    suite.check('a two-story title ("A / B") gets a "story" kind at the point nearest the middle',
        (() => {
            const pts = [ { at: 60, sources: [] }, { at: 700, sources: [] }, { at: 1340, sources: [] } ];
            const out = detect.classifyKinds(pts, 1400, 'New Kid in Town / Pickles vs. Pickles');
            return (out[0].kind === 'opening') && (out[1].kind === 'story') && (out[2].kind === 'credits');
        })());
    suite.check('a one-story title never gets a "story" kind',
        detect.classifyKinds([ { at: 700, sources: [] } ], 1400, 'Sassy Come Home').every( (p) => p.kind !== 'story' ));

    // ---- strength -----------------------------------------------------------------------
    suite.check('a chapter-only point is weak',
        detect.scoreStrength( { black: null, silence: null, sources: ['chapter'] } ) < 0.3);
    suite.check('a longer black and silence score higher than a blink',
        detect.scoreStrength( { black: [0, 3], silence: [0, 4], sources: ['blackSilence'] } )
            > detect.scoreStrength( { black: [0, 0.3], silence: [0, 0.4], sources: ['blackSilence'] } ));
    suite.check('a chapter agreeing raises the score over the same point without one',
        detect.scoreStrength( { black: [0, 2], silence: [0, 2], sources: ['blackSilence', 'chapter'] } )
            > detect.scoreStrength( { black: [0, 2], silence: [0, 2], sources: ['blackSilence'] } ));
    suite.check('strength never leaves 0..1',
        (detect.scoreStrength( { black: [0, 999], silence: [0, 999], sources: ['blackSilence', 'chapter'] } ) <= 1)
            && (detect.scoreStrength( { black: [0, 0], silence: [0, 0], sources: [] } ) >= 0));

    // ---- end to end, a believable half-hour episode -------------------------------------
    (() => {
        const duration = 1400; // ~23:20
        const silence = [[74, 75.2], [705.6, 707.1], [1339, 1340.4]];
        const black = [[74.2, 75.0], [705.8, 706.9], [1339.2, 1340.2]];
        const chaptersIn = [ { s: 0, e: 74.6, t: 'Chapter 01' }, { s: 74.6, e: 706.3, t: 'Chapter 02' }, { s: 706.3, e: duration, t: 'Chapter 03' } ];
        const points = detect.detectBreaks( { duration, title: 'Pilot', silence, black, chapters: chaptersIn } );
        suite.check('finds all three points, in order, every one found and un-approved',
            (points.length === 3) && points.every( (p) => (p.status === 'found') && (p.approvedBy === null) ));
        suite.check('...the first is the opening, agreeing with a chapter',
            (points[0].kind === 'opening') && points[0].sources.includes('chapter'));
        suite.check('...the middle is an act, agreeing with a chapter too',
            (points[1].kind === 'act') && points[1].sources.includes('chapter'));
        suite.check('...and the last, inside 90s of the end, is credits',
            points[2].kind === 'credits');
        suite.check('every point keeps a null keyframe for now (step 6\'s job)',
            points.every( (p) => p.keyframe === null));
    })();

    return suite;
};
