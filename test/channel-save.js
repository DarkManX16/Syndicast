/*
 * The channel save path, at the two places it used to let the in-memory view and
 * the on-disk view disagree:
 *
 *  - configCache used to be repopulated with the channel being written, before
 *    the DAO had validated it, so a rejected save left every consumer reading a
 *    channel that never committed. It now invalidates instead.
 *  - fs.writeFile truncates the target first, so a read landing mid-write gets a
 *    partial file and getChannel returned null for it - which every consumer
 *    reads as "channel doesn't exist". Repopulating the cache hid that, because
 *    concurrent readers got a cache hit and never reached the file; invalidating
 *    sends them to disk, so getChannel now retries an unparseable read instead.
 *    See the comment on READ_RETRY_DELAYS in src/dao/channel-db.js for why the
 *    usual temp-file-and-rename is not what this does.
 *
 * The only file in test/ that touches a data folder, because both of the above
 * are about what is on disk and a fixture in memory cannot show either. It makes
 * its own folder under the OS temp directory and removes it again, so it still
 * needs no data folder of the user's and no running server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite, channelCache, show, flex } = require('./support');
const ChannelDB = require('../src/dao/channel-db');
const ChannelService = require('../src/services/channel-service');

function tempFolder() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-test-'));
    const channels = path.join(root, 'channels');
    fs.mkdirSync(channels);
    return { root, channels };
}

function removeFolder(root) {
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch (err) {
        console.log('  (could not remove ' + root + ': ' + err.code + ')');
    }
}

function channel(number, name, programs) {
    return {
        number,
        name,
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        duration: 0,
        programs: programs || [show('Aqua Teen', 11), flex(3), show('Futurama', 22)],
        fallback: [],
        fillerCollections: [],
        offlineMode: 'pic',
        transcoding: {},
        onDemand: { isOnDemand: false },
    };
}

// Enough programs that replacing the file is not instantaneous, which is what
// makes the torn-read check below mean anything.
function bigChannel(number, name) {
    const programs = [];
    for (let i = 0; i < 30000; i++) {
        programs.push({
            title: `Episode ${i} of something with a realistic length of title`,
            key: `/library/metadata/${100000 + i}`,
            serverKey: 'a-plex-server-name',
            file: `/media/shows/Something/Season 01/Something - s01e${i}.mkv`,
            plexFile: `/library/parts/${200000 + i}/file.mkv`,
            ratingKey: `${300000 + i}`,
            duration: 1320000,
        });
    }
    return channel(number, name, programs);
}

module.exports = async function run() {
    const suite = new Suite('channel save');
    const { root, channels } = tempFolder();

    try {
        const db = new ChannelDB(channels);
        /*
         * ChannelService#saveChannel and #deleteChannel read a bare `channelDB`
         * rather than `this.channelDB`, which resolves to the implicit global
         * index.js creates at `channelDB = new ChannelDB(...)` - no declaration,
         * so it lands on globalThis. Setting it here is what the production
         * wiring does. Passing it to the constructor as well means this keeps
         * working if that is ever tightened to this.channelDB.
         */
        global.channelDB = db;
        const service = new ChannelService(db);

        // ---- a rejected save must not change what anything reads ------------
        channelCache.clear();
        const committed = channel(5, 'Committed');
        await service.saveChannel(5, committed);

        const readBack = await service.getChannel(5);
        suite.check('a saved channel reads back',
            readBack != null && readBack.name === 'Committed',
            readBack == null ? 'got null' : `name ${readBack.name}`);

        let threw = null;
        const rejected = channel(5, 'Rejected');
        try {
            // validateChannelJson throws on a number it cannot parse, before any write
            await service.saveChannel('not-a-number', rejected);
        } catch (err) {
            threw = err;
        }
        suite.check('the DAO rejects a channel whose number will not parse',
            threw !== null, threw === null ? 'it did not throw' : threw.message);

        const afterReject = await service.getChannel(5);
        suite.check('a rejected save leaves the committed channel being served',
            afterReject != null && afterReject.name === 'Committed',
            afterReject == null ? 'got null' : `name ${afterReject.name}`);

        const onDisk = JSON.parse(fs.readFileSync(path.join(channels, '5.json'), 'utf8'));
        suite.check('and the file on disk is untouched',
            onDisk.name === 'Committed', `name ${onDisk.name}`);

        // ---- the lazy reload still makes a successful save visible ----------
        const updated = await service.getChannel(5);
        updated.name = 'Updated';
        await service.saveChannel(5, updated);
        const afterUpdate = await service.getChannel(5);
        suite.check('a successful save is visible on the next read',
            afterUpdate.name === 'Updated', `name ${afterUpdate.name}`);

        /*
         * getChannel hands out whatever getChannelConfig holds. While the cache
         * was repopulated on save that was the caller's own object, so mutating a
         * channel after saving it silently changed what everything else read.
         */
        const mutable = await service.getChannel(5);
        await service.saveChannel(5, mutable);
        mutable.name = 'Mutated after the save';
        const afterMutation = await service.getChannel(5);
        suite.check('mutating a channel after saving it does not change what is served',
            afterMutation.name === 'Updated', `name ${afterMutation.name}`);

        // ---- a read during a write must not report the channel as missing ----
        channelCache.clear();
        await service.saveChannel(6, bigChannel(6, 'Big A'));
        const bytes = fs.statSync(path.join(channels, '6.json')).size;

        // a raw read, to establish that the window this is about is real here
        const rawRead = () => new Promise((resolve) => {
            fs.readFile(path.join(channels, '6.json'), (err, data) => {
                if (err) {
                    return resolve('readerr');
                }
                try {
                    JSON.parse(data);
                    resolve('ok');
                } catch (parseErr) {
                    resolve('torn');
                }
            });
        });

        let rawTorn = 0, daoNull = 0, daoWrongShape = 0, attempts = 0;
        for (let round = 0; round < 5; round++) {
            const next = await service.getChannel(6);
            next.name = `Big ${round}`;
            const writing = service.saveChannel(6, next);
            /*
             * Both read groups have to be issued in the same tick as the write,
             * not one after the other: awaiting the raw reads first would let the
             * write finish before the DAO reads even start, and the two checks
             * below would pass without the retry ladder ever running.
             */
            const [raws, viaDao] = await Promise.all([
                Promise.all([0, 1, 2].map(() => rawRead())),
                Promise.all([0, 1, 2].map(() => db.getChannel(6))),
            ]);
            await writing;
            for (const r of raws) {
                attempts++;
                if (r === 'torn') {
                    rawTorn++;
                }
            }
            for (const c of viaDao) {
                if (c == null) {
                    daoNull++;
                } else if ( (c.number !== 6) || (c.programs.length !== 30000) ) {
                    daoWrongShape++;
                }
            }
        }
        suite.check('the DAO never reports the channel missing while it is being written',
            daoNull === 0, `${daoNull} nulls out of 15 reads`);
        suite.check('and never returns a half-parsed channel',
            daoWrongShape === 0, `${daoWrongShape} wrong-shaped out of 15 reads`);
        /*
         * Informational rather than a check: whether an unprotected read tears is
         * a timing question and would make this suite flaky on a fast enough
         * machine, while the two guarantees above are not timing-dependent. It is
         * here so a reader can tell whether those two proved anything on this run.
         */
        suite.log(`a raw fs.readFile tore ${rawTorn} of ${attempts} reads during the same`
            + ` ${(bytes / 1e6).toFixed(1)}MB writes`
            + (rawTorn === 0 ? ' - so the two checks above proved less than usual here' : ''));
    } finally {
        delete global.channelDB;
        channelCache.clear();
        removeFolder(root);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
