/*
 * The names review screen's own logic (stage 5, step 6), kept out of the
 * directive so it can be driven from a test: how a clip is grouped and marked,
 * what "accept all confident suggestions" would do, and what a save sends.
 * Pure, no I/O, no DOM; the screen (web/directives/names-review.js) and the
 * server (src/services/show-match-service.js) both read it.
 *
 * A row is what GET /api/filler/:id/match gives for one clip:
 *   { index, title, names, reviewed, proposal }
 * `names` are the clip's saved names, `reviewed` is true when it was saved as
 * naming no show, and `proposal` is what its title suggests ({ names, found,
 * unresolved? }). A decision made on the screen is *pending* until it is saved:
 * `pending[index] = { names: [showKey, ...] }`, an empty list for "names no show".
 * Nothing here changes a row; every function returns something new.
 */
const showMatch = require('./show-match');
const clipNames = require('./clip-names');

// The groups, in the order the screen lists them: what needs a look comes first.
const GROUPS = [
    { id: 'flagged', title: 'Flagged: the title could not be read as a show, a movie or a season' },
    { id: 'uncertain', title: 'Less certain suggestions' },
    { id: 'confident', title: 'Confident suggestions, not saved yet' },
    { id: 'none', title: 'No suggestion' },
    { id: 'saved', title: 'Saved' },
];

const MAX_NAMES = showMatch.MAX_NAMES;

/*
 * Whether the row's names are saved, only suggested, or there are none.
 * A clip saved as naming no show counts as saved.
 */
function statusOf(row) {
    if ( (Array.isArray(row.names) && row.names.length > 0) || (row.reviewed === true) ) {
        return 'saved';
    }
    if ( (row.proposal != null) && Array.isArray(row.proposal.names) && (row.proposal.names.length > 0) ) {
        return 'suggested';
    }
    return 'none';
}

/*
 * How a suggestion was reached, for the screen to say next to it, and whether
 * that makes it less certain. `from` is how a hit was found; the matcher marks
 * a hit `shortened`, `abbreviation`, `standalone` (a one-word title found only
 * because it stood alone) or with `alsoKeys` (more than one show has the title).
 */
function marksOf(proposal) {
    const marks = [];
    if (proposal == null) {
        return marks;
    }
    const found = Array.isArray(proposal.found) ? proposal.found : [];
    const has = (test) => found.some(test);
    if (proposal.unresolved != null) {
        const kind = proposal.unresolved.kind;
        marks.push( { id: 'flagged', uncertain: true, label: (kind === 'movie') ? 'flagged: a movie or special that is not on a channel'
            : (kind === 'saga') ? 'flagged: a saga that is not taught as a season nickname'
            : 'flagged: a title with several shows, one not recognised' } );
    }
    if (has( (h) => h.subtitle === true )) {
        marks.push( { id: 'movie', label: 'from the movie’s subtitle', uncertain: false } );
    }
    if (has( (h) => typeof(h.special) === 'string' )) {
        marks.push( { id: 'special', label: 'from a special’s title: less certain', uncertain: true } );
    }
    if (has( (h) => h.seasonFromTitle === true )) {
        marks.push( { id: 'season', label: 'from “Season N”: less certain, it may be for the whole show', uncertain: true } );
    }
    if (has( (h) => h.shortened === true )) {
        marks.push( { id: 'shortened', label: 'from a shortened title', uncertain: true } );
    }
    if (has( (h) => h.abbreviation === true )) {
        marks.push( { id: 'abbreviation', label: 'from an abbreviation', uncertain: true } );
    }
    if (has( (h) => h.standalone === true )) {
        marks.push( { id: 'standalone', label: 'less certain: one word found on its own', uncertain: true } );
    }
    if (has( (h) => Array.isArray(h.alsoKeys) && (h.alsoKeys.length > 0) )) {
        marks.push( { id: 'ambiguous', label: 'less certain: more than one show has this title', uncertain: true } );
    }
    if ( (proposal.extra || 0) > 0 ) {
        marks.push( { id: 'extra', label: 'less certain: it mentions more shows than a clip can name', uncertain: true } );
    }
    return marks;
}

/*
 * The group a row is listed in: saved clips first of all (a saved name wins over
 * whatever the title says), then a flagged title, then a suggestion carrying any
 * of the less-certain marks, then a plain one, else none.
 */
function groupOf(row) {
    const status = statusOf(row);
    if (status === 'saved') {
        return 'saved';
    }
    if ( (row.proposal != null) && (row.proposal.unresolved != null) ) {
        return 'flagged';
    }
    if (status === 'suggested') {
        return marksOf(row.proposal).some( (m) => m.uncertain ) ? 'uncertain' : 'confident';
    }
    return 'none';
}

// Rows in the screen's order: by group, then by position in the list.
function orderRows(rows) {
    const rank = (r) => GROUPS.findIndex( (g) => g.id === groupOf(r) );
    return rows.slice().sort( (a, b) => (rank(a) - rank(b)) || (a.index - b.index) );
}

// { flagged, uncertain, confident, none, saved, total } for a list's rows.
function summarize(rows) {
    const counts = { flagged: 0, uncertain: 0, confident: 0, none: 0, saved: 0, total: rows.length };
    for (const row of rows) {
        counts[groupOf(row)]++;
    }
    return counts;
}

// The same, as the overview shows it: how many clips want a look at all.
function needsLook(counts) {
    return counts.flagged + counts.uncertain;
}

/*
 * What a row reads as with the pending decisions applied: the names it will have
 * ('saved', 'pending' - decided here, not saved yet -, 'suggested' or 'none').
 */
