/*
 * src/catalog-reader.js: reading each show's full catalog - a Plex show by
 * its show key, a custom show by its id - with the I/O passed in, as the
 * editor passes the library's own Plex code. See NOTES.md, Known issues,
 * "Full catalogs, and a never-air list".
 */
const { MIN, Suite } = require('./support');
const { readCatalogs } = require('../src/catalog-reader');

const SERVER = { name: 'srv', uri: 'http://plex', accessToken: 't' };
const ep = (show, n, showKey) => ({ type: 'episode', showTitle: show, title: `${show} ${n}`, season: 1, episode: n, duration: 22 * MIN,
    serverKey: 'srv', key: `/library/metadata/${showKey}${n}`, ratingKey: `${showKey}${n}`,
    showIcon: showKey ? `http://plex/library/metadata/${showKey}/thumb/1` : undefined });
// What getNested returns for /library/metadata/<k>/allLeaves: library items, server attached.
const leaves = { 11: [1, 2, 3].map((n) => Object.assign(ep('Doug (Plex)', n, 11), { server: SERVER, serverKey: undefined })),
                 12: [4].map((n) => Object.assign(ep('Doug', n, 12), { server: SERVER, serverKey: undefined })) };

function stubs(failing) {
    let running = 0, most = 0, calls = [];
    const slow = (v) => new Promise((resolve) => setTimeout(() => resolve(v), 5));
    return {
        calls, most: () => most,
        getNested: async (server, lib) => {
            running++; most = Math.max(most, running); calls.push(lib.key);
            try {
                const k = /metadata\/(\d+)\/allLeaves/.exec(lib.key)[1];
                await slow();
                if (failing && failing.includes(k)) throw new Error('Plex timed out');
                return (leaves[k] || []).map((x) => Object.assign({}, x));
            } finally { running--; }
        },
        getShowKey: async (server, ratingKey) => { calls.push('meta ' + ratingKey); return '12'; },
        getShow: async (id) => ({ id, name: 'DD', content: [ep('DD', 1, 30), ep('DD', 2, 30)] }),
    };
}

module.exports = async function () {
    const suite = new Suite('catalog-reader');
    {
        const s = stubs();
        const out = await readCatalogs({ shows: [{ showId: 'tv.Doug', title: 'Doug', lineupItems: [ep('Doug', 1, 11)] }], servers: [SERVER],
            getNested: s.getNested, getShowKey: s.getShowKey, getShow: s.getShow });
        const c = out['tv.Doug'];
        suite.check('reads a Plex show by its showIcon key',
            c.items.length === 3 && c.items.every((p) => p.showTitle === 'Doug' && p.serverKey === 'srv' && p.server === undefined)
                && JSON.stringify(c.source) === JSON.stringify({ plex: 'srv', shows: ['11'] }), JSON.stringify(c.source));
    }
    {
        const s = stubs();
        const out = await readCatalogs({ shows: [{ showId: 'tv.Doug', title: 'Doug', lineupItems: [ep('Doug', 4, undefined)] }], servers: [SERVER],
            getNested: s.getNested, getShowKey: s.getShowKey, getShow: s.getShow });
        suite.check('...by its episode when showIcon has none',
            out['tv.Doug'].items.length === 1 && s.calls[0] === 'meta undefined4' && out['tv.Doug'].source.shows.join() === '12',
            JSON.stringify(s.calls));
    }
    {
        const s = stubs();
        const out = await readCatalogs({ shows: [{ showId: 'tv.Doug', title: 'Doug', lineupItems: [ep('Doug', 1, 11), ep('Doug', 4, 12)] }], servers: [SERVER],
            getNested: s.getNested, getShowKey: s.getShowKey, getShow: s.getShow });
        suite.check('joins two Plex shows of one title', out['tv.Doug'].items.length === 4 && out['tv.Doug'].source.shows.join() === '11,12');
    }
    {
        const s = stubs();
        const out = await readCatalogs({ shows: [{ showId: 'custom.cs1', title: 'DD', lineupItems: [] }], servers: [SERVER],
            getNested: s.getNested, getShowKey: s.getShowKey, getShow: s.getShow });
        suite.check('reads a custom show', out['custom.cs1'].items.map((p) => p.customOrder).join() === '0,1'
            && out['custom.cs1'].source.custom === 'cs1');
    }
    {
        const s = stubs(['11']);
        const shows = [{ showId: 'tv.Doug', title: 'Doug', lineupItems: [ep('Doug', 1, 11)] }, { showId: 'custom.cs1', title: 'DD', lineupItems: [] },
            { showId: 'tv.Gone', title: 'Gone', lineupItems: [ep('Gone', 1, 99)], source: { plex: 'other server', shows: ['99'] } }];
        let out = null, rejected = false;
        try {
            out = await readCatalogs({ shows, servers: [SERVER], getNested: s.getNested, getShowKey: s.getShowKey, getShow: s.getShow });
        } catch (err) { rejected = true; }
        suite.check('a failed read is that show\'s error and the rest still read',
            ! rejected && out['tv.Doug'].error === 'Plex timed out' && out['custom.cs1'].items.length === 2 && /server/.test(out['tv.Gone'].error || ''),
            JSON.stringify(out && Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.error || v.items.length]))));
    }
    {
        const s = stubs();
        const shows = Array.from({ length: 20 }, (_, i) => ({ showId: 'tv.S' + i, title: 'S' + i, lineupItems: [ep('S' + i, 1, 11)] }));
        await readCatalogs({ shows, servers: [SERVER], getNested: s.getNested, getShowKey: s.getShowKey, getShow: s.getShow, concurrency: 3 });
        suite.check('never runs more than concurrency at once', s.most() === 3, String(s.most()));
    }
    return suite;
};
