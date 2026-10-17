/*
 * What the Swap and Insert dialog does when it cannot read a show - This show,
 * Other shows on this channel, Custom shows. The dialog hands in the I/O (the
 * server's /api/catalogs/read, the custom shows), so this decides only what to
 * say and what to offer instead: the failure in plain words, and the episodes
 * the lineup already holds, as Create Lineup falls back (see
 * time-slots-schedule-editor). Pure, tested in Node, bundled into the editor.
 * See NOTES.md, Known issues, "Swaps, inserts and Flex that keeps time".
 */
const catalog = require('./show-catalog');

const PLEX_DOWN = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Plex unreachable/;

// The reason a read failed, as a sentence: from what the dialog's request
// rejected with (angular's { status, data }), a show's { error } text or an Error.
function explain(err) {
    if ( (err === null) || (typeof(err) === 'undefined') ) {
        return "The reason isn't known.";
    }
    let text = (typeof(err) === 'string') ? err : ( (typeof(err.message) === 'string') ? err.message : null );
    if (text === null) {
        if (typeof(err.status) === 'number') {
            if (err.status <= 0) {
                return "The Syndicast server didn't answer - it may not be running any more. Start it again, reload this page and try again.";
            }
            let said = (typeof(err.data) === 'string') ? err.data.trim().slice(0, 160) : '';
            return `The server answered with an error (${err.status})` + (said ? `: ${said}` : (err.statusText ? `: ${err.statusText}` : '')) + '.';
        }
        return "The reason isn't known.";
    }
    let named = /no Plex server named "(.*)"/.exec(text);
    if (named !== null) {
        return (named[1] === 'undefined')
            ? "There is nothing in the lineup from this show to tell which Plex server it is on."
            : `Plex server "${named[1]}" isn't set up in this data folder.`;
    }
    if (PLEX_DOWN.test(text)) {
        return `Plex isn't answering (${text.replace(/^Plex unreachable: /, '')}).`;
    }
    if (/timed out/.test(text)) {
        return "Plex didn't answer in time.";
    }
    return text;
}

const episodesOf = (n) => (n === 1) ? 'episode' : 'episodes';

// A read that failed, and what is offered in its place.
function fallback(label, why, held, noun) {
    let n = held.length;
    return {
        items: held,
        notice: `Couldn't read ${label}. ${why}` + ( (n > 0) ? ` Showing the ${n} ${noun(n)} already in the lineup.` : ' The lineup holds none of it either.' ),
    };
}

/*
 * One show's catalog. `read(shows)` is the server's read, which answers
 * { showId: { items } | { error } } or rejects; `lineupItems` are what the
 * lineup holds of the show.
 */
async function readShow({ read, showId, title, lineupItems }) {
    let why;
    try {
        let got = (await read([ { showId: showId, title: title, lineupItems: lineupItems } ]) || {})[showId];
        if ( got && Array.isArray(got.items) ) {
            return { items: got.items, notice: '' };
        }
        why = (got && got.error) ? explain(got.error) : 'The server gave no answer for it.';
    } catch (err) {
        why = explain(err);
    }
    return fallback(title || showId, why, lineupItems, episodesOf);
}

const itemsOf = (n) => (n === 1) ? 'item' : 'items';

// The custom shows the lineup holds, once each, by name.
function customShowsIn(programs) {
    let found = new Map();
    programs.forEach( (p) => {
        if ( ! p.isOffline && (typeof(p.customShowId) !== 'undefined') && ! found.has(p.customShowId) ) {
            found.set(p.customShowId, { id: p.customShowId, name: p.customShowName });
        }
    } );
    return [ ...found.values() ].sort( (a, b) => String(a.name).localeCompare(String(b.name)) );
}

// A custom show's items in the lineup, once each, in the show's order.
function customItemsIn(programs, id) {
    let seen = new Set();
    return programs.filter( (p) => {
        if ( p.isOffline || (p.customShowId !== id) || seen.has(p.customOrder) ) {
            return false;
        }
        seen.add(p.customOrder);
        return true;
    } ).sort( (a, b) => a.customOrder - b.customOrder );
}

// The list of custom shows to choose from: the server's, or the lineup's own.
async function readCustomShows({ list, programs }) {
    try {
        return { shows: (await list()).slice().sort( (a, b) => a.name.localeCompare(b.name) ), notice: '' };
    } catch (err) {
        let held = customShowsIn(programs);
        let n = held.length;
        return {
            shows: held,
            notice: `Couldn't read the custom shows. ${explain(err)}`
                + ( (n > 0) ? ` Showing the ${n} custom ${ (n === 1) ? 'show' : 'shows' } already in the lineup.` : ' The lineup holds none.' ),
        };
    }
}

// One custom show's items: the server's, or those the lineup holds.
async function readCustomItems({ get, id, name, programs }) {
    let why;
    try {
        let show = await get(id);
        if ( ! show || ! Array.isArray(show.content) ) {
            throw new Error('custom show not found');
        }
        return { items: catalog.fromCustom(Object.assign({ id: id }, show)), notice: '' };
    } catch (err) {
        why = explain(err);
    }
    return fallback(name || 'that custom show', why, customItemsIn(programs, id), itemsOf);
}

module.exports = { explain, readShow, customShowsIn, customItemsIn, readCustomShows, readCustomItems };
