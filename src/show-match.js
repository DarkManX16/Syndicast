/*
 * Which show a filler clip is about. See docs/blocks-spec.md, Stage 5, "Which
 * shows a clip names".
 *
 * A transition step that wants "the Up Next for the show that follows" needs to
 * know which show each clip names, and nobody is going to type that per pair:
 * channel 1 has 281 distinct adjacent show pairs in a week. So the mapping
 * lives on the clip, as `names: [showKey]` or `names: [showKey, showKey]`
 * (now, then), and is proposed here from the clip's title. This module only
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
 * A show title shorter than this is not matched. "Up" is a real show, and "Up
 * Next" would name it on every promo that says so.
 */
const MIN_TITLE_LENGTH = 3;

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
    for (const [key, titles] of found) {
        const seen = new Set();
        const offer = (name, folded, alone) => {
            if ( (folded.length < MIN_TITLE_LENGTH) || seen.has(folded) ) {
                return;
            }
            seen.add(folded);
            (alone ? standalone : entries).push( { key: key, name: name, folded: folded } );
            (owners[folded] = owners[folded] || new Set()).add(key);
        };
        for (const name of titles) {
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
    entries.sort(byLength);
    standalone.sort(byLength);
    const ambiguous = {};
    for (const folded of Object.keys(owners)) {
        if (owners[folded].size > 1) {
            ambiguous[folded] = Array.from(owners[folded]).sort();
        }
    }
    return { entries: entries, standalone: standalone, names: display, ambiguous: ambiguous };
}

/*
 * Finds the show titles in a folded text, longest first, and blanks out what it
 * found so a shorter title inside a longer one ("Dragon Ball" in "Dragon Ball
 * Z") is never read as a second show. Returns the hits and the text with the
 * matched words gone.
 */
function consumeTitles(title, vocabulary) {
    let text = ' ' + fold(title) + ' ';
    const hits = [];
    const take = (entry, at, needle, alone) => {
        const hit = { pos: at + 1, key: entry.key, text: entry.folded, via: 'title' };
        if (alone) {
            hit.standalone = true;      // a one-word title, found only because it stood alone: less certain
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
 * What a clip's title says it is about. Show titles are looked for first,
 * longest first; the words left over are then looked up as aliases. Whatever is
 * found is ordered by where it sits in the title: one show proposes [show], two
 * in order propose [now, then] - the same show found twice is one show - and a
 * third is reported as `extra` and not proposed. Nothing found proposes [].
 *
 * `found` says what matched and how, for a review screen to show.
 */
function propose(title, vocabulary, aliases) {
    const known = aliases || {};
    const { hits, remaining } = consumeTitles(title, vocabulary);
    const wordPattern = /\S+/g;
    let match;
    while ( (match = wordPattern.exec(remaining)) !== null ) {
        const key = known[match[0]];
        if ( (typeof(key) === 'string') && Object.prototype.hasOwnProperty.call(known, match[0]) ) {
            hits.push( { pos: match.index, key: key, text: match[0], via: 'alias' } );
        }
    }
    hits.sort( (a, b) => a.pos - b.pos );
    const keys = [];
    for (const hit of hits) {
        if (keys.indexOf(hit.key) === -1) {
            keys.push(hit.key);
        }
    }
    return {
        names: keys.slice(0, 2),
        found: hits.map( (h) => { const { pos, ...rest } = h; return rest; } ),
        extra: Math.max(0, keys.length - 2),
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
    const { remaining } = consumeTitles(title, vocabulary);
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
 * The names a clip carries, as the rest of the code should see them: one or two
 * show keys, or [] for a clip that names nothing (no field, or one that is not
 * a valid shape - namesProblem is what says so). Hands back a copy.
 */
function namesOf(clip) {
    if ( (clip == null) || ! Array.isArray(clip.names) ) {
        return [];
    }
    if ( (clip.names.length < 1) || (clip.names.length > 2) ) {
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
        return `names is ${typeof(clip.names)} rather than an array of one or two show keys`;
    }
    if ( (clip.names.length < 1) || (clip.names.length > 2) ) {
        return `names holds ${clip.names.length} entries, and should hold one or two show keys`;
    }
    if (! clip.names.every( (k) => (typeof(k) === 'string') && (k !== '') ) ) {
        return 'names holds something that is not a show key (a non-empty string such as "tv.Futurama")';
    }
    return null;
}

module.exports = {
    fold: fold,
    buildVocabulary: buildVocabulary,
    propose: propose,
    learnAliases: learnAliases,
    namesOf: namesOf,
    namesProblem: namesProblem,
};
