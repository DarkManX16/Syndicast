/*
 * Where each slot position is in its show, for the slot generators and the
 * slot editors alike. Pure - no I/O - so the editor reaches it through
 * browserify and the two can never disagree about what a position is.
 *
 * A position is one show, one mode and one range: "Johnny Bravo, Play Next,
 * no Season 2". Slots that share all three share a place. Every airing a
 * generator emits carries a label naming its position, and when Create Lineup
 * runs the editor reads each position's place from the lineup it has loaded:
 * the first airing of that position on air or ahead. A lineup saved before
 * labels existed is read by matching each airing to the slot it starts in.
 *
 * See NOTES.md, Known issues, "Per-position stored progress, and the shuffles
 * built on it".
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const MODES = [ 'next', 'shuffle', 'rerun', 'repeat', 'ordered' ];
// The modes that work through rounds, and so carry a round number.
const ROUND_MODES = [ 'shuffle', 'rerun', 'ordered' ];

/*
 * A slot's season settings. Schedules saved before settings moved onto the
 * slot carried one entry per show in schedule.showConstraints, still read for
 * a slot with none of its own.
 */
function constraintOf(slot, schedule) {
    if ( (typeof(slot.seasons) === 'object') && (slot.seasons !== null) ) {
        return slot.seasons;
    }
    if ( (typeof(schedule) !== 'object') || (schedule === null)
         || (typeof(schedule.showConstraints) !== 'object')
         || (schedule.showConstraints === null) ) {
        return undefined;
    }
    return schedule.showConstraints[slot.showId];
}

/*
 * The seasons a constraint leaves out, ascending. startSeason is a one-time
 * seek, not part of what a position is: if it were, a position's key would
 * change the moment the seek was cleared after a run.
 */
function excludedOf(constraint) {
    if ( (typeof(constraint) !== 'object') || (constraint === null)
         || ! Array.isArray(constraint.excludeSeasons) ) {
        return [];
    }
    return constraint.excludeSeasons.slice().sort( (a, b) => a - b );
}

function positionKey(showId, mode, constraint) {
    return JSON.stringify( [ showId, mode, excludedOf(constraint) ] );
}

/*
 * The label an airing carries: "next|2", "shuffle|1,2|3", "repeat". The show
 * is not in it - getShowData gives that from the program itself.
 */
function label(mode, constraint, round) {
    if (mode === 'repeat') {
        return 'repeat';
    }
    let text = mode + '|' + excludedOf(constraint).join(',');
    if (ROUND_MODES.indexOf(mode) !== -1) {
        text += '|' + ( (typeof(round) === 'number') ? round : 0 );
    }
    return text;
}

function parseLabel(text) {
    if (typeof(text) !== 'string') {
        return null;
    }
    if (text === 'repeat') {
        return { mode: 'repeat', excluded: [], round: null };
    }
    let parts = text.split('|');
    let mode = parts[0];
    if ( (MODES.indexOf(mode) === -1) || (mode === 'repeat') ) {
        return null;
    }
    let rounds = ROUND_MODES.indexOf(mode) !== -1;
    if (parts.length !== (rounds ? 3 : 2) ) {
        return null;
    }
    let excluded = [];
    if (parts[1] !== '') {
        excluded = parts[1].split(',').map( (s) => /^-?\d+$/.test(s) ? parseInt(s, 10) : NaN );
        if ( excluded.some( (n) => isNaN(n) ) ) {
            return null;
        }
    }
    let round = null;
    if (rounds) {
        if (! /^\d+$/.test(parts[2]) ) {
            return null;
        }
        round = parseInt(parts[2], 10);
    }
    return { mode: mode, excluded: excluded, round: round };
}

/*
 * An episode reference: the file, and where it sits in its show's order. The
 * file key is what identifies it; the order is the fallback once the file has
 * gone, and keeps meaning something when the candidates change, where an
 * index into them would not.
 */
function ref(program, getShowData) {
    let server = (typeof(program.serverKey) === 'undefined') ? 'unknown' : program.serverKey;
    let key = (typeof(program.key) === 'undefined') ? 'unknown' : program.key;
    return { key: server + '|' + key, order: getShowData(program).order };
}

/*
 * The generator's own arithmetic for which slot covers an instant -
 * localMsIntoPeriod and findSlot in time-slots-service.js, which
 * test/dst-fall-back.js lifts to check this agrees with through a
 * daylight-saving change. Built once per schedule, since reading a lineup
 * asks it for every airing.
 */
