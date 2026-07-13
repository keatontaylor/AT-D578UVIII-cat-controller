// RadioID.net DMR user-database lookup (ported from the PoC's radioid.mjs). The radio reports only
// a caller's DMR id (+ sometimes a short alias); this maps that id to full operator details
// (callsign, name, location). The dataset is a flat CSV:
//   RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY
// A hit also disambiguates person-vs-talkgroup: a real caller resolves to a callsign; a talkgroup
// id does not appear in the user DB.

import { readFile } from 'node:fs/promises'

export interface CallerInfo {
  callsign: string | null
  name: string | null
  location: string | null
}

export class RadioIdDb {
  private index: Map<number, CallerInfo> | null = null

  get loaded(): boolean {
    return this.index != null
  }
  get count(): number {
    return this.index?.size ?? 0
  }

  /** Parse the CSV at `path` into an id→record map (~16 MB / ~300k rows, well under a second).
   * Read + parse are async so startup isn't blocked. A missing file leaves the DB unloaded. */
  async load(path: string): Promise<number> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      this.index = null
      return 0
    }
    const map = new Map<number, CallerInfo>()
    let first = true
    for (const line of text.split('\n')) {
      if (first) {
        first = false // header row
        continue
      }
      if (!line) continue
      const f = line.split(',') // dataset has no quoted commas
      const id = Number(f[0])
      if (!Number.isInteger(id)) continue
      const name = [(f[2] || '').trim(), (f[3] || '').trim()].filter(Boolean).join(' ')
      const loc = [(f[4] || '').trim(), (f[5] || '').trim(), (f[6] || '').trim()].filter(Boolean).join(', ')
      map.set(id, {
        callsign: (f[1] || '').trim() || null,
        name: name || null,
        location: loc || null,
      })
    }
    this.index = map
    return map.size
  }

  lookup(id: number): CallerInfo | null {
    if (this.index == null || !Number.isInteger(id)) return null
    return this.index.get(id) ?? null
  }
}
