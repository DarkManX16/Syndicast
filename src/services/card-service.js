const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const request = require('request');
const Plex = require('../plex');
const transitions = require('../transitions');
const cards = require('../card-templates');
const cardMoment = require('../card-moment');
const cardRender = require('../card-render');

/*
 * Generated cards, rendered ahead of time (docs/blocks-spec.md, Stage 5,
 * "Generated cards").
 *
 * A break's plan never waits for a card: buildPlan asks `cardFor`, which only
 * looks at what is already on disk. Everything slow happens here, in the
 * background, a week ahead:
 *
 *   scan     every channel with a card step: build the plan of every break in
 *            the next week with the same buildPlan the stream uses, learning
 *            from env.card exactly which cards would play (a real clip that
 *            wins means no card is wanted), then render the ones not on disk.
 *            Runs a minute after start, every half hour, and soon after a
 *            channel is saved.
 *   render   one at a time, at low priority: the movie's file (or, failing
 *            that, the file through Plex), measured once for a lively moment
 *            unless one was chosen by hand; Plex's poster, art and logo for the
 *            movie; then card-render.js's command. Written beside the final
 *            name and renamed, so a card on disk is always whole.
 *   prune    cards no break has wanted for two weeks are deleted.
 *
 * Under <data>/generated/: cards/<key>.ts with <key>.json beside it (what it
 * is, its length and stream details), images/, work/, previews/, and
 * moments.json (each movie's measured moment, per section length).
 */

const LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_UNWANTED_MS = 14 * 24 * 60 * 60 * 1000;
const FIRST_SCAN_MS = 60 * 1000;
const SCAN_EVERY_MS = 30 * 60 * 1000;
const AFTER_SAVE_MS = 10 * 1000;
const PREVIEWS_KEPT = 12;

function defaultRunner(cmd, args) {
    return new Promise( (resolve) => {
        let child;
        try {
            child = childProcess.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
            resolve( { status: 1, stdout: '', stderr: String(err.message) } );
            return;
        }
        try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch (err) {
            // not fatal: the render just runs at normal priority
        }
        const out = [];
        const errs = [];
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => errs.push(d));
        child.on('error', (err) => resolve( { status: 1, stdout: '', stderr: String(err.message) } ));
        child.on('close', (code) => resolve( { status: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8') } ));
    } );
}

function ffprobeOf(ffmpegPath) {
    return String(ffmpegPath || 'ffmpeg').replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || ''));
}

function fontDir() {
    return (process.platform === 'win32') ? path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts') : '/usr/share/fonts';
}

function cardSteps(channel) {
    for (const list of [channel.dayParts, channel.blocks]) {
        for (const context of (Array.isArray(list) ? list : [])) {
            const all = transitions.normalizeTransitions(context);
            for (const name of transitions.SITUATIONS) {
                if (all[name].out.concat(all[name].in).some( (s) => s.kind === 'generated' )) {
                    return true;
                }
            }
        }
    }
    return false;
}

function lastLines(text, n) {
    return String(text || '').trim().split(/\r?\n/).slice(-n).join(' | ');
}

class CardService {

    /*
     * options: { folder, templateDB, channelService, fillerService,
     *            getFfmpegSettings(), getPlexServer(name), runner?, now?, log? }
     */
    constructor(options) {
        this.options = options;
        this.folder = path.join(options.folder, 'generated');
        this.dirs = {
            cards: path.join(this.folder, 'cards'),
            images: path.join(this.folder, 'images'),
            work: path.join(this.folder, 'work'),
            previews: path.join(this.folder, 'previews'),
        };
        this.templateDB = options.templateDB;
        this.run = options.runner || defaultRunner;
        this.now = options.now || (() => Date.now());
        this.log = options.log || ( (line) => console.log(line) );
        this.ready = new Map();         // key -> sidecar
        this.failures = new Map();      // key -> { error, at }
        this.rendering = null;          // key being rendered
        this.lastWants = [];            // from the last scan, for the page
        this.analysis = {};             // moments.json
        this.scanning = null;
        this.timers = [];
    }

