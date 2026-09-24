/*
 * Shared helpers for the blocks test suite. Everything here is a thin wrapper
 * over what NOTES.md > "createLineup can be exercised directly" describes:
 * createLineup has no I/O of its own, so filler selection is testable with a
 * stub programPlayTime and plain object fixtures, no ffmpeg or data folder.
 */
const helperFuncs = require('../src/helperFuncs');
const dayParts = require('../src/day-parts');
const channelCache = require('../src/channel-cache');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Parses a local-time ISO string the same way `new Date(string)` does, which
// is what every fixture below is written against - times in this suite are
// deliberately in the machine's own zone, the same as the real resolver.
function at(isoLocal) {
    return new Date(isoLocal).getTime();
}

// A stub programPlayTime: in-memory, forgets nothing, shaped like the real
// ProgramPlayTimeDB (getProgramLastPlayTime/update) so it drops into
// createLineup and channelCache.recordPlayback unchanged.
function freshStore() {
    const t = {};
    return {
        getProgramLastPlayTime: (c, k) => t[c + '|' + k] || 0,
        update: (c, k, v) => { t[c + '|' + k] = v; },
    };
}

function clip(title, mins) {
    return { title, key: '/f/' + title, duration: mins * MIN, serverKey: 'srv' };
}
function show(title, mins) {
    return { title, key: '/s/' + title, duration: mins * MIN, serverKey: 'srv' };
}
function flex(mins) {
    return { isOffline: true, duration: mins * MIN };
}
// entries: [id, weight, cooldownMs?] - the shape a channel or day-part stores
// under fillerCollections.
function mix(entries) {
    return entries.map(([id, weight, cooldown]) => ({ id, weight, cooldown: cooldown || 0 }));
}

/*
 * A minimal check/report harness shared by every file in this directory, so
 * `npm test` gets one combined pass/fail count instead of each file managing
 * its own console output and exit code.
 */
class Suite {
    constructor(name) {
        this.name = name;
        this.count = 0;
        this.failures = 0;
    }
    check(name, ok, detail) {
        this.count++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
        if (!ok) {
            this.failures++;
        }
        return ok;
    }
    log(line) {
        console.log('  ' + line);
    }
}

module.exports = {
    helperFuncs, dayParts, channelCache,
    MIN, HOUR, DAY, at,
    freshStore, clip, show, flex, mix,
    Suite,
};
