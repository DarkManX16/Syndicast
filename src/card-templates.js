/*
 * Generated cards (docs/blocks-spec.md, Stage 5, "Generated cards"): the
 * template a card is drawn from, the line saying when the show airs, the
 * format a card is rendered in and the key it is cached under.
 *
 * Pure, like transitions.js: no files, no ffmpeg. The card service renders,
 * card-render.js builds the ffmpeg command, and this module decides what a card
 * says and when an old render no longer fits.
 *
 * A card is rendered ahead of time and kept, so everything that changes what
 * it looks or sounds like goes into its key: the template (all but its name),
 * the channel's format, the movie, the airtime line and a moment chosen by
 * hand. Change any of them and the card is rendered again; nothing stale airs.
 */
const crypto = require('crypto');

// Bump when the render itself changes in a way old cards should not survive.
const RENDER_VERSION = 1;

const KINDS = ['next-time'];

const DEFAULT_TEMPLATE = {
    id: '',
    name: '',
    kind: 'next-time',
    // seconds of the movie itself, before the ending
    footageSeconds: 11.25,
    // how long "NEXT TIME ON / CARTOON THEATRE" shows at the start
    headingSeconds: 3,
    headingTop: 'NEXT TIME ON',
    headingMain: 'CARTOON THEATRE',
    headingFont: 'BROADW.TTF',
    textFont: 'ERASBD.TTF',
    gold: '#F2C14E',
    outline: '#7A1010',
    textColor: '#FFFFFF',
    // where things sit, as fractions of the frame's height from the top
    headingY: 0.30,
    titleY: 0.64,
    whenY: 0.84,
    // the movie's title as Plex's own logo for it, when Plex has one
    useClearLogo: true,
    // a stretch of a real clip to close on (the marquee); no file, no ending
    ending: { file: '', startS: 0, lengthS: 0 },
    // an optional music bed: under the poster card, and under the movie at
    // `underFootage` (0 = only under the poster card)
    music: { file: '', startS: 0, lengthS: 0, volume: 0.6, underFootage: 0 },
    // the poster card, for a movie whose file cannot be read
    fallback: { background: 'art', blur: 8, darken: 0.55 },
    loudness: -18,
};

const MIN_FOOTAGE = 3;
const MAX_FOOTAGE = 30;

const num = (value, fallback) => ( (typeof(value) === 'number') && isFinite(value) ) ? value : fallback;
const str = (value, fallback) => (typeof(value) === 'string') ? value : fallback;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/*
 * A template with every field present and in range, as the renderer reads it.
 * The stored object is not changed.
 */
function normalizeTemplate(stored) {
    const t = (stored != null) && (typeof(stored) === 'object') ? stored : {};
    const d = DEFAULT_TEMPLATE;
    const part = (name) => ( (t[name] != null) && (typeof(t[name]) === 'object') ) ? t[name] : {};
    return {
        id: str(t.id, d.id),
        name: str(t.name, d.name),
        kind: str(t.kind, d.kind),
        footageSeconds: clamp(num(t.footageSeconds, d.footageSeconds), MIN_FOOTAGE, MAX_FOOTAGE),
        headingSeconds: clamp(num(t.headingSeconds, d.headingSeconds), 0, MAX_FOOTAGE),
        headingTop: str(t.headingTop, d.headingTop),
        headingMain: str(t.headingMain, d.headingMain),
        headingFont: str(t.headingFont, d.headingFont),
        textFont: str(t.textFont, d.textFont),
        gold: str(t.gold, d.gold),
        outline: str(t.outline, d.outline),
        textColor: str(t.textColor, d.textColor),
        headingY: clamp(num(t.headingY, d.headingY), 0, 1),
        titleY: clamp(num(t.titleY, d.titleY), 0, 1),
        whenY: clamp(num(t.whenY, d.whenY), 0, 1),
        useClearLogo: (typeof(t.useClearLogo) === 'boolean') ? t.useClearLogo : d.useClearLogo,
        ending: {
            file: str(part('ending').file, d.ending.file),
            startS: num(part('ending').startS, d.ending.startS),
            lengthS: num(part('ending').lengthS, d.ending.lengthS),
        },
        music: {
            file: str(part('music').file, d.music.file),
            startS: num(part('music').startS, d.music.startS),
            lengthS: num(part('music').lengthS, d.music.lengthS),
            volume: clamp(num(part('music').volume, d.music.volume), 0, 2),
            underFootage: clamp(num(part('music').underFootage, d.music.underFootage), 0, 2),
        },
        fallback: {
            background: (part('fallback').background === 'poster') ? 'poster' : 'art',
            blur: clamp(num(part('fallback').blur, d.fallback.blur), 0, 40),
            darken: clamp(num(part('fallback').darken, d.fallback.darken), 0, 1),
        },
        loudness: clamp(num(t.loudness, d.loudness), -40, -5),
    };
}

/*
 * What is wrong with a template, one line each, for the page and the save. A
 * missing ending or music file is not wrong: a card can do without either.
 */
function templateProblems(template) {
    const t = normalizeTemplate(template);
    const problems = [];
    if (t.name.trim() === '') {
        problems.push('Give the template a name.');
    }
    if (KINDS.indexOf(t.kind) === -1) {
        problems.push(`"${t.kind}" is not a kind of card this version can make (only ${KINDS.join(', ')}).`);
    }
    for (const [label, part] of [['ending', t.ending], ['music', t.music]]) {
        if ( (part.startS < 0) || (part.lengthS < 0) ) {
            problems.push(`The ${label}'s start and length cannot be negative.`);
        }
    }
    return problems;
}