function slotFinder(schedule) {
    let period = (typeof(schedule.period) === 'number') ? schedule.period : DAY;
    let s = (Array.isArray(schedule.slots) ? schedule.slots : [])
        .filter( (slot) => typeof(slot.time) === 'number' )
        .slice()
        .sort( (a, b) => a.time - b.time );
    return (instant) => {
        if (s.length === 0) {
            return null;
        }
        let offsetMs = (new Date(instant)).getTimezoneOffset() * MINUTE;
        let local = instant - offsetMs;
        let dayTime = ( (local % period) + period ) % period;
        for (let i = 0; i < s.length; i++) {
            let endTime = (i === s.length - 1) ? s[0].time + period : s[i + 1].time;
            if ( (s[i].time <= dayTime) && (dayTime < endTime) ) {
                return s[i];
            }
            if ( (s[i].time <= dayTime + period) && (dayTime + period < endTime) ) {
                return s[i];
            }
        }
        return null;
    };
}

function slotAt(schedule, instant) {
    return slotFinder(schedule)(instant);
}

/*
 * Each position's place: its first airing on air at `now` or after, walking
 * the lineup's cycle once from the airing on air. The airing on air counts as
 * not yet aired, so nothing is skipped.
 *
 * A lineup with labels is read by its labels alone: an airing without one was
 * placed or replaced by hand and never moves a position, and a repeat never
 * does either. A lineup with none - every channel saved before labels - is
 * read by slot: an airing counts for the slot it starts in when it is that
 * slot's show. Its Shuffle airings carry the old shuffler's number, and one
 * without a number was placed by hand.
 */
function readPlaces({ programs, startTime, now, schedule, getShowData }) {
    let places = new Map();
    let n = programs.length;
    let total = 0;
    for (let i = 0; i < n; i++) {
        total += programs[i].duration;
    }
    if ( (n === 0) || ! (total > 0) ) {
        return places;
    }
    let labelled = programs.some( (p) => typeof(p.slotPosition) === 'string' );
    let findSlot = slotFinder(schedule || {});

    let start = (typeof(startTime) === 'number') ? startTime : new Date(startTime).getTime();
    let into = ( ( (now - start) % total ) + total ) % total;
    let index = 0;
    let t = now - into;
    while (t + programs[index].duration <= now) {
        t += programs[index].duration;
        index++;
    }

    for (let step = 0; step < n; step++) {
        let program = programs[ (index + step) % n ];
        let found = placeOf(program, t, labelled, findSlot, schedule, getShowData);
        if ( (found !== null) && ! places.has(found.key) ) {
            places.set(found.key, {
                program: program,
                start: t,
                round: found.round,
                legacyShuffleOrder: found.legacyShuffleOrder,
            });
        }
        t += program.duration;
    }
    return places;
}

function placeOf(program, start, labelled, findSlot, schedule, getShowData) {
    if (program.isOffline) {
        return null;
    }
    let show = getShowData(program);
    if (! show.hasShow) {
        return null;
    }
    if (labelled) {
        let parsed = parseLabel(program.slotPosition);
        if ( (parsed === null) || (parsed.mode === 'repeat') ) {
            return null;
        }
        return {
            key: positionKey(show.showId, parsed.mode, { excludeSeasons: parsed.excluded }),
            round: parsed.round,
            legacyShuffleOrder: null,
        };
    }
    let slot = findSlot(start);
    if ( (slot === null) || (slot.showId !== show.showId) ) {
        return null;
    }
    let legacyShuffleOrder = null;
    if (slot.order === 'shuffle') {
        if (typeof(program.shuffleOrder) !== 'number') {
            return null;
        }
        legacyShuffleOrder = program.shuffleOrder;
    }
    return {
        key: positionKey(show.showId, slot.order, constraintOf(slot, schedule)),
        round: null,
        legacyShuffleOrder: legacyShuffleOrder,
    };
}

module.exports = {
    MODES: MODES,
    ROUND_MODES: ROUND_MODES,
    constraintOf: constraintOf,
    excludedOf: excludedOf,
    positionKey: positionKey,
    label: label,
    parseLabel: parseLabel,
    ref: ref,
    slotAt: slotAt,
    slotFinder: slotFinder,
    readPlaces: readPlaces,
};
