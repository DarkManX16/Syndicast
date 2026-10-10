/*
 * Rounds for Shuffle, Rerun and Ordered shuffle. Pure, shared by the
 * generators and the editor's planner.
 *
 * A round airs every story of a position once - a story being a single
 * episode or the parts of a multi-part one, see multi-part.js. Its order is the
 * stories sorted by a hash (orderHash) of the position key, the round number
 * and the story's first file, which doesn't depend on how many stories there are:
 * adding an episode or changing the range leaves the rest of the round where
 * it was. Whatever aired in the later half of a round goes after everything
 * else in the next, so no story comes back within half a round.
 *
 * A round carried over - from the old shuffler, or from the position a slot
 * belonged to before its range changed - is an explicit queue of episodes,
 * played in its own order first.
 *
 * See NOTES.md, Known issues, "Per-position stored progress, and the shuffles
 * built on it".
 */
const randomJS = require('random-js');

function fileKey(program) {
    let server = (typeof(program.serverKey) === 'undefined') ? 'unknown' : program.serverKey;
    let key = (typeof(program.key) === 'undefined') ? 'unknown' : program.key;
    return server + '|' + key;
}

// FNV-1a, 32 bits, over the string's UTF-16 code units.
function hash32(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

/*
 * The hash a round is ordered by: FNV-1a, then murmur3's 32-bit finaliser.
 * FNV-1a alone follows a string's last characters too closely - Plex keys run
 * in sequence ("/library/metadata/113716"), and ordering by it gave back
 * roughly the files' own order, a rank correlation of 0.8 - so its result is
 * mixed until every bit depends on every character.
 */
function orderHash(text) {
    let h = hash32(text);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

function storyKey(story) {
    return fileKey(story[0]);
}

function deferredIn(story, laterHalf) {
    return story.some( (p) => laterHalf.has(fileKey(p)) );
}

/*
 * A round's order: the stories that aired in the later half of the round
 * before (`laterHalf`, a set of file keys) go after all the others; within
 * each group, by hash, then by key.
 */
function roundOrder({ seed, round, stories, laterHalf }) {
    let later = (laterHalf instanceof Set) ? laterHalf : new Set(laterHalf || []);
    let keyed = stories.map( (story) => {
        let key = storyKey(story);
        return { story: story, late: deferredIn(story, later) ? 1 : 0, hash: orderHash(seed + '|' + round + '|' + key), key: key };
    } );
    keyed.sort( (a, b) => (a.late - b.late) || (a.hash - b.hash) || ( (a.key < b.key) ? -1 : (a.key > b.key) ? 1 : 0 ) );
    return keyed.map( (k) => k.story );
}

// The file keys of every episode in the later half of an order.
function laterHalfOf(order) {
    let keys = new Set();
    order.slice(order.length - Math.floor(order.length / 2)).forEach( (story) => {
        story.forEach( (p) => keys.add(fileKey(p)) );
    } );
    return keys;
}

function shuffleRange(array, lo, hi, r) {
    let currentIndex = hi, temporaryValue, randomIndex;
    while (lo !== currentIndex) {
        randomIndex = r.integer(lo, currentIndex - 1);
        currentIndex -= 1;
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }
    return array;
}

/*
 * One generation of the old shuffler - the order it aired a show's episodes in
 * before rounds replaced it - seeded from the show id and the generation
 * number over the episodes in their sorted order. Used once per position, to
 * finish the round it was in.
 *
 * What it built depended on the generation it started in, `startGeneration`
 * (by default the same one): started in generation 0 it shuffled its base
 * list twice, so every later generation came out differently from one built
 * by a shuffler started there. On channel 3, 153 of 1,172 Shuffle airings are
 * of the first kind.
 */
function legacyRound(sortedPrograms, showId, generation, startGeneration) {
    let started = (typeof(startGeneration) === 'number') ? startGeneration : generation;
    let n = sortedPrograms.length;
    let split = sortedPrograms.slice();
    let order = [];
    let init = (g) => {
        let seed = [];
        for (let i = 0; i < showId.length; i++) {
            seed.push(showId.charCodeAt(i));
        }
        seed.push(g);
        let r = new randomJS.Random(randomJS.MersenneTwister19937.seedWithArray(seed));
        if (g == 0) {
            shuffleRange(split, 0, n, r);
        }
        order = split.slice();
        let a = Math.floor(n / 2);
        shuffleRange(order, 0, a, r);
        shuffleRange(order, a, n, r);
    };
    init(0);
    init(started);
    if (generation !== started) {
        init(generation);
    }
    return order;
}

/*
 * The record that finishes the old shuffler's round from `position`: the
 * rest of that generation as a queue, and its later half to go last in the
 * round after. `orderOf` gives a program's order, for the references. When
 * the airing at `position` is known, the generation is built the way that
 * reproduces it - see legacyRound.
 */
function legacyCarry(sortedPrograms, showId, position, orderOf, airing) {
    let n = sortedPrograms.length;
    if (n === 0) {
        return { round: 0, deferred: [] };
    }
    let generation = Math.floor(position / n);
    let full = legacyRound(sortedPrograms, showId, generation);
    if ( (typeof(airing) === 'object') && (airing !== null) && (generation > 0)
         && (fileKey(full[position % n]) !== fileKey(airing)) ) {
        let fromZero = legacyRound(sortedPrograms, showId, generation, 0);
        if (fileKey(fromZero[position % n]) === fileKey(airing)) {
            full = fromZero;
        }
    }
    return {
        round: 0,
        queue: full.slice(position % n).map( (p) => ({ key: fileKey(p), order: orderOf(p) }) ),
        laterHalf: [ ...laterHalfOf( full.map( (p) => [ p ] ) ) ],
    };
}

/*
 * A position's airings, round by round, from its record:
 *   { round, queue, laterHalf } - a carried round: the queue's episodes in
 *     order (those still in range), then round + 1 with laterHalf last;
 *   { round, next, deferred }   - round `round`, with `deferred` (file keys)
 *     last, from the story holding `next`, or where it would sit if it's gone;
 *   { round }                    - the start of that round.
 * `current()` is the episode to air and its round; `next()` moves on, part by
 * part through a story.
 *
 * `eligible(story)`, when given, is asked as each story comes up: one that
 * isn't is passed over - it counts as aired this round and waits for a later
 * one - so the round's order never moves. Rerun uses it, asking afresh each
 * time, since what it may pick grows as its show's Play Next moves on.
 *
 * `deferAired`, for the same reason, takes the later half of what actually
 * aired in a round to go last in the next, rather than the later half of its
 * order - for a Shuffle the two are the same, for a Rerun that passes over
 * stories they are not. The record then also carries `aired`, the stories
 * already aired this round.
 */
function player({ seed, stories, record, eligible, deferAired }) {
    let where = new Map();
    stories.forEach( (story) => story.forEach( (p, part) => where.set(fileKey(p), { story: story, part: part }) ) );

    let round = 0;
    let order = [];
    let index = 0;
    let part = 0;
    let carried = null;
    let airedThisRound = [];

    let startRound = (r, laterHalf) => {
        round = r;
        order = roundOrder({ seed: seed, round: r, stories: stories, laterHalf: laterHalf });
        index = 0;
        part = 0;
        carried = null;
        airedThisRound = [];
    };

    // The round is over: the next one, with its later half last.
    let endRound = () => {
        let laterHalf = deferAired ? laterHalfOf(airedThisRound)
            : (carried !== null) ? carried
            : laterHalfOf(order);
        startRound(round + 1, laterHalf);
    };

    let rec = ( (typeof(record) === 'object') && (record !== null) ) ? record : {};
    let airedBefore = Array.isArray(rec.aired) ? rec.aired : [];
    let startAt = (typeof(rec.round) === 'number') ? rec.round : 0;
    if (Array.isArray(rec.queue)) {
        // A carried round plays episode by episode, in its own order.
        let seen = new Set();
        order = [];
        rec.queue.forEach( (r) => {
            let found = where.get(r.key);
            if ( (typeof(found) !== 'undefined') && ! seen.has(r.key) ) {
                seen.add(r.key);
                order.push( [ found.story[found.part] ] );
            }
        } );
        round = startAt;
        index = 0;
        part = 0;
        carried = new Set(rec.laterHalf || []);
        airedThisRound = [];
        if (order.length === 0) {
            endRound();
        }
    } else {
        startRound(startAt, new Set(rec.deferred || []));
        if ( (typeof(rec.next) === 'object') && (rec.next !== null) ) {
            let found = where.get(rec.next.key);
            if (typeof(found) !== 'undefined') {
                index = order.indexOf(found.story);
                part = found.part;
            } else {
                // Gone or now out of range: where it would sit in this round.
                let late = new Set(rec.deferred || []).has(rec.next.key) ? 1 : 0;
                let hash = orderHash(seed + '|' + round + '|' + rec.next.key);
                let deferred = new Set(rec.deferred || []);
                index = order.findIndex( (story) => {
                    let l = deferredIn(story, deferred) ? 1 : 0;
                    let h = orderHash(seed + '|' + round + '|' + storyKey(story));
                    return (l > late) || ( (l === late) && ( (h > hash) || ( (h === hash) && (storyKey(story) > rec.next.key) ) ) );
                } );
                part = 0;
                if (index === -1) {
                    endRound();
                }
            }
        }
    }
    if (deferAired && (airedThisRound.length === 0) && (airedBefore.length > 0) ) {
        airedBefore.forEach( (k) => {
            let found = where.get(k);
            if (typeof(found) !== 'undefined') {
                airedThisRound.push(found.story);
            }
        } );
    }

    // Pass over stories that aren't eligible, between stories only: a story
    // under way finishes. Bounded, in case nothing is eligible at all.
    let settle = () => {
        if ( (typeof(eligible) !== 'function') || (order.length === 0) || (part !== 0) ) {
            return;
        }
        let tries = 0;
        let limit = 3 * (stories.length + order.length) + 3;
        while (! eligible(order[index]) && (tries++ < limit) ) {
            index++;
            if (index >= order.length) {
                endRound();
            }
        }
    };

    return {
        current: () => {
            if (order.length === 0) {
                return null;
            }
            settle();
            return { program: order[index][part], round: round };
        },
        next: () => {
            if (order.length === 0) {
                return;
            }
            part++;
            if (part < order[index].length) {
                return;
            }
            part = 0;
            airedThisRound.push(order[index]);
            index++;
            if (index < order.length) {
                return;
            }
            endRound();
        },
    };
}

module.exports = {
    fileKey: fileKey,
    hash32: hash32,
    orderHash: orderHash,
    storyKey: storyKey,
    roundOrder: roundOrder,
    laterHalfOf: laterHalfOf,
    legacyRound: legacyRound,
    legacyCarry: legacyCarry,
    player: player,
};
