// Typed loader for the harvested menu-setting offset map (data/settings-offsets.json):
// block → byte offset → option list. Used by the settings decoder to turn a raw 05/06/09
// settings-block read into named, labelled values. The map is the verified single source
// (capture-harvested via the BT-01 menu walk) — see COMMAND_REFERENCE decode TODO #3.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

interface RawSetting {
  name: string
  menu: string
  op: string
  block: string
  payloadOffset: number
  options: string[]
  desc?: string
}
interface RawFile {
  settings: RawSetting[]
}

const here = dirname(fileURLToPath(import.meta.url))
const PATH = resolve(here, '../../data/settings-offsets.json')
const file = JSON.parse(readFileSync(PATH, 'utf8')) as RawFile

export interface SettingDef {
  readonly name: string
  readonly block: string
  /** Byte index within the read frame (includes the 2-byte `04 0X` header). */
  readonly payloadOffset: number
  /** The `08 <op>` menu sub-opcode used to WRITE this setting. */
  readonly op: number
  readonly options: readonly string[]
  /** One-line plain-English explanation of what the setting does (shown in the editor). */
  readonly description: string
  /** The radio's own menu path (e.g. "display/back light"). */
  readonly menu: string
}

const toDef = (s: RawSetting): SettingDef => ({
  name: s.name,
  block: s.block,
  payloadOffset: s.payloadOffset,
  op: parseInt(s.op, 16),
  options: s.options,
  description: s.desc ?? '',
  menu: s.menu,
})

const byBlock = new Map<string, SettingDef[]>()
const byName = new Map<string, SettingDef>()
for (const s of file.settings) {
  const def = toDef(s)
  const list = byBlock.get(s.block) ?? []
  list.push(def)
  byBlock.set(s.block, list)
  byName.set(def.name, def)
}

export function settingsForBlock(block: string): readonly SettingDef[] {
  return byBlock.get(block) ?? []
}

export function settingByName(name: string): SettingDef | undefined {
  return byName.get(name)
}

export const allSettings: readonly SettingDef[] = file.settings.map(toDef)
