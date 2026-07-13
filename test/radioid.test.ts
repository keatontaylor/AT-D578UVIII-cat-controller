// RadioID.net DMR user-DB parse + lookup: id → callsign/name/location, miss → null.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RadioIdDb } from '../src/services/radioid'

const CSV = `RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY
3123456,W1ABC,John,Smith,Boston,Massachusetts,United States
1023007,VA3BOC,Hans Juergen,,Cornwall,Ontario,Canada
`

test('load parses the CSV; lookup resolves callsign/name/location', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rid-'))
  try {
    const path = join(dir, 'user.csv')
    writeFileSync(path, CSV)
    const db = new RadioIdDb()
    assert.equal(await db.load(path), 2)
    assert.equal(db.loaded, true)
    assert.deepEqual(db.lookup(3123456), {
      callsign: 'W1ABC',
      name: 'John Smith',
      location: 'Boston, Massachusetts, United States',
    })
    // a partial row (no last name) still resolves
    assert.equal(db.lookup(1023007)?.name, 'Hans Juergen')
    // a talkgroup id / unknown → null (this is how person-vs-TG is disambiguated)
    assert.equal(db.lookup(5067498), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing DB file leaves the DB unloaded; lookup returns null', async () => {
  const db = new RadioIdDb()
  assert.equal(await db.load('/no/such/file.csv'), 0)
  assert.equal(db.loaded, false)
  assert.equal(db.lookup(3123456), null)
})
