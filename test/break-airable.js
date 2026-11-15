/*
 * Approved automatically, and the points of a file that may air (docs/blocks-spec.md,
 * Stage 6, "The Midrolls switch, and approved automatically", and build order 5a):
 * autoApproval() in src/break-patterns.js and airablePoints() in src/break-airable.js,
 * on records shaped like the real scanner's.
 */
const { Suite } = require('./support');
const patterns = require('../src/break-patterns');
let airable = null;
try {
    airable = require('../src/break-airable');
} catch (e) {
    airable = null;
}

function pt(at, kind, strength = 0.75, extra = {}) {
    const black = [ at - 0.5, at + 0.5 ];
    return Object.assign( { at, black, silence: black, kind, sources: [ 'blackSilence' ], strength, keyframe: null, status: 'found', approvedBy: null }, extra );
}
function rec(minutes, points, extra = {}) {
    return Object.assign( { ratingKey: '1', size: 1000, mtimeMs: 5, durationMs: Math.round(minutes * 60000), scannedAt: 1, scanner: 1, chapters: [], points, noBreaks: false, error: null }, extra );
}
function show(files, extra = {}) {
    return Object.assign( { theatrical: false, pattern: null, files }, extra );
}

/*
 * A 22-minute show with "2 breaks an episode" whose breaks move from episode to
 * episode: an opening at 1:10, then two strong fades 5 minutes apart. `holding` of the
 * `n` episodes have both; the rest have one strong fade and one weak one.
 */
function twoBreaks(n, holding) {
    const files = {};
    for (let i = 0; i < n; i++) {
        const a = 400 + i * 53;
        files[`G:\\Show\\e${i + 1}.mkv`] = rec(22, [ pt(70, 'opening', 0.7), pt(a, 'act', 0.85), pt(a + 300, 'act', (i < holding) ? 0.88 : 0.4), pt(1300, 'credits', 0.8) ] );
    }
    return show(files);
}

const keys = (s) => Object.keys(s.files);
const ats = (list) => list.map( (p) => `${p.kind}@${Math.round(p.at)}:${p.by}` ).join(' ');
const approvedGroups = (s, opts) => patterns.autoApproval(s, opts).groups.filter( (g) => g.approved );

