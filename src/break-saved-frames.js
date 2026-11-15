/*
 * Saved frames (docs/blocks-spec.md, Stage 6, build order 5c; DarkManX16, Nov 15): the two
 * frames of each point waiting on the list to check, cut by the scanner and kept in a folder
 * of their own, `<data>/breaks-saved-frames/<show key>/`, so the Breaks page rarely has to
 * read a drive while someone watches from it. Apart from the page's own 4,000-frame cache
 * (break-frames.js), whose pruning never reaches them.
 *
 * Which frames a show wants is worked out from its record each time: a show in Needs a click,
 * its episodes on the list to check, their points still waiting (status `found`), the frames
 * either side of each (breaks-page.framesOf). A frame's name carries the file's size and date,
 * so a file that changes wants new ones. sweep() deletes every saved frame of a show it no
 * longer wants: a point approved, rejected or moved, an episode off the list, a changed file.
 */
const fs = require('fs');
const path = require('path');
const store = require('./breaks-store');
const page = require('./breaks-page');
const { frameName } = require('./break-frames');

const DIR = 'breaks-saved-frames';

class SavedFrames {
    constructor(folder) {
        this.dir = path.join(folder, DIR);
    }

    showDir(key) {
        return path.join(this.dir, store.sanitizeKey(key));
    }

    pathFor(key, file, record, t) {
        return path.join(this.showDir(key), frameName(file, record, t));
    }

    // [{ file, record, t, out }]: what the list to check wants of this show (of one file, if given).
    wanted(key, show, only = null) {
        if ( (show == null) || (show.theatrical === true) ) {
            return [];
        }
        const d = page.detail(key, show, key);
        if (! d.line.needsClick) {
            return [];
        }
        const out = [];
        for (const e of d.toCheck) {
            const record = (show.files || {})[e.path];
            if ( (record == null) || ( (only !== null) && (e.path !== only) ) ) {
                continue;
            }
            for (const p of e.points.filter( (x) => x.status === 'found' )) {
                for (const t of new Set( [ p.frames.before, p.frames.after ] )) {
                    out.push( { file: e.path, record, t, out: this.pathFor(key, e.path, record, t) } );
                }
            }
        }
        return out;
    }

    // A saved frame of `file` at `t`, if there is one.
    existing(key, file, record, t) {
        const p = this.pathFor(key, file, record, t);
        return fs.existsSync(p) ? p : null;
    }

    missing(key, show, only = null) {
        return this.wanted(key, show, only).filter( (w) => ! fs.existsSync(w.out) );
    }

    // Deletes the show's saved frames it no longer wants; returns how many.
    sweep(key, show) {
        const dir = this.showDir(key);
        if (! fs.existsSync(dir)) {
            return 0;
        }
        const keep = new Set(this.wanted(key, show).map( (w) => path.basename(w.out) ));
        let n = 0;
        for (const f of fs.readdirSync(dir)) {
            if (! keep.has(f)) {
                fs.rmSync(path.join(dir, f), { force: true });
                n++;
            }
        }
        return n;
    }
}

module.exports = { SavedFrames, DIR };