    async init() {
        for (const dir of Object.values(this.dirs)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }
        if (this.templateDB.templates().length === 0) {
            await this.templateDB.load();
        }
        try {
            this.analysis = JSON.parse(await fs.promises.readFile(path.join(this.folder, 'moments.json'), 'utf8'));
        } catch (err) {
            this.analysis = {};
        }
        this.ready = new Map();
        for (const name of await fs.promises.readdir(this.dirs.cards)) {
            if (! name.endsWith('.json')) {
                continue;
            }
            try {
                const meta = JSON.parse(await fs.promises.readFile(path.join(this.dirs.cards, name), 'utf8'));
                if (fs.existsSync(meta.file)) {
                    this.ready.set(meta.key, meta);
                }
            } catch (err) {
                this.log(`Cards: skipping unreadable ${name}: ${err.message}`);
            }
        }
    }

    start() {
        const scan = () => this.scan().catch( (err) => this.log(`Cards: scan failed: ${err.stack || err}`) );
        this.timers.push(setTimeout(scan, FIRST_SCAN_MS));
        this.timers.push(setInterval(scan, SCAN_EVERY_MS));
        let pending = null;
        if (typeof(this.options.channelService.on) === 'function') {
            this.options.channelService.on('channel-update', () => {
                clearTimeout(pending);
                pending = setTimeout(scan, AFTER_SAVE_MS);
            } );
        }
    }

    stop() {
        for (const t of this.timers) {
            clearTimeout(t);
            clearInterval(t);
        }
        this.timers = [];
    }

    // ---- what a want is ---------------------------------------------------------------------

    describe(want, channel) {
        const template = this.templateDB.template(want.templateId);
        if (template === null) {
            return null;
        }
        const t = cards.normalizeTemplate(template);
        const format = cards.cardFormat(this.options.getFfmpegSettings() || {}, channel);
        const when = cards.whenText(want.breakStart, want.airStart);
        const movieKey = cards.movieKey(want.program);
        const chosen = this.templateDB.moment(movieKey);
        const key = cards.cardKey( { template: t, format: format, program: want.program, whenText: when, moment: chosen } );
        return { key, template: t, format, when, movieKey, chosen, title: want.program.title || '' };
    }

    // The card for this want if it is on disk, else null. Synchronous, for buildPlan's env.card.
    cardFor(want, channel) {
        const d = this.describe(want, channel);
        if (d === null) {
            return null;
        }
        const meta = this.ready.get(d.key);
        if ( (meta == null) || ! fs.existsSync(meta.file) ) {
            return null;
        }
        return { file: meta.file, key: meta.key, title: meta.title, durationMs: meta.durationMs, streamStats: meta.streamStats };
    }

    // ---- scanning ------------------------------------------------------------------------------

    scan() {
        if (this.scanning === null) {
            this.scanning = this.scanOnce().finally( () => {
                this.scanning = null;
            } );
        }
        return this.scanning;
    }

    async scanOnce() {
        const now = this.now();
        const wants = new Map();
        for (const channel of await this.options.channelService.getAllChannels()) {
            if ( (channel == null) || ! cardSteps(channel) || ! Array.isArray(channel.programs) || (channel.programs.length === 0) ) {
                continue;
            }
            const ids = transitions.stepListIds(channel);
            const loaded = await this.options.fillerService.getFillersFromCollections(channel, ids.map( (id) => ({ id: id }) ));
            const lists = {};
            const featuring = {};
            for (const l of loaded) {
                lists[l.id] = l.content;
                featuring[l.id] = (l.clipsFeatureShows === true);
            }
            const env = {
                getList: (id) => (Array.isArray(lists[id]) ? lists[id] : null),
                featuresShows: (id) => featuring[id] === true,
                card: (want) => {
                    const d = this.describe(want, channel);
                    if ( (d !== null) && ! wants.has(d.key) ) {
                        wants.set(d.key, Object.assign( { want: want, channel: channel }, d ));
                    }
                    return null;
                },
            };
            for (const brk of transitions.breaksBetween(channel, now, now + LOOKAHEAD_MS)) {
                transitions.buildPlan(channel, brk, env);
            }
        }
        const list = Array.from(wants.values()).sort( (a, b) => a.want.breakStart - b.want.breakStart );
        this.lastWants = list;
        let rendered = 0;
        let failed = 0;
        for (const item of list) {
            const meta = this.ready.get(item.key);
            if (meta != null) {
                meta.lastWanted = now;
                await this.writeMeta(meta);
                continue;
            }
            const ok = await this.render(item);
            if (ok) {
                rendered++;
            } else {
                failed++;
            }
        }
        await this.prune();
        if ( (list.length > 0) || (rendered > 0) || (failed > 0) ) {
            this.log(`Cards: ${list.length} wanted in the next week, ${rendered} rendered, ${failed} failed.`);
        }
        return { wanted: list.length, rendered: rendered, failed: failed };
    }

