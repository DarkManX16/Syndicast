/*
 * What the Breaks page shows (src/breaks-page.js): a show's line, the list to
 * check without the episodes that have no breaks, where to look in the picture,
 * and the order DarkManX16 checks shows in (what airs soonest first).
 */
const { Suite } = require('./support');
const page = require('../src/breaks-page');
const patterns = require('../src/break-patterns');
const edit = require('../src/break-edit');

function pt(at, kind, strength = 0.75, extra = {}) {
    const black = (extra.chapterOnly === true) ? null : [ at - 1, at + 1 ];
    return { at, black, silence: black, kind, sources: black ? [ 'blackSilence' ] : [ 'chapter' ], strength, keyframe: null, status: extra.status || 'found', approvedBy: extra.approvedBy || null };
}
function rec(minutes, points, extra = {}) {
    return Object.assign( { ratingKey: '1', size: 1, mtimeMs: 1, durationMs: Math.round(minutes * 60000), scannedAt: 1, scanner: 1, chapters: [], points, noBreaks: false, error: null }, extra );
}

// Happy Days: the same three places in five episodes, one missing its second act and
// carrying a stray scene fade; two more with nothing found; one marked "none".
function happyDays() {
    const files = {};
    [ 0, 8, -12, 15, -5 ].forEach( (j, i) => {
        files[`F:\\HD\\Happy Days (1974)\\e${i + 1}.mkv`] = rec(25.5, [ pt(74 + j, 'opening'), pt(706 + j, 'act'), pt(1380 + j, 'act'), pt(1500, 'credits') ]);
    } );
    files['F:\\HD\\Happy Days (1974)\\e6.mkv'] = rec(25.5, [ pt(74, 'opening'), pt(300, 'act', 0.4), pt(706, 'act'), pt(1500, 'credits') ]);
    files['F:\\HD\\Happy Days (1974)\\e7.mkv'] = rec(25.5, [ pt(1500, 'credits') ]);
    files['F:\\HD\\Happy Days (1974)\\e8.mkv'] = rec(25.5, []);
    files['F:\\HD\\Happy Days (1974)\\e9.mkv'] = rec(25.5, [ pt(706, 'act') ], { noBreaks: true });
    return { theatrical: false, pattern: null, files };
}

