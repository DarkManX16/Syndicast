/*
 * Generated cards: the ffmpeg command that renders one (src/card-render.js).
 * The first half reads the command; the second renders two small real cards
 * from generated test inputs, when ffmpeg is on the PATH (it says so when not).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { Suite } = require('./support');
const cards = require('../src/card-templates');
const render = require('../src/card-render');

const FORMAT = {
    width: 1920, height: 1080, fps: '30000/1001', videoEncoder: 'mpeg2video', videoBitrate: 5000,
    videoBufSize: 10000, audioEncoder: 'aac', audioBitrate: 192, audioSampleRate: 48000, audioChannels: 2,
};
const SOURCES = {
    movie: 'G:/Cartoon Theatre Movies/Scooby-Doo 2.mp4', movieHasAudio: true, momentS: 2661.95,
    logo: null, poster: null, art: null,
    ending: 'G:/CCN/Cartoon Theatre/Boo Brothers.mp4', endingHasAudio: true, music: null, musicHasAudio: false,
};
const TITLE = "Scooby-Doo 2: Monsters' Unleashed, 100%";

function job(overrides) {
    const template = cards.normalizeTemplate( Object.assign( {
        name: 'Cartoon Theatre Next Time',
        ending: { file: 'G:/CCN/Cartoon Theatre/Boo Brothers.mp4', startS: 11.25, lengthS: 3.82 },
    }, overrides.template || {} ) );
    return render.renderJob( Object.assign( {
        mode: 'footage', template: template, format: FORMAT, title: TITLE, whenText: 'NEXT SATURDAY · 7PM',
        sources: SOURCES,
        fontDir: 'C:/Windows/Fonts', workDir: 'C:/data/generated/work/abc', output: 'C:/data/generated/cards/abc.ts.tmp',
    }, overrides, { template: template } ) );
}

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

function findFfmpeg() {
    for (const candidate of [process.env.SYNDICAST_TEST_FFMPEG, 'ffmpeg']) {
        if (! candidate) {
            continue;
        }
        const r = childProcess.spawnSync(candidate, ['-hide_banner', '-version'], { encoding: 'utf8' });
        if (r.status === 0) {
            return candidate;
        }
    }
    return null;
}

function probe(ffmpeg, file) {
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || ''));
    const r = childProcess.spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,sample_rate,channels',
        '-of', 'json', file], { encoding: 'utf8' });
    return JSON.parse(r.stdout);
}

module.exports = async () => {
    const suite = new Suite('card render');

    // ---- the command ------------------------------------------------------------------------
    const footage = job({});
    const graph = argAfter(footage.args, '-filter_complex');
    suite.check('the graph is passed inline, and both outputs are mapped',
        (typeof(graph) === 'string') && footage.args.includes('[v]') && footage.args.includes('[a]'));
    suite.check("the movie is read from the chosen moment for the movie section's length",
        (argAfter(footage.args, '-ss') === '2661.95') && (argAfter(footage.args, '-t') === '11.25'));
    suite.check("the output is the channel's format: MPEG-2 5000k, NTSC rate, 1920x1080, AAC 192k 48kHz stereo, MPEG-TS",
        (argAfter(footage.args, '-c:v') === 'mpeg2video') && (argAfter(footage.args, '-b:v') === '5000k')
        && (argAfter(footage.args, '-bufsize') === '10000k') && (argAfter(footage.args, '-r') === '30000/1001')
        && (argAfter(footage.args, '-c:a') === 'aac') && (argAfter(footage.args, '-b:a') === '192k')
        && (argAfter(footage.args, '-ar') === '48000') && (argAfter(footage.args, '-ac') === '2')
        && (argAfter(footage.args, '-f') === 'mpegts') && graph.includes('1920:1080'));
    suite.check('the title never appears in the graph; it is read from a file',
        ! graph.includes('Scooby') && graph.includes('textfile=') && (Object.values(footage.files).indexOf(TITLE) !== -1));
    suite.check('the airtime line is written to a file as it is', Object.values(footage.files).indexOf('NEXT SATURDAY · 7PM') !== -1);
    suite.check('text is drawn without % expansion', ! /drawtext=(?![^;]*expansion=none)/.test(graph));
    suite.check('the fonts are the template\'s, from the font folder', graph.includes("C\\:/Windows/Fonts/BROADW.TTF") && graph.includes("C\\:/Windows/Fonts/ERASBD.TTF"));
    suite.check('the loudness is brought to the template\'s -18 LUFS', graph.includes('loudnorm=I=-18'));
    suite.check('the movie and the ending are joined', graph.includes('concat=n=2:v=1:a=1'));
    suite.check('the ending is read from its start for its length', footage.args.includes('11.25') && footage.args.includes('3.82'));

    const mute = job({ sources: Object.assign({}, SOURCES, { movieHasAudio: false }) });
    const muteGraph = argAfter(mute.args, '-filter_complex');
    suite.check('a movie with no sound gets silence, never its missing audio stream',
        ! muteGraph.includes('[0:a]') && muteGraph.includes('anullsrc'));

    const noEnding = job({ template: { ending: { file: '', startS: 0, lengthS: 0 } },
        sources: Object.assign({}, SOURCES, { ending: null, endingHasAudio: false }) });
    const noEndingGraph = argAfter(noEnding.args, '-filter_complex');
    suite.check('with no ending file, nothing is joined', ! noEndingGraph.includes('concat='));

    const logo = job({ sources: Object.assign({}, SOURCES, { logo: 'C:/data/generated/images/logo.png' }) });
    const logoGraph = argAfter(logo.args, '-filter_complex');
    suite.check("with Plex's clear logo, the title is the logo, not text",
        logoGraph.includes('overlay=') && (Object.values(logo.files).indexOf(TITLE) === -1));

    const bed = job({ template: { music: { file: 'G:/closing.mp4', startS: 11.5, lengthS: 5.5, volume: 0.6, underFootage: 0.25 } },
        sources: Object.assign({}, SOURCES, { music: 'G:/closing.mp4', musicHasAudio: true }) });
    const bedGraph = argAfter(bed.args, '-filter_complex');
    suite.check('a music bed set to play under the movie is mixed in, looped to length', bedGraph.includes('amix=') && bedGraph.includes('aloop='));
    suite.check('... and without that setting it is not', ! graph.includes('amix='));

    const poster = job({ mode: 'poster', sources: Object.assign({}, SOURCES, {
        movie: null, movieHasAudio: false, poster: 'C:/img/poster.jpg', art: 'C:/img/art.jpg' }) });
    const posterGraph = argAfter(poster.args, '-filter_complex');
    suite.check('the poster card pushes in slowly on the art and shows the poster', posterGraph.includes('zoompan=') && poster.args.includes('C:/img/poster.jpg') && poster.args.includes('C:/img/art.jpg'));
    suite.check('the poster card darkens the art by brightness, keeping its colour', posterGraph.includes('lutyuv=y=') && ! posterGraph.includes('color=black@0.55'));
    suite.check('a silent section is left silent; only sections with sound are levelled',
        /anullsrc[^;]*[movieaudio]/.test(posterGraph) && posterGraph.includes('[movieaudio]anull[a0]') && /[d+:a][^;]*loudnorm[^;]*[a1]/.test(posterGraph));
    suite.check('the poster card never reads the movie', ! poster.args.includes('G:/Cartoon Theatre Movies/Scooby-Doo 2.mp4'));

    // ---- real renders -------------------------------------------------------------------------
    const ffmpeg = findFfmpeg();
    if (ffmpeg === null) {
        suite.log('ffmpeg is not on the PATH (or SYNDICAST_TEST_FFMPEG): the two real renders are skipped.');
        return suite;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-card-'));
    try {
        const run = (args) => childProcess.spawnSync(ffmpeg, args, { encoding: 'utf8' });
        const movie = path.join(dir, 'movie.mp4');
        const ending = path.join(dir, 'ending.mp4');
        const art = path.join(dir, 'art.png');
        run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=40', '-f', 'lavfi', '-i', 'sine=f=440:d=40',
            '-shortest', '-c:v', 'libx264', '-g', '24', '-c:a', 'aac', movie]);
        run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=s=320x240:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=880:d=6',
            '-shortest', '-c:v', 'libx264', '-c:a', 'aac', ending]);
        run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=800x450', '-frames:v', '1', art]);
        const small = Object.assign({}, FORMAT, { width: 480, height: 270, videoBitrate: 1500, videoBufSize: 3000 });
        const fontDir = (process.platform === 'win32') ? 'C:/Windows/Fonts' : '/usr/share/fonts/truetype/dejavu';
        const fonts = (process.platform === 'win32') ? {} : { headingFont: 'DejaVuSans-Bold.ttf', textFont: 'DejaVuSans.ttf' };
        for (const mode of ['footage', 'poster']) {
            const work = path.join(dir, 'work-' + mode);
            fs.mkdirSync(work);
            const out = path.join(dir, `${mode}.ts`);
            const template = cards.normalizeTemplate( Object.assign( { name: 'Test', footageSeconds: 4,
                ending: { file: ending, startS: 2, lengthS: 3 } }, fonts ) );
            const j = render.renderJob( {
                mode: mode, template: template, format: small, title: TITLE, whenText: 'NEXT SATURDAY · 7PM',
                sources: { movie: (mode === 'footage') ? movie : null, movieHasAudio: true, momentS: 12,
                    logo: null, poster: (mode === 'poster') ? art : null, art: (mode === 'poster') ? art : null,
                    ending: ending, endingHasAudio: true, music: null, musicHasAudio: false },
                fontDir: fontDir, workDir: work, output: out,
            } );
            for (const name of Object.keys(j.files)) {
                fs.writeFileSync(path.join(work, name), j.files[name], 'utf8');
            }
            const r = run(j.args);
            const ok = suite.check(`a real ${mode} card renders`, r.status === 0, r.status === 0 ? '' : (r.stderr || '').split('\n').slice(-6).join(' | '));
            if (! ok) {
                continue;
            }
            const info = probe(ffmpeg, out);
            const v = info.streams.find( (s) => s.codec_type === 'video' );
            const a = info.streams.find( (s) => s.codec_type === 'audio' );
            const duration = parseFloat(info.format.duration);
            suite.check(`... ${mode}: 7s long (4s, then the 3s ending)`, Math.abs(duration - 7) < 0.25, String(duration));
            suite.check(`... ${mode}: MPEG-2 at 480x270 with AAC at 48kHz stereo`,
                (v.codec_name === 'mpeg2video') && (v.width === 480) && (v.height === 270)
                && (a.codec_name === 'aac') && (a.sample_rate === '48000') && (a.channels === 2), JSON.stringify(info.streams));
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
