const execFile = require('child_process').execFile;
const { markHighQos } = require('./ffmpeg-qos');

class FFMPEGInfo {
    constructor(opts) {
        this.ffmpegPath = opts.ffmpegPath
    }
    async getVersion() {
        try {
            let s = await new Promise( (resolve, reject) => {
                // execFile rather than exec, so the child is ffmpeg itself and not a shell around it
                let child = execFile( this.ffmpegPath, ['-version'], function(error, stdout, stderr){
                    if (error !== null) {
                        reject(error);
                    } else {
                        resolve(stdout);
                    }
                });
                markHighQos(child);
            });
            var m = s.match( /version\s+([^\s]+)\s+.*Copyright/ )
            if (m == null) {
                console.error("ffmpeg -version command output not in the expected format: " + s);
                return "Unknown";
            }
            return m[1];
        } catch (err) {
            console.error("Error getting ffmpeg version", err);
            return "Error";
        }
    }
}

module.exports = FFMPEGInfo