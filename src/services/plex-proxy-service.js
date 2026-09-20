const Plex = require('../plex.js')
const events = require('events')

class PlexProxyService extends events.EventEmitter {

    constructor(plexServerDB) {
        super();
        this.plexServerDB = plexServerDB;
    }

    async get(serverName64, path, query) {
        let plexServer = await getPlexServer64(this.plexServerDB, serverName64);
        // A potential area of improvement is to reuse the client when possible
        let client = new Plex(plexServer);
        return { MediaContainer: await client.Get("/" + path + buildQueryString(query)) };
    }

    async getKeyMediaContents(serverName, key) {
        let plexServer = await getPlexServer(this.plexServerDB, serverName);
        let client = new Plex(plexServer);
        let obj = { MediaContainer: await client.Get(key) };
        let metadata = obj.MediaContainer.Metadata;
        if ( typeof(metadata) !== "object") {
            return [];
        }
        metadata = metadata.map( (item) => fillerMapper(serverName, item) );

        return metadata;
    }
}

/*
 * Plex takes most of its useful options as query parameters - title filters,
 * container paging - so a proxy that only forwards the path silently drops
 * them and returns an unfiltered result, which looks like the filter simply
 * not working.
 */
function buildQueryString(query) {
    if ( (typeof(query) !== 'object') || (query === null) ) {
        return "";
    }
    let params = new URLSearchParams();
    for (const key of Object.keys(query)) {
        // The token comes from the stored server, never from the caller.
        if (key.toLowerCase() === 'x-plex-token') {
            continue;
        }
        let value = query[key];
        if (Array.isArray(value)) {
            value.forEach( (v) => params.append(key, v) );
        } else {
            params.append(key, value);
        }
    }
    let s = params.toString();
    return (s === "") ? "" : ("?" + s);
}

function fillerMapper(serverName, plexMetadata) {
    let image = {};
    if ( (typeof(plexMetadata.Image) === "object")
        && (typeof(plexMetadata.Image[0]) === "object")
    ) {
        image = plexMetadata.Image[0];
    }

    let media = {};
    if ( (typeof(plexMetadata.Media) === "object")
        && (typeof(plexMetadata.Media[0]) === "object")
    ) {
        media = plexMetadata.Media[0];
    }


    let part = {};
    if ( (typeof(media.Part) === "object")
        && (typeof(media.Part[0]) === "object")
    ) {
        part = media.Part[0];
    }


    return {
        title    : plexMetadata.title,
        key      : plexMetadata.key,
        ratingKey: plexMetadata.ratingKey,
        icon     : image.url,
        type     : plexMetadata.type,
        duration : part.duration,
        durationStr : undefined,
        summary  : "",
        date     : "",
        year     : plexMetadata.year,
        plexFile : part.key,
        file     : part.file,
        showTitle: plexMetadata.title,
        episode  : 1,
        season   : 1,
        serverKey: serverName,
        commercials: [],
    }
}

async function getPlexServer(plexServerDB, serverKey) {
    let server = await plexServerDB.getPlexServerByName(serverKey);
    if (server == null) {
        throw Error("server not found");
    }
    return server;
}



async function getPlexServer64(plexServerDB, serverName64) {
    let serverKey = Buffer.from(serverName64, 'base64').toString('utf-8');
    return await getPlexServer(plexServerDB, serverKey);
}



module.exports = PlexProxyService