/*
 * Which show a filler clip is about. See docs/blocks-spec.md, Stage 5, "Which
 * shows a clip names".
 *
 * A transition step that wants "the Up Next for the show that follows" needs to
 * know which show each clip names, and nobody is going to type that per pair:
 * channel 1 has 281 distinct adjacent show pairs in a week. So the mapping
 * lives on the clip, as `names: [showKey]` or, for a clip that announces several
 * shows, `names: [showKey, showKey, ...]` in the order they air (the one coming up
 * first; four at most), and is proposed here from the clip's title. This module only
 * proposes. It reads titles, a vocabulary and aliases and returns answers; it
 * writes nothing, and the review screen (a later step) is what fixes a proposal
 * and saves it.
 *
 * Pure and free of I/O, like day-parts.js and transitions.js, so it can be
 * driven from a test, from the filler-list route, or from a script over a copy
 * of the data folder.
 */

const clipNames = require('./clip-names');

const KIND_ORDER = { custom: 0, tv: 1, audio: 2, movie: 3 };

/*
 * The most shows one clip names. "Miguzi - Next Bumper (TMNT-Static Shock-Teen
 * Titans)" names three; more than a few in one bumper is a list that happens to
 * mention shows, and the ones past the limit are counted, not named.
 */
const MAX_NAMES = 4;

/*
 * A show title shorter than this is not matched. "Up" is a real show, and "Up
 * Next" would name it on every promo that says so.
 */
const MIN_TITLE_LENGTH = 3;

/*
 * A title is read through different spacing only when it is at least this many
 * letters with its spaces taken out: "dragonballgt" yes, a handful of short
 * words run together no.
 */
const MIN_RESPACED_LENGTH = 6;

/*
 * Last words that describe the kind of thing a title is and a clip leaves off:
 * "Mobile Suit Gundam Series", "The Tex Avery Show".
 */
const GENERIC_TAIL = /^(.*\S) (?:series|show)$/;

// The most clip words that are joined to be compared with a title's squashed form.
const MAX_RESPACED_WORDS = 8;

/*
 * A program shorter than this is a clip someone put in a lineup (a NEXT promo
 * inserted by hand, an ident), not an episode, so it does not make a show. On
 * channel 1 the four such clips are movie items of 10-15 seconds, and the
 * shortest real episode in the lineup is over three minutes. Left in, a clip
 * titled "[As] NEXT - Home Movies (2003)" would be a show of its own, and as the
 * longest title it would beat "Home Movies" on the very clips this exists for.
 * Custom shows are exempt: a custom show of short gags is a show.
 */
const CLIP_MAX_MS = 60 * 1000;

/*
 * A movie is offered by its subtitle (and as a movie to pick) only when it runs at
 * least this long. On the channels the movie items that are shorter are shorts and
 * episodes a custom show holds as movies - Looney Tunes, a gym-class cartoon - and
 * a subtitle of one of those would be matched against every clip's title.
 */
const MOVIE_MIN_MS = clipNames.MOVIE_MIN_MS;

/*
 * Words that do not make a subtitle a title of its own: "The Movie" is the end of
 * a hundred titles. A subtitle made only of these (and of the everyday words below,
 * and numbers) is never offered.
 */
const SUBTITLE_STOP = new Set(['movie', 'movies', 'film', 'films', 'part', 'parts', 'chapter', 'volume', 'vol', 'episode', 'act']);

/*
 * Plex tells two shows of one name apart with a year in the title, "ThunderCats
 * (2011)", and a clip rarely says it. This is a trailing "(2011)", "[2011]" or
 * "('83)".
 */
