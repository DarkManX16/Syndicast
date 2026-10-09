/*
 * Which stretch of a movie its Next Time card shows (docs/blocks-spec.md,
 * Stage 5, "Generated cards"): a lively one, the way a real promo would pick it.
 *
 * Two cheap measurements, taken once per movie and kept:
 *   keyframes   from ffprobe's packet flags, read without decoding the video.
 *               An encoder starts a keyframe at a cut, so where they crowd
 *               together the picture is busy, and a stretch that starts on one
 *               starts cleanly and seeks exactly.
 *   loudness    ebur128's momentary loudness of the audio alone, every 0.1s.
 * A movie of an hour and a half measures in about 11 seconds.
 *
 * Every stretch that starts on a keyframe is scored, outside the opening (the
 * first tenth, at least 4 minutes: titles and credits) and the last stretch (the
 * last fifth, at least 10 minutes: the ending, the climax and the credits).
 * A stretch more than 15% quiet is passed over; of the rest, louder and busier
 * is better. Pure: the card service runs the commands and passes the output in.
 */

const QUIET_LUFS = -35;
const FLOOR_LUFS = -70;
const MAX_QUIET_SHARE = 0.15;
const CUT_WEIGHT = 1.5;
const MAX_CUTS = 6;
const QUIET_WEIGHT = 40;
const CANDIDATES = 5;

function parseKeyframes(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const [time, flags] = line.split(',');
        if ( (flags != null) && (flags.charAt(0) === 'K') ) {
            const t = parseFloat(time);
            if (isFinite(t)) {
                out.push(t);
            }
        }
    }
    return out.sort( (a, b) => a - b );
}

function parseLoudness(text) {
    const out = [];
    let time = null;
    for (const line of String(text || '').split(/\r?\n/)) {
        const at = /pts_time:([-\d.]+)/.exec(line);
        if (at !== null) {
            time = parseFloat(at[1]);
            continue;
        }
        const m = /lavfi\.r128\.M=(\S+)/.exec(line);
        if ( (m !== null) && (time !== null) ) {
            const value = parseFloat(m[1]);
            out.push( [time, isFinite(value) ? Math.max(FLOOR_LUFS, value) : FLOOR_LUFS] );
            time = null;
        }
    }
    return out;
}

// First index whose value (by `key`) is >= x.
function lowerBound(list, x, key) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (key(list[mid]) < x) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/*
 * The stretch of `lengthS` seconds to use: { startS, candidates } with up to
 * five candidates, best first. A movie too short for the rule, or with no
 * measurements, gets the stretch around its middle.
 */
function pickMoment({ durationS, keyframes, loudness }, lengthS) {
    const D = durationS;
    const L = lengthS;
    const keys = Array.isArray(keyframes) ? keyframes : [];
    const levels = Array.isArray(loudness) ? loudness : [];
    const middle = () => {
        const want = Math.max(0, D / 2 - L / 2);
        if (keys.length === 0) {
            return { startS: want, candidates: [] };
        }
        let best = keys[0];
        for (const k of keys) {
            if ( (Math.abs(k - want) < Math.abs(best - want)) && (k + L <= D) ) {
                best = k;
            }
        }
        return { startS: best, candidates: [] };
    };

    const from = Math.max(0.10 * D, 240);
    const to = D - Math.max(0.20 * D, 600) - L;
    if ( (to < from) || (levels.length === 0) ) {
        return middle();
    }

    // running sums of loudness and of quiet samples, so each stretch is O(log n)
    const sum = [0];
    const quiet = [0];
    for (let i = 0; i < levels.length; i++) {
        sum.push(sum[i] + levels[i][1]);
        quiet.push(quiet[i] + (levels[i][1] < QUIET_LUFS ? 1 : 0));
    }
    const scored = [];
    for (const s of keys) {
        if ( (s < from) || (s > to) ) {
            continue;
        }
        const a = lowerBound(levels, s, (x) => x[0]);
        const b = lowerBound(levels, s + L, (x) => x[0]);
        const n = b - a;
        if (n === 0) {
            continue;
        }
        const mean = (sum[b] - sum[a]) / n;
        const quietShare = (quiet[b] - quiet[a]) / n;
        const cuts = lowerBound(keys, s + L, (x) => x) - lowerBound(keys, s, (x) => x) - 1;
        scored.push( {
            startS: s,
            quietShare: quietShare,
            score: mean + CUT_WEIGHT * Math.min(cuts, MAX_CUTS) - QUIET_WEIGHT * quietShare,
        } );
    }
    if (scored.length === 0) {
        return middle();
    }
    const lively = scored.filter( (c) => c.quietShare <= MAX_QUIET_SHARE );
    const pool = (lively.length > 0) ? lively : scored;
    pool.sort( (x, y) => (y.score - x.score) || (x.startS - y.startS) );
    const candidates = pool.slice(0, CANDIDATES).map( (c) => ({ startS: c.startS, score: Math.round(c.score * 10) / 10 }) );
    return { startS: candidates[0].startS, candidates: candidates };
}

// The two commands that measure a movie (arguments for ffprobe and ffmpeg).
function analysisCommands(source) {
    return {
        keyframes: ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags',
            '-of', 'csv=p=0', source],
        loudness: ['-hide_banner', '-nostats', '-vn', '-i', source,
            '-af', 'ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=-', '-f', 'null', '-'],
    };
}

module.exports = {
    parseKeyframes,
    parseLoudness,
    pickMoment,
    analysisCommands,
};
