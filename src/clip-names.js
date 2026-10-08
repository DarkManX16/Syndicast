/*
 * What one entry of a clip's `names` can be, and how an entry is read. See
 * docs/blocks-spec.md, Stage 5, "Which shows a clip names".
 *
 * A name is one of:
 *
 *   "tv.Dragon Ball Z"                the show (also "custom.<id>" and "audio.<title>")
 *   "movie.Dragon Ball Z: Cooler's Revenge"
 *                                     that one movie, wherever it airs
 *   { show: "tv.Dragon Ball Z", season: 3 }
 *                                     one season of the show (0 is its specials)
 *   { show: "tv.Justice League", seasons: [3, 4, 5] }
 *                                     several seasons of one show (two or more, in order)
 *   { anyOf: ["tv.Even Stevens", "movie.Halloweentown"] }
 *                                     any one of several of the names here (two to eight, none an
 *                                     any-of): a clip that represents a show without announcing it
 *                                     (an actor's Wand ID: a show, or a movie the actor was in)
 *   { show: "tv.Dragon Ball Z", episode: "Bardock - The Father of Goku" }
 *                                     one episode of the show, by title: a special
 *
 * A show key is every name a clip had before movies and seasons, so every `names`
 * saved earlier reads unchanged. The other three are *specific*: they fit one movie,
 * season or episode and nothing else, where a show key fits every program of the show.
 *
 * Pure and free of I/O, like the modules that read it.
 */

/*
 * The movie length the names picker and the channel page's Movies tab share: a movie of 40
 * minutes or more. The movie items under that on the channels are shorts and episodes that a
 * custom show holds as movies, and listing them would bury the films.
 */
const MOVIE_MIN_MS = 40 * 60 * 1000;

// Whether a program is a movie that is long enough to be listed (picked, shown under Movies).
function isListableMovie(program) {
    return (program != null) && (program.type === 'movie') && (typeof(program.title) === 'string') && (program.title !== '')
        && (typeof(program.duration) === 'number') && (program.duration >= MOVIE_MIN_MS);
}

// A show a season or an episode belongs to is one with seasons: a series from Plex.
const SEASONED_SHOW = /^tv\..+/;

function isSeasonName(n) {
    return (n != null) && (typeof(n) === 'object') && (typeof(n.show) === 'string') && Object.prototype.hasOwnProperty.call(n, 'season');
}

function isSeasonsName(n) {
    return (n != null) && (typeof(n) === 'object') && (typeof(n.show) === 'string') && Object.prototype.hasOwnProperty.call(n, 'seasons');
}

function isAnyOfName(n) {
    return (n != null) && (typeof(n) === 'object') && Object.prototype.hasOwnProperty.call(n, 'anyOf');
}

// The most names one any-of name can hold.
const MAX_ANY_OF = 8;
// What an any-of member can be as a plain key: a show, a custom show or a movie. (An audio
// show is not one; a season or a special is an object.)
const ANY_OF_MEMBER = /^(tv|custom|movie)\..+/;

function isEpisodeName(n) {
    return (n != null) && (typeof(n) === 'object') && (typeof(n.show) === 'string') && Object.prototype.hasOwnProperty.call(n, 'episode');
}

/*
 * Whether `n` is a name that can be stored: a non-empty string, or an object of
 * exactly the two fields of one of the two shapes above. Anything else (an extra
 * field, a season that is not a whole number, a show that is not a "tv." key) is not
 * a name, so that what is stored is exactly what readers expect.
 */
function validName(n) {
    if ( (typeof(n) === 'string') && (n !== '') ) {
        return true;
    }
    if (isAnyOfName(n) && ! Array.isArray(n) ) {
        // Two to eight different names (a show, a custom show, a movie, seasons of a show or a
        // special; never another any-of), and nothing else in the object.
        return (Object.keys(n).length === 1) && (anyOfProblem(n.anyOf) === null);
    }
    if ( (n == null) || (typeof(n) !== 'object') || Array.isArray(n) || (typeof(n.show) !== 'string') || ! SEASONED_SHOW.test(n.show) ) {
        return false;
    }
    const fields = Object.keys(n).sort().join(',');
    if (fields === 'season,show') {
        return Number.isInteger(n.season) && (n.season >= 0);
    }
    if (fields === 'seasons,show') {
        // Two or more seasons, whole numbers from 0 up, ascending and without repeats: one
        // way to write each set, so equal names compare equal. One season is the shape above.
        return Array.isArray(n.seasons) && (n.seasons.length >= 2)
            && n.seasons.every( (x, i) => Number.isInteger(x) && (x >= 0) && ( (i === 0) || (x > n.seasons[i - 1]) ) );
    }
    if (fields === 'episode,show') {
        return (typeof(n.episode) === 'string') && (n.episode !== '');
    }
    return false;
}

/*
 * Whether `m` can be one of the names an any-of holds: a key of a show, a custom show or a
 * movie, or a season, several seasons or a special of a show; never another any-of.
 */
