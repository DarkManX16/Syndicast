/*
 * Picks a spare port for test-restore's throwaway server. Per NOTES.md's
 * "Windows NAT can grab port 18000, giving EACCES with nothing listening" -
 * a port reservation can be invisible to every usual check, so the only
 * trustworthy answer is an actual bind test, not an assumption.
 */
const net = require('net');

// No host is passed to listen() - same as index.js's own app.listen(process.env.PORT, ...),
// so this checks the same binding the real server will actually make.
function canBind(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, () => {
            server.close(() => resolve(true));
        });
    });
}

async function findFreePort(candidates) {
    for (const port of candidates) {
        if (await canBind(port)) {
            return port;
        }
    }
    throw new Error(`No free port found among candidates: ${candidates.join(', ')}`);
}

module.exports = { canBind, findFreePort };
