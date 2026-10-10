const events = require('events')
const channelCache = require("../channel-cache");
const showCatalog = require("../show-catalog");

class ChannelService extends events.EventEmitter {

    constructor(channelDB) {
        super();
        this.channelDB = channelDB;
        this.onDemandService = null;
        this.catalogQueue = new Map();
    }

    setOnDemandService(onDemandService) {
        this.onDemandService = onDemandService;
    }

    async saveChannel(number, channelJson, options) {

        let channel = cleanUpChannel(channelJson);
        if ( (typeof(options) === 'object') && (options !== null) && (options.keepCatalog === true) ) {
            // channel.catalog belongs to the catalog ops below: a save from the
            // channel page keeps the stored one, so a page opened before a
            // review can't undo it.
            let stored = await this.getChannel(number);
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
            ( (typeof(options) === 'undefined') || (options.ignoreOnDemand !== true) )
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

    // Ops on a channel's catalog state, applied in order and saved once; one
    // channel's ops run one call at a time, so two at once both land.
    async applyCatalogOps(number, ops) {
        let key = String(number);
        let previous = this.catalogQueue.get(key) || Promise.resolve();
        let run = previous.catch( () => {} ).then( async () => {
            let channel = await this.getChannel(number);
            if (channel == null) {
                throw new Error('No channel ' + number);
            }
            let copy = JSON.parse(JSON.stringify(channel));
            copy.catalog = showCatalog.applyOps(showCatalog.stateOf(copy), ops, Date.now());
            await this.saveChannel(number, copy);
            return copy.catalog;
        } );
        this.catalogQueue.set(key, run);
        return run;
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