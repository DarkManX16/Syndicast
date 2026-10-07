/*
 * The Nicknames page's own logic: every nickname as the page lists it, and what editing or
 * deleting one would change before anything is saved. Pure, no I/O, no DOM; the service
 * (src/services/show-match-service.js) feeds it the vocabulary, the saved nicknames and every
 * clip, and the page (web/controllers/nicknames.js) shows what it says.
 *
 * A nickname only ever changes what is *suggested* for a clip whose names are not saved. A clip
 * with saved names, or one saved as naming no show, keeps what it has whatever happens to the
 * nickname, so a preview counts those clips as kept and never lists them as changed.
 */
const showMatch = require('./show-match');
const clipNames = require('./clip-names');

// The most clips a preview lists by name; the counts are always complete.
const LISTED = 60;

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// What a nickname is for, as the page groups it: a show, some seasons of one, or any one of several.
function kindOf(target) {
    if (clipNames.isAnyOfName(target) ) {
        return 'anyOf';
    }
    if (clipNames.isSeasonName(target) || clipNames.isSeasonsName(target) ) {
        return 'seasons';
    }
    return 'show';
}

// Whether a folded title contains a folded nickname as whole words.
function uses(foldedTitle, alias) {
    return (' ' + foldedTitle + ' ').indexOf(' ' + alias + ' ') !== -1;
}

/*
 * Every nickname, in alphabetical order: { alias, target, kind, label, missing, used }.
 * `label` is what it means in words; `missing` is true when a show it means is no longer on
 * any channel (it still reads, as its key, and can be edited or deleted); `used` is how many
 * clips, in every list, have the nickname in their title. `clips` is [{ title }].
 */
function listNicknames(aliases, vocabulary, clips) {
    const known = aliases || {};
    const folded = (clips || []).map( (c) => showMatch.fold(c.title) );
    return Object.keys(known).sort( (a, b) => a.localeCompare(b) ).map( (alias) => {
        const target = known[alias];
        return {
            alias: alias,
            target: target,
            kind: kindOf(target),
            label: clipNames.labelOf(target, vocabulary.names),
            missing: clipNames.showsOf(target).some( (k) => typeof(vocabulary.names[k]) === 'undefined' ),
            used: folded.filter( (t) => uses(t, alias) ).length,
        };
    } );
}

/*
 * What an edit would do. `edit` is one of
 *
 *   { alias, remove: true }                    delete the nickname
 *   { alias, newAlias?, target? }              change its text, what it means, or both; what is left
 *                                              out stays as it is
 *
 * `ctx` is { vocabulary, aliases, clips }, clips being [{ list, listName, index, title, names,
 * reviewed }]. Returns
 *
 *   { ok, problems, alias, newAlias, target, remove, changes, kept }
 *
 * `ok` is false when the edit cannot be saved, `problems` saying why in sentences. `changes`
 * lists every clip whose suggestion would be different afterwards, { list, listName, index,
 * title, before, after, beforeFlagged, afterFlagged } (names, and whether the title is flagged as
 * having a show that is not recognised), and `kept` counts the clips that have the nickname in
 * their title and keep their saved names (or their saved "names no show"). Nothing passed in is
 * changed, and no clip is ever written: this only reads.
 *
 * The text and meaning follow the rules of teaching a nickname (everyday words, a title, a nickname
 * that already exists, a show on no channel), without the check against clips that teaching
 * makes: changing what a nickname means is a decision, and the clips it touches are listed.
 */
function previewEdit(edit, ctx) {
    const known = ctx.aliases || {};
    const vocabulary = ctx.vocabulary;
    const result = { ok: false, problems: [], alias: null, newAlias: null, target: null, remove: edit.remove === true, changes: [], kept: 0 };
    const alias = showMatch.fold(edit.alias == null ? '' : String(edit.alias));
    if ( (alias === '') || ! has(known, alias) ) {
        result.problems.push('That nickname is not in the list any more. Reload the page.');
        return result;
    }
    result.alias = alias;
    const without = Object.assign({}, known);
    delete without[alias];

    let next;
    if (result.remove) {
        next = without;
    } else {
        const typed = (typeof(edit.newAlias) === 'string') ? edit.newAlias : alias;
        const newAlias = showMatch.fold(typed);
        const target = (typeof(edit.target) !== 'undefined') ? edit.target : known[alias];
        result.newAlias = newAlias;
        result.target = target;
        if (newAlias === '') {
            result.problems.push('Type a word or a phrase.');
        } else {
            result.problems.push(...showMatch.nicknameProblems(typed, newAlias, target, vocabulary, without));
        }
        if ( (result.problems.length === 0) && (newAlias === alias) && clipNames.sameName(known[alias], target) ) {
            result.problems.push('Nothing has changed.');
        }
        if (result.problems.length > 0) {
            return result;
        }
        next = Object.assign({}, without);
        next[newAlias] = target;
    }

    const phrases = [alias];
    if ( (result.newAlias !== null) && (result.newAlias !== alias) ) {
        phrases.push(result.newAlias);
    }
    for (const clip of (ctx.clips || []) ) {
        const folded = showMatch.fold(clip.title);
        if (! phrases.some( (p) => uses(folded, p) )) {
            continue;
        }
        if ( (clip.names.length > 0) || (clip.reviewed === true) ) {
            result.kept++;
            continue;
        }
        const before = showMatch.propose(clip.title, vocabulary, known);
        const after = showMatch.propose(clip.title, vocabulary, next);
        const ids = (names) => names.map(clipNames.nameId).join('|');
        if ( (ids(before.names) !== ids(after.names)) || ((before.unresolved != null) !== (after.unresolved != null)) ) {
            result.changes.push( { list: clip.list, listName: clip.listName, index: clip.index, title: clip.title,
                before: before.names, after: after.names, beforeFlagged: before.unresolved != null, afterFlagged: after.unresolved != null } );
        }
    }
    result.ok = true;
    return result;
}

module.exports = {
    LISTED: LISTED,
    kindOf: kindOf,
    listNicknames: listNicknames,
    previewEdit: previewEdit,
};
