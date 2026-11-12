/*
 * Show patterns and approval (src/break-patterns.js), on records shaped like the
 * real scanner's (docs/blocks-spec.md, Stage 6, "Show patterns, and approving",
 * with DarkManX16's Nov 10 changes): the kinds read past a file's fade-in, patterns by
 * position and by "N breaks an episode", groups by running length, one-click
 * approval and withdrawal, later episodes, the list to check, theatrical, movies,
 * and a file that changed and was scanned again.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const patterns = require('../src/break-patterns');
const store = require('../src/breaks-store');

// A point as the detector stores it. `old` marks a record scanned before the
// detector dropped its first 10 s (its fade-in point kept, the real opening an act).
function pt(at, kind, strength = 0.75, extra = {}) {
    const black = (extra.chapterOnly === true) ? null : [ at - 0.5, at + 0.5 ];
    return Object.assign( { at, black, silence: black, kind, sources: black ? [ 'blackSilence' ] : [ 'chapter' ], strength, keyframe: null, status: 'found', approvedBy: null },
        extra.status ? { status: extra.status, approvedBy: extra.approvedBy || null } : {} );
}
function rec(minutes, points, extra = {}) {
    return Object.assign( { ratingKey: '1', size: 1000, mtimeMs: 5, durationMs: Math.round(minutes * 60000), scannedAt: 1, scanner: 1, chapters: [], points, noBreaks: false, error: null }, extra );
}
function show(files, extra = {}) {
    return Object.assign( { theatrical: false, pattern: null, files }, extra );
}
const approvedAts = (r) => r.points.filter( (p) => p.status === 'approved' ).map( (p) => `${p.kind}@${Math.round(p.at)}` ).join(' ');

// Happy Days: the same three places in every episode, give or take 20 s; one
// episode is missing its second act; one has a stray scene fade at 5:00.
function happyDays() {
    const files = {};
    const jitter = [ 0, 8, -12, 15, -5, 20 ];
    jitter.forEach( (j, i) => {
        const points = [ pt(74 + j, 'opening'), pt(706 + j, 'act'), pt(1500, 'credits') ];
        if (i !== 5) {
            points.splice(2, 0, pt(1380 + j, 'act'));
        }
        if (i === 2) {
            points.splice(1, 0, pt(300, 'act', 0.4));
        }
        files[`F:\\HD\\e${i + 1}.mkv`] = rec(25.5, points);
    } );
    return show(files);
}

// Gargoyles, scanned before the fix: the fade-in at 0:00 called the opening, the
// real opening at 1:03 an act, then two strong acts that move from episode to
// episode, and weak scene fades.
function gargoyles() {
    const acts = [ [ 391, 805 ], [ 452, 860 ], [ 330, 701 ], [ 512, 905 ], [ 400, 780 ], [ 360, 950 ] ];
    const files = {};
    acts.forEach( ([a, b], i) => {
        files[`E:\\Gargoyles\\e${i + 1}.mkv`] = rec(22.8, [
            pt(0.63, 'opening', 0.62), pt(62.7, 'act', 0.47), pt(a, 'act', 0.73), pt(600 + i * 47, 'act', 0.35), pt(b, 'act', 0.71), pt(1367, 'credits', 0.85),
        ] );
    } );
    return show(files);
}

// Batman: two long fades (the act breaks) and four scene fades, all mid-episode.
function batman() {
    const files = {};
    for (let i = 0; i < 6; i++) {
        const a = 560 + i * 25;
        const b = 930 + i * 31;
        files[`G:\\Batman\\e${i + 1}.mkv`] = rec(22.4, [
            pt(70, 'opening', 0.7), pt(200 + i * 47, 'act', 0.45), pt(a, 'act', 0.85), pt(700 + i * 47, 'act', 0.52), pt(b, 'act', 0.88), pt(1100 + i * 47, 'act', 0.5), pt(1300 - i * 47, 'act', 0.41), pt(1330, 'credits', 0.8),
        ] );
    }
    return show(files);
}

module.exports = async () => {
    const suite = new Suite('break patterns');

    // ---- kinds, read past the fade-in ------------------------------------------------
    {
        const r = gargoyles().files['E:\\Gargoyles\\e1.mkv'];
        const eff = patterns.effectivePoints(r);
        suite.check('a stored point in the first 10 s is ignored, and the break after the titles reads as the opening - no rescan',
            (eff[0].kind === 'opening') && (Math.round(eff[0].at) === 63) && ! eff.some( (p) => p.at < 10 ), JSON.stringify(eff.map( (p) => `${p.kind}@${Math.round(p.at)}` )));
        suite.check('...each keeps its place in the stored list, so an approval lands on the stored point',
            eff[0].index === 1);
    }

    // ---- a pattern by position --------------------------------------------------------
    {
        const s = happyDays();
        suite.check('Happy Days\' line: the same three places in most episodes',
            patterns.patternLine('Happy Days', s, 104) === 'Happy Days, 6 of 104 episodes scanned: opening near 1:22 (100%), act near 11:54 (100%), act near 23:00 (83%)',
            patterns.patternLine('Happy Days', s, 104));
        const n = patterns.approve(s, 1000);
        const e1 = s.files['F:\\HD\\e1.mkv'];
        suite.check('approving the pattern approves the nearest point to each place in every episode',
            (approvedAts(e1) === 'opening@74 act@706 act@1380') && (n === 17), `${approvedAts(e1)} (${n} in all)`);
        suite.check('...marked as approved by the pattern, credits never',
            e1.points.filter( (p) => p.status === 'approved' ).every( (p) => p.approvedBy === 'pattern' ) && (e1.points.find( (p) => p.kind === 'credits' ).status === 'found'));
        const stray = s.files['F:\\HD\\e3.mkv'].points.find( (p) => Math.round(p.at) === 300 );
        suite.check('a stray scene fade in an episode that fits is not approved',
            stray.status === 'found');
        const list = patterns.outliers(s);
        suite.check('the list to check: only the episode missing its second act, not the one with a stray',
            (list.length === 1) && (list[0].path === 'F:\\HD\\e6.mkv') && (list[0].reasons.join() === 'no act near 23:00'), JSON.stringify(list));
    }

    // ---- "N breaks an episode": Gargoyles' breaks move ------------------------------------
    {
        const s = gargoyles();
        const line = patterns.patternLine('Gargoyles', s, 78);
        suite.check('Gargoyles\' line: the opening by position, then two breaks an episode at different times',
            line === 'Gargoyles, 6 of 78 episodes scanned: opening near 1:03 (100%), 2 breaks an episode at different times (6 of 6)', line);
        patterns.approve(s, 1000);
        const e4 = s.files['E:\\Gargoyles\\e4.mkv'];
        suite.check('approving it approves each episode\'s two strong mid-episode points and its opening, not the fade-in or the weak scene fade',
            approvedAts(e4) === 'opening@63 act@512 act@905', approvedAts(e4));
        suite.check('...the opening stored as an opening now, so "opening: false" keeps it off air',
            e4.points[1].kind === 'opening');
        suite.check('...and nothing to check: every episode fits',
            patterns.outliers(s).length === 0, JSON.stringify(patterns.outliers(s)));
    }

    // ---- Batman: the two strongest are the long fades -----------------------------------
    {
        const s = batman();
        const line = patterns.patternLine('Batman: The Animated Series', s);
        patterns.approve(s, 1000);
        const approvedMid = Object.values(s.files).map( (r) => r.points.filter( (p) => (p.status === 'approved') && (p.kind === 'act') ).map( (p) => p.strength ) );
        suite.check('Batman: "2 breaks an episode", the long fades approved and none of its scene fades',
            /2 breaks an episode at different times \(6 of 6\)/.test(line) && approvedMid.every( (s2) => (s2.length === 2) && s2.every( (x) => x >= 0.85 ) ), `${line} ${JSON.stringify(approvedMid)}`);
    }

    // ---- where both kinds of pattern exist, the one that fits more episodes ----------------
    {
        const s = happyDays();
        const g = patterns.showPatterns(s).groups[0].pattern;
        suite.check('a show whose breaks keep their places keeps the pattern by position',
            (g.count === null) && (g.positions.length === 3));
    }

    // ---- running lengths ------------------------------------------------------------------
    {
        const files = {};
        for (let i = 0; i < 4; i++) {
            files[`G:\\Gummi\\half${i}.mkv`] = rec(10.8, [ pt(58, 'opening'), pt(330 + i * 3, 'act') ]);
            files[`G:\\Gummi\\full${i}.mkv`] = rec(21.8, [ pt(59, 'opening'), pt(655 + i * 4, 'act') ]);
        }
        files['G:\\Gummi\\special.mkv'] = rec(44, [ pt(60, 'opening'), pt(1300, 'act') ]);
        const s = show(files);
        const line = patterns.patternLine('Adventures of the Gummi Bears', s);
        suite.check('11-minute and 22-minute files get a pattern each; one 44-minute special is too few to tell',
            line === 'Adventures of the Gummi Bears, 9 episodes scanned: 11-minute episodes (4): opening near 0:58 (100%), act near 5:36 (100%); 22-minute episodes (4): opening near 0:59 (100%), act near 11:03 (100%); 44-minute episodes (1): too few to tell', line);
        patterns.approve(s, 1000);
        suite.check('...each approved by its own pattern',
            (approvedAts(s.files['G:\\Gummi\\half2.mkv']) === 'opening@58 act@336') && (approvedAts(s.files['G:\\Gummi\\full2.mkv']) === 'opening@59 act@663'));
        const list = patterns.outliers(s);
        suite.check('...and the special is on the list as the only one of its length',
            (list.length === 1) && (list[0].reasons.join() === 'only 1 episode of this length (44 min)'), JSON.stringify(list));
    }

    // ---- withdrawing ------------------------------------------------------------------------
    {
        const s = happyDays();
        s.files['F:\\HD\\e2.mkv'].points[1] = Object.assign( {}, s.files['F:\\HD\\e2.mkv'].points[1], { status: 'approved', approvedBy: 'owner' } );
        s.files['F:\\HD\\e4.mkv'].points[1] = Object.assign( {}, s.files['F:\\HD\\e4.mkv'].points[1], { status: 'rejected' } );
        patterns.approve(s, 1000);
        suite.check('DarkManX16\'s own approval and rejection are left as they are by the pattern',
            (s.files['F:\\HD\\e2.mkv'].points[1].approvedBy === 'owner') && (s.files['F:\\HD\\e4.mkv'].points[1].status === 'rejected'));
        const back = patterns.withdraw(s);
        suite.check('withdrawing returns every pattern-approved point to found, and only those',
            (back === 15) && (s.pattern === null) && Object.values(s.files).every( (r) => r.points.every( (p) => p.approvedBy !== 'pattern' ) ) && (s.files['F:\\HD\\e2.mkv'].points[1].status === 'approved'), back);
    }

    // ---- theatrical and movies ----------------------------------------------------------------
    {
        const s = happyDays();
        s.theatrical = true;
        suite.check('a theatrical show has no pattern, approves nothing and lists nothing',
            (patterns.showPatterns(s).groups.length === 0) && (patterns.approve(s, 1) === 0) && (patterns.outliers(s).length === 0)
            && (patterns.patternLine('The Iron Giant', s) === 'The Iron Giant: theatrical, breaks only where added by hand'));
        const movie = show( { 'D:\\Even Stevens.mkv': rec(94, [ pt(5, 'opening'), pt(1678, 'act'), pt(3193, 'act'), pt(4514, 'act'), pt(5600, 'credits') ]) } );
        const list = patterns.outliers(movie, true);
        suite.check('a TV movie always lists its points to check, its fade-in left out',
            (list.length === 1) && (list[0].reasons[0] === 'a TV movie: 3 points to check (27:58, 53:13, 75:14)'), JSON.stringify(list));
    }

    // ---- no audio, no breaks, chapter-only ----------------------------------------------------
    {
        const s = happyDays();
        s.files['F:\\HD\\silent.mp4'] = rec(25.5, [ pt(706, 'act', 0.15, { chapterOnly: true }) ], { noAudio: true });
        s.files['F:\\HD\\blank.mkv'] = rec(25.5, [ pt(1500, 'credits') ]);
        const list = patterns.outliers(s);
        const of = (p) => (list.find( (x) => x.path === p ) || { reasons: [] }).reasons.join(' | ');
        suite.check('a file with no audio is listed, with its chapter-only point',
            /^no audio track/.test(of('F:\\HD\\silent.mp4')) && /a chapter-only point at 11:46/.test(of('F:\\HD\\silent.mp4')), of('F:\\HD\\silent.mp4'));
        suite.check('an episode with no breaks found is listed as such',
            /^no breaks found/.test(of('F:\\HD\\blank.mkv')), of('F:\\HD\\blank.mkv'));
    }

    // ---- later episodes, and a file that changed, through the store ------------------------------
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'break-patterns-'));
        try {
            const dir = path.join(tmp, 'breaks');
            const s = happyDays();
            patterns.approve(s, 1000);
            store.saveShow(dir, 'tv.Happy Days', s);
            const file = (p, size) => ({ path: p, ratingKey: '9', size, mtimeMs: 5, durationS: 25.5 * 60, chapters: [] });
            const fitting = store.recordFor(dir, 'tv.Happy Days', file('F:\\HD\\e7.mkv', 1000), { points: [ pt(80, 'opening'), pt(712, 'act'), pt(1390, 'act'), pt(1500, 'credits') ] }, () => 2000);
            suite.check('an episode scanned after the pattern was approved is approved as it arrives',
                approvedAts(fitting) === 'opening@80 act@712 act@1390', approvedAts(fitting));
            const odd = store.recordFor(dir, 'tv.Happy Days', file('F:\\HD\\e8.mkv', 1000), { points: [ pt(80, 'opening'), pt(500, 'act'), pt(1500, 'credits') ] }, () => 2000);
            const saved = store.loadShow(dir, 'tv.Happy Days');
            suite.check('...one that does not fit has its matching points approved and joins the list',
                (approvedAts(odd) === 'opening@80') && patterns.outliers(saved).some( (x) => (x.path === 'F:\\HD\\e8.mkv') && /no act near 11:54/.test(x.reasons.join()) ), approvedAts(odd));
            const changed = store.recordFor(dir, 'tv.Happy Days', file('F:\\HD\\e1.mkv', 2000), { points: [ pt(74, 'opening'), pt(707, 'act'), pt(1381, 'act'), pt(1500, 'credits') ] }, () => 3000);
            suite.check('a file that changed and was scanned again is approved again by the pattern',
                approvedAts(changed) === 'opening@74 act@707 act@1381', approvedAts(changed));
            const plain = store.recordFor(dir, 'tv.Cheers', file('F:\\Cheers\\e1.mkv', 1000), { points: [ pt(80, 'opening'), pt(712, 'act') ] }, () => 2000);
            suite.check('a show with no approved pattern approves nothing on its own',
                approvedAts(plain) === '');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    return suite;
};
