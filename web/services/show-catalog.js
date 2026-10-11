/*
 * Reads shows' full catalogs for the slot editors and the Catalog page. The
 * server reads them (POST /api/catalogs/read) with the shared reader
 * (src/catalog-reader.js) and the library's own Plex code, so every episode
 * is made exactly as the library makes it - several shows at once, where the
 * browser's own requests to Plex run nearly one at a time (channel 2's 160
 * shows: about 35 s here, 5 s there). See NOTES.md, Known issues, "Full
 * catalogs, and a never-air list".
 */
module.exports = function ($http) {
    // What the reader needs of a show's lineup episodes: where to find the show.
    let slim = (items) => {
        let seen = new Set();
        return (items || []).filter( (p) => {
            let k = p.showIcon || p.ratingKey;
            if (seen.has(k)) {
                return false;
            }
            seen.add(k);
            return true;
        } ).map( (p) => ({ showIcon: p.showIcon, serverKey: p.serverKey, ratingKey: p.ratingKey }) );
    };
    return {
        // shows: [{ showId, title, lineupItems, source }] -> { showId: { items, source } | { error } }
        read: async (shows) => {
            let body = { shows: shows.map( (s) => ({ showId: s.showId, title: s.title, source: s.source, lineupItems: slim(s.lineupItems) }) ) };
            let res = await $http({
                method: 'POST', url: '/api/catalogs/read', data: angular.toJson(body),
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            });
            return res.data;
        },
    };
};
