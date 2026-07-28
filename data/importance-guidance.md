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
- **Amateur emergency traffic**: mayday / pan-pan, "break break" interrupting a conversation,
  stations declaring emergency traffic, health-and-welfare traffic during a real event.
- **Net activations for a REAL event**: ARES/RACES callout, SKYWARN activation (an actual
  activation — not the practice net), emergency net standing up.
- **Net OPENINGS — any scheduled net calling to order** (I use these to learn which nets exist
  and when they run): net control taking the frequency, the start of a preamble, "calling the net
  to order", the first call for check-ins. Tier 2 **even when the script is recurring** — high
  recurrence means it's a scheduled net, which is exactly what I want flagged; do not let the
  recurrence signal discount an opening. NAME the net in the reason and summary whenever it's
  audible ("Colorado Connection evening net opening"). Flag only the EARLIEST opening clip of a
  given net in the batch — the rest of the preamble, check-ins, net traffic, and the closing are
  tier 0.
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

When uncertain between two tiers, choose the LOWER one. False alarms erode trust faster than
missed low-tier items. This is a hobbyist monitoring aid, not a safety system.
