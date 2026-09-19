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
