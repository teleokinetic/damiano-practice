# Video drop: one-time setup

1. Go to script.new (signed in as Tanner). Name the project "Damiano video drop".
2. Paste `Code.gs` over the default file. Project Settings → show `appsscript.json` → paste this folder's version.
3. Run `setup` once. Approve Google's permission screen. The log prints the folder link and the `UPLOAD_KEY`.
4. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone. Copy the `/exec` URL.
5. Put the URL and key in `config.js`, bump the version, push.

Clips land in **Damiano videos** in Tanner's Drive, named like `2026-10-01 Bench press — 115 lb × 8.mov`, with the set details in the file's description. `NOTIFY_EMAIL` in `Code.gs` sends Tanner a link per clip; set it to `false` to stop.

After editing `Code.gs`, redeploy with Deploy → Manage deployments → edit → New version, so the `/exec` URL stays the same.

## Live deployment (Oct 1 2026)

- Project: "Damiano video drop" in Tanner's Apps Script, deployed as a web app (execute as Tanner, access Anyone). The URL and key are in `config.js`.
- Folder: **Damiano videos** in Tanner's Drive.
- Checked against real Google from teleokinetic.github.io: CORS on the script and on Drive's upload session, `Range` readable on `308`, a wrong key refused, and a 20 MB clip through the app's own Send flow (three 8 MB chunks, about 12 s) landing at the exact size with name and set details.
