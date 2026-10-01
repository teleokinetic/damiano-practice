// Damiano — program seed (provisional A/B/C, Oct 2026)
// First-run seed only. Program changes go through code: bump specVersion and
// the app replaces the stored program on next launch (logs are untouched).
//
// Slot fields:
//   track: true     → load capture, prefilled from the last session by name
//   reps: true      → reps capture alongside the load
//   bw: true        → bodyweight only, reps without a load row
//   added: true     → load is added to bodyweight (shows BW when empty)
//   rest            → 'normal' (2:00) | 'heavy' (3:00)
//   restSec         → this slot's own rest, overriding the tier
//   pair / pairRest → slots sharing a pair key alternate sets; pairRest seconds
//   cut             → 1 = cut first if short on time, 2 = cut next
//   video           → key into VIDEO_LIFTS (app.js) for filming requests

const SEED_PROGRAM = {
  specVersion: 'dm-1.0',
  days: [
    {
      id: 'dayA',
      name: 'Strength A',
      subtitle: 'Bench · split squat · row',
      slots: [
        { id: 'a0', name: 'Warm-up', target: 'Easy walk or jog · ramp-up sets', track: false, rest: 'normal' },
        {
          id: 'a1', name: 'Bench press', target: '3×6–10', track: true, reps: true, rest: 'normal',
          warmup: 'Lighter ramp-up sets until ready. Not counted.', video: 'bench',
        },
        {
          id: 'a2', name: 'Bulgarian split squat', target: '3×8–12 /leg', track: true, reps: true, rest: 'normal',
          cue: '30–60 s between legs · 2:00 after both', video: 'splitsquat',
        },
        {
          id: 'a3', name: 'One-arm dumbbell row', target: '2×8–12 /side', track: true, reps: true, rest: 'normal',
          cue: 'Switch sides, then 2:00',
        },
        { id: 'a4', name: 'Lateral raise', target: '2×12–20', track: true, reps: true, rest: 'normal', restSec: 90, cut: 2 },
        { id: 'a5', name: 'Hanging knee raise', target: '2×8–15', track: true, reps: true, bw: true, rest: 'normal', restSec: 90, cut: 1 },
      ],
    },
    {
      id: 'dayB',
      name: 'Strength B',
      subtitle: 'RDL · pull-up · goblet squat',
      slots: [
        { id: 'b0', name: 'Warm-up', target: 'Easy walk or jog · ramp-up sets', track: false, rest: 'normal' },
        {
          id: 'b1', name: 'Romanian deadlift', target: '2×6–10', track: true, reps: true, rest: 'normal',
          warmup: 'Lighter ramp-up sets until ready. Not counted.', video: 'rdl',
        },
        {
          id: 'b2', name: 'Pull-up', target: '3×4–8', track: true, reps: true, added: true, rest: 'heavy',
          video: 'pullup',
        },
        { id: 'b3', name: 'Goblet squat', target: '3×8–12', track: true, reps: true, rest: 'normal' },
        { id: 'b4', name: 'Dumbbell overhead press', target: '2×6–10', track: true, reps: true, rest: 'normal' },
        {
          id: 'b5', name: 'Dumbbell curl', target: '2×10–15', track: true, reps: true, rest: 'normal',
          pair: 'b', pairRest: 60, short: 'curls', cut: 2,
        },
        {
          id: 'b6', name: 'Calf raise', target: '2×12–20', track: true, reps: true, rest: 'normal',
          pair: 'b', short: 'calves', cut: 1,
        },
      ],
    },
    {
      id: 'dayC',
      name: 'Strength C',
      subtitle: 'Bench + pull-up · RDL · row',
      slots: [
        { id: 'c0', name: 'Warm-up', target: 'Easy walk or jog · ramp-up sets', track: false, rest: 'normal' },
        {
          id: 'c1', name: 'Bench press', target: '3×6–10', track: true, reps: true, rest: 'normal',
          pair: 'c', pairRest: 75, short: 'bench', video: 'bench',
          warmup: 'Lighter ramp-up sets until ready. Not counted.',
          cue: 'Straight sets if pairing hurts performance',
        },
        {
          id: 'c2', name: 'Pull-up', target: '3×4–8', track: true, reps: true, added: true, rest: 'normal',
          pair: 'c', short: 'pull-ups', video: 'pullup',
        },
        {
          id: 'c3', name: 'Romanian deadlift', target: '2×6–10', track: true, reps: true, rest: 'normal',
          video: 'rdl',
        },
        {
          id: 'c4', name: 'One-arm dumbbell row', target: '2×8–12 /side', track: true, reps: true, rest: 'normal',
          cue: 'Switch sides, then 2:00',
        },
        {
          id: 'c5', name: 'Lateral raise', target: '2×12–20', track: true, reps: true, rest: 'normal',
          pair: 'd', pairRest: 60, short: 'raises', cut: 2,
        },
        {
          id: 'c6', name: 'Overhead dumbbell triceps extension', target: '2×10–15', track: true, reps: true, rest: 'normal',
          pair: 'd', short: 'triceps', cut: 1,
        },
      ],
    },
  ],
};
