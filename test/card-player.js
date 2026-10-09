/*
 * Generated cards on the air: the lineup item a card step becomes
 * (helperFuncs.createLineup), the player chosen for it (program-player.js), and
 * a real card played through the channel's own ffmpeg path (card-player.js),
 * when ffmpeg is on the PATH.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { PassThrough } = require('stream');
const { helperFuncs, freshStore, Suite } = require('./support');
const cards = require('../src/card-templates');
const render = require('../src/card-render');

/*
 * The players and ffmpeg.js loaded fresh: test/aspect-mark.js requires ffmpeg.js
 * while child_process.spawn is a recorder, and ffmpeg.js keeps the spawn it was
 * loaded with, so the copy in the cache cannot run a real ffmpeg. The cache is
 * put back as it was afterwards.
 */
function freshPlayers() {
    const names = ['../src/ffmpeg', '../src/card-player', '../src/plex-player', '../src/offline-player', '../src/program-player'];
    const saved = {};
    for (const n of names) {
        const p = require.resolve(n);
        saved[p] = require.cache[p];
        delete require.cache[p];
    }
    const ProgramPlayer = require('../src/program-player');
    const restore = () => {
        for (const p of Object.keys(saved)) {
            if (saved[p]) {
                require.cache[p] = saved[p];
            } else {
                delete require.cache[p];
            }
        }
    };
    return { ProgramPlayer, restore };
}

// Channel 1's real ffmpeg settings (Oct 8, 2026), with ffmpeg from the PATH.
const SETTINGS = {
    ffmpegPath: 'ffmpeg', threads: 4, concatMuxDelay: '0', logFfmpeg: false, enableFFMPEGTranscoding: true,
    audioVolumePercent: 100, videoEncoder: 'mpeg2video', audioEncoder: 'aac', targetResolution: '1920x1080',
    videoBitrate: 5000, videoBufSize: 10000, audioBitrate: 192, audioBufSize: 384, audioSampleRate: 48,
    audioChannels: 2, errorScreen: 'testsrc', errorAudio: 'silent', normalizeVideoCodec: true,
    normalizeAudioCodec: true, normalizeResolution: true, normalizeAudio: true, maxFPS: 29.97,
    scalingAlgorithm: 'bicubic', deinterlaceFilter: 'none', disablePreludes: true, disableChannelOverlay: true,
};
const CHANNEL = { number: 1, name: 'Test', transcoding: { targetResolution: '', aspect: 'mark' }, watermark: { enabled: false } };

function haveFfmpeg() {
    return childProcess.spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
}

module.exports = async () => {
    const suite = new Suite('card player');
    const { ProgramPlayer, restore } = freshPlayers();
    try {
        return await run(suite, ProgramPlayer);
    } finally {
        restore();
    }
};

async function run(suite, ProgramPlayer) {

    const transition = {
        kind: 'generated', durationMs: 3000,
        clip: { title: 'Next Time: Gamma', key: 'card|abc', duration: 3000, generatedFile: 'C:/cards/abc.ts',
            streamStats: { videoWidth: 480, videoHeight: 270, videoCodec: 'mpeg2video', audioCodec: 'aac', audioIndex: 'a' } },
    };
    const item = helperFuncs.createLineup(freshStore(), { program: { isOffline: true, duration: 60000 }, timeElapsed: 0,
        transition: transition }, CHANNEL, [], false, Date.now())[0];
    suite.check('a card step becomes a transition item carrying its file and stream details, whole, from its start',
        (item.type === 'transition') && (item.generatedFile === 'C:/cards/abc.ts') && (item.start === 0)
        && (item.streamDuration === 3000) && (item.streamStats.videoWidth === 480) && (typeof(item.serverKey) === 'undefined'), JSON.stringify(item));

    const context = (lineupItem) => ({ lineupItem: lineupItem, ffmpegSettings: Object.assign({}, SETTINGS), channel: CHANNEL,
        db: { 'client-id': { find: () => [{ clientId: 'test' }] } }, audioOnly: false });
    const chosen = new ProgramPlayer(context(item));
    suite.check('the card is played by the card player, not the Plex one', chosen.delegate.constructor.name === 'CardPlayer');
    chosen.cleanUp();

    if (! haveFfmpeg()) {
        suite.log('ffmpeg is not on the PATH: the real playback is skipped.');
        return suite;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-card-play-'));
    try {
        const movie = path.join(dir, 'movie.mp4');
        childProcess.spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=20',
            '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', movie]);
        const format = Object.assign(cards.cardFormat(SETTINGS, CHANNEL), { width: 480, height: 270, videoBitrate: 1500, videoBufSize: 3000 });
        const template = cards.normalizeTemplate( Object.assign( { name: 'T', footageSeconds: 3 },
            (process.platform === 'win32') ? {} : { headingFont: 'DejaVuSans-Bold.ttf', textFont: 'DejaVuSans.ttf' } ) );
        const card = path.join(dir, 'card.ts');
        const job = render.renderJob( { mode: 'footage', template: template, format: format, title: 'Gamma', whenText: 'TONIGHT · 7PM',
            sources: { movie: movie, movieHasAudio: true, momentS: 5, logo: null, poster: null, art: null, ending: null },
            fontDir: (process.platform === 'win32') ? 'C:/Windows/Fonts' : '/usr/share/fonts/truetype/dejavu', workDir: dir, output: card } );
        for (const name of Object.keys(job.files)) {
            fs.writeFileSync(path.join(dir, name), job.files[name], 'utf8');
        }
        suite.check('a small real card renders for the playback test', childProcess.spawnSync('ffmpeg', job.args).status === 0);

        const real = Object.assign({}, item, { generatedFile: card,
            streamStats: { videoWidth: 480, videoHeight: 270, videoFramerate: 29.97, videoCodec: 'mpeg2video', audioCodec: 'aac',
                audioIndex: 'a', pixelP: 1, pixelQ: 1, anamorphic: false, audioOnly: false, videoScanType: 'progressive', duration: 3000 } });
        const player = new ProgramPlayer(context(real));
        const out = new PassThrough();
        const chunks = [];
        out.on('data', (c) => chunks.push(c));
        const quiet = console.log;
        console.log = () => {};
        let emitter;
        try {
            emitter = await player.play(out);
            await new Promise( (resolve) => {
                const done = setTimeout(resolve, 15000);
                emitter.on('end', () => { clearTimeout(done); resolve(); });
                emitter.on('close', () => { clearTimeout(done); resolve(); });
            } );
        } finally {
            console.log = quiet;
            player.cleanUp();
        }
        const played = Buffer.concat(chunks);
        const file = path.join(dir, 'played.ts');
        fs.writeFileSync(file, played);
        const probe = childProcess.spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
        const info = JSON.parse(probe.stdout || '{}');
        const v = (info.streams || []).find( (s) => s.width > 0 );
        suite.check('played through the channel\'s ffmpeg, the card comes out as the channel streams: MPEG-2 at 1920x1080',
            (v != null) && (v.codec_name === 'mpeg2video') && (v.width === 1920) && (v.height === 1080), probe.stdout);
        suite.check('... the whole card, about 3 seconds', Math.abs(parseFloat((info.format || {}).duration) - 3) < 0.5, JSON.stringify(info.format));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return suite;
}

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
