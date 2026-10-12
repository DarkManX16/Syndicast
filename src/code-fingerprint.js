/*
 * A fingerprint of the server's own source: index.js and every .js file under
 * src, paths and contents, in a fixed order. The server takes one when it
 * starts and reports it beside a fresh one from disk (src/build-info.js,
 * /api/version), so the editor can tell when the server it talks to is
 * running older code than the page it served (src/build-check.js). web/ is
 * not in it: that is the page, rebuilt on request.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function listJs(dir, prefix) {
    let out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return out;
    }
    for (const entry of entries) {
        const rel = prefix + '/' + entry.name;
        if (entry.isDirectory()) {
            out = out.concat(listJs(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(rel);
        }
    }
    return out;
}

function codeFingerprint(root) {
    const files = ['index.js'].concat(listJs(path.join(root, 'src'), 'src')).sort();
    const hash = crypto.createHash('sha1');
    for (const rel of files) {
        let body;
        try {
            body = fs.readFileSync(path.join(root, rel));
        } catch (err) {
            continue;
        }
        hash.update(rel + '\0' + body.length + '\0');
        hash.update(body);
    }
    return hash.digest('hex').slice(0, 12);
}

module.exports = { codeFingerprint };
