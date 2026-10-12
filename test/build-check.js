/*
 * The editor's check that the server it talks to is running the code the page
 * was built from: src/code-fingerprint.js (what the server reports) and
 * src/build-check.js (what the editor makes of it). See NOTES.md, Known
 * issues, "Swaps, inserts and Flex that keeps time" (Task 4c).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const { codeFingerprint } = require('../src/code-fingerprint');
const buildCheck = require('../src/build-check');

function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-'));
    fs.mkdirSync(path.join(root, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = "a";\n');
    fs.writeFileSync(path.join(root, 'src', 'services', 'b.js'), 'module.exports = "b";\n');
    return root;
}

module.exports = async function () {
    const suite = new Suite('build-check');
    const root = tempRoot();
    try {
        suite.log('-- the fingerprint --');
        const first = codeFingerprint(root);
        suite.check('the same files give the same fingerprint, however often it is asked',
            typeof first === 'string' && first.length > 0 && codeFingerprint(root) === first && codeFingerprint(root) === first);
        fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = "changed";\n');
        const edited = codeFingerprint(root);
        suite.check('a changed file changes it - even one of the same length, written within the same second',
            edited !== first);
        fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = "a";\n');
        suite.check('...and putting it back puts the fingerprint back', codeFingerprint(root) === first);
        fs.writeFileSync(path.join(root, 'src', 'services', 'c.js'), '\n');
        suite.check('a new file changes it', codeFingerprint(root) !== first);
        fs.rmSync(path.join(root, 'src', 'services', 'c.js'));
        fs.writeFileSync(path.join(root, 'src', 'notes.txt'), 'not code\n');
        fs.mkdirSync(path.join(root, 'web'), { recursive: true });
        fs.writeFileSync(path.join(root, 'web', 'page.js'), 'browser code\n');
        suite.check('a file that is not server code (a .txt under src, anything under web) does not',
            codeFingerprint(root) === first);
        fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 2;\n');
        suite.check('index.js counts', codeFingerprint(root) !== first);

        suite.log('-- the verdict --');
        const same = buildCheck.verdict({ codeRunning: 'abc', codeOnDisk: 'abc' });
        suite.check('a server running what is on disk is fine', same.ok === true && same.message === '');
        const differ = buildCheck.verdict({ codeRunning: 'abc', codeOnDisk: 'abd' });
        suite.check('a server running other code than is on disk is stale, in plain words',
            differ.ok === false && differ.message === 'Your server is still running older code than this page. Restart your server first, then reload this page and try again.',
            differ.message);
        const older = buildCheck.verdict({ dizquetv: '0.1.0', gitCommit: 'edeb025' });
        suite.check('a server that reports neither - an older build - is stale too',
            older.ok === false && older.message === differ.message);
        suite.check('...and so is an answer with nothing in it',
            buildCheck.verdict(undefined).ok === false && buildCheck.verdict(null).ok === false && buildCheck.verdict('error').ok === false);
        suite.check('...but not knowing, when the server could not be asked, never blocks',
            buildCheck.verdict(buildCheck.UNKNOWN).ok === true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    suite.log('-- the guard --');
    {
        let generated = 0;
        const generate = async () => { generated++; return 'lineup'; };
        let refused = null;
        try {
            await buildCheck.guard({ fetchVersion: async () => ({ codeRunning: 'a', codeOnDisk: 'b' }), run: generate });
        } catch (err) {
            refused = err;
        }
        suite.check('the guard refuses a stale server with the message, and never runs what it guards',
            refused !== null && refused.message === buildCheck.MESSAGE && refused.serverStale === true && generated === 0,
            refused && refused.message);
        const ok = await buildCheck.guard({ fetchVersion: async () => ({ codeRunning: 'a', codeOnDisk: 'a' }), run: generate });
        suite.check('...runs it for a server on the current code', ok === 'lineup' && generated === 1);
        const unreachable = await buildCheck.guard({ fetchVersion: async () => { throw new Error('no answer'); }, run: generate });
        suite.check('...and when the server cannot be asked, runs it: its own error will say what is wrong',
            unreachable === 'lineup' && generated === 2);
        let thrown = null;
        try {
            await buildCheck.guard({ fetchVersion: async () => ({ codeRunning: 'a', codeOnDisk: 'a' }), run: async () => { throw new Error('boom'); } });
        } catch (err) {
            thrown = err;
        }
        suite.check('...and what it guards fails as it would have, not as a stale server',
            thrown !== null && thrown.message === 'boom' && ! thrown.serverStale);
    }

    suite.log('-- what the server reports --');
    {
        const buildInfo = require('../src/build-info');
        const root = path.join(__dirname, '..');
        suite.check('build-info reports the fingerprint taken at start and one from disk now, which agree while the code is unchanged',
            typeof buildInfo.codeRunning === 'string' && buildInfo.codeRunning.length > 0 && buildInfo.codeNow() === buildInfo.codeRunning
                && buildInfo.codeRunning === codeFingerprint(root),
            `${buildInfo.codeRunning} / ${buildInfo.codeNow()}`);
    }

    return suite;
};
