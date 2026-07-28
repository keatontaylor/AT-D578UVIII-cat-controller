# Importance guidance

Edit this file to tell the importance scorer what YOU consider notable in your radio traffic.
It is embedded verbatim into the scoring prompt — plain prose, no code. Re-read every scoring
batch; no restart needed.

## My context

I monitor amateur radio and public-safety channels along the Colorado Front Range (Boulder
County / Denver metro): the Colorado Connection ("COLCON", a statewide LINKED analog repeater
system), RMHAM DMR repeaters, local 2m/70cm club repeaters, DMR hotspot talkgroups, and
sheriff/fire scan channels (BCSO, Boulder County fire districts).

## Raise the tier (2 important, 3 urgent)

- **Severe weather — actual reports, not forecasts**: tornado / funnel cloud / wall cloud, large
  hail, flash flooding, damaging winds, blizzard strandings and road closures. A spotter
  reporting what they SEE outranks anyone discussing a forecast.
- **Wildfire** (the big one for this area): new smoke columns / new starts, spreading fire,
  pre-evacuation or evacuation notices, red-flag-day incidents. Evacuations in progress = urgent.
- **Public-safety incidents with substance** on the sheriff/fire channels: crimes in progress,
  theft, pursuits, dangerous/erratic drivers, injury accidents, structure fires, backcountry
  search-and-rescue operations. Escalations rank higher: second/third alarm, mutual-aid
  activation, mass-casualty. An officer or firefighter emergency ("mayday", officer down) is
  always urgent.
- **Amateur emergency traffic**: mayday / pan-pan, "break break" interrupting an AMATEUR
  conversation, stations declaring emergency traffic, health-and-welfare traffic during a real
  event. (On dispatch channels "break" is a routine procedure word between transmissions — not
  an emergency signal.)
- **Net activations for a REAL event**: ARES/RACES callout, SKYWARN activation (an actual
  activation — not the practice net), emergency net standing up.
- **Net OPENINGS — a net actively being called to order** (I use these to learn which nets exist
  and when they run): net control taking the frequency RIGHT NOW and convening the net — "calling
  the net to order", the first call for check-ins. Tier 2 **even when the script is recurring**;
  do not let the recurrence signal discount a real opening. NAME the net in the reason and
  summary whenever it's audible ("Colorado Connection evening net opening"). What is NOT an
  opening (all tier 0): automated schedule announcements or reminders ("...Net, Tuesday night,
  7 o'clock"), repeater/system IDs ("This is the Colorado Connection"), a station announcing they
  are MONITORING for calls, preamble instruction fragments ("key up for two seconds..."), and
  anything with mid-net texture — reports or check-ins already flowing, "next station", "standing
  by for reports". Mid-net is mid-net even if you see no opening clip in this batch (batches are
  short windows; the opening was probably earlier). Flag only the EARLIEST true opening of a
  given net in the batch.
