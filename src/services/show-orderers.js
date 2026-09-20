const random = require('../helperFuncs').random;
const getShowData = require("./get-show-data")();
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


function seasonOf(program) {
    return (typeof(program.season) === 'number') ? program.season : 0;
}

/*
 * A season constraint is { excludeSeasons: [..], startSeason: n }, both
 * optional. Only "Play Next" honours it: shuffle seeds its permutation over the
 * candidate count and stores the resulting position on each program, so
 * changing that count silently changes what a saved position means.
 */
function applySeasonExclusions(sortedPrograms, constraint) {
    if ( (typeof(constraint) !== 'object') || (constraint === null) ) {
        return sortedPrograms;
    }
    if (! Array.isArray(constraint.excludeSeasons) ) {
        return sortedPrograms;
    }
    let excluded = {};
    constraint.excludeSeasons.forEach( (s) => { excluded[s] = true; } );
    let kept = sortedPrograms.filter( (p) => excluded[ seasonOf(p) ] !== true );
    // Excluding everything would leave the slot with nothing to play, which is
    // worse than ignoring a constraint the user can see and change.
    return (kept.length === 0) ? sortedPrograms : kept;
}

/*
 * Where to resume. startSeason is a one-off seek rather than a filter, so it
 * chooses a position and then the caller forgets it; earlier seasons stay
 * reachable on later passes.
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
    // The founder is gone, usually because its season was excluded. Take the
    // nearest surviving episode forward, and wrap deliberately rather than
    // letting a scan fall off the end onto the finale.
    for (let i = 0; i < candidates.length; i++) {
        if ( getShowData(candidates[i]).order > founderOrder ) {
            return i;
        }
    }
    return 0;
}

function getShowOrderer(show, constraint) {
    if (typeof(show.orderer) === 'undefined') {

        let sortedPrograms = JSON.parse( JSON.stringify(show.programs) );
        sortedPrograms.sort((a, b) => {
            let showA = getShowData(a);
            let showB = getShowData(b);
            return showA.order - showB.order;
        });

        let candidates = applySeasonExclusions(sortedPrograms, constraint);
        let position = resumePosition(candidates, show.founder, constraint);

        show.orderer = {

            current : () => {
                return candidates[position];
            },

            next: () => {
                position = (position + 1) % candidates.length;
            },

        }
    }
    return show.orderer;
}


function getShowShuffler(show) {
    if (typeof(show.shuffler) === 'undefined') {
        if (typeof(show.programs) === 'undefined') {
            throw Error(show.id + " has no programs?")
        }

        let sortedPrograms = JSON.parse( JSON.stringify(show.programs) );
        sortedPrograms.sort((a, b) => {
            let showA = getShowData(a);
            let showB = getShowData(b);
            return showA.order - showB.order;
        });
        let n = sortedPrograms.length;

        let splitPrograms = [];
        let randomPrograms = [];

        for (let i = 0; i < n; i++) {
            splitPrograms.push( sortedPrograms[i] );
            randomPrograms.push( {} );
        }

     
        let showId = getShowData(show.programs[0]).showId;

        let position = show.founder.shuffleOrder;
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
        
        show.shuffler  = {

            current : () => {
                let prog = JSON.parse(
                    JSON.stringify(randomPrograms[position % n] )
                );
                prog.shuffleOrder = position;
                return prog;
            },

            next: () => {
                position++;
                if (position % n == 0) {
                    let generation = Math.floor( position / n );
                    initGeneration( generation );
                }
            },

        }
    }
    return show.shuffler;
}

module.exports = {
    getShowOrderer : getShowOrderer,
    getShowShuffler: getShowShuffler,
}