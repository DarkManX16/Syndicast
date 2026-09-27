/*
 * Pure comparison logic used by scripts/test-restore.js to decide whether the
 * channels a restored server reports over HTTP match the channel files inside
 * the backup it was restored from. No filesystem, no HTTP - both sides are
 * just arrays of channel numbers here.
 */
const { Suite } = require('./support');
const { compareChannelNumbers } = require('../scripts/lib/compare-channels');

module.exports = async function run() {
    const suite = new Suite('backup restore check');

    {
        const result = compareChannelNumbers([1, 2, 3], [3, 1, 2]);
        suite.check('same numbers in a different order is a match',
            result.ok === true, JSON.stringify(result));
    }
    {
        const result = compareChannelNumbers([1, 2, 3], [1, 2]);
        suite.check('a channel missing from the live server is reported',
            result.ok === false && result.missing.length === 1 && result.missing[0] === 3,
            JSON.stringify(result));
    }
    {
        const result = compareChannelNumbers([1, 2], [1, 2, 3]);
        suite.check('a channel the live server has that the backup does not is reported as extra',
            result.ok === false && result.extra.length === 1 && result.extra[0] === 3,
            JSON.stringify(result));
    }
    {
        // Same count and same set can still hide a duplicate masking a missing
        // one (e.g. backup has [1,2,3], live reports [1,1,3]) - count alone
        // isn't enough, the set comparison is what actually catches this.
        const result = compareChannelNumbers([1, 2, 3], [1, 1, 3]);
        suite.check('a duplicate standing in for a missing channel number is still caught',
            result.ok === false, JSON.stringify(result));
    }
    {
        const result = compareChannelNumbers([], []);
        suite.check('two empty lists match',
            result.ok === true, JSON.stringify(result));
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
