
module.exports = function ($timeout, dizquetv, getShowData, seasonConstraints ) {
    const DAY = 24*60*60*1000;
    const WEEK = 7 * DAY;
    const WEEK_DAYS = [ "Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday" ];
    
    return {
        restrict: 'E',
        templateUrl: 'templates/time-slots-schedule-editor.html',
        replace: true,
        scope: {
            linker: "=linker",
            onDone: "=onDone"
        },
        
        link: function (scope, element, attrs) {
            scope.limit = 50000;
            scope.visible = false;
            scope.fake = { time: -1 };
            scope.badTimes = false;
            scope._editedTime = null;
            let showsById;
            let shows;


            function reset() {
                showsById = {};
                shows = [];
                scope.openSeasonEditor = null;
                scope.seasonGroup = [];
                scope.seasonDayList = [];
                scope.slotFilter = "";
                scope.schedule = {
                    period : DAY,
                    lateness : 0,
                    maxDays: 365,
                    flexPreference : "distribute",
                    slots : [],
                    pad: 1,
                    fake: { time: -1 },
                }
 
            }
            reset();

            function loadBackup(backup) {
                scope.schedule = JSON.parse( JSON.stringify(backup) );
                if (typeof(scope.schedule.pad) == 'undefined') {
                    scope.schedule.pad = 1;
                }
                //Schedules written before season settings moved onto the slot
                //carried one entry per show. Fold those onto the slots so the
                //editor shows what the generator will actually do.
                seasonConstraints.adoptShowConstraints(scope.schedule);
                let slots = scope.schedule.slots;
                for (let i = 0; i < slots.length; i++) {
                    let found = false;
                    for (let j = 0; j < scope.showOptions.length; j++) {
                        if (slots[i].showId == scope.showOptions[j].id) {
                            found = true;
                        }
                    }
                    if (! found) {
                        slots[i].showId  = "flex.";
                        slots[i].order = "shuffle";
                    }
                }
                if (typeof(scope.schedule.flexPreference) === 'undefined') {
                    scope.schedule.flexPreference = "distribute";
                }
                if (typeof(scope.schedule.period) === 'undefined') {
                    scope.schedule.period = DAY;
                }
                scope.schedule.fake = {
                    time: -1,
                }
            }

            let getTitle = (slot) => {
                for (let i = 0; i < scope.showOptions.length; i++) {
                    if (scope.showOptions[i].id == slot.showId) {
                        return scope.showOptions[i].description;
                    }
                }
                return "Uknown";
            }
            scope.isWeekly = () => {
                return (scope.schedule.period === WEEK);
            };
            scope.periodChanged = () => {
                if (scope.isWeekly()) {
                    //From daily to weekly
                    let l = scope.schedule.slots.length;
                    for (let i = 0; i < l; i++) {
                        let t = scope.schedule.slots[i].time;
                        scope.schedule.slots[i].time = t % DAY;
                        for (let j = 1; j < 7; j++) {
                            //clone the slot for every day of the week
                            let c = JSON.parse( angular.toJson(scope.schedule.slots[i]) );
                            c.time += j * DAY;
                            scope.schedule.slots.push(c);
                        }
                    }
                } else {
                    //From weekly to daily
                    let newSlots = [];
                    let seen = {};
                    for (let i = 0; i < scope.schedule.slots.length; i++) {
                        let slot = scope.schedule.slots[i];
                        let t = slot.time % DAY;
                        if (seen[t] !== true) {
                            seen[t] = true;
                            newSlots.push(slot);
                        }
                    }
                    scope.schedule.slots = newSlots;
                }
                //The slot list was rebuilt, so anything pointing into the old one
                //is stale.
                scope.openSeasonEditor = null;
                scope.seasonGroup = [];
                scope.seasonDayList = [];
                scope.refreshSlots();
            }
            /*
             * Narrowing the row list. A weekly schedule holds seven copies of every
             * slot - a 48 slot channel becomes 336 rows - so finding the few that
             * need changing is most of the work of changing them.
             *
             * The filtered list is a separate array and the real one is never
             * reordered or reduced by it. Matching runs over the show's display name
             * and the slot's own time label, and every word typed has to appear
             * somewhere in that, so "aqua fri" finds the Friday Aqua Teen rows
             * without having to type the words between.
             */
            scope.visibleSlots = [];

            function slotSearchText(slot) {
                let name = (slot.showId === 'flex.') ? "Flex" : getTitle(slot);
                return ( name + " " + scope.displayTime(slot.time) ).toLowerCase();
            }

            function applyFilter() {
                let terms = (scope.slotFilter || "").toLowerCase().split(/\s+/)
                    .filter( (x) => x !== "" );
                if (terms.length === 0) {
                    scope.visibleSlots = scope.schedule.slots;
                    return;
                }
                scope.visibleSlots = scope.schedule.slots.filter( (s) => {
                    let text = slotSearchText(s);
                    return terms.every( (term) => text.indexOf(term) !== -1 );
                } );
            }
            scope.filterChanged = applyFilter;

            scope.isFiltered = () => {
                return (scope.slotFilter || "").trim() !== "";
            }

            scope.clearFilter = () => {
                scope.slotFilter = "";
                applyFilter();
            }

            /*
             * Rows are addressed by the slot object, not by the position the
             * template happened to render them at. The list can be filtered, so a
             * template $index is a position in the visible subset and acting on it
             * would hit the wrong slot. The time editor serialises what it is given,
             * so the index is resolved here and travels as a number.
             */
            scope.editTime = (slot) => {
                scope._editedTime = {
                    time: slot.time,
                    index : scope.schedule.slots.indexOf(slot),
                    isWeekly : scope.isWeekly(),
                    title : getTitle(slot),
                };
            }
            scope.finishedTimeEdit = (slot) => {
                scope.schedule.slots[slot.index].time = slot.time;
                scope.refreshSlots();
            }
            scope.addSlot = () => {
                scope._addedTime =  {
                    time: 0,
                    index : -1,
                    isWeekly : scope.isWeekly(),
                    title: "New time slot",
                }
            }
            scope.finishedAddingTime = (slot) => {
                scope.schedule.slots.push( {
                    time: slot.time,
                    showId: "flex.",
                    order: "next"
                } );
                //A new slot is Flex, which almost never matches whatever is being
                //filtered for, so it would be added out of sight.
                scope.slotFilter = "";
                scope.refreshSlots();
            }
            scope.displayTime = (t) => {
                if (scope.isWeekly()) {
                    let w =  Math.floor( t / DAY );
                    let t2 = t % DAY;
                    return WEEK_DAYS[w].substring(0,3) + " " + niceLookingTime(t2);

                } else {
                    return niceLookingTime(t);
                }
            }
            scope.timeColumnClass = () => {
                let r = {};
                if (scope.isWeekly()) {
                    r["col-md-3"] = true;
                } else {
                    r["col-md-2"] = true;
                }
                return r;
            }
            scope.programColumnClass = () => {
                let r = {};
                if (scope.isWeekly()) {
                    r["col-md-6"] = true;
                } else {
                    r["col-md-7"] = true;
                }
                return r;
            };
            scope.periodOptions = [
                { id : DAY , description: "Daily" },
                { id : WEEK , description: "Weekly" },
            ]
            scope.latenessOptions = [
                { id: 0 , description: "Do not allow" },
                { id: 5*60*1000, description:  "5 minutes" },
                { id: 10*60*1000 , description:  "10 minutes" },
                { id: 15*60*1000 , description:  "15 minutes" },
                { id: 1*60*60*1000 , description:  "1 hour" },
                { id: 2*60*60*1000 , description:  "2 hours" },
                { id: 3*60*60*1000 , description:  "3 hours" },
                { id: 4*60*60*1000 , description:  "4 hours" },
                { id: 8*60*60*1000 , description:  "8 hours" },
                { id: 24*60*60*1000 , description:  "I don't care about lateness" },
            ];
            scope.flexOptions = [
                { id: "distribute", description: "Between videos" },
                { id: "end", description: "End of the slot" },
            ]

            scope.padOptions = [
                {id: 1, description: "Do not pad" },
                {id: 5*60*1000, description: "0:00, 0:05, 0:10, ..., 0:55" },
                {id: 10*60*1000, description: "0:00, 0:10, 0:20, ..., 0:50" },
                {id: 15*60*1000, description: "0:00, 0:15, 0:30, ..., 0:45" },
                {id: 30*60*1000, description: "0:00, 0:30" },
                {id: 1*60*60*1000, description: "0:00" },
            ];

            scope.showOptions = [];
            scope.orderOptions = [
                { id: "next", description: "Play Next" },
                { id: "shuffle", description: "Shuffle" },
            ];

            let doWait = (millis) => {
                return new Promise( (resolve) => {
                    $timeout( resolve, millis );
                } );
            }

            let doIt = async(fromInstant) => {
                scope.schedule.timeZoneOffset =  (new Date()).getTimezoneOffset();
                let t0 = new Date().getTime();
                let res = await dizquetv.calculateTimeSlots(scope.programs, scope.schedule  );
                let t1 = new Date().getTime();

                let w = Math.max(0, 250 - (t1 - t0) );
                if (fromInstant && (w > 0) ) {
                    await doWait(w);
                }

                res.schedule = scope.schedule;
                delete res.schedule.fake;
                seasonConstraints.clearStartSeasons(res.schedule);
                return res;
            }



            
            let startDialog = (programs, limit, backup, instant) => {
                scope.limit = limit;
                scope.programs = programs;

                reset();
                


                programs.forEach( (p) => {
                    let show = getShow(p);
                    if (show != null) {
                        if (typeof(showsById[show.id]) === 'undefined') {
                            showsById[show.id] = shows.length;
                            shows.push( show );
                        } else {
                            show = shows[ showsById[show.id] ];
                        }
                    }
                } );
                scope.showOptions = shows.map( (show) => { return show } );
                scope.showOptions.push( {
                    id: "flex.",
                    description: "Flex",
                } );
                scope.hadBackup = (typeof(backup) !== 'undefined');
                if (scope.hadBackup) {
                    loadBackup(backup);
                }
                applyFilter();

                scope.visible = true;
                if (instant) {
                    scope.finished(false, true);
                }
            }


            scope.linker( {
                startDialog: startDialog,
            } );

            scope.finished = async (cancel, fromInstant) => {
                scope.error = null;
                if (!cancel) {
                    if ( scope.schedule.slots.length === 0) {
                        scope.onDone(null);
                        scope.visible = false;
                        return;
                    }

                    try {
                        scope.loading = true;
                        $timeout();
                        scope.onDone( await doIt(fromInstant) );
                        scope.visible = false;
                    } catch(err) {
                        console.error("Unable to generate channel lineup", err);
                        scope.error  = "There was an error processing the schedule";
                        return;
                    } finally {
                        scope.loading = false;
                        $timeout();
                    }
                } else {
                    scope.visible = false;
                }
            }

            scope.deleteSlot = (slot) => {
                let i = scope.schedule.slots.indexOf(slot);
                if (i !== -1) {
                    scope.schedule.slots.splice(i, 1);
                    if (scope.openSeasonEditor === slot) {
                        scope.openSeasonEditor = null;
                    }
                    applyFilter();
                }
            }

            scope.hasTimeError = (slot) => {
                return typeof(slot.timeError) !== 'undefined';
            }

            scope.disableCreateLineup = () => {
                if (scope.badTimes) {
                    return true;
                }
                if (typeof(scope.schedule.maxDays) === 'undefined') {
                    return true;
                }
                if (scope.schedule.slots.length == 0) {
                    return true;
                }
                return false;
            }

            scope.hideCreateLineup = () => {
                return (
                    scope.disableCreateLineup()
                    && (scope.schedule.slots.length == 0)
                    && scope.hadBackup
                );
            }
                       
            scope.showResetSlots = () => {
                return scope.hideCreateLineup();
            }

            scope.canShowSlot = (slot) => {
                return (slot.showId != 'flex.') && !(slot.showId.startsWith('redirect.'));
            }

            /*
             * Season settings belong to the slot, so one day of the week can run a
             * different range of a show than another. Slots that ask for the same
             * seasons still share one episode position, which is what lets a
             * weekday block advance as a single thread.
             *
             * The open panel is held by slot reference rather than by index:
             * refreshSlots sorts the array in place, and the objects survive that
             * while their positions do not.
             */
            scope.openSeasonEditor = null;

            scope.seasonsAvailable = (showId) => {
                let seasons = {};
                for (let i = 0; i < scope.programs.length; i++) {
                    let p = scope.programs[i];
                    if (p.type !== 'episode') {
                        continue;
                    }
                    if (getShowData(p).showId !== showId) {
                        continue;
                    }
                    seasons[ (typeof(p.season) === 'number') ? p.season : 0 ] = true;
                }
                return Object.keys(seasons).map( (s) => parseInt(s, 10) ).sort( (a,b) => a - b );
            }

            scope.canConstrainSeasons = (slot) => {
                return scope.canShowSlot(slot)
                    && (slot.order === 'next')
                    && (scope.seasonsAvailable(slot.showId).length > 1);
            }

            scope.seasonsDisabledReason = (slot) => {
                if (! scope.canShowSlot(slot)) {
                    return "";
                }
                if (slot.order === 'shuffle') {
                    return "Season settings apply to Play Next only. Shuffle stores its position "
                         + "in a way that changes meaning when the episode count changes.";
                }
                return "";
            }

            //Read-only, and safe to call from the template: it will not create
            //the settings it is asked about.
            scope.seasonsOf = (slot) => {
                return seasonConstraints.read(slot);
            }

            scope.hasSeasonConstraint = (slot) => {
                return seasonConstraints.isConstrained(slot);
            }

            /*
             * Which days an edit writes to.
             *
             * A weekly schedule is built by cloning each slot across the seven
             * days, so the rows meaning "this show, at this time" are the ones
             * sharing a time of day. Editing seasons one row at a time makes the
             * common case - a range for the weekdays and another for Friday - five
             * separate edits found among hundreds of rows.
             *
             * The group starts as the days whose slot already asks for the same
             * seasons. Fresh clones all match, so they keep moving together until a
             * day is deliberately peeled off. Joining a day gives it the current
             * range right away, so what is selected and what is stored never
             * disagree. Leaving a day is not destructive: it keeps the range it has
             * and simply stops following.
             */
            scope.seasonGroup = [];
            scope.seasonDayList = [];

            let dayOf = (slot) => {
                return Math.floor(slot.time / DAY);
            }

            let siblingOnDay = (slot, day) => {
                let t = slot.time % DAY;
                for (let i = 0; i < scope.schedule.slots.length; i++) {
                    let s = scope.schedule.slots[i];
                    if ( (s.showId === slot.showId) && (s.order === slot.order)
                         && ( (s.time % DAY) === t ) && (dayOf(s) === day) ) {
                        return s;
                    }
                }
                return null;
            }

            //Rebuilt on open and on change rather than from the template, because
            //ng-repeat over a function returning fresh objects re-renders on every
            //digest.
            let rebuildSeasonDays = () => {
                let slot = scope.openSeasonEditor;
                scope.seasonDayList = [];
                if ( (slot === null) || ! scope.isWeekly() ) {
                    return;
                }
                for (let day = 0; day < 7; day++) {
                    let s = siblingOnDay(slot, day);
                    scope.seasonDayList.push( {
                        day: day,
                        name: WEEK_DAYS[day].substring(0,3),
                        available: (s !== null),
                        selected: (s !== null) && (scope.seasonGroup.indexOf(day) !== -1),
                        isSelf: (s === slot),
                    } );
                }
            }

            //Every slot the open panel writes to. Outside a weekly schedule there
            //are no sibling days, so this is just the slot itself.
            let groupSlots = (slot) => {
                if (! scope.isWeekly() ) {
                    return [ slot ];
                }
                let r = [];
                for (let i = 0; i < scope.seasonGroup.length; i++) {
                    let s = siblingOnDay(slot, scope.seasonGroup[i]);
                    if ( (s !== null) && (r.indexOf(s) === -1) ) {
                        r.push(s);
                    }
                }
                if (r.indexOf(slot) === -1) {
                    r.push(slot);
                }
                return r;
            }

            let spreadToGroup = (slot) => {
                let group = groupSlots(slot);
                for (let i = 0; i < group.length; i++) {
                    seasonConstraints.copyRange(slot, group[i]);
                }
            }

            //The panel asks this on every digest. The group always holds the edited
            //slot's own day, so the selection length is the answer and there is no
            //need to walk the slot list for it.
            scope.seasonGroupSize = () => {
                return scope.isWeekly() ? scope.seasonGroup.length : 1;
            }

            scope.toggleSeasonDay = (slot, entry) => {
                //The row being edited is always written to, so its own day cannot
                //be switched off.
                if (! entry.available || entry.isSelf) {
                    return;
                }
                let i = scope.seasonGroup.indexOf(entry.day);
                if (i === -1) {
                    scope.seasonGroup.push(entry.day);
                    seasonConstraints.copyRange( slot, siblingOnDay(slot, entry.day) );
                } else {
                    scope.seasonGroup.splice(i, 1);
                }
                rebuildSeasonDays();
                scope.refreshSlots();
            }

            scope.selectAllSeasonDays = (slot) => {
                for (let day = 0; day < 7; day++) {
                    let s = siblingOnDay(slot, day);
                    if (s === null) {
                        continue;
                    }
                    if (scope.seasonGroup.indexOf(day) === -1) {
                        scope.seasonGroup.push(day);
                    }
                    seasonConstraints.copyRange(slot, s);
                }
                rebuildSeasonDays();
                scope.refreshSlots();
            }

            //Narrow to the row being edited without touching what the other days
            //already hold.
            scope.selectOnlyThisDay = (slot) => {
                scope.seasonGroup = [ dayOf(slot) ];
                rebuildSeasonDays();
            }

            scope.toggleSeasonEditor = (slot) => {
                if (scope.openSeasonEditor === slot) {
                    scope.openSeasonEditor = null;
                    scope.seasonGroup = [];
                    scope.seasonDayList = [];
                    return;
                }
                scope.openSeasonEditor = slot;
                scope.seasonGroup = [];
                if (scope.isWeekly()) {
                    for (let day = 0; day < 7; day++) {
                        let s = siblingOnDay(slot, day);
                        if ( (s !== null) && seasonConstraints.sameRange(s, slot) ) {
                            scope.seasonGroup.push(day);
                        }
                    }
                }
                rebuildSeasonDays();
            }

            scope.isSeasonExcluded = (slot, season) => {
                return seasonConstraints.read(slot).excludeSeasons.indexOf(season) !== -1;
            }

            scope.toggleSeason = (slot, season) => {
                let c = seasonConstraints.edit(slot);
                let i = c.excludeSeasons.indexOf(season);
                if (i === -1) {
                    c.excludeSeasons.push(season);
                } else {
                    c.excludeSeasons.splice(i, 1);
                }
                seasonConstraints.tidy(slot);
                spreadToGroup(slot);
                rebuildSeasonDays();
                scope.refreshSlots();
            }

            scope.setStartSeason = (slot, season) => {
                let c = seasonConstraints.edit(slot);
                if ( (season === null) || (typeof(season) === 'undefined') ) {
                    delete c.startSeason;
                } else {
                    c.startSeason = season;
                }
                seasonConstraints.tidy(slot);
                spreadToGroup(slot);
                rebuildSeasonDays();
                scope.refreshSlots();
            }

            //Slots naming the same show with the same seasons advance one
            //position between them, so the panel can say how many it is setting.
            scope.slotsSharingPosition = (slot) => {
                return seasonConstraints.sharingPosition(scope.schedule.slots, slot);
            }

            scope.refreshSlots = () => {
                scope.badTimes = false;
                applyFilter();
                //"Bubble sort ought to be enough for anybody"
                for (let i = 0; i < scope.schedule.slots.length; i++) {
                    for (let j = i+1; j < scope.schedule.slots.length; j++) {
                        if (scope.schedule.slots[j].time< scope.schedule.slots[i].time) {
                            let x = scope.schedule.slots[i];
                            scope.schedule.slots[i] = scope.schedule.slots[j];
                            scope.schedule.slots[j] = x;
                        }
                    }
                    if (scope.schedule.slots[i].showId == 'movie.') {
                        scope.schedule.slots[i].order = "shuffle";
                    }
                }
                for (let i = 0; i < scope.schedule.slots.length; i++) {
                    if (
                        (i > 0 && (scope.schedule.slots[i].time == (scope.schedule.slots[i-1].time) ) )
                        || ( (i+1 < scope.schedule.slots.length) && (scope.schedule.slots[i].time == (scope.schedule.slots[i+1].time) ) )
                    ) {
                        scope.badTimes = true;
                        scope.schedule.slots[i].timeError = "Please select a unique time.";
                    } else {
                        delete scope.schedule.slots[i].timeError;
                    }
                }
                $timeout();
            }



        }
    };


    function getShow(program) {

        let d = getShowData(program);
        if (! d.hasShow) {
            return null;
        } else {
            d.description = d.showDisplayName;
            d.id = d.showId;
            return d;
        }
    }



}

function niceLookingTime(t) {
    let d = new Date(t);
    d.setMilliseconds(0);

    return d.toLocaleTimeString( [] , {timeZone: 'UTC' } );
}

