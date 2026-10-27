/*
 * Finding break points inside a file (docs/blocks-spec.md, Stage 6,
 * "Detection" and "A break point"): black frames that touch a silence, with
 * embedded chapters as a second opinion. Pure: break-scan.js runs ffmpeg and
 * hands this module the parsed silence and black intervals; this module does
 * no I/O.
 *
 * Two changes over the Oct 15 investigation's prototype, both aimed at the
 * slow HD HEVC files: only a silence of MIN_SILENCE_S or more opens a black
 * window at all, and a silence longer than LONG_SILENCE_S is checked at its
 * two ends only, never across its middle (Samurai Jack's long quiet
 * stretches otherwise decode minutes of picture for nothing).
 */

const MIN_SILENCE_S = 0.4;
const MERGE_GAP_S = 1.0;
const LONG_SILENCE_S = 6.0;
const WINDOW_PAD_S = 1.0;
const TOUCH_S = 0.3;
const OPENING_WINDOW_S = 180;
const CREDITS_WINDOW_S = 90;
const CHAPTER_NEAR_S = 3;
const SCENE_LIST_CHAPTERS = 8;
const RIPPER_MINUTE_TOL_S = 2;
const RIPPER_SPACING_TOL_S = 5;
const CHAPTER_ONLY_STRENGTH = 0.15;

// -- reading ffmpeg's own text --------------------------------------------------

function parseSilence(text, fallbackEnd) {
    const out = [];
    let start = null;
    for (const m of String(text || '').matchAll(/silence_(start|end): ([\d.-]+)/g)) {
        if (m[1] === 'start') {
            start = Math.max(0, parseFloat(m[2]));
        } else if (start !== null) {
            out.push([start, parseFloat(m[2])]);
            start = null;
        }
    }
    if ((start !== null) && (fallbackEnd != null)) {
        out.push([start, fallbackEnd]);
    }
    return out;
}

function parseBlack(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
        out.push([parseFloat(m[1]), parseFloat(m[2])]);
    }
    return out;
}

// -- silence grouping and the windows worth a black scan -----------------------

function significantSilences(silences, minS = MIN_SILENCE_S) {
    return (silences || []).filter( ([s, e]) => (e - s) >= minS );
}

function mergeSilences(intervals, gapS = MERGE_GAP_S) {
    const sorted = [...(intervals || [])].sort( (a, b) => a[0] - b[0] );
    const groups = [];
    for (const [s, e] of sorted) {
        const last = groups[groups.length - 1];
        if (last && ((s - last[1]) < gapS)) {
            last[1] = Math.max(last[1], e);
        } else {
            groups.push([s, e]);
        }
    }
    return groups;
}

// A short group is scanned whole; a long one only at its two ends.
function windowsForSilences(groups, { pad = WINDOW_PAD_S, longS = LONG_SILENCE_S, duration = Infinity } = {}) {
    const windows = [];
    for (const [gs, ge] of groups) {
        if ((ge - gs) <= longS) {
            windows.push([Math.max(0, gs - pad), Math.min(duration, ge + pad)]);
        } else {
            windows.push([Math.max(0, gs - pad), Math.min(duration, gs + pad)]);
            windows.push([Math.max(0, ge - pad), Math.min(duration, ge + pad)]);
        }
    }
    return windows;
}

// What a black interval must touch (within TOUCH_S) to count for this group:
// the whole span for a short silence, or just one end for a long one.
function touchTargets(group, longS = LONG_SILENCE_S) {
    const [gs, ge] = group;
    if ((ge - gs) <= longS) {
        return [ { from: gs, to: ge, silence: group } ];
    }
    return [
        { from: gs, to: gs, silence: group },
        { from: ge, to: ge, silence: group },
    ];
}

function pointsFromBlack(groups, black) {
    const sorted = [...(black || [])].sort( (a, b) => a[0] - b[0] );
    const points = [];
    for (const group of groups) {
        for (const target of touchTargets(group)) {
            const hits = sorted.filter( (b) => (b[1] >= target.from - TOUCH_S) && (b[0] <= target.to + TOUCH_S) );
            if (!hits.length) {
                continue;
            }
            const blackSpan = [
                Math.min(...hits.map( (h) => h[0] )),
                Math.max(...hits.map( (h) => h[1] )),
            ];
            points.push( {
                at: (blackSpan[0] + blackSpan[1]) / 2,
                black: blackSpan,
                silence: target.silence,
                sources: ['blackSilence'],
            } );
        }
    }
    return points;
}

// -- chapters, as a second opinion ----------------------------------------------

function chapterBoundaries(chapters) {
    const sorted = [...(chapters || [])].sort( (a, b) => a.s - b.s );
    const bounds = [];
    for (let i = 0; i < sorted.length - 1; i++) {
        bounds.push( (sorted[i].e + sorted[i + 1].s) / 2 );
    }
    return bounds;
}

