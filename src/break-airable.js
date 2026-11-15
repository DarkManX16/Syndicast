/*
 * Which points of a file may air (docs/blocks-spec.md, Stage 6, "The Midrolls switch,
 * and approved automatically"; build order 5a), pure: the one answer every midroll
 * reader asks. A person's choices win, in this order:
 *   1. his point decisions: a break he placed (`hand`) or approved or moved airs, one
 *      he rejected never does;
 *   2. an episode marked "no breaks", or a movie marked theatrical: nothing else airs;
 *   3. his click on the show: Approve airs what its pattern approved (the opening
 *      included; the midroll setting decides whether openings play), and a remembered
 *      Withdraw (`show.withdrawn`) airs nothing more;
 *   4. otherwise, automatic approval (patterns.autoApproval): never the opening, never
 *      a movie.
 * Returns [{ index, at, kind, by: 'hand' | 'owner' | 'pattern' | 'auto' }] in time
 * order, `index` the point's place in record.points. Nothing is written.
 * Options: `isMovie` (the show key is a movie's), `auto` (autoApproval(show) already
 * worked out, when one show's files are asked about one after another).
 */
const patterns = require('./break-patterns');

function airablePoints(show, path, { isMovie = false, auto = null } = {}) {
    const record = (show.files || {})[path];
    if ( (record == null) || (record.error != null) || ! Array.isArray(record.points) ) {
        return [];
    }
    const clicked = (show.pattern != null);
    const blocked = (record.noBreaks === true) || (record.theatrical === true) || (show.theatrical === true);
    const automatic = ! clicked && ! blocked && (show.withdrawn == null) && ! isMovie && (record.movie !== true);
    const a = automatic ? (auto || patterns.autoApproval(show, { isMovie })) : null;
    const autoIndex = new Set( automatic ? patterns.autoPoints(a, record).map( (p) => p.index ) : [] );
    const out = [];
    for (const p of patterns.readPoints(clicked ? show.pattern : (a || { groups: [] }), record)) {
        let by = null;
        if (p.status === 'hand') {
            by = 'hand';
        } else if (p.status === 'rejected') {
            by = null;
        } else if ( (p.status === 'approved') && (p.approvedBy !== 'pattern') ) {
            by = 'owner';
        } else if (blocked) {
            by = null;
        } else if ( (p.status === 'approved') && clicked ) {
            by = 'pattern';
        } else if ( (p.status === 'found') && autoIndex.has(p.index) ) {
            by = 'auto';
        }
        if (by !== null) {
            out.push( { index: p.index, at: p.at, kind: p.kind, by } );
        }
    }
    return out;
}

module.exports = { airablePoints };
