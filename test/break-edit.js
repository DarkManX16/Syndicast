/*
 * DarkManX16's own say on a file's break points (src/break-edit.js): approve, reject,
 * nudge, a typed time, a kind, a break he adds, "this one has none", theatrical -
 * and that none of it is undone by a pattern's withdraw or approval.
 */
const { Suite } = require('./support');
const edit = require('../src/break-edit');
const patterns = require('../src/break-patterns');

function pt(at, kind, strength = 0.75, status = 'found', approvedBy = null) {
    return { at, black: [ at - 1, at + 1 ], silence: [ at - 1, at + 1 ], kind, sources: [ 'blackSilence' ], strength, keyframe: at - 0.4, status, approvedBy };
}
function rec(points) {
    return { ratingKey: '1', size: 1, mtimeMs: 1, durationMs: 25 * 60000, scannedAt: 1, scanner: 1, chapters: [], points, noBreaks: false, error: null };
}

module.exports = async function() {
    const suite = new Suite('break edit');

    {
        const r = rec([ pt(80, 'opening'), pt(700, 'act'), pt(1380, 'act') ]);
        edit.editPoint(r, 1, 'approve');
        suite.check('approve: the point airs, and it is his own approval',
            (r.points[1].status === 'approved') && (r.points[1].approvedBy === 'owner'));
        edit.editPoint(r, 2, 'reject');
        suite.check('reject: it stays recorded as rejected, so a rescan does not offer it again',
            (r.points.length === 3) && (r.points[2].status === 'rejected') && (r.points[2].approvedBy === 'owner'));
    }

    {
        const r = rec([ pt(700, 'act') ]);
        const res = edit.editPoint(r, 0, 'nudge', 1.5);
        suite.check('nudge moves the point, approves it as his, and remembers where it was found',
            res.ok && (r.points[0].at === 701.5) && (r.points[0].status === 'approved') && (r.points[0].foundAt === 700) && (r.points[0].approvedBy === 'owner'));
        edit.editPoint(r, 0, 'nudge', -0.5);
        suite.check('...nudged again, it still remembers the first place', r.points[0].foundAt === 700);
        suite.check('...the keyframe of the old place is dropped (a copied file starts on a keyframe)', r.points[0].keyframe === null);
        edit.editPoint(r, 0, 'nudge', 5);
        suite.check('...a nudge out of the black drops the black, which no longer holds the point', r.points[0].black === null);
    }

    {
        const r = rec([ pt(700, 'act') ]);
        suite.check('a typed time moves it too', edit.editPoint(r, 0, 'time', 705).ok && (r.points[0].at === 705));
        suite.check('...a time outside the episode is refused, and nothing changes',
            ! edit.editPoint(r, 0, 'time', 25 * 60 + 1).ok && ! edit.editPoint(r, 0, 'nudge', -9999).ok && (r.points[0].at === 705));
        suite.check('...a point reordered by a move stays in time order',
            (() => { const q = rec([ pt(100, 'act'), pt(200, 'act') ]); edit.editPoint(q, 0, 'time', 300); return q.points.map( (p) => p.at ).join() === '200,300'; })());
    }

    {
        const r = rec([ pt(700, 'act') ]);
        suite.check('kind: relabelled', edit.editPoint(r, 0, 'kind', 'story').ok && (r.points[0].kind === 'story'));
        suite.check('...only to a real kind', ! edit.editPoint(r, 0, 'kind', 'nonsense').ok && (r.points[0].kind === 'story'));
        suite.check('...and a point that is not there, or an action that is not one, is refused',
            ! edit.editPoint(r, 7, 'approve').ok && ! edit.editPoint(r, 0, 'explode').ok);
    }

    {
        const r = rec([ pt(700, 'act') ]);
        const added = edit.addPoint(r, 400);
        suite.check('add a break: a hand point, his, sorted into place',
            added.ok && (r.points.length === 2) && (r.points[0].at === 400) && (r.points[0].status === 'hand') && (r.points[0].approvedBy === 'owner') && (added.index === 0));
        suite.check('...a hand point rejected is simply gone', edit.editPoint(r, 0, 'reject').ok && (r.points.length === 1));
        const again = edit.addPoint(r, 700.4);
        suite.check('...adding one where a point already is approves that one instead', (r.points.length === 1) && again.ok && (r.points[0].status === 'approved'));
        suite.check('...outside the episode is refused', ! edit.addPoint(r, 99999).ok && ! edit.addPoint(r, -1).ok);
    }

    {
        const r = rec([]);
        edit.setNoBreaks(r, true);
        suite.check('"this one has none"', r.noBreaks === true);
        edit.setNoBreaks(r, false);
        suite.check('...and back', r.noBreaks === false);
        edit.setTheatrical(r, true);
        suite.check('theatrical is on the movie\'s own record', r.theatrical === true);
        edit.setTheatrical(r, false);
        suite.check('...and off again', r.theatrical === undefined);
    }

    {
        // A record marked "none" or theatrical is no longer spoken for by a pattern
        const mk = () => rec([ pt(74, 'opening', 0.75, 'approved', 'pattern'), pt(706, 'act', 0.75, 'approved', 'pattern'), pt(1380, 'act', 0.75, 'approved', 'owner'), Object.assign( pt(500, 'act'), { status: 'hand', approvedBy: 'owner' } ) ]);
        const none = mk();
        edit.setNoBreaks(none, true);
        suite.check('marking an episode "none" sends what the pattern approved back to found, and leaves his own approvals and breaks',
            (none.points[0].status === 'found') && (none.points[0].approvedBy === null) && (none.points[1].status === 'found') && (none.points[2].status === 'approved') && (none.points[3].status === 'hand'),
            JSON.stringify(none.points.map( (p) => p.status )));
        const theatrical = mk();
        edit.setTheatrical(theatrical, true);
        suite.check('...a movie marked theatrical the same', (theatrical.points[1].status === 'found') && (theatrical.points[2].status === 'approved'));
    }

    {
        // His own say survives the pattern's withdraw, and a pattern approved later.
        const make = (n) => rec([ pt(74, 'opening'), pt(706 + n, 'act'), pt(1380 + n, 'act') ]);
        const show = { theatrical: false, pattern: null, files: { a: make(0), b: make(5), c: make(-8), d: make(10) } };
        patterns.approve(show, 1);
        edit.editPoint(show.files.a, 1, 'reject');
        edit.editPoint(show.files.b, 2, 'nudge', 2);
        patterns.withdraw(show);
        suite.check('withdrawing the pattern leaves a point he rejected rejected, and one he moved approved',
            (show.files.a.points[1].status === 'rejected') && (show.files.b.points[2].status === 'approved') && (show.files.b.points[2].at === 1387)
                && (show.files.c.points[1].status === 'found'));
        patterns.approve(show, 2);
        suite.check('...approving it again does not bring the rejected one back',
            (show.files.a.points[1].status === 'rejected') && (show.files.a.points[2].status === 'approved'));
    }

    return suite;
};
