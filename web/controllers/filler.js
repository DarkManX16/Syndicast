module.exports = function ($scope, $timeout, dizquetv) {
    $scope.fillers = []
    $scope.showFillerConfig = false
    $scope.selectedFiller = null
    $scope.selectedFillerIndex = -1

    $scope.refreshFiller = async () => {
        $scope.fillers = [ { id: '?', pending: true} ]
        $timeout();
        // Order comes from the server, which sorts by stored rank.
        $scope.fillers = await dizquetv.getAllFillersInfo();
        $timeout();
    }
    $scope.refreshFiller();

    $scope.savingOrder = false;

    let persistOrder = async () => {
        $scope.savingOrder = true;
        try {
            await dizquetv.saveFillerOrder( $scope.fillers.map( (f) => f.id ) );
        } catch (err) {
            console.error("Unable to save filler order", err);
            // Fall back to whatever the server actually has, so the page never
            // shows an order that was not persisted.
            await $scope.refreshFiller();
        }
        $scope.savingOrder = false;
        $timeout();
    }

    // Runs after the dropped copy has been inserted, so this splice removes the
    // original and leaves the array in its final order.
    $scope.fillerMoved = (index) => {
        $scope.fillers.splice(index, 1);
        persistOrder();
    }

    $scope.sortFillersByName = (descending) => {
        $scope.fillers.sort( (a, b) => {
            let r = (a.name || "").localeCompare(b.name || "");
            return descending ? -r : r;
        } );
        persistOrder();
    }

    let feedToFillerConfig = () => {};
    let feedToDeleteFiller = feedToFillerConfig;

    $scope.registerFillerConfig = (feed) => {
        feedToFillerConfig = feed;
    }

    $scope.registerDeleteFiller = (feed) => {
        feedToDeleteFiller = feed;
    }

    $scope.queryChannel = async (index, channel) => {
        let ch = await dizquetv.getChannelDescription(channel.number);
        ch.pending = false;
        $scope.fillers[index] = ch;
        $scope.$apply();
    }

    $scope.onFillerConfigDone = async (filler) => {
        if ($scope.selectedChannelIndex != -1) {
            $scope.fillers[ $scope.selectedChannelIndex ].pending = false;
        }
        if (typeof filler !== 'undefined') {
            // not canceled
            if ($scope.selectedChannelIndex == -1) { // add new channel
                await dizquetv.createFiller(filler);
            } else {
                $scope.fillers[ $scope.selectedChannelIndex ].pending = true;
                await dizquetv.updateFiller(filler.id, filler);
            }
            await $scope.refreshFiller();
        }
    }
    $scope.selectFiller = async (index) => {
        try {
            if ( (index != -1) && $scope.fillers[index].pending) {
                return;
            }
            $scope.selectedChannelIndex = index;
            if (index === -1) {
                feedToFillerConfig();
            } else {
                $scope.fillers[index].pending = true;
                let f = await dizquetv.getFiller($scope.fillers[index].id);
                feedToFillerConfig(f);
                $timeout();
            }
        } catch( err ) {
            console.error("Could not fetch filler.", err);
        }
    }

    // Keyed on the filler's own id, not its array position: $scope.fillers
    // can be reassigned (a reorder, another delete, a refresh) while the
    // confirmation dialog is open, and a stored index can then point past
    // the end of the new array or at the wrong row. onFillerDelete used to
    // dereference a stored index instead - a miss there threw before the
    // real delete request on the line right after it, so the delete never
    // ran, the filler list survived untouched, and the only visible symptom
    // was a console error and a row stuck showing as pending.
    let findFillerById = (id) => $scope.fillers.find((f) => f.id === id);

    $scope.deleteFiller = async (index) => {
        try {
            if ( $scope.fillers[index].pending) {
                return;
            }
            $scope.deleteFillerId = $scope.fillers[index].id;
            $scope.fillers[index].pending = true;
            let id = $scope.fillers[index].id;
            let channels = await dizquetv.getChannelsUsingFiller(id);
            feedToDeleteFiller( {
                id: id,
                name: $scope.fillers[index].name,
                channels : channels,
            } );
            $timeout();

        } catch (err) {
            console.error("Could not start delete filler dialog.", err);
        }

    }

    $scope.onFillerDelete = async( id ) => {
        try {
            let pendingFiller = findFillerById($scope.deleteFillerId);
            if (pendingFiller) {
                pendingFiller.pending = false;
            }
            $timeout();
            if (typeof(id) !== 'undefined') {
                if (pendingFiller) {
                    pendingFiller.pending = true;
                }
                await dizquetv.deleteFiller(id);
                $timeout();
                await $scope.refreshFiller();
                $timeout();
            }
        } catch (err) {
            console.error("Error attempting to delete filler", err);
        }
    }
}