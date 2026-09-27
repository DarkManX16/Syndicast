const { execSync } = require('child_process');
const path = require('path');
const constants = require('./constants');

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

const gitCommit = readGitCommit();
const gitDirty = readGitDirty();

module.exports = {
    version: constants.VERSION_NAME,
    gitCommit,
    gitDirty,
    startTime,
};
