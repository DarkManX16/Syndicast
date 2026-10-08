/*
 * The Nicknames page: listing every nickname with what it means, and editing or deleting one.
 * The logic (src/nicknames.js), the alias file's writer (ShowAliasDB#change), the service and
 * its three routes. The point of the page is that changing a nickname only changes what is
 * suggested for clips whose names are not saved: no name saved on a clip is ever rewritten, and
 * before anything is saved the clips whose suggestion would change are listed.
 *
 * Fixtures and throwaway folders under the OS temp directory only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { MIN, Suite } = require('./support');
const clipNames = require('../src/clip-names');
const showMatch = require('../src/show-match');
const nicknames = require('../src/nicknames');
const FillerDB = require('../src/dao/filler-db');
const ShowAliasDB = require('../src/dao/show-alias-db');
const ShowMatchService = require('../src/services/show-match-service');
const api = require('../src/api');

const JL = 'tv.Justice League';
const EVEN = 'tv.Even Stevens';
const KIM = 'tv.Kim Possible';
const HANNAH = 'tv.Hannah Montana';
const S3 = { show: JL, season: 3 };
const S345 = { show: JL, seasons: [3, 4, 5] };
const CCR = { anyOf: [EVEN, KIM] };

function episode(show, season, n) {
    return { title: `${show} S${season}E${n}`, type: 'episode', showTitle: show, season, episode: n, duration: 22 * MIN, serverKey: 'srv', ratingKey: `${show}-${season}-${n}` };
}
const PROGRAMS = [
    episode('Justice League', 1, 1), episode('Justice League', 3, 1), episode('Justice League', 4, 1), episode('Justice League', 5, 1),
    episode('Even Stevens', 1, 1), episode('Kim Possible', 1, 1), episode('Hannah Montana', 1, 1), episode('Batman Beyond', 1, 1),
    { isOffline: true, duration: 5 * MIN },
];
const CHANNELS = [ { number: 1, name: 'Toonami', programs: PROGRAMS, scheduleBackup: { slots: [] } } ];
const vocabulary = showMatch.buildVocabulary(CHANNELS, {});

const clip = (list, index, title, names, reviewed) => ({ list, listName: 'List ' + list, index, title, names: names || [], reviewed: reviewed === true });
const CLIPS = [
    clip('a', 0, 'Toonami - Justice League Unlimited Short Intro (4K HD)', [S3]),         // saved as season 3
    clip('a', 1, 'Justice League Unlimited Promo'),                                          // unsaved
    clip('a', 2, 'Justice League Unlimited Promo [2005]', [], true),                         // reviewed: names no show
    clip('a', 3, 'Unlimited Power'),                                                         // unsaved
    clip('a', 4, 'Even Stevens Behind the Scenes (Christy Romano)'),                         // unsaved, names a show by its title
    clip('a', 5, 'Christy Romano Wand ID'),                                                  // unsaved, only the nickname names it
    clip('b', 0, 'Kim Possible Wand ID (Christy Romano)', [KIM]),                            // saved
    clip('b', 1, 'Unlimited Fun Facts', [HANNAH]),                                           // saved under another show
    clip('b', 2, 'Full House ID'),
];
const ALIASES = { unlimited: S3, 'christy romano': CCR, 'emily osment': HANNAH, 'gone nick': 'tv.Gone Show' };
const ctx = (aliases, clips) => ({ vocabulary, aliases: aliases || ALIASES, clips: clips || CLIPS });
const label = (names) => names.map( (n) => clipNames.labelOf(n, vocabulary.names) ).join(' → ') || '(none)';
const find = (changes, list, index) => changes.find( (c) => c.list === list && c.index === index );

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-nicknames-'));
}
function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* left for the OS */ }
}
const sha = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

