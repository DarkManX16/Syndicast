# Notes

## Feature roadmap

Intended work, mostly a statement of direction rather than of state. **An
unticked box is not built.** A ticked one is, and says what actually shipped,
which is not always the whole of what the line originally asked for. The Known
issues section below is separate and covers defects in what already ships.

### Blocks system

The original reason for the fork. See [docs/blocks-spec.md](docs/blocks-spec.md)
for the full spec, stages and acceptance tests.

- [ ] Timed Flex Blocks - time-scoped filler switching by time of day and day of week

      Stage 1's core is built and its acceptance rows pass, but there is no way
      to configure a day-part from the UI yet, so the box stays unticked. The
      resolver is `src/day-parts.js`, pure and free of I/O; `createLineup` takes
      a `t0` and resolves the mix when it fills a break. `channel.dayParts` is
      an optional field, so nothing needed migrating and a channel without one
      takes the same code path it always did.

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

### The play-time cache is loaded without being awaited

`index.js` calls `initializeProgramPlayTimeDB()` at line 130 without awaiting
it, and the express app is wired up immediately after. A stream that starts
before the load finishes reads an empty cache, so a clip or a filler list looks
like it has never played and its cooldown is ignored for that pick.

Pre-existing, never observed, and the window is the time it takes to read one
small JSON file per remembered program. Worth knowing because per-list cooldowns
now come out of the same store, so the race covers them too - it just widens
what a badly-timed first pick can forget, rather than introducing anything new.

Left alone deliberately. Awaiting it delays server start behind a directory
walk that scales with the number of remembered programs, which on this install
is most of a 39,999 program channel, and the failure it prevents is one slightly
wrong filler pick in the first moments after a restart.

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

### `npm test` runs the blocks suite

`test/` holds the stage 1 verification for day-parts.

```
npm test
```

runs every file in the directory and prints one combined pass/fail count (34
checks as of stage 1). Three files, matching the three things stage 1 needed
proving:

- `blocks-acceptance.js` - the stage 1 rows from
  [docs/blocks-spec.md](docs/blocks-spec.md)'s acceptance table, transcribed
  into one array, `ROWS`. **Stage 2 adds its rows to this same array**, tagged
  `row(2, ...)`, rather than starting a parallel file - see the comment at the
  end of `ROWS` for where new fixtures and helpers go.
- `blocks-unchanged.js` - the guarantee that a channel without day-parts is
  unaffected, as self-contained assertions rather than a diff against a
  historical commit (see below).
- `blocks-persistence.js` - the long-break and cooldown-persistence findings
  from the Resolved section below, plus the filler attribution regression.

`test/support.js` holds the shared fixtures, builders and the `Suite`
check/report harness. `test/run.js` is what `npm test` calls; it requires each
file above and aggregates their results. Nothing here touches ffmpeg, a data
folder or a running server, and there is no test runner dependency to
install - it is plain Node, in keeping with the rest of the project having
none either. Each file also runs standalone, e.g. `node
test/blocks-acceptance.js`, while developing just that piece.

### createLineup can be exercised directly

`helperFuncs.createLineup(programPlayTime, obj, channel, fillers, isFirst, t0)`
is exported and has no I/O of its own, so filler selection can be tested without
playback, ffmpeg or a real channel. Pass a stub for `programPlayTime` exposing
`getProgramLastPlayTime(channelId, programKey)` and `update(channelId,
programKey, t)`, an `obj` of `{timeElapsed, program, programIndex}` where the
program is `{isOffline: true, duration}`, and fillers shaped
`{id, content, weight, cooldown}`.

`t0` is the instant the decision is being made at, and `programIndex` addresses
`channel.programs`. Both only matter on a channel with day-parts: the resolver
uses `programIndex` to find the program after the break and takes its context.
Omit `t0` and it defaults to now.

Two things make measuring proportions awkward, and both have a way round.
Passing `isFirst` true disables the longest-idle branch, which leaves the list
weights governing on their own - that is how the 70/30 and 95/5 mixes in the
stage 1 acceptance table were confirmed to land on exactly 70/30 and 95/5. And
naming every clip after the list it belongs to makes a pick's true owner
unambiguous, which is what caught the attribution defect below.