function hasEnding(template) {
    return (template.ending.file !== '') && (template.ending.lengthS > 0);
}

// How long the card runs: the movie section, then the ending if there is one.
function totalSeconds(template) {
    const t = normalizeTemplate(template);
    const total = t.footageSeconds + (hasEnding(t) ? t.ending.lengthS : 0);
    return Math.round(total * 1000) / 1000;
}

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

function clockText(date) {
    const h = date.getHours();
    const m = date.getMinutes();
    const h12 = (h % 12 === 0) ? 12 : (h % 12);
    return `${h12}${m === 0 ? '' : ':' + String(m).padStart(2, '0')}${h < 12 ? 'AM' : 'PM'}`;
}

function midnight(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/*
 * When the show airs, seen from the break the card plays in, local time:
 * TONIGHT (or TODAY before 5pm) the same day, TOMORROW the next, the weekday
 * within six days, NEXT and the weekday after that. Days are counted on the
 * calendar, so a daylight-saving change in between does not shift them.
 */
function whenText(breakStart, airStart) {
    const b = new Date(breakStart);
    const a = new Date(airStart);
    const days = Math.round( (midnight(a) - midnight(b)) / (24 * 60 * 60 * 1000) );
    let day;
    if (days <= 0) {
        day = (a.getHours() >= 17) ? 'TONIGHT' : 'TODAY';
    } else if (days === 1) {
        day = 'TOMORROW';
    } else if (days < 7) {
        day = WEEKDAYS[a.getDay()];
    } else {
        day = 'NEXT ' + WEEKDAYS[a.getDay()];
    }
    return `${day} · ${clockText(a)}`;
}

function parseResolution(text) {
    const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(text || ''));
    return (m === null) ? null : { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

// The frame rate ffmpeg is given, as a string: NTSC rates as exact fractions.
function fpsText(maxFPS) {
    const fps = num(maxFPS, 29.97);
    if ( (fps <= 0) || (fps > 60.01) ) {
        return '30000/1001';
    }
    for (const [approx, exact] of [[23.976, '24000/1001'], [29.97, '30000/1001'], [59.94, '60000/1001']]) {
        if (Math.abs(fps - approx) < 0.01) {
            return exact;
        }
    }
    return (Math.abs(fps - Math.round(fps)) < 0.001) ? String(Math.round(fps)) : fps.toFixed(3);
}

// A hardware encoder is for live streams; a card is rendered in the background
// with the software encoder of the same codec.
function softwareEncoder(encoder) {
    const e = String(encoder || '').toLowerCase();
    if (! /(nvenc|qsv|vaapi|amf|videotoolbox|_mf$|v4l2m2m)/.test(e) ) {
        return (e === '') ? 'libx264' : encoder;
    }
    if (/(hevc|265)/.test(e)) {
        return 'libx265';
    }
    if (/mpeg2/.test(e)) {
        return 'mpeg2video';
    }
    return 'libx264';
}

/*
 * The format a card for this channel is rendered in: the same resolution, frame
 * rate, codecs and bitrates the channel streams everything else in (the
 * channel's own resolution and bitrates first, as ffmpeg.js reads them), so the
 * card looks and sounds like the rest of the channel and needs no fixing up
 * when it plays.
 */
function cardFormat(ffmpegSettings, channel) {
    const s = ffmpegSettings || {};
    const own = ( (channel != null) && (channel.transcoding != null) ) ? channel.transcoding : {};
    const size = parseResolution(own.targetResolution) || parseResolution(s.targetResolution) || { width: 1920, height: 1080 };
    const positive = (value) => (typeof(value) === 'number') && (value > 0);
    return {
        width: size.width,
        height: size.height,
        fps: fpsText(s.maxFPS),
        videoEncoder: softwareEncoder(s.videoEncoder),
        videoBitrate: positive(own.videoBitrate) ? own.videoBitrate : num(s.videoBitrate, 5000),
        videoBufSize: positive(own.videoBufSize) ? own.videoBufSize : num(s.videoBufSize, 10000),
        audioEncoder: str(s.audioEncoder, 'aac') || 'aac',
        audioBitrate: num(s.audioBitrate, 192),
        audioSampleRate: Math.round(num(s.audioSampleRate, 48) * 1000),
        audioChannels: num(s.audioChannels, 2),
    };
}

// Which movie a card is about, stable across lineup regenerations.
function movieKey(program) {
    if ( (program != null) && (program.ratingKey != null) && (program.serverKey != null) ) {
        return `${program.serverKey}|${program.ratingKey}`;
    }
    const p = program || {};
    return `${p.title || ''}|${p.year || ''}`;
}

function stable(value) {
    if (Array.isArray(value)) {
        return value.map(stable);
    }
    if ( (value != null) && (typeof(value) === 'object') ) {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            out[k] = stable(value[k]);
        }
        return out;
    }
    return value;
}

/*
 * The key a card is cached under. A template's id and name are left out, so
 * renaming one, or two templates that are the same, render nothing new.
 */
function cardKey({ template, format, program, whenText, moment }) {
    const t = Object.assign({}, normalizeTemplate(template));
    delete t.id;
    delete t.name;
    const payload = stable( {
        v: RENDER_VERSION,
        template: t,
        format: format,
        movie: movieKey(program),
        title: (program && program.title) || '',
        when: whenText,
        moment: (typeof(moment) === 'number') ? moment : null,
    } );
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

module.exports = {
    RENDER_VERSION,
    KINDS,
    DEFAULT_TEMPLATE,
    normalizeTemplate,
    templateProblems,
    hasEnding,
    totalSeconds,
    whenText,
    cardFormat,
    movieKey,
    cardKey,
};
