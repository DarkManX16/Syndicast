/*
 * src/swap-read.js: what the Swap and Insert dialog does when it cannot read a
 * show - "This show", "Other shows on this channel" and "Custom shows" - and
 * says why in plain words. Ron, Oct 16: on a preview whose server was no longer
 * running, This show and Custom shows both said "Something went wrong reading
 * that show." and listed nothing.
 */
const { Suite } = require('./support');
const swapRead = require('../src/swap-read');

const episode = (n, extra) => Object.assign({ type: 'episode', showTitle: 'House of Mouse', title: `Ep ${n}`, duration: 22 * 60000, key: `/e/${n}`, ratingKey: String(n) }, extra || {});
const customItem = (id, name, i, extra) => Object.assign({ type: 'movie', title: `${name} ${i}`, duration: 80 * 60000, key: `/c/${id}/${i}`, customShowId: id, customShowName: name, customOrder: i }, extra || {});

// What angular's $http rejects with when the server is not there, and when it answers badly.
const serverGone = { status: -1, statusText: '', data: null, config: { url: '/api/catalogs/read' } };
const serverError = { status: 500, statusText: 'Internal Server Error', data: 'EMFILE: too many open files', config: {} };

module.exports = async function () {
    const suite = new Suite('swap-read');

    suite.log('-- the reason, in plain words --');
    {
        const gone = swapRead.explain(serverGone);
        suite.check('a request the server never answered says the server did not answer, and what to do',
            /server didn't answer/.test(gone) && /running/.test(gone) && ! /undefined|null|\[object/.test(gone), gone);
        const bad = swapRead.explain(serverError);
        suite.check('a server error says so, with its status and what it said',
            /error/.test(bad) && /500/.test(bad) && /too many open files/.test(bad), bad);
        suite.check('a Plex server this data folder has no entry for says that, naming it',
            /Plex server "Thats So Disney" isn't set up/.test(swapRead.explain('no Plex server named "Thats So Disney"')),
            swapRead.explain('no Plex server named "Thats So Disney"'));
        suite.check('...and one with no name at all says the show has nothing in the lineup to find it by',
            /nothing in the lineup/.test(swapRead.explain('no Plex server named "undefined"')), swapRead.explain('no Plex server named "undefined"'));
        suite.check('Plex not answering says Plex, not the server',
            /Plex/.test(swapRead.explain('Plex unreachable: connect ECONNREFUSED 127.0.0.1:32400')) && ! /server didn't answer/.test(swapRead.explain('Plex unreachable: connect ECONNREFUSED 127.0.0.1:32400')),
            swapRead.explain('Plex unreachable: connect ECONNREFUSED 127.0.0.1:32400'));
        suite.check('a plain Error keeps its message, and nothing at all is still a sentence',
            swapRead.explain(new Error('custom show not found')) === 'custom show not found' && swapRead.explain(undefined).length > 10);
    }

    suite.log('-- This show, and Other shows on this channel --');
    {
        const held = [ episode(1), episode(2), episode(3) ];
        const dead = await swapRead.readShow({ read: async () => { throw serverGone; }, showId: 'tv.House of Mouse', title: 'House of Mouse', lineupItems: held });
        suite.check('a server that does not answer still offers the episodes the lineup holds, and says why',
            dead.items === held && /House of Mouse/.test(dead.notice) && /server didn't answer/.test(dead.notice) && /3 episodes already in the lineup/.test(dead.notice)
                && ! /Something went wrong/.test(dead.notice), dead.notice);
        const refused = await swapRead.readShow({ read: async () => { throw serverError; }, showId: 'tv.House of Mouse', title: 'House of Mouse', lineupItems: held });
        suite.check('...and so does a server error', refused.items === held && /500/.test(refused.notice), refused.notice);
        const perShow = await swapRead.readShow({ read: async () => ({ 'tv.House of Mouse': { error: 'no Plex server named "Nope"' } }), showId: 'tv.House of Mouse', title: 'House of Mouse', lineupItems: held });
        suite.check('...and a show the server could not read, as before, in the same words',
            perShow.items === held && /Plex server "Nope" isn't set up/.test(perShow.notice) && /3 episodes already/.test(perShow.notice), perShow.notice);
        const nothing = await swapRead.readShow({ read: async () => { throw serverGone; }, showId: 'tv.House of Mouse', title: 'House of Mouse', lineupItems: [] });
        suite.check('...and when the lineup holds none of it, it says so rather than offering nothing silently',
            nothing.items.length === 0 && /lineup holds none/.test(nothing.notice), nothing.notice);
        const fine = await swapRead.readShow({ read: async () => ({ 'tv.House of Mouse': { items: [ episode(9) ] } }), showId: 'tv.House of Mouse', title: 'House of Mouse', lineupItems: held });
        suite.check('a show that is read is its full catalog, with no notice', fine.items.length === 1 && fine.items[0].title === 'Ep 9' && fine.notice === '');
        const odd = await swapRead.readShow({ read: async () => ({}), showId: 'tv.House of Mouse', title: 'House of Mouse', lineupItems: held });
        suite.check('...and an answer without the show is a failure too', odd.items === held && odd.notice !== '', odd.notice);
    }

    suite.log('-- Custom shows --');
    {
        const lineup = [
            episode(1), customItem('a1', 'Friday DCOM Movies', 0), customItem('a1', 'Friday DCOM Movies', 1),
            customItem('a1', 'Friday DCOM Movies', 1), customItem('b2', 'Silly Symphonies', 0), { isOffline: true, duration: 1000 },
        ];
        const shows = swapRead.customShowsIn(lineup);
        suite.check('the custom shows the lineup holds are listed by name, once each',
            shows.length === 2 && shows[0].name === 'Friday DCOM Movies' && shows[0].id === 'a1' && shows[1].id === 'b2', JSON.stringify(shows));
        suite.check('...and a custom show\'s items in the lineup are once each, in the show\'s order',
            swapRead.customItemsIn(lineup, 'a1').map((p) => p.customOrder).join() === '0,1');

        const list = await swapRead.readCustomShows({ list: async () => { throw serverGone; }, programs: lineup });
        suite.check('a list the server will not give falls back to the custom shows in the lineup, and says why',
            list.shows.length === 2 && /server didn't answer/.test(list.notice) && /custom shows already in the lineup/.test(list.notice), list.notice);
        const listed = await swapRead.readCustomShows({ list: async () => [ { id: 'z', name: 'Zorro' }, { id: 'a', name: 'Alpha' } ], programs: lineup });
        suite.check('...and a list that comes is sorted by name, with no notice',
            listed.shows.map((s) => s.name).join() === 'Alpha,Zorro' && listed.notice === '');

        const item = await swapRead.readCustomItems({ get: async () => { throw serverError; }, id: 'a1', name: 'Friday DCOM Movies', programs: lineup });
        suite.check('a custom show the server will not give falls back to its items in the lineup, and says why',
            item.items.length === 2 && /500/.test(item.notice) && /2 items already in the lineup/.test(item.notice), item.notice);
        const got = await swapRead.readCustomItems({ get: async () => ({ name: 'Friday DCOM Movies', content: [ { title: 'A', duration: 1000 }, { title: 'B', duration: 1000 }, { title: 'C', duration: 1000 } ] }),
            id: 'a1', name: 'Friday DCOM Movies', programs: lineup });
        suite.check('...and one that is given is the whole show, in its order, with no notice',
            got.items.length === 3 && got.items[2].customOrder === 2 && got.items[0].customShowId === 'a1' && got.notice === '');
        const none = await swapRead.readCustomItems({ get: async () => { throw serverGone; }, id: 'q', name: 'Quiet', programs: lineup });
        suite.check('...and one the lineup does not hold says so', none.items.length === 0 && /lineup holds none/.test(none.notice), none.notice);
    }

    return suite;
};
