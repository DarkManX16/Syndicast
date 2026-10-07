/*
 * Display only - nothing on this page changes how a channel is saved or
 * played. "Now playing" is polled from the server's own /now-playing
 * endpoint rather than computed here from channel.startTime, so its clock is
 * always the server's, never the viewing device's; a break never claims to
 * know which filler clip is on (that's chosen live, per viewer, and isn't
 * stored anywhere) - it shows the mix in effect and the time to the next
 * real program instead.
 *
 * The library grouping reuses getShowData/commonProgramTools, the same
 * showId-based grouping the programming list and custom shows already use,
 * rather than a second classification scheme invented for this page.
 */
const channelLibrary = require('../../src/channel-library');

module.exports = function ($scope, $routeParams, $timeout, $interval, dizquetv, getShowData, commonProgramTools) {
    let channelNumber = parseInt($routeParams.number, 10);
    $scope.channelNumber = channelNumber;
    $scope.loading = true;
    $scope.loadError = false;
    $scope.channel = null;

    $scope.tab = 'overview';
    $scope.libraryTab = 'movies';
    $scope.displayImages = true;

    $scope.nowPlaying = null;
    $scope.nowPlayingError = false;

    $scope.library = null;
    $scope.selectedGroup = null;
    $scope.selectGroup = (g) => {
        $scope.selectedGroup = (g === $scope.selectedGroup) ? null : g;
    }

    $scope.fillerLists = null;
    $scope.fillerListsLoading = false;

    $scope._infoProgram = null;
    $scope.showProgramInfo = (program) => {
        $scope._infoProgram = program;
    }

    $scope.getProgramDisplayTitle = commonProgramTools.getProgramDisplayTitle;

    $scope.durationString = (duration) => {
        if (typeof(duration) !== 'number' || isNaN(duration) || duration < 0) {
            return 'Unknown';
        }
        var date = new Date(0);
        date.setSeconds(Math.floor(duration / 1000));
        return date.toISOString().substr(11, 8);
    }

    // Total runtimes and filler-mix totals can run into days, where the
    // HH:MM:SS above would just wrap - this drops units that are zero rather
    // than showing "0d".
    $scope.longDurationString = (ms) => {
        if (typeof(ms) !== 'number' || isNaN(ms) || ms < 0) {
            return 'Unknown';
        }
        let totalMinutes = Math.floor(ms / 60000);
        let days = Math.floor(totalMinutes / (24 * 60));
        let hours = Math.floor((totalMinutes % (24 * 60)) / 60);
        let minutes = totalMinutes % 60;
        let parts = [];
        if (days > 0) {
            parts.push(days + 'd');
        }
        if (hours > 0 || days > 0) {
            parts.push(hours + 'h');
        }
        parts.push(minutes + 'm');
        return parts.join(' ');
    }

    $scope.setTab = (t) => {
        $scope.tab = t;
        if ( (t === 'filler') && ($scope.fillerLists === null) && ! $scope.fillerListsLoading) {
            loadFillerLists();
        }
    }

    $scope.setLibraryTab = (t) => {
        $scope.libraryTab = t;
        $scope.selectedGroup = null;
    }

    $scope.streamEndpoints = [
        { id: 'video', label: '/video', description: 'Channel mpegts' },
        { id: 'm3u8', label: '/m3u8', description: 'Playlist of individual videos' },
        { id: 'radio', label: '/radio', description: 'Audio-only channel mpegts' },
    ];
    $scope.streamUrl = (endpointId) => {
        let path = `/${endpointId}?channel=${channelNumber}`;
        return window.location.href.replace(window.location.hash, '') + path;
    }

    $scope.progressPercent = (np) => {
        if ( (np == null) || (typeof(np.durationMs) !== 'number') || (np.durationMs <= 0) ) {
            return 0;
        }
        return Math.max(0, Math.min(100, (np.elapsedMs / np.durationMs) * 100));
    }

    $scope.breakContextLabel = (np) => {
        if ( (np == null) || (np.contextKind === 'channel') ) {
            return "the channel's own Flex mix";
        }
        let kind = (np.contextKind === 'block') ? 'block' : 'day-part';
        return '"' + np.contextName + '" ' + kind;
    }

    let nowPlayingTimer = null;
    let refreshNowPlaying = async () => {
        try {
            $scope.nowPlaying = await dizquetv.getChannelNowPlaying(channelNumber);
            $scope.nowPlayingError = false;
        } catch (err) {
            console.error("Could not fetch now-playing status for channel " + channelNumber, err);
            $scope.nowPlayingError = true;
        }
        $timeout();
    }

    let loadFillerLists = async () => {
        $scope.fillerListsLoading = true;
        $timeout();
        try {
            $scope.fillerLists = await dizquetv.getChannelFillerLists(channelNumber);
        } catch (err) {
            console.error("Could not fetch filler lists for channel " + channelNumber, err);
            $scope.fillerLists = { channelWide: [], dayParts: [], blocks: [] };
        }
        $scope.fillerListsLoading = false;
        $timeout();
    }

    let buildLibrary = (programs) => channelLibrary.buildLibrary(programs, getShowData);

    let load = async () => {
        $scope.loading = true;
        $scope.loadError = false;
        $timeout();
        try {
            let results = await Promise.all([
                dizquetv.getChannelProgramless(channelNumber),
                dizquetv.getChannelPrograms(channelNumber),
            ]);
            let channel = results[0];
            channel.programs = results[1];
            $scope.channel = channel;
            $scope.library = buildLibrary(channel.programs);
        } catch (err) {
            console.error("Could not load channel " + channelNumber, err);
            $scope.loadError = true;
        }
        $scope.loading = false;
        $timeout();
    }

    load();
    refreshNowPlaying();
    nowPlayingTimer = $interval(refreshNowPlaying, 5000);

    $scope.$on('$destroy', () => {
        if (nowPlayingTimer !== null) {
            $interval.cancel(nowPlayingTimer);
        }
    });
}
