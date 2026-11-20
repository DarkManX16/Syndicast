/*
 * The midroll layout (docs/blocks-spec.md, Stage 6, "Keeping the schedule on time"; build
 * order 5f), pure: where each part of a program, each midroll and the end break sit.
 *
 * Midrolls borrow only from the Flex run after the program, so the next row starts exactly
 * when the lineup says; `channel.programs` is never touched. The budget is that Flex less
 * the end break's own steps, each counted at the longest clip it could play (DarkManX16,
 * Nov 19), so the times are fixed before any clip is picked and playback, the guide and the
 * editor all agree. The midrolls and the end break get equal shares in whole seconds; a
 * share under `minMs`, or an end break left with less than `minMs` of commercials, means one
 * fewer midroll, down to none. No midroll runs over 4 minutes (or `minMs`, if longer): the
 * rest stays in the end break (DarkManX16, Nov 19).
 *
 * Points are what break-airable.js allows, of the kinds the context's setting allows, at
 * least 2 minutes from either end and 3 from each other; with more than fit, the set nearest
 * even spacing, then the stronger. A file whose scanned length is more than 2 s off the
 * program's (changed, not scanned again) has none.
 *
 * `env` is the outside world, so this stays pure:
 *   env.on                 the Midrolls switch; off, there is no layout at all
 *   env.pointsFor(program) { durationMs, points: [{ index, at (s), kind, by, strength, black }] }
 *                          for the program's file, or null (never scanned)
 *   env.getList(id)        a filler list's clips, or null (for the steps' longest clips)
 *   env.cardMs(templateId) a card template's length in ms, or null
 *   env.frozen             optional { get(number, index, start), set(number, index, start,
 *                          held, now) }: layoutAt's layouts kept for the program on air
 *   env.card, env.lastPlayed, env.featuresShows
 *                          as transitions.buildPlan reads them, for buildMidrollPlan
 */
const transitions = require('./transitions');
const dayParts = require('./day-parts');
const lineupCursor = require('./lineup-cursor');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const MAX_MIDROLL_MS = 4 * MINUTE;
const EDGE_MS = 2 * MINUTE;
const APART_MS = 3 * MINUTE;
const LENGTH_SLACK_MS = 2 * SECOND;

function isOnDemand(channel) {
    return (channel.onDemand != null) && (channel.onDemand.isOnDemand === true);
}

function isRedirect(program) {
    return (program.isOffline === true) && (program.type === 'redirect');
}

// A program the scanner reads: a real episode or movie with a file.
function hasFile(program) {
    return (program != null) && (program.isOffline !== true)
        && ( (program.type === 'episode') || (program.type === 'movie') )
        && (typeof(program.file) === 'string') && (program.file !== '');
}

function kindsAllowed(setting) {
    const kinds = new Set( [ 'act' ] );
    if (setting.story === true) {
        kinds.add('story');
    }
    if (setting.opening === true) {
        kinds.add('opening');
    }
    return kinds;
}

// The points a midroll may use, in time order: { index, atMs, kind, by, strength }.
function usablePoints(points, durationMs, setting) {
    const kinds = kindsAllowed(setting);
    const seen = new Set();
    return (Array.isArray(points) ? points : [])
        .filter( (p) => (p != null) && (typeof(p.at) === 'number') && Number.isFinite(p.at) && kinds.has(p.kind) )
        .map( (p) => ({ index: p.index, atMs: Math.round(p.at * SECOND), kind: p.kind, by: p.by, strength: (typeof(p.strength) === 'number') ? p.strength : 0,
            black: (Array.isArray(p.black) && (p.black.length === 2)) ? p.black : null }) )
        .filter( (p) => (p.atMs >= EDGE_MS) && (p.atMs <= durationMs - EDGE_MS) )
        .sort( (a, b) => (a.atMs - b.atMs) || ( (a.index || 0) - (b.index || 0) ) )
        .filter( (p) => {
            if (seen.has(p.atMs)) {
                return false;
            }
            seen.add(p.atMs);
            return true;
        } );
}

// The most of them that can stand 3 minutes apart (earliest first is as many as any).
function mostApart(points) {
    let count = 0;
    let last = -Infinity;
    for (const p of points) {
        if (p.atMs - last >= APART_MS) {
            count++;
            last = p.atMs;
        }
    }
    return count;
}

/*
 * n of the points, 3 minutes apart, nearest even spacing (the least total distance from
 * the program's n+1 equal parts), then the stronger, then the earlier. null if n cannot
 * stand apart. One pass per midroll over the pairs of points, so a movie with many points
 * costs no more than a few thousand comparisons.
 */