// A ripper's chapters: on the whole minute and evenly spaced, so they say
// nothing about where the broadcast breaks were.
function isRipperChapters(boundaries) {
    if (!boundaries.length) {
        return false;
    }
    const onMinute = boundaries.every( (b) => Math.abs(b - Math.round(b / 60) * 60) <= RIPPER_MINUTE_TOL_S );
    if (!onMinute) {
        return false;
    }
    if (boundaries.length < 2) {
        return true;
    }
    const gaps = boundaries.slice(1).map( (b, i) => b - boundaries[i] );
    const first = gaps[0];
    return gaps.every( (g) => Math.abs(g - first) <= RIPPER_SPACING_TOL_S );
}

// Adds a `chapter` source (and strength) to a point a chapter boundary agrees
// with; a leftover boundary becomes its own weak point, unless the chapters
// are a ripper's (ignored outright) or a scene list (kept only where it
// already agrees with black and silence).
function correlateChapters(points, chapters, duration) {
    const boundaries = chapterBoundaries(chapters);
    if (!boundaries.length || isRipperChapters(boundaries)) {
        return points;
    }
    const isSceneList = (chapters || []).length > SCENE_LIST_CHAPTERS;
    const used = new Set();
    const out = points.map( (p) => {
        const near = boundaries.find( (b) => Math.abs(b - p.at) <= CHAPTER_NEAR_S );
        if (near == null) {
            return p;
        }
        used.add(near);
        return { ...p, sources: [...p.sources, 'chapter'] };
    } );
    if (!isSceneList) {
        for (const b of boundaries) {
            if (used.has(b)) {
                continue;
            }
            out.push( { at: b, black: null, silence: null, sources: ['chapter'] } );
        }
    }
    return out;
}

// -- kind and strength -----------------------------------------------------------

// credits > story > opening > act: a point can only be one, and a point near
// the end is credits even if the file is also titled as two stories.
function classifyKinds(points, duration, title) {
    const isTwoStory = /\s\/\s/.test(String(title || ''));
    let openingIdx = -1;
    let openingAt = Infinity;
    points.forEach( (p, i) => {
        if ((p.at <= OPENING_WINDOW_S) && (p.at < openingAt)) {
            openingAt = p.at;
            openingIdx = i;
        }
    } );
    let storyIdx = -1;
    let storyDist = Infinity;
    if (isTwoStory) {
        const mid = duration / 2;
        points.forEach( (p, i) => {
            const d = Math.abs(p.at - mid);
            if (d < storyDist) {
                storyDist = d;
                storyIdx = i;
            }
        } );
    }
    return points.map( (p, i) => {
        if ((duration - p.at) <= CREDITS_WINDOW_S) {
            return { ...p, kind: 'credits' };
        }
        if (i === storyIdx) {
            return { ...p, kind: 'story' };
        }
        if (i === openingIdx) {
            return { ...p, kind: 'opening' };
        }
        return { ...p, kind: 'act' };
    } );
}

function scoreStrength(point) {
    if (point.black == null) {
        return CHAPTER_ONLY_STRENGTH;
    }
    const blackLen = point.black[1] - point.black[0];
    const silLen = point.silence ? (point.silence[1] - point.silence[0]) : 0;
    let s = (Math.min(1, blackLen / 1.5) * 0.55) + (Math.min(1, silLen / 2) * 0.3);
    if (point.sources.includes('chapter')) {
        s += 0.15;
    }
    return Math.max(0, Math.min(1, s));
}

// -- putting it together ----------------------------------------------------------

/*
 * duration, title: the file's.
 * silence, black: every interval ffmpeg reported, in absolute file seconds
 *   (break-scan.js offsets each window's output before calling this).
 * chapters: [{ s, e, t }, ...] as read from the file (or Plex's copy of them).
 */
function detectBreaks({ duration, title, silence = [], black = [], chapters = [] } = {}) {
    const groups = mergeSilences(significantSilences(silence));
    let points = pointsFromBlack(groups, black);
    points = correlateChapters(points, chapters, duration);
    points.sort( (a, b) => a.at - b.at );
    points = classifyKinds(points, duration, title);
    return points.map( (p) => ( {
        at: p.at,
        black: p.black,
        silence: p.silence,
        kind: p.kind,
        sources: p.sources,
        strength: scoreStrength(p),
        keyframe: null,
        status: 'found',
        approvedBy: null,
    } ) );
}

module.exports = {
    parseSilence, parseBlack,
    significantSilences, mergeSilences, windowsForSilences, touchTargets, pointsFromBlack,
    chapterBoundaries, isRipperChapters, correlateChapters,
    classifyKinds, scoreStrength,
    detectBreaks,
    constants: {
        MIN_SILENCE_S, MERGE_GAP_S, LONG_SILENCE_S, WINDOW_PAD_S, TOUCH_S,
        OPENING_WINDOW_S, CREDITS_WINDOW_S, CHAPTER_NEAR_S, SCENE_LIST_CHAPTERS,
        RIPPER_MINUTE_TOL_S, RIPPER_SPACING_TOL_S, CHAPTER_ONLY_STRENGTH,
    },
};
