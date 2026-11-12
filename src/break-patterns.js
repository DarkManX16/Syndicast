/*
 * Show patterns and approval (docs/blocks-spec.md, Stage 6, "Show patterns, and
 * approving"), pure: a show's records in, its pattern, its approvals and the list
 * for DarkManX16 to check out. Nothing here reads a file or the clock.
 *
 * As built, with DarkManX16's changes of Nov 10, 2026:
 *   - kinds are read through effectivePoints(), so a file scanned before the
 *     detector dropped its first 10 s gets the same kinds as one scanned after
 *     (the fade-in at 0:00 is ignored, and the break after the titles is the
 *     opening again) - no rescan;
 *   - a show's episodes are grouped by running length, not by season (the
 *     records hold lengths, not seasons): 11-minute halves get a pattern of
 *     their own;
 *   - a pattern is the plan's positions (points within 45 s of each other in at
 *     least half of a group's episodes, and at least three) or, where a show's
 *     breaks move from episode to episode, "N breaks an episode": each episode's
 *     N strongest mid-episode points - whichever fits more episodes. An opening
 *     found by position stays in the pattern either way;
 *   - the list to check leaves out stray points in episodes that fit the
 *     pattern: they are never approved, so they never air.
 */
const { FILE_START_S, constants: detectConstants } = require('./break-detect');

const SPAN_S = 45;                  // a position group, and how near a point must be to it
const MIN_EPISODES = 3;
const LENGTH_TOLERANCE = 1.15;      // a running-length group spans at most 15%
const STRONG = 0.6;                 // a mid-episode point counted by "N breaks an episode"
const EDGE_S = 120;                 // midrolls never come within 2 minutes of either end
const OPENING_WINDOW_S = detectConstants.OPENING_WINDOW_S;

