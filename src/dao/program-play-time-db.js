const path = require('path');
var fs = require('fs');

// Files read at once while loading; far under any open-file limit.
const LOAD_CONCURRENCY = 32;
 
class ProgramPlayTimeDB {

    constructor(dir) {
        this.dir = dir;
        this.programPlayTimeCache = {};
    }


    async load() {
        try {
            if (! (await fs.promises.stat(this.dir)).isDirectory()) {
                return;
            }
        } catch (err) {
            return;
        }
        let files = await fs.promises.readdir(this.dir);

        let processSubFileName = async (fileName, subDir, subFileName) => {
            try {
                if (subFileName.endsWith(".json")) {
                    let programKey64 = subFileName.substring(
                        0,
                        subFileName.length - 4
                    );
                    let programKey = Buffer.from(programKey64, 'base64')
                        .toString('utf-8');


                    let filePath = path.join(subDir, subFileName);
                    let fileContent = await fs.promises.readFile(
                        filePath, 'utf-8');
                    let jsonData = JSON.parse(fileContent);
                    let key = getKey(fileName, programKey);
                    this.programPlayTimeCache[ key ] = jsonData["t"]
                }
            } catch (err) {
                console.log(`When processing ${subDir}/${subFileName}`, err);
            }
        }

        // One list of every file under every channel's folder, read through a
        // small pool: opening them all at once ran past the process's limit on
        // open files (EMFILE) and dropped most of the play history.
        let jobs = [];
        await Promise.all( files.map( async fileName => {
            const subDir = path.join(this.dir, fileName);
            try {
                let subFiles = await fs.promises.readdir( subDir );
                for (let i = 0; i < subFiles.length; i++) {
                    jobs.push( [fileName, subDir, subFiles[i]] );
                }
            } catch (err) {
                console.log(`When processing ${subDir}`, err);
            }
        }) );

        let next = 0;
        let worker = async () => {
            while (next < jobs.length) {
                let [fileName, subDir, subFileName] = jobs[next++];
                await processSubFileName(fileName, subDir, subFileName);
            }
        };
        let workers = [];
        for (let i = 0; i < Math.min(LOAD_CONCURRENCY, jobs.length); i++) {
            workers.push( worker() );
        }
        await Promise.all( workers );
    }

    getProgramLastPlayTime(channelId, programKey) {
        let v = this.programPlayTimeCache[ getKey(channelId, programKey) ];
        if (typeof(v) === 'undefined') {
            v = 0;
        }
        return v;
    }

    async update(channelId, programKey, t) {

        let key = getKey(channelId, programKey);
        this.programPlayTimeCache[ key ] = t;

        const channelDir = path.join(this.dir, `${channelId}`);
        await fs.promises.mkdir( channelDir, { recursive: true } );
        let key64 = Buffer.from(programKey, 'utf-8').toString('base64');
        let filepath = path.join(channelDir, `${key64}.json`);
        let data = {t:t};
        await fs.promises.writeFile(filepath, JSON.stringify(data), 'utf-8');
    }

}

function getKey(channelId, programKey) {
    return channelId + "|" + programKey;
}


module.exports = ProgramPlayTimeDB;