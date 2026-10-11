const events = require('events')
const channelCache = require("../channel-cache");
const showCatalog = require("../show-catalog");

class ChannelService extends events.EventEmitter {

    constructor(channelDB) {
        super();
        this.channelDB = channelDB;
        this.onDemandService = null;
        this.channelQueue = new Map();
    }

    setOnDemandService(onDemandService) {
        this.onDemandService = onDemandService;
    }

    /*
     * A channel's saves and its catalog ops run one at a time, in the order
     * they arrive (see exclusive), and only a catalog op writes
     * channel.catalog: every other save keeps the stored one, whatever it
     * sends. So a writer holding a copy read before an op - the channel page,
     * the filler or on-demand services, a Plex server change - can't undo the
     * op, and an op can't undo a save. See NOTES.md, Known issues, "Full
     * catalogs, and a never-air list".
     */
    async saveChannel(number, channelJson, options) {
        return this.exclusive(number, () => this.writeChannel(number, channelJson, options, null));
    }

    exclusive(number, task) {
        let key = String(number);
        let previous = this.channelQueue.get(key) || Promise.resolve();
        let run = previous.catch( () => {} ).then(task);
        this.channelQueue.set(key, run);
        return run;
    }

    // catalog: the state to write (a catalog op), or null to keep the stored one.
    async writeChannel(number, channelJson, options, catalog) {
        // A renumber saves under the new number with catalogFrom, the old one.
        let catalogFrom = channelJson.catalogFrom;
        delete channelJson.catalogFrom;
        let channel = cleanUpChannel(channelJson);
        if (catalog !== null) {
            channel.catalog = catalog;
        } else {
            let stored = await this.getChannel(number);
            if ( (stored == null) && (typeof(catalogFrom) !== 'undefined') ) {
                stored = await this.getChannel(catalogFrom);
            }
            if ( (stored != null) && (typeof(stored.catalog) === 'object') && (stored.catalog !== null) ) {
                channel.catalog = JSON.parse(JSON.stringify(stored.catalog));
            } else {
                delete channel.catalog;
            }
        }
        let ignoreOnDemand = true;
        if (
            (this.onDemandService != null)
            &&
            ( (typeof(options) === 'undefined') || (options === null) || (options.ignoreOnDemand !== true) )
        ) {
            ignoreOnDemand = false;
            this.onDemandService.fixupChannelBeforeSave( channel );
        }
        channelCache.saveChannelConfig( number, channel);
        await channelDB.saveChannel( number, channel );

        this.emit('channel-update', { channelNumber: number,  channel: channel, ignoreOnDemand: ignoreOnDemand} );
    }

    // The channel's full-catalog state - see src/show-catalog.js.
    async getCatalog(number) {
        let channel = await this.getChannel(number);
        if (channel == null) {
            throw new Error('No channel ' + number);
        }
        return showCatalog.stateOf(channel);
    }

    // Ops on a channel's catalog state, applied in order and saved once, in
    // turn with the channel's saves; a refused op saves nothing.
    async applyCatalogOps(number, ops) {
        return this.exclusive(number, async () => {
            let channel = await this.getChannel(number);
            if (channel == null) {
                throw new Error('No channel ' + number);
            }
            let copy = JSON.parse(JSON.stringify(channel));
            let catalog = showCatalog.applyOps(showCatalog.stateOf(copy), ops, Date.now());
            await this.writeChannel(number, copy, undefined, catalog);
            return catalog;
        } );
    }

    async deleteChannel(number) {
        await channelDB.deleteChannel( number );
        this.emit('channel-update', { channelNumber: number,  channel: null} );

        channelCache.clear();
    }

    async getChannel(number) {
        let lis = await channelCache.getChannelConfig(this.channelDB, number)
        if ( lis == null || lis.length !== 1) {
            return null;
        }
        return lis[0];
    }

    async getAllChannelNumbers() {
        return await channelCache.getAllNumbers(this.channelDB);
    }

    async getAllChannels() {
        return await channelCache.getAllChannels(this.channelDB);
    }


}


function cleanUpProgram(program) {
    delete program.start
    delete program.stop
    delete program.streams;
    delete program.durationStr;
    delete program.commercials;
    if (
      (typeof(program.duration) === 'undefined')
      ||
      (program.duration <= 0)
    ) {
      console.error(`Input contained a program with invalid duration: ${program.duration}. This program has been deleted`);
      return [];
    }
    if (! Number.isInteger(program.duration) ) {
      console.error(`Input contained a program with invalid duration: ${program.duration}. Duration got fixed to be integer.`);
      program.duration = Math.ceil(program.duration);
    }
    return [ program ];
}

function cleanUpChannel(channel) {
    if (
      (typeof(channel.groupTitle) === 'undefined')
      ||
      (channel.groupTitle === '')
    ) {
      channel.groupTitle = "Syndicast";
    }
    channel.programs = channel.programs.flatMap( cleanUpProgram );
    delete channel.fillerContent;
    delete channel.filler;
    channel.fallback = channel.fallback.flatMap( cleanUpProgram );
    channel.duration = 0;
    for (let i = 0; i < channel.programs.length; i++) {
      channel.duration += channel.programs[i].duration;
    }
    return channel;

}


module.exports = ChannelService