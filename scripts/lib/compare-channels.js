// Compares the channel numbers a restored server reports over HTTP against
// the channel numbers found in the backup it was restored from. Set
// comparison, not just a count: a duplicate number on one side masking a
// missing one would still pass a plain length check.
function compareChannelNumbers(expected, actual) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = [...expectedSet].filter((n) => !actualSet.has(n)).sort((a, b) => a - b);
    const extra = [...actualSet].filter((n) => !expectedSet.has(n)).sort((a, b) => a - b);
    return {
        ok: missing.length === 0 && extra.length === 0 && expected.length === actual.length,
        expectedCount: expected.length,
        actualCount: actual.length,
        missing,
        extra,
    };
}

module.exports = { compareChannelNumbers };
