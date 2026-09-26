/*
 * The channel editor rewrites `startTime` every time a channel is loaded into
 * it, so a plain reload-and-resave with no edits changes the field. That looked
 * like the cause of a live channel's stream jumping when it was saved, since
 * `startTime` is what decides which program is playing now.
 *
 * It is not. `adjustStartTimeToCurrentProgram` rotates `channel.programs` so the
 * program playing now sits at index 0 and moves `startTime` back by the offset
 * into it, in the same breath. On a cyclic lineup those two cancel exactly: the
 * field's value changes, its meaning does not. This file is the check that they
 * keep cancelling.
 *
 * The two editor functions are lifted out of web/directives/channel-config.js by
 * name and brace-matching, and the two save-path ones out of
 * src/services/channel-service.js the same way, rather than transcribed here -
 * a transcription would go stale silently, and these are the functions whose
 * agreement is the whole point. Extraction failing is a loud FAIL, not a skip.
 *
 * Run against the committed fixture by default. Pass channel JSON paths to run
 * it against real channels too:
 *
 *     node test/startTime-rotation.js .dizquetv-dev/channels/2.json
 */
const fs = require('fs');
const path = require('path');
const { helperFuncs, Suite, show, flex, MIN, HOUR } = require('./support');

const ROOT = path.join(__dirname, '..');

/*
 * Pulls one top-level function out of a source file by brace-matching from its
 * declaration, so this survives edits above or below it in the file.
 */
function liftSource(file, name) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const decl = src.indexOf(`function ${name}(`);
    if (decl === -1) {
        throw new Error(`${file} no longer declares ${name}`);
    }
    let i = src.indexOf('{', decl);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                return src.slice(decl, i + 1);
            }
        }
    }
    throw new Error(`${file}'s ${name} has unbalanced braces`);
}

// The editor's two functions run against a `scope`; give them one.
const editorSrc = [
    liftSource('web/directives/channel-config.js', 'adjustStartTimeToCurrentProgram'),
    liftSource('web/directives/channel-config.js', 'updateChannelDuration'),
].join('\n\n');
// eslint-disable-next-line no-new-func
const runEditorLoad = new Function('scope', editorSrc
    + '\nadjustStartTimeToCurrentProgram();\nupdateChannelDuration();');

const saveSrc = [
    liftSource('src/services/channel-service.js', 'cleanUpProgram'),
    liftSource('src/services/channel-service.js', 'cleanUpChannel'),
].join('\n\n');
// eslint-disable-next-line no-new-func
const runCleanUpChannel = new Function('channel', saveSrc + '\nreturn cleanUpChannel(channel);');

// What web/controllers/channels.js does when it opens a channel in the editor,
// then what the editor does to it on load.
function loadIntoEditor(raw) {
    const ch = JSON.parse(JSON.stringify(raw));
    ch.startTime = new Date(ch.startTime);
    if (typeof (ch.onDemand) === 'undefined') {
        ch.onDemand = {};
    }
    if (typeof (ch.onDemand.isOnDemand) !== 'boolean') {
        ch.onDemand.isOnDemand = false;
    }
    const scope = { channel: ch, maxSize: 0, fixedOnDemand: false };
    runEditorLoad(scope);
    return scope.channel;
}

// angular.toJson -> PUT /api/channel -> cleanUpChannel, with no edits in between.
function resave(editorChannel) {
    const body = JSON.parse(JSON.stringify(editorChannel));
    if (typeof (body.fallback) === 'undefined') {
        body.fallback = [];
    }
    return runCleanUpChannel(body);
}

// A program's identity, independent of where it sits in the array.
function identify(program) {
    return program.isOffline
        ? `offline:${program.duration}`
        : `${program.serverKey}|${program.key || program.file || program.title}`;
}

function positionAt(t, channel) {
    const r = helperFuncs.getCurrentProgramAndTimeElapsed(t, channel);
    return { elapsed: r.timeElapsed, id: identify(r.program), title: r.program.title };
}

/*
 * A channel whose lineup is deliberately uneven, so a rotation lands on a
 * different program depending on the instant rather than on a tidy grid.
 */
