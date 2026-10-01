/**
 * Damiano's Practice — video drop into Google Drive.
 *
 * Deployed as a web app under Tanner's Google account. The app on Damiano's
 * phone asks this script for an upload session, then sends the clip straight
 * to Google Drive in chunks (so large iPhone videos never pass through here).
 * When the last chunk lands, the app reports back and this script names the
 * file, notes the set details, and (optionally) emails Tanner a link.
 *
 * Setup: see apps-script/SETUP.md.
 */

var FOLDER_NAME = 'Damiano videos';
var ALLOWED_ORIGINS = ['https://teleokinetic.github.io'];
var MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
var NOTIFY_EMAIL = true;                // email Tanner a link when a clip lands

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var key = PropertiesService.getScriptProperties().getProperty('UPLOAD_KEY');
    if (!key || req.key !== key) return out({ ok: false, error: 'not-authorized' });
    if (req.action === 'start') return out(startSession(req));
    if (req.action === 'done') return out(finish(req));
    if (req.action === 'ping') return out({ ok: true, folder: folder().getName() });
    return out({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return out({ ok: true, app: "Damiano's Practice video drop" });
}

function startSession(req) {
  var origin = String(req.origin || '');
  if (ALLOWED_ORIGINS.indexOf(origin) < 0) return { ok: false, error: 'origin-not-allowed' };
  var size = Number(req.size);
  if (!(size > 0) || size > MAX_BYTES) return { ok: false, error: 'bad-size' };
  var mime = String(req.mimeType || '');
  if (!/^video\//.test(mime)) return { ok: false, error: 'not-a-video' };

  var meta = {
    name: String(req.name || 'Damiano clip').slice(0, 200),
    mimeType: mime,
    parents: [folder().getId()],
    description: String(req.description || '').slice(0, 4000),
  };
  var res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify(meta),
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(size),
        // Lets the phone upload the chunks directly (CORS) from the app's origin.
        Origin: origin,
      },
      muteHttpExceptions: true,
    }
  );
  if (res.getResponseCode() !== 200) {
    return { ok: false, error: 'drive-' + res.getResponseCode(), detail: res.getContentText().slice(0, 300) };
  }
  var h = res.getHeaders();
  var url = h.Location || h.location;
  if (!url) return { ok: false, error: 'no-session-url' };
  return { ok: true, uploadUrl: url };
}

function finish(req) {
  var file = DriveApp.getFileById(String(req.fileId));
  var parents = file.getParents();
  var inFolder = false;
  var f = folder();
  while (parents.hasNext()) { if (parents.next().getId() === f.getId()) inFolder = true; }
  if (!inFolder) return { ok: false, error: 'wrong-folder' };
  if (req.expectedSize && Number(file.getSize()) !== Number(req.expectedSize)) {
    return { ok: false, error: 'size-mismatch', size: file.getSize() };
  }
  if (NOTIFY_EMAIL) {
    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      subject: "Damiano's Practice — new video: " + (req.lift || file.getName()),
      body: [
        (req.lift || 'Video') + ' from Damiano.',
        req.summary || '',
        '',
        file.getUrl(),
      ].join('\n'),
    });
  }
  return { ok: true, url: file.getUrl(), size: file.getSize() };
}

function folder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreated below */ }
  }
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor: creates the folder, sets a key, asks for permissions. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('UPLOAD_KEY')) props.setProperty('UPLOAD_KEY', Utilities.getUuid());
  var f = folder();
  Logger.log('Folder: ' + f.getUrl());
  Logger.log('UPLOAD_KEY: ' + props.getProperty('UPLOAD_KEY'));
}
