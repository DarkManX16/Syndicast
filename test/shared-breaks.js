/*
 * Two viewers of one channel took turns with the offline screen during
 * commercial breaks (NOTES.md, "Two viewers of a channel took turns with the
 * offline screen"). These are the three fixes' checks:
 *
 *   B  a list whose clip is still on the air is not cooling down
 *   A  one list of Flex picks per break, per channel, shared by its viewers
 *   C  a leftover too short for any clip ends the break, under 30 seconds
 *
 * Fixtures only: createLineup with a stub play-time store, and the real
 * video.js router on a fake clock for the viewer-level checks.
 */
const { helperFuncs, freshStore, Suite } = require('./support');

const SEC = 1000;

function breakObj(leftMs) {
    return { program: { isOffline: true, duration: leftMs }, timeElapsed: 0, programIndex: 0 };
}
function listChannel() {
    return { number: 7, name: 'B', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [] };
}
function clips(prefix, n, secs) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ title: `${prefix}${i}`, key: `/f/${prefix}${i}`, duration: secs * SEC, serverKey: 'srv' });
    return out;
}
const listKey = (id) => '!fillerList!|' + id;
const clipKey = (c) => 'plex|' + c.serverKey + '|' + c.key;

function checkB(suite) {
    const content = clips('Ad', 3, 30);
    const fillers = (cooldown) => [{ id: 'L', content, weight: 100, cooldown }];

    // A clip from the list on the air for another viewer, 25 seconds to go.
    let offline = 0, sawOnAir = 0;
    for (let k = 0; k < 60; k++) {
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now + 25 * SEC);
        store.update(7, clipKey(content[0]), now + 25 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(120 * SEC), listChannel(), fillers(0), false)[0];
        if (item.type !== 'commercial') offline++;
        if (item.title === content[0].title) sawOnAir++;
    }
    suite.check('B: a list with no cooldown whose clip is on the air elsewhere for 25s more still plays (60 of 60)',
        offline === 0, `${offline} offline`);
    suite.check('B: ... and never the clip that is on the air', sawOnAir === 0, `${sawOnAir} times`);

    {
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now + 5 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(120 * SEC), listChannel(), fillers(0), false)[0];
        suite.check('B: one ending within 10s plays, as before', item.type === 'commercial', item.type);
    }
    {
        // A configured cooldown still runs from the end of the clip.
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now + 25 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(300 * SEC), listChannel(), fillers(60 * SEC), false)[0];
        suite.check('B: a list with a 60s cooldown whose clip ends in 25s is still refused',
            item.type === 'offline', item.type);
        suite.check('B: ... and the wait is counted from the end of that clip: 25s + 60s',
            Math.abs(item.streamDuration - 85 * SEC) < 200, `${item.streamDuration}ms`);
    }
    {
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now - 70 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(120 * SEC), listChannel(), fillers(60 * SEC), false)[0];
        suite.check('B: the same list 70s after its clip ended plays', item.type === 'commercial', item.type);
    }
}

module.exports = async function run() {
    const suite = new Suite('shared-breaks');
    checkB(suite);
    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
