/*
 * DarkManX16's own say on a file's break points (docs/blocks-spec.md, Stage 6,
 * "Show patterns, and approving", the per-point actions), pure: a record in,
 * the same record changed. Nothing here reads a file or the clock; the caller
 * saves the show.
 *
 * Whatever he does is marked `approvedBy: 'owner'`, so a pattern's withdraw and
 * a later episode's pattern approval leave it alone (they touch only `found`
 * points, and approved ones marked 'pattern'):
 *   approve   the point airs                          status 'approved'
 *   reject    it never airs, and a rescan does not    status 'rejected'
 *             offer it again (a hand point just goes)
 *   nudge     moved by seconds, which approves it     keeps `foundAt`, the measured time
 *   time      moved to a typed time, same
 *   kind      relabelled
 *   add       a break he places himself               status 'hand'
 */

const KINDS = [ 'opening', 'act', 'story', 'credits' ];

const fail = (error) => ({ ok: false, error });

function lengthS(record) {
    return (record.durationMs > 0) ? record.durationMs / 1000 : Infinity;
}

// A black that no longer holds the point (a nudge past it) says nothing about the new place.
function trimBlack(p) {
    if ( (p.black != null) && ! ( (p.at >= p.black[0]) && (p.at <= p.black[1]) ) ) {
        p.black = null;
        p.silence = null;
    }
    // a file sent out without re-encoding starts on a keyframe: the old one is for the old place
    p.keyframe = null;
}

function moveTo(record, p, at) {
    if ( ! Number.isFinite(at) || (at < 0) || (at > lengthS(record)) ) {
        return fail('that time is outside the episode');
    }
    if (p.foundAt == null) {
        p.foundAt = p.at;
    }
    p.at = at;
    trimBlack(p);
    if (p.status !== 'hand') {
        p.status = 'approved';
        p.approvedBy = 'owner';
    }
    return { ok: true };
}

/*
 * action: 'approve' | 'reject' | 'nudge' (arg: seconds, + or -) | 'time' (arg: seconds
 * from the start) | 'kind' (arg: one of KINDS). `index` is the point's place in
 * record.points.
 */
function editPoint(record, index, action, arg) {
    if ( ! Array.isArray(record.points) || ! record.points[index] ) {
        return fail('no such point');
    }
    // the stored point is replaced, so a copy held elsewhere never changes under it
    const p = Object.assign( {}, record.points[index] );
    let result = { ok: true };
    if (action === 'approve') {
        if (p.status !== 'hand') {
            p.status = 'approved';
            p.approvedBy = 'owner';
        }
    } else if (action === 'reject') {
        if (p.status === 'hand') {
            record.points = record.points.filter( (x, i) => i !== index );
            return { ok: true };
        }
        p.status = 'rejected';
        p.approvedBy = 'owner';
    } else if ( (action === 'nudge') || (action === 'time') ) {
        const to = (action === 'nudge') ? p.at + Number(arg) : Number(arg);
        result = moveTo(record, p, to);
    } else if (action === 'kind') {
        if ( ! KINDS.includes(arg) ) {
            return fail('not a kind of break');
        }
        p.kind = arg;
    } else {
        return fail('not something a point can do');
    }
    if (result.ok) {
        record.points = record.points.map( (x, i) => (i === index) ? p : x );
        record.points.sort( (a, b) => a.at - b.at );
    }
    return result;
}

// A break he places himself, at a time in seconds. Returns { ok, index }.
function addPoint(record, at, kind = 'act') {
    if ( ! KINDS.includes(kind) ) {
        return fail('not a kind of break');
    }
    if ( ! Number.isFinite(at) || (at < 0) || (at > lengthS(record)) ) {
        return fail('that time is outside the episode');
    }
    const points = Array.isArray(record.points) ? record.points : [];
    const near = points.findIndex( (p) => (Math.abs(p.at - at) < 1) && (p.status !== 'rejected') );
    if (near >= 0) {
        return editPoint(record, near, 'approve');   // already there: it is his now
    }
    points.push( { at, black: null, silence: null, kind, sources: [ 'hand' ], strength: 1, keyframe: null, status: 'hand', approvedBy: 'owner' } );
    points.sort( (a, b) => a.at - b.at );
    record.points = points;
    return { ok: true, index: points.findIndex( (p) => p.at === at ) };
}

// What a pattern approved on a record goes back to found when the record is marked: the pattern no longer
// speaks for it. DarkManX16's own approvals and hand points stay his.
function releasePatternPoints(record) {
    record.points = (record.points || []).map( (p) => ( (p.status === 'approved') && (p.approvedBy === 'pattern') ) ? Object.assign( {}, p, { status: 'found', approvedBy: null } ) : p );
}

// "This one has none" (a streaming copy with its breaks cut out).
function setNoBreaks(record, value) {
    record.noBreaks = (value === true);
    if (record.noBreaks) {
        releasePatternPoints(record);
    }
    return { ok: true };
}

// A movie he marks theatrical: no found points, breaks only where he adds them.
function setTheatrical(record, value) {
    if (value === true) {
        record.theatrical = true;
        releasePatternPoints(record);
    } else {
        delete record.theatrical;
    }
    return { ok: true };
}

module.exports = { editPoint, addPoint, setNoBreaks, setTheatrical, KINDS };
