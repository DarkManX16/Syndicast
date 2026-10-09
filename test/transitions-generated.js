/*
 * Generated cards in a break's plan (src/transitions.js, kind 'generated'). See
 * docs/blocks-spec.md, Stage 5, "Generated cards".
 *
 * The fixture is the Cartoon Theatre shape in miniature: a block airing only
 * Monday 10-11am, opening with a movie; the break after it leaves the block,
 * and the block's next airing, a week on, opens with another movie. The
 * block's Leaving row has the real Next Time step (a list keyed on later) and a
 * card step marked to play only if that one found nothing.
 */
const { MIN, HOUR, at, flex, mix, Suite } = require('./support');
const transitions = require('../src/transitions');

function movie(title, mins) {
    return { title, key: `/m/${title}`, ratingKey: title.length, type: 'movie', duration: mins * MIN, serverKey: 'srv' };
}
function episode(show, n, mins) {
    return { title: `${show} ${n}`, key: `/e/${show}${n}`, type: 'episode', showTitle: show,
        season: 1, episode: n, duration: mins * MIN, serverKey: 'srv' };
}
function clipOf(title, secs, names) {
    return { title, key: '/c/' + title, duration: secs * 1000, serverKey: 'srv', names: names };
}

const MON = at('2026-10-05T10:00:00');
const CARD = { file: 'C:/data/generated/cards/abc.ts', key: 'abc', title: 'Next Time card: Gamma', durationMs: 15070,
    streamStats: { videoWidth: 1920, videoHeight: 1080 } };

function channelWith(leavingOut) {
    const progs = [movie('Alpha', 60), flex(5), episode('Beta', 1, 30), flex(9985), movie('Gamma', 30)];
    return {
        number: 18, name: 'Cards', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
        dayParts: [{ id: 'd', name: 'D', fillerCollections: mix([['A', 100]]), starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] }],
        blocks: [{ id: 'ct', name: 'Cartoon Theatre', fillerCollections: mix([['B', 100]]),
            airings: [{ days: [1], start: 10 * HOUR, end: 11 * HOUR }],
            transitions: { leaving: { out: leavingOut, in: [] } } }],
        programs: progs, duration: progs.reduce((a, p) => a + p.duration, 0), startTime: new Date(MON).toISOString(),
    };
}

const nextTime = { id: 'nt', kind: 'list', listId: 'NT', match: 'show', keyedOn: 'later' };
const card = (extra) => Object.assign({ id: 'card', kind: 'generated', templateId: 'tpl', keyedOn: 'later', onlyIfNoMatch: 'nt' }, extra || {});

