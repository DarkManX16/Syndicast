const path = require('path');
const { v4: uuidv4 } = require('uuid');
let fs = require('fs');
 
class FillerDB {

    constructor(folder,  channelService) {
        this.folder = folder;
        this.cache = {};
        this.channelService = channelService;


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

    async getFillerChannels(id) {
        let numbers = await this.channelService.getAllChannelNumbers();
        let channels = [];
        await Promise.all( numbers.map( async(number) => {
            let ch = await this.channelService.getChannel(number);
            let name = ch.name;
            let fillerCollections = ch.fillerCollections;
            for (let i = 0 ; i < fillerCollections.length; i++) {
                if (fillerCollections[i].id === id) {
                    channels.push( {
                        number: number,
                        name : name,
                    } );
                    break;
                }
            }
            ch = null;

        } ) );
        return channels;
    }

    async deleteFiller(id) {
        try {
            let channels = await this.getFillerChannels(id);
            await Promise.all( channels.map( async(channel) => {
                console.log(`Updating channel ${channel.number} , remove filler: ${id}`);
                let json = await channelService.getChannel(channel.number);
                json.fillerCollections = json.fillerCollections.filter( (col) => {
                    return col.id != id;
                } );
                await this.channelService.saveChannel( channel.number, json );
            } ) );

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

    async getFillersFromChannel(channel) {

        let loadChannelFiller = async(fillerEntry) => {
            let content = [];
            try {
                let filler = await this.getFiller(fillerEntry.id);
                content = filler.content;
            } catch(e) {
                console.error(`Channel #${channel.number} - ${channel.name} references an unattainable filler id: ${fillerEntry.id}`);
            }
            return {
                id: fillerEntry.id,
                content: content,
                weight: fillerEntry.weight,
                cooldown: fillerEntry.cooldown,
            }
        };
        return await Promise.all(
            channel.fillerCollections.map(loadChannelFiller)
        );
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