function clock(s) {
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function usable(record) {
    return (record != null) && (record.error == null) && Array.isArray(record.points)
        && (record.durationMs > 0) && (record.noBreaks !== true);
}

/*
 * The record's points as step 3 reads them: the first 10 s dropped, and the
 * earliest remaining opening-or-act point within the first 3 minutes made the
 * opening (any other `opening` becomes an act). Each keeps `index`, its place in
 * record.points, so an approval lands on the stored point.
 */
function effectivePoints(record) {
    const pts = (record.points || []).map( (p, index) => Object.assign( {}, p, { index } ) )
        .filter( (p) => p.at >= FILE_START_S );
    const candidates = pts.filter( (p) => ( (p.kind === 'opening') || (p.kind === 'act') ) && (p.at <= OPENING_WINDOW_S) );
    const opening = candidates.length ? candidates.reduce( (a, b) => (b.at < a.at ? b : a) ) : null;
    return pts.map( (p) => {
        if (p === opening) {
            return Object.assign(p, { kind: 'opening' });
        }
        if (p.kind === 'opening') {
            return Object.assign(p, { kind: 'act' });
        }
        return p;
    } );
}

// Mid-episode points a midroll could use, and the strong ones among them.
function midPoints(record) {
    const d = record.durationMs / 1000;
    return effectivePoints(record).filter( (p) => ( (p.kind === 'act') || (p.kind === 'story') ) && (p.at >= EDGE_S) && (p.at <= d - EDGE_S) );
}
function strongMid(record) {
    return midPoints(record).filter( (p) => (p.black != null) && (p.strength >= STRONG) );
}

/*
 * files: [[path, record], ...] usable ones. Groups by running length, each
 * spanning at most 15% from its shortest.
 */
function lengthGroups(files) {
    const sorted = files.slice().sort( (a, b) => a[1].durationMs - b[1].durationMs );
    const groups = [];
    for (const f of sorted) {
        const g = groups[groups.length - 1];
        if (g && (f[1].durationMs <= g.minMs * LENGTH_TOLERANCE)) {
            g.files.push(f);
            g.maxMs = f[1].durationMs;
        } else {
            groups.push( { minMs: f[1].durationMs, maxMs: f[1].durationMs, files: [ f ] } );
        }
    }
    return groups;
}

function need(n) {
    return Math.max(MIN_EPISODES, Math.ceil(n / 2));
}

// The plan's positions: opening, act and story points within 45 s, in enough episodes.
function positionGroups(files) {
    const vals = [];
    for (const [path, rec] of files) {
        for (const p of effectivePoints(rec)) {
            if (p.kind !== 'credits') {
                vals.push( { at: p.at, kind: p.kind, path } );
            }
        }
    }
    vals.sort( (a, b) => a.at - b.at );
    const raw = [];
    for (const v of vals) {
        const g = raw[raw.length - 1];
        if (g && (v.at - g.first <= SPAN_S)) {
            g.items.push(v);
        } else {
            raw.push( { first: v.at, items: [ v ] } );
        }
    }
    const out = [];
    for (const g of raw) {
        const paths = new Set(g.items.map( (i) => i.path ));
        if (paths.size < need(files.length)) {
            continue;
        }
        const ats = g.items.map( (i) => i.at ).sort( (a, b) => a - b );
        const kinds = {};
        for (const i of g.items) {
            kinds[i.kind] = (kinds[i.kind] || 0) + 1;
        }
        const kind = Object.keys(kinds).sort( (a, b) => kinds[b] - kinds[a] )[0];
        out.push( { at: ats[Math.floor(ats.length / 2)], kind, episodes: paths.size } );
    }
    return out;
}

// "N breaks an episode": the commonest number of strong mid-episode points, if enough episodes have it.
function countPattern(files) {
    const tally = {};
    for (const [, rec] of files) {
        const n = strongMid(rec).length;
        tally[n] = (tally[n] || 0) + 1;
    }
    const best = Object.keys(tally).map(Number).filter( (n) => n > 0 ).sort( (a, b) => (tally[b] - tally[a]) || (b - a) )[0];
    if ( (best === undefined) || (tally[best] < need(files.length)) ) {
        return null;
    }
    return { n: best, episodes: tally[best] };
}

function nearest(points, at) {
    let best = null;
    for (const p of points) {
        const d = Math.abs(p.at - at);
        if ( (d <= SPAN_S) && ( (best === null) || (d < Math.abs(best.at - at)) ) ) {
            best = p;
        }
    }
    return best;
}

// Does one record fit one group's pattern? (positions all present, count exact)
function fits(pattern, record) {
    const pts = effectivePoints(record).filter( (p) => p.kind !== 'credits' );
    for (const pos of pattern.positions) {
        if (nearest(pts, pos.at) === null) {
            return false;
        }
    }
    if (pattern.count !== null) {
        return strongMid(record).length === pattern.count;
    }
    return true;
}

/*
 * One running-length group's pattern, or null when it has too few episodes or
 * nothing recurs. { minMs, maxMs, episodes, positions: [{ at, kind, episodes }],
 * count: N | null, countEpisodes, fitting }
 */
function groupPattern(group) {
    const files = group.files;
    if (files.length < MIN_EPISODES) {
        return null;
    }
    const positions = positionGroups(files);
    const openings = positions.filter( (p) => p.kind === 'opening' );
    const acts = positions.filter( (p) => p.kind !== 'opening' );
    const count = countPattern(files);
    const byPosition = { minMs: group.minMs, maxMs: group.maxMs, episodes: files.length, positions, count: null, countEpisodes: 0 };
    const byCount = count ? { minMs: group.minMs, maxMs: group.maxMs, episodes: files.length, positions: openings, count: count.n, countEpisodes: count.episodes } : null;
    const fitting = (p) => files.filter( ([, r]) => fits(p, r) ).length;
    let chosen = null;
    if ( (acts.length > 0) && (byCount === null) ) {
        chosen = byPosition;
    } else if (byCount !== null) {
        chosen = ( (acts.length > 0) && (fitting(byPosition) >= fitting(byCount)) ) ? byPosition : byCount;
    } else if (positions.length > 0) {
        chosen = byPosition;
    }
    if (chosen === null) {
        return null;
    }
    chosen.fitting = fitting(chosen);
    return chosen;
}

function scanned(show) {
    return Object.entries(show.files || {}).filter( ([, r]) => usable(r) );
}

/*
 * The show's patterns, one per running-length group: { groups: [{ minMs, maxMs,
 * episodes, pattern | null }] }. A theatrical show has none.
 */
function showPatterns(show) {
    if (show.theatrical === true) {
        return { groups: [] };
    }
    return { groups: lengthGroups(scanned(show)).map( (g) => ({ minMs: g.minMs, maxMs: g.maxMs, episodes: g.files.length, pattern: groupPattern(g) }) ) };
}

function minutesOf(ms) {
    return Math.round(ms / 60000);
}

/*
 * The line DarkManX16 reads: "Happy Days, 98 of 104 episodes scanned: opening near
 * 1:14 (95%), act near 11:46 (91%)". `total`, the show's files on the channels,
 * if known. A show of more than one running length gets a clause per length.
 */
function patternLine(name, show, total = null) {
    const n = scanned(show).length;
    const head = `${name}, ${ (total != null) ? `${n} of ${total}` : n } episode${ (n === 1) ? '' : 's' } scanned`;
    if (show.theatrical === true) {
        return `${name}: theatrical, breaks only where added by hand`;
    }
    const groups = showPatterns(show).groups;
    const several = groups.length > 1;
    const clauses = groups.map( (g) => {
        const p = g.pattern;
        const label = several ? `${minutesOf(g.minMs)}${ (minutesOf(g.maxMs) !== minutesOf(g.minMs)) ? '-' + minutesOf(g.maxMs) : '' }-minute episodes (${g.episodes}): ` : '';
        if (p === null) {
            return `${label}${ (g.episodes < MIN_EPISODES) ? 'too few to tell' : 'no pattern' }`;
        }
        const parts = p.positions.map( (pos) => `${pos.kind} near ${clock(pos.at)} (${Math.round(100 * pos.episodes / g.episodes)}%)` );
        if (p.count !== null) {
            parts.push(`${p.count} break${ (p.count === 1) ? '' : 's' } an episode at different times (${p.countEpisodes} of ${g.episodes})`);
        }
        return label + parts.join(', ');
    } );
    return `${head}: ${clauses.join('; ')}`;
}

// The approved pattern's group a record belongs to, by its running length.
function groupFor(approved, record) {
    return (approved.groups || []).find( (g) => (record.durationMs >= g.minMs / LENGTH_TOLERANCE) && (record.durationMs <= g.maxMs * LENGTH_TOLERANCE) ) || null;
}

function approvePoint(record, p, kind) {
    const stored = record.points[p.index];
    if (stored.status !== 'found') {
        return 0;   // DarkManX16's own approvals, rejections and hand points are his
    }
    record.points[p.index] = Object.assign( {}, stored, { status: 'approved', approvedBy: 'pattern', kind } );
    return 1;
}

/*
 * Approves one record against the approved pattern: the point nearest each
 * position, and - for "N breaks an episode" - its N strong mid-episode points
 * when it has exactly N. Returns { fits, approved }.
 */
function applyToRecord(approved, record) {
    if (! usable(record)) {
        return { fits: false, approved: 0 };
    }
    const g = groupFor(approved, record);
    if (g === null) {
        return { fits: false, approved: 0 };
    }
    let count = 0;
    const pts = effectivePoints(record).filter( (p) => p.kind !== 'credits' );
    for (const pos of g.positions) {
        const p = nearest(pts, pos.at);
        if (p !== null) {
            count += approvePoint(record, p, pos.kind);
        }
    }
    if ( (g.count !== null) && (strongMid(record).length === g.count) ) {
        for (const p of strongMid(record)) {
            count += approvePoint(record, p, p.kind);
        }
    }
    return { fits: fits(g, record), approved: count };
}

/*
 * One click: the show's pattern, every length group's, is approved and applied to
 * every scanned episode. Changes `show` in place (the caller saves it); returns
 * the number of points approved.
 */
function approve(show, now) {
    if (show.theatrical === true) {
        return 0;
    }
    const groups = showPatterns(show).groups.filter( (g) => g.pattern !== null ).map( (g) => ({
        minMs: g.minMs, maxMs: g.maxMs,
        positions: g.pattern.positions.map( (p) => ({ at: p.at, kind: p.kind }) ),
        count: g.pattern.count,
    }) );
    show.pattern = { approvedAt: now, groups };
    let n = 0;
    for (const [, rec] of scanned(show)) {
        n += applyToRecord(show.pattern, rec).approved;
    }
    return n;
}

// Withdraw: every pattern-approved point back to found; DarkManX16's own approvals stay.
function withdraw(show) {
    let n = 0;
    for (const rec of Object.values(show.files || {})) {
        if (! Array.isArray(rec.points)) {
            continue;
        }
        rec.points = rec.points.map( (p) => {
            if ( (p.status === 'approved') && (p.approvedBy === 'pattern') ) {
                n++;
                return Object.assign( {}, p, { status: 'found', approvedBy: null } );
            }
            return p;
        } );
    }
    show.pattern = null;
    return n;
}

/*
 * A record saved after the pattern was approved (a later episode, or a file that
 * changed and was scanned again): approved as it arrives if the show's pattern is
 * approved. Returns { fits, approved }, or null when nothing is approved.
 */
function applyApproved(show, path) {
    if ( (show.pattern == null) || (show.theatrical === true) || (show.files[path] == null) ) {
        return null;
    }
    return applyToRecord(show.pattern, show.files[path]);
}

/*
 * The list for DarkManX16 to check: [{ path, reasons: [...] }]. Episodes that fit the
 * pattern are left out, stray points and all; a TV movie always lists its points.
 * `isMovie`: the show key is a movie's (movie.<title>), which has no pattern.
 */
function outliers(show, isMovie = false) {
    if (show.theatrical === true) {
        return [];
    }
    const out = [];
    const all = Object.entries(show.files || {}).filter( ([, r]) => (r != null) && (r.error == null) && Array.isArray(r.points) && (r.noBreaks !== true) );
    if (isMovie) {
        for (const [path, rec] of all) {
            const pts = effectivePoints(rec).filter( (p) => p.kind !== 'credits' );
            out.push( { path, reasons: [ pts.length ? `a TV movie: ${pts.length} point${ (pts.length === 1) ? '' : 's' } to check (${pts.map( (p) => clock(p.at) ).join(', ')})` : 'a TV movie with no breaks found' ] } );
        }
        return out;
    }
    const pattern = (show.pattern != null) ? show.pattern : { groups: showPatterns(show).groups.filter( (g) => g.pattern !== null ).map( (g) => Object.assign( { minMs: g.minMs, maxMs: g.maxMs }, g.pattern ) ) };
    const sizes = lengthGroups(all.filter( ([, r]) => r.durationMs > 0 ));
    for (const [path, rec] of all) {
        const reasons = [];
        if (rec.noAudio === true) {
            reasons.push('no audio track, so only its chapters can offer a break');
        }
        const pts = effectivePoints(rec).filter( (p) => p.kind !== 'credits' );
        if (pts.length === 0) {
            reasons.push('no breaks found');
        }
        const g = groupFor(pattern, rec);
        if (g === null) {
            const size = sizes.find( (s) => s.files.some( ([p]) => p === path ) );
            if (size && (size.files.length < MIN_EPISODES)) {
                reasons.push(`only ${size.files.length} episode${ (size.files.length === 1) ? '' : 's' } of this length (${minutesOf(rec.durationMs)} min)`);
            } else if (pts.length > 0) {
                reasons.push('no pattern for episodes of this length');
            }
        } else {
            for (const pos of g.positions) {
                if (nearest(pts, pos.at) === null) {
                    reasons.push(`no ${pos.kind} near ${clock(pos.at)}`);
                }
            }
            if (g.count !== null) {
                const k = strongMid(rec).length;
                if (k !== g.count) {
                    reasons.push(`${k} strong break${ (k === 1) ? '' : 's' }, not ${g.count}`);
                }
            }
        }
        for (const p of pts) {
            if ( (p.black == null) && (p.status === 'found') ) {
                reasons.push(`a chapter-only point at ${clock(p.at)}`);
            }
        }
        if (reasons.length > 0) {
            out.push( { path, reasons } );
        }
    }
    out.sort( (a, b) => a.path.localeCompare(b.path) );
    return out;
}

module.exports = {
    effectivePoints, midPoints, strongMid, lengthGroups, positionGroups, countPattern, groupPattern,
    showPatterns, patternLine, approve, withdraw, applyApproved, outliers, fits, clock,
    constants: { SPAN_S, MIN_EPISODES, LENGTH_TOLERANCE, STRONG, EDGE_S },
};
