/*
 * The show catalogs a re-lay read from Plex, kept for the next re-lay while
 * the channel editor is open: a swap re-lays two or three times, and reading
 * all 160 of channel 2's shows again each time was 13 s of every one. Kept
 * for `maxAge` from the first read; a show that could not be read is asked
 * for again. Create Lineup reads afresh, as it always has.
 */
function keeper({ maxAge }) {
    let kept = null;
    let since = 0;
    return {
        // The catalogs to read into: the kept ones while fresh, else a new, empty set.
        catalogs: (now) => {
            if ( (kept === null) || (now - since > maxAge) ) {
                kept = {};
                since = now;
            }
            Object.keys(kept).forEach( (id) => {
                let c = kept[id];
                if ( (c !== null) && (typeof(c) === 'object') && ! Array.isArray(c) && c.error ) {
                    delete kept[id];
                }
            } );
            return kept;
        },
        // Catalogs read afresh (Create Lineup) replace the kept ones.
        keep: (catalogs, now) => {
            if (catalogs !== kept) {
                kept = catalogs;
                since = now;
            }
        },
        clear: () => {
            kept = null;
        },
    };
}

module.exports = { keeper };
