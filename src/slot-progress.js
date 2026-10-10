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

const rounds = require('./shuffle-rounds');
const multiPart = require('./multi-part');

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

function seasonOf(program) {
    return (typeof(program.season) === 'number') ? program.season : 0;
}

/*
 * A position's episodes: its show's, sorted, without the seasons it leaves
 * out. Excluding everything would leave the slot with nothing to play, which
 * is worse than ignoring a constraint the user can see and change.
 */
function applySeasonExclusions(sortedPrograms, constraint) {
    let excluded = {};
    excludedOf(constraint).forEach( (s) => { excluded[s] = true; } );
    let kept = sortedPrograms.filter( (p) => excluded[ seasonOf(p) ] !== true );
    return (kept.length === 0) ? sortedPrograms : kept;
}

function candidatesFor(pool, showId, constraint, getShowData) {
    let sorted = pool
        .filter( (p) => ! p.isOffline && (getShowData(p).showId === showId) )
        .sort( (a, b) => getShowData(a).order - getShowData(b).order );
    return applySeasonExclusions(sorted, constraint);
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
    return { key: rounds.fileKey(program), order: getShowData(program).order };
}

/*
 * Where a reference sits in a position's candidates, sorted by order: the
 * same file when it is still there, wherever the custom show or range has
 * moved it; otherwise the first episode at or after its order, which is the
 * next one along; past the end, the first, as a Play Next position wraps.
 */
