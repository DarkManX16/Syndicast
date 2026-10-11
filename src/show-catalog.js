/*
 * Full catalogs, and a never-air list: what a show's whole episode list adds
 * to a channel, the pool a regeneration draws on, and the channel's list of
 * episodes left out of the rotation - holidays Ron places himself, and ones
 * never to air. Pure; the editors (through browserify), the Catalog page, the
 * server's ops and the proof scripts share it. See NOTES.md, Known issues,
 * "Full catalogs, and a never-air list".
 *
 * A catalog is { items, source } or { error }. The state is channel.catalog:
 * { shows: { showId: { reviewedAt, by, specials, source, known } },
 *   neverAir: { fileKey: { showId, season, episode, title, duration, at, how,
 *               reason, holiday } } }.
 */
const rounds = require('./shuffle-rounds');

const DEFAULT_LIMIT_MS = 30 * 60 * 1000;
const fileKey = rounds.fileKey;

// The words that make a title a likely holiday episode, in the order they're
// tried. Whole words only, so "Eastern" isn't Easter and "Cupidity" isn't
// Valentine's.
const A = "['’]";
const HOLIDAYS = [
    { name: 'Christmas', words: new RegExp(`\\b(christmas|xmas|x-mas|santa|noel|yule(tide)?|reindeer|mistletoe|nutcracker|jingle|deck the (halls|malls?)|north pole|elf|elves|krampus|a \\w+ carol)\\b`, 'i') },
    { name: 'Halloween', words: new RegExp(`\\b(halloween|hallowe${A}en|trick[- ]or[- ]treat\\w*|jack[- ]o${A}?[- ]lanterns?|great pumpkin|day of the dead|d[i\u00ed]a de (los )?muertos)\\b`, 'i') },
    { name: 'Thanksgiving', words: new RegExp(`\\b(thanksgiving|pilgrims?|turkey)\\b`, 'i') },
    { name: 'Easter', words: /\beaster\b/i },
    { name: "Valentine's", words: new RegExp(`\\b(valentine(${A}?s)?|cupid)\\b`, 'i') },
    { name: 'New Year', words: new RegExp(`\\bnew year(${A}?s)?\\b`, 'i') },
    { name: 'Hanukkah', words: /\b(hanukk?ah|chanukk?ah)\b/i },
    { name: "St. Patrick's", words: new RegExp(`\\b(st\\.? patrick(${A}?s)?|saint patrick(${A}?s)?|leprechauns?)\\b`, 'i') },
    { name: 'Fourth of July', words: /\b(fourth of july|4th of july|independence day)\b/i },
    { name: "Mother's Day", words: new RegExp(`\\bmother${A}?s?${A}? day\\b`, 'i') },
    { name: "Father's Day", words: new RegExp(`\\bfather${A}?s?${A}? day\\b`, 'i') },
    { name: "April Fools'", words: new RegExp(`\\bapril fool(${A}?s)?${A}?`, 'i') },
    { name: 'Groundhog Day', words: /\b(groundhog|hog) day\b/i },
    { name: 'Kwanzaa', words: /\bkwanzaa\b/i },
    { name: 'Passover', words: /\bpassover\b/i },
    { name: 'Labor Day', words: /\blabou?r day\b/i },
    { name: 'Memorial Day', words: /\bmemorial day\b/i },
];

function emptyState() {
    return { shows: {}, neverAir: {} };
}

function stateOf(channel) {
    let c = (channel && typeof(channel.catalog) === 'object' && channel.catalog !== null) ? channel.catalog : null;
    if (c === null) {
        return emptyState();
    }
    let copy = JSON.parse(JSON.stringify(c));
    copy.shows = copy.shows || {};
    copy.neverAir = copy.neverAir || {};
    return copy;
}

function showKeysOf(programs) {
    let keys = [];
    (programs || []).forEach( (p) => {
        let m = /\/library\/metadata\/(\d+)\/thumb/.exec(p.showIcon || '');
        if ( (m !== null) && ! keys.includes(m[1]) ) {
            keys.push(m[1]);
        }
    } );
    return keys;
}