    async writeMeta(meta) {
        await fs.promises.writeFile(path.join(this.dirs.cards, meta.key + '.json'), JSON.stringify(meta, null, 2), 'utf8');
    }

    async prune() {
        const cutoff = this.now() - KEEP_UNWANTED_MS;
        for (const [key, meta] of Array.from(this.ready.entries())) {
            if ( (meta.lastWanted || meta.renderedAt || 0) < cutoff ) {
                this.ready.delete(key);
                for (const f of [meta.file, path.join(this.dirs.cards, key + '.json')]) {
                    await fs.promises.rm(f, { force: true });
                }
            }
        }
    }

    // ---- rendering -------------------------------------------------------------------------------

    async probe(source) {
        const settings = this.options.getFfmpegSettings() || {};
        const r = await this.run(ffprobeOf(settings.ffmpegPath),
            ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source]);
        if (r.status !== 0) {
            return null;
        }
        try {
            const info = JSON.parse(r.stdout);
            const streams = Array.isArray(info.streams) ? info.streams : [];
            return {
                video: streams.find( (s) => s.codec_type === 'video' ) || null,
                audio: streams.find( (s) => s.codec_type === 'audio' ) || null,
                durationS: parseFloat( (info.format || {}).duration ),
            };
        } catch (err) {
            return null;
        }
    }

    plexServer(program) {
        const server = (program && (program.serverKey != null)) ? this.options.getPlexServer(program.serverKey) : null;
        return (server && server.uri) ? Object.assign({}, server, { uri: server.uri.replace(/\/$/, '') }) : null;
    }

    // Where the movie can be read: its own file, else through Plex, else null.
    async movieSource(program) {
        const candidates = [];
        if ( (typeof(program.file) === 'string') && (program.file !== '') && fs.existsSync(program.file) ) {
            candidates.push(program.file);
        }
        const server = this.plexServer(program);
        if ( (server !== null) && (typeof(program.plexFile) === 'string') && (program.plexFile !== '') ) {
            candidates.push(`${server.uri}${program.plexFile}?X-Plex-Token=${server.accessToken}`);
        }
        for (const source of candidates) {
            const info = await this.probe(source);
            if ( (info !== null) && (info.video !== null) && (info.durationS > 0) ) {
                return { source: source, info: info };
            }
        }
        return null;
    }

    // The movie's measured moment for a section this long, measured once and kept.
    async autoMoment(source, movieKey, lengthS, durationS) {
        const id = `${movieKey}|${lengthS}`;
        if ( (this.analysis[id] != null) && (typeof(this.analysis[id].startS) === 'number') ) {
            return this.analysis[id].startS;
        }
        const settings = this.options.getFfmpegSettings() || {};
        const cmds = cardMoment.analysisCommands(source.source);
        const k = await this.run(ffprobeOf(settings.ffmpegPath), cmds.keyframes);
        const l = await this.run(settings.ffmpegPath, cmds.loudness);
        const picked = cardMoment.pickMoment( {
            durationS: durationS,
            keyframes: (k.status === 0) ? cardMoment.parseKeyframes(k.stdout) : [],
            loudness: (l.status === 0) ? cardMoment.parseLoudness(l.stdout) : [],
        }, lengthS );
        // the best candidate that does not fade to black
        let startS = picked.startS;
        for (const c of picked.candidates) {
            const r = await this.run(settings.ffmpegPath, ['-hide_banner', '-nostats', '-ss', String(c.startS), '-t', String(lengthS),
                '-i', source.source, '-an', '-vf', 'blackdetect=d=0.4:pix_th=0.10', '-f', 'null', '-']);
            if ( (r.status === 0) && ! /black_start/.test(r.stderr) ) {
                startS = c.startS;
                break;
            }
        }
        this.analysis[id] = { startS: startS, candidates: picked.candidates, durationS: durationS, analyzedAt: this.now() };
        await fs.promises.writeFile(path.join(this.folder, 'moments.json'), JSON.stringify(this.analysis, null, 2), 'utf8');
        return startS;
    }

    // Plex's poster, background art and title logo for the movie, cached; null for each it does not have.
    async images(program) {
        const found = { poster: null, art: null, logo: null };
        const server = this.plexServer(program);
        if ( (server === null) || (program.ratingKey == null) ) {
            return found;
        }
        const base = path.join(this.dirs.images, String(cards.movieKey(program)).replace(/[^a-zA-Z0-9]+/g, '_'));
        const existing = (kind) => ['.jpg', '.png'].map( (ext) => base + '-' + kind + ext ).find( (f) => fs.existsSync(f) ) || null;
        for (const kind of Object.keys(found)) {
            found[kind] = existing(kind);
        }
        if ( (found.poster !== null) || (found.art !== null) ) {
            return found;
        }
        let meta;
        try {
            const plex = new Plex( { uri: server.uri, accessToken: server.accessToken } );
            const container = await plex.Get(`/library/metadata/${program.ratingKey}`);
            meta = (container && Array.isArray(container.Metadata)) ? container.Metadata[0] : null;
        } catch (err) {
            this.log(`Cards: could not read Plex's details for "${program.title}": ${err.message}`);
            return found;
        }
        if (meta == null) {
            return found;
        }
        const logo = Array.isArray(meta.Image) ? (meta.Image.find( (i) => i.type === 'clearLogo' ) || {}).url : null;
        const paths = { poster: meta.thumb, art: meta.art, logo: logo };
        for (const kind of Object.keys(paths)) {
            if (typeof(paths[kind]) !== 'string') {
                continue;
            }
            try {
                const body = await new Promise( (resolve, reject) => {
                    request( { url: server.uri + paths[kind], headers: { 'X-Plex-Token': server.accessToken }, encoding: null },
                        (err, res, data) => ( err || (res.statusCode !== 200) ) ? reject(err || new Error(`status ${res.statusCode}`)) : resolve(data) );
                } );
                const png = (body.length > 4) && (body.readUInt32BE(0) === 0x89504E47);
                const file = base + '-' + kind + (png ? '.png' : '.jpg');
                await fs.promises.writeFile(file, body);
                found[kind] = file;
            } catch (err) {
                this.log(`Cards: could not fetch the ${kind} for "${program.title}": ${err.message}`);
            }
        }
        return found;
    }

    // Everything renderJob needs for a card about `program`, from `template`.
    async sourcesFor(program, template, movieKey, chosen) {
        const movie = await this.movieSource(program);
        let momentS = null;
        let momentSource = null;
        if (movie !== null) {
            const length = template.footageSeconds;
            if (typeof(chosen) === 'number') {
                momentS = Math.max(0, Math.min(chosen, movie.info.durationS - length));
                momentSource = 'chosen';
            } else {
                momentS = await this.autoMoment(movie, movieKey, length, movie.info.durationS);
                momentSource = 'auto';
            }
        }
        const pictures = await this.images(program);
        const extra = async (file) => {
            if ( (typeof(file) !== 'string') || (file === '') || ! fs.existsSync(file) ) {
                return { file: null, hasAudio: false };
            }
            const info = await this.probe(file);
            return { file: (info === null) ? null : file, hasAudio: (info !== null) && (info.audio !== null) };
        };
        const ending = await extra(template.ending.file);
        const music = await extra(template.music.file);
        return {
            mode: (movie !== null) ? 'footage' : 'poster',
            momentS: momentS, momentSource: momentSource,
            sources: {
                movie: (movie !== null) ? movie.source : null,
                movieHasAudio: (movie !== null) && (movie.info.audio !== null),
                momentS: momentS,
                logo: pictures.logo, poster: pictures.poster, art: pictures.art,
                ending: ending.file, endingHasAudio: ending.hasAudio,
                music: music.file, musicHasAudio: music.hasAudio,
            },
        };
    }

    async runRender({ template, format, title, when, prepared, workName, output }) {
        const settings = this.options.getFfmpegSettings() || {};
        const work = path.join(this.dirs.work, workName);
        await fs.promises.mkdir(work, { recursive: true });
        const job = cardRender.renderJob( {
            mode: prepared.mode, template: template, format: format, title: title, whenText: when,
            sources: prepared.sources, fontDir: fontDir(), workDir: work, output: output,
        } );
        for (const name of Object.keys(job.files)) {
            await fs.promises.writeFile(path.join(work, name), job.files[name], 'utf8');
        }
        const r = await this.run(settings.ffmpegPath, job.args);
        await fs.promises.rm(work, { recursive: true, force: true });
        return r;
    }

    async render(item) {
        const { key, template, format, when, movieKey, chosen, want } = item;
        this.rendering = key;
        const tmp = path.join(this.dirs.cards, key + '.part.ts');
        const file = path.join(this.dirs.cards, key + '.ts');
        try {
            const prepared = await this.sourcesFor(want.program, template, movieKey, chosen);
            const r = await this.runRender( { template, format, title: want.program.title || '', when, prepared, workName: key, output: tmp } );
            if (r.status !== 0) {
                throw new Error(`ffmpeg failed: ${lastLines(r.stderr, 3)}`);
            }
            const info = await this.probe(tmp);
            if ( (info === null) || (info.video === null) || ! (info.durationS > 0) ) {
                throw new Error('the rendered card could not be read back');
            }
            await fs.promises.rename(tmp, file);
            const [num, den] = String(info.video.r_frame_rate || format.fps).split('/').map(Number);
            const meta = {
                key: key, file: file,
                title: `Next Time: ${want.program.title || ''}`,
                movie: want.program.title || '', movieKey: movieKey, templateId: want.templateId, when: when,
                mode: prepared.mode, momentS: prepared.momentS, momentSource: prepared.momentSource,
                durationMs: Math.round(info.durationS * 1000),
                streamStats: {
                    videoWidth: info.video.width, videoHeight: info.video.height,
                    videoFramerate: (den > 0) ? num / den : num, videoCodec: info.video.codec_name,
                    audioCodec: (info.audio !== null) ? info.audio.codec_name : undefined,
                    audioIndex: 'a', pixelP: 1, pixelQ: 1, anamorphic: false, audioOnly: false,
                    videoScanType: 'progressive', duration: Math.round(info.durationS * 1000),
                },
                renderedAt: this.now(), lastWanted: this.now(),
            };
            await this.writeMeta(meta);
            this.ready.set(key, meta);
            this.failures.delete(key);
            this.log(`Cards: rendered "${meta.title}" (${prepared.mode}, ${when}) as ${path.basename(file)}.`);
            return true;
        } catch (err) {
            await fs.promises.rm(tmp, { force: true });
            this.failures.set(key, { error: err.message, at: this.now() });
            this.log(`Cards: could not render the card for "${want.program.title}": ${err.message}`);
            return false;
        } finally {
            this.rendering = null;
        }
    }

    // ---- for the Cards page ----------------------------------------------------------------------

    upcoming() {
        return this.lastWants.map( (item) => {
            const meta = this.ready.get(item.key);
            const failure = this.failures.get(item.key);
            const analysed = this.analysis[`${item.movieKey}|${item.template.footageSeconds}`];
            const state = (meta != null) ? 'ready' : (this.rendering === item.key) ? 'rendering' : (failure != null) ? 'failed' : 'waiting';
            return {
                key: item.key, state: state, error: (failure != null) ? failure.error : null,
                channel: item.channel.number, channelName: item.channel.name || '',
                templateId: item.want.templateId, title: item.title, movieKey: item.movieKey, when: item.when,
                breakStart: item.want.breakStart, airStart: item.want.airStart,
                mode: (meta != null) ? meta.mode : null,
                momentS: (typeof(item.chosen) === 'number') ? item.chosen
                    : (meta != null) ? meta.momentS : (analysed != null) ? analysed.startS : null,
                momentSource: (typeof(item.chosen) === 'number') ? 'chosen' : 'auto',
            };
        } );
    }

    async setMoment(movieKey, startS) {
        const item = this.lastWants.find( (w) => w.movieKey === movieKey );
        await this.templateDB.setMoment(movieKey, startS, item ? item.title : undefined);
        // the cards keyed on the old moment are no longer what the scan wants
        this.lastWants = this.lastWants.map( (w) => (w.movieKey === movieKey) ? Object.assign({}, w, this.describe(w.want, w.channel)) : w );
    }

    // A card's details and file again, from scratch (the page's "Render again").
    async forget(key) {
        const meta = this.ready.get(key);
        this.ready.delete(key);
        this.failures.delete(key);
        if (meta != null) {
            await fs.promises.rm(meta.file, { force: true });
            await fs.promises.rm(path.join(this.dirs.cards, key + '.json'), { force: true });
        }
    }

    // Every movie on the channels, for previewing a template no step uses yet.
    async movies() {
        const seen = new Map();
        for (const channel of await this.options.channelService.getAllChannels()) {
            for (const p of (channel && Array.isArray(channel.programs)) ? channel.programs : []) {
                if ( (p != null) && (p.type === 'movie') && (p.isOffline !== true) ) {
                    const key = cards.movieKey(p);
                    if (! seen.has(key)) {
                        seen.set(key, { movieKey: key, title: p.title || '', year: p.year || null, program: p, channel: channel });
                    }
                }
            }
        }
        return Array.from(seen.values()).sort( (a, b) => a.title.localeCompare(b.title) );
    }

    /*
     * A small preview of a template (saved or not) for one movie, as a file in
     * previews/: 'clip' a 640x360 H.264 MP4 a browser can play, 'frame' a PNG
     * from just after the title appears. Never touches the cards on air.
     */
    async preview(templateDraft, movieKey, kind, whenOverride) {
        const template = cards.normalizeTemplate(templateDraft);
        const item = this.lastWants.find( (w) => w.movieKey === movieKey );
        const movie = (item != null) ? { program: item.want.program, channel: item.channel }
            : (await this.movies()).find( (m) => m.movieKey === movieKey );
        if (movie == null) {
            throw new Error('That movie is not on any channel.');
        }
        const settings = this.options.getFfmpegSettings() || {};
        const format = Object.assign( cards.cardFormat(settings, movie.channel), {
            width: 640, height: 360, videoEncoder: 'libx264', videoBitrate: 1500, videoBufSize: 3000,
            audioEncoder: 'aac', audioBitrate: 128, audioSampleRate: 48000, audioChannels: 2 } );
        const when = whenOverride || ( (item != null) ? item.when : 'NEXT SATURDAY · 7PM' );
        const prepared = await this.sourcesFor(movie.program, template, movieKey, this.templateDB.moment(movieKey));
        const name = 'preview-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const ts = path.join(this.dirs.previews, name + '.ts');
        const r = await this.runRender( { template, format, title: movie.program.title || '', when, prepared, workName: name, output: ts } );
        if (r.status !== 0) {
            await fs.promises.rm(ts, { force: true });
            throw new Error(`ffmpeg failed: ${lastLines(r.stderr, 3)}`);
        }
        let out;
        if (kind === 'frame') {
            out = path.join(this.dirs.previews, name + '.png');
            const at = Math.min(template.footageSeconds - 0.5, template.headingSeconds + 1.5);
            await this.run(settings.ffmpegPath, ['-v', 'error', '-y', '-ss', String(at), '-i', ts, '-frames:v', '1', out]);
        } else {
            out = path.join(this.dirs.previews, name + '.mp4');
            await this.run(settings.ffmpegPath, ['-v', 'error', '-y', '-i', ts, '-c', 'copy', '-movflags', '+faststart', out]);
        }
        await fs.promises.rm(ts, { force: true });
        await this.prunePreviews();
        if (! fs.existsSync(out)) {
            throw new Error('The preview could not be made.');
        }
        return { file: path.basename(out), mode: prepared.mode, momentS: prepared.momentS, momentSource: prepared.momentSource, when: when };
    }

    previewPath(name) {
        if (! /^preview-[a-z0-9]+\.(mp4|png)$/.test(name)) {
            return null;
        }
        const file = path.join(this.dirs.previews, name);
        return fs.existsSync(file) ? file : null;
    }

    async prunePreviews() {
        const files = (await fs.promises.readdir(this.dirs.previews))
            .map( (f) => ({ f: f, t: fs.statSync(path.join(this.dirs.previews, f)).mtimeMs }) )
            .sort( (a, b) => b.t - a.t );
        for (const old of files.slice(PREVIEWS_KEPT)) {
            await fs.promises.rm(path.join(this.dirs.previews, old.f), { force: true });
        }
    }
}

module.exports = CardService;