function effective(row, pending) {
    const decided = pending[row.index];
    if (typeof(decided) !== 'undefined') {
        return { state: 'pending', names: decided.names.slice() };
    }
    const status = statusOf(row);
    if (status === 'saved') {
        return { state: 'saved', names: Array.isArray(row.names) ? row.names.slice() : [] };
    }
    if (status === 'suggested') {
        return { state: 'suggested', names: row.proposal.names.slice() };
    }
    return { state: 'none', names: [] };
}

/*
 * What "accept all confident suggestions" would do: the rows it takes (confident
 * ones with no decision yet) and how many it leaves for a look, so the screen can
 * say "accept 41? This skips 9 less certain and 3 flagged" before doing anything.
 * Saved clips and clips already decided here are never touched.
 */
function acceptAllPlan(rows, pending) {
    const plan = { accept: [], skippedUncertain: 0, skippedFlagged: 0 };
    for (const row of rows) {
        if (typeof(pending[row.index]) !== 'undefined') {
            continue;
        }
        const group = groupOf(row);
        if (group === 'confident') {
            plan.accept.push(row.index);
        } else if (group === 'uncertain') {
            plan.skippedUncertain++;
        } else if (group === 'flagged') {
            plan.skippedFlagged++;
        }
    }
    return plan;
}

// pending with the rows the plan names accepted as suggested: a new object.
function acceptAll(rows, pending) {
    const next = Object.assign({}, pending);
    const byIndex = new Map(rows.map( (r) => [r.index, r] ));
    for (const index of acceptAllPlan(rows, pending).accept) {
        next[index] = { names: byIndex.get(index).proposal.names.slice() };
    }
    return next;
}

/*
 * A list of picked names (a show or movie key, or a season or an episode of a show),
 * cleaned: blanks dropped, at most four, and the same name not twice in a row (a clip
 * that names "TMNT, TMNT" would never fit a break). The same name may come back later
 * in a list of several, since lineups repeat.
 */
function cleanPicks(picks) {
    const out = [];
    for (const pick of picks) {
        if ( clipNames.validName(pick) && (out.length < MAX_NAMES) && ! ( (out.length > 0) && clipNames.sameName(out[out.length - 1], pick) ) ) {
            out.push(pick);
        }
    }
    return out;
}

// Why picked names cannot be saved as they are, or null.
function picksProblem(keys) {
    if (! Array.isArray(keys) ) {
        return 'names is not a list';
    }
    if (keys.length > MAX_NAMES) {
        return `a clip can name at most ${MAX_NAMES} shows`;
    }
    for (let i = 0; i < keys.length; i++) {
        if (! clipNames.validName(keys[i]) ) {
            return 'a show has not been picked';
        }
        if ( (i > 0) && clipNames.sameName(keys[i], keys[i - 1]) ) {
            return 'the same show is picked twice in a row';
        }
    }
    return null;
}

/*
 * What a save sends: only the clips decided on this screen and only the
 * nicknames taught on it - a clip nobody looked at is not in it, so it is not
 * written. `nicknames` is [{ alias, target }] with `alias` already in the form
 * the matcher stores and `target` what it means: a show key, or { show, season } for
 * a season nickname (older callers pass `showKey` for a show).
 */
function savePayload(rows, pending, nicknames) {
    const byIndex = new Map(rows.map( (r) => [r.index, r] ));
    const clips = [];
    for (const key of Object.keys(pending) ) {
        const index = Number(key);
        const row = byIndex.get(index);
        if (typeof(row) !== 'undefined') {
            clips.push( { index: index, title: row.title, names: pending[key].names.slice() } );
        }
    }
    clips.sort( (a, b) => a.index - b.index );
    const aliases = {};
    for (const n of nicknames) {
        aliases[n.alias] = (typeof(n.target) !== 'undefined') ? n.target : n.showKey;
    }
    return { clips: clips, aliases: aliases };
}

function pendingCount(pending, nicknames) {
    return { clips: Object.keys(pending).length, nicknames: nicknames.length };
}

/*
 * Names kept through a refresh. A list imported from Plex has its clips replaced
 * by Plex's every so often, and the replacements know nothing about names, so the
 * names that were saved are carried over by the clip's Plex rating key (its file
 * if there is none). A clip that is new, or that already has names, is left as it
 * is. Returns new clips and changes nothing.
 */
function carryNames(oldClips, newClips) {
    const keyOf = (c) => (c == null) ? null : ((c.ratingKey != null) ? 'r:' + c.ratingKey : ((c.plexFile != null) ? 'f:' + c.plexFile : null));
    const saved = new Map();
    for (const clip of (oldClips || []) ) {
        const key = keyOf(clip);
        if ( (key !== null) && Array.isArray(clip.names) && ! saved.has(key) ) {
            saved.set(key, clip.names);
        }
    }
    return (newClips || []).map( (clip) => {
        const key = keyOf(clip);
        if ( (key === null) || ! saved.has(key) || (typeof(clip.names) !== 'undefined') ) {
            return clip;
        }
        return Object.assign({}, clip, { names: saved.get(key).slice() });
    } );
}

module.exports = {
    GROUPS: GROUPS,
    MAX_NAMES: MAX_NAMES,
    statusOf: statusOf,
    marksOf: marksOf,
    groupOf: groupOf,
    orderRows: orderRows,
    summarize: summarize,
    needsLook: needsLook,
    effective: effective,
    acceptAllPlan: acceptAllPlan,
    acceptAll: acceptAll,
    cleanPicks: cleanPicks,
    picksProblem: picksProblem,
    savePayload: savePayload,
    pendingCount: pendingCount,
    carryNames: carryNames,
};
