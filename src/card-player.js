/******************
 * Plays a generated card (docs/blocks-spec.md, Stage 5, "Generated cards").
 * Follows the program-player contract, like plex-player.js, with the Plex part
 * taken out: a card is a file Syndicast rendered itself, so it goes straight to
 * the same FFMPEG.spawnStream every Plex clip goes through, and comes out of it
 * encoded the way the channel streams everything else.
 **/
const EventEmitter = require('events');
const FFMPEG = require('./ffmpeg');
const constants = require('./constants');

class CardPlayer {

    constructor(context) {
        this.context = context;
        this.ffmpeg = null;
        this.killed = false;
    }

    cleanUp() {
        this.killed = true;
        if (this.ffmpeg != null) {
            this.ffmpeg.kill();
            this.ffmpeg = null;
        }
    }

    async play(outStream) {
        const lineupItem = this.context.lineupItem;
        const ffmpegSettings = this.context.ffmpegSettings;
        const channel = this.context.channel;
        const streamStats = Object.assign( { audioIndex: 'a', pixelP: 1, pixelQ: 1, anamorphic: false, audioOnly: false },
            lineupItem.streamStats || {} );
        streamStats.duration = lineupItem.streamDuration;
        let streamDuration;
        if ( (typeof(lineupItem.streamDuration) !== 'undefined')
            && (lineupItem.start + lineupItem.streamDuration + constants.SLACK < lineupItem.duration) ) {
            streamDuration = lineupItem.streamDuration / 1000;
        }

        let ffmpeg = new FFMPEG(ffmpegSettings, channel);
        ffmpeg.setAudioOnly(this.context.audioOnly);
        this.ffmpeg = ffmpeg;
        const emitter = new EventEmitter();
        let ff = await ffmpeg.spawnStream(lineupItem.generatedFile, streamStats, undefined, streamDuration,
            this.context.watermark, lineupItem.type);
        if (this.killed) {
            return emitter;
        }
        ff.pipe(outStream, { end: false });
        ffmpeg.on('end', () => emitter.emit('end'));
        ffmpeg.on('close', () => emitter.emit('close'));
        ffmpeg.on('error', async (err) => {
            console.log('Replacing failed card with error stream');
            ff.unpipe(outStream);
            ffmpeg.removeAllListeners('data');
            ffmpeg.removeAllListeners('end');
            ffmpeg.removeAllListeners('error');
            ffmpeg.removeAllListeners('close');
            ffmpeg = new FFMPEG(ffmpegSettings, channel);
            ffmpeg.setAudioOnly(this.context.audioOnly);
            this.ffmpeg = ffmpeg;
            ffmpeg.on('close', () => emitter.emit('close'));
            ffmpeg.on('end', () => emitter.emit('end'));
            ffmpeg.on('error', (e) => emitter.emit('error', e));
            ff = await ffmpeg.spawnError('oops', 'oops', Math.min(streamStats.duration || 15000, 60000));
            ff.pipe(outStream);
            emitter.emit('error', err);
        } );
        return emitter;
    }
}

module.exports = CardPlayer;
