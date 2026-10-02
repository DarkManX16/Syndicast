const showMatch = require('../show-match');

/*
 * Proposals for which show each clip of a filler list is about, for the filler
 * review screen. Read-only on purpose: it loads a list, every channel and the
 * alias file, and answers. Fixing a proposal and saving the names or an alias
 * is the review screen's job, through paths that do not exist yet.
 */
class ShowMatchService {

    constructor(fillerDB, channelService, customShowDB, showAliasDB) {
        this.fillerDB = fillerDB;
        this.channelService = channelService;
        this.customShowDB = customShowDB;
        this.showAliasDB = showAliasDB;
    }

    async vocabulary() {
        const numbers = await this.channelService.getAllChannelNumbers();
        const channels = [];
        for (const number of numbers) {
            const channel = await this.channelService.getChannel(number);
            if (channel != null) {
                channels.push(channel);
            }
        }
        const customShowNames = {};
        for (const info of await this.customShowDB.getAllShowsInfo() ) {
            customShowNames[info.id] = info.name;
        }
        return showMatch.buildVocabulary(channels, customShowNames);
    }

    /*
     * One entry per clip, in the list's order: what the clip says it names now
     * (`names`, [] when it has none) and what the title says it names
     * (`proposal`). `showNames` gives a display name for every key either
     * mentions, so a client need not carry the vocabulary.
     */
    async matchFiller(id) {
        const filler = await this.fillerDB.getFiller(id);
        if (filler == null) {
            return null;
        }
        const vocabulary = await this.vocabulary();
        const aliases = await this.showAliasDB.load();
        const showNames = {};
        const remember = (keys) => {
            for (const key of keys) {
                if (typeof(vocabulary.names[key]) !== 'undefined') {
                    showNames[key] = vocabulary.names[key];
                }
            }
        };
        const clips = (filler.content || []).map( (clip, index) => {
            const names = showMatch.namesOf(clip);
            const proposal = showMatch.propose(clip.title, vocabulary, aliases);
            remember(names);
            remember(proposal.names);
            return { index: index, title: clip.title, names: names, proposal: proposal };
        } );
        return {
            id: id,
            name: filler.name,
            aliasCount: Object.keys(aliases).length,
            showNames: showNames,
            clips: clips,
        };
    }
}

module.exports = ShowMatchService;