function pickPoints(points, n, durationMs) {
    if (n <= 0) {
        return [];
    }
    const ideal = (k) => Math.round( (durationMs * (k + 1)) / (n + 1) );
    const better = (a, b) => (b === null) || (a.off < b.off) || ( (a.off === b.off) && (a.strength > b.strength + 1e-9) );
    let best = points.map( (p, i) => ({ off: Math.abs(p.atMs - ideal(0)), strength: p.strength, path: [ i ] }) );
    for (let k = 1; k < n; k++) {
        const next = points.map( () => null );
        for (let i = 0; i < points.length; i++) {
            for (let j = 0; j < i; j++) {
                if ( (best[j] === null) || (points[i].atMs - points[j].atMs < APART_MS) ) {
                    continue;
                }
                const c = { off: best[j].off + Math.abs(points[i].atMs - ideal(k)), strength: best[j].strength + points[i].strength, path: best[j].path.concat( [ i ] ) };
                if (better(c, next[i])) {
                    next[i] = c;
                }
            }
        }
        best = next;
    }
    let chosen = null;
    for (const c of best) {
        if ( (c !== null) && better(c, chosen) ) {
            chosen = c;
        }
    }
    return (chosen === null) ? null : chosen.path.map( (i) => points[i] );
}

// ---- what steps can take ------------------------------------------------------------------------

const longest = new WeakMap();

function longestClipMs(env, listId) {
    if ( (typeof(listId) !== 'string') || (listId === '') ) {
        return 0;
    }
    let memo = longest.get(env);
    if (memo === undefined) {
        memo = new Map();
        longest.set(env, memo);
    }
    if (! memo.has(listId)) {
        const clips = (typeof(env.getList) === 'function') ? env.getList(listId) : null;
        let max = 0;
        for (const clip of (Array.isArray(clips) ? clips : [])) {
            if ( (clip != null) && (clip.duration > max) ) {
                max = clip.duration;
            }
        }
        memo.set(listId, max);
    }
    return memo.get(listId);
}

function stepMs(step, env) {
    if (step.kind === 'list') {
        return Math.max(longestClipMs(env, step.listId), longestClipMs(env, step.fallbackListId));
    }
    if (step.kind === 'generated') {
        const ms = (typeof(env.cardMs) === 'function') ? env.cardMs(step.templateId) : null;
        return ( (typeof(ms) === 'number') && (ms > 0) ) ? ms : 0;
    }
    return 0;
}

/*
 * The most a set of steps can play, whole seconds up: `entries` are { context, situation,
 * side, step }, as transitions.assemble gives them. Each step counts at the longest clip of
 * its list and fallback list (or its card template's length), whatever its days, times or
 * chance say. A step that plays only if another found nothing counts once with it, as the
 * longer of the two (with every step watching the same one, together); cascade steps on one
 * side count as the longest of them, since at most one plays; a step that can never be
 * honoured counts nothing.
 */
function stepsMs(entries, env) {
    const groups = [];
    for (const e of entries) {
        let g = groups.find( (x) => (x.context === e.context) && (x.situation === e.situation) );
        if (g === undefined) {
            g = { context: e.context, situation: e.situation, entries: [] };
            groups.push(g);
        }
        g.entries.push(e);
    }
    let total = 0;
    for (const g of groups) {
        const sequence = g.entries.map( (e) => e.step );
        const cascade = { out: 0, in: 0 };
        const watching = new Map();
        const plain = [];
        for (const e of g.entries) {
            const watch = transitions.watchOf(e.step);
            const ms = stepMs(e.step, env);
            if (watch.cascade) {
                cascade[e.side] = Math.max(cascade[e.side] || 0, ms);
            } else if (watch.marked) {
                if (transitions.watchProblem(e.step, sequence) === null) {
                    watching.set(watch.id, (watching.get(watch.id) || 0) + ms);
                }
            } else {
                plain.push( { id: e.step.id, ms } );
            }
        }
        for (const p of plain) {
            total += Math.max(p.ms, ( (p.id != null) && watching.has(p.id) ) ? watching.get(p.id) : 0);
        }
        total += (cascade.out || 0) + (cascade.in || 0);
    }
    return Math.ceil(total / SECOND) * SECOND;
}

function sideEntries(assembled) {
    return assembled.out.map( (e) => Object.assign( { side: 'out' }, e ) )
        .concat( assembled.in.map( (e) => Object.assign( { side: 'in' }, e ) ) );
}

function midrollEntries(context) {
    const steps = transitions.normalizeTransitions(context).midroll;
    return steps.out.map( (step) => ({ context, situation: 'midroll', side: 'out', step }) )
        .concat( steps.in.map( (step) => ({ context, situation: 'midroll', side: 'in', step }) ) );
}

// ---- the layout ---------------------------------------------------------------------------------

/*
 * The layout of one airing from its numbers: { start, durationMs, flexMs, end, parts:
 * [{ fromMs, toMs, start }], midrolls: [{ k, atMs, index, kind, by, strength, start,
 * lengthMs }], endBreak: { start, lengthMs }, why } - `why` saying, when there are none,
 * why not. `none` forces none, with that reason.
 */
