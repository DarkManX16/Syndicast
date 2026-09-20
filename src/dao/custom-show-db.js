const path = require('path');
const { v4: uuidv4 } = require('uuid');
let fs = require('fs');
 
class CustomShowDB {

    constructor(folder) {
        this.folder = folder;
    }

    async $loadShow(id) {
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

    async getShow(id) {
        return await this.$loadShow(id);
    }

    async saveShow(id, json) {
        if (typeof(id) === 'undefined') {
            throw Error("Mising custom show id");
        }
        fixup(json);
        if (typeof(json.rank) !== 'number') {
            // The show editor posts only name and content. Without this the show
            // would lose its position every time someone edited its programs.
            let existing = await this.getShow(id);
            if (existing !== null && typeof(existing.rank) === 'number') {
                json.rank = existing.rank;
            }
        }
        let f = path.join(this.folder, `${id}.json` );

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
    }

    async createShow(json) {
        let id = uuidv4();
        fixup(json);
        if (typeof(json.rank) !== 'number') {
            json.rank = await this.$nextRank();
        }
        await this.saveShow(id, json);
        return id;
    }

    async $nextRank() {
        let shows = await this.getAllShows();
        let max = -1;
        for (let i = 0; i < shows.length; i++) {
            if (typeof(shows[i].rank) === 'number' && shows[i].rank > max) {
                max = shows[i].rank;
            }
        }
        return max + 1;
    }

    async saveShowOrder(ids) {
        if (!Array.isArray(ids)) {
            throw Error("Expected an array of custom show ids");
        }
        for (let i = 0; i < ids.length; i++) {
            let show = await this.getShow(ids[i]);
            if (show === null) {
                continue;
            }
            show.rank = i;
            await this.saveShow(ids[i], show);
        }
    }

    async deleteShow(id) {
            let f = path.join(this.folder, `${id}.json` );
            await new Promise( (resolve, reject) => {
                fs.unlink(f, function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            });
    }

    
    async getAllShowIds() {
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
    
    async getAllShows() {
        let ids = await this.getAllShowIds();
        let shows = await Promise.all( ids.map( async (c) => this.getShow(c) ) );
        // Ordering lives here rather than in a page controller so that every
        // caller - the custom shows page, the Plex library picker - agrees.
        return shows.filter( (s) => s !== null ).sort(compareShowOrder);
    }

    async getAllShowsInfo() {
        //returns just name and id
        let shows = await this.getAllShows();
        return shows.map( (f) =>  {
            return {
                'id'  : f.id,
                'name': f.name,
                'count': f.content.length,
            }
        } );
    }


}

function fixup(json) {
    if (typeof(json.content) === 'undefined') {
        json.content = [];
    }
    if (typeof(json.name) === 'undefined') {
        json.name = "Unnamed Show";
    }
    if (typeof(json.rank) !== 'number' || isNaN(json.rank)) {
        delete json.rank;
    }
}

// Shows that predate ranking have none, so they sort alphabetically after the
// ranked ones and get real ranks the first time the user reorders anything.
function compareShowOrder(a, b) {
    let ar = (typeof(a.rank) === 'number') ? a.rank : Number.MAX_SAFE_INTEGER;
    let br = (typeof(b.rank) === 'number') ? b.rank : Number.MAX_SAFE_INTEGER;
    if (ar !== br) {
        return ar - br;
    }
    return (a.name || "").localeCompare(b.name || "");
}

module.exports = CustomShowDB;