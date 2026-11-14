/*
 * What the Breaks page shows (docs/blocks-spec.md, Stage 6, step 4), pure: a show's
 * stored records in, one line for the page's list and, when DarkManX16 opens a show,
 * its list to check and its episodes. Nothing here reads a file or the clock.
 *
 *   line      the show on one line: how much is scanned, the pattern on offer and
 *             whether it is approved, how many episodes have no breaks, how many
 *             are on the list to check, and when it next airs.
 *   to check  episodes with a point still waiting for his say. An episode with no
 *             breaks found is not on it (DarkManX16, Nov 14: there is nothing to
 *             approve, and it can never air); it is counted on the show's line and
 *             stays in the show's full list of episodes.
 */
const path = require('path');
const patterns = require('./break-patterns');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FRAME_NEAR_S = 0.4;       // a frame this far outside a black
const FRAME_CUT_S = 0.1;        // a frame this far either side of a cut with no black to look past

function kindOf(key) {
    if (key.startsWith('custom.')) {
        return 'custom';
    }
    return key.startsWith('movie.') ? 'movie' : 'tv';
}

// The show's own name: a key's title, or the custom show's name when it is known.
function nameOf(key, customNames = {}) {
    if (key.startsWith('custom.')) {
        return customNames[key.slice('custom.'.length)] || 'A custom show';
    }
    return key.slice(key.indexOf('.') + 1);
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function baseName(file) {
    const base = String(file).split(/[\\/]/).pop();
    return base.replace(/\.[A-Za-z0-9]{2,4}$/, '');
}

function folderOf(file) {
    const win = String(file).includes('\\');
    return (win ? path.win32 : path.posix).dirname(file);
}

// "S03E08 Howard's 45th Fiasco" from what the channels know of the file, else its filename.
function episodeName(file, info) {
    if (info == null) {
        return baseName(file);
    }
    const title = (info.title != null) ? String(info.title) : baseName(file);
    if ( (info.type === 'episode') && Number.isFinite(Number(info.season)) && Number.isFinite(Number(info.episode)) && (Number(info.season) > 0 || Number(info.episode) > 0) ) {
        return `S${pad(info.season)}E${pad(info.episode)} ${title}`;
    }
    return title;
}

const roundTo = (x, places) => Math.round(x * 10 ** places) / 10 ** places;

/*
 * Where to look to judge a point: the picture just before its black and just after it (the
 * viewer sees the fade out, the break and the fade back in), or, for a point with no
 * black (a chapter's, a hand-placed one, one he nudged), either side of the cut itself.
 */
function framesOf(p, durationS) {
    let before;
    let after;
    if (p.black != null) {
        before = p.black[0] - FRAME_NEAR_S;
        after = p.black[1] + FRAME_NEAR_S;
    } else {
        before = p.at - FRAME_CUT_S;
        after = p.at + FRAME_CUT_S;
    }
    const last = Math.max(0, durationS - 0.2);
    return { before: roundTo(Math.min(Math.max(0, before), last), 1), after: roundTo(Math.min(Math.max(0, after), last), 1) };
}

function pointView(p, durationS) {
    return {
        index: p.index,
        at: roundTo(p.at, 2),
        kind: p.kind,
        status: p.status,
        by: p.approvedBy || null,
        strength: roundTo(p.strength || 0, 2),
        chapterOnly: (p.black == null) && Array.isArray(p.sources) && p.sources.includes('chapter') && ! p.sources.includes('hand'),
        black: (p.black != null) ? [ roundTo(p.black[0], 1), roundTo(p.black[1], 1) ] : null,
        movedFrom: (p.foundAt != null) ? roundTo(p.foundAt, 2) : null,
        frames: framesOf(p, durationS),
    };
}

// The points of a record he can act on. A movie he marked theatrical shows only his own.
function viewPoints(pattern, record) {
    const durationS = record.durationMs / 1000;
    let pts = patterns.readPoints(pattern, record);
    if (record.theatrical === true) {
        pts = pts.filter( (p) => p.status === 'hand' );
    }
    return pts.map( (p) => pointView(p, durationS) );
}

const waiting = (p) => p.status === 'found';

/*
 * The part of a line that only the stored show decides (so it can be kept until the show's
 * file changes): `show` is the store's file, `name` the show's title, `total` the files on
 * the channels, if known.
 */
function lineCore(key, show, name, total = null) {
    const isMovieKey = key.startsWith('movie.');
    // A stub is a movie marked theatrical before it was ever scanned: it has nothing but the mark.
    const records = Object.values(show.files || {}).filter( (r) => (r != null) && (r.stub !== true) );
    const stubs = Object.values(show.files || {}).filter( (r) => (r != null) && (r.stub === true) );
    const scannedRecs = records.filter( (r) => (r.error == null) && Array.isArray(r.points) );
    const pattern = patterns.patternOf(show);
    const list = listOf(key, show, pattern);
    const groups = (show.theatrical === true) ? [] : patterns.showPatterns(show).groups;
    const hasPattern = ! isMovieKey && groups.some( (g) => g.pattern !== null );
    const first = patterns.patternLine(name, show, total);
    const weakerFull = isMovieKey ? null : patterns.weakerLine(name, show, total);
    const clauses = (line) => {
        const at = (line == null) ? -1 : line.indexOf(' scanned: ');
        return (at >= 0) ? line.slice(at + ' scanned: '.length) : ( (line != null) ? line.replace(name + ': ', '') : null );
    };
    const noneFound = scannedRecs.filter( (r) => (r.noBreaks !== true) && (r.theatrical !== true) && (patterns.readPoints(pattern, r).length === 0) ).length;
    const approved = (show.pattern != null);
    return {
        key,
        kind: kindOf(key),
        name,
        scanned: scannedRecs.length,
        total: Math.max(total || 0, scannedRecs.length),
        errors: records.length - scannedRecs.length,
        // a movie marked theatrical: its one file carries the mark (and so does a custom show of shorts)
        theatrical: (show.theatrical === true) || ( isMovieKey && records.concat(stubs).length > 0 && records.concat(stubs).every( (r) => r.theatrical === true ) ),
        moviePath: isMovieKey ? ( Object.keys(show.files || {})[0] || null ) : null,
        movies: patterns.moviesOf(show),
        pattern: hasPattern ? clauses(first) : null,
        patternText: first,
        weaker: (weakerFull != null) ? clauses(weakerFull) : null,
        approved,
        approvedWeaker: approved && (show.pattern.weaker === true),
        noBreaksFound: noneFound,
        markedNoBreaks: records.filter( (r) => r.noBreaks === true ).length,
        toCheck: list.length,
        needsClick: ( ! approved && (hasPattern || (weakerFull != null)) && (show.theatrical !== true) ) || (list.length > 0),
    };
}

/*
 * The episodes of this show with a point still waiting for DarkManX16: [{ path, reasons }].
 */
function listOf(key, show, pattern = patterns.patternOf(show)) {
    return patterns.outliers(show, key.startsWith('movie.')).filter( (o) => {
        const record = show.files[o.path];
        return (record != null) && patterns.readPoints(pattern, record).some(waiting) && (record.theatrical !== true);
    } );
}

/*
 * A line for the page's list: the core, and what the channels say: `info`
 * { nextAt, total } (nextAt a time in ms, or null when the show is on no channel).
 */
function lineFor(core, info = {}, now = Date.now()) {
    const nextAt = (info.nextAt != null) ? info.nextAt : null;
    return Object.assign( {}, core, {
        // files kept under another show's key count as scanned here too
        scanned: core.scanned + (info.elsewhere || 0),
        total: Math.max(core.total, info.total || 0),
        moviePath: core.moviePath || ( (core.kind === 'movie') && info.paths && info.paths[0] ) || null,
        movieFiles: Math.max(info.movies || 0, ((core.movies || {}).tv || 0) + ((core.movies || {}).theatrical || 0)),
        nextAt,
        thisWeek: (nextAt != null) && (nextAt < now + WEEK_MS),
    } );
}

/*
 * The shows in the order DarkManX16 checks them: those that air soonest first, those on no
 * channel last, ties by name.
 */
function byNextAiring(lines) {
    return lines.slice().sort( (a, b) => {
        if ( (a.nextAt == null) !== (b.nextAt == null) ) {
            return (a.nextAt == null) ? 1 : -1;
        }
        if (a.nextAt !== b.nextAt) {
            return a.nextAt - b.nextAt;
        }
        return a.name.localeCompare(b.name);
    } );
}

/*
 * One show opened: its line, the list to check, and every episode scanned.
 * `names`: (path) => { title, type, season, episode } | null, from the channels.
 */
function detail(key, show, name, names = () => null, info = {}, now = Date.now()) {
    const core = lineCore(key, show, name, info.total);
    const pattern = patterns.patternOf(show);
    const episodeOf = ([file, record]) => ({
        path: file,
        name: episodeName(file, names(file)),
        folder: folderOf(file),
        durationMs: record.durationMs || 0,
        movie: record.movie === true,
        theatrical: record.theatrical === true,
        noBreaks: record.noBreaks === true,
        noAudio: record.noAudio === true,
        error: (record.error != null) ? String(record.error.message || record.error) : null,
        unscanned: false,
        points: (record.error == null) && Array.isArray(record.points) && (record.durationMs > 0) ? viewPoints(pattern, record) : [],
    });
    const all = Object.entries(show.files || {}).filter( ([, r]) => r != null ).map(episodeOf);
    // A file the channels carry that was never scanned: listed, so a movie can be marked theatrical
    // before the scanner reaches it (a stub holds only that mark).
    for (const [file, record] of Object.entries(show.files || {})) {
        if ( (record != null) && (record.stub === true) ) {
            all.find( (e) => e.path === file ).unscanned = true;
        }
    }
    // Files of this show whose records are kept under another show's key: shown with their points, acted on there.
    for (const f of (info.elsewhere || [])) {
        const r = f.record;
        if ( (r != null) && (r.stub !== true) ) {
            const e = episodeOf( [ f.path, r ] );
            e.elsewhere = f.key;
            all.push(e);
        }
    }
    const known = new Set(Object.keys(show.files || {}).concat( (info.elsewhere || []).map( (f) => f.path ) ));
    for (const f of (info.files || [])) {
        if ( ! known.has(f.path) ) {
            const a = names(f.path);
            all.push( { path: f.path, name: episodeName(f.path, a), folder: folderOf(f.path), durationMs: f.durationMs || 0, movie: f.movie === true, theatrical: false, noBreaks: false, noAudio: false, error: null, points: [], unscanned: true } );
        }
    }
    all.sort( (a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }) );
    const reasons = new Map(listOf(key, show, pattern).map( (o) => [ o.path, o.reasons ] ));
    const toCheck = all.filter( (e) => reasons.has(e.path) ).map( (e) => Object.assign( {}, e, { reasons: reasons.get(e.path) } ) );
    const scannedElsewhere = (info.elsewhere || []).filter( (f) => (f.record != null) && (f.record.error == null) && Array.isArray(f.record.points) && (f.record.stub !== true) ).length;
    return { line: lineFor(core, Object.assign( {}, info, { elsewhere: scannedElsewhere } ), now), toCheck, episodes: all };
}

module.exports = { lineCore, lineFor, byNextAiring, detail, listOf, framesOf, episodeName, folderOf, nameOf, kindOf, WEEK_MS };
