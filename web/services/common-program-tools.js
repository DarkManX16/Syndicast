//This is an exact copy of the file with the same now in the nodejs
//one of these days, we'll figure out how to share the code.
module.exports = function (getShowData) {

    // The channel programming list's one-line row is given exactly this
    // height (both the CSS, via an inline style bound to this same value,
    // and vs-repeat's `{size: ...}`) so the two can never drift apart -
    // NOTES.md > "Program rows show the episode title" has the bug that came
    // from a CSS height and a hardcoded vs-repeat size disagreeing per row
    // type. test/program-row-heights.js renders the row for real and fails
    // if its measured height doesn't match this constant.
    const PROGRAM_SCHEDULE_ROW_HEIGHT = 26;

    // The same idea for the custom show editor and filler lists: one line per
    // row, every row exactly this tall, and the row's inline height and
    // vs-repeat's `{size: ...}` both read this one value. A custom show's
    // slot-fit gauge is a thin bar along the row's bottom edge, positioned
    // absolutely, so it has no way to add to the height.
    const CONTENT_LIST_ROW_HEIGHT = 26;


    /*** Input: list of programs
     * output: sorted list of programs */
    function sortShows(programs) {
        let shows = {}
        let movies = [] //not exactly accurate name
        let newProgs = []
        let progs = programs
        for (let i = 0, l = progs.length; i < l; i++) {
            let showData = getShowData( progs[i] );
            if ( showData.showId === 'movie.' || ! showData.hasShow ) {
                movies.push(progs[i]);
            } else {
                if (typeof shows[showData.showId] === 'undefined') {
                    shows[showData.showId] = [];
                }
                shows[showData.showId].push(progs[i]);
            }
        }
        let keys = Object.keys(shows)
        for (let i = 0, l = keys.length; i < l; i++) {
            shows[keys[i]].sort((a, b) => {
                let aData = getShowData(a);
                let bData = getShowData(b);
                return aData.order - bData.order;
            })
            newProgs = newProgs.concat(shows[keys[i]])
        }
        movies.sort( (a,b) => {
            if (a.title === b.title) {
                return 0;
            } else if (a.title < b.title) {
                return -1;
            } else {
                return 1;
            }
        } );
        return newProgs.concat(movies);
    }

    function shuffle(array, lo, hi ) {
        if (typeof(lo) === 'undefined') {
            lo = 0;
            hi = array.length;
        }
        let currentIndex = hi, temporaryValue, randomIndex
        while (lo !== currentIndex) {
            randomIndex = lo + Math.floor(Math.random() * (currentIndex -lo) );
            currentIndex -= 1
            temporaryValue = array[currentIndex]
            array[currentIndex] = array[randomIndex]
            array[randomIndex] = temporaryValue
        }
        return array
    }


    let removeDuplicates = (progs) => {
        let tmpProgs = {}
        for (let i = 0, l = progs.length; i < l; i++) {
            if ( progs[i].type ==='redirect' ) {
                tmpProgs['_redirect ' + progs[i].channel + ' _ '+ progs[i].duration ] = progs[i];
            } else {
                let data = getShowData(progs[i]);
                if (data.hasShow) {
                    let key = data.showId + "|" + data.order;
                    if (typeof(tmpProgs[key]) === 'undefined') {
                        tmpProgs[key] = progs[i];
                    }
                }
            }
        }
        let newProgs = [];
        let keys = Object.keys(tmpProgs);
        for (let i = 0, l = keys.length; i < l; i++) {
            newProgs.push(tmpProgs[keys[i]])
        }
        return newProgs;
    }

    let removeSpecials = (progs) => {
        let tmpProgs = []
        for (let i = 0, l = progs.length; i < l; i++) {
            if (
                (typeof(progs[i].customShowId) !== 'undefined')
                ||
                (progs[i].season !== 0)
            ) {
                tmpProgs.push(progs[i]);
            }
        }
        return tmpProgs;
    }

    let getProgramDisplayTitle = (x) => {
        let s = x.type === 'episode' ? x.showTitle + ' - S' + x.season.toString().padStart(2, '0') + 'E' + x.episode.toString().padStart(2, '0') : x.title
        if (typeof(x.customShowId) !== 'undefined') {
            s = x.customShowName + " X" + (x.customOrder+1).toString().padStart(2,'0') + " (" + s + ")";
        }
        return s;
    }

    let sortByDate = (programs) => {
        programs.sort( (a,b) => {
            let aHas = ( typeof(a.date) !== 'undefined' );
            let bHas = ( typeof(b.date) !== 'undefined' );
            if (!aHas && !bHas) {
                return 0;
            } else if (! aHas) {
                return 1;
            } else if (! bHas) {
                return -1;
            }
            if (a.date < b.date ) {
                return -1;
            } else if (a.date > b.date) {
                return 1;
            } else {
                let aHasSeason = ( typeof(a.season) !== 'undefined' );
                let bHasSeason = ( typeof(b.season) !== 'undefined' );
                if (! aHasSeason && ! bHasSeason) {
                    return 0;
                } else if (! aHasSeason) {
                    return 1;
                } else if (! bHasSeason) {
                    return -1;
                }
                if (a.season < b.season) {
                    return -1;
                } else if (a.season > b.season) {
                    return 1;
                } else if (a.episode < b.episode) {
                    return -1;
                } else if (a.episode > b.episode) {
                    return 1;
                } else {
                    return 0;
                }
            }
        });
        return programs;
    }

    // Just the color/pattern a program's identity hashes to - no duration
    // encoding. Split out of programSquareStyle so the custom show editor and
    // filler lists can show a plain color swatch while the older duration-width
    // square (still used by the channel programming list) keeps its own
    // behavior untouched.
    let programColorStyle = (program) => {
        let background ="";
        if  ( (program.isOffline) && (program.type !== 'redirect') ) {
            background = "rgb(255, 255, 255)";
        } else {
            let r = 0, g = 0, b = 0, r2=0, g2=0,b2=0;
            let angle = 45;
            let w = 3;
            if (program.type === 'redirect') {
                angle = 0;
                w = 4 + (program.channel % 10);
                let c = (program.channel * 100019);
                //r = 255, g = 0, b = 0;
                //r2 = 0, g2 = 0, b2 = 255;

                r = ( (c & 3) * 77 );
                g = ( ( (c >> 1) & 3) * 77 );
                b = ( ( (c >> 2) & 3) * 77 );
                r2 = ( ( (c >> 5) & 3) * 37 );
                g2 = ( ( (c >> 3) & 3) * 37 );
                b2 = ( ( (c >> 4) & 3) * 37 );
            } else if ( typeof(program.customShowId) !== 'undefined') {
                let h = Math.abs( getHashCode(program.customShowId, false));
                let h2 = Math.abs( getHashCode(program.customShowId, true));
                r = h % 256;
                g = (h / 256) % 256;
                b = (h / (256*256) ) % 256;
                r2 = (h2 / (256*256) ) % 256;
                g2 = (h2 / (256*256) ) % 256;
                b2 = (h2 / (256*256) ) % 256;
                angle = (360 - 90 + h % 180) % 360;
                if ( angle >= 350 || angle < 10 ) {
                    angle += 53;
                }

            } else if (program.type === 'episode') {
                let h = Math.abs( getHashCode(program.showTitle, false));
                let h2 = Math.abs( getHashCode(program.showTitle, true));
                r = h % 256;
                g = (h / 256) % 256;
                b = (h / (256*256) ) % 256;
                r2 = (h2 / (256*256) ) % 256;
                g2 = (h2 / (256*256) ) % 256;
                b2 = (h2 / (256*256) ) % 256;
                angle = (360 - 90 + h % 180) % 360;
                if ( angle >= 350 || angle < 10 ) {
                    angle += 53;
                }
            } else if (program.type === 'track') {
                r = 10, g = 10, b = 10;
                r2 = 245, g2 = 245, b2 = 245;
                angle = 315;
                w = 2;
            } else {
                r = 10, g = 10, b = 10;
                r2 = 245, g2 = 245, b2 = 245;
                angle = 45;
                w = 6;
            }
            let rgb1 = "rgb("+ r + "," + g + "," + b +")";
            let rgb2 = "rgb("+ r2 + "," + g2 + "," + b2 +")"
            angle += 90;
            background = "repeating-linear-gradient( " + angle + "deg, " + rgb1 + ", " + rgb1 + " " + w + "px, " + rgb2 + " " + w + "px, " + rgb2 + " " + (w*2) + "px)";

        }
        return background;
    }

    let programSquareStyle = (program) => {
        let background = programColorStyle(program);
        let f = interpolate;
        let w = 15.0;
        let t = 4*60*60*1000;
        //let d = Math.log( Math.min(t, program.duration) ) / Math.log(2);
        //let a = (d * Math.log(2) ) / Math.log(t);
        let a = ( f(program.duration) *w) / f(t);
        a = Math.min( w, Math.max(0.3, a) );
        b = w - a + 0.01;

        return {
            'width': `${a}%`,
            'height': '1.3em',
            'margin-right': `${b}%`,
            'background': background,
            'border': '1px solid black',
            'margin-top': "0.01em",
            'margin-bottom': '1px',
        };
    }
    let getHashCode = (s, rev) => {
        var hash = 0;
        if (s.length == 0) return hash;
        let inc = 1, st = 0, e = s.length;
        if (rev) {
            inc = -1, st = e - 1, e = -1;
        }
        for (var i = st; i != e; i+= inc) {
            hash = s.charCodeAt(i) + ((hash << 5) - hash);
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash;
    }

    let interpolate = ( () => {
        let h = 60*60*1000;
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

    // m:ss under an hour, h:mm:ss at or above it - schedule to the second,
    // never rounded to a minute.
    let exactDurationString = (ms) => {
        if (typeof(ms) !== 'number' || isNaN(ms) || ms < 0) {
            return 'Unknown';
        }
        let totalSeconds = Math.floor(ms / 1000);
        let h = Math.floor(totalSeconds / 3600);
        let m = Math.floor((totalSeconds % 3600) / 60);
        let s = totalSeconds % 60;
        let ss = s.toString().padStart(2, '0');
        if (h > 0) {
            return h + ':' + m.toString().padStart(2, '0') + ':' + ss;
        }
        return m + ':' + ss;
    }

    // A program's absolute scheduled date/time - moved here from
    // channel-config.js's own dateForGuide so it can be shared rather than
    // duplicated.
    let startTimeString = (date) => {
        let t = date.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        if (t.charCodeAt(1) == 58) {
            t = "0" + t;
        }
        return date.toLocaleDateString(undefined, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }) + " " + t;
    }

    // The same absolute start time, compact - "9/28 2:00:00a" - for the
    // channel programming list's one-line-per-row layout, which has no room
    // for startTimeString's full "MM/DD/YYYY hh:mm:ss AM". No leading zero on
    // month/day/hour, and am/pm collapses to one trailing letter.
    let shortStartTimeString = (date) => {
        let hours24 = date.getHours();
        let ampm = hours24 < 12 ? 'a' : 'p';
        let hours12 = hours24 % 12;
        if (hours12 === 0) {
            hours12 = 12;
        }
        let minutes = date.getMinutes().toString().padStart(2, '0');
        let seconds = date.getSeconds().toString().padStart(2, '0');
        return (date.getMonth() + 1) + '/' + date.getDate() + ' ' +
            hours12 + ':' + minutes + ':' + seconds + ampm;
    }

    // Coarse total for a list header - runtimes here can run into days, where
    // exactDurationString's h:mm:ss would just be unreadable.
    let longDurationString = (ms) => {
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

    // Smallest standard slot a program fits in: 15 and 30 minutes for split
    // half-episodes, then every half hour above that with no ceiling, the way
    // a 2h15m movie schedules into a 150-min slot rather than being capped.
    let slotFitGauge = (program) => {
        let ms = program.duration;
        if (typeof(ms) !== 'number' || isNaN(ms) || ms <= 0) {
            return null;
        }
        const MIN = 60 * 1000;
        let slotMinutes;
        if (ms <= 15 * MIN) {
            slotMinutes = 15;
        } else if (ms <= 30 * MIN) {
            slotMinutes = 30;
        } else {
            slotMinutes = Math.ceil(ms / (30 * MIN)) * 30;
        }
        let slotMs = slotMinutes * MIN;
        let breaksMs = Math.max(0, slotMs - ms);
        let fillPercent = Math.max(0, Math.min(100, (ms / slotMs) * 100));
        return {
            slotMinutes: slotMinutes,
            fillPercent: fillPercent,
            breaksMs: breaksMs,
            label: slotMinutes + '-min slot · ' + exactDurationString(breaksMs) + ' for breaks',
        };
    }

    // The channel programming list's one-line row - each function reads one
    // field off a program (a schedule item: an episode/movie/track, or an
    // offline Flex/redirect placeholder) with nothing else to close over,
    // which is what lets test/program-row-heights.js drive them directly to
    // build realistic fixture rows instead of guessing at their output.
    let rowStartTime = (x) => {
        return (x && x.start) ? shortStartTimeString(x.start) : '';
    }
    let rowDuration = (x) => {
        return x ? exactDurationString(x.duration) : '';
    }
    // The show/album name - blank for Flex and redirect, which use
    // rowOfflineLabel instead. A custom show's own name is prefixed on top,
    // the one thing about a placed clip that isn't already implied by being
    // in this list.
    let rowShow = (x) => {
        if (!x || x.isOffline) {
            return '';
        }
        let name = (x.type === 'episode' || x.type === 'track') ? x.showTitle : x.title;
        if (typeof(x.customShowId) !== 'undefined') {
            name = x.customShowName + ' · ' + name;
        }
        return name;
    }
    let rowTag = (x) => {
        if (!x || x.isOffline) {
            return '';
        }
        if (x.type === 'episode') {
            return 'S' + x.season + ' · E' + x.episode;
        }
        if (x.type === 'track') {
            if (typeof(x.season) === 'number' && x.season > 1) {
                return 'Disc ' + x.season + ' · Track ' + x.episode;
            }
            return 'Track ' + x.episode;
        }
        return '';
    }
    // The episode/track title, or a movie's year - blank for anything else,
    // since rowShow already said everything it has.
    let rowTitle = (x) => {
        if (!x || x.isOffline) {
            return '';
        }
        if (x.type === 'episode' || x.type === 'track') {
            return x.title;
        }
        if (x.type === 'movie' && typeof(x.year) !== 'undefined' && x.year !== null) {
            return String(x.year);
        }
        return '';
    }
    let rowOfflineLabel = (x) => {
        if (!x || !x.isOffline) {
            return '';
        }
        return (x.type === 'redirect') ? ('Redirect to channel: ' + x.channel) : 'Flex';
    }
    // The real break the Flex/redirect run right after this program adds up
    // to (channel-config.js's updateChannelDuration computes $breakAfterMs)
    // - blank when the next item is another program, or for an offline row
    // itself, which is the break rather than something with one after it.
    let rowBreakAfter = (x) => {
        if (!x || x.isOffline || typeof(x.$breakAfterMs) !== 'number' || x.$breakAfterMs <= 0) {
            return '';
        }
        return 'break after ' + exactDurationString(x.$breakAfterMs);
    }

    // The custom show editor's slot-fit gauge, split into the two things its
    // row shows: the "for breaks" text as a small tag at the right end, and
    // how full the slot is as a thin bar along the row's bottom edge.
    // slotFitGauge already returns null for a program with no usable
    // duration, which means neither is drawn.
    let rowSlotLabel = (x) => {
        let gauge = x ? slotFitGauge(x) : null;
        return gauge ? gauge.label : '';
    }
    let rowSlotFillPercent = (x) => {
        let gauge = x ? slotFitGauge(x) : null;
        return gauge ? gauge.fillPercent : 0;
    }
    // A filler list's one name per row: the episode or track gets its show
    // and its own title, anything else (a clip, a movie) is just its title.
    let rowFillerName = (x) => {
        if (!x) {
            return '';
        }
        if ((x.type === 'episode' || x.type === 'track') && x.showTitle) {
            return x.showTitle + ' · ' + x.title;
        }
        return x.title;
    }

    return {
        sortShows: sortShows,
        shuffle: shuffle,
        removeDuplicates: removeDuplicates,
        removeSpecials: removeSpecials,
        sortByDate: sortByDate,
        getProgramDisplayTitle: getProgramDisplayTitle,
        programSquareStyle: programSquareStyle,
        programColorStyle: programColorStyle,
        exactDurationString: exactDurationString,
        longDurationString: longDurationString,
        startTimeString: startTimeString,
        shortStartTimeString: shortStartTimeString,
        slotFitGauge: slotFitGauge,
        programScheduleRowHeight: PROGRAM_SCHEDULE_ROW_HEIGHT,
        contentListRowHeight: CONTENT_LIST_ROW_HEIGHT,
        rowStartTime: rowStartTime,
        rowDuration: rowDuration,
        rowShow: rowShow,
        rowTag: rowTag,
        rowTitle: rowTitle,
        rowOfflineLabel: rowOfflineLabel,
        rowBreakAfter: rowBreakAfter,
        rowSlotLabel: rowSlotLabel,
        rowSlotFillPercent: rowSlotFillPercent,
        rowFillerName: rowFillerName,
    }

}