// As plex-library.js's selectItem adds an item, with the channel's own title.
function fromPlex(items, server, showTitle) {
    return items.map( (it) => {
        let copy = Object.assign( {}, it );
        delete copy.server;
        copy.serverKey = server.name;
        copy.showTitle = showTitle;
        return JSON.parse(JSON.stringify(copy));
    } );
}

// As plex-library.js's addCustomShow adds a custom show.
function fromCustom(show) {
    return show.content.map( (it, i) => {
        let copy = JSON.parse(JSON.stringify(it));
        copy.customShowId = show.id;
        copy.customShowName = show.name;
        copy.customOrder = i;
        return copy;
    } );
}

function specialsAllowed(lineupItems) {
    return (lineupItems || []).some( (p) => (p.customShowId === undefined) && (p.season === 0) );
}

function isNeverAir(state, program) {
    return Object.prototype.hasOwnProperty.call(state.neverAir || {}, fileKey(program));
}

function withoutNeverAir(programs, state) {
    return programs.filter( (p) => p.isOffline || ! isNeverAir(state, p) );
}

function neverAirEntry(program, getShowData, how, reason, holiday, now) {
    let entry = {
        showId: getShowData(program).showId,
        season: program.season,
        episode: program.episode,
        title: program.title,
        duration: program.duration,
        at: new Date(now).toISOString(),
        how: how,
        reason: reason,
    };
    if ( (reason === 'holiday') && (typeof(holiday) === 'string') ) {
        entry.holiday = holiday;
    }
    return { key: fileKey(program), entry: entry };
}

function holidayOf(title) {
    let match = holidayMatch(title);
    return (match === null) ? null : match.name;
}

function holidayMatch(title) {
    for (let h of HOLIDAYS) {
        let m = h.words.exec(title || '');
        if (m !== null) {
            return { name: h.name, word: m[0] };
        }
    }
    // "Holiday(s)" alone - "Home for the Holidays" - is nearly always the
    // Christmas season; any named holiday above wins over it.
    let m = /\bholidays?\b/i.exec(title || '');
    return (m === null) ? null : { name: 'Christmas', word: m[0] };
}

