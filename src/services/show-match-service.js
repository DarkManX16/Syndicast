const showMatch = require('../show-match');
const namesReview = require('../names-review');
const transitions = require('../transitions');
const clipNames = require('../clip-names');
const showSeasons = require('../show-seasons');
const nicknamesLogic = require('../nicknames');
const Plex = require('../plex');

// The most clips a nickname check lists by name; the counts are always complete.
const LISTED = 60;
// How long a show's seasons, as Plex gave them, are remembered.
const SEASONS_TTL_MS = 10 * 60 * 1000;

/*
 * Proposals for which show each clip of a filler list is about, and the writes
 * the names review screen makes (stage 5, step 6). Reading saves nothing. Saving
 * is `saveNames`, the one caller of the alias file's writer: it writes `names`
 * onto exactly the clips it is told about, and the nicknames it is told to teach,
 * and checks both before it writes either.
 */
class ShowMatchService {

    // `plexServerDB` and `plexClient` are only for the seasons lookup (showSeasons), and
    // both are optional: without them a show's seasons are the ones its lineups have.
    constructor(fillerDB, channelService, customShowDB, showAliasDB, plexServerDB, plexClient) {
        this.fillerDB = fillerDB;
        this.channelService = channelService;
        this.customShowDB = customShowDB;
        this.showAliasDB = showAliasDB;
        this.plexServerDB = plexServerDB || null;
        this.plexClient = plexClient || ( (server) => new Plex(server) );
        this.seasonCache = new Map();
    }

    async channels() {
        const numbers = await this.channelService.getAllChannelNumbers();
        const channels = [];
        for (const number of numbers) {
            const channel = await this.channelService.getChannel(number);
            if (channel != null) {
                channels.push(channel);
            }
        }
        return channels;
    }

    async vocabulary(channels) {
        const customShows = await this.customShowDB.getAllShows();
        const customShowNames = {};
        for (const show of customShows) {
            customShowNames[show.id] = show.name;
        }
        return showMatch.buildVocabulary(channels || await this.channels(), customShowNames, customShows);
    }

    /*
     * One entry per clip, in the list's order: what the clip says it names now
     * (`names`, [] when it has none, `reviewed` when it was saved as naming no show)
     * and what the title says it names (`proposal`).
     */
    rowsOf(filler, vocabulary, aliases) {
        return (filler.content || []).map( (clip, index) => ({
            index: index,
            title: clip.title,
            names: showMatch.namesOf(clip),
            reviewed: showMatch.isReviewedNone(clip),
            proposal: showMatch.propose(clip.title, vocabulary, aliases),
        }) );
    }

    /*
     * `showNames` gives a display name for every key a row mentions, so a client
     * need not carry the vocabulary; `shows` is every show and custom show on the
     * channels, by name, for the screen's pickers.
     */
    async matchFiller(id) {
        const filler = await this.fillerDB.getFiller(id);
        if (filler == null) {
            return null;
        }
        const vocabulary = await this.vocabulary();
        const aliases = await this.showAliasDB.load();
        const clips = this.rowsOf(filler, vocabulary, aliases);
        const showNames = {};
        const remember = (names) => {
            for (const name of names) {
                for (const key of clipNames.showsOf(name) ) {
                    if (typeof(vocabulary.names[key]) !== 'undefined') {
                        showNames[key] = vocabulary.names[key];
                    }
                }
            }
        };
        for (const row of clips) {
            remember(row.names);
            remember(row.proposal.names);
            remember(row.proposal.unresolved != null ? row.proposal.unresolved.recognised : []);
            for (const hit of row.proposal.found) {
                remember(hit.alsoKeys || []);
            }
        }
        const shows = Object.keys(vocabulary.names)
            .filter( (key) => /^(tv|custom)\./.test(key) )
            .map( (key) => ({ key: key, name: vocabulary.names[key], custom: key.startsWith('custom.'),
                group: key.startsWith('custom.') ? 'Custom shows' : 'Shows' }) )
            .sort( (a, b) => a.name.localeCompare(b.name) );
        // Every movie a clip may be for, after the shows: the movies of at least 40 minutes
        // on the channels, in a custom show or not, and any other movie a channel airs.
        for (const m of vocabulary.movies) {
            shows.push( { key: m.key, name: m.name, custom: false, movie: true, inCustomShow: m.custom, group: 'Movies' } );
        }
        return {
            id: id,
            name: filler.name,
            aliasCount: Object.keys(aliases).length,
            showNames: showNames,
            shows: shows,
            clips: clips,
        };
    }