module.exports = async () => {
    const suite = new Suite('generated cards in plans');

    const run = (steps, lists, ready) => {
        const channel = channelWith(steps);
        const brk = transitions.findBreak(channel, 1, MON + 60 * MIN);
        const wants = [];
        const env = { getList: (id) => (lists[id] || null) };
        if (ready !== undefined) {
            env.card = (want) => {
                wants.push(want);
                return ready ? CARD : null;
            };
        }
        return { plan: transitions.buildPlan(channel, brk, env), wants: wants, brk: brk };
    };
    const noRealClip = { NT: [clipOf('Next Time: Delta', 15, ['movie.Delta'])] };
    const realClip = { NT: [clipOf('Next Time: Gamma', 15, ['movie.Gamma'])] };

    {
        const { plan, wants, brk } = run([nextTime, card()], noRealClip, true);
        suite.check('no real Next Time clip for next week\'s movie: the card plays',
            (plan.out.length === 1) && (plan.out[0].kind === 'generated') && (plan.out[0].stepId === 'card'), JSON.stringify(plan.out));
        suite.check('... for its rendered length, which the break makes room for',
            (plan.out[0].durationMs === 15070) && (plan.outMs === 15070));
        suite.check('... and plays like a clip: its file, a key of its own, its title',
            (plan.out[0].clip.generatedFile === CARD.file) && (plan.out[0].clip.key === 'card|abc')
            && (plan.out[0].clip.title === CARD.title) && (plan.out[0].clip.duration === 15070)
            && (plan.out[0].clip.streamStats.videoWidth === 1920));
        const w = wants[0];
        suite.check('the card asked for is next week\'s movie, the template, and when it airs',
            (wants.length === 1) && (w.program.title === 'Gamma') && (w.templateId === 'tpl') && (w.keyedOn === 'later')
            && (w.stepId === 'card') && (w.airStart === MON + 7 * 24 * HOUR) && (w.breakStart === brk.startTime)
            && (w.channelNumber === 18), JSON.stringify(Object.assign({}, w, { program: w && w.program.title })));
    }
    {
        const { plan, wants } = run([nextTime, card()], realClip, true);
        suite.check('a real clip for next week\'s movie wins: it plays and the card stays out',
            (plan.out.length === 1) && (plan.out[0].clip.title === 'Next Time: Gamma')
            && plan.skipped.some( (s) => (s.stepId === 'card') && (s.problem === false) ), JSON.stringify(plan.skipped));
        suite.check('... and no card is even asked for, so none is rendered', wants.length === 0);
    }
    {
        const { plan } = run([nextTime, card()], noRealClip, false);
        suite.check('a card not rendered yet is skipped, never waited for, and the break keeps its time for commercials',
            (plan.out.length === 0) && (plan.outMs === 0)
            && plan.skipped.some( (s) => (s.stepId === 'card') && (s.problem === true) && /not rendered yet/.test(s.reason) ), JSON.stringify(plan.skipped));
        suite.check('... with a note in the log', plan.notes.some( (n) => /not rendered yet/.test(n) ), plan.notes.join(' | '));
    }
    {
        const { plan } = run([nextTime, card()], noRealClip, undefined);
        suite.check('with nothing to ask for cards (a preview, a test), the card step is skipped the same way',
            (plan.out.length === 0) && plan.skipped.some( (s) => (s.stepId === 'card') && /not rendered yet/.test(s.reason) ));
    }
    {
        const { plan, wants } = run([nextTime, card({ days: [6] })], noRealClip, true);
        suite.check('a card limited to other days stays out, and is not asked for',
            (plan.out.length === 0) && (wants.length === 0));
    }
    {
        const { plan, wants, brk } = run([card({ id: 'next', keyedOn: 'next', onlyIfNoMatch: null })], {}, true);
        suite.check('a card keyed on the show coming up asks for that show, airing right after the break',
            (plan.out.length === 1) && (wants[0].program.title === 'Beta 1') && (wants[0].airStart === brk.next.startTime));
    }
    {
        const { plan, wants } = run([card({ templateId: '', onlyIfNoMatch: null })], {}, true);
        suite.check('a card step with no template is skipped as a problem, and asks for nothing',
            (plan.out.length === 0) && (wants.length === 0) && (plan.notes.length === 1) && /template/.test(plan.notes[0]), plan.notes.join(' | '));
    }
    {
        // The card step here is itself unconditional (onlyIfNoMatch: null), so
        // watchProblem does not reject `closing` for watching a conditional step -
        // that would make `closing` skip as a problem before ever asking whether the
        // card played, which is exactly the bug a looser fixture here would hide.
        const plainCard = card({ onlyIfNoMatch: null });
        const closing = { id: 'closing', kind: 'list', listId: 'CL', match: 'any', onlyIfNoMatch: 'card' };
        const lists = Object.assign({ CL: [clipOf('Closing', 10)] }, noRealClip);
        const ready = run([plainCard, closing], lists, true);
        suite.check('a card that plays counts as found: a step watching it stays out',
            (ready.plan.out.length === 1) && (ready.plan.out[0].kind === 'generated'),
            ready.plan.out.map( (s) => s.clip.title ).join(', '));
        const unready = run([plainCard, closing], lists, false);
        suite.check('... and when the card step finds nothing (not rendered yet), the step watching it plays',
            (unready.plan.out.length === 1) && (unready.plan.out[0].clip.title === 'Closing'),
            unready.plan.out.map( (s) => s.clip.title ).join(', '));
    }
    {
        const channel = channelWith([]);
        const brk = transitions.findBreak(channel, 1, MON + 60 * MIN);
        const airing = transitions.laterAiring(channel, brk, channel.blocks[0]);
        suite.check('laterAiring gives the program and when it starts',
            (airing.program.title === 'Gamma') && (airing.startTime === MON + 7 * 24 * HOUR));
        suite.check('laterProgram is still its program', transitions.laterProgram(channel, brk, channel.blocks[0]) === airing.program);
    }
    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