module.exports = async function run() {
    const suite = new Suite('nicknames-page');

    // ---- the list ---------------------------------------------------------------------
    {
        const rows = nicknames.listNicknames(ALIASES, vocabulary, CLIPS);
        suite.check('every nickname is listed, alphabetically, with what it means in words',
            rows.map( (r) => r.alias ).join() === 'christy romano,emily osment,gone nick,unlimited'
            && rows.find( (r) => r.alias === 'unlimited' ).label === 'Justice League · Season 3'
            && rows.find( (r) => r.alias === 'christy romano' ).label === 'Even Stevens or Kim Possible'
            && rows.find( (r) => r.alias === 'emily osment' ).label === 'Hannah Montana', JSON.stringify(rows.map( (r) => r.label )));
        suite.check('and which kind it is: a show, some seasons, any one of several',
            rows.map( (r) => r.kind ).join() === 'anyOf,show,show,seasons'
            && nicknames.kindOf(S345) === 'seasons' && nicknames.kindOf(S3) === 'seasons' && nicknames.kindOf(CCR) === 'anyOf' && nicknames.kindOf(JL) === 'show');
        suite.check('a nickname for a show that is on no channel is marked, still reads, and is not the others',
            rows.find( (r) => r.alias === 'gone nick' ).missing === true && rows.filter( (r) => r.missing ).length === 1 && rows.find( (r) => r.alias === 'gone nick' ).label === 'Gone Show');
        suite.check('how many clips have it in their title is counted over every list, whole words only',
            rows.find( (r) => r.alias === 'unlimited' ).used === 5 && rows.find( (r) => r.alias === 'christy romano' ).used === 3
            && rows.find( (r) => r.alias === 'emily osment' ).used === 0 && nicknames.listNicknames({ lim: JL }, vocabulary, [{ title: 'Unlimited' }])[0].used === 0);
        suite.check('no nicknames is an empty list', nicknames.listNicknames({}, vocabulary, CLIPS).length === 0 && nicknames.listNicknames(null, vocabulary, null).length === 0);
    }

    // ---- deleting: what would change ---------------------------------------------------
    {
        const frozen = JSON.stringify([ALIASES, CLIPS]);
        const del = nicknames.previewEdit({ alias: 'unlimited', remove: true }, ctx());
        suite.check('deleting a nickname is ok and lists the unsaved clips whose suggestion would change, with before and after',
            del.ok === true && del.remove === true && del.problems.length === 0
            && label(find(del.changes, 'a', 1).before) === 'Justice League · Season 3' && label(find(del.changes, 'a', 1).after) === 'Justice League'
            && label(find(del.changes, 'a', 3).before) === 'Justice League · Season 3' && label(find(del.changes, 'a', 3).after) === '(none)',
            JSON.stringify(del.changes.map( (c) => [c.index, label(c.before), label(c.after)] )));
        suite.check('a clip with a name saved, saved under another show, or marked as naming no show is not listed as changed: it is counted as kept',
            ! find(del.changes, 'a', 0) && ! find(del.changes, 'a', 2) && ! find(del.changes, 'b', 1) && del.kept === 3, 'kept ' + del.kept);
        suite.check('a clip that does not have the nickname in its title is not listed',
            del.changes.length === 2 && ! find(del.changes, 'b', 2) && ! find(del.changes, 'a', 4));
        suite.check('preview reads only: nothing passed in is changed', JSON.stringify([ALIASES, CLIPS]) === frozen);
        const wand = nicknames.previewEdit({ alias: 'christy romano', remove: true }, ctx());
        suite.check('deleting a nickname for any of two shows leaves the clip that names a show in its title as it is, and un-names the one only it named',
            wand.ok && wand.changes.length === 1 && label(find(wand.changes, 'a', 5).before) === 'Even Stevens or Kim Possible' && label(find(wand.changes, 'a', 5).after) === '(none)', JSON.stringify(wand.changes.map( (c) => c.index )));
        suite.check('a nickname that is not in the list is refused, saying so',
            nicknames.previewEdit({ alias: 'nope', remove: true }, ctx()).ok === false && /not in the list/.test(nicknames.previewEdit({ alias: 'nope', remove: true }, ctx()).problems.join(' '))
            && nicknames.previewEdit({ remove: true }, ctx()).ok === false);
        suite.check('the nickname is found however it is spelled', nicknames.previewEdit({ alias: 'Christy  ROMANO', remove: true }, ctx()).ok === true);
        suite.check('a nickname for a show no channel has can be deleted',
            nicknames.previewEdit({ alias: 'gone nick', remove: true }, ctx()).ok === true);
        const flagged = nicknames.previewEdit({ alias: 'christy romano', remove: true }, ctx(ALIASES, [ clip('c', 0, 'Christy Romano to Zork Zork Zork') ]));
        suite.check('a title with several shows whose recognised one is the nickname goes from flagged to nothing, and that counts as a change',
            flagged.ok && flagged.changes.length === 0 || (flagged.changes.length === 1 && flagged.changes[0].beforeFlagged === true), JSON.stringify(flagged.changes));
    }

    // ---- editing: what it means, what it says --------------------------------------------
    {
        const widen = nicknames.previewEdit({ alias: 'unlimited', target: S345 }, ctx());
        suite.check('changing what a nickname means (season 3 to seasons 3 to 5) is ok and lists the unsaved clips that would read differently',
            widen.ok === true && widen.alias === 'unlimited' && widen.newAlias === 'unlimited' && clipNames.sameName(widen.target, S345)
            && label(find(widen.changes, 'a', 1).after) === 'Justice League · Seasons 3–5' && widen.changes.length === 2, JSON.stringify(widen.changes.map( (c) => [c.index, label(c.after)] )));
        const rename = nicknames.previewEdit({ alias: 'unlimited', newAlias: 'Justice League Unlimited', target: S345 }, ctx());
        suite.check('renaming it and widening it together: the old text stops meaning it, the new one does, over the clips that have either',
            rename.ok === true && rename.newAlias === 'justice league unlimited'
            && label(find(rename.changes, 'a', 1).after) === 'Justice League · Seasons 3–5' && label(find(rename.changes, 'a', 3).after) === '(none)', JSON.stringify(rename.changes.map( (c) => [c.index, label(c.before), label(c.after)] )));
        const justRename = nicknames.previewEdit({ alias: 'christy romano', newAlias: 'christy carlson romano' }, ctx());
        suite.check('changing only the text keeps what it means',
            justRename.ok === true && clipNames.sameName(justRename.target, CCR) && label(find(justRename.changes, 'a', 5).after) === '(none)');
        const same = nicknames.previewEdit({ alias: 'unlimited', newAlias: 'Unlimited', target: S3 }, ctx());
        suite.check('changing nothing is not a change', same.ok === false && /Nothing has changed/.test(same.problems.join(' ')));
        suite.check('an edit that leaves everything out is nothing changed too',
            nicknames.previewEdit({ alias: 'unlimited' }, ctx()).ok === false);
        suite.check('the same text as another nickname is refused, saying what that one means',
            (() => { const r = nicknames.previewEdit({ alias: 'unlimited', newAlias: 'emily osment' }, ctx()); return r.ok === false && /already means Hannah Montana/.test(r.problems.join(' ')); })());
        suite.check('an everyday word, a number, a title, nothing, too short or too long are refused, as when teaching',
            ['promo', 'next', '1999', 'Justice League', '', '  ', 'ab', 'one two three four five six seven'].every( (t) => nicknames.previewEdit({ alias: 'unlimited', newAlias: t }, ctx()).ok === false ));
        suite.check('a meaning that is no show, a show on no channel, or an any-of of one are refused',
            [null, 'tv.Nope', { anyOf: [EVEN, 'tv.Nope'] }, { anyOf: [EVEN] }, { show: JL, seasons: [5, 3] }].every( (t) => nicknames.previewEdit({ alias: 'unlimited', target: t }, ctx()).ok === false ));
        const toAny = nicknames.previewEdit({ alias: 'emily osment', target: { anyOf: [HANNAH, EVEN] } }, ctx());
        suite.check('a nickname for one show can become any one of several',
            toAny.ok === true && clipNames.sameName(toAny.target, { anyOf: [HANNAH, EVEN] }));
        suite.check('a nickname for a show that is gone can be pointed at a show that is there',
            nicknames.previewEdit({ alias: 'gone nick', target: HANNAH }, ctx()).ok === true);
        suite.check('and a refused edit lists no changes', nicknames.previewEdit({ alias: 'unlimited', newAlias: 'promo' }, ctx()).changes.length === 0);
        // editing a nickname that is not used by any other clip changes no suggestion
        const quiet = nicknames.previewEdit({ alias: 'emily osment', target: JL }, ctx());
        suite.check('a nickname no clip has in its title changes no suggestion', quiet.ok === true && quiet.changes.length === 0 && quiet.kept === 0);
    }

    // ---- the alias file's writer ----------------------------------------------------------
    {
        const dir = tempDir();
        try {
            const file = path.join(dir, 'show-aliases.json');
            const db = new ShowAliasDB(dir);
            const write = (text) => fs.writeFileSync(file, text);
            const raw = () => JSON.parse(fs.readFileSync(file, 'utf8'));
            write(JSON.stringify({ note: 'kept', aliases: { first: 'tv.A', second: S3, odd: { show: 'tv.A', seasons: [5, 3] }, last: 'tv.B' } }));
            await db.change('second', 'second', S345);
            suite.check('giving a nickname another meaning keeps its place, and everything else in the file as it was, hand-edited oddities and other keys too',
                Object.keys(raw().aliases).join() === 'first,second,odd,last' && JSON.stringify(raw().aliases.second) === JSON.stringify(S345)
                && JSON.stringify(raw().aliases.odd) === JSON.stringify({ show: 'tv.A', seasons: [5, 3] }) && raw().note === 'kept' && raw().aliases.last === 'tv.B');
            await db.change('first', 'renamed', 'tv.A');
            suite.check('renaming keeps its place too', Object.keys(raw().aliases).join() === 'renamed,second,odd,last');
            await db.change('odd', null);
            suite.check('deleting removes that one only', Object.keys(raw().aliases).join() === 'renamed,second,last');
            suite.check('and leaves no temporary file behind', fs.readdirSync(dir).join() === 'show-aliases.json');
            let err = null;
            try { await db.change('nope', null); } catch (e) { err = e; }
            suite.check('a nickname that is not there is refused', err !== null && /not a nickname/.test(err.message));
            err = null;
            const before = fs.readFileSync(file, 'utf8');
            try { await db.change('second', 'last', 'tv.A'); } catch (e) { err = e; }
            suite.check('a new text that is already another nickname is refused, and nothing is written', err !== null && /already a nickname/.test(err.message) && fs.readFileSync(file, 'utf8') === before);
            write('{ this is not json');
            err = null;
            try { await db.change('second', null); } catch (e) { err = e; }
            suite.check('a file that is not valid JSON is refused, saying so, and left exactly as it is', err !== null && /could not be read as JSON/.test(err.message) && fs.readFileSync(file, 'utf8') === '{ this is not json');
            fs.unlinkSync(file);
            err = null;
            try { await db.change('second', null); } catch (e) { err = e; }
            suite.check('no file is no nickname to change, and none is created', err !== null && ! fs.existsSync(file));
            suite.check('the reader still drops what it cannot use, and reads what the writer wrote',
                await (async () => { write(JSON.stringify({ aliases: { good: S345, odd: { show: 'tv.A', seasons: [5, 3] } } })); await db.change('good', 'better', CCR); const l = await db.load(); return Object.keys(l).join() === 'better' && JSON.stringify(l.better) === JSON.stringify(CCR); })());
        } finally {
            removeDir(dir);
        }
    }

    // ---- the service and the routes, against real files ----------------------------------------
    {
        const dir = tempDir();
        const fillerDir = path.join(dir, 'filler');
        fs.mkdirSync(fillerDir);
        try {
            const listA = { name: 'Toonami Show Intros', mode: 'custom', rank: 0, content: [
                { title: 'Toonami - Justice League Unlimited Short Intro (4K HD)', duration: 7000, key: '/1', serverKey: 'srv', names: [S3] },
                { title: 'Justice League Unlimited Promo', duration: 28000, key: '/2', serverKey: 'srv' },
                { title: 'Justice League Unlimited Promo [2005]', duration: 28000, key: '/3', serverKey: 'srv', names: [] },
                { title: 'Unlimited Power', duration: 28000, key: '/4', serverKey: 'srv' },
                { title: 'Unlimited Fun Facts', duration: 28000, key: '/5', serverKey: 'srv', names: [HANNAH] },
                { title: 'Christy Romano Wand ID', duration: 10000, key: '/6', serverKey: 'srv' },
            ] };
            fs.writeFileSync(path.join(fillerDir, 'a.json'), JSON.stringify(listA));
            fs.writeFileSync(path.join(dir, 'show-aliases.json'), JSON.stringify({ aliases: { unlimited: S3, 'christy romano': CCR } }, null, 2));
            const fillerFile = path.join(fillerDir, 'a.json');
            const aliasFile = path.join(dir, 'show-aliases.json');
            const fillerDB = new FillerDB(fillerDir);
            let fillerWrites = 0;
            const realSave = fillerDB.saveFiller.bind(fillerDB);
            fillerDB.saveFiller = (...args) => { fillerWrites++; return realSave(...args); };
            const aliasDB = new ShowAliasDB(dir);
            const channelService = { getAllChannelNumbers: async () => [1], getChannel: async () => CHANNELS[0] };
            const customShowDB = { getAllShowsInfo: async () => [], getAllShows: async () => [] };
            const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);
            const fillerBefore = sha(fillerFile);
            const aliasBefore = sha(aliasFile);

            const page = await service.nicknames();
            suite.check('the page lists the nicknames with what they mean, and offers shows and custom shows to pick from, never a movie',
                page.nicknames.map( (n) => n.alias ).join() === 'christy romano,unlimited' && page.nicknames[1].label === 'Justice League · Season 3'
                && page.shows.some( (s) => s.key === JL && s.name === 'Justice League' ) && page.shows.every( (s) => /^(tv|custom)\./.test(s.key) ) && page.showNames[JL] === 'Justice League');
            const del = await service.previewNickname({ alias: 'unlimited', remove: true });
            suite.check('the preview of a delete lists the clips whose suggestion would change, in words, and counts the clips that keep their names',
                del.ok === true && del.remove === true && del.was === 'Justice League · Season 3' && del.changed === 2
                && del.changes.find( (c) => c.index === 1 ).before === 'Justice League · Season 3' && del.changes.find( (c) => c.index === 1 ).after === 'Justice League'
                && del.changes.find( (c) => c.index === 3 ).after === 'no suggestion' && del.changes[0].listName === 'Toonami Show Intros' && del.kept === 3, JSON.stringify(del));
            const edit = await service.previewNickname({ alias: 'unlimited', newAlias: 'Justice League Unlimited', showKey: JL, seasons: [3, 4, 5] });
            suite.check('the preview of an edit says what it would mean, and which clips read differently',
                edit.ok === true && edit.meaning === 'Justice League · Seasons 3–5' && edit.newAlias === 'justice league unlimited'
                && edit.changes.find( (c) => c.index === 1 ).after === 'Justice League · Seasons 3–5', JSON.stringify(edit));
            const anyOf = await service.previewNickname({ alias: 'unlimited', anyOf: [JL, HANNAH] });
            suite.check('and one for any of two shows', anyOf.ok === true && anyOf.meaning === 'Justice League or Hannah Montana');
            const none = await service.previewNickname({ alias: 'unlimited', showKey: '' });
            suite.check('no show picked is a problem, not a crash', none.ok === false && /Pick the show/.test(none.problems.join(' ')));
            suite.check('previewing wrote nothing: not a clip, not the alias file, and no list was saved',
                sha(fillerFile) === fillerBefore && sha(aliasFile) === aliasBefore && fillerWrites === 0);

            const refused = async (body) => { try { await service.saveNickname(body); return null; } catch (err) { return err; } };
            const refusals = await Promise.all([ { alias: 'nope', remove: true }, { alias: 'unlimited', newAlias: 'promo' }, { alias: 'unlimited', showKey: 'tv.Nope' },
                { alias: 'unlimited', newAlias: 'christy romano' }, { alias: 'unlimited' } ].map(refused));
            suite.check('an edit that cannot be made is refused, with the reason, whichever way it arrives',
                refusals.every( (e) => e instanceof ShowMatchService.ReviewError ) && /everyday words/.test(refusals[1].message) && /already means/.test(refusals[3].message), refusals.map( (e) => e && e.message ).join(' | '));
            suite.check('and a refused save wrote nothing', sha(fillerFile) === fillerBefore && sha(aliasFile) === aliasBefore);

            const edited = await service.saveNickname({ alias: 'unlimited', newAlias: 'Justice League Unlimited', showKey: JL, seasons: [3, 4, 5] });
            const stored = JSON.parse(fs.readFileSync(aliasFile, 'utf8')).aliases;
            suite.check('an edit changes the nickname in the alias file, nothing else there',
                Object.keys(stored).join() === 'justice league unlimited,christy romano' && JSON.stringify(stored['justice league unlimited']) === JSON.stringify(S345) && stored['christy romano'].anyOf.length === 2);
            suite.check('and answers with the list as it now reads', edited.nicknames.map( (n) => n.alias ).join() === 'christy romano,justice league unlimited' && edited.nicknames[1].label === 'Justice League · Seasons 3–5');
            suite.check('no name saved on a clip was rewritten: the list file is byte for byte as it was, and no list was saved',
                sha(fillerFile) === fillerBefore && fillerWrites === 0);
            const match = await service.matchFiller('a');
            suite.check('the clips with names saved keep exactly them, the one with a name saved under another show too',
                JSON.stringify(match.clips[0].names) === JSON.stringify([S3]) && JSON.stringify(match.clips[4].names) === JSON.stringify([HANNAH]) && match.clips[2].reviewed === true);
            suite.check('and the unsaved clip is now suggested as the new nickname says',
                clipNames.sameName(match.clips[1].proposal.names[0], S345) && match.clips[3].proposal.names.length === 0);

            const deleted = await service.saveNickname({ alias: 'christy romano', remove: true });
            suite.check('a delete removes the nickname, answers with the list, and still writes no clip',
                deleted.nicknames.map( (n) => n.alias ).join() === 'justice league unlimited' && sha(fillerFile) === fillerBefore && fillerWrites === 0
                && ! Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(aliasFile, 'utf8')).aliases, 'christy romano'));

            // the routes
            const app = express();
            app.use(express.json());
            app.use(api.router({}, channelService, fillerDB, customShowDB, null, null, null, null, null, null, null, null, null, service));
            const server = await new Promise( (resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); } );
            try {
                const call = (method, p, body) => new Promise( (resolve, reject) => {
                    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
                        let text = '';
                        res.on('data', (d) => { text += d; });
                        res.on('end', () => resolve({ status: res.statusCode, text }));
                    });
                    req.on('error', reject);
                    req.end(body === undefined ? undefined : JSON.stringify(body));
                } );
                const got = await call('GET', '/api/nicknames');
                suite.check('GET /api/nicknames lists them', got.status === 200 && JSON.parse(got.text).nicknames.length === 1 && JSON.parse(got.text).nicknames[0].alias === 'justice league unlimited', got.text.slice(0, 100));
                const pre = await call('POST', '/api/nicknames/preview', { alias: 'justice league unlimited', remove: true });
                suite.check('POST preview answers and writes nothing', pre.status === 200 && JSON.parse(pre.text).ok === true && JSON.parse(pre.text).changed >= 1 && sha(aliasFile) !== undefined
                    && Object.keys(JSON.parse(fs.readFileSync(aliasFile, 'utf8')).aliases).length === 1);
                const bad = await call('POST', '/api/nicknames/save', { alias: 'justice league unlimited', newAlias: 'promo' });
                suite.check('POST save refuses with 400 and what to say', bad.status === 400 && /everyday words/.test(JSON.parse(bad.text).error), bad.text.slice(0, 120));
                const ok = await call('POST', '/api/nicknames/save', { alias: 'justice league unlimited', showKey: JL, season: 3 });
                suite.check('POST save edits one, answering with the list',
                    ok.status === 200 && JSON.parse(ok.text).nicknames[0].label === 'Justice League · Season 3'
                    && sha(fillerFile) === fillerBefore && fillerWrites === 0);
                const gone = await call('POST', '/api/nicknames/save', { alias: 'justice league unlimited', remove: true });
                suite.check('POST save deletes one', gone.status === 200 && JSON.parse(gone.text).nicknames.length === 0);
                suite.check('and one that is gone is refused', (await call('POST', '/api/nicknames/save', { alias: 'justice league unlimited', remove: true })).status === 400);
            } finally {
                server.close();
            }
        } finally {
            removeDir(dir);
        }
    }

    return suite;
};

if (require.main === module) {
    module.exports().then( (suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    } );
}
