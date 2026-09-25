/*
 * Day-parts and blocks: a wall-clock schedule of filler rules, resolved at
 * the moment filler is picked. See docs/blocks-spec.md. Blocks are stage 2 -
 * a named, possibly-repeating stretch of programming (Toonami, Miguzi) that
 * overrides whichever day-part would otherwise be running while it airs.
 *
 * This is an overlay. Nothing here enters the generated lineup and nothing
 * here changes how slots schedule shows - it only decides which filler lists
 * createLineup draws from, and (stage 2) what name the guide shows in place
 * of a channel's own placeholder. A channel with neither day-parts nor blocks
 * resolves to null everywhere, so the picker runs on exactly the array it was
 * handed and behaves as it did before any of this existed.
 *
 * Kept free of I/O on purpose, the same way src/image-url.js is: every
 * function here is a pure function of a channel object and an instant, so the
 * resolution rules can be exercised without a data folder, a filler DB or a
 * running server.
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;

/*
 * How far forward a neighbour walk is willing to look for a real program.
 * Consecutive Flex blocks are merged by the slot generator, so in practice the
 * first step finds one; the cap is here because a channel on this install
 * carries 39,999 programs and an all-Flex stretch must not turn a per-clip
 * decision into a scan of all of them.
 */
const MAX_NEIGHBOUR_SCAN = 32;

let standardOffsetCache = {};

function timezoneOffsetAt(instant) {
    return (new Date(instant)).getTimezoneOffset() * MINUTE;
}

/*
 * The offset this zone keeps outside daylight saving. Whichever of midwinter
 * and midsummer sits further behind UTC is the standard one, which is true in
 * both hemispheres and in zones that never shift at all.
 */
function standardOffsetFor(instant) {
    let year = (new Date(instant)).getFullYear();
    if (typeof(standardOffsetCache[year]) === 'undefined') {
        let jan = (new Date(year, 0, 1)).getTimezoneOffset();
        let jul = (new Date(year, 6, 1)).getTimezoneOffset();
        standardOffsetCache[year] = Math.max(jan, jul) * MINUTE;
    }
    return standardOffsetCache[year];
}

/*
 * How far ahead of standard time the local clock is running at this instant:
 * zero in winter, an hour in summer. A start marked "shift with daylight
 * saving" stays fixed in standard time, so adding this is what makes 7:00 PM in
 * January read as 8:00 PM in July. Everything else stays at the wall-clock time
 * that was entered.
 *
 * Resolved per instant rather than captured once, for the reason the slot
 * generator resolves its offset per occurrence: a value captured at save time
 * is wrong for most of the year it is used in.
 */
function daylightShiftAt(instant) {
    return standardOffsetFor(instant) - timezoneOffsetAt(instant);
}

/*
 * Where an instant falls in the week, in local calendar terms. Using the local
 * day and clock fields rather than arithmetic on the epoch is what gives
 * "12am starts the next day" for free - Saturday 1am is simply Saturday.
 */
function weekPositionOf(instant) {
    let d = new Date(instant);
    return d.getDay() * DAY
        + d.getHours() * 60 * MINUTE
        + d.getMinutes() * MINUTE
        + d.getSeconds() * 1000
        + d.getMilliseconds();
}

function isOnDemand(channel) {
    return (typeof(channel.onDemand) !== 'undefined')
        && (channel.onDemand.isOnDemand === true);
}

/*
 * On-demand channels deliberately sever the lineup from the wall clock, so a
 * wall-clock schedule of filler rules has nothing to attach to.
 */
function hasDayParts(channel) {
    return (channel != null)
        && Array.isArray(channel.dayParts)
        && (channel.dayParts.length > 0)
        && ! isOnDemand(channel);
}

/*
 * Same as hasDayParts, for blocks. Kept as its own check rather than folded
 * straight into hasOverlay because allFillerCollections and blockContextAt
 * each need to know specifically which kind of overlay a channel has, not
 * just whether it has one.
 */
function hasBlocks(channel) {
    return (channel != null)
        && Array.isArray(channel.blocks)
        && (channel.blocks.length > 0)
        && ! isOnDemand(channel);
}

/*
 * Whether any time-scoped overlay applies to this channel at all - day-parts,
 * blocks, or both. This is the guard resolveCollections and
 * allFillerCollections actually want: a channel with only blocks and no
 * day-parts must still be intervened on, and a channel with neither must be
 * left completely alone, by reference - the same guarantee stage 1 made for
 * day-parts alone.
 */
function hasOverlay(channel) {
    return hasDayParts(channel) || hasBlocks(channel);
}

