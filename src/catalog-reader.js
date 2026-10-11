/*
 * Reading each show's full catalog: a Plex show's episodes with the library's
 * own code (getNested on /library/metadata/<show>/allLeaves), a custom show's
 * current items. The I/O is passed in - the server's /api/catalogs/read and the
 * proof scripts pass web/services/plex.js and the custom shows - so this
 * module decides only what to read and how to put it together. A failure is
 * that show's { error }, never a rejection, and nothing waits for ever: each
 * request has a time limit, the whole read a deadline, and a Plex server that
 * can't be reached fails its other shows at once. See NOTES.md, Known
 * issues, "Full catalogs, and a never-air list".
 */
const catalog = require('./show-catalog');

const UNREACHABLE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed out/;

function within(promise, ms, what) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise( (resolve, reject) => { timer = setTimeout( () => reject(new Error(what + ' timed out')), ms ); } ),
    ]).finally( () => clearTimeout(timer) );
}

async function readOne(show, servers, io, timeoutMs, dead) {
    if (show.showId.startsWith('custom.')) {
        let id = (show.source && show.source.custom) || show.showId.slice('custom.'.length);
        // A custom show's id names its file in custom-shows: letters, digits
        // and dashes only, so no id can reach a file anywhere else.
        if ( (typeof(id) !== 'string') || ! /^[A-Za-z0-9-]+$/.test(id) ) {
            throw new Error('not a custom show id');
        }
        let custom = await within(Promise.resolve(io.getShow(id)), timeoutMs, 'reading the custom show');
        if (! custom || ! Array.isArray(custom.content)) {
            throw new Error('custom show not found');
        }
        return { items: catalog.fromCustom(custom), source: { custom: id } };
    }
    let lineupItems = show.lineupItems || [];
    let serverName = (show.source && show.source.plex) || (lineupItems[0] && lineupItems[0].serverKey);
    let server = servers.find( (s) => s.name === serverName );
    if (typeof(server) === 'undefined') {
        throw new Error('no Plex server named "' + serverName + '"');
    }
    if (dead.has(server.name)) {
        throw new Error('Plex unreachable: ' + dead.get(server.name));
    }
    try {
        let keys = (show.source && Array.isArray(show.source.shows) && show.source.shows.length) ? show.source.shows.slice() : catalog.showKeysOf(lineupItems);
        if ( (keys.length === 0) && lineupItems.length ) {
            let k = await within(Promise.resolve(io.getShowKey(server, lineupItems[0].ratingKey)), timeoutMs, 'Plex');
            if (k) {
                keys = [ String(k) ];
            }
        }
        if (keys.length === 0) {
            throw new Error('the show could not be found in Plex');
        }
        let items = [];
        for (let k of keys) {
            let errors = [];
            let got = await within(Promise.resolve(io.getNested(server, { key: '/library/metadata/' + k + '/allLeaves' }, false, errors)), timeoutMs, 'Plex');
            items = items.concat( (got || []).filter( (p) => p.type === 'episode' ) );
        }
        return { items: catalog.fromPlex(items, server, show.title), source: { plex: server.name, shows: keys } };
    } catch (err) {
        let message = (err && err.message) ? err.message : String(err);
        if (UNREACHABLE.test(message) || UNREACHABLE.test( (err && err.code) || '' )) {
            dead.set(server.name, message);
        }
        throw err;
    }
}

async function readCatalogs({ shows, servers, getNested, getShowKey, getShow, concurrency, timeoutMs, deadlineMs }) {
    let io = { getNested, getShowKey, getShow };
    let limit = (typeof(concurrency) === 'number' && concurrency > 0) ? concurrency : 8;
    let perRequest = (typeof(timeoutMs) === 'number' && timeoutMs > 0) ? timeoutMs : 15000;
    let deadline = Date.now() + ( (typeof(deadlineMs) === 'number' && deadlineMs > 0) ? deadlineMs : 90000 );
    let dead = new Map();
    let out = {};
    let queue = shows.slice();
    let worker = async () => {
        while (queue.length > 0) {
            let show = queue.shift();
            if (Date.now() >= deadline) {
                out[show.showId] = { error: 'not read in time' };
                continue;
            }
            try {
                out[show.showId] = await within(readOne(show, servers || [], io, perRequest, dead), Math.max(1, deadline - Date.now()), 'the read');
            } catch (err) {
                out[show.showId] = { error: (err && err.message) ? err.message : String(err) };
            }
        }
    };
    await Promise.all( Array.from( { length: Math.min(limit, shows.length) }, worker ) );
    return out;
}

module.exports = { readCatalogs };
