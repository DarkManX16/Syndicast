# Notes

## Feature roadmap

Intended work, mostly a statement of direction rather than of state. **An
unticked box is not built.** A ticked one is, and says what actually shipped,
which is not always the whole of what the line originally asked for. The Known
issues section below is separate and covers defects in what already ships.

### Blocks system

The original reason for the fork.

- [ ] Timed Flex Blocks - time-scoped filler switching by time of day and day of week
- [ ] Transition bumpers: "we'll be right back", "back to the show", "up next", per series
      and per block
- [ ] Slot filler positions (HEAD / PRE / MID / POST / TAIL)
- [ ] Midrolls
- [ ] Block schedule manager

### Scheduling

- [x] Season exclusion / season start, per slot, for Play Next
- [x] Setting a season range across a group of slots in one go, and a filter for
      finding the slots to set it on
- [ ] Sign-ons and sign-offs
- [ ] Random slot pad times below their duration
- [ ] Chapter and segment detector, to split episodes and insert bumpers between segments
- [ ] Rerun
- [ ] Per-position stored progress, which also lets a secondary Play Next range
      continue across a regeneration instead of restarting
- [ ] Shuffle - *blocked on per-position stored progress*
- [ ] Ordered shuffle - *blocked on per-position stored progress*

Orderers are no longer keyed by show. `getShowOrderer` keys them by show plus
the seasons asked for, so slots wanting different ranges of one show get
different episode positions while slots wanting the same range still advance
together. That was the half of the blocker the three items shared; what is left
for the two shuffle ones is somewhere to keep progress per position. That work
also fixes a rough edge in what already ships, so it is one item rather than
two - see the per-position stored progress entry under Known issues.

Grouped editing was the cost of per-slot settings meeting a weekly period.
Switching a schedule from daily to weekly clones every slot across seven days,
so a 48 slot channel becomes 336 rows, and setting one show's range for Monday
through Thursday meant finding and editing four of them by hand. The season
panel now carries a day picker, and the row list a filter. See the slot editing
entry under Known issues for why the picker works on times of day rather than
on shows.

### Media handling

- [ ] Per-channel transcoding configs, so channels can use different video and audio formats
- [ ] Fix NVIDIA / h264_nvenc encoder issues
- [ ] Aspect ratio stretch without having to disable "normalize resolution"
- [ ] Fix very short items repeating or being skipped next to Flex

      Items under roughly 20 seconds, placed adjacent to Flex in the lineup,
      either play about three times over or get skipped entirely. This is a
      playback problem, not a filler-selection one: the 1.6.0 filler algorithm
      does not touch it, and it happens to items already placed in the
      programming rather than to items being chosen. Most likely in the concat
      or transition handling, where a very short item interacts badly with the
      black-frame interlude and the buffer boundaries. Reproduce with a
      deliberately short item next to Flex before attempting any fix -
      guessing at the layer here would be expensive.

### Library management

- [ ] Swap out episodes of a show, and plug library items in anywhere
- [ ] Info panel and thumbnail per item
- [ ] Jellyfin as a media source

### Interface

- [ ] Profiles for specific looks
- [ ] Custom TV guides
- [ ] UI customization and cosmetic theming
- [ ] Channel detail page: now playing with progress, total runtime, program count,
      stream mode and transcode config, plus a library browsable by type - movies,
      shows, artists, music videos, other - with durations and artwork

The channel detail page is mostly display layer over data the API already returns,
so it carries little risk to existing behaviour. The one real constraint is scale:
a channel here already holds 9712 programs, so artwork needs lazy loading rather
than rendering every tile up front. It should be drawn to Syndicast's own identity
rather than copying the layout of other projects.

### Infrastructure

- [ ] Public channel sharing without exposing an IP
- [ ] Easier version updates
- [ ] Fix random crashes during streaming
- [ ] Fix time slots breaking across daylight savings
- [ ] Keep a safer version of editing the ffmpeg path in the UI

## Known issues / future work

### Rebrand artwork does not reach existing installs

The branding kit replaces the images in `resources/`, but the app copies those
into the data folder (`.syndicast` / `.dizquetv`) on startup and only when the
file is missing. An existing install therefore keeps showing the old artwork
after a rebrand: the header logo and the on-air screens for error, offline,
music, and loading.

Affects `initDB()` in `index.js`. Workaround is to delete the stale files from
`<data folder>/images/` and restart, which recreates them from `resources/`.
Worth deciding whether the app should overwrite these on version change, or
leave it manual so users keep any artwork they replaced themselves.

### Guide requests an unresolved Angular binding when no channels exist

