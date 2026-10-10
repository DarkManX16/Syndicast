/*
 * src/shuffle-rounds.js: rounds for Shuffle, Rerun and Ordered shuffle. A
 * round's order is a hash of the position, the round and each story's file,
 * so it doesn't move when the episode count does; whatever aired in the later
 * half of a round goes after everything else in the next; and a round carried
 * over from the old shuffler finishes in its old order. See NOTES.md, Known
 * issues, "Per-position stored progress, and the shuffles built on it".
 */
const { MIN, Suite } = require('./support');
const rounds = require('../src/shuffle-rounds');
const multiPart = require('../src/multi-part');

function ep(show, season, episode, title) {
    return {
        type: 'episode', showTitle: show, title: title || `${show} S${season}E${episode}`, season, episode,
        duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${episode}`,
    };
}
const keyOf = (p) => p.serverKey + '|' + p.key;
const refOf = (p) => ({ key: keyOf(p), order: p.season * 1000000 + p.episode });
const many = (show, seasons, per) => {
    const out = [];
    for (let s = 1; s <= seasons; s++) for (let e = 1; e <= per; e++) out.push(ep(show, s, e));
    return out;
};
// The next `count` airings of a player, as program titles with their rounds.
function play(player, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const c = player.current();
        out.push({ title: c.program.title, round: c.round, key: keyOf(c.program) });
        player.next();
    }
    return out;
}

module.exports = async function () {
    const suite = new Suite('shuffle-rounds');

    suite.log('-- hashing --');
    suite.check('hash32 is FNV-1a', rounds.hash32('') === 2166136261 && rounds.hash32('a') === 0xe40c292c,
        rounds.hash32('a').toString(16));

    suite.log('-- rounds --');
    {
        const stories = multiPart.stories(many('Doug', 2, 10));
        const p = rounds.player({ seed: 'K', stories, record: { round: 0 } });
        const aired = play(p, 100);
        let everyOnce = true;
        for (let r = 0; r < 5; r++) {
            const block = aired.slice(r * 20, r * 20 + 20);
            everyOnce = everyOnce && new Set(block.map((a) => a.key)).size === 20 && block.every((a) => a.round === r);
        }
        suite.check('each round airs every story once', everyOnce);
        suite.check('...in a different order each round', aired.slice(0, 20).map((a) => a.key).join() !== aired.slice(20, 40).map((a) => a.key).join());

        const longer = play(rounds.player({ seed: 'K', stories, record: { round: 0 } }), 20 * 20);
        const last = new Map();
        let closest = Infinity;
        longer.forEach((a, i) => {
            if (last.has(a.key)) closest = Math.min(closest, i - last.get(a.key) - 1);
            last.set(a.key, i);
        });
        suite.check('none back within half a round over 20 rounds', closest >= 10, `closest: ${closest} stories between`);
    }
    {
        const base = many('Doug', 1, 12);
        const order = rounds.roundOrder({ seed: 'K', round: 3, stories: multiPart.stories(base), laterHalf: new Set() });
        const added = ep('Doug', 1, 13);
        const withNew = rounds.roundOrder({ seed: 'K', round: 3, stories: multiPart.stories(base.concat([added])), laterHalf: new Set() });
        suite.check('adding an episode leaves the rest of the round in place',
            withNew.filter((s) => keyOf(s[0]) !== keyOf(added)).map((s) => keyOf(s[0])).join() === order.map((s) => keyOf(s[0])).join());

        const place = order[5][0];
        const newAt = withNew.findIndex((s) => keyOf(s[0]) === keyOf(added));
        const placeAt = withNew.findIndex((s) => keyOf(s[0]) === keyOf(place));
        const rest = play(rounds.player({ seed: 'K', stories: multiPart.stories(base.concat([added])), record: { round: 3, next: refOf(place), deferred: [] } }), 12);
        const thisRound = rest.filter((a) => a.round === 3).map((a) => a.key);
        suite.check('...and the new one airs this round only if its turn is still ahead',
            thisRound.includes(keyOf(added)) === (newAt > placeAt)
                && thisRound.filter((k) => k !== keyOf(added)).join() === order.slice(5).map((s) => keyOf(s[0])).join(),
            `new at ${newAt}, place at ${placeAt}`);
    }
    {
        const all = many('Kim Possible', 2, 8);
        const order = rounds.roundOrder({ seed: 'K', round: 1, stories: multiPart.stories(all), laterHalf: new Set() });
        const place = order[6][0];
        const seasonTwo = all.filter((p) => p.season === 2);
        const rest = play(rounds.player({ seed: 'K', stories: multiPart.stories(seasonTwo), record: { round: 1, next: refOf(place), deferred: [] } }), 8);
        const thisRound = rest.filter((a) => a.round === 1).map((a) => a.key);
        const expected = order.slice(6).map((s) => keyOf(s[0])).filter((k) => seasonTwo.some((p) => keyOf(p) === k));
        const airedAlready = order.slice(0, 6).map((s) => keyOf(s[0]));
        suite.check('excluding a season mid-round reshows nothing early',
            thisRound.join() === expected.join() && !thisRound.some((k) => airedAlready.includes(k)),
            thisRound.length + ' left this round');
    }
    {
        const titles = ['Judging Omi (1)', 'Saving Omi (2)', 'Finding Omi (3)', 'Dojo Def', 'Deadomutt (1)', 'Deadomutt (2)', 'Bird Brained'];
        const programs = titles.map((t, i) => ep('Show', 1, i + 1, t));
        const aired = play(rounds.player({ seed: 'S', stories: multiPart.stories(programs), record: { round: 0 } }), 7 * 4);
        let together = true;
        aired.forEach((a, i) => {
            if (a.title === 'Judging Omi (1)') together = together && aired[i + 1].title === 'Saving Omi (2)' && aired[i + 2].title === 'Finding Omi (3)';
            if (a.title === 'Deadomutt (1)') together = together && aired[i + 1].title === 'Deadomutt (2)';
        });
        suite.check('a story\'s parts are consecutive airings of the position', together && aired.length === 28);
    }

    suite.log('-- carried rounds --');
    {
        // blocks' getShowShuffler for these seven episodes, started at each position 0-20.
        const OLD = [1, 3, 2, 7, 4, 6, 5, 2, 1, 7, 5, 3, 6, 4, 1, 2, 7, 3, 6, 4, 5];
        const doug = [1, 2, 3, 4, 5, 6, 7].map((e) => ep('Doug', 1, e));
        const got = [];
        for (let pos = 0; pos <= 20; pos++) {
            got.push(rounds.legacyRound(doug, 'tv.Doug', Math.floor(pos / 7))[pos % 7].episode);
        }
        suite.check('legacyRound reproduces the old shuffler', got.join() === OLD.join(), got.join());

        // blocks' getShowShuffler started at 0 and moved on through positions 0-20:
        // having started in generation 0, it shuffled its base list twice.
        const ADVANCED = [1, 3, 2, 7, 4, 6, 5, 2, 1, 3, 6, 7, 4, 5, 1, 2, 3, 7, 4, 5, 6];
        const moved = [];
        for (let pos = 0; pos <= 20; pos++) {
            moved.push(rounds.legacyRound(doug, 'tv.Doug', Math.floor(pos / 7), 0)[pos % 7].episode);
        }
        suite.check('...and one that started in generation 0 and moved on', moved.join() === ADVANCED.join(), moved.join());

        const orderOf = (p) => p.season * 1000000 + p.episode;
        const fromMoved = rounds.legacyCarry(doug, 'tv.Doug', 9, orderOf, doug[2]);
        const fromHere = rounds.legacyCarry(doug, 'tv.Doug', 9, orderOf, doug[6]);
        suite.check('legacyCarry finishes the round the airing it starts from belongs to',
            fromMoved.queue.map((r) => r.order % 100).join() === '3,6,7,4,5' && fromHere.queue.map((r) => r.order % 100).join() === '7,5,3,6,4',
            fromMoved.queue.map((r) => r.order % 100).join() + ' / ' + fromHere.queue.map((r) => r.order % 100).join());

        const queue = [doug[4], doug[1], doug[6]].map(refOf);
        const carried = play(rounds.player({ seed: 'K', stories: multiPart.stories(doug), record: { round: 2, queue, laterHalf: [keyOf(doug[1])] } }), 10);
        suite.check('a carried queue plays first, in order',
            carried.slice(0, 3).map((a) => a.title).join() === 'Doug S1E5,Doug S1E2,Doug S1E7'
                && carried.slice(0, 3).every((a) => a.round === 2) && carried[3].round === 3,
            carried.slice(0, 4).map((a) => a.title + '@' + a.round).join());
        suite.check('...then the next round, with the carried later half last',
            carried.slice(3, 10).map((a) => a.key).indexOf(keyOf(doug[1])) === 6);

        const gone = play(rounds.player({ seed: 'K', stories: multiPart.stories(doug.filter((p) => p.episode !== 2)),
            record: { round: 2, queue, laterHalf: [] } }), 2);
        suite.check('...skipping an entry no longer in range', gone.map((a) => a.title).join() === 'Doug S1E5,Doug S1E7');
    }

    return suite;
};