    /*
     * Every list with how many of its clips are in each group, and the channels
     * whose transition steps use it, the lists in use first (those that need a
     * look before the ones that do not), then the rest in the Filler Lists order.
     */
    async overview() {
        const channels = await this.channels();
        const vocabulary = await this.vocabulary(channels);
        const aliases = await this.showAliasDB.load();
        const usedBy = {};
        for (const channel of channels) {
            for (const id of transitions.stepListIds(channel) ) {
                (usedBy[id] = usedBy[id] || []).push( { number: channel.number, name: channel.name } );
            }
        }
        const fillers = await this.fillerDB.getAllFillers();
        const lists = fillers.map( (filler, position) => {
            const counts = namesReview.summarize(this.rowsOf(filler, vocabulary, aliases));
            return Object.assign({ id: filler.id, name: filler.name, usedBy: usedBy[filler.id] || [], position: position,
                needsLook: namesReview.needsLook(counts) }, counts);
        } );
        lists.sort( (a, b) => ((b.usedBy.length > 0) - (a.usedBy.length > 0))
            || ((a.usedBy.length > 0) ? (b.needsLook - a.needsLook) : 0) || (a.position - b.position) );
        return { lists: lists };
    }

    // Every clip of every list, as checkNickname reads them.
    async everyClip() {
        const clips = [];
        for (const filler of await this.fillerDB.getAllFillers() ) {
            (filler.content || []).forEach( (clip, index) => {
                clips.push( { list: filler.id, listName: filler.name, index: index, title: clip.title,
                    names: showMatch.namesOf(clip), reviewed: showMatch.isReviewedNone(clip) } );
            } );
        }
        return clips;
    }

    /*
     * Whether a nickname may be taught, and which clips it would name: the answer
     * of checkNickname with the lists' names added and the clips counted by whether
     * they are in the list being reviewed. `index` is the clip it is taught from.
     */
    async checkNickname(id, text, showKey, index, season, seasons, anyOf) {
        const filler = await this.fillerDB.getFiller(id);
        if (filler == null) {
            return null;
        }
        const vocabulary = await this.vocabulary();
        const aliases = await this.showAliasDB.load();
        const source = ( (Number.isInteger(index)) && (filler.content[index] != null) ) ? filler.content[index].title : undefined;
        const clips = await this.everyClip();
        // A nickname means a show, or one season of it when `season` is given, or several
        // when `seasons` is, or any one of several shows when `anyOf` is.
        const target = namesReview.nicknameTarget( { showKey: showKey, season: season, seasons: seasons, anyOf: anyOf } );
        const result = showMatch.checkNickname(text, target, vocabulary, aliases, clips, { sourceTitle: source });
        const listName = {};
        for (const clip of clips) {
            listName[clip.list] = clip.listName;
        }
        const label = (n) => clipNames.labelOf(n, vocabulary.names);
        const show = (c) => ({ list: c.list, listName: listName[c.list], index: c.index, title: c.title,
            names: c.names.map(label) });
        // The clip it is taught from is not 'another clip'.
        const others = result.newly.filter( (c) => ! ( (c.list === id) && (c.index === index) ) );
        const here = others.filter( (c) => c.list === id );
        return {
            alias: result.alias,
            ok: result.ok,
            problems: result.problems,
            showName: (target !== null) && clipNames.showsOf(target).every( (k) => typeof(vocabulary.names[k]) === 'string' ) ? label(target) : String(showKey),
            sourceNames: result.sourceNames || [],
            sourceUnresolved: result.sourceUnresolved === true,
            sourceShows: (result.sourceNames || []).map(label),
            thisList: here.length,
            otherLists: others.length - here.length,
            newly: others.slice(0, LISTED).map(show),
            changed: result.changed.slice(0, LISTED).map(show),
        };
    }

    // What to offer when teaching a nickname from one clip.
    async nicknameSuggestions(id, index, showKey, season, seasons, anyOf) {
        const filler = await this.fillerDB.getFiller(id);
        if ( (filler == null) || (filler.content[index] == null) ) {
            return null;
        }
        const vocabulary = await this.vocabulary();
        const aliases = await this.showAliasDB.load();
        // What the other clips name, as far as anyone knows: their saved names, else
        // what their titles suggest, so a word the channel uses everywhere is seen as
        // such before anything has been saved.
        const corpus = (await this.everyClip() ).map( (c) => ({ title: c.title,
            names: (c.names.length > 0) ? c.names : (c.reviewed ? [] : showMatch.propose(c.title, vocabulary, aliases).names) }) );
        const target = namesReview.nicknameTarget( { showKey: showKey, season: season, seasons: seasons, anyOf: anyOf } );
        if (target === null) {
            return [];
        }
        return showMatch.nicknameSuggestions(filler.content[index].title, target, vocabulary, aliases, corpus);
    }

