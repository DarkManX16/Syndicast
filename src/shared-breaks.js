/*
 * One list of Flex picks per break, per channel: every viewer of a channel
 * sees the same commercials in the same order, as on a real broadcast.
 *
 * Each viewer's stream asks for its Flex one clip at a time (lineup-cursor.js
 * keeps it in order). Before, every request ran the picker for itself, so two
 * viewers of one channel saw different commercials, and each one's clip held
 * the list against the other (NOTES.md, "Two viewers of a channel took turns
 * with the offline screen"). Now a Flex entry of the lineup, each time round
 * the cycle, has a list of picks kept in channel-cache.js, like a break's
 * transition plan:
 *
 *   - the first viewer to need pick k makes it, with the picker as it always
 *     chose (weights, cooldowns, the longest idle), and its play times are
 *     recorded then - once per pick, however many viewers play it
 *   - every other viewer plays pick k next, from its start, without recording
 *     it again; the cursor's `pick` says how far into the list a stream is
 *   - a viewer for whom pick k no longer fits what is left of its break (it is
 *     later than the viewer who made it by more than SLACK) picks its own for
 *     the rest of that entry, and stays off the list there
 *   - a stream with no cursor (tuning in, /m3u8, a cursor the clock took back)
 *     joins the pick on the air at that moment, partway, as the replay cache
 *     already does; with none on the air it makes the next pick, except a
 *     tune-in's, which starts partway into a clip and is its own
 *
 * Viewers of a channel are seldom more than a few seconds apart in a break -
 * every break bends each stream back to the clock - so a shared pick nearly
 * always fits: about 1 pick in 100, always a break's last, did not, measured
 * on simulated days of channel 1.
 *
 * Pure: channel-cache.js holds the lists and video.js does the asking.
 */
const SLACK = require('./constants').SLACK;

function isOnDemand(channel) {
    return (typeof(channel.onDemand) === 'object') && (channel.onDemand !== null)
        && (channel.onDemand.isOnDemand === true);
}

/*
 * Whether obj (getCurrentProgramAndTimeElapsed's or the cursor's answer) is
 * Flex of this channel's own lineup that can share its picks: not a
 * transition step, an error, a redirect or an on-demand channel.
 */
function shareable(channel, obj) {
    if ( (obj == null) || (typeof(obj) !== 'object') || isOnDemand(channel) ) {
        return false;
    }
    let programs = channel.programs;
    let index = obj.programIndex;
    if (! Array.isArray(programs) || (typeof(index) !== 'number') || (index < 0) || (index >= programs.length) ) {
        return false;
    }
    let program = obj.program;
    return (program === programs[index]) && (program.isOffline === true) && (program.type !== 'redirect')
        && (typeof(program.err) === 'undefined')
        && ( (typeof(obj.transition) !== 'object') || (obj.transition === null) );
}

// Where obj's Flex entry starts on the lineup, as the cursor and the clock both count it.
function entryStart(obj, t0) {
    return (typeof(obj.lineupStart) === 'number') ? obj.lineupStart : t0 + (obj.startsIn || 0) - obj.timeElapsed;
}

// This time round the lineup's cycle: the entry and where it starts.
function keyOf(obj, t0) {
    return `${obj.programIndex}|${entryStart(obj, t0)}`;
}

function entryEnd(obj, t0) {
    return entryStart(obj, t0) + obj.program.duration;
}

function copyOf(item) {
    return JSON.parse(JSON.stringify(item));
}

/*
 * What a stream plays next in a Flex entry. `log` is the entry's list (or
 * null), `at` the cursor's pick (a number, -1 for "off the list here", or
 * undefined on the clock path), leftMs the time the stream has left for Flex
 * (helperFuncs.timeLeft). One of:
 *
 *   { kind: 'replay', item, next }  pick `at`, from its start
 *   { kind: 'join',   item, next }  the pick on the air at t0, partway
 *   { kind: 'new', index, next }    make pick `index` with the picker and add it
 *   { kind: 'own', next }           a pick of this stream's own, not shared
 *
 * `next` is the cursor's pick once this has played. A replayed or joined item
 * carries sharedPick, so its play times are not recorded a second time.
 */
function decide(log, at, leftMs, t0, isFirst) {
    let picks = ( (log != null) && Array.isArray(log.picks) ) ? log.picks : [];
    if (at === -1) {
        return { kind: 'own', next: -1 };
    }
    if (typeof(at) !== 'number') {
        for (let j = picks.length - 1; j >= 0; j--) {
            let p = picks[j];
            let into = t0 - p.at;
            let rest = p.item.streamDuration - into;
            if ( (into >= 0) && (rest >= SLACK) ) {
                let item = copyOf(p.item);
                item.start += into;
                item.streamDuration = Math.min(rest, leftMs + SLACK);
                item.sharedPick = true;
                return { kind: 'join', item: item, next: j + 1 };
            }
        }
        if (isFirst) {
            return { kind: 'own', next: picks.length };
        }
        return { kind: 'new', index: picks.length, next: picks.length + 1 };
    }
    if (at < picks.length) {
        let p = picks[at];
        let length = p.item.duration - p.item.start;
        if (length <= leftMs + SLACK) {
            let item = copyOf(p.item);
            item.streamDuration = Math.max(1, Math.min(length, leftMs + SLACK));
            item.sharedPick = true;
            return { kind: 'replay', item: item, next: at + 1 };
        }
        return { kind: 'own', next: -1 };
    }
    return { kind: 'new', index: picks.length, next: picks.length + 1 };
}

module.exports = {
    shareable: shareable,
    keyOf: keyOf,
    entryEnd: entryEnd,
    decide: decide,
};