/*
 * One start can name several days, so it expands to one point per day. A
 * daylight-saving shift can carry a late start past midnight - an 11:30pm start
 * fixed in standard time really is 12:30am the next day in summer - so the
 * position is normalised back into the week rather than clamped.
 */
function startWeekPositions(start, instant) {
    let positions = [];
    if ( (start == null) || ! Array.isArray(start.days) ) {
        return positions;
    }
    let time = start.time;
    if (typeof(time) !== 'number' || isNaN(time)) {
        return positions;
    }
    let shift = (start.shiftWithDst === true) ? daylightShiftAt(instant) : 0;
    for (let i = 0; i < start.days.length; i++) {
        let day = start.days[i];
        if (typeof(day) !== 'number' || isNaN(day)) {
            continue;
        }
        let at = day * DAY + time + shift;
        positions.push( ((at % WEEK) + WEEK) % WEEK );
    }
    return positions;
}

/*
 * Every start of every day-part, as one continuous weekly chain. There are no
 * end times: each start runs until the next one, wrapping at the end of the
 * week, which is what makes gaps and overlaps impossible.
 */
function chainOf(channel, instant) {
    let points = [];
    let dayParts = channel.dayParts;
    for (let i = 0; i < dayParts.length; i++) {
        let dayPart = dayParts[i];
        if ( (dayPart == null) || ! Array.isArray(dayPart.starts) ) {
            continue;
        }
        for (let j = 0; j < dayPart.starts.length; j++) {
            let positions = startWeekPositions(dayPart.starts[j], instant);
            for (let k = 0; k < positions.length; k++) {
                points.push({
                    at: positions[k],
                    dayPartIndex: i,
                    startIndex: j,
                    dayPart: dayPart,
                });
            }
        }
    }
    points.sort( (a, b) => {
        if (a.at !== b.at) {
            return a.at - b.at;
        }
        if (a.dayPartIndex !== b.dayPartIndex) {
            return a.dayPartIndex - b.dayPartIndex;
        }
        return a.startIndex - b.startIndex;
    } );
    return points;
}

/*
 * The latest start at or before this point in the week. Two starts landing on
 * the same moment is a configuration error the editor warns about; resolving it
 * to the day-part declared first keeps the answer deterministic rather than
 * dependent on sort stability.
 */
function pickPoint(points, position) {
    let chosen = null;
    for (let i = 0; i < points.length; i++) {
        if (points[i].at > position) {
            break;
        }
        if ( (chosen === null) || (points[i].at > chosen.at) ) {
            chosen = points[i];
        }
    }
    if (chosen !== null) {
        return chosen;
    }
    // Nothing has started yet this week, so the chain has wrapped and the
    // week's last start is still running. Saturday 12am needs no configuration
    // for the same reason: the day-part that began on Friday simply runs on.
    let last = points[points.length - 1];
    for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].at !== last.at) {
            break;
        }
        last = points[i];
    }
    return last;
}

/*
 * Every span an airing covers this week, one per day it names, in week-
 * position terms. An airing whose end is earlier than its start crosses
 * midnight and belongs to its start day (the spec's rule): the span's length
 * is computed from the raw start/end so that rule holds regardless of
 * shiftWithDst, and a span can run past the end of the week (one starting
 * late Saturday and crossing into Sunday) - spanCovers, below, is what reads
 * that correctly rather than this function wrapping it.
 *
 * shiftWithDst moves the whole airing together rather than shifting each end
 * on its own, so a block's length on the wall clock never changes with the
 * season - only where it sits does. That is what lets "Cartoon Theatre covers
 * 7-8pm in both seasons" hold: shifting only the start while leaving the end
 * fixed would stretch or shrink the hour instead of moving it.
 */
function airingSpans(airing, instant) {
    let spans = [];
    if ( (airing == null) || ! Array.isArray(airing.days) ) {
        return spans;
    }
    let start = airing.start;
    let end = airing.end;
    if ( (typeof(start) !== 'number') || isNaN(start) || (typeof(end) !== 'number') || isNaN(end) ) {
        return spans;
    }
    let length = end - start;
    if (length < 0) {
        length += DAY;
    }
    let shift = (airing.shiftWithDst === true) ? daylightShiftAt(instant) : 0;
    for (let i = 0; i < airing.days.length; i++) {
        let day = airing.days[i];
        if (typeof(day) !== 'number' || isNaN(day)) {
            continue;
        }
        let from = ( ((day * DAY + start + shift) % WEEK) + WEEK ) % WEEK;
        spans.push( { from: from, to: from + length } );
    }
    return spans;
}