function layoutFor( { start, durationMs, flexMs, points, setting, endReserveMs = 0, midrollReserveMs = 0, none = null } ) {
    const end = start + durationMs + flexMs;
    const base = { start, durationMs, flexMs, end, endReserveMs, midrollReserveMs };
    const plain = (why) => Object.assign(base, {
        parts: [ { fromMs: 0, toMs: durationMs, start } ], midrolls: [], endBreak: { start: start + durationMs, lengthMs: flexMs }, why,
    } );
    if (none !== null) {
        return plain(none);
    }
    if (setting.count === 0) {
        return plain('the setting says none here');
    }
    if (points.length === 0) {
        return plain('no point may air');
    }
    if (flexMs <= 0) {
        return plain('no Flex after it');
    }
    const budget = flexMs - endReserveMs;
    const cap = Math.max(MAX_MIDROLL_MS, setting.minMs);
    for (let n = Math.min( (setting.count === null) ? Infinity : setting.count, mostApart(points) ); n >= 1; n--) {
        const share = Math.round(budget / (n + 1) / SECOND) * SECOND;
        const len = Math.min(share, cap);
        if ( (share < setting.minMs) || (len < midrollReserveMs) || (budget - (n * len) < setting.minMs) ) {
            continue;
        }
        const chosen = pickPoints(points, n, durationMs);
        if (chosen === null) {
            continue;
        }
        const parts = [];
        const midrolls = [];
        let at = start;
        let from = 0;
        chosen.forEach( (p, k) => {
            parts.push( { fromMs: from, toMs: p.atMs, start: at } );
            at += p.atMs - from;
            midrolls.push( { k, atMs: p.atMs, index: p.index, kind: p.kind, by: p.by, strength: p.strength, black: p.black, start: at, lengthMs: len } );
            at += len;
            from = p.atMs;
        } );
        parts.push( { fromMs: from, toMs: durationMs, start: at } );
        at += durationMs - from;
        return Object.assign(base, { parts, midrolls, endBreak: { start: at, lengthMs: end - at }, why: null } );
    }
    return plain('too little Flex after it');
}

// Where the next real row starts: after the program and the Flex run behind it.
function runOf(channel, index, start) {
    const programs = channel.programs;
    const n = programs.length;
    const next = (index + 1) % n;
    const ends = start + programs[index].duration;
    if ( (n > 1) && (programs[next].isOffline === true) ) {
        return transitions.findBreak(channel, next, ends);
    }
    return null;
}

/*
 * The layout of the program at `index`, airing from `start` (ms), or null: the switch off,
 * an on-demand channel, or an entry that is not a program with a file. A program that gets
 * no midrolls still has a layout, its whole Flex its end break, and `why` says why.
 */
function midrollLayout(channel, index, start, env) {
    if ( (channel == null) || (env == null) || (env.on !== true) || isOnDemand(channel) || ! Array.isArray(channel.programs) ) {
        return null;
    }
    const programs = channel.programs;
    const program = programs[index];
    if (! hasFile(program)) {
        return null;
    }
    const brk = runOf(channel, index, start);
    let flexMs = 0;
    let none = null;
    if (brk !== null) {
        flexMs = brk.endTime - brk.startTime;
        for (let i = brk.firstFlex, k = 0; k < brk.flexCount; i = (i + 1) % programs.length, k++) {
            if (isRedirect(programs[i])) {
                none = 'a redirect follows it';
            }
        }
    }
    const context = dayParts.resolveContext(channel, start);
    const setting = transitions.normalizeMidrolls(context);
    const found = (typeof(env.pointsFor) === 'function') ? env.pointsFor(program) : null;
    if ( (none === null) && (found == null) ) {
        none = 'not scanned';
    } else if ( (none === null) && ! ( (typeof(found.durationMs) === 'number') && (Math.abs(found.durationMs - program.duration) <= LENGTH_SLACK_MS) ) ) {
        none = 'the file is not the length it was scanned at';
    }
    const points = (none === null) ? usablePoints(found.points, program.duration, setting) : [];
    const worth = (none === null) && (points.length > 0) && (flexMs > 0) && (setting.count !== 0);
    const layout = layoutFor( {
        start, durationMs: program.duration, flexMs, points, setting, none,
        endReserveMs: worth ? stepsMs(sideEntries(transitions.assemble(channel, brk)), env) : 0,
        midrollReserveMs: worth ? stepsMs(midrollEntries(context), env) : 0,
    } );
    return Object.assign( { channel: channel.number, index, fingerprint: lineupCursor.fingerprint(program), setting }, layout );
}

