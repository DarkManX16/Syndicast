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
 *   { show: "tv.Dragon Ball Z", episode: "Bardock - The Father of Goku" }
 *                                     one episode of the show, by title: a special
 *
 * A show key is every name a clip had before movies and seasons, so every `names`
 * saved earlier reads unchanged. The other three are *specific*: they fit one movie,
 * season or episode and nothing else, where a show key fits every program of the show.
 *
 * Pure and free of I/O, like the modules that read it.
 */

// A show a season or an episode belongs to is one with seasons: a series from Plex.
const SEASONED_SHOW = /^tv\..+/;

function isSeasonName(n) {
    return (n != null) && (typeof(n) === 'object') && (typeof(n.show) === 'string') && Object.prototype.hasOwnProperty.call(n, 'season');
}

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
    if ( (n == null) || (typeof(n) !== 'object') || Array.isArray(n) || (typeof(n.show) !== 'string') || ! SEASONED_SHOW.test(n.show) ) {
        return false;
    }
    const fields = Object.keys(n).sort().join(',');
    if (fields === 'season,show') {
        return Number.isInteger(n.season) && (n.season >= 0);
    }
    if (fields === 'episode,show') {
        return (typeof(n.episode) === 'string') && (n.episode !== '');
    }
    return false;
}

// One string for a name, equal for equal names: for comparing, de-duplicating and keys.
function nameId(n) {
    if (typeof(n) === 'string') {
        return n;
    }
    if (isSeasonName(n) ) {
        return `${n.show}#season:${n.season}`;
    }
    if (isEpisodeName(n) ) {
        return `${n.show}#episode:${n.episode}`;
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

// Whether a name is for one movie, season or episode and not for a whole show.
function isSpecific(n) {
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
    if (isEpisodeName(name) ) {
        return (program.title === name.episode) ? 'specific' : false;
    }
    return false;
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
    if (isSeasonName(n) ) {
        return `${text(n.show)} · ${n.season === 0 ? 'Specials' : 'Season ' + n.season}`;
    }
    if (isEpisodeName(n) ) {
        return `${text(n.show)} · “${n.episode}”`;
    }
    return '';
}

module.exports = {
    isSeasonName: isSeasonName,
    isEpisodeName: isEpisodeName,
    validName: validName,
    nameId: nameId,
    sameName: sameName,
    showOf: showOf,
    isSpecific: isSpecific,
    fits: fits,
    labelOf: labelOf,
};
