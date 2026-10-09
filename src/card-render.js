/*
 * The ffmpeg command that renders one generated card (docs/blocks-spec.md,
 * Stage 5, "Generated cards"). Pure: it returns the arguments and the small text
 * files they read, and the card service writes the files and runs ffmpeg.
 *
 * Two kinds of card, the same length and the same ending:
 *
 *   footage   a stretch of the movie itself, its own picture and sound, with
 *             "NEXT TIME ON / CARTOON THEATRE" over it for the first seconds,
 *             then the title (Plex's logo for the movie, or the title as text)
 *             and the airtime line; then the ending clip. What the real clips
 *             do: there is no music track they share.
 *   poster    for a movie whose file cannot be read: the movie's art pushing in
 *             slowly, blurred and darkened, its poster in a gold frame, the same
 *             words in a column beside it, and the template's music bed if it
 *             has one; then the ending clip.
 *
 * Text never goes into the graph itself: a title like "Scooby-Doo 2: Monsters
 * Unleashed" or "Wakko's Wish" would need escaping at two levels, so each line
 * is written to a file drawtext reads, with expansion off so a "%" is a "%".
 *
 * The output is the channel's own format (card-templates.cardFormat): the same
 * size, frame rate, codecs and bitrates as everything else it streams, as an
 * MPEG transport stream, at the template's loudness.
 */
const path = require('path');

function escapeFilterPath(p) {
    const text = String(p).replace(/\\/g, '/');
    if (text.indexOf("'") !== -1) {
        throw new Error(`card-render: a path with a quote in it cannot be passed to ffmpeg's filters: ${text}`);
    }
    return text.replace(/:/g, '\\:');
}

function fontPath(fontDir, name) {
    return (path.isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name)) ? name : path.join(fontDir, name);
}

function ffColor(color, alpha) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(color || '').trim());
    const hex = (m === null) ? 'FFFFFF' : m[1].toUpperCase();
    return `0x${hex}` + ( (typeof(alpha) === 'number') ? `@${alpha}` : '' );
}

function fpsNumber(fps) {
    const [a, b] = String(fps).split('/').map(Number);
    return (b > 0) ? a / b : a;
}

const r2 = (x) => Math.round(x * 100) / 100;
const even = (x) => 2 * Math.round(x / 2);

/*
 * Everything one card needs; see the module comment.
 *   sources   { movie, movieHasAudio, momentS, logo, poster, art, ending,
 *               endingHasAudio, music, musicHasAudio } - paths or null
 * Returns { args, files }: files is { name: text } to write into workDir first.
 */