function isAnyOfMember(m) {
    if (typeof(m) === 'string') {
        return ANY_OF_MEMBER.test(m);
    }
    return (m != null) && (typeof(m) === 'object') && ! isAnyOfName(m) && validName(m);
}

/*
 * Why `members` are not an any-of name, as a sentence, or null when they are: two to eight
 * names that can be members, all different, and none a whole show next to a part of the
 * same show ("Even Stevens, or Even Stevens season 2" is just Even Stevens).
 */
function anyOfProblem(members) {
    if (! Array.isArray(members) ) {
        return 'an any-of is a list';
    }
    if (members.some( (m) => ! isAnyOfMember(m) )) {
        return 'a name in an any-of is not a show, a movie, a season of a show or a special';
    }
    if (new Set(members.map(nameId)).size !== members.length) {
        return 'the same name is picked twice in an any-of';
    }
    if (members.length < 2) {
        return 'an any-of needs two names';
    }
    if (members.length > MAX_ANY_OF) {
        return 'an any-of holds too many names';
    }
    const whole = new Set(members.filter( (m) => typeof(m) === 'string' ));
    if (members.some( (m) => (typeof(m) !== 'string') && whole.has(m.show) )) {
        return 'a whole show and a part of the same show are both in an any-of';
    }
    return null;
}

// One string for a name, equal for equal names: for comparing, de-duplicating and keys.
function nameId(n) {
    if (typeof(n) === 'string') {
        return n;
    }
    if (isSeasonName(n) ) {
        return `${n.show}#season:${n.season}`;
    }
    if (isSeasonsName(n) && Array.isArray(n.seasons) ) {
        return `${n.show}#seasons:${n.seasons.join(',')}`;
    }
    if (isEpisodeName(n) ) {
        return `${n.show}#episode:${n.episode}`;
    }
    if (isAnyOfName(n) && Array.isArray(n.anyOf) ) {
        // The same shows in another order are the same name.
        return 'anyOf:' + n.anyOf.map(nameId).sort().join('|');
    }
    return '#invalid';
}

function sameName(a, b) {
    return nameId(a) === nameId(b);
}

// The show key a name belongs to: itself for a show or a movie, the show of a season or episode.
function showOf(n) {
    return (typeof(n) === 'string') ? n : ( (n != null) && (typeof(n.show) === 'string') ? n.show : null );
}

// The show keys a name is about: itself for a show or a movie, the show of a season or an
// episode, the show or movie of every member of an any-of name (each once). [] for anything
// that is not a name.
function showsOf(n) {
    if (isAnyOfName(n) ) {
        return Array.isArray(n.anyOf) ? Array.from(new Set(n.anyOf.map(showOf).filter( (k) => k !== null ))) : [];
    }
    const key = showOf(n);
    return (key === null) ? [] : [key];
}

// Whether a name is for one movie, season or episode and not for a whole show. An any-of
// name is neither: how it ranks depends on the member that fits (see `fits`).
function isSpecific(n) {
    if (isAnyOfName(n) ) {
        return false;
    }
    return (typeof(n) !== 'string') || n.startsWith('movie.');
}

/*
 * How a name fits a program: 'specific' when it names that exact movie, season or
 * episode, 'show' when it names the show the program belongs to, false when it does
 * not fit. `showKey` is the function that gives a program's show key (the one in
 * transitions.js), passed in so this module needs nothing.
 */
function fits(name, program, showKey) {
    if ( (program == null) || (program.isOffline === true) ) {
        return false;
    }
    if (isAnyOfName(name) ) {
        // It ranks by the member that fits: 'specific' before the exact movie, season or
        // special of a member, 'show' before a program of a member that is a show. When more
        // than one member fits, the closer one.
        let best = false;
        for (const member of (Array.isArray(name.anyOf) ? name.anyOf : []) ) {
            const how = fits(member, program, showKey);
            if (how === 'specific') {
                return 'specific';
            }
            best = best || how;
        }
        return best;
    }
    if (typeof(name) === 'string') {
        if (name.startsWith('movie.')) {
            return ( (program.type === 'movie') && (('movie.' + program.title) === name) ) ? 'specific' : false;
        }
        return (showKey(program) === name) ? 'show' : false;
    }
    if ( (program.type !== 'episode') || (('tv.' + program.showTitle) !== name.show) ) {
        return false;
    }
    if (isSeasonName(name) ) {
        return (program.season === name.season) ? 'specific' : false;
    }
    if (isSeasonsName(name) ) {
        return (Array.isArray(name.seasons) && name.seasons.includes(program.season)) ? 'specific' : false;
    }
    if (isEpisodeName(name) ) {
        return (program.title === name.episode) ? 'specific' : false;
    }
    return false;
}

