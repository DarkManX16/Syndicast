/*
 * Transitions: the steps that play around a break - out before the Flex, in
 * after it. See docs/blocks-spec.md, Stage 5. This is the first piece of it:
 * which situation a break is, and which steps its contexts hand it. Choosing a
 * clip for a step, and playing any of it, come in later steps; nothing here is
 * called by playback yet, so no stream, guide or channel behaves differently.
 *
 * Pure and free of I/O, the same way day-parts.js is: every function is a
 * function of a channel object and numbers, so it can be exercised without a
 * data folder or a server. It reads contexts through day-parts.js's
 * resolveContext, so a break's contexts are decided by the one function every
 * other consumer uses.
 *
 * A break is the run of adjacent Flex entries between a program P and a
 * program N. P's context is the one covering P's start, N's the one covering
 * N's start - boundaries never cut a show short, so a show that overruns keeps
 * the context it began in.
 *
 *   same context, same show       -> betweenEpisodes
 *   same context, different show  -> betweenShows
 *   different contexts            -> boundary: P's Leaving and N's Entering
 *
 * The lineup is a cycle (channel.programs repeats), so a Flex run at the head
 * of it has the last program of the cycle as its P, the same wrap
 * findNextProgram already does going forward. "No program on that side" only
 * arises when a channel has no real program in reach at all.
 */

const dayParts = require('./day-parts');

const SITUATIONS = ['leaving', 'entering', 'betweenEpisodes', 'betweenShows'];
const KINDS = ['list', 'generated'];
const MATCHES = ['any', 'show', 'pair'];
const KEYED_ON = ['now', 'next', 'later'];

const STEP_DEFAULTS = { kind: 'list', match: 'any', keyedOn: 'next', fallbackListId: null };

/*
 * The key the slot editor uses for "the same show" (get-show-data.js), with
 * one deliberate difference: a movie is keyed by its own title, where there it is a
 * single "movie." key for every movie, which would make a break between two
 * unrelated films read as a break between episodes. A custom show is one show
 * whatever its items are called, which is what makes a run of Looney Tunes
 * shorts one show and not thirty. Flex has no show.
 */
function showKey(program) {
    if ( (program == null) || (program.isOffline === true) ) {
        return null;
    }
    if (typeof(program.customShowId) !== 'undefined') {
        return 'custom.' + program.customShowId;
    }
    if (program.type === 'episode') {
        return 'tv.' + program.showTitle;
    }
    if (program.type === 'track') {
        return 'audio.' + program.showTitle;
    }
    if (program.type === 'movie') {
        return 'movie.' + program.title;
    }
    return 'item.' + program.title;
}

function emptyTransitions() {
    const all = {};
    for (const name of SITUATIONS) {
        all[name] = { out: [], in: [] };
    }
    return all;
}

/*
 * A context's transitions as the rest of the code should see them: all four
 * situations present, each side an array, each step carrying every field. It
 * builds new objects and arrays on every call and writes nothing back, so a
 * context without the field stays without it and reading can never change what
 * is saved. A side that is not an array reads as empty and an unknown
 * situation is left out; channel-db.js's warnAboutTransitions is what tells
 * the user, this just never lets a malformed one reach a caller.
 */
function normalizeTransitions(context) {
    const all = emptyTransitions();
    const stored = ( (context != null) && (context.transitions != null) && (typeof(context.transitions) === 'object') )
        ? context.transitions
        : null;
    if (stored === null) {
        return all;
    }
    for (const name of SITUATIONS) {
        const situation = stored[name];
        if ( (situation == null) || (typeof(situation) !== 'object') ) {
            continue;
        }
        for (const side of ['out', 'in']) {
            if (! Array.isArray(situation[side]) ) {
                continue;
            }
            for (const step of situation[side]) {
                if ( (step == null) || (typeof(step) !== 'object') ) {
                    continue;
                }
                all[name][side].push( Object.assign({}, STEP_DEFAULTS, step) );
            }
        }
    }
    return all;
}

/*
 * The break around the Flex entry at `index`, whose start is `entryStart` (ms
 * since the epoch). The break is the whole run of adjacent Flex entries, found
 * by walking back to its first and forward to its last, wrapping round the
 * cyclic lineup. Time is carried by arithmetic from `entryStart`, so a wrapped
 * neighbour's start is simply earlier or later by its duration - the lineup is
 * contiguous in time across the wrap.
 *
 * out steps attach to firstFlex and in steps to lastFlex: a sequence belongs
 * to the break, never to a Flex entry, so a break the generator left as two
 * Flex entries still gets one.
 *
 * prev and next are { index, program, startTime }, or null when the channel
 * has no real program at all.
 */
