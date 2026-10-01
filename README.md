# Damiano’s Practice

Damiano's practice with Tanner: strength sessions now, with room for running and more later. Built on the Strength Rebuild app's layout, rest timer and animations, with its own palette (sky, coral, oxblood, mauve, dark earth) and a maple-samara ornament. Static PWA with no build step, served by GitHub Pages.

## What's in v1.0 (demo, Oct 1 2026)

- **Home**: greeting, *Up next* (the session trained least recently; any can be opened), and the other two sessions. A camera line names any lift Tanner has asked to see in that session.
- **Sessions A / B / C**: provisional plan, working sets only, in order, with pairings grouped on one mat and their own rests (B finish 1:00, C main 1:15, C finish 1:00). Pull-ups unpaired 3:00, main lifts 2:00, unpaired accessories 1:30. Accessories carry *cut first / cut next*.
- **Logging**: per exercise, load (lb), reps and RIR (default 2) in the drawer. Each tap of the ring banks one set with those three numbers, so every working set is recorded. The warm-up is its own row and is never counted. Finish records each exercise as done, partial (n of m sets) or skipped.
- **Video requests**: a request belongs to the lift. A camera chip sits on that lift's row (outside the drawer) wherever it comes up next. The chip opens the framing reference (credited), records with the phone camera or picks an existing clip, then plays it back with draggable trim marks and load, reps, rest and reps-left fields. Retake keeps the current draft until a new clip arrives, and cancelling a retake changes nothing. Send keeps the clip on the phone (IndexedDB) and uploads it to Tanner's Google Drive (`upload.js`, `apps-script/`): 8 MB resumable chunks straight to Drive, resuming after dropped connections, a locked phone or a closed app. The request only counts as received once Drive has every byte and the script has checked the size; then the phone copy is freed.
- **Bug button**: a small corner button on every screen opens a note that goes to Tanner's inbox (the same FormSubmit box as Joe's app) with the screen, the open session and any recent script errors attached. Offline, notes wait on the phone and send on reconnect or next launch.
- **Program changes ship in code**: edit `seed.js` and bump `specVersion`. The app swaps in the new program on next launch, and logs are untouched. There is no in-app program editor.

## Not built yet

- **Sync backend**: workout logs reaching Tanner automatically, remembered email-code sign-in. (Videos already go to Drive; bug notes to his inbox.)
- **Messages**: a two-way thread ("Send me a message"), unread dot on both sides, no email notifications.
- **Coach view**: Damiano's logs, messages and clips, clip download, and requesting a new recording.
- **Progress tracker**: Tanner still needs to design and build it. History is saved in every session record (`setLog`, `status`, `rir`) so the tracker has data from day one.
- **Week calendar**: hidden until its design is production-ready.
- **Running**: hidden until defined.
- **Resources**: hidden until there's something in it.
- The framing images are hotlinked from their sources and should move into `images/` once copied over.

## Develop

```
python3 -m http.server 8080
```

## Ship

Push to `main`; GitHub Pages serves the root. Bump `CACHE` in `sw.js` and `APP_VERSION` in `app.js` when shipping so installed phones pick up the new version. Storage key `damiano-state-v1` and cache prefix `damiano-` keep it apart from the other apps on teleokinetic.github.io.
