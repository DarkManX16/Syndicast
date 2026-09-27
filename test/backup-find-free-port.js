/*
 * scripts/lib/find-free-port.js: picks a spare port for test-restore's
 * throwaway server by actually trying to bind each candidate, per NOTES.md's
 * own "Windows NAT can grab a port with nothing listening" finding - a port
 * looking free is not enough to trust, so this never guesses.
 */
const net = require('net');
const { Suite } = require('./support');
const { canBind, findFreePort } = require('../scripts/lib/find-free-port');

// No host, to match find-free-port.js's own canBind and the real app's
// app.listen(port, cb) - otherwise this could bind a different socket than
// the one canBind checks and never actually collide with it.
function occupy(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, () => resolve(server));
    });
}
function release(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

module.exports = async function run() {
    const suite = new Suite('find free port');

    // Ask the OS for an ephemeral port to occupy, so this suite never hard-codes
    // a port number that might collide with something else on the machine.
    const held = await occupy(0);
    const occupiedPort = held.address().port;

    try {
        const stillBusy = await canBind(occupiedPort);
        suite.check('canBind reports false for a port already listening',
            stillBusy === false);

        const anotherFreePort = occupiedPort === 65535 ? occupiedPort - 1 : occupiedPort + 1;
        const picked = await findFreePort([occupiedPort, anotherFreePort]);
        suite.check('findFreePort skips a busy candidate and returns the next free one',
            picked === anotherFreePort, `picked ${picked}`);

        let threw = null;
        try {
            await findFreePort([occupiedPort]);
        } catch (err) {
            threw = err;
        }
        suite.check('findFreePort throws when every candidate is busy',
            threw !== null);
    } finally {
        await release(held);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
