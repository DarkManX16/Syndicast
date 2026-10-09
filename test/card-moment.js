/*
 * Generated cards: picking a lively stretch of a movie for its Next Time card
 * (src/card-moment.js). Built on synthetic measurements shaped like the real
 * ones: a keyframe list from ffprobe and momentary loudness from ffmpeg's
 * ebur128, one value every 0.1s.
 */
const { Suite } = require('./support');
const moment = require('../src/card-moment');

// A movie of `durationS` seconds: keyframes every `gop` seconds plus any extra
// cut times, and a loudness of `base` LUFS except where `loud` or `quiet` say.
function movie(durationS, { gop = 5, cuts = [], base = -26, loud = [], quiet = [] } = {}) {
    const keyframes = [];
    for (let t = 0; t < durationS; t += gop) {
        keyframes.push(t);
    }
    for (const c of cuts) {
        keyframes.push(c);
    }
    keyframes.sort( (a, b) => a - b );
    const loudness = [];
    for (let i = 0; i * 0.1 < durationS; i++) {
        const t = i * 0.1;
        let m = base;
        for (const [from, to, value] of loud) {
            if ( (t >= from) && (t < to) ) {
                m = value;
            }
        }
        for (const [from, to] of quiet) {
            if ( (t >= from) && (t < to) ) {
                m = -60;
            }
        }
        loudness.push([t, m]);
    }
    return { durationS, keyframes, loudness };
}

const busyCuts = (from, n, step) => Array.from({ length: n }, (_, i) => from + 1 + i * step);

module.exports = async () => {
    const suite = new Suite('card moment');
    const L = 11.25;
    const D = 90 * 60;

    // ---- reading the measurements -------------------------------------------------------
    suite.check('keyframes read from ffprobe packet lines, only the K ones',
        JSON.stringify(moment.parseKeyframes('0.000000,K__\n0.041708,___\n4.170833,K__\r\n\n')) === JSON.stringify([0, 4.170833]));
    const parsed = moment.parseLoudness('frame:0    pts:0       pts_time:0\nlavfi.r128.M=-120.691\nframe:1 pts:4410 pts_time:0.1\nlavfi.r128.M=-18.6\nframe:2 pts:8820 pts_time:0.2\nlavfi.r128.M=-inf\n');
    suite.check('loudness read from ametadata lines, floored at -70',
        JSON.stringify(parsed) === JSON.stringify([[0, -70], [0.1, -18.6], [0.2, -70]]), JSON.stringify(parsed));

    // ---- picking --------------------------------------------------------------------------
    const lively = movie(D, { loud: [[3000, 3020, -17]], cuts: busyCuts(3000, 6, 1.5) });
    const picked = moment.pickMoment(lively, L);
    suite.check('the loud stretch full of cuts wins', (picked.startS >= 2995) && (picked.startS <= 3001), JSON.stringify(picked.startS));
    suite.check('it starts on a keyframe', lively.keyframes.includes(picked.startS));
    suite.check('up to five candidates are kept, best first',
        (picked.candidates.length === 5) && (picked.candidates[0].startS === picked.startS)
        && picked.candidates.every( (c, i, a) => (i === 0) || (a[i - 1].score >= c.score) ));

    const credits = movie(D, { loud: [[60, 80, -12], [D - 300, D - 280, -12]], cuts: busyCuts(60, 6, 1.5).concat(busyCuts(D - 300, 6, 1.5)) });
    const avoided = moment.pickMoment(credits, L).startS;
    suite.check('the opening and the last stretch are never used, however loud',
        (avoided >= Math.max(0.10 * D, 240)) && (avoided + L <= D - Math.max(0.20 * D, 600)), String(avoided));

    const hushed = movie(D, { base: -22, loud: [[2000, 2020, -15]], quiet: [[2003, 2010]], cuts: busyCuts(2000, 6, 1.5) });
    const notHushed = moment.pickMoment(hushed, L).startS;
    suite.check('a stretch with a quiet gap is passed over', (notHushed + L <= 2003) || (notHushed >= 2010), String(notHushed));

    const short = movie(8 * 60);
    const middle = moment.pickMoment(short, L);
    suite.check('a movie too short for the rule starts near its middle, on a keyframe',
        (Math.abs(middle.startS - (240 - L / 2)) <= 5) && short.keyframes.includes(middle.startS), String(middle.startS));

    const silent = moment.pickMoment(movie(D, { base: -60 }), L);
    suite.check('a movie quiet throughout still gets a moment inside the allowed stretch',
        (silent.startS >= 0.10 * D) && (silent.startS + L <= D - 0.20 * D), String(silent.startS));

    const nothing = moment.pickMoment({ durationS: D, keyframes: [], loudness: [] }, L);
    suite.check('no measurements at all: the middle of the movie', Math.abs(nothing.startS - (D / 2 - L / 2)) < 0.001, String(nothing.startS));

    // ---- the commands that measure ------------------------------------------------------
    const cmds = moment.analysisCommands('G:/Movies/Scooby-Doo.mp4');
    suite.check('keyframes come from ffprobe packet flags, without decoding',
        cmds.keyframes.join(' ').includes('-show_entries packet=pts_time,flags') && cmds.keyframes.includes('G:/Movies/Scooby-Doo.mp4'));
    suite.check('loudness comes from the audio alone, momentary, printed to stdout',
        cmds.loudness.includes('-vn') && cmds.loudness.join(' ').includes('ebur128=metadata=1')
        && cmds.loudness.join(' ').includes('file=-'));

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