These builders - `clip`, `show`, `flex`, `mix`, `freshStore` - are not just
prose convention any more; they are the literal functions in
`test/support.js`, shared by every file in the suite above.

### Comparing a filler change against the version before it

The picker is auto-seeded, so old and new cannot be compared call for call.
Three things together are enough to show a change did not disturb channels it
was not meant to touch, and all three were used for day-parts:

- An **exact-equality** case. One list, one clip shorter than the break, and
  `isFirst` false leaves nothing random in the pick, so the emitted item must
  match field for field.
- A **distribution** comparison at large N. 40,000 picks against the previous
  commit's `helperFuncs.js` and `channel-cache.js`, extracted with `git show`
  into a scratch directory, agreed within 0.22 points on every clip.
- An **identity** check on the input. `dayParts.allFillerCollections` returns
  the channel's own array by reference when there are no day-parts, so the
  picker provably runs on the same object it always did.

Running it a few hundred times and counting titles is enough to characterise
the picker statistically. That is how the 1.6.0 filler algorithm was verified:
600 lineups showed every pick going to never-played clips, and once all had
played, the longest idle took 67 percent against 33 for the next.

The committed `test/blocks-unchanged.js` proves the same three guarantees but
does not keep the git-show comparison itself. Pinned to a commit, it would
either go stale as history moves past it or break outright if that commit
were ever rewritten, to reprove something that only needs proving once per
change to this code path, not replayed on every future `npm test`. It keeps
the exact-equality and identity checks as they were, and replaces the
distribution diff against old code with a tolerance-banded check against the
configured weights instead - a smoke test that day-parts hasn't disturbed the
picker, not a restatement of the picker's own statistical behaviour, which the
acceptance suite's weight rows already cover.

## Model guide

Which model to hand a piece of work to. This is a cost and quality split, not a
statement that one model cannot do the other's job.

### The default split: investigate on Opus 5, implement on Sonnet 5

Investigation is where a wrong answer is expensive, because everything built on
top of it inherits the mistake. The season work is the example: its value was
almost entirely in the reading - finding that `getShowOrderer` cached the
orderer on the show and silently ignored the constraint after the first call,
and that Play Next has no stored cursor to preserve. Once that was written
down, the change itself was mechanical. A wrong read would have produced a
confident, working implementation of the wrong thing.

So: **Opus 5 to investigate and to decide the shape. Sonnet 5 to build it once
the shape is settled and written down.** The handover point is a design that
names the files, the data shape and the verification - roughly the level of
detail the reports in this file carry.

**Haiku is not used on this project.**

### Work that stays on Opus 5 end to end

Some items cannot be split, because the implementation *is* the design - the
first real decision is made in the code, and there is no settled shape to hand
over. These stay on Opus 5 for both halves:

- **Per-position stored progress.** The representation is the whole problem.
  See its entry above: whichever half ships first picks the key, the storage
  and the invalidation rule for the other.
- **Rerun, shuffle and ordered shuffle.** They depend on stored progress and
  inherit the same decision.
- **Very short items repeating or being skipped next to Flex.** A diagnosis
  problem in the concat or transition handling, with no reproduction yet. The
  roadmap entry already says guessing at the layer here would be expensive.
- **Random crashes during streaming.** Intermittent, no reproduction, so it is
  diagnosis all the way down.
- **The Blocks scheduling core.** The original reason for the fork, and it has
  to attach to the existing lineup pipeline without disturbing slots, filler or
  the orderers. The surrounding UI is ordinary work and can go to Sonnet 5 once
  the core is settled.

The common thread: reach for Opus when the risk is *choosing wrong*, not when
the work is merely large.

### Fable 5.1

Fable costs extra on the Pro plan, so it is not part of the normal rotation.
Reserve it for at most a single Blocks design pass - the one session where the
shape of the whole system is being decided and a better answer pays for itself
across everything built on it afterwards. Not for implementation, not for
investigation that Opus 5 already handles well.

