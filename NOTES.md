# Notes

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
