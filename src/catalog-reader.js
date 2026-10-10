/*
 * Reading each show's full catalog: a Plex show's episodes with the library's
 * own code (getNested on /library/metadata/<show>/allLeaves), a custom show's
 * current items. The I/O is passed in - the editor and the Catalog page pass
 * web/services/plex.js and dizquetv, the proof scripts the same Plex code in
 * Node - so this module decides only what to read and how to put it together.
 * A failure is that show's { error }, never a rejection. See NOTES.md, Known
 * issues, "Full catalogs, and a never-air list".
 */
const catalog = require('./show-catalog');

async function readOne(show, servers, io) {
    if (show.showId.startsWith('custom.')) {
        let id = (show.source && show.source.custom) || show.showId.slice('custom.'.length);
        let custom = await io.getShow(id);
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
    let keys = (show.source && Array.isArray(show.source.shows) && show.source.shows.length) ? show.source.shows.slice() : catalog.showKeysOf(lineupItems);
    if ( (keys.length === 0) && lineupItems.length ) {
        let k = await io.getShowKey(server, lineupItems[0].ratingKey);
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
        let got = await io.getNested(server, { key: '/library/metadata/' + k + '/allLeaves' }, false, errors);
        items = items.concat( (got || []).filter( (p) => p.type === 'episode' ) );
    }
    return { items: catalog.fromPlex(items, server, show.title), source: { plex: server.name, shows: keys } };
}

async function readCatalogs({ shows, servers, getNested, getShowKey, getShow, concurrency }) {
    let io = { getNested, getShowKey, getShow };
    let limit = (typeof(concurrency) === 'number' && concurrency > 0) ? concurrency : 8;
    let out = {};
    let queue = shows.slice();
    let worker = async () => {
        while (queue.length > 0) {
            let show = queue.shift();
            try {
                out[show.showId] = await readOne(show, servers || [], io);
            } catch (err) {
                out[show.showId] = { error: (err && err.message) ? err.message : String(err) };
            }
        }
    };
    await Promise.all( Array.from( { length: Math.min(limit, shows.length) }, worker ) );
    return out;
}

module.exports = { readCatalogs };