/*
 * Whether a week-position span covers a position, including the copy of the
 * span one week later - which is what makes an airing starting late Saturday
 * and crossing into Sunday still cover a Sunday-morning instant, whose own
 * week position sits nowhere near the span's un-shifted [from, to). A span
 * one week *earlier* is never relevant: position is already normalised into
 * [0, WEEK), and every span's own `from` is too, so shifting position back a
 * week can only move it further from a non-negative `from`.
 */
function spanCovers(span, position) {
    return (position >= span.from && position < span.to)
        || (position + WEEK >= span.from && position + WEEK < span.to);
}

/*
 * The block airing covering this instant, or null. Declaration order is the
 * tie-break, both for an accidental overlap between two different blocks (the
 * editor is meant to prevent this; the resolver still needs an answer if one
 * slips through - a hand-edited channel file, say) and, harmlessly, for a
 * single block's own airings never being able to collide with themselves. The
 * first match found wins, mirroring pickPoint's "declared first" rule for
 * colliding day-part starts.
 */
function blockContextAt(channel, instant) {
    if (! hasBlocks(channel)) {
        return null;
    }
    let position = weekPositionOf(instant);
    for (let i = 0; i < channel.blocks.length; i++) {
        let block = channel.blocks[i];
        if ( (block == null) || ! Array.isArray(block.airings) ) {
            continue;
        }
        for (let j = 0; j < block.airings.length; j++) {
            let spans = airingSpans(block.airings[j], instant);
            for (let k = 0; k < spans.length; k++) {
                if (spanCovers(spans[k], position)) {
                    return block;
                }
            }
        }
    }
    return null;
}

/*
 * The context covering an instant: the block airing there, else the day-part
 * covering it, else null - the channel's own Flex applies from there. Blocks
 * are checked first unconditionally, per the spec's definition of context; a
 * day-part chain has no notion of "paused while a block airs", so a block
 * simply outranks whatever the day-part chain would otherwise say.
 */
function resolveContext(channel, instant) {
    let block = blockContextAt(channel, instant);
    if (block !== null) {
        return block;
    }
    if (! hasDayParts(channel)) {
        return null;
    }
    let points = chainOf(channel, instant);
    if (points.length === 0) {
        return null;
    }
    return pickPoint(points, weekPositionOf(instant)).dayPart;
}

/*
 * The first real program after the break being filled, and the wall-clock
 * instant it starts at.
 *
 * obj is what getCurrentProgramAndTimeElapsed returned, so obj.programIndex
 * addresses channel.programs and the break began at t0 - obj.timeElapsed. The
 * duration is read from the array rather than from obj.program because video.js
 * substitutes a synthetic year-long program for a permanently offline channel;
 * that case has no real neighbour anyway and falls through to null below.
 *
 * Adjacent Flex blocks are skipped: two Flex programs in a row are one break as
 * far as a viewer is concerned. A channel that is Flex all the way round
 * returns null, and the caller resolves from the clock instead.
 */
function findNextProgram(channel, t0, obj) {
    let programs = channel.programs;
    if (! Array.isArray(programs) || (programs.length === 0) ) {
        return null;
    }
    let index = obj.programIndex;
    if ( (typeof(index) !== 'number') || (index < 0) || (index >= programs.length) ) {
        return null;
    }
    let at = t0 - obj.timeElapsed + programs[index].duration;
    let limit = Math.min(MAX_NEIGHBOUR_SCAN, programs.length);
    for (let i = 1; i <= limit; i++) {
        let program = programs[ (index + i) % programs.length ];
        if (program.isOffline !== true) {
            return { program: program, startTime: at };
        }
        at += program.duration;
    }
    return null;
}

/*
 * The shared "given a maybe-absent neighbour, which instant do we resolve
 * context at" decision - see resolveCollections below for why the neighbour's
 * start wins when there is one. Factored out because the picker and the
 * guide each find that neighbour a different way (the picker walks
 * channel.programs from obj.programIndex; the guide scans the window it has
 * already built) but, once a neighbour's start time is in hand or is absent,
 * make the identical decision from it.
 */
function resolveBreakContext(channel, t0, neighbourStartTime) {
    let instant = ( (neighbourStartTime !== null) && (typeof(neighbourStartTime) !== 'undefined') )
        ? neighbourStartTime
        : t0;
    return resolveContext(channel, instant);
}