function renderJob({ mode, template, format, title, whenText, sources, fontDir, workDir, output }) {
    const t = template;
    const W = format.width;
    const H = format.height;
    const FPS = format.fps;
    const SR = format.audioSampleRate;
    const CL = (format.audioChannels === 1) ? 'mono' : 'stereo';
    const F = t.footageSeconds;
    const hasEnding = (sources.ending != null) && (t.ending.file !== '') && (t.ending.lengthS > 0);
    const E = hasEnding ? t.ending.lengthS : 0;
    const useMusic = (sources.music != null) && (sources.musicHasAudio === true) && (t.music.lengthS > 0);
    const footage = (mode === 'footage') && (sources.movie != null);
    const useLogo = (sources.logo != null) && (t.useClearLogo === true);
    const wide = (W / H) >= 1.5;
    const usePoster = ! footage && wide && (sources.poster != null);
    const background = ! footage ? ( ( (t.fallback.background === 'poster') ? sources.poster : sources.art ) || sources.art || sources.poster ) : null;

    const files = {};
    const fileArg = (name, text) => {
        files[name] = text;
        return escapeFilterPath(path.join(workDir, name));
    };
    const font = (name) => escapeFilterPath(fontPath(fontDir, name));
    const shadow = Math.max(1, Math.round(H / 360));
    const drawtext = ({ file, text, fontName, size, color, x, y, alpha, border }) => [
        'drawtext=expansion=none',
        `fontfile='${font(fontName)}'`,
        `textfile='${fileArg(file, text)}'`,
        `fontsize=${Math.max(8, Math.round(size))}`,
        `fontcolor=${color}`,
        `x=${x}`, `y=${Math.round(y)}`,
        `shadowcolor=black@0.8`, `shadowx=${shadow}`, `shadowy=${shadow}`,
    ].concat(border ? [`borderw=${border.width}`, `bordercolor=${border.color}`] : [])
        .concat(alpha ? [`alpha='${alpha}'`] : []).join(':');
    // a size that keeps a line inside `maxWidth`, assuming a glyph is about `aspect` of the size wide
    const fit = (text, size, maxWidth, aspect) => Math.min(size, maxWidth / (aspect * Math.max(1, text.length)));

    // ---- inputs ------------------------------------------------------------------------------
    const args = ['-hide_banner', '-nostats', '-y'];
    let next = 0;
    const input = (list) => {
        args.push(...list);
        return next++;
    };
    // A still image is read once, and scaled once before it is held (`hold`), never per frame.
    const still = (file) => input(['-i', file]);
    const frames = Math.max(1, Math.round(F * fpsNumber(FPS)));
    const hold = `loop=loop=${frames - 1}:size=1:start=0,setpts=N/(${FPS})/TB`;
    let iMain;
    let iPoster = null;
    if (footage) {
        iMain = input(['-ss', String(sources.momentS), '-t', String(F), '-i', sources.movie]);
    } else {
        iMain = still(background);
        if (usePoster) {
            iPoster = still(sources.poster);
        }
    }
    const iLogo = useLogo ? still(sources.logo) : null;
    const iEnding = hasEnding ? input(['-ss', String(t.ending.startS), '-t', String(E), '-i', sources.ending]) : null;
    const iMusic = useMusic ? input(['-ss', String(t.music.startS), '-t', String(t.music.lengthS), '-i', sources.music]) : null;

    // ---- picture -------------------------------------------------------------------------------
    const chains = [];
    const fitFrame = `setpts=PTS-STARTPTS,scale='trunc(iw*sar/2)*2':ih,setsar=1,scale=${W}:${H}:force_original_aspect_ratio=decrease,`
        + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`;
    const HS = (t.headingSeconds >= 0.8) ? Math.min(t.headingSeconds, F - 0.5) : 0;
    const headingAlpha = `if(lt(t,0.2),0,if(lt(t,0.6),(t-0.2)/0.4,if(lt(t,${r2(HS - 0.4)}),1,if(lt(t,${r2(HS)}),(${r2(HS)}-t)/0.4,0))))`;
    const titleAlpha = (HS > 0) ? `if(lt(t,${r2(HS)}),0,if(lt(t,${r2(HS + 0.4)}),(t-${r2(HS)})/0.4,1))` : null;
    const gold = ffColor(t.gold);
    const outline = { width: Math.max(1, Math.round(H / 270)), color: ffColor(t.outline) };
    const white = ffColor(t.textColor);
    const filters = [];
    let cx;
    let colWidth;
    let at;
    if (footage) {
        cx = '(w-text_w)/2';
        colWidth = 0.92 * W;
        at = { top: t.headingY * H - 0.075 * H, main: t.headingY * H, title: t.titleY * H, when: t.whenY * H, rule: null };
        filters.push(`[${iMain}:v]${fitFrame},tpad=stop_mode=clone:stop_duration=${F},trim=duration=${F}`);
        if (HS > 0) {
            filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@0.35:t=fill:enable='lt(t,${r2(HS)})'`);
        }
        filters.push(`drawbox=x=0:y=ih*0.56:w=iw:h=ih*0.44:color=black@0.4:t=fill:enable='gte(t,${r2(HS)})'`);
    } else {
        const centre = wide ? 0.677 * W : W / 2;
        cx = `${Math.round(centre)}-text_w/2`;
        colWidth = wide ? 0.52 * W : 0.9 * W;
        at = { top: 0.157 * H, main: 0.227 * H, title: wide ? 0.46 * H : 0.47 * H, when: 0.74 * H, rule: 0.375 * H, centre: centre };
        filters.push(`[${iMain}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,`
            + `zoompan=z='1+0.06*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`);
        if (t.fallback.blur > 0) {
            filters.push(`boxblur=${Math.round(t.fallback.blur * H / 1080)}:1`);
        }
        // darkened by brightness alone: a black box over it would drain the colour too
        filters.push('format=yuv420p', `lutyuv=y='val*${r2(1 - t.fallback.darken)}'`, 'vignette=PI/4');
        filters.push(`drawbox=x=${Math.round(centre - colWidth / 2)}:y=${Math.round(at.rule)}:w=${Math.round(colWidth)}:h=${Math.max(2, Math.round(H / 180))}:color=0xB3121F:t=fill`);
    }
    const headingOn = footage ? (HS > 0) : true;
    if (headingOn) {
        filters.push(drawtext( { file: 'heading-top.txt', text: t.headingTop, fontName: t.textFont,
            size: fit(t.headingTop, 0.056 * H, colWidth, 0.62), color: white, x: cx, y: at.top, alpha: footage ? headingAlpha : null } ));
        filters.push(drawtext( { file: 'heading-main.txt', text: t.headingMain, fontName: t.headingFont,
            size: fit(t.headingMain, 0.096 * H, colWidth, 0.72), color: gold, x: cx, y: at.main,
            alpha: footage ? headingAlpha : null, border: outline } ));
    }
    if (! useLogo) {
        filters.push(drawtext( { file: 'title.txt', text: title, fontName: t.textFont,
            size: fit(title, 0.085 * H, colWidth, 0.55), color: white, x: cx, y: at.title,
            alpha: footage ? titleAlpha : null, border: { width: Math.max(1, Math.round(H / 360)), color: '0x000000' } } ));
    }
    filters.push(drawtext( { file: 'when.txt', text: whenText, fontName: t.textFont,
        size: fit(whenText, 0.059 * H, colWidth, 0.6), color: white, x: cx, y: at.when, alpha: footage ? titleAlpha : null } ));
    let picture = 'base';
    chains.push(filters.join(',') + `[${picture}]`);

    if (iPoster !== null) {
        const border = Math.max(2, Math.round(H / 135));
        const ph = even(0.72 * H);
        chains.push(`[${iPoster}:v]scale=-2:${ph},setsar=1,pad=iw+${2 * border}:ih+${2 * border}:${border}:${border}:color=${gold},${hold}[poster]`);
        chains.push(`[${picture}][poster]overlay=x=${Math.round(0.078 * W)}:y=(H-h)/2:shortest=1[withposter]`);
        picture = 'withposter';
    }
    if (iLogo !== null) {
        const lw = even(wide || footage ? 0.55 * W : 0.8 * W);
        const lw2 = footage ? lw : even(Math.min(lw, colWidth));
        const lh = even(0.18 * H);
        const fade = footage && (HS > 0) ? `,fade=t=in:st=${r2(HS)}:d=0.4:alpha=1` : '';
        chains.push(`[${iLogo}:v]format=rgba,scale=w=${lw2}:h=${lh}:force_original_aspect_ratio=decrease,${hold}${fade}[logo]`);
        const x = footage ? '(W-w)/2' : `${Math.round(at.centre)}-w/2`;
        chains.push(`[${picture}][logo]overlay=x=${x}:y=${Math.round(at.title)}:shortest=1[withlogo]`);
        picture = 'withlogo';
    }
    chains.push(`[${picture}]fade=t=in:st=0:d=${footage ? 0.3 : 0.4},fade=t=out:st=${r2(F - 0.3)}:d=0.3[v0]`);

    // ---- sound ------------------------------------------------------------------------------
    const fmt = `aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=${CL}`;
    const silence = (seconds, label) => `anullsrc=r=${SR}:cl=${CL},atrim=duration=${seconds}[${label}]`;
    const bed = (volume, label) => `[${iMusic}:a]asetpts=PTS-STARTPTS,${fmt},aloop=loop=-1:size=${Math.round(t.music.lengthS * SR)},`
        + `atrim=duration=${F},volume=${volume},afade=t=in:st=0:d=0.3,afade=t=out:st=${r2(F - 0.6)}:d=0.6[${label}]`;
    const loudness = `loudnorm=I=${t.loudness}:TP=-1.5:LRA=11,aresample=${SR}`;
    // Each section with sound is brought to the template's loudness on its own, so a
    // silent poster card does not push its ending up (silence is left as silence).
    let firstHasSound = true;
    if (footage && (sources.movieHasAudio === true)) {
        chains.push(`[${iMain}:a]asetpts=PTS-STARTPTS,${fmt},afade=t=in:st=0:d=0.3,afade=t=out:st=${r2(F - 0.4)}:d=0.4,`
            + `apad=whole_dur=${F},atrim=duration=${F}[movieaudio]`);
    } else if (! footage && useMusic) {
        chains.push(bed(t.music.volume, 'movieaudio'));
    } else {
        chains.push(silence(F, 'movieaudio'));
        firstHasSound = false;
    }
    if (footage && useMusic && (t.music.underFootage > 0)) {
        chains.push(bed(t.music.underFootage, 'under'));
        chains.push(`[movieaudio][under]amix=inputs=2:duration=first:normalize=0,${loudness}[a0]`);
    } else {
        chains.push(`[movieaudio]${firstHasSound ? loudness : 'anull'}[a0]`);
    }

    // ---- the ending, and the whole -----------------------------------------------------------
    if (hasEnding) {
        chains.push(`[${iEnding}:v]${fitFrame},fade=t=in:st=0:d=0.2,tpad=stop_mode=clone:stop_duration=${E},trim=duration=${E}[v1]`);
        chains.push( (sources.endingHasAudio === true)
            ? `[${iEnding}:a]asetpts=PTS-STARTPTS,${fmt},${loudness},apad=whole_dur=${E},atrim=duration=${E}[a1]`
            : silence(E, 'a1') );
        chains.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
    } else {
        chains.push('[v0]null[v]');
        chains.push('[a0]anull[a]');
    }

    args.push('-filter_complex', chains.join(';'), '-map', '[v]', '-map', '[a]');
    args.push('-c:v', format.videoEncoder, '-b:v', `${format.videoBitrate}k`, '-maxrate', `${format.videoBitrate}k`,
        '-bufsize', `${format.videoBufSize}k`, '-r', FPS, '-pix_fmt', 'yuv420p');
    if (format.videoEncoder === 'libx264') {
        args.push('-preset', 'medium');
    }
    args.push('-c:a', format.audioEncoder, '-b:a', `${format.audioBitrate}k`, '-ar', String(SR), '-ac', String(format.audioChannels),
        '-f', 'mpegts', output);
    return { args, files };
}

module.exports = {
    renderJob,
    fontPath,
    escapeFilterPath,
};
