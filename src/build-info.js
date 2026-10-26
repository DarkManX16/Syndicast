const { execSync } = require('child_process');
const path = require('path');
const constants = require('./constants');
const { codeFingerprint } = require('./code-fingerprint');

// Captured once, when this module is first required (i.e. at server startup),
// so a long-running process keeps reporting the build and commit it started
// with even after later commits land on disk.
const startTime = new Date();

function readGitCommit() {
    try {
        return execSync('git rev-parse --short HEAD', {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
    } catch (err) {
        return 'unknown';
    }
}

// Tracked files only - untracked files don't count as "modified".
function readGitDirty() {
    try {
        let status = execSync('git status --porcelain --untracked-files=no', {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
        return status.length > 0;
    } catch (err) {
        return false;
    }
}

// The server's own source as it started, and as it is on disk now: the editor
// refuses to make lineups against a server whose two differ (src/build-check.js).
const codeRoot = path.join(__dirname, '..');
const codeRunning = codeFingerprint(codeRoot);
const codeNow = () => codeFingerprint(codeRoot);

const gitCommit = readGitCommit();
const gitDirty = readGitDirty();

module.exports = {
    // Read fresh each call, for stamping a build (src/web-bundle.js).
    readGitCommit,
    readGitDirty,
    version: constants.VERSION_NAME,
    gitCommit,
    gitDirty,
    startTime,
    codeRunning,
    codeNow,
};
