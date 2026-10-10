const random = require('../helperFuncs').random;
const getShowData = require("./get-show-data")();
const slotProgress = require('../slot-progress');
const randomJS = require("random-js");
const Random = randomJS.Random;



/****
 *
 *  Code shared by random slots and time slots for keeping track of the order
 * of episodes
 *
 **/
function shuffle(array, lo, hi, randomOverride ) {
    let r = randomOverride;
    if (typeof(r) === 'undefined') {
        r = random;
    }
    if (typeof(lo) === 'undefined') {
        lo = 0;
        hi = array.length;
    }
    let currentIndex = hi, temporaryValue, randomIndex
    while (lo !== currentIndex) {
        randomIndex =  r.integer(lo, currentIndex-1);
        currentIndex -= 1
        temporaryValue = array[currentIndex]
        array[currentIndex] = array[randomIndex]
        array[randomIndex] = temporaryValue
    }
    return array
}


const seasonOf = slotProgress.seasonOf;
const applySeasonExclusions = slotProgress.applySeasonExclusions;

/*
 * A season constraint is { excludeSeasons: [..], startSeason: n }, both
 * optional, and it comes from a slot rather than from a show. Only "Play Next"
 * honours it so far: the old shuffler seeds its permutation over the candidate
 * count and stores the resulting position on each program, so changing that
 * count silently changes what a saved position means.
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
 * The old shuffler, unchanged but for where it starts: a stored number when
 * the position has one, else the founder's, as before. Its permutation is
 * seeded over the candidate count, so the number means nothing once that count
 * changes; rounds kept by episode replace it.
 */
function oldShuffler(show, constraint, record) {
    if (typeof(show.programs) === 'undefined') {
        throw Error(show.id + " has no programs?")
    }

    let sorted = sortedPrograms(show);
    let n = sorted.length;

    let splitPrograms = [];
    let randomPrograms = [];

    for (let i = 0; i < n; i++) {
        splitPrograms.push( sorted[i] );
        randomPrograms.push( {} );
    }

    let showId = getShowData(show.programs[0]).showId;

    let position = ( (typeof(record) === 'object') && (record !== null) && (typeof(record.legacyShuffleOrder) === 'number') )
        ? record.legacyShuffleOrder
        : show.founder.shuffleOrder;
    if (typeof(position) === 'undefined') {
        position = 0;
    }

    let localRandom = null;

    let initGeneration = (generation) => {
        let seed = [];
        for (let i = 0 ; i < show.showId.length; i++) {
            seed.push( showId.charCodeAt(i) );
        }
        seed.push(generation);

        localRandom = new Random( randomJS.MersenneTwister19937.seedWithArray(seed) )

        if (generation == 0) {
            shuffle( splitPrograms, 0, n , localRandom );
        }
        for (let i = 0; i < n; i++) {
            randomPrograms[i] = splitPrograms[i];
        }
        let a = Math.floor(n / 2);
        shuffle( randomPrograms, 0, a,  localRandom );
        shuffle( randomPrograms, a, n,  localRandom );
    };
    initGeneration(0);
    let generation = Math.floor( position / n );
    initGeneration( generation );

    return {
        mode: 'shuffle',
        current : () => {
            let prog = JSON.parse(
                JSON.stringify(randomPrograms[position % n] )
            );
            delete prog.slotPosition;
            prog.shuffleOrder = position;
            prog.slotPosition = slotProgress.label('shuffle', constraint, Math.floor(position / n));
            return prog;
        },

        next: () => {
            position++;
            if (position % n == 0) {
                let generation = Math.floor( position / n );
                initGeneration( generation );
            }
        },
    };
}

/*
 * The positions of one generator run. Each starts from its record in
 * schedule.progress - written by the editor when Create Lineup runs, from the
 * lineup on air - and, with none, from the founder rule as before.
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
                    ? oldShuffler(show, constraint, record)
                    : playNext(show, constraint, record) );
            }
            return positions.get(key);
        },
    };
}

module.exports = {
    createPositions : createPositions,
}
