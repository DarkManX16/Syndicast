/*
 * channel.catalog - a channel's full-catalog reviews and its never-air list -
 * is written only by the catalog ops (channelService.applyCatalogOps); a
 * channel save from the channel page keeps the stored one whatever it sends,
 * so a page open in another tab can't undo a review. See NOTES.md, Known
 * issues, "Full catalogs, and a never-air list".
 *
 * Its own data folder under the OS temp directory, as test/channel-save.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite, channelCache, show, flex } = require('./support');
const ChannelDB = require('../src/dao/channel-db');
const ChannelService = require('../src/services/channel-service');

function channel(number, name) {
    return {
        number, name, startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), duration: 0,
        programs: [show('Aqua Teen', 11), flex(3), show('Futurama', 22)], fallback: [], fillerCollections: [],
        offlineMode: 'pic', transcoding: {}, onDemand: { isOnDemand: false },
    };
}
const entry = (n) => ({ key: 'srv|/library/metadata/' + n, entry: { showId: 'tv.Futurama', season: 1, episode: n, title: 'Ep ' + n, duration: 1320000, how: 'deleted', reason: 'never' } });

module.exports = async function run() {
    const suite = new Suite('channel catalog');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-test-'));
    const channels = path.join(root, 'channels');
    fs.mkdirSync(channels);
    try {
        const db = new ChannelDB(channels);
        global.channelDB = db;
        const service = new ChannelService(db);
        channelCache.clear();
        await service.saveChannel(7, channel(7, 'Seven'));

        const empty = await service.getCatalog(7);
        suite.check('a channel with no catalog reads as empty', JSON.stringify(empty) === JSON.stringify({ shows: {}, neverAir: {} }), JSON.stringify(empty));

        const after = await service.applyCatalogOps(7, [
            { review: { showId: 'tv.Futurama', source: { plex: 'srv', shows: ['1'] }, specials: false, known: ['srv|/library/metadata/1'], neverAir: [entry(2)] } },
            { neverAir: [entry(3)] },
        ]);
        const onDisk = JSON.parse(fs.readFileSync(path.join(channels, '7.json'), 'utf8'));
        suite.check('ops are applied and saved',
            Object.keys(after.neverAir).length === 2 && onDisk.catalog && onDisk.catalog.shows['tv.Futurama'].by === 'review'
                && Object.keys(onDisk.catalog.neverAir).join() === 'srv|/library/metadata/2,srv|/library/metadata/3'
                && onDisk.programs.length === 3, JSON.stringify(onDisk.catalog && Object.keys(onDisk.catalog.neverAir)));

        // The channel page, opened before the ops, saves its stale copy - with no catalog, or an old one.
        const stale = channel(7, 'Seven, renamed');
        await service.saveChannel(7, stale, { keepCatalog: true });
        const stale2 = Object.assign(channel(7, 'Seven again'), { catalog: { shows: {}, neverAir: {} } });
        await service.saveChannel(7, stale2, { keepCatalog: true });
        const kept = await service.getChannel(7);
        suite.check('a channel save keeps the stored catalog whatever it sends',
            kept.name === 'Seven again' && kept.catalog && Object.keys(kept.catalog.neverAir).length === 2, JSON.stringify(kept.catalog));

        // Every other writer saves the stored channel it read, catalog and all.
        const read = JSON.parse(JSON.stringify(await service.getChannel(7)));
        read.fillerCollections = [{ id: 'x', weight: 1, cooldown: 0 }];
        await service.saveChannel(7, read);
        suite.check('the other writers keep it', Object.keys((await service.getCatalog(7)).neverAir).length === 2);

        const both = await Promise.all([ service.applyCatalogOps(7, [{ restore: ['srv|/library/metadata/2'] }]), service.applyCatalogOps(7, [{ neverAir: [entry(4)] }]) ]);
        const final = await service.getCatalog(7);
        suite.check('two ops at once both land',
            both.length === 2 && Object.keys(final.neverAir).sort().join() === 'srv|/library/metadata/3,srv|/library/metadata/4', Object.keys(final.neverAir).join());

        // Renumbering: the channel page saves under the new number, then deletes the old one.
        await service.saveChannel(9, Object.assign(channel(9, 'Seven, renumbered'), { catalogFrom: 7 }), { keepCatalog: true });
        await service.deleteChannel(7);
        const moved = await service.getCatalog(9);
        const movedFile = JSON.parse(fs.readFileSync(path.join(channels, '9.json'), 'utf8'));
        suite.check('renumbering a channel keeps its catalog',
            Object.keys(moved.neverAir).length === 2 && !!moved.shows['tv.Futurama'] && movedFile.catalogFrom === undefined, JSON.stringify(moved));
        await service.saveChannel(7, channel(7, 'Seven'));
        await service.applyCatalogOps(7, [{ neverAir: [entry(3), entry(4)] }]);

        let threw = null;
        try { await service.applyCatalogOps(7, [{ explode: 1 }]); } catch (err) { threw = err; }
        suite.check('a bad op is refused and nothing is saved', threw !== null && Object.keys((await service.getCatalog(7)).neverAir).length === 2);
    } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { console.log('  (could not remove ' + root + ')'); }
    }
    return suite;
};
