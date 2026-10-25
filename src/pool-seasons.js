/*
 * Each show's seasons in a pool - what a Time Slots slot can leave out -
 * worked out once per pool. The schedule editor asks for every slot on every
 * redraw (canConstrainSeasons); scanning the whole pool for each, with full
 * catalogs (14,347 items, 335 slots on channel 2), took 2.4 s a redraw and
 * froze the page while a swap re-laid the lineup.
 */

// showId -> its seasons, sorted; an episode with no season counts as 0.
function seasonsByShow(pool, getShowData) {
    let found = new Map();
    for (let i = 0; i < pool.length; i++) {
        let p = pool[i];
        if (p.type !== 'episode') {
            continue;
        }
        let id = getShowData(p).showId;
        if (! found.has(id)) {
            found.set(id, new Set());
        }
        found.get(id).add( (typeof(p.season) === 'number') ? p.season : 0 );
    }
    let out = new Map();
    found.forEach( (seasons, id) => out.set(id, [ ...seasons ].sort( (a, b) => a - b )) );
    return out;
}

// (pool, showId) -> seasons, worked out again only when the pool is a different array.
function memo(getShowData) {
    let pool = null;
    let byShow = new Map();
    return (available, showId) => {
        if (available !== pool) {
            pool = available;
            byShow = seasonsByShow(available, getShowData);
        }
        return byShow.get(showId) || [];
    };
}

module.exports = { seasonsByShow, memo };