function fixtureChannel() {
    return {
        number: 77,
        name: 'Rotation Fixture',
        startTime: new Date(Date.now() - 3 * HOUR - 137000).toISOString(),
        duration: 0,
        programs: [
            show('Aqua Teen', 11), flex(3), show('Futurama', 22), flex(2),
            show('Inuyasha', 24), flex(6), show('Cowboy Bebop', 24), flex(1),
            show('Big O', 23), flex(4), show('Trigun', 22), flex(8),
        ],
        fallback: [],
        fillerCollections: [],
        offlineMode: 'pic',
        transcoding: {},
        onDemand: { isOnDemand: false },
    };
}

module.exports = async function run() {
    const suite = new Suite('startTime rotation');

    const extras = process.argv.slice(2);
    const subjects = [{ label: 'fixture', channel: fixtureChannel() }];
    for (const f of extras) {
        subjects.push({
            label: path.basename(f),
            channel: JSON.parse(fs.readFileSync(f, 'utf8')),
        });
    }

    const SAMPLES = 500;

    for (const { label, channel } of subjects) {
        // the streamer's view: straight off disk, before the editor touches it
        const before = JSON.parse(JSON.stringify(channel));
        before.duration = before.programs.reduce((a, p) => a + p.duration, 0);
        const after = resave(loadIntoEditor(channel));

        const movedBy = new Date(after.startTime).getTime() - new Date(before.startTime).getTime();
        suite.check(`${label}: the resave really does move startTime`,
            movedBy !== 0, `by ${movedBy}ms`);

        suite.check(`${label}: cycle length is unchanged`,
            after.duration === before.duration, `${before.duration} -> ${after.duration}`);

        suite.check(`${label}: no program is added or dropped`,
            after.programs.length === before.programs.length,
            `${before.programs.length} -> ${after.programs.length}`);

        // a rotation, not a reorder: same programs, same cyclic order
        const ids = (c) => c.programs.map(identify);
        const b = ids(before);
        const a = ids(after);
        let rotation = -1;
        for (let i = 0; i < b.length; i++) {
            if (b.slice(i).concat(b.slice(0, i)).join(',') === a.join(',')) {
                rotation = i;
                break;
            }
        }
        suite.check(`${label}: programs are rotated, not reordered`,
            rotation !== -1, rotation === -1 ? 'no rotation reproduces the new order' : `by ${rotation}`);

        /*
         * The point of the file. Sampling a whole cycle covers the editor having
         * been left open for any length of time before the save, because the
         * rotation is computed once at load and then has to hold at every later
         * instant, not just the one it was computed at.
         */
        const total = after.duration;
        const t0 = Date.now();
        let sameProgram = 0, sameElapsed = 0, worst = 0;
        const examples = [];
        for (let s = 0; s < SAMPLES; s++) {
            const t = t0 + Math.floor((s / SAMPLES) * total);
            const pb = positionAt(t, before);
            const pa = positionAt(t, after);
            if (pb.id === pa.id) {
                sameProgram++;
            } else if (examples.length < 3) {
                examples.push(`@+${t - t0}ms "${pb.title}" vs "${pa.title}"`);
            }
            const drift = pa.elapsed - pb.elapsed;
            if (drift === 0) {
                sameElapsed++;
            } else if (Math.abs(drift) > Math.abs(worst)) {
                worst = drift;
            }
        }
        suite.check(`${label}: same program at every instant`,
            sameProgram === SAMPLES, `${sameProgram}/${SAMPLES}`
            + (examples.length ? '   ' + examples.join('; ') : ''));
        suite.check(`${label}: same offset into it at every instant`,
            sameElapsed === SAMPLES, `${sameElapsed}/${SAMPLES}, worst drift ${worst}ms`);
    }

    /*
     * cleanUpProgram is the one thing on the save path that can break the
     * cancellation, because it changes the cycle length after the rotation has
     * been computed against the old one. Stated as a check so the trap is
     * visible rather than a paragraph in NOTES.md nobody reads.
     */
    {
        const ch = fixtureChannel();
        const edited = loadIntoEditor(ch);
        const beforeLen = edited.programs.reduce((a, p) => a + p.duration, 0);
        edited.programs[3].duration += 0.4;   // make one duration fractional
        const saved = resave(edited);
        const afterLen = saved.programs.reduce((a, p) => a + p.duration, 0);
        suite.check('cleanUpProgram ceils a fractional duration, changing the cycle',
            afterLen === beforeLen + 1, `${beforeLen} -> ${afterLen}`);
        suite.log('^ this is the one save-path change that can desync the rotation'
            + ' from startTime; it does not fire on integer durations.');
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