/*
 * midrollLayout, except that the program on air keeps the layout it was first asked for
 * while on (env.frozen), until its end break ends: a change made during it (an approval, a
 * scan, the switch, a save) reaches the next airing instead. A held layout is used only
 * while the program and where the next row starts are what they were, so it never moves
 * a start; a restart forgets it, and the rest of the airing then follows the new layout.
 */
function layoutAt(channel, index, start, env, now) {
    const program = ( (channel != null) && Array.isArray(channel.programs) ) ? channel.programs[index] : null;
    if ( (program == null) || (program.isOffline === true) ) {
        return null;
    }
    const frozen = (env != null) ? env.frozen : null;
    const fingerprint = lineupCursor.fingerprint(program);
    const run = runOf(channel, index, start);
    const end = (run !== null) ? run.endTime : start + program.duration;
    if (frozen != null) {
        const held = frozen.get(channel.number, index, start);
        if ( (held != null) && (held.fingerprint === fingerprint) && (held.end === end) ) {
            return held.layout;
        }
    }
    const layout = midrollLayout(channel, index, start, env);
    if ( (frozen != null) && (typeof(now) === 'number') && (now >= start) && (now < end) ) {
        frozen.set(channel.number, index, start, { layout, fingerprint, end }, now);
    }
    return layout;
}

/*
 * Every airing of a program on in [from, to) - the one on at `from` included - with its
 * layout: [{ index, start, layout }]. [] with the switch off. With env.frozen and `now`,
 * through layoutAt.
 */
function midrollsBetween(channel, from, to, env, now) {
    if ( (env == null) || (env.on !== true) || (channel == null) || isOnDemand(channel) || ! Array.isArray(channel.programs) ) {
        return [];
    }
    const programs = channel.programs;
    const n = programs.length;
    let total = 0;
    for (const p of programs) {
        total += p.duration;
    }
    const lineupStart = new Date(channel.startTime).getTime();
    if ( (n === 0) || ! (total > 0) || ! Number.isFinite(lineupStart) ) {
        return [];
    }
    let offset = (from - lineupStart) % total;
    if (offset < 0) {
        offset += total;
    }
    let index = 0;
    let t = from - offset;
    while ( (index < n) && (t + programs[index].duration <= from) ) {
        t += programs[index].duration;
        index++;
    }
    const out = [];
    for (let guard = 0; (t < to) && (guard < n * 1000); guard++) {
        const program = programs[index];
        if (program.isOffline !== true) {
            const layout = (env.frozen != null) ? layoutAt(channel, index, t, env, now) : midrollLayout(channel, index, t, env);
            if (layout !== null) {
                out.push( { index, start: t, layout } );
            }
        }
        t += program.duration;
        index = (index + 1) % n;
    }
    return out;
}

/*
 * Where the clock is in a layout: { phase: 'part', k, fileMs } (part k, at fileMs into the
 * file), { phase: 'midroll', k, intoMs }, { phase: 'end', intoMs }, or null outside it. The
 * clock can be in a part while the lineup's clock is already in the Flex entry.
 */
function whereAt(layout, t) {
    if ( (layout == null) || (t < layout.start) || (t >= layout.end) ) {
        return null;
    }
    for (let k = 0; k < layout.parts.length; k++) {
        const part = layout.parts[k];
        if (t < part.start + (part.toMs - part.fromMs)) {
            return { phase: 'part', k, fileMs: part.fromMs + (t - part.start) };
        }
        const m = layout.midrolls[k];
        if ( (m != null) && (t < m.start + m.lengthMs) ) {
            return { phase: 'midroll', k, intoMs: t - m.start };
        }
    }
    return { phase: 'end', intoMs: t - layout.endBreak.start };
}

/*
 * Midroll k as a break for transitions.buildPlan: the show on air is both `prev` and
 * `next`, so steps keyed on now or next are about it; `after` is the end break, from whose
 * next program `later`, `afterNext` and `tomorrow` resolve.
 */
function midrollBreak(channel, layout, k) {
    const programs = channel.programs;
    const program = programs[layout.index];
    const m = layout.midrolls[k];
    const on = { index: layout.index, program, startTime: layout.start };
    return {
        midroll: k, startTime: m.start, endTime: m.start + m.lengthMs, firstFlex: null, lastFlex: null, flexCount: 0,
        prev: on, next: on, after: runOf(channel, layout.index, layout.start),
    };
}

// Which clip each step of midroll k plays: the stage 5 planner, keyed on the show on air.
function buildMidrollPlan(channel, layout, k, env) {
    return transitions.buildPlan(channel, midrollBreak(channel, layout, k), env);
}

module.exports = {
    MAX_MIDROLL_MS, EDGE_MS, APART_MS, LENGTH_SLACK_MS,
    kindsAllowed, usablePoints, pickPoints, stepsMs, layoutFor,
    midrollLayout, layoutAt, midrollsBetween, whereAt, midrollBreak, buildMidrollPlan,
};
