const getShowData = require("./get-show-data")();
const slotProgress = require('../slot-progress');
const rounds = require('../shuffle-rounds');
const multiPart = require('../multi-part');



/****
 *
 *  Code shared by random slots and time slots for keeping track of the order
 * of episodes
 *
 **/

const seasonOf = slotProgress.seasonOf;
const applySeasonExclusions = slotProgress.applySeasonExclusions;

/*
 * A season constraint is { excludeSeasons: [..], startSeason: n }, both
 * optional, and it comes from a slot rather than from a show. Every mode
 * honours the exclusions; startSeason is a seek, for Play Next.
 *
 * Which place a slot uses is its position - show, mode and excluded seasons,
 * see slotProgress.positionKey - so a weekday block advances as a single
 * thread while slots asking for different seasons each keep their own. The
 * season filter itself is slotProgress.applySeasonExclusions, shared with the
 * editor's planner.
 */
/*
 * Where to resume when a position has no stored place - every channel's first
 * run after stored progress, and Random Slots lineups saved before it.
 * startSeason is a one-off seek rather than a filter, so it chooses a position
 * and then the caller forgets it; earlier seasons stay reachable on later
 * passes.
 */
function resumePosition(candidates, founder, constraint) {
    if ( (typeof(constraint) === 'object') && (constraint !== null)
         && (typeof(constraint.startSeason) === 'number') ) {
        for (let i = 0; i < candidates.length; i++) {
            if ( seasonOf(candidates[i]) >= constraint.startSeason ) {
                return i;
            }
        }
        return 0;
    }
    if (typeof(founder) === 'undefined') {
        return 0;
    }
    let founderOrder = getShowData(founder).order;
    for (let i = 0; i < candidates.length; i++) {
        if ( getShowData(candidates[i]).order === founderOrder ) {
            return i;
        }
    }
    // The founder is not in this candidate list. There is one founder per show
    // but a show can carry several positions, so at most one of them can match
    // it - every other one lands here and resumes at the nearest episode its
    // own seasons allow. Wrap deliberately rather than letting a scan fall off
    // the end onto the finale.
    for (let i = 0; i < candidates.length; i++) {
        if ( getShowData(candidates[i]).order > founderOrder ) {
            return i;
        }
    }
    return 0;
}

function sortedPrograms(show) {
    let sorted = JSON.parse( JSON.stringify(show.programs) );
    sorted.sort((a, b) => {
        let showA = getShowData(a);
        let showB = getShowData(b);
        return showA.order - showB.order;
    });
    return sorted;
}

/*
 * The airing a position emits: its own copy, so a later edit to one airing can
 * never reach another, carrying its position's label and nothing a previous
 * lineup left on the program - in particular no Shuffle number on a Play Next
 * airing, which used to ride along from the old lineup and found the next
 * run's Shuffle at the wrong place.
 */
function labelled(program, text) {
    let copy = Object.assign( {}, program );
    delete copy.shuffleOrder;
    copy.slotPosition = text;
    return copy;
}

function playNext(show, constraint, record) {
    let candidates = applySeasonExclusions(sortedPrograms(show), constraint);
    let position = ( (typeof(record) === 'object') && (record !== null) && (typeof(record.next) === 'object') )
        ? slotProgress.resolveRef(record.next, candidates, getShowData)
        : resumePosition(candidates, show.founder, constraint);
    // Whether the position has gone round its range, for Rerun: everything it
    // covers has aired once it has.
    let wrapped = (typeof(record) === 'object') && (record !== null) && (record.wrapped === true);
    let text = slotProgress.label('next', constraint);
    return {
        mode: 'next',
        candidates: () => candidates,
        place: () => position,
        wrapped: () => wrapped,
        current: () => labelled(candidates[position], text),
        next: () => {
            position = (position + 1) % candidates.length;
            if (position === 0) {
                wrapped = true;
            }
        },
    };
}

/*
 * A Shuffle position: rounds of its stories, from its record - see
 * shuffle-rounds.js. A record written while the old shuffler still ran holds
 * just its number; that becomes the rest of the old round, played first.
 */
function shuffled(show, mode, constraint, record, key) {
    let candidates = applySeasonExclusions(sortedPrograms(show), constraint);
    let stories = (show.id === 'movie.') ? candidates.map( (p) => [ p ] ) : multiPart.stories(candidates);
    let start = record;
    if ( (typeof(record) === 'object') && (record !== null) && (typeof(record.legacyShuffleOrder) === 'number') ) {
        start = rounds.legacyCarry(sortedPrograms(show), show.id, record.legacyShuffleOrder, (p) => getShowData(p).order);
    }
    let player = rounds.player({ seed: key, stories: stories, record: start });
    return {
        mode: mode,
        current: () => {
            let c = player.current();
            return (c === null) ? null : labelled(c.program, slotProgress.label(mode, constraint, c.round));
        },
        next: () => player.next(),
    };
}

/*
 * The positions of one generator run. Each starts from its record in
 * schedule.progress - written by the editor when Create Lineup runs, from the
 * lineup on air - and, with none, a Play Next position from the founder rule
 * as before, a Shuffle one from the start of its first round.
 *
 * `shows` is the services' list: each with its `id`, `programs` and `founder`.
 */
function createPositions({ shows, schedule }) {
    let byId = new Map();
    shows.forEach( (show) => byId.set(show.id, show) );
    let records = ( (typeof(schedule) === 'object') && (schedule !== null)
                    && (typeof(schedule.progress) === 'object') && (schedule.progress !== null)
                    && (typeof(schedule.progress.positions) === 'object') && (schedule.progress.positions !== null) )
        ? schedule.progress.positions
        : {};
    let positions = new Map();
    return {
        forSlot: (slot) => {
            let constraint = slotProgress.constraintOf(slot, schedule);
            let key = slotProgress.positionKey(slot.showId, slot.order, constraint);
            if (! positions.has(key) ) {
                let show = byId.get(slot.showId);
                let record = records[key];
                positions.set(key, (slot.order === 'shuffle')
                    ? shuffled(show, slot.order, constraint, record, key)
                    : playNext(show, constraint, record) );
            }
            return positions.get(key);
        },
    };
}

module.exports = {
    createPositions : createPositions,
}