/*
 * The name for any one of some names, in the one shape that is stored: null when none are
 * given, the name itself for one, { anyOf } for two or more (repeats left out, the order
 * kept). Members are the names an any-of can hold (a show, a custom show, a movie, seasons
 * of a show or a special); anything else is left out. Whether the result is a valid name is
 * `validName`'s to say: at most eight, and no whole show beside a part of it.
 */
function anyOfName(members) {
    const seen = new Set();
    const list = [];
    for (const m of (Array.isArray(members) ? members : []) ) {
        if (isAnyOfMember(m) && ! seen.has(nameId(m)) ) {
            seen.add(nameId(m));
            list.push(m);
        }
    }
    if (list.length === 0) {
        return null;
    }
    return (list.length === 1) ? list[0] : { anyOf: list };
}

/*
 * The name for some seasons of a show, in the one shape that is stored: the show's key
 * when none are given, { show, season } for one, { show, seasons } (sorted, no repeats)
 * for several. `seasons` is an array of whole numbers; anything else in it is left out.
 */
function seasonsName(show, seasons) {
    const list = Array.from(new Set((Array.isArray(seasons) ? seasons : []).filter( (x) => Number.isInteger(x) && (x >= 0) ))).sort( (a, b) => a - b );
    if (list.length === 0) {
        return show;
    }
    return (list.length === 1) ? { show: show, season: list[0] } : { show: show, seasons: list };
}

// The seasons a season or seasons name is for, ascending; [] for any other name.
function seasonsOf(n) {
    if (isSeasonName(n) ) {
        return [n.season];
    }
    return (isSeasonsName(n) && Array.isArray(n.seasons) ) ? n.seasons.slice() : [];
}

/*
 * Seasons as people read them: "Seasons 3–5", "Seasons 3, 5, 7–9", "Season 3"; season 0
 * is "Specials" ("Specials, Seasons 3–5").
 */
function seasonsLabel(seasons) {
    const list = seasons.filter( (x) => x !== 0 );
    const runs = [];
    for (const x of list) {
        const last = runs[runs.length - 1];
        if ( (typeof(last) !== 'undefined') && (x === last.to + 1) ) {
            last.to = x;
        } else {
            runs.push( { from: x, to: x } );
        }
    }
    const tokens = runs.map( (r) => (r.from === r.to) ? String(r.from) : (r.to === r.from + 1 ? `${r.from}, ${r.to}` : `${r.from}–${r.to}`) );
    const text = (list.length === 0) ? '' : ( (list.length === 1 ? 'Season ' : 'Seasons ') + tokens.join(', ') );
    return seasons.includes(0) ? ( (text === '') ? 'Specials' : 'Specials, ' + text ) : text;
}

/*
 * What a name reads as: the show's name, "Dragon Ball Z · Season 3", "Dragon Ball Z ·
 * Specials" for season 0, or the show and the episode. `showNames` maps a show or movie
 * key to its display name; a key it does not know reads as its own text without the
 * kind in front.
 */
function labelOf(n, showNames) {
    const names = showNames || {};
    const text = (key) => (typeof(names[key]) === 'string') ? names[key] : String(key).replace(/^[a-z]+\./, '');
    if (typeof(n) === 'string') {
        return text(n);
    }
    if (isAnyOfName(n) ) {
        // A member that is part of a show reads "Kim Possible (Seasons 1–2)", so the part is not
        // taken for the whole list's.
        const each = Array.isArray(n.anyOf) ? n.anyOf.map( (m) => labelOf(m, showNames).replace(/ · (.*)$/, ' ($1)') ) : [];
        return (each.length < 2) ? each.join('') : each.slice(0, -1).join(', ') + ' or ' + each[each.length - 1];
    }
    if (isSeasonName(n) ) {
        return `${text(n.show)} · ${n.season === 0 ? 'Specials' : 'Season ' + n.season}`;
    }
    if (isSeasonsName(n) && Array.isArray(n.seasons) ) {
        return `${text(n.show)} · ${seasonsLabel(n.seasons)}`;
    }
    if (isEpisodeName(n) ) {
        return `${text(n.show)} · “${n.episode}”`;
    }
    return '';
}

module.exports = {
    MOVIE_MIN_MS: MOVIE_MIN_MS,
    isListableMovie: isListableMovie,
    isSeasonName: isSeasonName,
    isSeasonsName: isSeasonsName,
    isAnyOfName: isAnyOfName,
    anyOfName: anyOfName,
    anyOfProblem: anyOfProblem,
    isAnyOfMember: isAnyOfMember,
    MAX_ANY_OF: MAX_ANY_OF,
    showsOf: showsOf,
    seasonsName: seasonsName,
    seasonsOf: seasonsOf,
    seasonsLabel: seasonsLabel,
    isEpisodeName: isEpisodeName,
    validName: validName,
    nameId: nameId,
    sameName: sameName,
    showOf: showOf,
    isSpecific: isSpecific,
    fits: fits,
    labelOf: labelOf,
};
