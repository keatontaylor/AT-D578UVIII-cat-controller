// RadioID.net DMR user database lookup. The radio only reports a caller's DMR
// ID (and sometimes a short alias); this maps that ID to full operator details
// (callsign, name, location). The dataset is a flat CSV:
//   RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY
// Looking an ID up also disambiguates person-vs-talkgroup: a real caller
// resolves to a callsign; a talkgroup ID does not appear in the user DB.
import { existsSync, readFileSync, mkdirSync, createWriteStream, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import https from 'node:https'

const RADIOID_URL = process.env.ANYTONE_RADIOID_URL || 'https://database.radioid.net/static/user.csv'

let index = null
let loadedAt = null
let fileMtime = null

export function radioidPath() {
  return process.env.ANYTONE_RADIOID_CSV || `${process.env.HOME}/anytone/data/radioid_user.csv`
}

export function radioidStatus() {
  return { loaded: index != null, count: index ? index.size : 0, path: radioidPath(), loadedAt, fileMtime }
}

// Parse the CSV into an id -> record map. Synchronous; ~16 MB / ~300k rows
// parses in well under a second and is done once at boot (or after a refresh).
export function loadRadioid(path = radioidPath()) {
  if (!existsSync(path)) { index = null; loadedAt = null; return radioidStatus() }
  const text = readFileSync(path, 'utf8')
  const map = new Map()
  let first = true
  for (const line of text.split('\n')) {
    if (first) { first = false; continue }        // header row
    if (!line) continue
    const f = line.split(',')                       // dataset has no quoted commas
    const id = Number(f[0])
    if (!Number.isInteger(id)) continue
    const name = [(f[2] || '').trim(), (f[3] || '').trim()].filter(Boolean).join(' ')
    const loc = [(f[4] || '').trim(), (f[5] || '').trim(), (f[6] || '').trim()].filter(Boolean).join(', ')
    map.set(id, {
      callsign: (f[1] || '').trim() || null,
      name: name || null,
      city: (f[4] || '').trim() || null,
      state: (f[5] || '').trim() || null,
      country: (f[6] || '').trim() || null,
      location: loc || null,
    })
  }
  index = map
  loadedAt = Date.now()
  try { fileMtime = statSync(path).mtimeMs } catch { fileMtime = null }
  return radioidStatus()
}

export function lookupRadioid(id) {
  if (index == null) return null
  const n = Number(id)
  if (!Number.isInteger(n)) return null
  return index.get(n) || null
}

// Download the latest dump to disk (atomic via .tmp + rename), then reload.
export function downloadRadioid(path = radioidPath()) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    const file = createWriteStream(tmp)
    const req = https.get(RADIOID_URL, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`radioid download HTTP ${res.statusCode}`)); return }
      res.pipe(file)
      file.on('finish', () => file.close(() => {
        try { renameSync(tmp, path); resolve(loadRadioid(path)) }
        catch (err) { reject(err) }
      }))
    })
    req.on('error', reject)
    file.on('error', reject)
  })
}