With no channels configured, the browser issues a request for the literal
string `{{channels[channelNumber].icon}}` and gets a 404. The binding in
`web/public/views/guide.html` is never resolved because there is no channel to
bind to, so the placeholder is used as an image URL.

Pre-existing dizqueTV behaviour, not introduced by the rebrand. Harmless today
(one failed request on an empty guide) but it pollutes the network log and
would confuse anyone debugging a real image problem. Needs an `ng-if` or
equivalent guard.

There is a second one, in the watermark preview at
`web/public/templates/channel-config.html`:

```html
<img src='{{ getWatermarkSrc() }}' ...>
```

which requests `/%7B%7B%20getWatermarkSrc()%20%7D%7D`. Both are the same
mistake - a plain `src` carrying an interpolation, which the browser resolves
before Angular does - so `ng-src` is the real fix for both, and the
empty-channel explanation above only describes when the first one is most
visible.

### Branding script counts the same file more than once

`syndicast-branding/apply-branding.js` tracks written files in a `Set`, but
builds paths two different ways: some edits use literals such as
`src/hdhr.js`, while `walk()` uses `path.join()`, which produces `src\hdhr.js`
on Windows. The two spellings are distinct set members, so the final report
double-counts. It printed "46 files written" for 42 actual files and listed
four of them twice.

Cosmetic only, and the edits themselves are applied correctly. Fix is to
normalise separators before adding to the set.

### ffmpegPathLockDate reads backwards, and clearing it locks harder

`isLocked()` in `src/services/ffmpeg-settings-service.js` treats a date in the
**past** as locked and a date in the **future** as unlocked, which is the
opposite of how the field name reads. `unlock()` correspondingly sets the date
to `now + 24h`.

The trap: clearing the field does not unlock it. `isNaN(undefined)` is true, so
a missing value takes the locked branch. Same for `null`. The only supported
way to unlock is starting with the `--unlock` flag, which is easy to miss since
nothing in the UI mentions it.

Worth renaming to something like `ffmpegPathUnlockedUntil`, and surfacing the
unlock route in the settings page instead of leaving it a CLI-only affordance.

### Windows NAT can grab port 18000, giving EACCES with nothing listening

`node index.js -p 18000` fails with `EACCES` while the port looks completely
free: nothing is listening, it is absent from
`netsh int ipv4 show excludedportrange protocol=tcp` (which lists only
50000-50059), and it sits outside the dynamic range of 1024 plus 13977.

The cause is the Windows NAT service reserving port ranges for Hyper-V, WSL
and Docker. Those reservations do not appear in the usual places, which is why
every check says the port is available. Restarting the service releases them,
from an elevated prompt:

```
net stop winnat
net start winnat
```

It can reclaim the range again later, so this may need repeating. 18080,
19000, 17000, 8123 and 9500 were all free when 18000 was not, and development
moved to 18080. `.claude/launch.json` and the README still say 18000
deliberately, since the reservation is transient. Confirm with a bind test
rather than assuming:

```js
require('net').createServer().listen(18000, '0.0.0.0')
```

### Shuffle progress is stored, and it is seeded over the candidate count

Worth stating plainly because the two orderers in `show-orderers.js` differ and
the difference is easy to miss.

*Play Next* keeps no stored position. `getShowOrderer` rediscovers it each run by
scanning the sorted episode list for `show.founder`, which is just the first
program of that show in the channel's current lineup. Nothing persists.

Having nothing to persist is what let per-slot season settings ship without new
state, and it is also where they are weakest. A show can now carry several
positions but still has exactly one founder, so at most one of them resumes on
the founder itself; the rest fall to the "nearest episode forward" branch and
resume at the start of the range they are allowed. That is stable and
repeatable - re-running the tool twice gives the same answer - but which
position gets the exact match depends on which slot happens to come first in
the previous lineup. Every other range restarts at its own beginning instead of
continuing. Fixing that needs somewhere to record progress per position, which
is the same thing constrained shuffle needs - see the next entry.

*Shuffle* does persist. `getShowShuffler` writes its cursor onto every program it
emits:

```js
prog.shuffleOrder = position;
```

That program goes into the lineup and is saved with the channel. The permutation
is seeded from the show id plus a generation number, where the generation is
`Math.floor(position / n)` and `n` is the number of candidate episodes.

So a saved `shuffleOrder` only means anything relative to the `n` it was produced
under. Change the candidate count - which is exactly what a season filter does -
and the same number selects a different episode, silently. Measured with twelve
episodes against the same saved position of 7:

    all 12 episodes   : S3E4 -> S1E1 -> S3E2 -> S3E3 -> S3E1
    season 2 removed  : S3E3 -> S3E4 -> S3E2 -> S1E2 -> S1E1