## Resolved

Kept here rather than deleted because every file involved is in the conflict
set for the pending 1.7.0 merge, and this will need re-applying.

### Filler list cooldowns are persisted, and were being credited to the wrong list

Per-clip last-played times have always been persisted, to
`<data folder>/play-cache/<channel>/<base64 key>.json`, and loaded at boot.
Per-**list** times were not: they sat in a plain object in `channel-cache.js`
and were forgotten on every restart. CN Groovies' 3000 second cooldown never
survived one. Day-parts lean on list cooldowns, so that had to stop being true.

They now go into the same store, under `!fillerList!|<id>`. That key cannot
collide with a program: `getProgramKey` always opens with `!unknown!` or `plex`,
which the real data folder confirms - the keys on disk look like
`plex|Thats So Disney/Nick Picks|/library/metadata/171404`. Reusing the store
means no new DAO, no new folder, no migration, and one source of truth instead
of two.

**The interesting part is what persisting it exposed.** Which list a clip is
credited to was assigned twice:

```js
pick.fillerId = minPickFillerId;   // the longest-idle clip's real list
...
pick.fillerId = fillerId;          // the list that won the weighted draw
```

The second overwrote the first unconditionally, so every clip chosen by the
longest-idle branch was credited to whichever list happened to win the draw.
Measured over 596 picks: 183 went through that branch, 54 were credited to a
list the clip does not belong to. Nine percent. The first assignment also wrote
onto the clip sitting in the filler list itself, before the clone.

This was invisible precisely *because* list cooldowns were forgotten on restart -
a wrong credit had no lasting consequence. Persisting them would have made it
permanent: a list held in cooldown having never played, another free to play
again having just played. So it is not a cleanup that happened to be nearby, it
is a prerequisite. Re-measured after the fix: 0 wrong out of 1,983.

It does change filler behaviour on channels with no day-parts, which is the one
thing stage 1 was otherwise careful not to do. Worth stating plainly rather than
leaving it to be discovered.

Finding it was the enumerate-the-writers habit paying off again - the one the
image URL fix learned the hard way, further down this section. One grep for the
per-list play time turned up exactly one writer and one reader, which is what
made it safe to move the storage; the same grep for `fillerId` turned up the two
assignments sitting one line apart.

### Guide requested an unresolved Angular binding

Resolved, and worth keeping because the first diagnosis was wrong.

The symptom was a 404 for the literal string `{{channels[channelNumber].icon}}`
on the guide page. That was written up here as an empty-guide problem - no
channel to bind to, so the placeholder gets used as an image URL - with an
`ng-if` guard suggested as the fix.

The real cause has nothing to do with there being no channels. A plain `src`
carrying an interpolation is resolved by the browser *before* Angular runs, so
the request for the literal text fires on every load whether or not a channel
exists. `ng-src` exists precisely for this: it holds the attribute back until
the expression has a value.

Enumerating the class rather than the reported symptom turned up three, not
one:

- `web/public/views/guide.html`, the channel icon - the reported 404
- `web/public/templates/channel-config.html`, the watermark preview, requesting
  `/%7B%7B%20getWatermarkSrc()%20%7D%7D` on every visit to a channel's
  properties
- `web/public/views/guide.html`, the play-channel button's `href`. An anchor
  does not fetch, so it produced no 404 and would never have been noticed from
  the network log, but a click landing before interpolation navigates to the
  literal. Converted to `ng-href` for the same reason.

Everything else under `web/public` already used `ng-src` or `ng-href`. The
check that settles it:

```
grep -rnP "(?<!ng-)(src|href)=['\"][^'\"]*\{\{" --include=*.html web/public
```

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

**That fix missed two writers, and the miss is the interesting part.** It
searched for the bad *construction* - `${location.protocol()}://${location.host}`
- and corrected all four places that matched. But `/api/upload/image` returned