    /*
     * The seasons of a show for the picker and the nickname panel: Plex's own titles
     * and the folder each season's files sit in (which is where a saga's name lives
     * when Plex calls the season "Season 3"), else the seasons the lineups have. Plex
     * is asked about one episode of the show on a channel; when it cannot be, or there
     * is none, the lineups' seasons are answered with `source: 'lineup'`. Read-only,
     * remembered for ten minutes.
     */
    async showSeasons(showKey) {
        const cached = this.seasonCache.get(showKey);
        if ( (typeof(cached) !== 'undefined') && (Date.now() - cached.at < SEASONS_TTL_MS) ) {
            return cached.value;
        }
        const channels = await this.channels();
        const vocabulary = await this.vocabulary(channels);
        if ( (typeof(showKey) !== 'string') || ! showKey.startsWith('tv.') || (typeof(vocabulary.names[showKey]) === 'undefined') ) {
            return null;
        }
        const fallback = showSeasons.lineupSeasons(vocabulary, showKey);
        let episode = null;
        for (const channel of channels) {
            episode = (channel.programs || []).find( (p) => (p != null) && (p.type === 'episode') && (p.isOffline !== true)
                && (typeof(p.customShowId) === 'undefined') && (('tv.' + p.showTitle) === showKey) && (p.ratingKey != null) && (p.serverKey != null) );
            if (typeof(episode) !== 'undefined') {
                break;
            }
            episode = null;
        }
        if ( (episode === null) || (this.plexServerDB === null) ) {
            return fallback;
        }
        try {
            const server = await this.plexServerDB.getPlexServerByName(episode.serverKey);
            if (server == null) {
                return fallback;
            }
            const value = await showSeasons.plexSeasons(this.plexClient(server), episode.ratingKey, showKey, vocabulary.names[showKey]);
            this.seasonCache.set(showKey, { at: Date.now(), value: value });
            return value;
        } catch (err) {
            console.error(`Could not read ${showKey}'s seasons from Plex; using the seasons its lineups have.`, err.message);
            return fallback;
        }
    }

    /*
     * The Nicknames page: every nickname with what it means in words, how many clips have it in
     * their title and whether a show it means is gone, plus the shows for the page's pickers
     * (shows and custom shows, then the movies of 40 minutes or more, marked `movie`: a nickname
     * never means one movie alone, but one member of an "any one of" nickname can be a movie).
     * Reads only.
     */
    async nicknames() {
        const vocabulary = await this.vocabulary();
        const aliases = await this.showAliasDB.load();
        const clips = await this.everyClip();
        const shows = Object.keys(vocabulary.names)
            .filter( (key) => /^(tv|custom)\./.test(key) )
            .map( (key) => ({ key: key, name: vocabulary.names[key], custom: key.startsWith('custom.'),
                group: key.startsWith('custom.') ? 'Custom shows' : 'Shows' }) )
            .sort( (a, b) => a.name.localeCompare(b.name) );
        const showNames = {};
        for (const key of Object.keys(vocabulary.names) ) {
            if (/^(tv|custom)\./.test(key) ) {
                showNames[key] = vocabulary.names[key];
            }
        }
        for (const m of vocabulary.movies) {
            shows.push( { key: m.key, name: m.name, custom: false, movie: true, inCustomShow: m.custom, group: 'Movies' } );
            showNames[m.key] = m.name;
        }
        return { nicknames: nicknamesLogic.listNicknames(aliases, vocabulary, clips), shows: shows, showNames: showNames };
    }

    /*
     * What editing or deleting a nickname would change, before anything is saved: the clips whose
     * suggestion would be different (with what it is now and what it would become) and how many
     * clips keep their saved names. `body` is { alias, remove: true } to delete, or { alias,
     * newAlias?, showKey?, season?, seasons?, anyOf? } to change the text, what it means, or both.
     * Reads only: no clip and no file is written.
     */
    async previewNickname(body) {
        const vocabulary = await this.vocabulary();
        const aliases = await this.showAliasDB.load();
        const clips = await this.everyClip();
        const given = (body != null) && ( (typeof(body.showKey) === 'string') || Array.isArray(body.anyOf) );
        const edit = { alias: (body == null) ? undefined : body.alias, remove: (body != null) && (body.remove === true) };
        if ( (body != null) && (typeof(body.newAlias) === 'string') ) {
            edit.newAlias = body.newAlias;
        }
        if (given) {
            // a meaning that is not one (no show, one show in a list of any-of's) is null, which the rules refuse
            edit.target = namesReview.nicknameTarget( { showKey: body.showKey, season: body.season, seasons: body.seasons, anyOf: body.anyOf } );
        }
        const result = nicknamesLogic.previewEdit(edit, { vocabulary: vocabulary, aliases: aliases, clips: clips } );
        const label = (n) => clipNames.labelOf(n, vocabulary.names);
        const listed = result.changes.slice(0, nicknamesLogic.LISTED).map( (c) => ({
            list: c.list, listName: c.listName, index: c.index, title: c.title,
            before: c.beforeFlagged ? 'flagged' : (c.before.length === 0 ? 'no suggestion' : c.before.map(label).join(' → ')),
            after: c.afterFlagged ? 'flagged' : (c.after.length === 0 ? 'no suggestion' : c.after.map(label).join(' → ')) }) );
        return {
            ok: result.ok,
            problems: result.problems,
            alias: result.alias,
            newAlias: result.newAlias,
            remove: result.remove,
            target: result.target,
            meaning: ( (result.target != null) && ! result.remove ) ? label(result.target) : null,
            changed: result.changes.length,
            changes: listed,
            kept: result.kept,
            // the nickname as it is now, for a delete's sentence
            was: (typeof(aliases[result.alias]) !== 'undefined') ? label(aliases[result.alias]) : null,
        };
    }

