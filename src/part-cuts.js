/*
 * Where a part of a program with midrolls starts and stops when its video is copied, not
 * encoded (docs/blocks-spec.md, Stage 6, "A break point": "A file sent out without re-encoding
 * can only start on a keyframe; there, part two starts at `keyframe` when the black has one,
 * else at the keyframe before `at`").
 *
 * An encoded item - every item on an install whose encoder is H.264, DarkManX16's among them -
 * starts at the exact frame `-ss` names, and nothing here runs. A copied one would start at
 * the keyframe before it and play the seconds between again, so the cut moves to the keyframe
 * itself, found when the part is played: the first keyframe inside the point's black, else
 * the last one at or before the point. The part before the midroll stops there and the part
 * after it starts there - both ask the same file the same question - so nothing is repeated
 * or lost; the midroll's commercials, measured from the clock, absorb the seconds moved.
 * Found at play time, never stored (DarkManX16, Nov 19).
 *
 * Pure, but for keyframesAround, which runs one ffprobe of packet flags (no decoding) over a
 * window of seconds around the point.
 */
const { execFile } = require('child_process');
const cardMoment = require('./card-moment');

const BEFORE_S = 10;     // how far before the point (or its black) a keyframe is looked for
const AFTER_S = 1;       // and after the black
const PROBE_TIMEOUT_MS = 5000;

/*
 * The cut for `point` ({ at, black: [start, end] | null }, seconds) among `keyframes`
 * (seconds, sorted): the first inside the black, else the last at or before `at`; null with
 * none to be had.
 */
function keyframeAt(keyframes, point) {
    if ( (point == null) || ! Array.isArray(keyframes) || (keyframes.length === 0) ) {
        return null;
    }
    const black = Array.isArray(point.black) && (point.black.length === 2) ? point.black : null;
    if (black !== null) {
        const inside = keyframes.find( (k) => (k >= black[0]) && (k <= black[1]) );
        if (inside !== undefined) {
            return inside;
        }
    }
    let before = null;
    for (const k of keyframes) {
        if (k <= point.at + 1e-6) {
            before = k;
        }
    }
    return before;
}

// The window keyframes are read over for a point: from 10 s before it (or its black) to 1 s after.
function windowOf(point) {
    const black = Array.isArray(point.black) && (point.black.length === 2) ? point.black : [ point.at, point.at ];
    return { fromS: Math.max(0, Math.min(point.at, black[0]) - BEFORE_S), toS: Math.max(point.at, black[1]) + AFTER_S };
}

/*
 * A copied part's start and length in seconds, moved to the keyframes: `startS` and
 * `durationS` as they would play (durationS undefined: to the end of the file), `cuts` the
 * item's { cutIn, cutOut } (points, or null), `keyframesFor(point)` the keyframes around one.
 * The start moves only when the part starts at its point (a tune-in partway is left alone);
 * the end moves whenever there is a point after it. null when nothing moves.
 */
async function moveCuts( { startS, durationS, cuts }, keyframesFor) {
    if (cuts == null) {
        return null;
    }
    let start = startS;
    let moved = false;
    if ( (cuts.cutIn != null) && (Math.abs(startS - cuts.cutIn.at) < 0.001) ) {
        const k = keyframeAt(await keyframesFor(cuts.cutIn), cuts.cutIn);
        if ( (k !== null) && (k !== startS) ) {
            start = k;
            moved = true;
        }
    }
    let duration = durationS;
    if ( (cuts.cutOut != null) && (typeof(durationS) === 'number') ) {
        const k = keyframeAt(await keyframesFor(cuts.cutOut), cuts.cutOut);
        const end = (k !== null) ? k : startS + durationS;
        if ( (end - start > 0) && (Math.abs( (end - start) - durationS ) > 1e-6) ) {
            duration = end - start;
            moved = true;
        }
    } else if (moved && (typeof(durationS) === 'number') ) {
        // the start moved and the end stays where it was
        duration = durationS + (startS - start);
    }
    return moved ? { startS: start, durationS: duration } : null;
}

// One ffprobe of the video's packet flags over the point's window: keyframe times, sorted ([] on failure).
function keyframesAround(ffprobePath, input, point) {
    const { fromS, toS } = windowOf(point);
    const args = [ '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${fromS.toFixed(3)}%${toS.toFixed(3)}`,
        '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input ];
    return new Promise( (resolve) => {
        execFile(ffprobePath, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            resolve( (err != null) ? [] : cardMoment.parseKeyframes(stdout).filter( (k) => (k >= fromS) && (k <= toS) ) );
        } );
    } );
}

module.exports = { keyframeAt, windowOf, moveCuts, keyframesAround };
