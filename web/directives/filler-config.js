const clipNames = require('../../src/clip-names');

module.exports = function ($timeout, dizquetv, commonProgramTools, getShowData, namesReview) {
    return {
        restrict: 'E',
        templateUrl: 'templates/filler-config.html',
        replace: true,
        scope: {
            linker: "=linker",
            onDone: "=onDone"
        },
        link: function (scope, element, attrs) {
            scope.showTools = false;
            // Whether the clips were changed in this editor and not saved yet (see matchShows).
            scope.clipsChanged = false;
            scope.showPlexLibrary = false;
            scope.content = [];
            scope.visible = false;
            scope.error = undefined;
            scope.longDurationString = commonProgramTools.longDurationString;

            // See show-config.js: one line per row, one height, handed to
            // both the row's own inline style and vs-repeat.
            scope.contentRowHeight = commonProgramTools.contentListRowHeight;
            scope.rowFillerName = commonProgramTools.rowFillerName;
            scope.rowDuration = commonProgramTools.rowDuration;
            scope.rowSquareStyle = (program) => {
                return { 'background': commonProgramTools.programColorStyle(program) };
            }

            // See show-config.js for why this is here: ng-show="visible"
            // only hides this modal with CSS, so vs-repeat's own row-window
            // math can go stale against a container that still reads zero
            // height, and reopening (the same filler list again, or a
            // different one) can then render nothing until something
            // prompts a recompute against the real, now-visible size.
            if (window.ResizeObserver) {
                let resizeObserver = new ResizeObserver(() => {
                    if (scope.visible) {
                        scope.$applyAsync(() => {
                            scope.$broadcast('vsRepeatTrigger');
                        });
                    }
                });
                resizeObserver.observe(element[0]);
                scope.$on('$destroy', () => resizeObserver.disconnect());
            }
            scope.modes = [ {
                name: "import",
                description: "Collection/Playlist from Plex",
            }, {
                name: "custom",
                description: "Custom List of Clips",
            } ];
            scope.servers = [];
            scope.libraries = [];
            scope.sources = [];
            scope.filteredContent = [];
            scope.searchText = "";

            function applyFilter() {
                let query = (scope.searchText || "").trim().toLowerCase();
                // Unfiltered keeps the same array reference so drag-and-drop still
                // operates on the real list rather than a copy of it.
                scope.filteredContent = (query === "")
                    ? scope.content
                    : scope.content.filter( (c) => c.$searchText.indexOf(query) !== -1 );
            }

            // $index is each item's position in the unfiltered list, which is what
            // delete and reorder act on. It has to be rebuilt after every mutation,
            // otherwise a filtered view would delete the wrong row.
            function refreshContentIndexes() {
                let totalDurationMs = 0;
                for (let i = 0; i < scope.content.length; i++) {
                    scope.content[i].$index = i;
                    scope.content[i].$searchText = scope.getText(scope.content[i]).toLowerCase();
                    if (typeof(scope.content[i].duration) === 'number' && !isNaN(scope.content[i].duration)) {
                        totalDurationMs += scope.content[i].duration;
                    }
                }
                scope.totalDurationMs = totalDurationMs;
                applyFilter();
            }

            scope.searchChanged = applyFilter;

            scope.isFiltered = () => {
                return (scope.searchText || "").trim() !== "";
            }

            // A plain `ng-click="_infoProgram = x"` on a row would assign to
            // that row's own ng-repeat child scope, not this one - the panel
            // is mounted on this scope, so it would never see it.
            scope.showProgramInfo = (program) => {
                scope._infoProgram = program;
            }
            scope.contentSplice = (a,b) => {
                scope.clipsChanged = true;
                scope.content.splice(a,b)
                refreshContentIndexes();
            }
            scope.deleteRow = (program) => {
                scope.contentSplice(program.$index, 1);
            }

            scope.dropFunction = (dropIndex, program) => {
                scope.clipsChanged = true;
                let y = program.$index;
                let z = dropIndex + scope.currentStartIndex - 1;
                scope.content.splice(y, 1);
                if (z >= y) {
                    z--;
                }
                scope.content.splice(z, 0, program );
                refreshContentIndexes();
                $timeout();
                return false;
            }
            scope.setUpWatcher = function setupWatchers() {
                this.$watch('vsRepeat.startIndex', function(val) {
                    scope.currentStartIndex = val;
                });
            };

            scope.movedFunction = (index) => {
                console.log("movedFunction(" + index + ")");
            }

            scope.serverChanged = async () => {
                if (scope.server === "") {
                    scope.libraryKey = "";
                    return;
                }
                scope.loadingLibraries = true;
                try {
                    let libraries = (await dizquetv.getFromPlexProxy(scope.server, "/library/sections")).Directory;
                    if ( typeof(libraries) === "undefined") {
                        libraries = []
                    }
                    let officialLibraries = libraries.map( (library) => {
                        return {
                            "key" : library.key,
                            "description" : library.title,
                        }
                    } );

                    let defaultLibrary = {
                            "key": "",
                            "description" : "Select a Library...",
                        }
                    let playlists = [
                        {
                            "key": "$PLAYLISTS",
                            "description" : "Playlists",
                        }
                    ];
                    let combined = officialLibraries.concat(playlists);
                    if (! combined.some( (library) => library.key === scope.libraryKey) ) {
                        scope.libraryKey = "";
                        scope.libraries = [defaultLibrary].concat(combined);
                    } else {
                        scope.libraries = combined;
                    }
                } catch (err) {
                    scope.libraries = [ { name: "", description: "Unable to load libraries"} ];
                    scope.libraryKey = ""
                    throw err;
                } finally {
                    scope.loadingLibraries = false;
                    $timeout( () => {}, 0);
                }
            }


            scope.libraryChanged = async () => {
                if (scope.libraryKey == null) {
                    throw Error(`null libraryKey? ${scope.libraryKey} ${new Date().getTime()} `);
                }
                if (scope.libraryKey === "") {
                    scope.sourceKey = "";
                    return;
                }
                scope.loadingCollections = true;
                try {
                    let collections;
                    if (scope.libraryKey === "$PLAYLISTS") {
                        collections = (await dizquetv.getFromPlexProxy(scope.server, `/playlists`)).Metadata;
                    } else {
                        collections = (await dizquetv.getFromPlexProxy(scope.server, `/library/sections/${scope.libraryKey}/collections`));
                        collections = collections.Metadata
                    }
                    if (typeof(collections) === "undefined") {
                        //when the library has no collections it returns size=0
                        //and no array
                        collections = [];
                    }
                    let officialCollections = collections.map( (col) => {
                        return {
                            "key" : col.key,
                            "description" : col.title,
                        }
                    } );
                    let defaultSource = {
                        "key": "",
                        "description" : "Select a Source...",
                    };
                    if (officialCollections.length == 0) {
                        defaultSource = {
                            "key": "",
                            "description" : "(No collections/lists found)",
                        }
                    }
                    if (! officialCollections.some( (col) => col.key === scope.sourceKey ) ) {
                        scope.sourceKey = "";
                        scope.sources = [defaultSource].concat(officialCollections);
                    } else {
                        scope.sources = officialCollections;
                    }
                } catch (err) {
                    scope.sources = [ { name: "", description: "Unable to load collections"} ];
                    scope.sourceKey = "";
                    throw err;
                } finally {
                    scope.loadingCollections = false;
                    $timeout( () => {}, 0);
                }
            }

            let reloadServers = async() => {
                scope.loadingServers = true;
                try {
                    let servers = await dizquetv.getPlexServers();
                    scope.servers = servers.map( (s) => {
                        return {
                            "name" : s.name,
                            "description" : `Plex - ${s.name}`,
                        }
                    } );
                    let defaultServer = {
                        name: "",
                        description: "Select a Plex server..."
                    };
                    if (! scope.servers.some( (server) => server.name === scope.server) ) {
                        scope.server = "";
                        scope.servers = [defaultServer].concat(scope.servers);
                    }
                } catch (err) {
                    scope.server = "";
                    scope.servers = [ {name:"", description:"Could not load servers"} ];
                    throw err;
                } finally {
                    scope.loadingServers = false;
                    $timeout( () => {}, 0);
                }

                await scope.serverChanged();
                await scope.libraryChanged();

            };




            // ---- names (stage 5, step 6) ----------------------------------------
            // A clip saved as naming shows carries `names`, which rides along when the
            // list is saved here. What the titles suggest is read from the saved list,
            // so it is shown only while the clips are as they were saved.
            scope.suggested = {};
            scope.nameKeys = {};

            // A name is a show or movie key, or a season or a special of a show.
            const showNameOf = (name) => clipNames.labelOf(name, scope.nameKeys);

            const loadNameInfo = async () => {
                scope.suggested = {};
                scope.nameKeys = {};
                if ( (scope.id === undefined) || (scope.mode === 'import') ) {
                    return;
                }
                const id = scope.id;
                try {
                    const match = await dizquetv.getFillerMatch(id);
                    if (scope.id !== id) {
                        return;
                    }
                    scope.nameKeys = match.showNames;
                    for (const row of match.clips) {
                        if ( (row.names.length === 0) && ! row.reviewed && (row.proposal.names.length > 0) && (row.proposal.unresolved == null) ) {
                            scope.suggested[row.index] = row.proposal.names;
                        }
                    }
                } catch (err) {
                    console.error(err);
                } finally {
                    $timeout();
                }
            };

            // The Names tag of a row: what is saved, else what the title suggests.
            scope.rowNames = (x) => {
                if (Array.isArray(x.names) ) {
                    return (x.names.length === 0) ? 'names no show' : x.names.map(showNameOf).join(' → ');
                }
                if ( ! scope.clipsChanged && (typeof(scope.suggested[x.$index]) !== 'undefined') ) {
                    return 'suggested: ' + scope.suggested[x.$index].map(showNameOf).join(' → ');
                }
                return '';
            };
            scope.rowNamesTitle = (x) => {
                return Array.isArray(x.names)
                    ? 'Saved: the show or shows this clip names, in the order they air. Change it with Match shows.'
                    : 'Only suggested from the clip title, not saved. Open Match shows to accept it.';
            };
            scope.rowNamesClass = (x) => Array.isArray(x.names) ? 'lr-names-saved' : 'lr-names-suggested';

            scope.canMatchShows = () => (scope.id !== undefined) && (scope.mode === 'custom');
            scope.matchShows = () => {
                if (scope.canMatchShows() && ! scope.clipsChanged) {
                    namesReview.open(scope.id);
                }
            };

            // Names saved on the review screen go onto this editor's copy of the clips,
            // so pressing Done here does not write the old ones back.
            const stopListening = scope.$root.$on('namesSaved', async (event, id) => {
                if ( ! scope.visible || (id !== scope.id) ) {
                    return;
                }
                try {
                    const saved = await dizquetv.getFiller(id);
                    if ( ! scope.clipsChanged && (saved.content.length === scope.content.length) ) {
                        for (let i = 0; i < scope.content.length; i++) {
                            if (typeof(saved.content[i].names) === 'undefined') {
                                delete scope.content[i].names;
                            } else {
                                scope.content[i].names = saved.content[i].names;
                            }
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
                loadNameInfo();
                $timeout();
            });
            scope.$on('$destroy', stopListening);

            scope.linker( async (filler) => {

                if ( typeof(filler) === 'undefined') {
                    scope.name = "";
                    scope.content = [];
                    scope.clipsFeatureShows = false;
                    scope.id = undefined;
                    scope.title = "Create Filler List";
                    scope.mode = "import";
                    scope.server = "";
                    scope.libraryKey = "";
                    scope.sourceKey = "";
                } else {
                    scope.name = filler.name;
                    scope.content = filler.content;
                    scope.clipsFeatureShows = (filler.clipsFeatureShows === true);
                    scope.id = filler.id;
                    scope.title = "Edit Filler List";
                    scope.mode = filler.mode;
                    scope.server = filler?.import?.serverName;
                    if ( typeof(scope.server) !== "string" ) {
                        scope.server = "";
                    }
                    scope.libraryKey = filler?.import?.meta?.libraryKey;
                    if ( typeof(scope.libraryKey) !== "string" ) {
                        scope.libraryKey = "";
                    }
                    scope.sourceKey = filler?.import?.key;
                    if ( typeof(scope.sourceKey) !== "string" ) {
                        scope.sourceKey = "";
                    }
                }
                scope.clipsChanged = false;
                scope.suggested = {};
                scope.nameKeys = {};
                await reloadServers();
                loadNameInfo();
                scope.source = "";
                scope.searchText = "";
                refreshContentIndexes();
                scope.visible = true;
            } );

            scope.finished = (cancelled) => {
                if (cancelled) {
                    scope.visible = false;
                    return scope.onDone();
                }
                if ( (typeof(scope.name) === 'undefined') || (scope.name.length == 0) ) {
                    scope.error = "Please enter a name";
                }
                if ( scope?.mode === "import" ) {
                    if ( (typeof(scope?.server) !== "string" ) || (scope?.server === "") ) {
                        scope.error = "Please select a server"
                    }
                    if ( (typeof(scope?.source) !== "string" ) && (scope?.source === "") ) {
                        scope.error = "Please select a source."
                    }
                 } else {
                    if ( scope.content.length == 0) {
                        scope.error = "Please add at least one clip.";
                    }
                }
                if (typeof(scope.error) !== 'undefined') {
                    $timeout( () => {
                        scope.error = undefined;
                    }, 30000);
                    return;
                }
                scope.visible = false;
                let object = {
                    name: scope.name,
                    content: scope.content.map( (c) => {
                        delete c.$index
                        delete c.$searchText
                        return c;
                    } ),
                    id: scope.id,
                    mode: scope.mode,

                };
                // Written only when on, so a list that never used it stays
                // byte-for-byte as it was and unticking it removes the field.
                if (scope.clipsFeatureShows === true) {
                    object.clipsFeatureShows = true;
                }
                if (object.mode === "import") {
                    object.content = [];
                    //In reality  dizqueTV only needs to know the server name
                    //and the source key, the meta object is for extra data
                    //that is useful for external things like this UI.
                    object.import = {
                        serverName : scope.server,
                        key: scope.sourceKey,
                        meta: {
                            libraryKey : scope.libraryKey,
                        }
                    }
                }
                scope.onDone( object );
            }
            scope.getText = (clip) => {
                let show = getShowData(clip);
                if (show.hasShow && show.showId !== "movie." ) {
                    return show.showDisplayName + " - " + clip.title;
                } else {
                    return clip.title;
                }
            }
            scope.showList = () => {
                return ! scope.showPlexLibrary;
            }
            scope.sortFillersByLength = () => {
                scope.clipsChanged = true;
                scope.content.sort( (a,b) => { return a.duration - b.duration } );
                refreshContentIndexes();
            }
            scope.sortFillersCorrectly = () => {
                scope.clipsChanged = true;
                scope.content = commonProgramTools.sortShows(scope.content);
                refreshContentIndexes();
            }

            scope.fillerRemoveAllFiller = () => {
                scope.clipsChanged = true;
                scope.content = [];
                refreshContentIndexes();
            }
            scope.fillerRemoveDuplicates = () => {
                scope.clipsChanged = true;
                function getKey(p) {
                    return p.serverKey + "|" + p.plexFile;
                }
                let seen = {};
                let newFiller = [];
                for (let i = 0; i < scope.content.length; i++) {
                    let p = scope.content[i];
                    let k = getKey(p);
                    if ( typeof(seen[k]) === 'undefined') {
                        seen[k] = true;
                        newFiller.push(p);
                    }
                }
                scope.content = newFiller;
                refreshContentIndexes();
            }
            scope.importPrograms = (selectedPrograms) => {
                scope.clipsChanged = true;
                for (let i = 0, l = selectedPrograms.length; i < l; i++) {
                    selectedPrograms[i].commercials = []
                }
                scope.content = scope.content.concat(selectedPrograms);
                refreshContentIndexes();
                scope.showPlexLibrary = false;
            }


            scope.durationString = (duration) => {
                var date = new Date(0);
                date.setSeconds( Math.floor(duration / 1000) ); // specify value for SECONDS here
                return date.toISOString().substr(11, 8);
            }

            let interpolate = ( () => {
                let h = 60*60*1000 / 6;
                let ix = [0, 1*h, 2*h, 4*h, 8*h, 24*h];
                let iy = [0, 1.0, 1.25, 1.5, 1.75, 2.0];
                let n = ix.length;

                return (x) => {
                    for (let i = 0; i < n-1; i++) {
                        if( (ix[i] <= x) && ( (x < ix[i+1]) || i==n-2 ) ) {
                            return iy[i] + (iy[i+1] - iy[i]) * ( (x - ix[i]) / (ix[i+1] - ix[i]) );
                        }
                    }
                }

            } )();

            scope.programSquareStyle = (program, dash) => {
                let background = "rgb(255, 255, 255)";
                let ems = Math.pow( Math.min(60*60*1000, program.duration), 0.7 );
                ems = ems / Math.pow(1*60*1000., 0.7);
                ems = Math.max( 0.25 , ems);
                let top = Math.max(0.0, (1.75 - ems) / 2.0) ;
                if (top == 0.0) {
                    top = "1px";
                }
                let solidOrDash = (dash? 'dashed' : 'solid');
                let f = interpolate;
                let w = 5.0;
                let t = 4*60*60*1000;
                let a = ( f(program.duration) *w) / f(t);
                a = Math.min( w, Math.max(0.3, a) );
                b = w - a + 0.01;

                return {
                    'width': `${a}%`,
                    'height': '1.3em',
                    'margin-right': `${b}%`,
                    'background': background,
                    'border': `1px ${solidOrDash} black`,
                    'margin-top': top,
                    'margin-bottom': '1px',
                };
            }

        }
    };
}