    /*
     * Edits or deletes one nickname: the same check as previewNickname, and a refusal (nothing
     * written) when it says the edit cannot be made. Only the alias file is written; no clip is
     * ever touched, so every name already saved on a clip stays as it is. Throws a ReviewError and
     * otherwise answers with the page's list as it now reads.
     */
    async saveNickname(body) {
        const preview = await this.previewNickname(body);
        if (! preview.ok) {
            throw new ReviewError(preview.problems.join(' '));
        }
        try {
            await this.showAliasDB.change(preview.alias, preview.remove ? null : preview.newAlias, preview.remove ? undefined : preview.target);
        } catch (err) {
            throw new ReviewError(err.message);
        }
        return await this.nicknames();
    }

    /*
     * The review screen's save. `body` is { clips: [{ index, title, names }],
     * aliases: { nickname: showKey } }, as names-review.savePayload makes it.
     * Everything is checked first - the clips are still where the screen saw them,
     * the show keys are real, each nickname passes checkNickname - and a problem
     * writes nothing. Then `names` is set on exactly the clips listed (an empty list
     * for "names no show") and the nicknames are added. Nothing else in the list
     * or the alias file is touched. Throws a ReviewError, which carries what to say,
     * and otherwise answers with the list as it now reads.
     */
    async saveNames(id, body) {
        const filler = await this.fillerDB.getFiller(id);
        if (filler == null) {
            return null;
        }
        const clips = (body != null) && Array.isArray(body.clips) ? body.clips : [];
        const wanted = (body != null) && (body.aliases != null) && (typeof(body.aliases) === 'object') ? body.aliases : {};
        const vocabulary = await this.vocabulary();
        const aliases = await this.showAliasDB.load();

        const seen = new Set();
        for (const c of clips) {
            const here = Number.isInteger(c.index) ? filler.content[c.index] : undefined;
            if ( (typeof(here) === 'undefined') || (here.title !== c.title) ) {
                throw new ReviewError('The list has changed since this screen was opened (a clip is no longer where it was). Close the screen and open it again.');
            }
            if (seen.has(c.index) ) {
                throw new ReviewError(`Clip ${c.index + 1} is in the save twice.`);
            }
            seen.add(c.index);
            const problem = namesReview.picksProblem(c.names);
            if (problem !== null) {
                throw new ReviewError(`“${c.title}”: ${problem}.`);
            }
            for (const name of c.names) {
                for (const key of clipNames.showsOf(name) ) {
                    if (typeof(vocabulary.names[key]) === 'undefined') {
                        throw new ReviewError(`“${c.title}”: ${key} is not a show or movie on any channel.`);
                    }
                }
            }
        }

        const toTeach = {};
        let known = aliases;
        const everyClip = Object.keys(wanted).length > 0 ? await this.everyClip() : [];
        for (const text of Object.keys(wanted) ) {
            if (! clipNames.validName(wanted[text]) ) {
                throw new ReviewError(`Nickname “${text}” was not saved: it does not mean a show, a movie or a season of a show, or any one of several shows.`);
            }
            const checked = showMatch.checkNickname(text, wanted[text], vocabulary, known, everyClip);
            if (! checked.ok) {
                throw new ReviewError(`Nickname “${text}” was not saved: ${checked.problems.join(' ')}`);
            }
            toTeach[checked.alias] = wanted[text];
            known = Object.assign({}, known, toTeach);
        }

        if (clips.length > 0) {
            const copy = JSON.parse( JSON.stringify(filler) );
            for (const c of clips) {
                copy.content[c.index].names = c.names.slice();
            }
            await this.fillerDB.saveFiller(id, copy);
        }
        if (Object.keys(toTeach).length > 0) {
            await this.showAliasDB.merge(toTeach);
        }
        return await this.matchFiller(id);
    }
}

// A save that was refused, with a sentence for the person using the screen.
class ReviewError extends Error {}

ShowMatchService.ReviewError = ReviewError;
module.exports = ShowMatchService;
