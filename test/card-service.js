/*
 * Generated cards: the service that renders next week's cards ahead of time and
 * hands a ready one to a break's plan (src/services/card-service.js), and the
 * file templates and chosen moments are kept in (src/dao/card-template-db.js).
 *
 * ffmpeg, ffprobe and Plex are stand-ins here: the runner answers each command
 * the way the real tools do and records it, and "rendering" writes a file. The
 * real renders are test/card-render.js's.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, HOUR, at, flex, mix, Suite } = require('./support');
const CardTemplateDB = require('../src/dao/card-template-db');
const CardService = require('../src/services/card-service');

const MON = at('2026-10-05T10:00:00');
const WEEK = 7 * 24 * HOUR;

function movie(title, mins, file) {
    return { title, key: `/m/${title}`, ratingKey: String(title.length), type: 'movie', duration: mins * MIN,
        serverKey: 'srv', file: file, plexFile: `/library/parts/${title.length}/file.mp4` };
}
function episode(show, n, mins) {
    return { title: `${show} ${n}`, key: `/e/${show}${n}`, type: 'episode', showTitle: show,
        season: 1, episode: n, duration: mins * MIN, serverKey: 'srv' };
}

function channelFixture(movieFile) {
    const progs = [movie('Alpha', 60, movieFile), flex(5), episode('Beta', 1, 30), flex(9985), movie('Gamma', 30, movieFile)];
    return {
        number: 18, name: 'Cards', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
        transcoding: { targetResolution: '', aspect: 'mark' },
        dayParts: [{ id: 'd', name: 'D', fillerCollections: mix([['A', 100]]), starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] }],
        blocks: [{ id: 'ct', name: 'Cartoon Theatre', fillerCollections: mix([['B', 100]]),
            airings: [{ days: [1], start: 10 * HOUR, end: 11 * HOUR }],
            transitions: { leaving: { out: [
                { id: 'nt', kind: 'list', listId: 'NT', match: 'show', keyedOn: 'later' },
                { id: 'card', kind: 'generated', templateId: 'tpl_ct', keyedOn: 'later', onlyIfNoMatch: 'nt' },
            ], in: [] } } }],
        programs: progs, duration: progs.reduce((a, p) => a + p.duration, 0), startTime: new Date(MON).toISOString(),
    };
}

// Answers commands as ffprobe and ffmpeg would; records them; "renders" by writing the output.
function fakeRunner(state) {
    return async (cmd, args) => {
        const joined = args.join(' ');
        state.calls.push( { cmd: path.basename(cmd), args: args } );
        if (joined.includes('packet=pts_time,flags')) {
            state.analyses++;
            let out = '';
            for (let t = 0; t < 5400; t += 5) {
                out += `${t}.000000,K__\n`;
            }
            return { status: 0, stdout: out, stderr: '' };
        }
        if (joined.includes('ebur128')) {
            let out = '';
            for (let i = 0; i < 54000; i++) {
                const t = i / 10;
                out += `frame:${i} pts:${i} pts_time:${t}\nlavfi.r128.M=${ (t >= 3000 && t < 3020) ? -15 : -26 }\n`;
            }
            return { status: 0, stdout: out, stderr: '' };
        }
        if (joined.includes('blackdetect')) {
            return { status: 0, stdout: '', stderr: '' };
        }
        if (joined.includes('-show_streams')) {
            const file = args[args.length - 1];
            if (/\.ts$/.test(file)) {
                return { status: 0, stderr: '', stdout: JSON.stringify( { streams: [
                    { index: 0, codec_type: 'video', codec_name: 'mpeg2video', width: 1920, height: 1080, r_frame_rate: '30000/1001' },
                    { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 } ],
                    format: { duration: '15.070000' } } ) };
            }
            if (! fs.existsSync(file)) {
                return { status: 1, stdout: '', stderr: `${file}: No such file or directory` };
            }
            return { status: 0, stderr: '', stdout: JSON.stringify( { streams: [
                { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
                { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 6 } ], format: { duration: '5400.0' } } ) };
        }
        if (args.includes('-filter_complex')) {
            state.renders.push(args);
            if (state.failRenders) {
                return { status: 1, stdout: '', stderr: 'Error while filtering: something broke' };
            }
            fs.writeFileSync(args[args.length - 1], 'card');
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unexpected command ' + joined };
    };
}

async function setup(options) {
    let folder = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-cards-'));
    if (options.quotedPath === true) {
        // a data folder under a path with a quote in it (a Windows user named
        // O'Brien, say) - escapeFilterPath (card-render.js) refuses such a path
        // rather than risk it breaking out of an ffmpeg filter argument
        folder = path.join(folder, "O'Brien");
        fs.mkdirSync(folder);
    }
    const movieFile = path.join(folder, 'movie.mp4');
    if (options.movieReadable !== false) {
        fs.writeFileSync(movieFile, 'movie');
    }
    const ending = path.join(folder, 'ending.mp4');
    fs.writeFileSync(ending, 'ending');
    const templateDB = new CardTemplateDB(folder);
    await templateDB.load();
    await templateDB.saveTemplate( { id: 'tpl_ct', name: 'Cartoon Theatre Next Time',
        ending: { file: ending, startS: 11.25, lengthS: 3.82 } } );
    const channel = channelFixture(movieFile);
    const state = { calls: [], renders: [], analyses: 0, failRenders: false };
    const clock = { now: MON - HOUR };
    const service = new CardService( {
        folder: folder,
        templateDB: templateDB,
        channelService: { getAllChannels: async () => [channel], on: () => {} },
        fillerService: { getFillersFromCollections: async (ch, ids) => ids.map( (e) => ({ id: e.id, content: [], clipsFeatureShows: false }) ) },
        getFfmpegSettings: () => ({ ffmpegPath: 'C:/ffmpeg/bin/ffmpeg.exe', targetResolution: '1920x1080', videoEncoder: 'mpeg2video',
            audioEncoder: 'aac', videoBitrate: 5000, videoBufSize: 10000, audioBitrate: 192, audioSampleRate: 48, audioChannels: 2, maxFPS: 29.97 }),
        getPlexServer: () => null,
        runner: fakeRunner(state),
        now: () => clock.now,
        log: () => {},
    } );
    await service.init();
    return { folder, service, state, channel, templateDB, clock };
}

const brkWant = (channel) => ({
    templateId: 'tpl_ct', stepId: 'card', keyedOn: 'later', program: channel.programs[4],
    airStart: MON + WEEK, breakStart: MON + HOUR, channelNumber: 18,
});

module.exports = async () => {
    const suite = new Suite('card service');
    const cleanups = [];
    try {
        {
            const s = await setup({});
            cleanups.push(s.folder);
            const want = brkWant(s.channel);
            suite.check('before any scan, no card is ready', s.service.cardFor(want, s.channel) === null);
            const first = await s.service.scan();
            suite.check('a scan finds the one card the week needs and renders it once',
                (first.wanted === 1) && (first.rendered === 1) && (s.state.renders.length === 1), JSON.stringify(first));
            const render = s.state.renders[0];
            suite.check("it renders a stretch of next week's movie, read from the file the lineup names",
                render.includes(s.channel.programs[4].file) && (render[render.indexOf('-ss') + 1] === '3000'), render.slice(0, 12).join(' '));
            suite.check('... in the channel\'s format', (render[render.indexOf('-c:v') + 1] === 'mpeg2video') && (render[render.indexOf('-b:v') + 1] === '5000k'));
            const card = s.service.cardFor(want, s.channel);
            suite.check('the card is then ready for the break, with its file, length and stream details',
                (card !== null) && fs.existsSync(card.file) && (card.durationMs === 15070) && (card.streamStats.videoWidth === 1920)
                && (card.streamStats.videoCodec === 'mpeg2video') && (card.title === 'Next Time: Gamma'), JSON.stringify(card));
            const second = await s.service.scan();
            suite.check('a second scan renders nothing', (second.rendered === 0) && (s.state.renders.length === 1), JSON.stringify(second));
            suite.check('the movie was measured once', s.state.analyses === 1);
            const up = s.service.upcoming();
            suite.check('the page sees the card as ready, with its movie, airtime and moment',
                (up.length === 1) && (up[0].state === 'ready') && (up[0].title === 'Gamma') && (up[0].when === 'NEXT MONDAY · 10AM')
                && (up[0].momentS === 3000) && (up[0].momentSource === 'auto'), JSON.stringify(up));

            await s.service.setMoment(up[0].movieKey, 1234.5);
            suite.check('choosing a moment by hand makes the old card no longer the right one', s.service.cardFor(want, s.channel) === null);
            await s.service.scan();
            const again = s.state.renders[1];
            suite.check('... and the next scan renders it again from that moment',
                (s.state.renders.length === 2) && (again[again.indexOf('-ss') + 1] === '1234.5'));
            suite.check('the chosen moment is kept in card-templates.json',
                JSON.parse(fs.readFileSync(path.join(s.folder, 'card-templates.json'), 'utf8')).moments[up[0].movieKey].startS === 1234.5);

            const reloaded = new CardService( Object.assign( {}, s.service.options, { runner: fakeRunner(s.state) } ) );
            await reloaded.init();
            suite.check('after a restart, cards already rendered are ready again without rendering', reloaded.cardFor(want, s.channel) !== null);

            // a card copied to a different folder (a preview server on a copy of the data
            // folder, a restored backup) must be read from where it actually is, never from
            // the path its sidecar was written with
            const copyFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-cards-copy-'));
            cleanups.push(copyFolder);
            fs.cpSync(s.folder, copyFolder, { recursive: true });
            const copied = new CardService( Object.assign( {}, s.service.options, { folder: copyFolder, runner: fakeRunner(s.state) } ) );
            await copied.init();
            const copiedCard = copied.cardFor(want, s.channel);
            suite.check("a card read from a copied data folder is served from the copy, not the sidecar's own recorded path",
                (copiedCard !== null) && copiedCard.file.startsWith(copyFolder) && fs.existsSync(copiedCard.file), JSON.stringify(copiedCard));

            // a card whose file was removed (by hand, by another copy's prune, by anything
            // outside the service) is not "ready": it is re-rendered, not served as a lie
            const beforeGone = s.state.renders.length;
            const missingMeta = s.service.ready.get(s.service.describe(want, s.channel).key);
            fs.rmSync(path.join(s.folder, 'generated', 'cards', missingMeta.key + '.ts'));
            suite.check('cardFor already treats a missing file as not ready', s.service.cardFor(want, s.channel) === null);
            await s.service.scan();
            suite.check('... and a scan renders it again rather than leaving it "ready" with nothing on disk',
                s.state.renders.length === beforeGone + 1);
            suite.check('... it is ready again afterwards', s.service.cardFor(want, s.channel) !== null);

            s.clock.now = MON + 13 * 24 * HOUR;
            await s.service.prune();
            const kept = fs.readdirSync(path.join(s.folder, 'generated', 'cards')).filter( (f) => /\.ts$/.test(f) );
            suite.check('cards wanted in the last two weeks are kept', kept.length === 2, kept.join(', '));
            s.clock.now = MON + 30 * 24 * HOUR;
            await s.service.prune();
            const left = fs.readdirSync(path.join(s.folder, 'generated', 'cards'));
            suite.check('cards no break has wanted for two weeks are deleted, with their details', left.length === 0, left.join(', '));
            await s.templateDB.setMoment(up[0].movieKey, null);
            suite.check('... and are no longer ready', s.service.cardFor(want, s.channel) === null);
        }
        {
            const s = await setup({ movieReadable: false });
            cleanups.push(s.folder);
            await s.service.scan();
            const render = s.state.renders[0] || [];
            suite.check("a movie whose file cannot be read gets the poster card, which never reads it",
                (s.state.renders.length === 1) && render.join(' ').includes('zoompan') && ! render.includes(s.channel.programs[4].file));
            suite.check('... and it is still ready for the break', s.service.cardFor(brkWant(s.channel), s.channel) !== null);
        }
        {
            const s = await setup({});
            cleanups.push(s.folder);
            s.state.failRenders = true;
            let threw = false;
            let summary = null;
            try {
                summary = await s.service.scan();
            } catch (err) {
                threw = true;
            }
            suite.check('a render that fails does not throw, and is counted', ! threw && (summary.failed === 1));
            const up = s.service.upcoming();
            suite.check('... the page shows it failed, with the reason', (up[0].state === 'failed') && /something broke/.test(up[0].error), JSON.stringify(up));
            suite.check('... nothing half-written is left as a card', fs.readdirSync(path.join(s.folder, 'generated', 'cards')).length === 0);
            s.state.failRenders = false;
            await s.service.scan();
            suite.check('... and the next scan tries again', (s.state.renders.length === 2) && (s.service.cardFor(brkWant(s.channel), s.channel) !== null));
        }
        {
            const s = await setup({});
            cleanups.push(s.folder);
            await s.service.scan();
            await s.templateDB.deleteTemplate('tpl_ct');
            suite.check('a deleted template has no card', s.service.cardFor(brkWant(s.channel), s.channel) === null);
        }
        {
            // the quote in the path makes card-render.js's escapeFilterPath throw before
            // any file is written or ffmpeg runs, inside runRender - the render still
            // fails cleanly (not a crash) and leaves nothing behind in generated/work/
            const s = await setup({ quotedPath: true });
            cleanups.push(path.dirname(s.folder));
            const summary = await s.service.scan();
            suite.check('a path with a quote in it fails the render cleanly, not a crash', summary.failed === 1, JSON.stringify(summary));
            const up = s.service.upcoming();
            suite.check('... reported on the page', (up[0].state === 'failed') && /quote/.test(up[0].error), JSON.stringify(up));
            const workDir = path.join(s.folder, 'generated', 'work');
            suite.check('... and nothing is left behind in generated/work/', fs.readdirSync(workDir).length === 0, fs.readdirSync(workDir).join(', '));
        }
        {
            const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-cards-'));
            cleanups.push(folder);
            fs.writeFileSync(path.join(folder, 'card-templates.json'), '{ not json');
            const db = new CardTemplateDB(folder);
            const lines = [];
            const real = console.error;
            console.error = (...a) => lines.push(a.join(' '));
            let data;
            try {
                data = await db.load();
            } finally {
                console.error = real;
            }
            suite.check('a card-templates.json that cannot be read is no templates, logged, and left as it was',
                (data.templates.length === 0) && (lines.length === 1)
                && (fs.readFileSync(path.join(folder, 'card-templates.json'), 'utf8') === '{ not json'));
            let refused = false;
            try {
                await db.saveTemplate({ name: 'x' });
            } catch (err) {
                refused = true;
            }
            suite.check('... and saving over it is refused rather than losing what is in it', refused);
        }
    } finally {
        for (const f of cleanups) {
            fs.rmSync(f, { recursive: true, force: true });
        }
    }
    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
