const review = require('../src/names-review');

/*
 * A show's seasons for a picker: Plex's titles and the folder each season's files sit in (where
 * a saga's name lives), else the seasons the lineups have, asked for once per show and kept for
 * the life of the screen. The names review screen and the Nicknames page both read seasons this
 * way, for the show a slot picks and for every member of an "any one of" name.
 *
 * A slot is { key, picked, special } (src/names-review.js). `info` is built once per show and the
 * lists it hands back are kept, so ng-repeat and ng-options see the same objects every digest
 * and settle.
 */
module.exports = function seasonSource(dizquetv, $timeout) {
    const info = {};
    const hasParts = (slot) => !! slot.key && /^tv[.]/.test(slot.key);

    const ensure = async (key) => {
        if ( ! key || ! /^tv[.]/.test(key) || (typeof(info[key]) !== 'undefined') ) {
            return;
        }
        const entry = { loading: true, data: null, choices: [], specials: [], error: '' };
        info[key] = entry;
        try {
            const data = await dizquetv.getShowSeasons(key);
            entry.data = data;
            for (const season of data.seasons) {
                entry.choices.push( { index: season.index, label: season.label, folder: (season.hint != null) ? season.folder : null } );
            }
            for (const special of data.specials) {
                entry.specials.push( { title: special.title } );
            }
        } catch (err) {
            console.error(err);
            entry.error = 'Unable to read this show’s seasons.';
        } finally {
            entry.loading = false;
            $timeout();
        }
    };

    // The seasons a slot offers: what the show has, plus any the slot already holds that the
    // show's list lacks. One list per combination, kept.
    const extraChoices = new Map();
    const choicesFor = (entry, picked) => {
        const base = (entry == null) ? [] : entry.choices;
        const missing = review.pickedSeasons( { picked: picked } ).filter( (n) => ! base.some( (c) => c.index === n ) );
        if (missing.length === 0) {
            return base;
        }
        const once = (entry == null ? '' : entry.choices.length) + '|' + missing.join(',');
        if (! extraChoices.has(once) ) {
            extraChoices.set(once, base.concat( missing.map( (n) => ({ index: n, label: n === 0 ? 'Specials' : 'Season ' + n, folder: null }) ) ).sort( (a, b) => a.index - b.index ));
        }
        return extraChoices.get(once);
    };
    const choices = (slot) => choicesFor(info[slot.key], slot.picked);

    const specials = (slot) => {
        const entry = info[slot.key];
        const base = (entry == null) ? [] : entry.specials;
        if ( ! slot.special || base.some( (o) => o.title === slot.special ) ) {
            return base;
        }
        const once = 'sp|' + slot.special + '|' + base.length;
        if (! extraChoices.has(once) ) {
            extraChoices.set(once, base.concat( [ { title: slot.special } ] ));
        }
        return extraChoices.get(once);
    };

    return { info: info, ensure: ensure, hasParts: hasParts, choices: choices, specials: specials, state: (slot) => info[slot.key] };
};
