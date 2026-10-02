const path = require('path');
const fs = require('fs');

/*
 * The words that mean a show, `<data>/show-aliases.json`: { "aliases": {
 * "sgc2c": "tv.Space Ghost Coast to Coast" } }. Shared by every filler list and
 * channel, since a word means the same show wherever it appears (see
 * docs/blocks-spec.md, Stage 5, "Which shows a clip names"). There is no alias
 * editor; the filler review screen is the alias editor.
 *
 * Reading never creates, rewrites or repairs the file: a missing file is no
 * aliases, and one that cannot be read is no aliases plus a line in the log,
 * left exactly as it was so nothing hand-edited is lost to a stray typo. Writing
 * is separate and explicit, and nothing in the server calls it yet - the review
 * screen will be the only caller.
 */

const FILE_NAME = 'show-aliases.json';

class ShowAliasDB {

    constructor(folder) {
        this.file = path.join(folder, FILE_NAME);
    }

    async load() {
        let data;
        try {
            data = await new Promise( (resolve, reject) => {
                fs.readFile(this.file, 'utf8', (err, text) => err ? reject(err) : resolve(text));
            } );
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Could not read ${this.file}; treating it as having no aliases.`, err.message);
            }
            return {};
        }
        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch (err) {
            console.error(`${this.file} is not valid JSON; treating it as having no aliases. It has not been changed.`, err.message);
            return {};
        }
        const stored = (parsed != null) && (typeof(parsed) === 'object') ? parsed.aliases : null;
        const aliases = {};
        if ( (stored == null) || (typeof(stored) !== 'object') ) {
            return aliases;
        }
        for (const word of Object.keys(stored)) {
            const key = stored[word];
            if ( (typeof(key) === 'string') && /^[a-z]+\..+/.test(key) ) {
                aliases[word] = key;
            }
        }
        return aliases;
    }

    async save(aliases) {
        const text = JSON.stringify( { aliases: aliases }, null, 2 );
        await new Promise( (resolve, reject) => {
            fs.writeFile(this.file, text, (err) => err ? reject(err) : resolve());
        } );
    }

    /*
     * Adds words that mean nothing yet. A word that already means a show keeps
     * its meaning whatever is passed: changing one is a decision for the review
     * screen, never a side effect of learning another. Returns everything that
     * is stored afterwards, and does not touch the file when there is nothing
     * new to add.
     */
    async merge(added) {
        const aliases = await this.load();
        let changed = false;
        for (const word of Object.keys(added || {}) ) {
            if (! Object.prototype.hasOwnProperty.call(aliases, word) ) {
                aliases[word] = added[word];
                changed = true;
            }
        }
        if (changed) {
            await this.save(aliases);
        }
        return aliases;
    }
}

module.exports = ShowAliasDB;
