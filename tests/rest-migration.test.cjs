const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function app() {
  const storage = new Map();
  const context = vm.createContext({
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    defaultVideoReqs: () => ({}),
    findDay: () => ({}),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'seed.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('/* ============================== helpers')), context);
  return { context, storage, run: (code) => vm.runInContext(code, context) };
}

test('fresh installs use 3 minutes while pair and accessory durations remain unchanged', () => {
  const a = app();
  a.run('load()');
  assert.equal(a.run('state.settings.restNormal'), 180);
  assert.equal(a.run('state.settings.restHeavy'), 180);
  assert.equal(a.run('state.program.days[0].slots[4].restSec'), 90);
  assert.equal(a.run('state.program.days[1].slots[5].pairRest'), 60);
  assert.equal(a.run('state.program.days[2].slots[1].pairRest'), 75);
});

test('existing install migrates once without losing logs, active work, or custom program fields', () => {
  const a = app();
  const old = JSON.parse(a.run('JSON.stringify(defaultState())'));
  delete old.settings.threeMinuteRest;
  old.settings.restNormal = 120;
  old.settings.restHeavy = 240;
  old.program.specVersion = 'dm-1.0';
  old.program.days[0].slots[2].cue = '30–60 s between legs · 2:00 after both';
  old.program.days[0].slots[3].cue = 'Switch sides, then 2:00';
  old.program.days[0].slots[1].target = 'custom target';
  old.sessions = [{ id: 'saved-session', entries: [{ weight: 55 }] }];
  old.active = { dayId: 'dayA', entries: { a1: { weight: 55, sets: 1 } } };
  old.drafts = { dayB: { preserved: true } };
  a.storage.set('damiano-state-v1', JSON.stringify(old));
  a.run('load()');
  const after = JSON.parse(a.run('JSON.stringify(state)'));
  assert.equal(after.settings.restNormal, 180);
  assert.equal(after.settings.restHeavy, 240);
  assert.equal(after.program.specVersion, 'dm-1.1');
  assert.equal(after.program.days[0].slots[2].cue, '30–60 s between legs · 3:00 after both');
  assert.equal(after.program.days[0].slots[3].cue, 'Switch sides, then 3:00');
  assert.equal(after.program.days[0].slots[1].target, 'custom target');
  for (const key of ['sessions', 'active', 'drafts']) assert.deepEqual(after[key], old[key]);
  a.run('state.settings.restNormal = 120; save(); load()');
  assert.equal(a.run('state.settings.restNormal'), 120);
});

test('custom Normal and Heavy rest settings survive the upgrade', () => {
  const a = app();
  const old = JSON.parse(a.run('JSON.stringify(defaultState())'));
  delete old.settings.threeMinuteRest;
  old.settings.restNormal = 150;
  old.settings.restHeavy = 210;
  old.program.specVersion = 'dm-1.0';
  old.program.days[0].slots[3].cue = 'custom cue';
  a.storage.set('damiano-state-v1', JSON.stringify(old));
  a.run('load()');
  assert.equal(a.run('state.settings.restNormal'), 150);
  assert.equal(a.run('state.settings.restHeavy'), 210);
  assert.equal(a.run('state.program.days[0].slots[3].cue'), 'custom cue');
});
