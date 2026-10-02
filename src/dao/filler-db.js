const path = require('path');
const { v4: uuidv4 } = require('uuid');
const showMatch = require('../show-match');
let fs = require('fs');
 
class FillerDB {

    constructor(folder) {
        this.folder = folder;
        this.cache = {};
    }

    async $loadFiller(id) {
        let f = path.join(this.folder, `${id}.json` );
        try {
            return await new Promise( (resolve, reject) => {
                fs.readFile(f, (err, data) => {
                    if (err) {
                        return reject(err);
                    }
                    try {
                        let j = JSON.parse(data);
                        j.id = id;
                        resolve(j);
                    } catch (err) {
                        reject(err);
                    }
                })
            });
        } catch (err) {
            console.error(err);
            return null;
        }
    }

    async getFiller(id) {
        if (typeof(this.cache[id]) === 'undefined') {
            this.cache[id] = await this.$loadFiller(id);
        }
        return this.cache[id];
    }

    async saveFiller(id, json) {
        if (typeof(id) === 'undefined') {
            throw Error("Mising filler id");
        }
        fixup(json);
        warnAboutNames(id, json);
        if (typeof(json.rank) !== 'number') {
            // The filler editor posts only name and content. Without this the
            // list would lose its position every time someone edited its clips.
            let existing = await this.getFiller(id);
            if (existing !== null && typeof(existing.rank) === 'number') {
                json.rank = existing.rank;
            }
        }
        let f = path.join(this.folder, `${id}.json` );
        try {
            await new Promise( (resolve, reject) => {
                let data = undefined;
                try {
                    //id is determined by the file name, not the contents
                    delete json.id;
                    data = JSON.stringify(json);
                } catch (err) {
                    return reject(err);
                }
                fs.writeFile(f, data, (err) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            });
        } finally {
            delete this.cache[id];
        }
    }

    async createFiller(json) {
        let id = uuidv4();
        fixup(json);
        if (typeof(json.rank) !== 'number') {
            json.rank = await this.$nextRank();
        }
        await this.saveFiller(id, json);
        return id;
    }

    async $nextRank() {
        let fillers = await this.getAllFillers();
        let max = -1;
        for (let i = 0; i < fillers.length; i++) {
            if (typeof(fillers[i].rank) === 'number' && fillers[i].rank > max) {
                max = fillers[i].rank;
            }
        }
        return max + 1;
    }

    async saveFillerOrder(ids) {
        if (!Array.isArray(ids)) {
            throw Error("Expected an array of filler ids");
        }
        for (let i = 0; i < ids.length; i++) {
            let filler = await this.getFiller(ids[i]);
            if (filler === null) {
                continue;
            }
            filler.rank = i;
            await this.saveFiller(ids[i], filler);
        }
    }
    async deleteFiller(id) {
        try {
            let f = path.join(this.folder, `${id}.json` );
            await new Promise( (resolve, reject) => {
                fs.unlink(f, function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            });
        } finally {
            delete this.cache[id];
        }
    }

    
    async getAllFillerIds() {
        return await new Promise( (resolve, reject) => {
            fs.readdir(this.folder, function(err, items) {
                if (err) {
                    return reject(err);
                }
                let fillerIds = [];
                for (let i = 0; i < items.length; i++) {
                    let name = path.basename( items[i] );
                    if (path.extname(name) === '.json') {
                        let id = name.slice(0, -5);
                        fillerIds.push(id);
                    }
                }
                resolve (fillerIds);
            });
        });
    }
    
    async getAllFillers() {
        let ids = await this.getAllFillerIds();
        let fillers = await Promise.all( ids.map( async (c) => this.getFiller(c) ) );
        // Ordering lives here rather than in a page controller so that every
        // caller - the filler page, the channel config dropdown - agrees.
        return fillers.filter( (f) => f !== null ).sort(compareFillerOrder);
    }

    async getAllFillersInfo() {
        //returns just name and id
        let fillers = await this.getAllFillers();
        return fillers.map( (f) =>  {
            return {
                'id'  : f.id,
                'name': f.name,
                'count': f.content.length,
            }
        } );
    }



}

/*
 * A clip may carry `names`: one show key, or two (now, then), saying which
 * shows it is about. See docs/blocks-spec.md, Stage 5. Warned about at the one
 * place every list write passes through, for the same reason channel-db.js
 * warns about day-parts: nothing fails on a bad value, the clip just stops
 * naming anything, and that should not happen silently. Warn-only, rewrites
 * nothing; show-match.js's namesOf reads a malformed value as unnamed.
 */
function warnAboutNames(id, json) {
    if (! Array.isArray(json.content) ) {
        return;
    }
    for (const clip of json.content) {
        const problem = showMatch.namesProblem(clip);
        if (problem !== null) {
            console.error(`Filler list ${id} ("${json.name}"): clip "${clip.title}" has an unusable names field - ${problem}. It will be treated as naming no show.`);
        }
    }
}

function fixup(json) {
    if (typeof(json.content) === 'undefined') {
        json.content = [];
    }
    if (typeof(json.name) === 'undefined') {
        json.name = "Unnamed Filler";
    }
    if (typeof(json.rank) !== 'number' || isNaN(json.rank)) {
        delete json.rank;
    }
}

// Lists that predate ranking have none, so they sort alphabetically after the
// ranked ones and get real ranks the first time the user reorders anything.
function compareFillerOrder(a, b) {
    let ar = (typeof(a.rank) === 'number') ? a.rank : Number.MAX_SAFE_INTEGER;
    let br = (typeof(b.rank) === 'number') ? b.rank : Number.MAX_SAFE_INTEGER;
    if (ar !== br) {
        return ar - br;
    }
    return (a.name || "").localeCompare(b.name || "");
}

module.exports = FillerDB;