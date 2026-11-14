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
 * And of Nov 13:
 *   - two points within 15 s are one break with the show's own card between
 *     them (Cheers: black, the "Cheers" card, black), read as the later one, so
 *     the card plays before the commercials;
 *   - a chapter-only point in an episode that fits is a stray like any other;
 *   - theatrical is per movie: a record carries `theatrical: true`, so marking one
 *     movie leaves the rest of its custom show alone;
 *   - a movie inside a custom show (a record with `movie: true`) is a movie: no
 *     part of the show's pattern, its points always on the list to check;
 *   - where the strong points give no mid-episode break but every point with a
 *     black gives a steady count (Full House), that count is offered on a line
 *     of its own, approved only by its own click.
 */
const { FILE_START_S, constants: detectConstants } = require('./break-detect');

const SPAN_S = 45;                  // a position group, and how near a point must be to it
const ONE_BREAK_S = 15;             // points this close are one break, a card between them
const MIN_EPISODES = 3;
const LENGTH_TOLERANCE = 1.15;      // a running-length group spans at most 15%
const STRONG = 0.6;                 // a mid-episode point counted by "N breaks an episode"
const EDGE_S = 120;                 // midrolls never come within 2 minutes of either end
const OPENING_WINDOW_S = detectConstants.OPENING_WINDOW_S;
// A half-hour show's cold open and titles can run past 3:00: Hannah Montana's break
// after the title card falls at 2:16-4:42 (frames, Nov 12). A running-length group of
// 20 minutes or more, at least half of whose episodes have their first point between
// 3:00 and 5:00, reads that point as its opening. Shorts never do.
const LONG_OPENING_WINDOW_S = 300;
const LONG_OPENING_MIN_MS = 20 * 60000;