function clock(ms) {
    let s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function preUntick(program, limitMs) {
    let h = holidayMatch(program.title);
    if (h !== null) {
        return { reason: 'holiday', holiday: h.name, why: `${h.name}: "${h.word}" in the title` };
    }
    if (program.duration > limitMs) {
        return { reason: 'never', why: `${clock(program.duration)}, longer than ${clock(limitMs)}` };
    }
    return null;
}

function toAdd({ items, lineupItems, state, specials }) {
    let held = new Set( (lineupItems || []).map(fileKey) );
    return items.filter( (p) => ! held.has(fileKey(p)) && ! isNeverAir(state, p) && (specials || (p.season !== 0) || (p.customShowId !== undefined)) );
}

function byShow(lineupPool, getShowData) {
    let groups = new Map();
    lineupPool.forEach( (p) => {
        if (p.isOffline) {
            return;
        }
        let d = getShowData(p);
        if (! d.hasShow) {
            return;
        }
        if (! groups.has(d.showId)) {
            groups.set(d.showId, []);
        }
        groups.get(d.showId).push(p);
    } );
    return groups;
}

let isCustom = (showId) => showId.startsWith('custom.');
let readOk = (c) => (typeof(c) === 'object') && (c !== null) && Array.isArray(c.items);

function reviewList({ lineupPool, catalogs, state, getShowData }) {
    let groups = byShow(lineupPool, getShowData);
    let out = [];
    Object.keys(catalogs || {}).forEach( (showId) => {
        let c = catalogs[showId];
        if (! readOk(c) || state.shows[showId]) {
            return;
        }
        let lineupItems = groups.get(showId) || [];
        let specials = isCustom(showId) || specialsAllowed(lineupItems);
        let add = toAdd({ items: c.items, lineupItems, state, specials });
        if (add.length === 0) {
            return;
        }
        let seasons = new Map();
        add.slice().sort( (a, b) => getShowData(a).order - getShowData(b).order ).forEach( (p) => {
            if (! seasons.has(p.season)) {
                seasons.set(p.season, []);
            }
            seasons.get(p.season).push(p);
        } );
        let first = lineupItems[0] || c.items[0];
        out.push({
            showId,
            name: isCustom(showId) ? first.customShowName : first.showTitle,
            count: add.length,
            seasons: [ ...seasons.keys() ].sort( (a, b) => a - b ).map( (season) => ({ season, episodes: seasons.get(season) }) ),
            source: c.source,
            specials,
            known: c.items.map(fileKey),
        });
    } );
    return out.sort( (a, b) => b.count - a.count );
}

function poolFor({ lineupPool, slotted, catalogs, state, getShowData }) {
    let groups = byShow(lineupPool, getShowData);
    let replaced = new Set();
    let additions = [];
    let complete = [];
    let fresh = {};
    let fellBack = [];
    let known = {};
    (slotted || []).forEach( (showId) => {
        if ( (showId === 'movie.') || ! groups.has(showId) && ! catalogs[showId] ) {
            return;
        }
        let c = (catalogs || {})[showId];
        let record = state.shows[showId];
        let lineupItems = groups.get(showId) || [];
        if (! readOk(c)) {
            if (record) {
                fellBack.push({ showId, reason: (c && c.error) ? c.error : 'not read' });
            }
            return;
        }
        known[showId] = c.items.map(fileKey);
        let custom = isCustom(showId);
        let specials = custom || (record ? (record.specials === true) : specialsAllowed(lineupItems));
        let add = toAdd({ items: c.items, lineupItems, state, specials });
        if (! record) {
            // Complete only when the catalog holds every episode the lineup
            // airs: a read that came back short - Plex lost the show, or
            // listed nothing - says nothing about what's missing.
            let held = new Set(known[showId]);
            if ( (add.length === 0) && (c.items.length > 0) && lineupItems.every( (p) => held.has(fileKey(p)) ) ) {
                complete.push(showId);
            }
            return;
        }
        let seen = new Set(record.known || []);
        let newOnes = add.filter( (p) => ! seen.has(fileKey(p)) );
        if (newOnes.length > 0) {
            fresh[showId] = newOnes;
        }
        if (custom) {
            // The custom show's own list and order, as it is now.
            replaced.add(showId);
            additions.push( ...c.items.filter( (p) => ! isNeverAir(state, p) ) );
        } else {
            additions.push( ...add );
        }
    } );
    let pool = lineupPool.filter( (p) => {
        if (p.isOffline) {
            return true;
        }
        if (isNeverAir(state, p)) {
            return false;
        }
        let d = getShowData(p);
        return ! (d.hasShow && replaced.has(d.showId));
    } ).concat(additions);
    return { pool, complete, fresh, fellBack, known };
}

// What to record as seen after a run: every key read, except newcomers the
// dialog didn't name (a re-roll, Random Slots), which stay new for next time.
function knownAfter(run, named) {
    let out = {};
    Object.keys(run.known || {}).forEach( (showId) => {
        let unnamed = named ? new Set() : new Set( (run.fresh[showId] || []).map(fileKey) );
        out[showId] = run.known[showId].filter( (k) => ! unnamed.has(k) );
    } );
    return out;
}

/*
 * The catalog ops a Create Lineup hands back for the channel page to save:
 * shows found complete, episodes left out in the dialog, and what was read.
 * None at all when the channel's catalog state couldn't be read - the run
 * drew on the lineup alone, and anything it saved would be built on a state
 * it never saw.
 */
function opsAfterRun({ run, catalogs, lineupPool, leftOut, named, stateReadable, getShowData }) {
    if (! stateReadable) {
        return [];
    }
    let lineupItemsOf = (id) => (lineupPool || []).filter( (p) => ! p.isOffline && getShowData(p).showId === id );
    return run.complete.map( (id) => ({ review: { showId: id, by: 'complete', source: catalogs[id].source,
            specials: id.startsWith('custom.') || specialsAllowed(lineupItemsOf(id)), known: run.known[id], neverAir: [] } }) )
        .concat( [ { neverAir: (leftOut || []).slice() }, { known: knownAfter(run, named) } ] );
}

/*
 * The Catalog page rebuilds its rows after every save; a show's open state
 * and the choices Ron made on its episodes but hasn't saved carry over.
 * choices: { showId: { open, episodes: { fileKey: { ticked, touched, reason, holiday } } } }.
 */
function carryChoices(choices, rows) {
    return rows.map( (r) => {
        let c = (choices || {})[r.showId];
        r.open = !! (c && c.open);
        r.choices = {};
        if (c && c.episodes) {
            r.seasons.forEach( (s) => s.episodes.forEach( (p) => {
                let e = c.episodes[fileKey(p)];
                if (e) {
                    r.choices[fileKey(p)] = Object.assign({}, e);
                }
            } ) );
        }
        return r;
    } );
}

function applyOps(state, ops, now) {
    let s = JSON.parse(JSON.stringify(state || emptyState()));
    s.shows = s.shows || {};
    s.neverAir = s.neverAir || {};
    let at = new Date(now).toISOString();
    let addEntries = (list) => (list || []).forEach( ({ key, entry }) => {
        s.neverAir[key] = Object.assign( { at }, entry );
    } );
    (ops || []).forEach( (op) => {
        if (op.review) {
            let r = op.review;
            // An automatic "complete" never replaces a review Ron made.
            if ( (r.by === 'complete') && s.shows[r.showId] && (s.shows[r.showId].by !== 'complete') ) {
                return;
            }
            s.shows[r.showId] = { reviewedAt: at, by: r.by || 'review', specials: r.specials === true, source: r.source || {}, known: (r.known || []).slice() };
            addEntries(r.neverAir);
        } else if (op.neverAir) {
            addEntries(op.neverAir);
        } else if (op.restore) {
            op.restore.forEach( (key) => { delete s.neverAir[key]; } );
        } else if (op.known) {
            Object.keys(op.known).forEach( (showId) => {
                if (s.shows[showId]) {
                    s.shows[showId].known = op.known[showId].slice();
                }
            } );
        } else if (op.reason) {
            let e = s.neverAir[op.reason.key];
            if (e) {
                e.reason = op.reason.reason;
                if (op.reason.reason === 'holiday' && typeof(op.reason.holiday) === 'string') {
                    e.holiday = op.reason.holiday;
                } else {
                    delete e.holiday;
                }
            }
        } else {
            throw new Error('Unknown catalog op: ' + JSON.stringify(op).slice(0, 80));
        }
    } );
    return s;
}

function byHoliday(state) {
    let groups = new Map();
    Object.keys(state.neverAir || {}).forEach( (key) => {
        let e = state.neverAir[key];
        if (e.reason !== 'holiday') {
            return;
        }
        let h = e.holiday || 'Other';
        if (! groups.has(h)) {
            groups.set(h, new Map());
        }
        let shows = groups.get(h);
        if (! shows.has(e.showId)) {
            shows.set(e.showId, []);
        }
        shows.get(e.showId).push(Object.assign({ key }, e));
    } );
    let order = HOLIDAYS.map( (h) => h.name ).concat(['Other']);
    let rank = (h) => { let i = order.indexOf(h); return (i === -1) ? order.length : i; };
    return [ ...groups.keys() ].sort( (a, b) => rank(a) - rank(b) || a.localeCompare(b) ).map( (holiday) => ({
        holiday,
        shows: [ ...groups.get(holiday).keys() ].sort().map( (showId) => ({
            showId,
            entries: groups.get(holiday).get(showId).sort( (a, b) => (a.season - b.season) || (a.episode - b.episode) ),
        }) ),
    }) );
}

module.exports = {
    DEFAULT_LIMIT_MS, HOLIDAYS,
    emptyState, stateOf, showKeysOf, fromPlex, fromCustom, specialsAllowed,
    isNeverAir, withoutNeverAir, neverAirEntry, holidayOf, preUntick,
    toAdd, reviewList, poolFor, applyOps, byHoliday, knownAfter, carryChoices, opsAfterRun,
};