This is why season settings are Play Next only. Constrained shuffle is not a
filter on top of the existing mechanism; it needs a progress representation that
survives `n` changing, or an explicit decision to reshuffle when constraints
change. The control stays disabled for shuffle slots, with that reason in its
tooltip.

### Per-position stored progress, which fixes two things at once

Two defects above look unrelated and are not. Both should be fixed by one piece
of work, and doing either alone is a false economy.

The defects:

- A Play Next slot asking for a range other than the one the founder falls in
  restarts at the beginning of its range every time the lineup is regenerated,
  rather than continuing. Only one range per show can resume exactly, because a
  show has one founder and several positions.
- Constrained shuffle cannot ship at all, because `shuffleOrder` is an index
  into a permutation of `n` items and a season filter changes `n`.

What they share is the absence of anywhere to put progress that belongs to a
*position* rather than to a show. The founder is per show. `shuffleOrder` is
per program but means nothing without the `n` it was produced under. Neither
survives one show carrying several ranges.

So the same three decisions serve both:

- **Key.** `(showId, constraintKey(constraint))` - the key already exists, in
  `show-orderers.js`, and already groups slots the way progress would need to be
  grouped.
- **Storage.** The schedule is the honest place. It already round-trips as
  `channel.scheduleBackup`, and unlike program tags it does not get thinned by
  `removeDuplicates`, which keys on `showId|order` and would silently drop one
  range's record whenever two ranges overlap on an episode. The cost is that the
  services would have to return the updated schedule and the editors merge it
  back, instead of the editor overwriting with its own copy as `doIt` does now.
- **Shape.** Episode identity, never an index. `getShowData(p).order` is
  `season * 1000000 + episode` and stays meaningful when the candidate set
  changes, which is exactly the property `shuffleOrder` lacks.

The payloads differ, and that is the whole of the difference: Play Next needs
the last episode emitted, shuffle needs the set already emitted this pass plus
the seed, so an unplayed candidate can be picked deterministically without
re-deriving a permutation over a count that has moved.

Build them together. Whichever ships first will pick the key, the storage and
the invalidation rule for the other, and if the second is added later against a
different representation the channel ends up carrying two disagreeing records of
where a show is. That is a worse bug than either of the ones being fixed.

### Editing slots when there are hundreds of them

Two decisions in the slot editors are worth stating, because both look
arbitrary until the alternative is spelled out.

**The day picker groups by time of day, not by show.** A weekly schedule is
built by cloning each slot across the seven days, so the rows that mean "this
show, at this time" are the ones sharing a time of day. Grouping by show
instead would sweep in a second, unrelated airing - a show at 08:00 and again
at 20:00 - and there is no way to tell from the data which of those the user
meant. Same time of day is the set the clone actually created, so it is the one
that can be explained in a sentence.

The group opens holding the days that already ask for the same seasons, which
for untouched clones is all seven. Joining a day copies the current range onto
it immediately, so the selection and the stored data never disagree. Leaving a
day is deliberately not destructive: it keeps whatever range it has and just
stops following.

**Rows are addressed by the slot object, never by a template `$index`.** Under
a filter, `$index` is a position in the visible subset, so `deleteSlot($index)`
on the second visible row of a filtered list would delete the second row of the
*full* list. Measured before the change: filtering to the three Friday Aqua
Teen rows and deleting the second would have removed Thursday's 12:30 Futurama
slot instead.

The awkward case is the time editor, which serialises the object it is handed
(`onDone(JSON.parse(angular.toJson(slot)))`), so a slot reference cannot
survive the round trip. `editTime` therefore resolves the real index from the
slot and sends that number, rather than letting the template supply one.

### Comparators that only work by accident

Left alone deliberately, but worth knowing about if any of this is touched.

Three comparators never return 0 for equal elements, so `cmp(a,b)` and
`cmp(b,a)` both return 1 when two items tie:

- `src/api.js`, channels by number
- `src/services/m3u-service.js`, channels by number
- `web/directives/channel-config.js`, the `a.c` branch

That is formally an inconsistent comparator, but all three sort on values that
are unique in practice, so nothing misbehaves today.

Worse, and more interesting: the one in `src/api.js` runs on the result of
`getAllChannelNumbers()`, which is an array of plain integers, not objects. It
compares `a.number` against `b.number`, both of which are `undefined` on a
number primitive, so it is a complete no-op and always has been. `/api/channels`
is correctly ordered only because the DAO now sorts before it returns. If
someone ever removes that DAO sort believing the endpoint sorts for itself, the
ordering silently breaks again.