function resolveRef(refValue, sortedCandidates, getShowData) {
    for (let i = 0; i < sortedCandidates.length; i++) {
        if (ref(sortedCandidates[i], getShowData).key === refValue.key) {
            return i;
        }
    }
    for (let i = 0; i < sortedCandidates.length; i++) {
        if (getShowData(sortedCandidates[i]).order >= refValue.order) {
            return i;
        }
    }
    return 0;
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
 * A position's season start, when one of its slots asks for one: a one-time
 * move of the position's place. If its slots ask for different seasons, the
 * one whose slot next starts after `now` wins - the seek that would take
 * effect first.
 */
function seekOf(slots, schedule, now) {
    let period = (typeof(schedule.period) === 'number') ? schedule.period : DAY;
    let local = now - (new Date(now)).getTimezoneOffset() * MINUTE;
    let into = ( (local % period) + period ) % period;
    let best = null;
    let bestWait = Infinity;
    slots.forEach( (slot) => {
        if ( (typeof(slot.seasons) !== 'object') || (slot.seasons === null)
             || (typeof(slot.seasons.startSeason) !== 'number') ) {
            return;
        }
        let wait = ( (slot.time - into) % period + period ) % period;
        if (wait < bestWait) {
            bestWait = wait;
            best = slot.seasons.startSeason;
        }
    } );
    return best;
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
    let total = cycleLength(programs);
    if (! (total > 0) ) {
        return places;
    }
    let found = airings({ programs, startTime, from: now, to: now + total, schedule, getShowData });
    for (let i = 0; i < found.length; i++) {
        let a = found[i];
        if ( (a.key !== null) && ! places.has(a.key) ) {
            places.set(a.key, {
                program: a.program,
                start: a.start,
                round: a.round,
                legacyShuffleOrder: a.legacyShuffleOrder,
            });
        }
    }
    return places;
}

function cycleLength(programs) {
    let total = 0;
    for (let i = 0; i < programs.length; i++) {
        total += programs[i].duration;
    }
    return total;
}

/*
 * Every airing on air at any point in [from, to), in order, with the
 * position it counts for - `key` is null for one that counts for none: Flex,
 * a hand-placed airing, a repeat, another show sitting in a slot. The lineup
 * loops, so the window may start or run anywhere in its cycle.
 */
function airings({ programs, startTime, from, to, schedule, getShowData }) {
    let out = [];
    let n = programs.length;
    let total = cycleLength(programs);
    if ( (n === 0) || ! (total > 0) ) {
        return out;
    }
    let labelled = programs.some( (p) => typeof(p.slotPosition) === 'string' );
    let findSlot = slotFinder(schedule || {});

    let start = (typeof(startTime) === 'number') ? startTime : new Date(startTime).getTime();
    let into = ( ( (from - start) % total ) + total ) % total;
    let index = 0;
    let t = from - into;
    while (t + programs[index].duration <= from) {
        t += programs[index].duration;
        index++;
    }
    while (t < to) {
        let program = programs[index];
        if (! program.isOffline) {
            let found = placeOf(program, t, labelled, findSlot, schedule, getShowData);
            out.push({
                start: t,
                program: program,
                key: (found === null) ? null : found.key,
                round: (found === null) ? null : found.round,
                legacyShuffleOrder: (found === null) ? null : found.legacyShuffleOrder,
            });
        }
        t += program.duration;
        index = (index + 1) % n;
    }
    return out;
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
        // The old shuffler labels its airings and still numbers them; nothing
        // else leaves a number on a labelled airing, so one here is its.
        return {
            key: positionKey(show.showId, parsed.mode, { excludeSeasons: parsed.excluded }),
            round: parsed.round,
            legacyShuffleOrder: ( (parsed.mode === 'shuffle') && (typeof(program.shuffleOrder) === 'number') )
                ? program.shuffleOrder
                : null,
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

/*
 * Every position's place as Create Lineup runs, as the records the generator
 * starts from (schedule.progress). In order, the first that applies:
 *
 *   1. a seek on one of its slots - season start today;
 *   2. its first airing on air or ahead in the lineup on air;
 *   3. its record from the last run, for a position with none ahead;
 *   4. the place of the position the same slot - same time, show and mode -
 *      belonged to in the schedule the lineup was made from, moved forward to
 *      the nearest episode its range allows (Ron, Oct 9);
 *   5. the first episode of its range, for a position the schedule never had.
 *
 * A position the schedule already had but whose place can't be read gets no
 * record, so the generator falls back to the founder rule - never below what
 * a regeneration did before stored progress. So do Random Slots positions in
 * a lineup without labels: their slots have no times to match. Until rounds
 * replace the old shuffler, a Shuffle position's record is just its number.
 * Positions no longer used keep a record, refreshed from the lineup when it
 * still has their airings.
 */
function planProgress({ programs, startTime, now, openedSchedule, schedule, pool, getShowData }) {
    let opened = ( (typeof(openedSchedule) === 'object') && (openedSchedule !== null) ) ? openedSchedule : { slots: [] };
    let oldRecords = ( (typeof(opened.progress) === 'object') && (opened.progress !== null)
                       && (typeof(opened.progress.positions) === 'object') && (opened.progress.positions !== null) )
        ? opened.progress.positions
        : {};
    let lastRun = ( (typeof(opened.progress) === 'object') && (opened.progress !== null) )
        ? Date.parse(opened.progress.asOf)
        : NaN;
    let readWith = (Array.isArray(opened.slots) && (opened.slots.length > 0)) ? opened : schedule;
    let start = (typeof(startTime) === 'number') ? startTime : new Date(startTime).getTime();
    let places = readPlaces({ programs, startTime: start, now, schedule: readWith, getShowData });
    let labelled = programs.some( (p) => typeof(p.slotPosition) === 'string' );
    let total = cycleLength(programs);

    let groupsOf = (sched) => {
        let groups = new Map();
        (Array.isArray(sched.slots) ? sched.slots : []).forEach( (slot) => {
            if ( (typeof(slot.showId) !== 'string') || (slot.showId === 'flex.') || slot.showId.startsWith('redirect.') ) {
                return;
            }
            let constraint = constraintOf(slot, sched);
            let key = positionKey(slot.showId, slot.order, constraint);
            if (! groups.has(key) ) {
                groups.set(key, { showId: slot.showId, mode: slot.order, constraint: constraint, slots: [] });
            }
            groups.get(key).slots.push(slot);
        } );
        return groups;
    };
    let groups = groupsOf(schedule);
    let oldGroups = groupsOf(opened);

    // Whether a Play Next position went round its range between the last run
    // and now: its episodes' order going down at any step. Only a lineup made
    // at the last run says what aired since; a carried-over one doesn't.
    let wrappedSince = (key, place) => {
        let prior = oldRecords[key];
        if ( (typeof(prior) === 'object') && (prior !== null) && (prior.wrapped === true) ) {
            return true;
        }
        if ( ! labelled || isNaN(lastRun) || (lastRun >= now) ) {
            return false;
        }
        if (now - lastRun >= total) {
            return true;
        }
        let orders = [];
        if ( (typeof(prior) === 'object') && (prior !== null) && (typeof(prior.next) === 'object') ) {
            orders.push(prior.next.order);
        }
        airings({ programs, startTime: start, from: lastRun, to: now, schedule: readWith, getShowData })
            .filter( (a) => a.key === key )
            .forEach( (a) => orders.push(getShowData(a.program).order) );
        orders.push(getShowData(place.program).order);
        for (let i = 1; i < orders.length; i++) {
            if (orders[i] < orders[i - 1]) {
                return true;
            }
        }
        return false;
    };

    let isRecord = (value) => (typeof(value) === 'object') && (value !== null);

    // A position's candidates as its rounds see them: stories, with movies
    // outside custom shows left single.
    let storiesFor = (showId, constraint) => {
        let candidates = candidatesFor(pool, showId, constraint, getShowData);
        return (showId === 'movie.') ? candidates.map( (p) => [ p ] ) : multiPart.stories(candidates);
    };

    // The deferred stories of `round`, from the record of the last run: its
    // own when the round is the same, else the later half of each round since,
    // rebuilt in order - the generator laid those rounds out from that record.
    let deferredFor = (key, stories, prior, round) => {
        if ( ! isRecord(prior) || (typeof(prior.round) !== 'number') || (prior.round > round) || (round - prior.round > 1000) ) {
            return new Set();
        }
        if (prior.round === round) {
            return Array.isArray(prior.queue) ? new Set() : new Set(prior.deferred || []);
        }
        let later = Array.isArray(prior.queue)
            ? new Set(prior.laterHalf || [])
            : rounds.laterHalfOf( rounds.roundOrder({ seed: key, round: prior.round, stories: stories, laterHalf: new Set(prior.deferred || []) }) );
        for (let r = prior.round + 1; r < round; r++) {
            later = rounds.laterHalfOf( rounds.roundOrder({ seed: key, round: r, stories: stories, laterHalf: later }) );
        }
        return later;
    };

    /*
     * A shuffle-family position's record from its place. An airing of the old
     * shuffler carries its number: the rest of that round is reproduced over
     * the show's whole sorted list, since the old shuffler ignored seasons. A
     * labelled airing gives its round; inside a carried round, the rest of the
     * queue from it.
     */
    let roundRecord = (key, place) => {
        let [ showId, , excluded ] = JSON.parse(key);
        if (typeof(place.legacyShuffleOrder) === 'number') {
            return rounds.legacyCarry(candidatesFor(pool, showId, undefined, getShowData), showId,
                place.legacyShuffleOrder, (p) => getShowData(p).order, place.program);
        }
        if (typeof(place.round) !== 'number') {
            return null;
        }
        let prior = oldRecords[key];
        let here = rounds.fileKey(place.program);
        if ( isRecord(prior) && Array.isArray(prior.queue) && (prior.round === place.round) ) {
            let i = prior.queue.findIndex( (r) => r.key === here );
            if (i !== -1) {
                return { round: place.round, queue: prior.queue.slice(i), laterHalf: (prior.laterHalf || []).slice() };
            }
        }
        let stories = storiesFor(showId, { excludeSeasons: excluded });
        return {
            round: place.round,
            next: ref(place.program, getShowData),
            deferred: [ ...deferredFor(key, stories, prior, place.round) ],
        };
    };

    /*
     * A Rerun's record also says what it has aired this round, since what
     * goes last in its next round is the later half of what it actually aired
     * (it passes over what its strip hasn't reached). Rebuilt from the record
     * of the last run and the position's airings in the lineup since: a story
     * counts once its last part has aired.
     */
    let rerunRecord = (key, place) => {
        let [ showId, , excluded ] = JSON.parse(key);
        let prior = oldRecords[key];
        let stories = storiesFor(showId, { excludeSeasons: excluded });
        let storyOf = new Map();
        stories.forEach( (story) => story.forEach( (p, part) => storyOf.set(rounds.fileKey(p), { story: story, last: part === story.length - 1 }) ) );
        let byKey = new Map();
        stories.forEach( (story) => byKey.set(rounds.storyKey(story), story) );

        let airedIn = new Map();
        if ( labelled && ! isNaN(lastRun) && (lastRun < now) ) {
            airings({ programs, startTime: start, from: lastRun, to: now, schedule: readWith, getShowData })
                .filter( (a) => (a.key === key) && (a.start + a.program.duration <= now) )
                .forEach( (a) => {
                    let found = storyOf.get(rounds.fileKey(a.program));
                    let round = parseLabel(a.program.slotPosition).round;
                    if ( (typeof(found) === 'undefined') || ! found.last ) {
                        return;
                    }
                    if (! airedIn.has(round)) {
                        airedIn.set(round, []);
                    }
                    airedIn.get(round).push(rounds.storyKey(found.story));
                } );
        }
        let listOf = (r) => {
            let list = (airedIn.get(r) || []).slice();
            if ( isRecord(prior) && (prior.round === r) && Array.isArray(prior.aired) ) {
                list = prior.aired.concat(list);
            }
            return list;
        };
        let laterHalfOfKeys = (keys) => rounds.laterHalfOf( keys.map( (k) => byKey.get(k) ).filter( (st) => typeof(st) !== 'undefined' ) );

        let round = place.round;
        let deferred;
        if ( isRecord(prior) && (prior.round === round) ) {
            deferred = new Set(prior.deferred || []);
        } else {
            let from = ( isRecord(prior) && (typeof(prior.round) === 'number') && (prior.round < round) ) ? prior.round : round - 1;
            deferred = new Set();
            for (let r = from; r < round; r++) {
                deferred = laterHalfOfKeys(listOf(r));
            }
        }
        return { round: round, next: ref(place.program, getShowData), deferred: [ ...deferred ], aired: listOf(round) };
    };

    let fromPlace = (key, place) => {
        let mode = JSON.parse(key)[1];
        if ( (mode === 'rerun') && (typeof(place.round) === 'number') && ! ( isRecord(oldRecords[key]) && Array.isArray(oldRecords[key].queue) && (oldRecords[key].round === place.round) ) ) {
            return rerunRecord(key, place);
        }
        if (ROUND_MODES.indexOf(mode) !== -1) {
            return roundRecord(key, place);
        }
        return { next: ref(place.program, getShowData), wrapped: wrappedSince(key, place) };
    };

    // The rest of an old shuffle-family position's round, in its order, as
    // episode references, with the later half that goes last after it.
    let restOfRound = (oldKey, record) => {
        if (Array.isArray(record.queue)) {
            return { refs: record.queue, laterHalf: record.laterHalf || [] };
        }
        if (typeof(record.round) !== 'number') {
            return null;
        }
        let [ showId, , excluded ] = JSON.parse(oldKey);
        let order = rounds.roundOrder({ seed: oldKey, round: record.round,
            stories: storiesFor(showId, { excludeSeasons: excluded }), laterHalf: new Set(record.deferred || []) });
        let start = 0;
        let part = 0;
        if (isRecord(record.next)) {
            let i = order.findIndex( (story) => story.some( (p) => rounds.fileKey(p) === record.next.key ) );
            if (i !== -1) {
                start = i;
                part = order[i].findIndex( (p) => rounds.fileKey(p) === record.next.key );
            }
        }
        let refs = [];
        order.slice(start).forEach( (story, j) => {
            story.slice( (j === 0) ? part : 0 ).forEach( (p) => refs.push( ref(p, getShowData) ) );
        } );
        return { refs: refs, laterHalf: [ ...rounds.laterHalfOf(order) ] };
    };

    // Where an old position is now, by the same rules 2 and 3.
    let placeOfOld = (key) => {
        if (places.has(key)) {
            return fromPlace(key, places.get(key));
        }
        return oldRecords[key] || null;
    };

    let nextStartAfterNow = (slot) => {
        let period = (typeof(schedule.period) === 'number') ? schedule.period : DAY;
        let local = now - (new Date(now)).getTimezoneOffset() * MINUTE;
        let into = ( (local % period) + period ) % period;
        return ( (slot.time - into) % period + period ) % period;
    };

    let inherited = (key, group) => {
        let best = null;
        let bestWait = Infinity;
        group.slots.forEach( (slot) => {
            if (typeof(slot.time) !== 'number') {
                return;
            }
            let old = (opened.slots || []).find( (o) => (o.time === slot.time) && (o.showId === slot.showId) );
            if ( (typeof(old) === 'undefined') || (old.order !== slot.order) ) {
                return;
            }
            let oldKey = positionKey(old.showId, old.order, constraintOf(old, opened));
            if (oldKey === key) {
                return;
            }
            let oldPlace = placeOfOld(oldKey);
            if ( ! isRecord(oldPlace) || ( ! isRecord(oldPlace.next) && ! Array.isArray(oldPlace.queue) ) ) {
                return;
            }
            let wait = nextStartAfterNow(slot);
            if (wait < bestWait) {
                bestWait = wait;
                best = { key: oldKey, record: oldPlace };
            }
        } );
        if (best === null) {
            return null;
        }
        let candidates = candidatesFor(pool, group.showId, group.constraint, getShowData);
        if (candidates.length === 0) {
            return null;
        }
        if (ROUND_MODES.indexOf(group.mode) !== -1) {
            // The rest of the old round, without what the new range leaves out.
            let rest = restOfRound(best.key, best.record);
            if (rest === null) {
                return null;
            }
            let inRange = new Set( candidates.map( (p) => rounds.fileKey(p) ) );
            return {
                round: (typeof(best.record.round) === 'number') ? best.record.round : 0,
                queue: rest.refs.filter( (r) => inRange.has(r.key) ),
                laterHalf: rest.laterHalf.filter( (k) => inRange.has(k) ),
            };
        }
        if (! isRecord(best.record.next) ) {
            return null;
        }
        return { next: ref(candidates[ resolveRef(best.record.next, candidates, getShowData) ], getShowData), wrapped: false };
    };

    let positions = {};
    Object.keys(oldRecords).forEach( (key) => { positions[key] = oldRecords[key]; } );
    places.forEach( (place, key) => {
        if (! groups.has(key) ) {
            let record = fromPlace(key, place);
            if (record !== null) {
                positions[key] = record;
            }
        }
    } );

    groups.forEach( (group, key) => {
        let record = null;
        if (places.has(key)) {
            record = fromPlace(key, places.get(key));
        }
        if ( (record === null) && (typeof(oldRecords[key]) === 'object') ) {
            record = oldRecords[key];
        }
        let timed = group.slots.some( (slot) => typeof(slot.time) === 'number' );
        let rounded = ROUND_MODES.indexOf(group.mode) !== -1;
        if ( (record === null) && timed && ( (group.mode === 'next') || rounded ) ) {
            record = inherited(key, group);
        }
        if ( (record === null) && timed && ( (group.mode === 'next') || rounded ) && ! oldGroups.has(key) ) {
            let candidates = candidatesFor(pool, group.showId, group.constraint, getShowData);
            if (candidates.length > 0) {
                record = rounded ? { round: 0, deferred: [] } : { next: ref(candidates[0], getShowData), wrapped: false };
            }
        }
        if (group.mode === 'next') {
            let seek = seekOf(group.slots, schedule, now);
            if (seek !== null) {
                let candidates = candidatesFor(pool, group.showId, group.constraint, getShowData);
                let found = candidates.find( (p) => seasonOf(p) >= seek ) || candidates[0];
                if (typeof(found) !== 'undefined') {
                    record = { next: ref(found, getShowData), wrapped: (record !== null) && (record.wrapped === true) };
                }
            }
        }
        if (record !== null) {
            positions[key] = record;
        } else {
            delete positions[key];
        }
    } );

    return { asOf: new Date(now).toISOString(), positions: positions };
}

/*
 * What the editor says under a Rerun slot that will play as a Shuffle for
 * now, or null when it reruns as asked. `progress` is the planner's answer
 * for the lineup on air: its records say where each of the show's Play Next
 * positions is. The generator decides the same way, as it goes - see
 * createPositions in show-orderers.js.
 */
function rerunNote({ schedule, progress, slot, pool, getShowData }) {
    let showId = slot.showId;
    let records = ( (typeof(progress) === 'object') && (progress !== null) && (typeof(progress.positions) === 'object') )
        ? progress.positions
        : {};
    let any = (Array.isArray(schedule.slots) ? schedule.slots : [])
        .some( (s) => (s.showId === showId) && (s.order === 'next') );
    let aired = new Set();
    Object.keys(records).forEach( (key) => {
        let [ sid, mode, excluded ] = JSON.parse(key);
        let record = records[key];
        if ( (sid !== showId) || (mode !== 'next') || (typeof(record) !== 'object') || (record === null) || (typeof(record.next) !== 'object') ) {
            return;
        }
        any = true;
        let candidates = candidatesFor(pool, showId, { excludeSeasons: excluded }, getShowData);
        let place = resolveRef(record.next, candidates, getShowData);
        (record.wrapped === true ? candidates : candidates.slice(0, place)).forEach( (p) => aired.add(rounds.fileKey(p)) );
    } );
    if (! any) {
        return "Plays as a Shuffle: this show has no Play Next slot, so there is nothing for a Rerun to stay behind.";
    }
    let range = candidatesFor(pool, showId, constraintOf(slot, schedule), getShowData);
    if (! range.some( (p) => aired.has(rounds.fileKey(p)) ) ) {
        return "Plays as a Shuffle for now: this show's Play Next hasn't aired any of these seasons yet. "
             + "Once it has, this slot reruns only episodes it has aired.";
    }
    return null;
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
    resolveRef: resolveRef,
    slotAt: slotAt,
    slotFinder: slotFinder,
    seekOf: seekOf,
    readPlaces: readPlaces,
    airings: airings,
    seasonOf: seasonOf,
    applySeasonExclusions: applySeasonExclusions,
    candidatesFor: candidatesFor,
    planProgress: planProgress,
    rerunNote: rerunNote,
};