module.exports = async function() {
    const suite = new Suite('breaks page');
    const NOW = new Date('2026-11-14T12:00:00').getTime();
    const HOURS = 3600 * 1000;

    {
        const show = happyDays();
        const core = page.lineCore('tv.Happy Days', show, 'Happy Days', 12);
        const line = page.lineFor(core, { nextAt: NOW + 5 * HOURS, total: 12 }, NOW);
        suite.check('a line: how much is scanned, of how many on the channels',
            (line.scanned === 9) && (line.total === 12) && (line.name === 'Happy Days') && (line.kind === 'tv'), JSON.stringify([ line.scanned, line.total ]));
        suite.check('...the pattern on offer, read without the name and the count (they have columns of their own)',
            /^opening near 1:\d\d \(\d+%\), act near 11:\d\d/.test(line.pattern), String(line.pattern));
        suite.check('...not approved yet, so it needs a click', (line.approved === false) && (line.needsClick === true));
        suite.check('...an episode with no breaks found, and the one he marked, are counted on the line',
            (line.noBreaksFound === 2) && (line.markedNoBreaks === 1), JSON.stringify([ line.noBreaksFound, line.markedNoBreaks ]));
        suite.check('...it airs this week', line.thisWeek === true);
        suite.check('...an episode with nothing found is not on the list to check; the one missing an act is',
            (core.toCheck === 1), String(core.toCheck));

        const detail = page.detail('tv.Happy Days', show, 'Happy Days', () => null, { total: 12 }, NOW);
        suite.check('the list to check holds the episode missing its second act, with its reasons',
            (detail.toCheck.length === 1) && /e6/.test(detail.toCheck[0].path) && /no act near 23:/.test(detail.toCheck[0].reasons.join()), JSON.stringify(detail.toCheck.map( (e) => e.reasons )));
        suite.check('...every episode scanned is in the full list, the ones with no breaks too',
            (detail.episodes.length === 9) && detail.episodes.some( (e) => e.noBreaks ) && detail.episodes.some( (e) => /e8/.test(e.path) && (e.points.length === 0) ));
        suite.check('...credits are never shown as a point to act on', detail.episodes.every( (e) => e.points.every( (p) => p.kind !== 'credits' ) ));

        patterns.approve(show, NOW);
        const approved = page.lineFor(page.lineCore('tv.Happy Days', show, 'Happy Days', 12), { nextAt: NOW + 5 * HOURS }, NOW);
        suite.check('once the pattern is approved the line says so; the odd episode still needs him',
            (approved.approved === true) && (approved.needsClick === true) && (approved.toCheck === 1));

        // His say on the one stray point leaves the list
        const e6 = Object.keys(show.files).find( (p) => /e6/.test(p) );
        const stray = show.files[e6].points.findIndex( (p) => p.at === 300 );
        edit.editPoint(show.files[e6], stray, 'reject');
        const after = page.lineCore('tv.Happy Days', show, 'Happy Days', 12);
        suite.check('when every point waiting on an episode has been decided it leaves the list, and the show stops needing a click',
            (after.toCheck === 0) && (after.needsClick === false), JSON.stringify([ after.toCheck, after.needsClick ]));

        patterns.withdraw(show);
        const withdrawn = page.lineCore('tv.Happy Days', show, 'Happy Days', 12);
        suite.check('withdrawn, the pattern is on offer again', (withdrawn.approved === false) && (withdrawn.needsClick === true));
    }

    {
        // A show with no pattern whose episodes have nothing found: nothing to click.
        const files = {};
        for (let i = 0; i < 6; i++) {
            files[`G:\\Weasel\\e${i}.mkv`] = rec(11, []);
        }
        const core = page.lineCore('tv.I Am Weasel', { theatrical: false, pattern: null, files }, 'I Am Weasel', 6);
        suite.check('a show whose episodes all have no breaks found needs no click, and says how many have none',
            (core.needsClick === false) && (core.noBreaksFound === 6) && (core.toCheck === 0) && (core.pattern === null), JSON.stringify([ core.needsClick, core.noBreaksFound, core.pattern ]));
    }

    {
        // A TV movie's points wait for him; once decided it is done. A theatrical one lists none.
        const file = 'E:\\Movies\\Twitches.mkv';
        const show = { theatrical: false, pattern: null, files: { [file]: rec(88, [ pt(1678, 'act'), pt(3193, 'act') ], { movie: true }) } };
        const before = page.lineCore('movie.Twitches', show, 'Twitches', 1);
        suite.check('a TV movie\'s found points are on the list to check', (before.toCheck === 1) && (before.needsClick === true) && (before.kind === 'movie') && (before.pattern === null));
        edit.editPoint(show.files[file], 0, 'approve');
        suite.check('...one point decided, one still waiting: still on it', page.lineCore('movie.Twitches', show, 'Twitches', 1).toCheck === 1);
        edit.editPoint(show.files[file], 1, 'reject');
        suite.check('...both decided: off it', page.lineCore('movie.Twitches', show, 'Twitches', 1).toCheck === 0);
        edit.setTheatrical(show.files[file], true);
        edit.addPoint(show.files[file], 2000);
        const d = page.detail('movie.Twitches', show, 'Twitches', () => null, {}, NOW);
        suite.check('theatrical: only the breaks he added are shown, and nothing waits',
            (d.episodes[0].points.length === 1) && (d.episodes[0].points[0].status === 'hand') && (d.toCheck.length === 0) && d.episodes[0].theatrical);
    }

    {
        // A break he places, moves, approves or rejects is his own: never read as one with a point beside it
        const file = 'F:\X\e1.mkv';
        const show = { theatrical: false, pattern: null, files: { [file]: rec(22, [ pt(130, 'act'), pt(827, 'act') ]) } };
        edit.editPoint(show.files[file], 0, 'reject');
        edit.addPoint(show.files[file], 123.5);
        const shown = page.detail('tv.X', show, 'X', () => null, {}, NOW).episodes[0].points.map( (p) => `${p.at}:${p.status}` ).join(' ');
        suite.check('a break he adds 6 s from a rejected point is still there', shown === '123.5:hand 130:rejected 827:found', shown);
        edit.editPoint(show.files[file], 2, 'nudge', -690);
        const moved = page.detail('tv.X', show, 'X', () => null, {}, NOW).episodes[0].points.map( (p) => `${p.at}:${p.status}` ).join(' ');
        suite.check('...a point he nudges to within 15 s of another stays too', moved === '123.5:hand 130:rejected 137:approved', moved);
    }

    {
        // The order: what airs soonest, shows on no channel last
        const lines = [
            { name: 'B', nextAt: NOW + 50 * HOURS }, { name: 'A', nextAt: null }, { name: 'C', nextAt: NOW + 2 * HOURS },
            { name: 'D', nextAt: null }, { name: 'E', nextAt: NOW + 2 * HOURS },
        ];
        suite.check('sorted by when each show next airs, shows on no channel last, ties by name',
            page.byNextAiring(lines).map( (l) => l.name ).join('') === 'CEBAD', page.byNextAiring(lines).map( (l) => l.name ).join(''));
        suite.check('...a show airing in 8 days is not "this week"',
            page.lineFor({ total: 1 }, { nextAt: NOW + 8 * 24 * HOURS }, NOW).thisWeek === false);
    }

    {
        // Where to look
        const withBlack = page.framesOf({ at: 100, black: [ 98.5, 101.5 ] }, 1500);
        suite.check('a point with a black: the picture just before it and just after it',
            (withBlack.before === 98.1) && (withBlack.after === 101.9), JSON.stringify(withBlack));
        const cut = page.framesOf({ at: 100, black: null }, 1500);
        suite.check('a point with no black: either side of the cut', (cut.before === 99.9) && (cut.after === 100.1), JSON.stringify(cut));
        const edge = page.framesOf({ at: 1499.9, black: null }, 1500);
        suite.check('...never past the end of the file', edge.after <= 1499.8, JSON.stringify(edge));
        const start = page.framesOf({ at: 0.05, black: null }, 1500);
        suite.check('...nor before its start', start.before === 0);
    }

    {
        suite.check('an episode is named by season and episode when the channels know them',
            page.episodeName('F:\\x\\a.mkv', { type: 'episode', title: 'Howard\'s 45th Fiasco', season: 3, episode: 8 }) === 'S03E08 Howard\'s 45th Fiasco');
        suite.check('...a movie by its title, a file the channels no longer carry by its filename',
            (page.episodeName('E:\\m\\a.mkv', { type: 'movie', title: 'Twitches' }) === 'Twitches') && (page.episodeName('F:\\x\\Happy Days S03E08 Howard.mp4', null) === 'Happy Days S03E08 Howard'));
        suite.check('a custom show is named from the list the page was given',
            (page.nameOf('custom.abc', { abc: 'Saturday movies' }) === 'Saturday movies') && (page.nameOf('tv.Cheers') === 'Cheers') && (page.nameOf('movie.First Kid') === 'First Kid'));
    }

    return suite;
};