module.exports = async () => {
    const suite = new Suite('approved automatically, and the points that air');
    if ( (typeof patterns.autoApproval !== 'function') || (airable === null) ) {
        suite.check('autoApproval() and src/break-airable.js exist', false, `autoApproval: ${typeof patterns.autoApproval}, break-airable: ${airable === null ? 'missing' : 'present'}`);
        return suite;
    }
    const airs = (s, path, opts) => airable.airablePoints(s, path, opts);

    // ---- the rule, per running-length group -------------------------------------------
    {
        const s = twoBreaks(10, 7);
        suite.check('a Batman-like group (the count holds in 7 of 10 episodes) is not approved automatically',
            approvedGroups(s).length === 0, JSON.stringify(patterns.autoApproval(s).groups));
        suite.check('...and none of its episodes air a midroll', keys(s).every( (k) => airs(s, k).length === 0 ));
    }
    {
        const s = twoBreaks(8, 6);
        const g = approvedGroups(s);
        suite.check('the count in 6 of 8 episodes (3 of every 4) is approved automatically',
            (g.length === 1) && (g[0].count === 2) && (g[0].episodes === 8) && (g[0].holding === 6), JSON.stringify(patterns.autoApproval(s).groups));
        const holding = airs(s, 'G:\\Show\\e1.mkv');
        suite.check('...an episode with exactly 2 strong points airs both, approved automatically',
            ats(holding) === 'act@400:auto act@700:auto', ats(holding));
        suite.check('...an episode without the count airs nothing', airs(s, 'G:\\Show\\e8.mkv').length === 0, ats(airs(s, 'G:\\Show\\e8.mkv')));
    }
    {
        const four = twoBreaks(4, 4);
        const five = twoBreaks(5, 5);
        suite.check('a group of 4 scanned episodes is not approved automatically, every one fitting',
            approvedGroups(four).length === 0, JSON.stringify(patterns.autoApproval(four).groups));
        suite.check('...and a group of 5 is', approvedGroups(five).length === 1, JSON.stringify(patterns.autoApproval(five).groups));
    }
    {
        const s = twoBreaks(6, 6);
        const close = 'G:\\Show\\e3.mkv';
        s.files[close].points[2] = pt(s.files[close].points[1].at + 105, 'act', 0.88);
        suite.check('two picks 1:45 apart: that episode airs neither', airs(s, close).length === 0, ats(airs(s, close)));
        suite.check('...the rest of the group still air theirs', airs(s, 'G:\\Show\\e1.mkv').length === 2);
    }
    {
        // Full House: one break an episode, but only from weaker points: the second line.
        const files = {};
        for (let i = 0; i < 8; i++) {
            files[`F:\\FH\\e${i + 1}.mkv`] = rec(22, [ pt(70, 'opening', 0.7), pt(500 + i * 60, 'act', 0.45), pt(1300, 'credits', 0.8) ] );
        }
        const s = show(files);
        suite.check('the weaker second line is never approved automatically (it is offered for a click)',
            (patterns.showPatterns(s).groups[0].weaker !== null) && (approvedGroups(s).length === 0) && keys(s).every( (k) => airs(s, k).length === 0 ));
    }
    {
        // Happy Days: the same three places in every episode - a pattern by position.
        const files = {};
        [ 0, 8, -12, 15, -5, 20, 3, -9 ].forEach( (j, i) => {
            files[`F:\\HD\\e${i + 1}.mkv`] = rec(25.5, [ pt(74 + j, 'opening'), pt(706 + j, 'act', 0.85), pt(1380 + j, 'act', 0.85), pt(1500, 'credits') ] );
        } );
        const s = show(files);
        suite.check('a pattern by position is not approved automatically (never checked in frames)',
            (patterns.showPatterns(s).groups[0].pattern.count === null) && (approvedGroups(s).length === 0) && keys(s).every( (k) => airs(s, k).length === 0 ));
    }
    {
        // American Dragon S01E12 (the Nov 14 copy): most episodes' opening is at about 2:30,
        // but in some a weak point at 1:40 comes first and the strong one at 2:45 - where the
        // show's opening is - reads as an act. A click takes it for the opening; so does this.
        const lateOpening = (good, odd) => {
            const files = {};
            for (let i = 0; i < good + odd; i++) {
                const points = (i < good) ? [ pt(150, 'opening', 0.7), pt(500 + i * 60, 'act', 0.85) ]
                    : [ pt(100, 'opening', 0.14), pt(165, 'act', 0.71), pt(500 + i * 60, 'act', 0.45) ];
                files[`E:\\AD\\e${i + 1}.mkv`] = rec(23, points.concat( [ pt(1300, 'credits', 0.8) ] ));
            }
            return show(files);
        };
        const six = lateOpening(4, 2);
        suite.check('a strong point where the show\'s opening is counts as the opening: 4 of 6 hold, not approved',
            approvedGroups(six).length === 0, JSON.stringify(patterns.autoApproval(six).groups));
        const eight = lateOpening(6, 2);
        suite.check('...6 of 8 hold and it is approved, but the opening is not aired in the odd ones',
            (approvedGroups(eight).length === 1) && (airs(eight, 'E:\\AD\\e7.mkv').length === 0) && (airs(eight, 'E:\\AD\\e1.mkv').length === 1),
            `${JSON.stringify(patterns.autoApproval(eight).groups)} e7: ${ats(airs(eight, 'E:\\AD\\e7.mkv'))}`);
    }
    {
        const s = twoBreaks(6, 6);
        suite.check('the break after the opening is never approved automatically',
            keys(s).every( (k) => airs(s, k).every( (p) => p.kind !== 'opening' ) ) && (airs(s, 'G:\\Show\\e1.mkv').length === 2));
    }
    {
        const s = twoBreaks(6, 6);
        s.files['G:\\Show\\movie.mkv'] = rec(22, [ pt(70, 'opening', 0.7), pt(400, 'act', 0.85), pt(700, 'act', 0.88) ], { movie: true });
        suite.check('a TV movie inside a custom show is never approved automatically', airs(s, 'G:\\Show\\movie.mkv').length === 0);
        const m = twoBreaks(6, 6);
        suite.check('...nor a movie under its own movie key', (approvedGroups(m, { isMovie: true }).length === 0) && (airs(m, 'G:\\Show\\e1.mkv', { isMovie: true }).length === 0));
        const t = twoBreaks(6, 6);
        t.theatrical = true;
        suite.check('...nor a theatrical show', airs(t, 'G:\\Show\\e1.mkv').length === 0);
        const r = twoBreaks(6, 6);
        r.files['G:\\Show\\e2.mkv'].theatrical = true;
        suite.check('...nor a theatrical movie record', airs(r, 'G:\\Show\\e2.mkv').length === 0);
    }
    {
        const s = twoBreaks(6, 6);
        s.files['G:\\Show\\e2.mkv'].noBreaks = true;
        suite.check('an episode marked "no breaks" airs nothing automatically', airs(s, 'G:\\Show\\e2.mkv').length === 0);
        s.files['G:\\Show\\e2.mkv'].points.push(pt(600, 'act', 1, { status: 'hand', approvedBy: 'owner', sources: [ 'hand' ] }));
        suite.check('...but a break he placed in it himself still airs', ats(airs(s, 'G:\\Show\\e2.mkv')) === 'act@600:hand', ats(airs(s, 'G:\\Show\\e2.mkv')));
    }

    // ---- read, never written --------------------------------------------------------
    {
        const s = twoBreaks(6, 6);
        const before = JSON.stringify(s);
        patterns.autoApproval(s);
        keys(s).forEach( (k) => airs(s, k) );
        suite.check('working it out writes nothing to the show', JSON.stringify(s) === before);
    }

    // ---- a person's choices always win ----------------------------------------------
    {
        const s = twoBreaks(6, 6);
        const now = 1700000000000;
        patterns.withdraw(s, now);
        suite.check('Withdraw is remembered beside an empty pattern',
            (s.pattern === null) && (s.withdrawn != null) && (s.withdrawn.at === now), JSON.stringify( { pattern: s.pattern, withdrawn: s.withdrawn } ));
        suite.check('...and a withdrawn show stays off, though the rule would approve it',
            (approvedGroups(s).length === 1) && keys(s).every( (k) => airs(s, k).length === 0 ));
        patterns.approve(s, now + 1);
        suite.check('Approve clears it', s.withdrawn == null, JSON.stringify(s.withdrawn));
    }
    {
        const s = twoBreaks(6, 6);
        patterns.approve(s, 5);
        const list = airs(s, 'G:\\Show\\e1.mkv');
        suite.check('his Approve on the show: its pattern airs, opening and all, and nothing automatic',
            ats(list) === 'opening@70:pattern act@400:pattern act@700:pattern', ats(list));
    }
    {
        const s = twoBreaks(8, 6);
        const off = 'G:\\Show\\e8.mkv';    // not the count: the rule airs nothing here
        s.files[off].points[1] = Object.assign( {}, s.files[off].points[1], { status: 'approved', approvedBy: 'owner' } );
        suite.check('his approval of a point beats the rule', ats(airs(s, off)) === `act@${Math.round(s.files[off].points[1].at)}:owner`, ats(airs(s, off)));
        const on = 'G:\\Show\\e1.mkv';
        s.files[on].points[1] = Object.assign( {}, s.files[on].points[1], { status: 'rejected', approvedBy: 'owner' } );
        suite.check('...and so does his rejection: the point he rejected never airs, the other one still does',
            ats(airs(s, on)) === 'act@700:auto', ats(airs(s, on)));
    }
    return suite;
};
