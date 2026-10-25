//Adds a slight pause so that long operations
//don't hold up the server. In a browser - the re-lay worker, src/relay-worker.js
//- there is nothing else to let run, and the bundle's own setImmediate is a
//setTimeout held to 4 ms: there it resolves at once.
const inNode = (typeof(process) === 'object') && (process !== null) && (typeof(process.versions) === 'object')
    && (typeof(process.versions.node) === 'string');
module.exports = function() {
    return new Promise((resolve) => {
        if (inNode && (typeof(setImmediate) === 'function')) {
            setImmediate(() => resolve());
        } else {
            resolve();
        }
    });
}
