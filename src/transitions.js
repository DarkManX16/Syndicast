/*
 * Transitions: the steps that play around a break - out before the Flex, in
 * after it. See docs/blocks-spec.md, Stage 5. Which situation a break is and
 * which steps its contexts hand it (assemble), and which clip each of those
 * steps plays (buildPlan). lineup-cursor.js plays a plan, through video.js,
 * which asks hasSteps first: a channel with no steps never builds a plan, so
 * it plays exactly as it did before transitions existed.
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
const showMatch = require('./show-match');

const SITUATIONS = ['leaving', 'entering', 'betweenEpisodes', 'betweenShows'];
const KINDS = ['list', 'generated'];
const MATCHES = ['any', 'show', 'pair'];
const KEYED_ON = ['now', 'next', 'later'];

const STEP_DEFAULTS = {
    kind: 'list', match: 'any', keyedOn: 'next', fallbackListId: null, onlyIfNoMatch: null,
    days: null, chance: null,
};

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

// Every day-part and block of the channel, each a context that may carry steps.
function contextsOf(channel) {
    const all = [];
    for (const list of [channel.dayParts, channel.blocks]) {
        if (Array.isArray(list)) {
            for (const context of list) {
                if (context != null) {
                    all.push(context);
                }
            }
        }
    }
    return all;
}

function isOnDemand(channel) {
    return (channel.onDemand != null) && (channel.onDemand.isOnDemand === true);
}

/*
 * Whether any break of this channel can have steps at all. Playback asks this
 * before anything else: a channel answering false - no sequences, sequences
 * that are all empty, or an on-demand channel, which has no contexts - plays
 * every break exactly as it did before transitions existed, with no plan
 * built and no step list loaded.
 */
function hasSteps(channel) {
    if ( (channel == null) || isOnDemand(channel) ) {
        return false;
    }
    for (const context of contextsOf(channel)) {
        const all = normalizeTransitions(context);
        for (const name of SITUATIONS) {
            if ( (all[name].out.length > 0) || (all[name].in.length > 0) ) {
                return true;
            }
        }
    }
    return false;
}

