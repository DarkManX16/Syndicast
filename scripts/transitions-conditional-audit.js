#!/usr/bin/env node
/*
 * Lists every transition step that is thrown out today because it watches
 * (`onlyIfNoMatch`) a step that is itself conditional - transitions.js's
 * watchProblem has always refused to honour that (a step's "found no clip"
 * is not something to guess at for a step that was never tried), so these
 * steps are warned about at save (channel-db.js's warnAboutTransitions) and
 * skipped on air, silently, every time. The new cascade option
 * (onlyIfNothingAbove) is built for exactly this case: a chain like "promo,
 * else Up Next, else bumper, else WBRB" is positional, not by id, so nothing
 * in it needs to watch a conditional step.
 *
 * Usage: node scripts/transitions-conditional-audit.js <data-folder>
 *
 * Read-only. Point it at a COPY of the data folder, not the live one.
 */
const fs = require('fs');
const path = require('path');
const transitions = require('../src/transitions');

const folder = process.argv[2];
if (typeof(folder) !== 'string' || folder === '') {
    console.error('usage: node scripts/transitions-conditional-audit.js <data-folder>');
    process.exit(2);
}

function readJsonFiles(dir) {
    if (! fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir).filter( (f) => f.endsWith('.json') )
        .map( (f) => ({ file: f, json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }) );
}

const channels = readJsonFiles(path.join(folder, 'channels'));
if (channels.length === 0) {
    console.error(`no channel files found under ${path.join(folder, 'channels')}`);
    process.exit(2);
}

const found = [];
for (const { file, json: channel } of channels) {
    const label = `channel ${channel.number}${channel.name ? ` ("${channel.name}")` : ''} [${file}]`;
    for (const [kind, list] of [['day-part', channel.dayParts], ['block', channel.blocks]]) {
        if (! Array.isArray(list)) {
            continue;
        }
        list.forEach( (context, i) => {
            if ((context == null) || (context.transitions == null) || (typeof(context.transitions) !== 'object')) {
                return;
            }
            const owner = `${kind} ${i}${context.name ? ` ("${context.name}")` : ''}`;
            for (const situationName of Object.keys(context.transitions)) {
                const situation = context.transitions[situationName];
                if ((situation == null) || (typeof(situation) !== 'object')) {
                    continue;
                }
                const out = Array.isArray(situation.out) ? situation.out : [];
                const inn = Array.isArray(situation.in) ? situation.in : [];
                const sequence = out.concat(inn);
                for (const side of ['out', 'in']) {
                    for (const step of (side === 'out' ? out : inn)) {
                        if ((step == null) || (typeof(step) !== 'object')) {
                            continue;
                        }
                        const problem = transitions.watchProblem(step, sequence);
                        if ((problem !== null) && /which is itself conditional/.test(problem)) {
                            const watchedId = step.onlyIfNoMatch;
                            const watched = sequence.find( (s) => (s != null) && (s.id === watchedId) );
                            found.push({
                                channel: label, context: owner, situation: situationName, side,
                                stepId: step.id, listId: step.listId || step.templateId || '(no list)',
                                watchedId, watchedListId: (watched != null) ? (watched.listId || watched.templateId || '(no list)') : '?',
                            });
                        }
                    }
                }
            }
        });
    }
}

console.log(`${channels.length} channel file(s) under ${folder}: ${found.length} step(s) watch a step that is itself conditional, so they are skipped on air today.\n`);
for (const f of found) {
    console.log(`${f.channel} / ${f.context} / ${f.situation}.${f.side} step "${f.stepId}" (list "${f.listId}")`
        + ` watches "${f.watchedId}" (list "${f.watchedListId}"), which is itself conditional - never honoured.`);
}
if (found.length > 0) {
    console.log('\nEach of these can be rebuilt with the cascade option ("only when no step above it on this side found a clip"),'
        + ' in position below the step it was trying to watch, instead of naming it.');
}