function clock(s) {
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function usable(record) {
    return (record != null) && (record.error == null) && Array.isArray(record.points)
        && (record.durationMs > 0) && (record.noBreaks !== true) && (record.theatrical !== true);
}

// An episode of the show: a movie in a custom show has no part in its pattern.
function episode(record) {
    return usable(record) && (record.movie !== true);
}

/*
 * Two points within 15 s are one break (DarkManX16, Nov 13): Cheers fades to black,
 * shows its own "Cheers" card for about 4 s, and fades to black again, and the
 * detector finds both blacks. The break is read as the later point, so the card
 * plays as the show's bumper before the commercials, at the stronger of the two
 * strengths; the earlier point's index is kept in `absorbed`. A later point with
 * no black (a chapter alone) gives way to the latest one with a black.
 * Mid-episode points only: the opening and the credits are read as before
 * (doing the same to openings moved them in about 40 shows on the Nov 12 copy
 * and lost The Incredible Hulk's pattern, none of it checked in the frames).
 */
function oneBreakEach(pts) {
    const out = [];
    let run = [];
    const flush = () => {
        if (run.length === 0) {
            return;
        }
        const blacks = run.filter( (p) => p.black != null );
        const keep = blacks.length ? blacks[blacks.length - 1] : run[run.length - 1];
        if (run.length > 1) {
            keep.strength = Math.max(...run.map( (p) => p.strength || 0 ));
            keep.absorbed = run.filter( (p) => p !== keep ).map( (p) => p.index );
        }
        out.push(keep);
        run = [];
    };
    for (const p of pts.slice().sort( (a, b) => a.at - b.at )) {
        if ( (p.kind === 'credits') || (p.kind === 'opening') ) {
            flush();
            out.push(p);
            continue;
        }
        if ( (run.length > 0) && (p.at - run[run.length - 1].at > ONE_BREAK_S) ) {
            flush();
        }
        run.push(p);
    }
    flush();
    return out.sort( (a, b) => a.at - b.at );
}

/*
 * The record's points as step 3 reads them: the first 10 s dropped, the earliest
 * remaining opening-or-act point within the first 3 minutes made the opening (any
 * other `opening` becomes an act), and mid-episode points within 15 s of each
 * other read as one. Each keeps `index`, its place in record.points, so an
 * approval lands on the stored point.
 */
function effectivePoints(record, windowS = OPENING_WINDOW_S) {
    const pts = (record.points || []).map( (p, index) => Object.assign( {}, p, { index } ) )
        .filter( (p) => p.at >= FILE_START_S );
    const candidates = pts.filter( (p) => ( (p.kind === 'opening') || (p.kind === 'act') ) && (p.at <= windowS) );
    const opening = candidates.length ? candidates.reduce( (a, b) => (b.at < a.at ? b : a) ) : null;
    return oneBreakEach( pts.map( (p) => {
        if (p === opening) {
            return Object.assign(p, { kind: 'opening' });
        }
        if (p.kind === 'opening') {
            return Object.assign(p, { kind: 'act' });
        }
        return p;
    } ) );
}

// Mid-episode points a midroll could use, and the strong ones among them.
function midPoints(record, windowS = OPENING_WINDOW_S) {
    const d = record.durationMs / 1000;
    return effectivePoints(record, windowS).filter( (p) => ( (p.kind === 'act') || (p.kind === 'story') ) && (p.at >= EDGE_S) && (p.at <= d - EDGE_S) );
}
function strongMid(record, windowS = OPENING_WINDOW_S) {
    return midPoints(record, windowS).filter( (p) => (p.black != null) && (p.strength >= STRONG) );
}
// The points "N breaks an episode" counts: the strong ones, or for a count from weaker
// points every mid-episode point with a black, at any strength.
function countedMid(record, windowS = OPENING_WINDOW_S, weak = false) {
    return weak ? midPoints(record, windowS).filter( (p) => p.black != null ) : strongMid(record, windowS);
}

// The opening window for one running-length group (see LONG_OPENING_WINDOW_S).
function openingWindow(files) {
    if ( (files.length < MIN_EPISODES) || files.some( ([, r]) => r.durationMs < LONG_OPENING_MIN_MS ) ) {
        return OPENING_WINDOW_S;
    }
    const late = files.filter( ([, r]) => {
        const first = (r.points || []).filter( (p) => (p.at >= FILE_START_S) && (p.kind !== 'credits') ).sort( (a, b) => a.at - b.at )[0];
        return (first != null) && (first.at > OPENING_WINDOW_S) && (first.at <= LONG_OPENING_WINDOW_S);
    } ).length;
    return (late >= need(files.length)) ? LONG_OPENING_WINDOW_S : OPENING_WINDOW_S;
}

function openingOf(record, windowS) {
    return effectivePoints(record, windowS).find( (p) => p.kind === 'opening' ) || null;
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
function positionGroups(files, windowS = OPENING_WINDOW_S) {
    const vals = [];
    for (const [path, rec] of files) {
        for (const p of effectivePoints(rec, windowS)) {
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

// "N breaks an episode": the commonest number of strong mid-episode points (or, `weak`, of
// all of them with a black), if enough episodes have it.
function countPattern(files, windowS = OPENING_WINDOW_S, weak = false) {
    const tally = {};
    for (const [, rec] of files) {
        const n = countedMid(rec, windowS, weak).length;
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

// Does one record fit one group's pattern? (positions all present, an opening where
// each episode's own is approved, count exact)
function fits(pattern, record) {
    const w = pattern.openingWindowS || OPENING_WINDOW_S;
    const pts = effectivePoints(record, w).filter( (p) => p.kind !== 'credits' );
    for (const pos of pattern.positions) {
        if (nearest(pts, pos.at) === null) {
            return false;
        }
    }
    if ( (pattern.openingEach != null) && (openingOf(record, w) === null) ) {
        return false;
    }
    if (pattern.count !== null) {
        return countedMid(record, w, pattern.weak === true).length === pattern.count;
    }
    return true;
}

/*
 * One running-length group's pattern, or null when it has too few episodes or
 * nothing recurs. { minMs, maxMs, episodes, positions: [{ at, kind, episodes }],
 * count: N | null, countEpisodes, fitting }
 */
function groupPattern(group) {
    return groupPatterns(group).pattern;
}

/*
 * { pattern, weaker }: the group's pattern, and - only where that gives no
 * mid-episode break - "N breaks an episode" from weaker points (DarkManX16, Nov 13:
 * Full House's single point is a real act break in 15 of 18 sampled, 7 of the 9
 * below 0.6 among them). The weaker one keeps the pattern's openings and carries
 * `weak: true`; it is offered, never approved by the ordinary click.
 */
function groupPatterns(group) {
    const files = group.files;
    if (files.length < MIN_EPISODES) {
        return { pattern: null, weaker: null };
    }
    const w = openingWindow(files);
    const positions = positionGroups(files, w);
    const openings = positions.filter( (p) => p.kind === 'opening' );
    const acts = positions.filter( (p) => p.kind !== 'opening' );
    const count = countPattern(files, w);
    // An opening that moves from episode to episode (no position group): each episode's own.
    let openingEach = null;
    if (openings.length === 0) {
        const ats = files.map( ([, r]) => openingOf(r, w) ).filter( (p) => p !== null ).map( (p) => p.at ).sort( (a, b) => a - b );
        if (ats.length >= need(files.length)) {
            openingEach = { from: ats[0], to: ats[ats.length - 1], episodes: ats.length };
        }
    }
    const common = { minMs: group.minMs, maxMs: group.maxMs, episodes: files.length, openingWindowS: w, openingEach };
    const byPosition = Object.assign( {}, common, { positions, count: null, countEpisodes: 0 } );
    const byCount = count ? Object.assign( {}, common, { positions: openings, count: count.n, countEpisodes: count.episodes } ) : null;
    const fitting = (p) => files.filter( ([, r]) => fits(p, r) ).length;
    let chosen = null;
    if ( (acts.length > 0) && (byCount === null) ) {
        chosen = byPosition;
    } else if (byCount !== null) {
        chosen = ( (acts.length > 0) && (fitting(byPosition) >= fitting(byCount)) ) ? byPosition : byCount;
    } else if (positions.length > 0) {
        chosen = byPosition;
    }
    if (chosen !== null) {
        chosen.fitting = fitting(chosen);
    }
    const breaks = (chosen !== null) && ( (chosen.count !== null) || chosen.positions.some( (p) => p.kind !== 'opening' ) );
    let weaker = null;
    const weak = breaks ? null : countPattern(files, w, true);
    if (weak !== null) {
        weaker = Object.assign( {}, common, { positions: openings, count: weak.n, countEpisodes: weak.episodes, weak: true } );
        weaker.fitting = fitting(weaker);
    }
    return { pattern: chosen, weaker };
}

// The show's scanned episodes (its movies and theatrical items left out).
function scanned(show) {
    return Object.entries(show.files || {}).filter( ([, r]) => episode(r) );
}

// A custom show's movies: { tv: TV-made ones scanned, theatrical }.
function moviesOf(show) {
    const recs = Object.values(show.files || {}).filter( (r) => (r != null) && (r.movie === true) );
    return {
        tv: recs.filter( (r) => usable(r) ).length,
        theatrical: recs.filter( (r) => r.theatrical === true ).length,
    };
}

/*
 * The show's patterns, one per running-length group: { groups: [{ minMs, maxMs,
 * episodes, pattern | null, weaker | null }] }. A theatrical show has none.
 */
function showPatterns(show) {
    if (show.theatrical === true) {
        return { groups: [] };
    }
    return { groups: lengthGroups(scanned(show)).map( (g) => Object.assign( { minMs: g.minMs, maxMs: g.maxMs, episodes: g.files.length }, groupPatterns(g) ) ) };
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
    const m = moviesOf(show);
    const movies = [
        m.tv ? `${m.tv} TV movie${ (m.tv === 1) ? '' : 's' }, each on the list to check` : null,
        m.theatrical ? `${m.theatrical} theatrical movie${ (m.theatrical === 1) ? '' : 's' }, breaks only where added by hand` : null,
    ].filter( (c) => c !== null );
    if ( (n === 0) && (movies.length > 0) ) {
        return `${name}: ${movies.join('; ')}`;
    }
    const groups = showPatterns(show).groups;
    const several = groups.length > 1;
    const clauses = groups.map( (g) => {
        if (g.pattern === null) {
            return `${lengthLabel(g, several)}${ (g.episodes < MIN_EPISODES) ? 'too few to tell' : 'no pattern' }`;
        }
        return lengthLabel(g, several) + clauseOf(g.pattern, g.episodes);
    } );
    return `${head}: ${clauses.concat(movies).join('; ')}`;
}

function lengthLabel(g, several) {
    return several ? `${minutesOf(g.minMs)}${ (minutesOf(g.maxMs) !== minutesOf(g.minMs)) ? '-' + minutesOf(g.maxMs) : '' }-minute episodes (${g.episodes}): ` : '';
}

function clauseOf(p, episodes) {
    const parts = p.positions.map( (pos) => `${pos.kind} near ${clock(pos.at)} (${Math.round(100 * pos.episodes / episodes)}%)` );
    if (p.openingEach != null) {
        parts.unshift(`opening at ${clock(p.openingEach.from)}-${clock(p.openingEach.to)} (${p.openingEach.episodes} of ${episodes})`);
    }
    if (p.count !== null) {
        const n = `${p.count} break${ (p.count === 1) ? '' : 's' } an episode at different times`;
        parts.push(p.weak ? `${n} (weaker points, ${p.countEpisodes} of ${episodes})` : `${n} (${p.countEpisodes} of ${episodes})`);
    }
    return parts.join(', ');
}

/*
 * The second line, or null: "Full House, 190 episodes scanned: 1 break an episode at
 * different times (weaker points, 121 of 190)", for the length groups whose strong
 * points give no mid-episode break but whose weaker points give a steady count.
 * approve(show, now, { weaker: true }) approves it, with the first line's pattern
 * for every other length group.
 */
function weakerLine(name, show, total = null) {
    if (show.theatrical === true) {
        return null;
    }
    const groups = showPatterns(show).groups;
    const offered = groups.filter( (g) => g.weaker !== null );
    if (offered.length === 0) {
        return null;
    }
    const n = scanned(show).length;
    const head = `${name}, ${ (total != null) ? `${n} of ${total}` : n } episode${ (n === 1) ? '' : 's' } scanned`;
    return `${head}: ${offered.map( (g) => lengthLabel(g, groups.length > 1) + clauseOf(g.weaker, g.episodes) ).join('; ')}`;
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
    if (! episode(record)) {
        return { fits: false, approved: 0 };
    }
    const g = groupFor(approved, record);
    if (g === null) {
        return { fits: false, approved: 0 };
    }
    let count = 0;
    const w = g.openingWindowS || OPENING_WINDOW_S;
    const pts = effectivePoints(record, w).filter( (p) => p.kind !== 'credits' );
    for (const pos of g.positions) {
        const p = nearest(pts, pos.at);
        if (p !== null) {
            count += approvePoint(record, p, pos.kind);
        }
    }
    if (g.openingEach != null) {
        const o = openingOf(record, w);
        if (o !== null) {
            count += approvePoint(record, o, 'opening');
        }
    }
    const counted = countedMid(record, w, g.weak === true);
    if ( (g.count !== null) && (counted.length === g.count) ) {
        for (const p of counted) {
            count += approvePoint(record, p, p.kind);
        }
    }
    return { fits: fits(g, record), approved: count };
}

/*
 * One click: the show's pattern, every length group's, is approved and applied to
 * every scanned episode. `weaker`: the second line's click, which takes the count
 * from weaker points where one is offered. Changes `show` in place (the caller
 * saves it); returns the number of points approved.
 */
function approve(show, now, { weaker = false } = {}) {
    if (show.theatrical === true) {
        return 0;
    }
    const groups = [];
    for (const g of showPatterns(show).groups) {
        const p = (weaker && (g.weaker !== null)) ? g.weaker : g.pattern;
        if (p === null) {
            continue;
        }
        groups.push( {
            minMs: g.minMs, maxMs: g.maxMs,
            positions: p.positions.map( (x) => ({ at: x.at, kind: x.kind }) ),
            count: p.count,
            weak: p.weak === true,
            openingWindowS: p.openingWindowS,
            openingEach: p.openingEach,
        } );
    }
    show.pattern = { approvedAt: now, weaker: weaker === true, groups };
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
 * pattern are left out, stray points and chapter-only points and all; a TV movie
 * always lists its points, under its own movie key or inside a custom show.
 * `isMovie`: the show key is a movie's (movie.<title>), which has no pattern.
 */
function outliers(show, isMovie = false) {
    if (show.theatrical === true) {
        return [];
    }
    const out = [];
    const listed = Object.entries(show.files || {}).filter( ([, r]) => (r != null) && (r.error == null) && Array.isArray(r.points) && (r.noBreaks !== true) && (r.theatrical !== true) );
    for (const [path, rec] of listed.filter( ([, r]) => isMovie || (r.movie === true) )) {
        const pts = effectivePoints(rec).filter( (p) => p.kind !== 'credits' );
        out.push( { path, reasons: [ pts.length ? `a TV movie: ${pts.length} point${ (pts.length === 1) ? '' : 's' } to check (${pts.map( (p) => clock(p.at) ).join(', ')})` : 'a TV movie with no breaks found' ] } );
    }
    const all = isMovie ? [] : listed.filter( ([, r]) => r.movie !== true );
    const pattern = (show.pattern != null) ? show.pattern : { groups: showPatterns(show).groups.filter( (g) => g.pattern !== null ).map( (g) => Object.assign( { minMs: g.minMs, maxMs: g.maxMs }, g.pattern ) ) };
    const sizes = lengthGroups(all.filter( ([, r]) => r.durationMs > 0 ));
    for (const [path, rec] of all) {
        const reasons = [];
        if (rec.noAudio === true) {
            reasons.push('no audio track, so only its chapters can offer a break');
        }
        const g = groupFor(pattern, rec);
        const fit = (g !== null) && fits(g, rec);
        const w = (g && g.openingWindowS) || OPENING_WINDOW_S;
        const pts = effectivePoints(rec, w).filter( (p) => p.kind !== 'credits' );
        if (pts.length === 0) {
            reasons.push('no breaks found');
        }
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
            if ( (g.openingEach != null) && (openingOf(rec, w) === null) ) {
                reasons.push('no opening found');
            }
            if (g.count !== null) {
                const k = countedMid(rec, w, g.weak === true).length;
                if (k !== g.count) {
                    reasons.push(`${k} ${ (g.weak === true) ? '' : 'strong ' }break${ (k === 1) ? '' : 's' }, not ${g.count}`);
                }
            }
        }
        for (const p of (fit ? [] : pts)) {
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
    effectivePoints, midPoints, strongMid, openingWindow, lengthGroups, positionGroups, countPattern, groupPattern,
    showPatterns, patternLine, weakerLine, approve, withdraw, applyApproved, outliers, fits, clock,
    constants: { SPAN_S, ONE_BREAK_S, MIN_EPISODES, LENGTH_TOLERANCE, STRONG, EDGE_S, LONG_OPENING_WINDOW_S, LONG_OPENING_MIN_MS },
};
