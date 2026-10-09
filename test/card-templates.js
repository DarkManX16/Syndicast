/*
 * Generated cards: the template, the line saying when the show airs, the format a
 * card is rendered in and the key it is cached under (src/card-templates.js). See
 * docs/blocks-spec.md, Stage 5, "Generated cards".
 *
 * Times are in the machine's own zone, like every fixture in this suite.
 */
const { at, Suite } = require('./support');
const cards = require('../src/card-templates');

// Channel 1's real ffmpeg settings, as saved on Oct 8, 2026.
const SETTINGS = {
    targetResolution: '1920x1080', videoEncoder: 'mpeg2video', audioEncoder: 'aac',
    videoBitrate: 5000, videoBufSize: 10000, audioBitrate: 192, audioSampleRate: 48,
    audioChannels: 2, maxFPS: 29.97,
};
const CHANNEL_1 = { number: 1, transcoding: { targetResolution: '', aspect: 'mark' } };

module.exports = async () => {
    const suite = new Suite('card templates');

    // ---- when it airs ----------------------------------------------------------------
    const when = (breakAt, airAt) => cards.whenText(at(breakAt), at(airAt));
    const whenCase = (name, got, want) => suite.check(name, got === want, `got "${got}"`);
    whenCase('a week ahead: NEXT SATURDAY · 7PM (Cartoon Theatre, Oct 10 to Oct 17)',
        when('2026-10-10T20:12:36', '2026-10-17T19:00:00'), 'NEXT SATURDAY · 7PM');
    whenCase('the same evening: TONIGHT', when('2026-10-17T18:00:00', '2026-10-17T19:00:00'), 'TONIGHT · 7PM');
    whenCase('the next day: TOMORROW', when('2026-10-16T20:00:00', '2026-10-17T19:00:00'), 'TOMORROW · 7PM');
    whenCase('later this week: the weekday, minutes shown when not on the hour',
        when('2026-10-14T12:00:00', '2026-10-17T19:30:00'), 'SATURDAY · 7:30PM');
    whenCase('the same day before evening: TODAY', when('2026-10-17T09:00:00', '2026-10-17T10:00:00'), 'TODAY · 10AM');
    whenCase('noon reads 12PM', when('2026-10-17T09:00:00', '2026-10-17T12:00:00'), 'TODAY · 12PM');
    whenCase('just after midnight reads 12:15AM', when('2026-10-16T22:00:00', '2026-10-17T00:15:00'), 'TOMORROW · 12:15AM');

    // ---- the channel's format ------------------------------------------------------------
    const f = cards.cardFormat(SETTINGS, CHANNEL_1);
    suite.check("channel 1's format: 1920x1080, NTSC frame rate, MPEG-2 at 5000k, AAC 192k 48kHz stereo",
        (f.width === 1920) && (f.height === 1080) && (f.fps === '30000/1001') && (f.videoEncoder === 'mpeg2video')
        && (f.videoBitrate === 5000) && (f.videoBufSize === 10000) && (f.audioEncoder === 'aac')
        && (f.audioBitrate === 192) && (f.audioSampleRate === 48000) && (f.audioChannels === 2), JSON.stringify(f));
    const sd = cards.cardFormat(SETTINGS, { transcoding: { targetResolution: '640x480', videoBitrate: 2000 } });
    suite.check("a channel's own resolution and bitrate override the global ones",
        (sd.width === 640) && (sd.height === 480) && (sd.videoBitrate === 2000), JSON.stringify(sd));
    suite.check('a hardware H.264 encoder renders with the software one',
        cards.cardFormat(Object.assign({}, SETTINGS, { videoEncoder: 'h264_nvenc' }), CHANNEL_1).videoEncoder === 'libx264');
    suite.check('a hardware HEVC encoder renders with the software one',
        cards.cardFormat(Object.assign({}, SETTINGS, { videoEncoder: 'hevc_qsv' }), CHANNEL_1).videoEncoder === 'libx265');
    suite.check('a whole frame rate stays whole',
        cards.cardFormat(Object.assign({}, SETTINGS, { maxFPS: 30 }), CHANNEL_1).fps === '30');
    suite.check('a frame rate above 60 (the "no limit" setting) renders at the NTSC rate',
        cards.cardFormat(Object.assign({}, SETTINGS, { maxFPS: 4000 }), CHANNEL_1).fps === '30000/1001');

    // ---- the template --------------------------------------------------------------------
    const t = cards.normalizeTemplate({ id: 'tpl_1', name: 'Cartoon Theatre Next Time' });
    suite.check('defaults fill in: 11.25s of the movie, the heading words, the fonts, -18 LUFS',
        (t.kind === 'next-time') && (t.footageSeconds === 11.25) && (t.headingTop === 'NEXT TIME ON')
        && (t.headingMain === 'CARTOON THEATRE') && (t.headingFont === 'BROADW.TTF') && (t.textFont === 'ERASBD.TTF')
        && (t.loudness === -18) && (t.ending.file === '') && (t.music.file === ''), JSON.stringify(t));
    suite.check('the movie section is kept between 3 and 30 seconds',
        (cards.normalizeTemplate({ footageSeconds: 1 }).footageSeconds === 3)
        && (cards.normalizeTemplate({ footageSeconds: 99 }).footageSeconds === 30));
    suite.check('normalizing leaves the stored object alone', (() => {
        const stored = { name: 'x', ending: { file: 'a.mp4' } };
        cards.normalizeTemplate(stored);
        return JSON.stringify(stored) === JSON.stringify({ name: 'x', ending: { file: 'a.mp4' } });
    })());
    suite.check('total length: movie section plus the ending',
        cards.totalSeconds(cards.normalizeTemplate({ ending: { file: 'end.mp4', startS: 11.25, lengthS: 3.82 } })) === 15.07);
    suite.check('total length with no ending file is the movie section alone',
        cards.totalSeconds(cards.normalizeTemplate({ ending: { file: '', startS: 0, lengthS: 3.82 } })) === 11.25);
    const problems = (x) => cards.templateProblems(x);
    suite.check('a good template has no problems', problems(t).length === 0, JSON.stringify(problems(t)));
    suite.check('a template needs a name', problems(Object.assign({}, t, { name: ' ' })).length === 1);
    suite.check('an unknown kind is a problem', problems(Object.assign({}, t, { kind: 'up-next' })).length === 1);
    suite.check('a negative ending start is a problem',
        problems(Object.assign({}, t, { ending: { file: 'a.mp4', startS: -1, lengthS: 3 } })).length === 1);

    // ---- which movie, and the card's key ---------------------------------------------------
    const scooby = { title: 'Scooby-Doo', ratingKey: '156995', serverKey: 'Thats So Disney/Nick Picks', year: 2002, type: 'movie' };
    suite.check("a movie's key is its Plex server and rating key", cards.movieKey(scooby) === 'Thats So Disney/Nick Picks|156995');
    suite.check('without a rating key, its title and year', cards.movieKey({ title: 'Balto', year: 1995 }) === 'Balto|1995');
    const base = { template: t, format: f, program: scooby, whenText: 'NEXT SATURDAY · 7PM', moment: null };
    const key = cards.cardKey(base);
    suite.check('a card key is 16 hex digits and the same for the same inputs',
        /^[0-9a-f]{16}$/.test(key) && (cards.cardKey(JSON.parse(JSON.stringify(base))) === key), key);
    const differs = (name, change) => suite.check(`${name} gives a new key`, cards.cardKey(Object.assign({}, base, change)) !== key);
    differs("the channel's bitrate", { format: Object.assign({}, f, { videoBitrate: 4000 }) });
    differs('a template edit', { template: Object.assign({}, t, { headingMain: 'CARTOON THEATER' }) });
    differs('another airtime', { whenText: 'TONIGHT · 7PM' });
    differs('a chosen moment', { moment: 2661.9 });
    differs('another movie', { program: Object.assign({}, scooby, { ratingKey: '1' }) });
    suite.check("a template's name is not part of the key (renaming re-renders nothing)",
        cards.cardKey(Object.assign({}, base, { template: Object.assign({}, t, { name: 'Renamed' }) })) === key);

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