// Every filler list a step of this channel may draw from, fallbacks included,
// each once: what playback loads so buildPlan can read them synchronously.
function stepListIds(channel) {
    const ids = [];
    for (const context of contextsOf(channel)) {
        const all = normalizeTransitions(context);
        for (const name of SITUATIONS) {
            for (const step of all[name].out.concat(all[name].in)) {
                for (const id of [step.listId, step.fallbackListId]) {
                    if ( (typeof(id) === 'string') && (id !== '') && ! ids.includes(id) ) {
                        ids.push(id);
                    }
                }
            }
        }
    }
    return ids;
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

/*
 * The show that follows the next one: the first program after N's own run that
 * is neither Flex nor another episode of N's show, walking the cyclic lineup.
 * A clip naming two shows in a step keyed on next means "coming up: these two,
 * in this order", and this is the second of the two. null when N has no
 * successor (the whole lineup is one show, or there is no N).
 */
function showAfter(channel, brk) {
    if ( (brk == null) || (brk.next == null) ) {
        return null;
    }
    const programs = channel.programs;
    const n = programs.length;
    const nextKey = showKey(brk.next.program);
    for (let i = 1; i < n; i++) {
        const program = programs[(brk.next.index + i) % n];
        if (program.isOffline === true) {
            continue;
        }
        const key = showKey(program);
        if (key !== nextKey) {
            return key;
        }
    }
    return null;
}

/*
 * A step marked `onlyIfNoMatch: <step id>` plays only when the step it names
 * found no clip. Unset, null, false and '' all mean "not marked"; any other
 * value that is not a string is a marked step that can never be honoured.
 */
function watchOf(step) {
    const w = step.onlyIfNoMatch;
    if ( (typeof(w) === 'undefined') || (w === null) || (w === false) || (w === '') ) {
        return { marked: false, id: null };
    }
    return { marked: true, id: (typeof(w) === 'string') ? w : null };
}

/*
 * A step may be limited to some weekdays (`days`, 0 = Sunday as in day-parts) and
 * may play only some of the time (`chance`, a whole percent from 1 to 99; 100
 * and unset both mean always). Unset and null are off. Like watchProblem, each
 * returns why the value cannot be honoured, or null; buildPlan skips such a step
 * and channel-db.js warns at save, from these same two functions. An empty
 * `days` is a mistake and plays on no day, never on every day.
 */
function daysProblem(step) {
    const d = step.days;
    if ( (typeof(d) === 'undefined') || (d === null) ) {
        return null;
    }
    if (! Array.isArray(d) ) {
        return 'days must be a list of weekday numbers, 0 (Sunday) to 6 (Saturday)';
    }
    if (d.length === 0) {
        return 'days is empty, so it plays on no day';
    }
    if (d.some( (x) => (! Number.isInteger(x)) || (x < 0) || (x > 6) )) {
        return 'days must be weekday numbers, 0 (Sunday) to 6 (Saturday)';
    }
    return null;
}

function chanceProblem(step) {
    const c = step.chance;
    if ( (typeof(c) === 'undefined') || (c === null) ) {
        return null;
    }
    if ( (! Number.isInteger(c)) || (c < 1) || (c > 100) ) {
        return 'chance must be a whole percent from 1 to 99 (100 or unset means always)';
    }
    return null;
}

/*
 * The roll a step with a chance is judged by, in [0, 1): a hash of the channel,
 * the break's start and the step, not a random number. A plan is dropped on
 * every save and lost on a restart, and rebuilding a half-played break must not
 * change what it showed; this way every build of one break, for every viewer,
 * gets the same answer, while the same break a lineup cycle later (a different
 * start) gets its own. FNV-1a over the text, then mixed.
 */
function defaultRoll(channel, brk, key) {
    const text = channel.number + '|' + brk.startTime + '|' + key;
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    // FNV's last byte barely reaches the high bits, so two steps whose ids differ
    // only at the end would roll nearly alike; a final mix (murmur3's) spreads it.
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/*
 * Why a marked step cannot be honoured, or null when it can (or is not marked).
 * `sequence` is every step of one context's one situation, out and in together:
 * a step watches another step of its own sequence and nothing outside it. It
 * may not watch itself, a step that does not exist or is not unique, or
 * another marked step (what "found no match" would mean for a step that was
 * never tried is not something to guess at). buildPlan and channel-db.js's
 * save-time warning both ask this, so they cannot drift apart.
 */
function watchProblem(step, sequence) {
    const watch = watchOf(step);
    if (! watch.marked) {
        return null;
    }
    if (watch.id === null) {
        return `onlyIfNoMatch must be the id of the step it watches, not ${JSON.stringify(step.onlyIfNoMatch)}`;
    }
    if (watch.id === step.id) {
        return 'watches itself';
    }
    const named = sequence.filter( (s) => (s !== step) && (s != null) && (s.id === watch.id) );
    if (named.length === 0) {
        return `watches step "${watch.id}", which is not in this situation`;
    }
    if (named.length > 1) {
        return `watches step "${watch.id}", but that id is used more than once in this situation`;
    }
    if (watchOf(named[0]).marked) {
        return `watches step "${watch.id}", which is itself conditional`;
    }
    return null;
}

/*
 * A clip's names as plan-building reads them: [] when it has none, the one or
 * two keys when it has, and null when the field is there but unusable, which
 * makes the clip ineligible everywhere. An unusable `names` must never turn a
 * clip into a general one - that would play a clip meant for some show before a
 * different one.
 */
function namesState(clip) {
    if (showMatch.namesProblem(clip) !== null) {
        return null;
    }
    return showMatch.namesOf(clip);
}

/*
 * Which clip each step of a break's sequence plays: the plan, built once when
 * the break is entered. `env` is the outside world, so this stays pure:
 *
 *   env.getList(listId)   the clips of a filler list, or null if there is none
 *   env.lastPlayed(clip)  when the clip last played, ms (0 = never); the same
 *                         per-clip times filler picks by
 *   env.featuresShows(listId)
 *                         true when the list's clips feature shows (optional;
 *                         unset reads as false, so no list does)
 *   env.roll(brk, stepKey)
 *                         a number in [0, 1) judging a step's chance (optional;
 *                         default is defaultRoll, derived from the break, so
 *                         tests can force one)
 *   env.log               unused here; a caller logs plan.notes
 *
 * Returns the assembled break plus what each step chose:
 *   out, in      the steps that will play, in order, each
 *                { kind: 'list', stepId, situation, side, listId, via, names,
 *                  clip, durationMs, fits }; clip is a copy carrying fillerId, like a
 *                filler pick, so playback is credited to the list it came from, and
 *                fits the titles of every clip that fitted the step's winning tier,
 *                the chosen one first: the clips that take turns on air
 *   outMs, inMs  their total durations
 *   skipped      every step that does not play, { stepId, side, situation,
 *                reason, problem }
 *   notes        the problems among them (a missing list, a step that cannot
 *                be honoured) as one line each, for the caller to log. A step
 *                that merely found nothing - "skip if none" - is not a problem.
 *
 * A step tries its most specific match, then the next, then its fallback list,
 * then skips. Whatever it tries, a clip plays only if every show it names is
 * one the step is keyed on, so a general clip stands in for a specific one but
 * a clip for another show never does:
 *
 *   show, keyed on next   a clip naming N; or naming two shows, N then the show
 *                         after N. Keyed on now: a clip naming P. A two-name
 *                         clip is never read as "now, then" outside a pair step.
 *   pair                  a clip naming P then N, else one naming only N
 *   any                   no name needed; a named clip must fit as above
 *   fallback list         an unnamed clip, or a named one that fits
 *
 * Among the clips that fit a tier the longest idle plays, and a clip never
 * plays twice in one plan, so the in step of a break whose out step took the
 * only fitting clip falls through to its fallback or skips. Ties go to list
 * order, so one break always builds one plan. `keyedOn: 'later'` and the
 * 'generated' kind are not built and are skipped as problems.
 *
 * A step marked onlyIfNoMatch is decided after the unmarked ones, whose
 * outcomes are all known by then. A clip from a fallback list counts as a
 * match, so the marked step stays out when the step it watches fell back.
 *
 * A step with `days` plays only when the break's local weekday (its start,
 * 0 = Sunday) is listed, and one with `chance` only when its roll comes up
 * under the percent. A step left out either way has found nothing, so a step
 * marked to watch it plays. In a list whose clips feature shows, a step tries
 * clips naming the keyed show first, then any clip of the list, named or not
 * (via 'featured'); a list without the setting never plays a clip naming a
 * different show.
 */
function buildPlan(channel, brk, env) {
    if ( (env == null) || (typeof(env.getList) !== 'function') ) {
        throw new Error('transitions.buildPlan: env.getList is required');
    }
    const lastPlayed = (typeof(env.lastPlayed) === 'function') ? env.lastPlayed : () => 0;
    const roll = (key) => (typeof(env.roll) === 'function') ? env.roll(brk, key) : defaultRoll(channel, brk, key);
    const assembled = assemble(channel, brk);
    const plan = {
        situation: assembled.situation, from: assembled.from, to: assembled.to,
        out: [], in: [], outMs: 0, inMs: 0, skipped: [], notes: [],
    };

    const entries = [];
    for (const side of ['out', 'in']) {
        for (const e of assembled[side]) {
            entries.push( { side: side, situation: e.situation, context: e.context, step: e.step, found: null } );
        }
    }

    const prevKey = (brk.prev != null) ? showKey(brk.prev.program) : null;
    const nextKey = (brk.next != null) ? showKey(brk.next.program) : null;
    let afterKey;
    const showAfterLazily = () => {
        if (typeof(afterKey) === 'undefined') {
            afterKey = showAfter(channel, brk);
        }
        return afterKey;
    };
    const keyedShows = (keyedOn) => {
        if (keyedOn === 'next') {
            const then = showAfterLazily();
            return { singles: [nextKey], pair: (then != null) ? [nextKey, then] : null };
        }
        if (keyedOn === 'now') {
            return { singles: [prevKey], pair: null };
        }
        return null;
    };
    const fits = (names, keyed) => {
        if (names.length === 0) {
            return true;
        }
        if (names.length === 1) {
            return (names[0] === keyed.singles[0]) || ( (keyed.singles.length > 1) && (names[0] === keyed.singles[1]) );
        }
        return (keyed.pair != null) && (names[0] === keyed.pair[0]) && (names[1] === keyed.pair[1]);
    };

    const lists = new Map();
    const clipsOf = (listId) => {
        if ( (listId == null) || (listId === '') ) {
            return null;
        }
        if (! lists.has(listId) ) {
            const found = env.getList(listId);
            lists.set(listId, (Array.isArray(found) && (found.length > 0)) ? found : null);
        }
        return lists.get(listId);
    };

    const used = new Set();
    const skip = (entry, reason, problem) => {
        plan.skipped.push( { stepId: entry.step.id, side: entry.side, situation: entry.situation, reason: reason, problem: problem } );
        if (problem) {
            plan.notes.push(`${entry.situation}.${entry.side} step "${entry.step.id}": ${reason}`);
        }
    };

    // A list whose clips feature shows (env.featuresShows) lets any clip play
    // before any show, after the clips that name the keyed show have had their turn.
    const featured = (listId) => (typeof(env.featuresShows) === 'function') && (env.featuresShows(listId) === true);
    const anyClip = { via: 'featured', accept: () => true };

    const tiersOf = (step) => {
        let own;
        let general;
        let ownFeatured;
        if (step.match === 'pair') {
            general = { singles: [prevKey, nextKey], pair: [prevKey, nextKey] };
            own = [
                { via: 'pair', accept: (names) => (names.length === 2) && (names[0] === prevKey) && (names[1] === nextKey) },
                { via: 'next', accept: (names) => (names.length === 1) && (names[0] === nextKey) },
            ];
            ownFeatured = own.concat([anyClip]);
        } else if ( (step.match === 'show') || (step.match === 'any') ) {
            general = keyedShows(step.keyedOn);
            if (general === null) {
                return null;
            }
            own = [ { via: step.match, accept: (names) => ( (step.match === 'any') || (names.length > 0) ) && fits(names, general) } ];
            ownFeatured = [ { via: step.match, accept: (names) => (names.length > 0) && fits(names, general) }, anyClip ];
        } else {
            return undefined;
        }
        return {
            own: own,
            ownFeatured: ownFeatured,
            fallback: [ { via: 'fallback', accept: (names) => fits(names, general) } ],
            fallbackFeatured: [ { via: 'fallback', accept: (names) => (names.length > 0) && fits(names, general) }, anyClip ],
        };
    };

    // Every clip of the list that fits the tier, in the order they would take their
    // turns (longest idle first, ties in list order): the first is the one chosen.
    const choose = (tier, clips) => {
        const eligible = [];
        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            if ( (clip == null) || used.has(clip) || ! (clip.duration > 0) ) {
                continue;
            }
            const names = namesState(clip);
            if ( (names !== null) && tier.accept(names) ) {
                const played = lastPlayed(clip);
                eligible.push( { clip: clip, played: (typeof(played) === 'number') ? played : 0, order: i } );
            }
        }
        eligible.sort( (a, b) => (a.played - b.played) || (a.order - b.order) );
        return eligible.map( (e) => e.clip );
    };

    // Whether this step is left out before it looks for a clip: a day or chance
    // it cannot honour (a problem), a weekday it is not limited to, or a lost
    // roll. Either way it has found nothing, so a step watching it plays.
    const leftOut = (entry) => {
        const step = entry.step;
        const bad = daysProblem(step) || chanceProblem(step);
        if (bad !== null) {
            skip(entry, bad, true);
            return true;
        }
        if ( (step.days != null) && (brk.startTime != null)
            && ! step.days.includes( new Date(brk.startTime).getDay() ) ) {
            skip(entry, 'not one of its days', false);
            return true;
        }
        if ( (step.chance != null) && (step.chance < 100) ) {
            const key = (step.id != null) ? step.id : `${entry.situation}.${entry.side}`;
            if (! (roll(key) * 100 < step.chance) ) {
                skip(entry, `lost its ${step.chance}% chance`, false);
                return true;
            }
        }
        return false;
    };

    const resolve = (entry) => {
        const step = entry.step;
        if (step.kind !== 'list') {
            skip(entry, `${step.kind} steps are not built yet`, true);
            return;
        }
        if (leftOut(entry)) {
            return;
        }
        const tiers = tiersOf(step);
        if (typeof(tiers) === 'undefined') {
            skip(entry, `has match "${step.match}", which is not one of ${MATCHES.join(', ')}`, true);
            return;
        }
        if (tiers === null) {
            skip(entry, (step.keyedOn === 'later') ? 'keyedOn "later" is not built yet' : `has keyedOn "${step.keyedOn}", which is not one of ${KEYED_ON.join(', ')}`, true);
            return;
        }
        const primary = clipsOf(step.listId);
        if (primary === null) {
            skip(entry, `its list ${step.listId == null ? '(none chosen)' : `"${step.listId}"`} is missing or empty`, true);
            return;
        }
        const attempts = (featured(step.listId) ? tiers.ownFeatured : tiers.own)
            .map( (tier) => ({ tier: tier, listId: step.listId, clips: primary }) );
        if ( (step.fallbackListId != null) && (step.fallbackListId !== '') ) {
            const fallback = clipsOf(step.fallbackListId);
            if (fallback === null) {
                plan.notes.push(`${entry.situation}.${entry.side} step "${step.id}": its fallback list "${step.fallbackListId}" is missing or empty`);
            } else {
                for (const tier of (featured(step.fallbackListId) ? tiers.fallbackFeatured : tiers.fallback) ) {
                    attempts.push( { tier: tier, listId: step.fallbackListId, clips: fallback } );
                }
            }
        }
        for (const attempt of attempts) {
            const fitting = choose(attempt.tier, attempt.clips);
            if (fitting.length > 0) {
                const clip = fitting[0];
                used.add(clip);
                const copy = JSON.parse( JSON.stringify(clip) );
                copy.fillerId = attempt.listId;
                entry.found = {
                    kind: 'list', stepId: step.id, situation: entry.situation, side: entry.side,
                    listId: attempt.listId, via: attempt.tier.via, names: namesState(clip),
                    clip: copy, durationMs: clip.duration,
                    fits: fitting.map( (c) => c.title ),
                };
                return;
            }
        }
        skip(entry, 'found no clip', false);
    };

    const sequenceOf = (entry) => entries
        .filter( (e) => (e.context === entry.context) && (e.situation === entry.situation) )
        .map( (e) => e.step );

    for (const entry of entries) {
        if (! watchOf(entry.step).marked) {
            resolve(entry);
        }
    }
    for (const entry of entries) {
        if (! watchOf(entry.step).marked) {
            continue;
        }
        const problem = watchProblem(entry.step, sequenceOf(entry));
        if (problem !== null) {
            skip(entry, problem, true);
            continue;
        }
        const watched = entries.find( (e) => (e !== entry) && (e.context === entry.context)
            && (e.situation === entry.situation) && (e.step.id === entry.step.onlyIfNoMatch) );
        if (watched.found !== null) {
            skip(entry, `only plays if "${watched.step.id}" finds no clip, and it did`, false);
            continue;
        }
        resolve(entry);
    }

    for (const entry of entries) {
        if (entry.found !== null) {
            plan[entry.side].push(entry.found);
            plan[entry.side === 'out' ? 'outMs' : 'inMs'] += entry.found.durationMs;
        }
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
    hasSteps: hasSteps,
    stepListIds: stepListIds,
    findBreak: findBreak,
    breaksBetween: breaksBetween,
    assemble: assemble,
    showAfter: showAfter,
    watchProblem: watchProblem,
    daysProblem: daysProblem,
    chanceProblem: chanceProblem,
    defaultRoll: defaultRoll,
    buildPlan: buildPlan,
};
