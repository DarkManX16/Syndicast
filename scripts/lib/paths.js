// Shared defaults for the backup CLIs. Overridable via --source/--dest so
// the live install (see NOTES.md's 1.0 must list) can point this same
// tooling at its own folder instead of needing its own copy of it.
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_SOURCE = path.join(REPO_ROOT, '.dizquetv-dev');
const DEFAULT_DEST_ROOT = path.join(REPO_ROOT, '..', 'dizquetv-backups');

module.exports = { REPO_ROOT, DEFAULT_SOURCE, DEFAULT_DEST_ROOT };