## Testing notes

### createLineup can be exercised directly

`helperFuncs.createLineup(programPlayTime, obj, channel, fillers, isFirst)` is
exported and has no I/O of its own, so filler selection can be tested without
playback, ffmpeg or a real channel. Pass a stub for `programPlayTime` exposing
`getProgramLastPlayTime(channelId, programKey)`, an `obj` of
`{timeElapsed, program}` where the program is `{isOffline: true, duration}`,
and fillers shaped `{id, content, weight, cooldown}`.

Running it a few hundred times and counting titles is enough to characterise
the picker statistically. That is how the 1.6.0 filler algorithm was verified:
600 lineups showed every pick going to never-played clips, and once all had
played, the longest idle took 67 percent against 33 for the next.

## Resolved

Kept here rather than deleted because every file involved is in the conflict
set for the pending 1.7.0 merge, and this will need re-applying.

### Channel images no longer depend on the host and port that created them

Previously the UI and two server paths wrote absolute URLs built from whatever
address happened to be in use, so a channel created on port 18000 stored
`http://localhost:18000/images/dizquetv.png` and broke as soon as the server
moved. XMLTV and M3U then handed that dead URL to Plex.

`icon`, `offlinePicture` and `watermark.url` now store a path such as
`/images/dizquetv.png`. The awkward part is that consumers need different
things from the same stored value, so `src/image-url.js` offers two resolvers:

- `forClient()` prefixes `{{host}}`, which `src/api.js` substitutes per request
  from `req.protocol` and `req.get('host')`. Used by `xmltv.js` and
  `m3u-service.js`, so each client gets an address it can actually reach.
- `forLocalFfmpeg()` prefixes `http://localhost:${process.env.PORT}`, because
  ffmpeg runs on this machine and cannot resolve a client's hostname. Used by
  `ffmpeg.js` for the offline picture and the watermark.

Anything not starting with `/` passes through untouched, which is what keeps
Plex thumbnail URLs working.

Migration step 805 to 806 rewrites existing channels. It only touches a URL
when the path starts with `/images/` **and** that file exists in the data
folder, leaving anything else exactly as it was. That conservatism is
deliberate: a channel carried 110 Plex thumbnail URLs with auth tokens, and a
blanket rewrite would have destroyed them. Verified after migrating: the two
fields changed, all 110 Plex URLs and the other 212 programs were byte
identical.

Note that the `http://localhost:${process.env.PORT}` strings still present in
`video.js`, `offline-player.js` and `plexTranscoder.js` are not part of this
problem. They are built per request for a local ffmpeg process and never
outlive the port they were built for.

### Channel order is consistent across every consumer

`getAllChannelNumbers()` enumerated the channels folder with `fs.readdir` and
returned whatever order that gave. Channel files are named `<number>.json`, so
that order is lexicographic: with channels 1, 2, 3, 10, 11, 20 and 100 on disk,
readdir yields 1, 10, 100, 11, 2, 20, 3.

The M3U and the API happened to sort afterwards, but two consumers did not: the
HDHomeRun lineup in `src/hdhr.js`, which is what Plex, Jellyfin and Emby read,
and the XMLTV guide build in `index.js`. So the same install advertised
channels in one order over M3U and a different one to a tuner client.

The DAO now sorts numerically, which is the one place every consumer passes
through. Verified against a folder of seven channels spanning single, double
and triple digits.

### M3U placeholder entry points at a path that is served

The no-channels entry in `m3u-service.js` pointed at `{{host}}/resources/...`,
which 404s since nothing mounts `/resources` as static - `index.js` maps only
`/favicon.svg` into that folder. It now uses `/images/dizquetv.png`, which
`initDB` guarantees exists on every start.

### validURL rejected the paths the icon change introduced

Storing channel images as paths broke saving any channel through the UI.
`validURL` in `channel-config.js` requires a scheme, so `/images/dizquetv.png`
failed with "Please enter a valid image URL" and the save never ran. It now
accepts a root-relative path as well.

The cause is worth more than the fix. The icon change was verified through
XMLTV output, M3U output and the browser rendering the image, all of which
read the value. Nothing exercised the path that *writes* it, so a validation
sitting directly in front of the save went unnoticed for two commits.

It also survived a first test attempt, because that test called a
`scope.saveChannel()` that does not exist. The optional-call guard meant
nothing ran and no error was raised, which read as a pass. The real entry
point is `scope._onDone(channel)`, bound to the Save button in
`channel-config.html`. When testing through a scope, confirm the function
being called actually exists.