```js
fileUrl: `${req.protocol}://${req.get('host')}/images/uploads/${logo.name}`
```

and `channel-config.js` stored that verbatim into `channel.icon` and
`watermark.url`. Those two writers build no URL of their own, so no search for
one could have found them. A logo uploaded after 805 to 806 had run was stored
absolute all over again, and the resolvers passed it straight through - the
same dead URL handed to Plex that the whole change existed to prevent. It was
found by noticing a stale `localhost:18080` request in the browser console,
four months of wall-clock luck after the fact.

The endpoint returns `filePath`, a path, and is renamed from `fileUrl` so an
unconverted caller fails loudly rather than storing a path under a name that
says URL. The filename is URL-encoded, which matters because uploads really do
carry spaces. Migration 807 to 808 re-runs `relativizeChannelImages` for
channels already carrying one - same rule, same fields, so it calls the same
function rather than keeping a second copy of it, and it is idempotent.

The lesson, which generalises past this bug: **when fixing a class of bug,
enumerate every writer of the data, not every construction of the bad value.**
There were six writers of these three fields. Listing them takes one grep and
would have caught all six in the first pass.

A read-time safety net in the resolvers was considered and rejected. See the
next entry.

### A read-time net in the image resolvers is not worth it

Tempting, since the migration's rule is right there: on output, if a value is
an absolute URL whose path is under `/images/` and the file exists locally,
rewrite it. Any future writer that slips through would be corrected before
anything saw it.

It should not be added.

The rule cannot tell a stale local URL from a legitimate remote one. It looks
at the pathname and at whether some local file happens to share the name.
Measured against the real data folder:

    http://localhost:18080/images/uploads/dizquetv.png  -> rewritten   (wanted)
    http://plex.local:32400/images/uploads/dizquetv.png -> rewritten   (wrong)
    http://cdn.example.com/images/dizquetv.png          -> rewritten   (wrong)

The last two are remote images silently replaced by whatever this machine has
under that name. The migration accepts that risk deliberately, but it accepts
it *once*, under supervision, on a pass whose output can be diffed - which is
exactly what was done, both times. Running it on every read makes it permanent,
silent and unreviewable.

Three smaller objections on top. It puts a filesystem stat inside what is now a
pure string function, which is the property that makes the resolvers testable
without a data folder. It fixes the output while leaving the stored value
wrong, and only four call sites go through the resolvers - the UI preview and
the channel list read `channel.icon` directly and would still get the bad
value. And it hides the defect, so the next writer that slips through looks
like it works.

The net that was added instead sits at the write boundary.
`validateChannelJson` in `src/dao/channel-db.js` is called by both
`saveChannel` and `saveChannelSync`, which makes it the one place every channel
write passes through. It warns when `icon`, `offlinePicture` or
`watermark.url` is saved as an absolute URL whose path is under `/images/`,
naming the channel, the field and the path it should have been.

It rewrites nothing, deliberately. Correcting the value would mean guessing
whether a remote URL under `/images/` is stale or intended, and a wrong guess
silently serves the wrong image - the same objection that rules out doing it on
read. Being loud is the whole job. It costs one `new URL()` per image field per
save and touches no disk, so it is safe in a way the read-time version is not.

It does not fire on anything in the data folder today, which is the point: it
exists for the third writer, whenever that turns up.

### Small things in the upload path, left alone deliberately

Found while tracing the stale icon URL. None of them are the bug, and none are
fixed.

`web/services/dizquetv.js` defines `addChannelWatermark`, which POSTs to
`/api/channel/watermark`. That route does not exist in `src/api.js`, and
nothing calls the function. Dead code aimed at a missing endpoint.

`index.js` mounts `/images` twice over the same directory, at lines 299 and
301. Harmless, and predates the fork.

`/api/upload/image` calls `logo.mv(...)` without a callback and without
awaiting it, then sends a success response regardless. express-fileupload
returns a promise when given no callback, so a failed move is an unhandled
rejection and the client is told the upload worked. Never observed in practice,
but the success response is not evidence of a successful write.

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
