//Adds a slight pause so that long operations
//don't hold up the server.
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
