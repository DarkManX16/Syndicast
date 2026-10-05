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
 * Returns { entries, names, ambiguous }: entries are { key, name, folded }
 * longest title first (so the longest is tried first), names maps a key to its
 * display name, and ambiguous maps a folded title that more than one key owns
 * to those keys.
 */
function buildVocabulary(channels, customShowNames) {
    const customNames = customShowNames || {};
    const found = new Map();           // key -> Set of names it is known by
    const display = {};
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
    return { entries: entries, standalone: standalone, names: display, ambiguous: ambiguous, squashed: squashed,
        abbreviations: abbreviationsOf(found) };
}

/*
 * Finds the show titles in a folded text, longest first, and blanks out what it
 * found so a shorter title inside a longer one ("Dragon Ball" in "Dragon Ball
 * Z") is never read as a second show. Returns the hits and the text with the
 * matched words gone.
 */
function consumeTitles(title, vocabulary, known) {
    let text = ' ' + fold(title) + ' ';
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
    const { hits, remaining } = consumeTitles(title, vocabulary, known);
    const wordPattern = /\S+/g;
    let match;
    while ( (match = wordPattern.exec(remaining)) !== null ) {
        const key = known[match[0]];
        if ( (typeof(key) === 'string') && Object.prototype.hasOwnProperty.call(known, match[0]) ) {
            hits.push( { pos: match.index, end: match.index + match[0].length, key: key, text: match[0], via: 'alias' } );
        }
    }
    hits.sort( (a, b) => a.pos - b.pos );
    return hits;
}

function propose(title, vocabulary, aliases) {
    const known = aliases || {};
    const hits = findHits(title, vocabulary, known);
    const keys = [];
    for (const hit of hits) {
        if (keys.indexOf(hit.key) === -1) {
            keys.push(hit.key);
        }
    }
    const found = hits.map( (h) => { const { pos, end, ...rest } = h; return rest; } );
    if (halfRead(title, hits, vocabulary, known)) {
        // Naming only the shows that were found would make a clip that says "A, then
        // B" play as a clip for B alone, and would make A's nickname look like a word
        // of another show when it is taught. Left unnamed, and flagged, for the
        // review screen.
        return {
            names: [],
            found: found,
            extra: 0,
            unresolved: { recognised: keys.slice(), reason: 'The title seems to name several shows, but not all of them were recognised.' },
        };
    }
    return {
        names: keys.slice(0, MAX_NAMES),
        found: found,
        extra: Math.max(0, keys.length - MAX_NAMES),
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
        const clipNames = Array.isArray(clip.names) ? clip.names : [];
        if ( (clipNames.length === 0) || (clipNames.indexOf(showKey) !== -1) ) {
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
            reason = (known[word] === showKey) ? 'already known' : 'taken by another show';
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
    if (! clip.names.every( (k) => (typeof(k) === 'string') && (k !== '') ) ) {
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
    if ( (clip.names.length < 1) || (clip.names.length > MAX_NAMES) ) {
        return `names holds ${clip.names.length} entries, and should hold one to four show keys`;
    }
    if (! clip.names.every( (k) => (typeof(k) === 'string') && (k !== '') ) ) {
        return 'names holds something that is not a show key (a non-empty string such as "tv.Futurama")';
    }
    return null;
}

module.exports = {
    MAX_NAMES: MAX_NAMES,
    fold: fold,
    buildVocabulary: buildVocabulary,
    propose: propose,
    learnAliases: learnAliases,
    namesOf: namesOf,
    namesProblem: namesProblem,
};