const TRAILING_YEAR = /\s*[(\[]\s*'?\d{2,4}\s*[)\]]\s*$/;

/*
 * A show whose title is "The X" with a single word left can drop "The" only
 * where that word stands alone as its own segment of the clip title - "Up Next
 * Bumper (Jeffersons)" - and not as part of a phrase, or "Office Space" would
 * name The Office. Under this length it is never offered: "The Wire" would be
 * any clip with a wire in it.
 */
const STANDALONE_MIN_LENGTH = 5;

/*
 * Words that describe what a clip is, not which show it is about. They are the
 * floor under the "used elsewhere" rule in learnAliases: that rule can only see
 * a word is generic when the corpus happens to contain a clip of another show
 * that uses it, and a list that is all one show's promos has none.
 */
const STRUCTURAL = new Set([
    'promo', 'promos', 'bumper', 'bumpers', 'bump', 'bumps', 'comm', 'comms', 'commercial',
    'trailer', 'teaser', 'preview', 'intro', 'outro', 'ident', 'next', 'later', 'tonight',
    'tomorrow', 'videogame', 'video', 'game', 'dvd', 'toy', 'toys', 'season', 'series', 'show',
    'new', 'special', 'episode', 'the', 'and', 'for', 'with', 'from', 'you', 'your', 'now', 'then',
    'more', 'back', 'back2back', 'b2b',
]);

/*
 * Case, accents and punctuation folded away, so "Aqua Teen: Hunger-Force!" and
 * "aqua teen hunger force" are the same text. "&" reads as "and", which is how
 * "The Grim Adventures of Billy & Mandy" is written in a clip title as often
 * as not.
 */
function fold(text) {
    return String(text == null ? '' : text)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function keyKind(key) {
    return key.slice(0, key.indexOf('.'));
}

/*
 * The initials of a title: "Teenage Mutant Ninja Turtles (2003)" is TMNT. The
 * trailing year goes, a word with no letter or digit in it ("&") carries no
 * initial, and a leading "The", "A" or "An" is dropped when `dropArticle`.
 */
function initialsOf(name, dropArticle) {
    let words = name.replace(TRAILING_YEAR, '').trim().split(/\s+/);
    if (dropArticle && (words.length > 1) && /^(the|a|an)$/i.test(words[0])) {
        words = words.slice(1);
    }
    return words.filter( (w) => /[A-Za-z0-9]/.test(w) )
        .map( (w) => /[A-Za-z0-9]/.exec(w)[0] ).join('').toUpperCase();
}

/*
 * The abbreviations a clip title may use: initials of three or more letters that
 * are the initials of exactly one show. Each title counts both with and without
 * a leading article ("The Tex Avery Show" is TAS or TTAS), and the initials of a
 * subtitle count too, only to make an abbreviation ambiguous and never to give it
 * a meaning: "TAS" is also the initials of "The Animated Series", so it names no
 * show. Initials that two shows share ("G.I. Joe" of two eras) name none; those
 * are for the review screen. Returns a Map of the lower-case initials to the key.
 */
function abbreviationsOf(found) {
    const owners = new Map();
    const note = (initials, key) => {
        if (/^[A-Z]{3,}$/.test(initials)) {
            if (! owners.has(initials) ) {
                owners.set(initials, { keys: new Set(), meanings: new Set() });
            }
            owners.get(initials).keys.add(key);
            return owners.get(initials);
        }
        return null;
    };
    for (const [key, titles] of found) {
        for (const name of titles) {
            const colon = name.indexOf(':');
            for (const drop of [true, false]) {
                const whole = note(initialsOf(name, drop), key);
                if (whole !== null) {
                    whole.meanings.add(key);
                }
                if (colon > 0) {
                    note(initialsOf(name.slice(colon + 1), drop), key);
                }
            }
        }
    }
    const abbreviations = new Map();
    for (const [initials, owner] of owners) {
        if ( (owner.keys.size === 1) && (owner.meanings.size === 1) ) {
            abbreviations.set(initials.toLowerCase(), Array.from(owner.keys)[0]);
        }
    }
    return abbreviations;
}

/*
 * The shows a clip can name: every show key that any channel's programs or
 * slots carry, with the title it is known by. `channels` is an array of channel
 * objects (programs and scheduleBackup.slots are read, nothing else) and
 * `customShowNames` maps a custom show id to its current name, which wins over
 * the name stamped on its programs and is the only way to name a custom show
 * that a slot references and no program carries yet.
 *
 * `customShows` (optional) is every custom show's own definition - `{ id, name,
 * content }` as CustomShowDB.getAllShows() gives them - read for its movies
 * alone: a movie of at least MOVIE_MIN_MS in a custom show's own catalog is a
 * name a clip can take whether or not that movie is in any channel's current
 * lineup, since a custom show's rotation moves on long before Time Slots is
 * re-run to match. `channels` still carries every other kind of name (shows,
 * custom shows themselves, tracks) and whatever movies it finds besides.
 *
 * Returns { entries, names, ambiguous }: entries are { key, name, folded }
 * longest title first (so the longest is tried first), names maps a key to its
 * display name, and ambiguous maps a folded title that more than one key owns
 * to those keys.
 */
function buildVocabulary(channels, customShowNames, customShows) {
    const customNames = customShowNames || {};
    const found = new Map();           // key -> Set of names it is known by
    const display = {};
    const movies = new Map();          // title -> the custom show it is in, or null: a movie of at least MOVIE_MIN_MS
    const specialTitles = new Map();   // show key -> Set of the titles of its season 0 episodes
    const seasonsSeen = new Map();     // show key -> Set of the seasons of its episodes
    const add = (key, name) => {
        if ( (typeof(name) !== 'string') || (name === '') ) {
            return;
        }
        if (! found.has(key) ) {
            found.set(key, new Set());
        }
        found.get(key).add(name);
        if (typeof(display[key]) === 'undefined') {
            display[key] = name;
        }
    };
    const addCustom = (id, stamped) => {
        const key = 'custom.' + id;
        if (typeof(customNames[id]) === 'string') {
            display[key] = customNames[id];
            add(key, customNames[id]);
        }
        add(key, stamped);
    };

    for (const channel of channels) {
        for (const program of (channel.programs || []) ) {
            if ( (program == null) || (program.isOffline === true) ) {
                continue;
            }
            if (clipNames.isListableMovie(program) ) {
                movies.set(program.title, (typeof(program.customShowId) !== 'undefined') ? (program.customShowName || 'a custom show') : null);
            }
            if ( (program.type === 'episode') && (typeof(program.showTitle) === 'string') && Number.isInteger(program.season)
                && (typeof(program.customShowId) === 'undefined') ) {
                const showKey = 'tv.' + program.showTitle;
                if (! seasonsSeen.has(showKey) ) {
                    seasonsSeen.set(showKey, new Set());
                }
                seasonsSeen.get(showKey).add(program.season);
                if ( (program.season === 0) && (typeof(program.title) === 'string') && (program.title !== '') ) {
                    if (! specialTitles.has(showKey) ) {
                        specialTitles.set(showKey, new Set());
                    }
                    specialTitles.get(showKey).add(program.title);
                }
            }
            if (typeof(program.customShowId) !== 'undefined') {
                addCustom(program.customShowId, program.customShowName);
            } else if ( (typeof(program.duration) === 'number') && (program.duration < CLIP_MAX_MS) ) {
                continue;
            } else if (program.type === 'episode') {
                add('tv.' + program.showTitle, program.showTitle);
            } else if (program.type === 'track') {
                add('audio.' + program.showTitle, program.showTitle);
            } else if (program.type === 'movie') {
                add('movie.' + program.title, program.title);
            }
        }
        const slots = (channel.scheduleBackup && channel.scheduleBackup.slots) || [];
        for (const slot of slots) {
            const id = (slot == null) ? undefined : slot.showId;
            if (typeof(id) !== 'string') {
                continue;
            }
            if (id.startsWith('custom.') && (id.length > 'custom.'.length) ) {
                const customId = id.slice('custom.'.length);
                if (typeof(customNames[customId]) === 'string') {
                    addCustom(customId, undefined);
                }
            } else if (id.startsWith('tv.') && (id.length > 'tv.'.length) ) {
                add(id, id.slice('tv.'.length));
            } else if (id.startsWith('audio.') && (id.length > 'audio.'.length) ) {
                add(id, id.slice('audio.'.length));
            }
        }
    }

    // Every custom show's own catalog, for its movies alone - the same two things a
    // movie in a channel's lineup gets above (`movies`, the whole title in `found`),
    // so a clip can name a movie whether or not its custom show currently airs it.
    for (const show of (customShows || []) ) {
        if (show == null) {
            continue;
        }
        const customName = (typeof(customNames[show.id]) === 'string') ? customNames[show.id] : show.name;
        for (const item of (show.content || []) ) {
            if (clipNames.isListableMovie(item) ) {
                if (! movies.has(item.title) ) {
                    movies.set(item.title, (typeof(customName) === 'string') ? customName : 'a custom show');
                }
                add('movie.' + item.title, item.title);
            }
        }
    }

    const entries = [];
    const standalone = [];
    const owners = {};
    const byLength = (a, b) => (b.folded.length - a.folded.length)
        || (KIND_ORDER[keyKind(a.key)] - KIND_ORDER[keyKind(b.key)])
        || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
    const shortenedForms = [];     // { key, name, folded }: a title's shortened forms, offered once every whole title is known
    const wholeTitles = new Set(); // the folded text of every whole title, of every show
    for (const [key, titles] of found) {
        const seen = new Set();
        const offer = (name, folded, alone, shortened) => {
            if ( (folded.length < MIN_TITLE_LENGTH) || seen.has(folded) ) {
                return;
            }
            seen.add(folded);
            const entry = { key: key, name: name, folded: folded };
            if (shortened) {
                entry.shortened = true;
            } else {
                wholeTitles.add(folded);
            }
            (alone ? standalone : entries).push(entry);
            (owners[folded] = owners[folded] || new Set()).add(key);
        };
        for (const name of titles) {
            // The part of a title before its colon, "Ghost in the Shell" for
            // "Ghost in the Shell: Stand Alone Complex": what a clip says when it
            // is short for the show. Offered after the loop, below.
            const colon = name.indexOf(':');
            if (colon > 0) {
                shortenedForms.push( { key: key, name: name, folded: fold(name.slice(0, colon)) } );
            }
            // A generic last word dropped, "Mobile Suit Gundam" for "Mobile Suit
            // Gundam Series" and "Tex Avery" for "The Tex Avery Show", where at
            // least two words are left.
            const tail = GENERIC_TAIL.exec(fold(name.replace(TRAILING_YEAR, '')));
            if ( (tail !== null) && (tail[1].indexOf(' ') !== -1) ) {
                shortenedForms.push( { key: key, name: name, folded: tail[1] } );
            }
            // The title as Plex has it, then without a trailing year ("ThunderCats
            // (2011)"), and each of those without a leading article.
            const forms = [ fold(name) ];
            const withoutYear = fold(name.replace(TRAILING_YEAR, ''));
            if (withoutYear !== forms[0]) {
                forms.push(withoutYear);
            }
            for (const folded of forms) {
                offer(name, folded, false);
                const bare = folded.replace(/^(the|a|an) /, '');
                if (bare === folded) {
                    continue;
                }
                if (bare.indexOf(' ') !== -1) {
                    offer(name, bare, false);
                } else if (bare.length >= STANDALONE_MIN_LENGTH) {
                    offer(name, bare, true);
                }
            }
        }
    }
    // Shortened forms last, so that one equal to any show's whole title (the plain
    // "Transformers" beside "Transformers: Robots In Disguise") is left to that
    // title, which is the more certain answer. Two shows sharing a shortened form
    // ("G.I. Joe" for two eras) are both offered and reported as ambiguous.
    const shortSeen = new Set();
    const offerShortened = (key, name, folded) => {
        const once = key + '|' + folded;
        if ( (folded.length < MIN_TITLE_LENGTH) || wholeTitles.has(folded) || shortSeen.has(once) ) {
            return;
        }
        shortSeen.add(once);
        entries.push( { key: key, name: name, folded: folded, shortened: true } );
        (owners[folded] = owners[folded] || new Set()).add(key);
    };
    for (const form of shortenedForms) {
        offerShortened(form.key, form.name, form.folded);
        const bare = form.folded.replace(/^(the|a|an) /, '');
        if ( (bare !== form.folded) && (bare.indexOf(' ') !== -1) ) {
            offerShortened(form.key, form.name, bare);
        }
    }

    // A movie names itself by its subtitle, the part after its colon ("Cooler's Revenge"
    // for "Dragon Ball Z: Cooler's Revenge"), and a clip that gives it is for that movie,
    // not for the show it belongs to. `parent` is that show, when a channel has it: a
    // clip that names both is read as naming the movie alone (see propose).
    const wholeOwner = {};
    for (const e of entries) {
        if (! e.shortened && ! e.key.startsWith('movie.') && (typeof(wholeOwner[e.folded]) === 'undefined') ) {
            wholeOwner[e.folded] = e.key;
        }
    }
    const parentOfMovie = (title) => {
        const colon = title.indexOf(':');
        return (colon > 0) ? wholeOwner[fold(title.slice(0, colon))] : undefined;
    };
    for (const e of entries) {
        if (e.key.startsWith('movie.') ) {
            e.specific = 'movie';
            e.parent = parentOfMovie(e.name);
        }
    }
    const subtitleForms = (text) => {
        const out = [];
        for (const piece of [text].concat(text.split(/\s[-\u2013\u2014]\s/)) ) {
            const whole = fold(piece);
            for (const form of [whole, whole.replace(/^(the|a|an) /, '')]) {
                const words = form.split(' ');
                if ( (words.length >= 2) && (form.length >= MIN_TITLE_LENGTH) && (out.indexOf(form) === -1)
                    && ! words.every( (w) => /^\d+$/.test(w) || STRUCTURAL.has(w) || FILLER_WORDS.has(w) || SUBTITLE_STOP.has(w) ) ) {
                    out.push(form);
                }
            }
        }
        return out;
    };
    const specificSeen = new Set();
    for (const [title, inCustom] of movies) {
        const key = 'movie.' + title;
        display[key] = title;
        const colon = title.indexOf(':');
        if (colon < 0) {
            continue;
        }
        for (const folded of subtitleForms(title.slice(colon + 1)) ) {
            const once = key + '|' + folded;
            if (wholeTitles.has(folded) || specificSeen.has(once) ) {
                continue;
            }
            specificSeen.add(once);
            entries.push( { key: key, name: title, folded: folded, specific: 'movie', parent: parentOfMovie(title), subtitle: true } );
            (owners[folded] = owners[folded] || new Set()).add(key);
        }
    }
    entries.sort(byLength);
    standalone.sort(byLength);
    const ambiguous = {};
    for (const folded of Object.keys(owners)) {
        if (owners[folded].size > 1) {
            ambiguous[folded] = Array.from(owners[folded]).sort();
        }
    }
    // Every title with its spaces taken out, so a clip that spaces a title
    // differently ("DragonBall GT" for "Dragon Ball GT", "Inu Yasha" for "InuYasha")
    // can still be read. A title under MIN_RESPACED_LENGTH letters is left out: run
    // together from a few short words it would be found in too many places.
    const squashed = new Map();
    for (const entry of entries) {
        const together = entry.folded.replace(/ /g, '');
        if (together.length < MIN_RESPACED_LENGTH) {
            continue;
        }
        if (! squashed.has(together) ) {
            squashed.set(together, []);
        }
        squashed.get(together).push(entry);
    }
    // The movies a clip can be for: every movie key above (a movie that is not in a custom
    // show is a key whatever its length) and every long movie of a custom show.
    const movieList = [];
    for (const key of Object.keys(display) ) {
        if (key.startsWith('movie.') ) {
            const title = key.slice('movie.'.length);
            movieList.push( { key: key, name: display[key], custom: movies.has(title) ? movies.get(title) : null } );
        }
    }
    movieList.sort( (a, b) => a.name.localeCompare(b.name) );
    // The specials of each show (its season 0 episodes), with the forms a clip may give
    // each by: the whole title and its pieces either side of a dash. A single word is
    // never one, and the show's own name has to be in the clip as well (see propose).
    const specials = new Map();
    for (const [showKey, titles] of specialTitles) {
        specials.set(showKey, Array.from(titles).sort().map( (title) => ({ title: title, forms: subtitleForms(title) }) )
            .filter( (sp) => sp.forms.length > 0 ));
    }
    const seasons = {};
    for (const [showKey, set] of seasonsSeen) {
        seasons[showKey] = Array.from(set).sort( (a, b) => a - b );
    }
    return { entries: entries, standalone: standalone, names: display, ambiguous: ambiguous, squashed: squashed,
        abbreviations: abbreviationsOf(found), movies: movieList, specials: specials, seasons: seasons };
}

/*
 * Finds the show titles in a folded text, longest first, and blanks out what it
 * found so a shorter title inside a longer one ("Dragon Ball" in "Dragon Ball
 * Z") is never read as a second show. Returns the hits and the text with the
 * matched words gone.
 */
function consumeTitles(title, vocabulary, known, taken) {
    // `taken` is the folded text with some words already blanked (see ownTitleNicknames).
    let text = (typeof(taken) === 'string') ? taken : ' ' + fold(title) + ' ';
    const hits = [];
    const take = (entry, at, needle, alone) => {
        const hit = { pos: at + 1, end: at + needle.length - 1, key: entry.key, text: entry.folded, via: 'title' };
        if (alone) {
            hit.standalone = true;      // a one-word title, found only because it stood alone: less certain
        }
        if (entry.shortened) {
            hit.shortened = true;       // found by a shortened form of the title ("from a shortened title"): less certain
        }
        if (entry.abbreviation) {
            hit.abbreviation = true;    // found by the initials of the title ("from an abbreviation"): less certain
        }
        if (entry.specific) {
            hit.specific = entry.specific;      // a movie, by its title or its subtitle: for that movie alone
            hit.parent = entry.parent;
            if (entry.subtitle) {
                hit.subtitle = true;
            }
        }
        const others = vocabulary.ambiguous[entry.folded];
        if (typeof(others) !== 'undefined') {
            hit.alsoKeys = others.filter( (k) => k !== entry.key );
        }
        hits.push(hit);
        text = text.slice(0, at) + ' '.repeat(needle.length) + text.slice(at + needle.length);
    };
    for (const entry of vocabulary.entries) {
        const needle = ' ' + entry.folded + ' ';
        const at = text.indexOf(needle);
        if (at !== -1) {
            take(entry, at, needle);
        }
    }
    // Titles the clip spaces differently, found among the words still left and only
    // where they sit side by side (a title taken out between two words breaks the
    // join). The longest comes first, as above.
    const squashed = vocabulary.squashed;
    if (squashed) {
        const words = [];
        const wordPattern = /\S+/g;
        let word;
        while ( (word = wordPattern.exec(text)) !== null ) {
            words.push( { text: word[0], at: word.index } );
        }
        const found = [];
        for (let i = 0; i < words.length; i++) {
            let joined = '';
            for (let k = 0; (k < MAX_RESPACED_WORDS) && (i + k < words.length); k++) {
                if ( (k > 0) && (words[i + k].at !== words[i + k - 1].at + words[i + k - 1].text.length + 1) ) {
                    break;
                }
                joined += words[i + k].text;
                const owners = squashed.get(joined);
                if (typeof(owners) === 'undefined') {
                    continue;
                }
                for (const entry of owners) {
                    found.push( { entry: entry, length: joined.length, start: words[i].at, end: words[i + k].at + words[i + k].text.length } );
                }
            }
        }
        found.sort( (a, b) => (b.length - a.length) || (a.start - b.start) );
        const used = [];
        for (const f of found) {
            if (used.some( (u) => (f.start < u.end) && (u.start < f.end) )) {
                continue;
            }
            used.push(f);
            take(f.entry, f.start - 1, ' ' + text.slice(f.start, f.end) + ' ');
        }
    }
    // Initials, as written in capitals: "TMNT" is Teenage Mutant Ninja Turtles. A word
    // the user has taught as an alias means what they taught, so it is left to that,
    // and a show already found by its title is not found a second time.
    if (vocabulary.abbreviations) {
        const capitals = new Set((String(title == null ? '' : title).match(/\b[A-Z]{3,}\b/g) || []).map( (w) => w.toLowerCase() ));
        for (const word of capitals) {
            const key = vocabulary.abbreviations.get(word);
            if ( (typeof(key) === 'undefined') || ( known && Object.prototype.hasOwnProperty.call(known, word) )
                || hits.some( (h) => h.key === key ) ) {
                continue;
            }
            const needle = ' ' + word + ' ';
            const at = text.indexOf(needle);
            if (at !== -1) {
                take( { key: key, folded: word, abbreviation: true }, at, needle);
            }
        }
    }
    // One-word titles that dropped their "The" count only as a segment of their
    // own: between brackets, dashes, colons or slashes, or the whole title.
    const segments = new Set(String(title == null ? '' : title)
        .split(/[()\[\]\-–—:;|\/,]+/).map(fold).filter( (s) => s !== '' ));
    for (const entry of (vocabulary.standalone || []) ) {
        if (! segments.has(entry.folded) ) {
            continue;
        }
        const needle = ' ' + entry.folded + ' ';
        const at = text.indexOf(needle);
        if (at !== -1) {
            take(entry, at, needle, true);
        }
    }
    return { hits: hits, remaining: text };
}

/*
 * What stands between the shows of a title that names several: a slash with a
 * space either side ("Now/Then (A / B)", written with the fraction slash U+2044,
 * U+2215 or a plain slash) or the word "to" before something that starts like a
 * title ("CN Next (A to B)"; the quotes allowed are plain and curly). "Now/Then"
 * itself, a slash with no spaces, is not one.
 */
const PAIR_SEPARATORS = [
    /\s[⁄∕\/]\s/g,
    /\sto\s(?=[A-Z0-9"'‘“(\[])/g,
];

/*
 * Words that do not make a piece of a title a show of its own: the words that
 * describe a clip, numbers, and small joining words.
 */
const FILLER_WORDS = new Set(['a', 'an', 'of', 'to', 'in', 'on', 'at']);

function contentWords(text, minLength) {
    return text.split(' ').filter( (w) => (w !== '') && (w.length >= minLength)
        && ! /^\d+$/.test(w) && ! STRUCTURAL.has(w) && ! FILLER_WORDS.has(w) );
}

/*
 * One stretch of a title cut by separators into pieces, each piece meant to be a
 * show. `separators` are { index, length } in `text`, in order; `hits` are what
 * was found in `text`. Returns whether the title is half-read: some piece holds a
 * show that was found and another piece, with a word of at least `minLength`
 * letters that is not a filler, holds none.
 *
 * A hit that straddles a separator is one title that happens to contain it
 * ("Space Ghost Coast to Coast", "Spider-Man"), so that separator is not one and
 * the pieces either side of it are one piece. A piece that holds two different
 * shows is not one show of a list, so the stretch is not a list and is not
 * half-read. With `guarded`, a piece that holds a show and also words that are not
 * part of it ("The Brady Bunch Kitty") is not a show by itself either.
 */
function scopeHalfRead(text, hits, separators, guarded, minLength) {
    const whole = fold(text);
    const boundsOf = (sep) => ({
        leftEnd: fold(text.slice(0, sep.index)).length,
        rightFrom: whole.length - fold(text.slice(sep.index + sep.length)).length,
    });
    let seps = separators.filter( (sep) => (fold(text.slice(0, sep.index)) !== '') && (fold(text.slice(sep.index + sep.length)) !== '') );
    for (;;) {
        const straddled = seps.findIndex( (sep) => {
            const b = boundsOf(sep);
            return hits.some( (h) => ! ((h.end - 1 <= b.leftEnd) || (h.pos - 1 >= b.rightFrom)) );
        } );
        if (straddled === -1) {
            break;
        }
        seps.splice(straddled, 1);
    }
    if (seps.length === 0) {
        return false;
    }
    const pieces = [];
    let from = 0;
    for (const sep of seps) {
        const b = boundsOf(sep);
        pieces.push( { from: from, to: b.leftEnd } );
        from = b.rightFrom;
    }
    pieces.push( { from: from, to: whole.length } );
    let seen = false;
    let blank = false;
    for (const piece of pieces) {
        const inside = hits.filter( (h) => (h.pos - 1 >= piece.from) && (h.end - 1 <= piece.to) );
        const letters = whole.slice(piece.from, piece.to).split('');
        for (const h of inside) {
            for (let i = h.pos - 1; i < h.end - 1; i++) {
                letters[i - piece.from] = ' ';
            }
        }
        if (inside.length > 0) {
            seen = true;
            if (new Set(inside.map( (h) => h.key )).size > 1) {
                return false;
            }
            if (guarded && (contentWords(letters.join(''), 1).length > 0) ) {
                return false;
            }
        } else if (contentWords(letters.join(''), minLength).length > 0) {
            blank = true;
        }
    }
    return seen && blank;
}

/*
 * Whether a title is built as several shows but not all of them were found: the
 * pieces of a title cut at a spaced slash or "to" (the whole title), or at the
 * hyphens inside one pair of brackets ("(TMNT-Static-Teen Titans)", one bracket
 * at a time so a hyphen in one does not make another half of a pair). A hyphen
 * inside a show's own title ("Scooby-Doo", "X-Men") is not one: the hit for the
 * title straddles it, which scopeHalfRead takes as that. See scopeHalfRead.
 */
function halfRead(title, hits, vocabulary, known) {
    if (hits.length === 0) {
        return false;
    }
    const text = String(title == null ? '' : title);
    const separators = [];
    for (const pattern of PAIR_SEPARATORS) {
        pattern.lastIndex = 0;
        let found;
        while ( (found = pattern.exec(text)) !== null ) {
            separators.push( { index: found.index, length: found[0].length } );
        }
    }
    separators.sort( (a, b) => a.index - b.index );
    if (scopeHalfRead(text, hits, separators, false, 1)) {
        return true;
    }
    const groups = /[(\[]([^()\[\]]*)[)\]]/g;
    let group;
    while ( (group = groups.exec(text)) !== null ) {
        const content = group[1];
        const hyphens = [];
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '-') {
                hyphens.push( { index: i, length: 1 } );
            }
        }
        if ( (hyphens.length > 0) && scopeHalfRead(content, findHits(content, vocabulary, known), hyphens, true, 3) ) {
            return true;
        }
    }
    return false;
}

/*
 * What a clip's title says it is about. Show titles are looked for first,
 * longest first; the words left over are then looked up as aliases. Whatever is
 * found is ordered by where it sits in the title: one show proposes [show], two
 * in order propose [now, then] - the same show found twice is one show - and a
 * third is reported as `extra` and not proposed. Nothing found proposes [].
 *
 * `found` says what matched and how, for a review screen to show. A hit found by
 * a shortened form of a title (the part before a colon) carries `shortened: true`,
 * and one found by the initials of a title ("TMNT") carries `abbreviation: true`.
 * A title built as several shows ("A to B", "Now/Then (A / B)", "(A-B-C)") of
 * which not all were recognised proposes nothing and carries
 * `unresolved: { recognised, reason }`.
 */
function findHits(title, vocabulary, known) {
    const ahead = ownTitleNicknames(title, vocabulary, known);
    const { hits, remaining } = consumeTitles(title, vocabulary, known, ahead.text);
    hits.push(...ahead.hits);
    hits.push(...takeNicknames(remaining, aliasEntries(known)).hits);
    hits.sort( (a, b) => a.pos - b.pos );
    return hits;
}

// The hit a nickname makes at `at` in a folded text, with what it narrows the show to.
function nicknameHit(alias, at, needle) {
    const hit = { pos: at + 1, end: at + needle.length - 1, key: alias.key, text: alias.folded, via: 'alias' };
    if (typeof(alias.season) === 'number') {
        hit.season = alias.season;      // a nickname for one season of the show
    }
    if (Array.isArray(alias.seasons) ) {
        hit.seasons = alias.seasons.slice();    // ... or for several of its seasons
    }
    if (Array.isArray(alias.anyOf) ) {
        hit.anyOf = alias.anyOf.slice();        // ... or for any one of several shows
    }
    return hit;
}

/*
 * Every place the given nicknames (longest first) occur in a folded text as whole
 * words, blanking each so a shorter one never reads inside it. Returns the hits and
 * the text with them blanked.
 */
function takeNicknames(folded, entries) {
    const hits = [];
    let text = folded;
    for (const alias of entries) {
        const needle = ' ' + alias.folded + ' ';
        for (let from = 0; ; ) {
            const at = text.indexOf(needle, from);
            if (at === -1) {
                break;
            }
            hits.push(nicknameHit(alias, at, needle));
            text = text.slice(0, at) + ' '.repeat(needle.length) + text.slice(at + needle.length);
            from = at + needle.length - 1;
        }
    }
    return { hits: hits, text: text };
}

/*
 * A nickname for some seasons of a show may contain the show's own title ("justice
 * league unlimited" for seasons 3 to 5 of Justice League). Titles are looked for first
 * and a nickname only in what they leave, so such a phrase would never be found: the
 * title would take "justice league" and leave "unlimited". These nicknames are
 * therefore looked for in the whole title before the titles are. No other nickname is
 * (none can contain a title of the show it names without being a longer title), so
 * every nickname taught before reads as it did. Returns the hits and the folded text
 * with their words blanked, which consumeTitles then reads.
 */
function ownTitleNicknames(title, vocabulary, known) {
    const folded = ' ' + fold(title) + ' ';
    const own = aliasEntries(known).filter( (alias) => alias.narrows === true
        && vocabulary.entries.some( (e) => alias.keys.includes(e.key) && (e.specific !== true) && (e.folded !== alias.folded)
            && containsPhrase(alias.folded, e.folded) ) );
    if (own.length === 0) {
        return { hits: [], text: folded };
    }
    const taken = takeNicknames(folded, own);
    return { hits: taken.hits, text: taken.text };
}

/*
 * The taught nicknames as the matcher reads them: folded the way titles are, so
 * "Foster's" is the phrase "foster s" and "gundam 0083" is two words, and ordered
 * longest first (most words, then most letters), so a phrase wins over a word
 * that sits inside it. A nickname is a word or a phrase, matched as whole words,
 * and only in what the show titles left over, as a single word always was.
 */
function aliasEntries(known) {
    const entries = [];
    for (const word of Object.keys(known) ) {
        const folded = fold(word);
        if ( (folded !== '') && (typeof(known[word]) === 'string') ) {
            entries.push( { folded: folded, key: known[word], keys: [known[word]], words: folded.split(' ').length } );
        } else if ( (folded !== '') && clipNames.isSeasonName(known[word]) && clipNames.validName(known[word]) ) {
            entries.push( { folded: folded, key: known[word].show, keys: [known[word].show], season: known[word].season, narrows: true, words: folded.split(' ').length } );
        } else if ( (folded !== '') && clipNames.isSeasonsName(known[word]) && clipNames.validName(known[word]) ) {
            entries.push( { folded: folded, key: known[word].show, keys: [known[word].show], seasons: known[word].seasons.slice(), narrows: true, words: folded.split(' ').length } );
        } else if ( (folded !== '') && clipNames.isAnyOfName(known[word]) && clipNames.validName(known[word]) ) {
            // A nickname for any one of several names. A hit needs a key: this one is made up from the
            // names, and never a show's own, so nothing else reads it as one (see nameOfHit). `keys` are
            // the shows and movies its members are about; `anyOf` the members themselves.
            entries.push( { folded: folded, key: 'any:' + clipNames.nameId(known[word]), keys: clipNames.showsOf(known[word]), anyOf: known[word].anyOf.slice(),
                narrows: true, words: folded.split(' ').length } );
        }
    }
    entries.sort( (a, b) => (b.words - a.words) || (b.folded.length - a.folded.length) || ((a.folded < b.folded) ? -1 : 1) );
    return entries;
}

/*
 * What the hits of a title say once movies, specials and seasons are read. The hits
 * are the shows (and movies) the title's words matched; this narrows them.
 *
 *   - A movie that was found takes the place of the show it belongs to: "DragonBall Z
 *     Movie Cooler's Revenge Intro" is for that movie, not for any episode of the show.
 *   - A show hit whose special's title is also in the clip is that special, which
 *     is one episode of the show (season 0): "DragonBall Z Special Bardock Father of
 *     Goku Intro". The show has to be named as well, or "The Musical Time Machine"
 *     would be a special of a show that has an episode called "Time Machine".
 *   - A season: a taught season nickname ("frieza saga") narrows a hit of its show
 *     to that season, and stands for the season by itself when the show is not named;
 *     failing that, "Season 6" narrows the hit of the show before it (or the only
 *     show). A season read from "Season N" is less certain: a promo for "Hannah
 *     Montana Season 1 DVD" is for the DVD, and may be for the whole show.
 *
 * Returns the narrowed hits, new objects, in the order of the title.
 */
function refineHits(title, hits, vocabulary) {
    let out = hits.map( (h) => Object.assign({}, h) );
    const folded = fold(title);

    const specials = vocabulary.specials;
    if (specials != null) {
        out = out.map( (h) => {
            if ( h.specific || ! specials.has(h.key) ) {
                return h;
            }
            let best = null;
            let tie = false;
            for (const special of specials.get(h.key) ) {
                for (const form of special.forms) {
                    if (! containsPhrase(folded, form) ) {
                        continue;
                    }
                    if ( (best === null) || (form.length > best.length) ) {
                        best = { title: special.title, length: form.length };
                        tie = false;
                    } else if ( (form.length === best.length) && (special.title !== best.title) ) {
                        tie = true;
                    }
                }
            }
            return ( (best === null) || tie ) ? h : Object.assign({}, h, { special: best.title });
        } );
    }

    const parents = new Set(out.filter( (h) => (h.specific === 'movie') && (typeof(h.parent) === 'string') ).map( (h) => h.parent ));
    out = out.filter( (h) => h.specific || (typeof(h.special) === 'string') || ! parents.has(h.key) );

    for (const nick of out.filter( (h) => (h.via === 'alias') && hasSeason(h) ) ) {
        const mate = out.find( (h) => (h !== nick) && ! h.specific && (h.key === nick.key) && ! hasSeason(h) && (typeof(h.special) !== 'string') );
        if (typeof(mate) !== 'undefined') {
            if (Array.isArray(nick.seasons) ) {
                mate.seasons = nick.seasons.slice();
            } else {
                mate.season = nick.season;
            }
            nick.merged = true;
        }
    }

    const padded = ' ' + folded + ' ';
    const seasonWord = / season (\d{1,2}) /g;
    let found;
    while ( (found = seasonWord.exec(padded)) !== null ) {
        const at = found.index + 1;
        const shows = out.filter( (h) => ! h.specific && /^tv\./.test(h.key) && (typeof(h.special) !== 'string') && ! hasSeason(h) );
        const before = shows.filter( (h) => h.pos <= at );
        const target = (before.length > 0) ? before[before.length - 1]
            : ( (out.filter( (h) => /^tv\./.test(h.key) ).length === 1) && (shows.length === 1) ? shows[0] : undefined );
        if (typeof(target) !== 'undefined') {
            target.season = parseInt(found[1], 10);
            target.seasonFromTitle = true;
        }
        seasonWord.lastIndex = found.index + found[0].length - 1;
    }
    return out;
}

// The name a refined hit stands for: the show or movie key, or a season or an episode of a show.
function nameOfHit(hit) {
    if (Array.isArray(hit.anyOf) ) {
        return clipNames.anyOfName(hit.anyOf);
    }
    if ( (typeof(hit.special) === 'string') && /^tv\./.test(hit.key) ) {
        return { show: hit.key, episode: hit.special };
    }
    if ( (typeof(hit.season) === 'number') && /^tv\./.test(hit.key) ) {
        return { show: hit.key, season: hit.season };
    }
    if ( Array.isArray(hit.seasons) && /^tv\./.test(hit.key) ) {
        return clipNames.seasonsName(hit.key, hit.seasons);
    }
    return hit.key;
}

// Whether a hit has been narrowed to a season, or to several.
function hasSeason(hit) {
    return (typeof(hit.season) === 'number') || Array.isArray(hit.seasons);
}

/*
 * A title that says "movie", "film" or "special" right after a show that no channel
 * airs a movie or special of: it is for one the lineup does not have, and naming the
 * whole show would play it before any episode. And a title that says "saga" when no
 * season nickname has been taught for it: it is for part of a show and does not say
 * which. Both are left unnamed and flagged, like a title of several shows with one not
 * recognised. Returns { kind, reason } or null.
 */
function unreadable(title, refined, vocabulary) {
    const folded = ' ' + fold(title) + ' ';
    const words = folded.trim().split(' ');
    const shows = refined.filter( (h) => ! h.specific && (h.merged !== true) && (typeof(h.special) !== 'string') && /^(tv|custom)\./.test(h.key) );
    for (const h of shows) {
        // `end` is the position just past the hit in the folded text, with its leading space.
        const after = folded.slice(h.end + 1).trim().split(' ')[0];
        if ( /^(movie|movies|film|special|specials)$/.test(after) && ! refined.some( (o) => o.parent === h.key || (o.specific === 'movie') ) ) {
            return { kind: 'movie', reason: `The title seems to be for a movie or special of ${vocabulary.names[h.key] || 'a show'}, but no movie or special like it is on a channel, so it would be read as the whole show. Put the movie on a channel, or pick the show it is for.` };
        }
    }
    if ( (words.indexOf('saga') !== -1) && (refined.length > 0) && ! refined.some(hasSeason) ) {
        return { kind: 'saga', reason: 'The title names a saga, which is part of a show and does not say which. Teach it as a season nickname (for example “frieza saga” for season 3), or pick the show.' };
    }
    return null;
}

function propose(title, vocabulary, aliases) {
    const known = aliases || {};
    const hits = findHits(title, vocabulary, known);
    // What the hits recognised, as names: a show's key, or the any-of name a nickname stands for.
    const keys = [];
    for (const hit of hits) {
        const recognised = Array.isArray(hit.anyOf) ? clipNames.anyOfName(hit.anyOf) : hit.key;
        if (! keys.some( (k) => clipNames.sameName(k, recognised) )) {
            keys.push(recognised);
        }
    }
    const strip = (list) => list.map( (h) => { const { pos, end, ...rest } = h; return rest; } );
    if (halfRead(title, hits, vocabulary, known)) {
        // Naming only the shows that were found would make a clip that says "A, then
        // B" play as a clip for B alone, and would make A's nickname look like a word
        // of another show when it is taught. Left unnamed, and flagged, for the
        // review screen.
        return {
            names: [],
            found: strip(hits),
            extra: 0,
            unresolved: { kind: 'several', recognised: keys.slice(), reason: 'The title seems to name several shows, but not all of them were recognised.' },
        };
    }
    const refined = refineHits(title, hits, vocabulary);
    const names = [];
    // The same show twice is one name; two any-of names are the same only when their shows are.
    const sameShow = (a, b) => (clipNames.isAnyOfName(a) || clipNames.isAnyOfName(b)) ? clipNames.sameName(a, b) : (clipNames.showOf(a) === clipNames.showOf(b));
    for (const hit of refined) {
        if (hit.merged === true) {
            continue;       // a season nickname that narrowed the hit of its own show: it is in `found`, not a name of its own
        }
        const name = nameOfHit(hit);
        const at = names.findIndex( (n) => sameShow(n, name) );
        if (at === -1) {
            names.push(name);
        } else if ( (typeof(names[at]) === 'string') && (typeof(name) !== 'string') ) {
            names[at] = name;       // the same show twice, once narrowed to a season or an episode: keep that
        }
    }
    // A show the title names itself beats a nickname for any of several shows that includes it:
    // "Christy Carlson Romano Kim Possible Promo" is for Kim Possible, not for Even Stevens too.
    const plainShows = new Set(names.filter( (n) => ! clipNames.isAnyOfName(n) ).map(clipNames.showOf));
    for (let i = names.length - 1; i >= 0; i--) {
        if (clipNames.isAnyOfName(names[i]) && clipNames.showsOf(names[i]).some( (k) => plainShows.has(k) )) {
            names.splice(i, 1);
        }
    }
    const trouble = unreadable(title, refined, vocabulary);
    if (trouble !== null) {
        return {
            names: [],
            found: strip(refined),
            extra: 0,
            unresolved: { kind: trouble.kind, recognised: names.slice(), reason: trouble.reason },
        };
    }
    return {
        names: names.slice(0, MAX_NAMES),
        found: strip(refined),
        extra: Math.max(0, names.length - MAX_NAMES),
    };
}

/*
 * What to learn when someone maps a clip to a show: the words of its title that
 * are not a show title become aliases for that show (`SGC2C` for Space Ghost
 * Coast to Coast), so the next proposal over the same list finds the rest of
 * them. Read literally that would turn every word into one - "Adult", "Swim",
 * "NEXT" - and then name the wrong show on every clip that says them, so a word
 * is not learned when:
 *
 *   - it is a number (a year, an episode count);
 *   - it already means a show (known if the same one, "taken by another show"
 *     if not - the review screen is where that is settled, never a silent
 *     overwrite);
 *   - it is part of a show title in this clip;
 *   - it appears in a clip of the corpus that names a different show: "adult"
 *     does, in an Adult Swim promo for Cowboy Bebop, which is what marks it as
 *     the channel's word and not a show's;
 *   - it is a structural word ("promo", "next"), the floor under the last rule
 *     for a list in which nothing else happens to use it;
 *   - it is under three letters.
 *
 * `corpus` is [{ title, names }] for the clips to compare against; the clip
 * being learned from is skipped by title. Nothing passed in is changed.
 * Returns { added: { word: showKey }, skipped: [{ word, reason }] }.
 */
function learnAliases(title, showKey, vocabulary, aliases, corpus) {
    const known = aliases || {};
    // `showKey` is the show the nickname is for, or the shows (any one of them) when it is for several.
    const targetKeys = Array.isArray(showKey) ? showKey : [showKey];
    const folded = fold(title);
    const explained = new Set();
    const { remaining } = consumeTitles(title, vocabulary, known);
    const left = new Set(remaining.split(' ').filter( (w) => w !== '' ));
    for (const word of folded.split(' ')) {
        if ( (word !== '') && ! left.has(word) ) {
            explained.add(word);
        }
    }
    const elsewhere = new Set();
    for (const clip of (corpus || []) ) {
        if (clip.title === title) {
            continue;
        }
        const names = Array.isArray(clip.names) ? clip.names : [];
        if ( (names.length === 0) || namesShow(names, targetKeys) ) {
            continue;
        }
        for (const word of fold(clip.title).split(' ')) {
            elsewhere.add(word);
        }
    }

    const added = {};
    const skipped = [];
    const seen = new Set();
    for (const word of folded.split(' ')) {
        if ( (word === '') || seen.has(word) ) {
            continue;
        }
        seen.add(word);
        let reason = null;
        if (/^\d+$/.test(word) ) {
            reason = 'number';
        } else if (Object.prototype.hasOwnProperty.call(known, word) ) {
            reason = targetKeys.some( (k) => (known[word] === k) || (clipNames.showOf(known[word]) === k) ) ? 'already known' : 'taken by another show';
        } else if (explained.has(word) ) {
            reason = 'part of a show title';
        } else if (elsewhere.has(word) ) {
            reason = 'used elsewhere';
        } else if (STRUCTURAL.has(word) ) {
            reason = 'structural';
        } else if (word.length < 3) {
            reason = 'too short';
        }
        if (reason === null) {
            added[word] = showKey;
        } else {
            skipped.push( { word: word, reason: reason } );
        }
    }
    return { added: added, skipped: skipped };
}

// Whether any of a clip's names is the show (or the movie) `showKey`, a season or an episode of it or an
// any-of name that includes it. `showKey` may be a list of keys: whether any of them is named.
function namesShow(names, showKey) {
    const keys = Array.isArray(showKey) ? showKey : [showKey];
    return names.some( (n) => clipNames.showsOf(n).some( (k) => keys.includes(k) ) );
}

/*
 * Whether a folded text contains a folded phrase as whole words.
 */
function containsPhrase(foldedText, foldedPhrase) {
    return (' ' + foldedText + ' ').indexOf(' ' + foldedPhrase + ' ') !== -1;
}

// The most words in a nickname: a longer one is a title, and titles are matched as titles.
const MAX_NICKNAME_WORDS = 6;
// A stretch of leftover words longer than this is a title's worth of words, not a nickname worth offering.
const MAX_SUGGESTED_PHRASE_WORDS = 3;

/*
 * Why a nickname's text and meaning cannot be taught, as sentences, [] when they can. `alias` is
 * `text` folded. The rules that do not depend on any clip: the meaning is a show on a channel
 * (or some seasons of one, or any of several), the text is a word or a phrase of at most six
 * words that is not only everyday words, not already a title and not already a nickname in
 * `known`. checkNickname adds what the clips say; the Nicknames page uses this one alone.
 */
function nicknameProblems(text, alias, target, vocabulary, known) {
    const problems = [];
    const words = alias.split(' ');
    const display = (name) => (typeof(name) === 'string') && (vocabulary.names[name] == null) ? name : clipNames.labelOf(name, vocabulary.names);
    // What a nickname names: a show, one season of a show, several, or any one of several
    // shows (`target` is its key, or { show, season }, { show, seasons }, { anyOf }).
    const targetKeys = clipNames.showsOf(target);
    if ( (targetKeys.length === 0) || targetKeys.some( (k) => typeof(vocabulary.names[k]) === 'undefined' )
        || ( (typeof(target) !== 'string') && ! ( (clipNames.isSeasonName(target) || clipNames.isSeasonsName(target) || clipNames.isAnyOfName(target)) && clipNames.validName(target)) ) ) {
        problems.push('Pick the show it names first.');
    }
    if (words.length > MAX_NICKNAME_WORDS) {
        problems.push(`That is ${words.length} words; a nickname is at most ${MAX_NICKNAME_WORDS}.`);
    }
    const generic = (w) => /^\d+$/.test(w) || STRUCTURAL.has(w) || FILLER_WORDS.has(w);
    if (words.every( (w) => /^\d+$/.test(w) )) {
        problems.push('A number on its own cannot name a show.');
    } else if (words.every(generic) ) {
        problems.push(`“${text}” is made only of everyday words (like “next” or “promo”), which many shows' clips use, so it cannot name one show.`);
    } else if ( (words.length === 1) && (alias.length < 3) ) {
        problems.push('A nickname needs at least three letters.');
    }
    if (Object.prototype.hasOwnProperty.call(known, alias) ) {
        problems.push(clipNames.sameName(known[alias], target) ? 'That is already a nickname for this show.'
            : `“${text}” already means ${display(known[alias])}.`);
    }
    const asTitle = vocabulary.entries.find( (e) => e.folded === alias );
    if (typeof(asTitle) !== 'undefined') {
        problems.push(`“${text}” is already the title of ${display(asTitle.key)}.`);
    }
    return problems;
}

/*
 * Whether a nickname is acceptable, and what it would do. The screen calls this
 * before a nickname is saved (to show which clips it would name), and the save
 * calls it again, so a refused nickname is refused whichever way it arrives.
 *
 *   text      what was typed: a word or a phrase ("static", "grim advs", "Foster's")
 *   showKey   the show it names
 *   clips     every clip to compare against, [{ list, index, title, names, reviewed }]:
 *             `names` are the clip's saved names, `reviewed` when it was marked as
 *             naming no show. A clip with saved names is never changed by a nickname.
 *   options.sourceTitle   the clip it is being taught from, which it must end up naming
 *
 * A nickname is refused when it is made only of generic words (a number, "next",
 * "promo", a word under three letters), when it is already a title or already
 * means a show, and when it is a word that other shows' clips use: it would change
 * the suggestion for a clip that already names a different show ("Adult" does, in
 * an Adult Swim promo for Cowboy Bebop), or appears in a clip saved as naming a
 * different one. It is also refused when the clip it is taught from would not be
 * named by it, which says the title is read some other way.
 *
 * Returns { alias, ok, problems: [string], newly, changed, sourceNames,
 * sourceUnresolved }: `alias` is the form that is stored (folded), `sourceNames`
 * the names the clip it is taught from would then have (when one was given; []
 * when its title still has a show that is not recognised, `sourceUnresolved`), `newly` the unsaved clips it would
 * give a name to,
 * { list, index, title, names }, and `changed` the clips whose suggestion it would
 * alter or that are saved under a different show, { list, index, title, names }.
 * Nothing passed in is changed.
 */
function checkNickname(text, target, vocabulary, aliases, clips, options) {
    const known = aliases || {};
    const alias = fold(text);
    const problems = [];
    const result = { alias: alias, ok: false, problems: problems, newly: [], changed: [] };
    if (alias === '') {
        problems.push('Type a word or a phrase.');
        return result;
    }
    const display = (name) => (typeof(name) === 'string') && (vocabulary.names[name] == null) ? name : clipNames.labelOf(name, vocabulary.names);
    const targetKeys = clipNames.showsOf(target);
    problems.push(...nicknameProblems(text, alias, target, vocabulary, known));
    if (problems.length > 0) {
        return result;
    }

    const withIt = Object.assign({}, known);
    withIt[alias] = target;
    const same = (a, b) => (a.length === b.length) && a.every( (n, i) => clipNames.sameName(n, b[i]) );
    const sameShow = (x, y) => (clipNames.isAnyOfName(x) || clipNames.isAnyOfName(y)) ? clipNames.sameName(x, y) : (clipNames.showOf(x) === clipNames.showOf(y));
    const sameShows = (a, b) => (a.length === b.length) && a.every( (n, i) => sameShow(n, b[i]) );
    for (const clip of (clips || []) ) {
        if (! containsPhrase(fold(clip.title), alias) ) {
            continue;
        }
        const saved = namesOf(clip);
        const hasSaved = (saved.length > 0) || (clip.reviewed === true);
        const entry = { list: clip.list, index: clip.index, title: clip.title };
        if (hasSaved) {
            if ( (saved.length > 0) && ! namesShow(saved, targetKeys) ) {
                result.changed.push( Object.assign(entry, { names: saved }) );
            }
            continue;
        }
        const before = propose(clip.title, vocabulary, known).names;
        const after = propose(clip.title, vocabulary, withIt).names;
        if (same(before, after) ) {
            continue;
        }
        // A clip that already names the same shows and is only narrowed to a season is
        // given a more exact suggestion, which is what the nickname is for; one that
        // names other shows would be changed to something else.
        if ( (before.length === 0) || sameShows(before, after) ) {
            result.newly.push( Object.assign(entry, { names: after }) );
        } else {
            result.changed.push( Object.assign(entry, { names: before }) );
        }
    }
    if (result.changed.length > 0) {
        const sample = result.changed.slice(0, 3).map( (c) => `“${c.title}”`).join(', ');
        problems.push(`Other shows' clips use “${text}”: it would change the suggestion for `
            + `${result.changed.length} clip${result.changed.length === 1 ? '' : 's'} that name a different show (${sample}`
            + `${result.changed.length > 3 ? ', and more' : ''}), so it is not a nickname for one show.`);
    }
    const source = (options != null) ? options.sourceTitle : undefined;
    if ( (typeof(source) === 'string') && (problems.length === 0) ) {
        const named = propose(source, vocabulary, withIt);
        result.sourceNames = named.names;
        result.sourceUnresolved = (named.unresolved != null);
        // The nickname has to be what the clip's title is read by. The clip may still not
        // be named (a title of two shows where the other one is not recognised either):
        // that is for the next nickname.
        if (! named.found.some( (h) => (h.via === 'alias') && (h.text === alias) ) ) {
            problems.push(`“${text}” would not be used for the clip you are teaching it from (“${source}”): `
                + ( (named.unresolved != null) ? 'its title still has a show that is not recognised.'
                    : 'its title is read as ' + (named.names.length === 0 ? 'no show' : named.names.map(display).join(', ')) + '.' ));
        }
    }
    result.ok = (problems.length === 0);
    return result;
}

/*
 * What to offer when someone teaches a nickname from a clip: the words of its
 * title that learnAliases would learn, and the stretches of leftover words (the
 * ones no show title took) that run two or more words, trimmed of "next", "promo"
 * and the like at either end - "gundam 0083" from "Gundam 0083 NEXT". Each is
 * { text, alias }: `text` as the title spells it, `alias` as it is stored. A phrase
 * that also appears in a clip of `corpus` ([{ title, names }]) naming a different
 * show is not offered: it is the channel's word, not the show's ("Adult Swim").
 * These are only offers; checkNickname decides.
 */
function nicknameSuggestions(title, target, vocabulary, aliases, corpus) {
    const targetKeys = clipNames.showsOf(target);
    const showKey = targetKeys[0];
    const known = aliases || {};
    const out = [];
    const seen = new Set();
    const spell = (words) => {
        const pattern = new RegExp(words.map( (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ).join('[^A-Za-z0-9]+'), 'i');
        const found = pattern.exec(String(title));
        return (found !== null) ? found[0] : words.join(' ');
    };
    const elsewhere = [];
    for (const clip of (corpus || []) ) {
        const names = Array.isArray(clip.names) ? clip.names : [];
        if ( (names.length > 0) && ! namesShow(names, targetKeys) ) {
            elsewhere.push(fold(clip.title));
        }
    }
    const offer = (words) => {
        const alias = words.join(' ');
        if ( (alias !== '') && ! seen.has(alias) && ! Object.prototype.hasOwnProperty.call(known, alias)
            && ! elsewhere.some( (t) => containsPhrase(t, alias) ) ) {
            seen.add(alias);
            out.push( { text: spell(words), alias: alias } );
        }
    };
    const { remaining } = consumeTitles(title, vocabulary, known);
    // For some seasons of a show, the show's own title with the word next to it ("justice
    // league unlimited"): such a nickname is matched against the whole title, so the
    // title's words are part of it.
    if ( (typeof(target) !== 'string') && ! clipNames.isAnyOfName(target) ) {
        const folded = ' ' + fold(title) + ' ';
        const own = vocabulary.entries.filter( (e) => (e.key === showKey) && (e.specific !== true) && (folded.indexOf(' ' + e.folded + ' ') !== -1) )[0];
        if (typeof(own) !== 'undefined') {
            const at = folded.indexOf(' ' + own.folded + ' ');
            const ownWords = own.folded.split(' ');
            const usable = (w, from) => (w !== '') && (remaining.substr(from, w.length) === w) && ! /^\d+$/.test(w) && ! STRUCTURAL.has(w) && ! FILLER_WORDS.has(w);
            const afterFrom = at + own.folded.length + 2;
            const after = folded.slice(afterFrom).split(' ')[0];
            if (usable(after, afterFrom) ) {
                offer(ownWords.concat([after]));
            }
            const beforeWords = folded.slice(0, at).trim().split(' ');
            const before = beforeWords[beforeWords.length - 1];
            const beforeFrom = at - before.length;
            if ( (before !== '') && usable(before, beforeFrom) ) {
                offer([before].concat(ownWords));
            }
        }
    }
    const tokens = [];
    const pattern = /\S+/g;
    let m;
    while ( (m = pattern.exec(remaining)) !== null ) {
        tokens.push( { word: m[0], at: m.index } );
    }
    const trimmable = (w) => STRUCTURAL.has(w) || FILLER_WORDS.has(w);
    let run = [];
    const flush = () => {
        while ( (run.length > 0) && trimmable(run[0]) ) { run.shift(); }
        while ( (run.length > 0) && trimmable(run[run.length - 1]) ) { run.pop(); }
        if ( (run.length >= 2) && (run.length <= MAX_SUGGESTED_PHRASE_WORDS) ) {
            offer(run);
        } else if (run.length > MAX_SUGGESTED_PHRASE_WORDS) {
            // A stretch too long to be one nickname often starts with one: a person's name
            // followed by "Wand ID" ("christy carlson romano wand"). Only the start is offered,
            // and only when it does not run across a bracket of the title.
            let words = run.slice(0, MAX_SUGGESTED_PHRASE_WORDS);
            while ( (words.length > 0) && trimmable(words[0]) ) { words = words.slice(1); }
            while ( (words.length > 0) && trimmable(words[words.length - 1]) ) { words = words.slice(0, -1); }
            if ( (words.length >= 2) && ! /[()\[\]]/.test(spell(words)) ) {
                offer(words);
            }
        }
        run = [];
    };
    for (let i = 0; i < tokens.length; i++) {
        if ( (i > 0) && (tokens[i].at !== tokens[i - 1].at + tokens[i - 1].word.length + 1) ) {
            flush();
        }
        run.push(tokens[i].word);
    }
    flush();
    const learned = learnAliases(title, targetKeys, vocabulary, known, corpus);
    for (const word of Object.keys(learned.added) ) {
        offer([word]);
    }
    return out;
}

/*
 * The names a clip carries, as the rest of the code should see them: one to four
 * show keys, or [] for a clip that names nothing (no field, or one that is not
 * a valid shape - namesProblem is what says so). Hands back a copy.
 */
function namesOf(clip) {
    if ( (clip == null) || ! Array.isArray(clip.names) ) {
        return [];
    }
    if ( (clip.names.length < 1) || (clip.names.length > MAX_NAMES) ) {
        return [];
    }
    if (! clip.names.every(clipNames.validName) ) {
        return [];
    }
    return clip.names.slice();
}

/*
 * Why a clip's `names` is not usable, or null when it is usable or absent. For
 * the save-time warning in filler-db.js, which tells the user and rewrites
 * nothing.
 */
function namesProblem(clip) {
    if ( (clip == null) || (typeof(clip.names) === 'undefined') ) {
        return null;
    }
    if (! Array.isArray(clip.names) ) {
        return `names is ${typeof(clip.names)} rather than an array of one to four show keys`;
    }
    if (clip.names.length > MAX_NAMES) {
        return `names holds ${clip.names.length} entries, and should hold one to four show keys`;
    }
    if (! clip.names.every(clipNames.validName) ) {
        return 'names holds something that is not a show key (a non-empty string such as "tv.Futurama", or a season or an episode of a show)';
    }
    return null;
}

/*
 * A clip whose names is an empty list was reviewed and names no show ("Names no
 * show" on the review screen). It plays as any unnamed clip does; the difference
 * is that the screen remembers the decision, so no suggestion is made for it again
 * and "accept all" leaves it alone.
 */
function isReviewedNone(clip) {
    return (clip != null) && Array.isArray(clip.names) && (clip.names.length === 0);
}

module.exports = {
    MAX_NAMES: MAX_NAMES,
    MOVIE_MIN_MS: MOVIE_MIN_MS,
    fold: fold,
    buildVocabulary: buildVocabulary,
    propose: propose,
    learnAliases: learnAliases,
    namesOf: namesOf,
    namesProblem: namesProblem,
    isReviewedNone: isReviewedNone,
    checkNickname: checkNickname,
    nicknameProblems: nicknameProblems,
    nicknameSuggestions: nicknameSuggestions,
};
