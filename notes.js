/* Damiano's Practice — Tanner's notes on his lifts.
   Notes ship in code, like the program in seed.js: add one to the top of
   COACH_NOTES and push. Newest first; the first is shown as "Latest", and a
   note he hasn't opened yet carries a coral dot (stored by id on his phone,
   so give every note a new id).

   Each note: id, lift (the list label), title (the page heading), date
   (YYYY-MM-DD), focus (the highlighted line; optional), praise (a highlighted
   opener for a note that's mostly "keep going"; optional), points (numbered
   sections), extras (unnumbered sections, e.g. optional variations), and
   closing (an optional last line).

   A section: { title, eyebrow?, body: [paragraph, …], strong?: index of the
   paragraph to set brighter, image?: { src, alt }, imageLead?, imageBody?,
   link?: { title, sub, url } }. */

const COACH_NOTES = [
  {
    id: 'pull-up-2026-11-21',
    lift: 'Pull-up',
    title: 'Pull-Up',
    date: '2026-11-21',
    praise: ['Great progress in these.', 'No notes, keep up the good work.'],
    extras: [
      {
        eyebrow: 'Optional · for variety',
        title: 'Grip changing game',
        body: [
          'If you wanted to bring variety, you can play with a grip changing game.',
          'Between every rep, change your grip, pull from there.',
        ],
        strong: 1,
      },
    ],
  },
  {
    id: 'bench-press-2026-11-21',
    lift: 'Bench press',
    title: 'Bench Press',
    date: '2026-11-21',
    focus: 'Bar over your eyebrows, then keep pushing the floor away.',
    points: [
      {
        title: 'Slide up the bench',
        body: [
          'It’s hard to know for sure from this angle, but it looks like you might be starting too far down the bench. It looks like you have to reach back to grab the bar.',
          'Slide up until the bar is right over your eyebrows, then pull the bar out with your lats. You might even lower the j-cups one notch.',
        ],
        strong: 1,
      },
      {
        title: 'Push the floor away',
        body: [
          'Push the floor away with your feet like you’re trying to slide your head up the bench. That pressure stays constant throughout.',
          '(Legs can be very helpful.)',
        ],
        strong: 0,
      },
    ],
    closing: 'Otherwise looking solid!!',
  },
  {
    id: 'rdl-2026-11-21',
    lift: 'RDL',
    title: 'Romanian Deadlift',
    date: '2026-11-21',
    focus: 'Squeeze the oranges in your armpits the whole rep.',
    points: [
      {
        title: 'Lock your lats',
        body: [
          'Throughout the rep, imagine that you’ve got two oranges in your armpits that you need to squeeze the entire time.',
          'Right now, the bar is hanging off your shoulders a bit, which brings a little bit of rounding into your back and moves load into your spine. If you squeeze those oranges, it will “lock” your lats in place and help your torso move as one unit.',
        ],
        strong: 0,
        imageLead: 'If that doesn’t click',
        image: { src: 'images/rdl-band-setup.gif', alt: 'A barbell RDL with a light band looped from the bar to the rack, gently pulling the bar forward' },
        imageBody: 'If the oranges cue doesn’t feel concrete enough, try a set-up with a light resistance band like this. The band gently pulls the bar forward, which will give us the lat engagement we’re looking for.',
      },
      {
        title: 'Add glute pull-throughs',
        body: [
          'I recommend using this as a specific warm-up or even a substitute for 1–2 working sets in the RDL. This should help with hip drive and hip ROM.',
        ],
        link: {
          title: 'Perfect Glute Pull Through',
          sub: 'Colossus Fitness · YouTube',
          url: 'https://www.youtube.com/results?search_query=Colossus+Fitness+How+to+PROPERLY+Glute+Pull+Through',
        },
      },
    ],
  },
];