- **Colorful / sensational conversations** — ragchews on wild, provocative, or morbid topics
  (geopolitics, nukes, crime, conspiracies) that are genuinely interesting listening: tier 2 at
  most, with a reason that frames it honestly as CONVERSATION ("colorful ragchew about arming
  Iran"), never wording that presents the topic as a real event or threat. These are NEVER
  urgent — tier 3 is reserved for real, local, actionable emergencies.
- **Band openings / unusual propagation** (time-critical for me): sporadic-E on 6 m, tropo
  ducting, aurora, "10 meters is open", long-haul VHF contacts being reported. These decay in
  hours — that's what makes them important, not dangerous.
- **Repeater / system infrastructure news**: a repeater or the COLCON link system down or
  misbehaving, maintenance windows announced, PL/access changes, node/link outages. I maintain
  monitoring gear around these systems; status changes matter to me.
- **Jamming or deliberate interference** incidents (recurring jammer, malicious interference).

## Keep routine (tier 0)

- Scheduled nets AFTER their opening: mid-net check-ins, continued preamble, "next station",
  net-control housekeeping, the closing — including scripts that MENTION emergencies, 911, or
  "if this were an actual emergency". High recurrence = scripted. (The opening call-up itself
  is tier 2 — see above.)
- Ragchews, signal reports, radio checks, kerchunk tests, equipment and antenna talk, weather as
  small talk, storm chat that is just "looks like rain tonight".
- Public-safety ADMINISTRATIVE traffic: unit status, radio checks, paperwork/records requests,
  routine transports, tone tests.
- Drills and exercises announced as such; tests of any kind.
- Repeater IDs and automated announcements.
- Formal traffic nets passing ROUTINE-precedence messages. (NTS precedence words: "Routine" and
  "Welfare" are normal; a formal message with **Priority** or **Emergency** precedence during a
  real event is important — but the word "priority" alone in net chatter is not.)

## Tiers

- **0 routine** — ordinary traffic.
- **1 notable** — mildly interesting but not worth flagging (first-time station on a quiet
  channel, swap-meet gear talk, satellite/balloon/foxhunt coordination, silent-key announcement).
  This tier is a buffer: it is never shown in the UI — use it for borderline cases instead of
  inflating them to important.
- **2 important** — I'd want to notice this when I glance at the timeline.
- **3 urgent** — active emergency / life-safety / evacuation / mayday in progress.

## Worked examples

- "Good evening, this is net control calling the Colorado Connection net to order, we meet every
  evening at 6:30…" → **2** (net OPENING — flag it and name the net, scripted or not)
- Later clips of the SAME net — more preamble ("…we practice copying the information needed to
  report an emergency to 911…"), check-ins, "next station" → **0** (mid-net; the 911 mention is
  script, not an emergency)
- "Radio check… you're loud and clear on the Buckhorn." → **0**
- "…copy records check on a white Silverado…" (sheriff admin) → **0**
- "RP states a vehicle is swerving all over the road, children in the back seat" → **2**
- "Reported theft in progress at the trailhead lot" → **2**
- "We've got a new smoke column visible west of Lyons, requesting a second engine" → **3**
- "Es opening on six meters, working Texas stations right now" → **2**
- "The Denver link has been down since this morning, techs are aware" → **2**
- Garbled fragment that merely contains the word "fire" with no coherent report → **0**
  (transcripts are auto-generated; do not over-read errors)
- "Colorado Astronomy Net, Tuesday night, 7 o'clock." → **0** (automated schedule announcement,
  not an opening — no matter how many times it repeats)
- "…monitoring COLCON for the Colorado Emergency Reporting Network to answer any emergency
  call…" → **0** (a station announcing they're listening, not a net convening)
- "444, suspicious individual" (bare dispatch callout, no substance) → **0** — the detailed
  follow-up clip seconds later is the one to flag
- "I'm a proponent of giving Iran nukes…" (ragchew hyperbole) → **2** reason "colorful ragchew
  about arming Iran" — interesting listening, NOT an urgent threat

The reason must name a CONCRETE thing — an incident, a net, a topic — built from words actually
present in the transcript. If you cannot, the clip is tier 0; never flag on vibes ("notable
incident report") or by echoing a phrase from this guidance.

When uncertain between two tiers, choose the LOWER one. False alarms erode trust faster than
missed low-tier items. This is a hobbyist monitoring aid, not a safety system.

## Transcript cleanup notes

- Callsign formatting: write callsigns as one unbroken token — no hyphens or spaces inside them
  ("KL-7GLK" → "KL7GLK", "Kilo-2 Alpha Delta" spoken phonetics → K2AD only when that call is
  already established in the conversation). US shapes: 1-2 letter prefix + one digit + 1-3 letter
  suffix, 6 characters max.
- NEVER substitute a different callsign than the one transcribed: if the audio rendered "KB2",
  keep "KB2" (or mark [unclear]) — do not "correct" it to another station's call, even one active
  in the conversation. A mis-copied callsign must stay visibly imperfect rather than become a
  confident wrong identity.
- Label the OPENING transmission too: its trailing signature identifies the speaker the same way
  ("...please come back, KL7GLK, looking for a signal report" = KL7GLK speaking).
- Two-station exchanges are half-duplex: once both callsigns are established, turns strictly
  alternate — use that to label every turn, and merge consecutive sentences by the same speaker
  into one turn.
- Once a station's callsign is established, resolve later spoken phonetics of that SAME call
  inline ("Kilo-2 Alpha Delta" → "K2AD") — phonetics are how hams spell calls aloud, not
  separate content.
- Short acknowledgments ("Yes indeed", "QSL", "copy", "roger") usually BEGIN the replying
  station's transmission — attach them to the FOLLOWING turn, not the previous speaker's tail.
- Restore question intonation: statements functioning as questions end with "?".
- Summaries: name the stations and what happened as a tiny narrative ("KL7GLK gets signal report
  from K2AD after radio trouble"), never generic ("two operators chat").
- Worked example — opener attribution: a transmission ending "…please come back, N1QRZ, looking
  for a signal report" is N1QRZ SPEAKING (trailing call = signature, and "please come back" =
  inviting others to call THEM). The reply "you were probably talking about me, W2XY" is W2XY.
  Anchor the whole alternation on those first two turns.
- Open calls vs directed calls: a transmission asking "anybody / anyone" is an OPEN call — a
  callsign at its START is the speaker self-identifying, not an addressee (you don't name one
  station and then ask "anybody"). A later "X, this is Y" answering it is Y REPLYING — always a
  separate turn (worked example: "N1QRZ, I'm mobile on the interstate, curious if anybody has a
  weather report" = N1QRZ speaking; "N1QRZ, this is W2XY" = W2XY's reply, new turn).