function findBreak(channel, index, entryStart) {
    const programs = channel.programs;
    const n = programs.length;
    if ( (index < 0) || (index >= n) || (programs[index].isOffline !== true) ) {
        throw new Error(`transitions.findBreak: entry ${index} is not a Flex entry`);
    }
    const isFlex = (i) => programs[i].isOffline === true;

    let first = index;
    let startTime = entryStart;
    let steps = 0;
    while ( isFlex( (first - 1 + n) % n ) && (steps < n) ) {
        first = (first - 1 + n) % n;
        startTime -= programs[first].duration;
        steps++;
    }
    if (steps >= n) {
        // every entry is Flex: there is nothing to be a neighbour
        let total = 0;
        for (const program of programs) {
            total += program.duration;
        }
        return { firstFlex: 0, lastFlex: n - 1, flexCount: n, startTime: entryStart, endTime: entryStart + total, prev: null, next: null };
    }

    let last = first;
    let endTime = startTime + programs[first].duration;
    while (isFlex( (last + 1) % n )) {
        last = (last + 1) % n;
        endTime += programs[last].duration;
    }
    const prevIndex = (first - 1 + n) % n;
    const nextIndex = (last + 1) % n;
    const flexCount = ( (last - first + n) % n ) + 1;
    return {
        firstFlex: first,
        lastFlex: last,
        flexCount: flexCount,
        startTime: startTime,
        endTime: endTime,
        prev: { index: prevIndex, program: programs[prevIndex], startTime: startTime - programs[prevIndex].duration },
        next: { index: nextIndex, program: programs[nextIndex], startTime: endTime },
    };
}

/*
 * Every break whose start falls in [from, to), in order, walking the cyclic
 * lineup from wherever `from` lands in it. A break counts when it starts inside
 * the window - the moment its program ends - so a window that opens halfway
 * through a break does not claim it, and consecutive windows never count one
 * break twice. Two programs with no Flex between them are not a break.
 */
function breaksBetween(channel, from, to) {
    const programs = channel.programs;
    const n = Array.isArray(programs) ? programs.length : 0;
    if (n === 0) {
        return [];
    }
    let total = 0;
    for (const program of programs) {
        total += program.duration;
    }
    if (! (total > 0) ) {
        return [];
    }
    const lineupStart = new Date(channel.startTime).getTime();
    let offset = (from - lineupStart) % total;
    if (offset < 0) {
        offset += total;
    }
    let index = 0;
    let begins = from - offset;       // the instant entry 0 of this trip round begins
    let t = begins;
    while ( (index < n) && (t + programs[index].duration <= from) ) {
        t += programs[index].duration;
        index++;
    }
    const found = [];
    // `t` is the start of entry `index`. A break begins at the first Flex entry
    // after a real program, so only those entries are asked about.
    for (let guard = 0; (t < to) && (guard < n * 1000); guard++) {
        const program = programs[index];
        const before = programs[(index - 1 + n) % n];
        if ( (program.isOffline === true) && (before.isOffline !== true) && (t >= from) ) {
            found.push( findBreak(channel, index, t) );
        }
        t += program.duration;
        index = (index + 1) % n;
    }
    return found;
}

/*
 * What a break is, and what its two contexts hand it. A side with no program
 * contributes nothing - not Leaving without a P, not Entering without an N -
 * which is different from a program whose context is simply the channel's own
 * Flex (null): that one has no transitions to offer either, but the program is
 * there, so the break still counts as a break between contexts if the other
 * side's differs.
 */
function assemble(channel, brk) {
    const hasPrev = (brk.prev != null);
    const hasNext = (brk.next != null);
    const from = hasPrev ? dayParts.resolveContext(channel, brk.prev.startTime) : null;
    const to = hasNext ? dayParts.resolveContext(channel, brk.next.startTime) : null;

    const plan = { situation: 'none', from: from, to: to, out: [], in: [] };
    if (! hasPrev && ! hasNext) {
        return plan;
    }

    const add = (side, situation, context) => {
        for (const step of normalizeTransitions(context)[situation][side]) {
            plan[side].push( { situation: situation, context: context, step: step } );
        }
    };

    if (hasPrev && hasNext && (from === to) ) {
        plan.situation = (showKey(brk.prev.program) === showKey(brk.next.program))
            ? 'betweenEpisodes'
            : 'betweenShows';
        add('out', plan.situation, from);
        add('in', plan.situation, from);
        return plan;
    }

    plan.situation = 'boundary';
    // P.leaving.out -> N.entering.out -> Flex -> P.leaving.in -> N.entering.in
    if (hasPrev) {
        add('out', 'leaving', from);
    }
    if (hasNext) {
        add('out', 'entering', to);
    }
    if (hasPrev) {
        add('in', 'leaving', from);
    }
    if (hasNext) {
        add('in', 'entering', to);
    }
    return plan;
}

module.exports = {
    SITUATIONS: SITUATIONS,
    KINDS: KINDS,
    MATCHES: MATCHES,
    KEYED_ON: KEYED_ON,
    showKey: showKey,
    emptyTransitions: emptyTransitions,
    normalizeTransitions: normalizeTransitions,
    findBreak: findBreak,
    breaksBetween: breaksBetween,
    assemble: assemble,
};