/*
 * Which filler mix fills this break, or null when nothing time-scoped applies
 * and the channel's own Flex tab should be used exactly as it is.
 *
 * The rule in the spec has two branches - same context on both sides of the
 * break uses that context's mix, a boundary uses the incoming one - and for the
 * mix alone both land on the incoming context. That is not an oversight: the
 * branches are kept distinct because stage 5 picks a different transition
 * sequence for a boundary than for a break inside one context. Only the
 * incoming side is computed here, because only it changes the answer. Stage 2
 * extends the same rule to block contexts: resolveContext already checks
 * blocks before day-parts, so nothing here needs to know which kind of
 * context it ends up with.
 *
 * Taking the context from the neighbouring program rather than from the clock
 * is what makes "the filler starts after the 2:30 show" work, and what keeps it
 * right when a show overruns. It also means the mix is stable for the whole of
 * a long break: createLineup is re-invoked once per filler clip with a fresh
 * t0, but the neighbour it reads does not move, so a break spanning a boundary
 * plays one mix throughout instead of switching partway.
 */
function resolveCollections(channel, t0, obj) {
    if (! hasOverlay(channel)) {
        return null;
    }
    let next = findNextProgram(channel, t0, obj);
    let context = resolveBreakContext(channel, t0, next !== null ? next.startTime : null);
    if ( (context == null) || ! Array.isArray(context.fillerCollections) ) {
        return null;
    }
    return context.fillerCollections;
}

/*
 * Every filler list the channel can reach, deduplicated by id. video.js loads
 * content for all of them so that createLineup, which is synchronous, can pick
 * a mix without having to go to the filler DB itself.
 *
 * The weights and cooldowns in the returned entries are not used for that -
 * createLineup re-applies them from whichever mix it resolves. This is a list
 * of what to load, nothing more.
 *
 * A channel with neither day-parts nor blocks gets its own array back, by
 * reference, so the picker provably runs on the same input it always did.
 */
function allFillerCollections(channel) {
    if (! hasOverlay(channel)) {
        return channel.fillerCollections;
    }
    let seen = {};
    let all = [];
    let add = (collections) => {
        if (! Array.isArray(collections)) {
            return;
        }
        for (let i = 0; i < collections.length; i++) {
            let collection = collections[i];
            if ( (collection == null)
                || (typeof(collection.id) === 'undefined')
                || (collection.id === 'none')
            ) {
                continue;
            }
            if (seen[collection.id] === true) {
                continue;
            }
            seen[collection.id] = true;
            all.push(collection);
        }
    };
    add(channel.fillerCollections);
    if (hasDayParts(channel)) {
        for (let i = 0; i < channel.dayParts.length; i++) {
            add(channel.dayParts[i].fillerCollections);
        }
    }
    if (hasBlocks(channel)) {
        for (let i = 0; i < channel.blocks.length; i++) {
            add(channel.blocks[i].fillerCollections);
        }
    }
    return all;
}

/*
 * The name to show in the guide in place of the channel's own placeholder,
 * when a time-scoped context governs the moment - stage 2's generalisation of
 * guideFlexPlaceholder. Strictly opt-in: a context with no guideName of its
 * own falls through to the channel-wide placeholder exactly as if it had
 * none, so wiring this into the guide changes no existing channel's output
 * until someone types a name into the new field.
 *
 * context is whatever resolveContext already returned - a block, a day-part,
 * or null - so the caller does the resolving and this just reads the result;
 * it never resolves anything itself.
 */
function guideNameFor(channel, context) {
    if ( (context != null) && (typeof(context.guideName) === 'string') && (context.guideName !== '') ) {
        return context.guideName;
    }
    if ( (typeof(channel.guideFlexPlaceholder) === 'string') && (channel.guideFlexPlaceholder !== '') ) {
        return channel.guideFlexPlaceholder;
    }
    return channel.name;
}

/*
 * What a start actually reads as on the wall clock at a given instant, so the
 * editor can show "7:00 PM in winter, 8:00 PM in summer" instead of asking
 * anyone to think in standard time. Returns ms from local midnight, which may
 * land on the following day for a shifted late-night start.
 */
function effectiveStartTime(start, instant) {
    let shift = (start.shiftWithDst === true) ? daylightShiftAt(instant) : 0;
    return ( ((start.time + shift) % DAY) + DAY ) % DAY;
}

module.exports = {
    hasDayParts: hasDayParts,
    hasBlocks: hasBlocks,
    hasOverlay: hasOverlay,
    resolveContext: resolveContext,
    resolveBreakContext: resolveBreakContext,
    resolveCollections: resolveCollections,
    allFillerCollections: allFillerCollections,
    guideNameFor: guideNameFor,
    effectiveStartTime: effectiveStartTime,
    daylightShiftAt: daylightShiftAt,
    findNextProgram: findNextProgram,
    DAY: DAY,
    WEEK: WEEK,
};
