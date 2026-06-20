import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface ScanGroup {
  id: string
  name: string
  channels: string[]
  createdAt: number
}

export interface ScanGroupsConfig {
  groups: ScanGroup[]
}

function scanGroupsPath(): string {
  if (process.env.CAT_SCAN_GROUPS_PATH) return resolve(process.env.CAT_SCAN_GROUPS_PATH)
  const dataDir = process.env.CAT_DATA_PATH || resolve(process.cwd(), '.data')
  return resolve(dataDir, 'scan-groups.json')
}

function normalizeScanGroup(value: any): ScanGroup | null {
  const name = String(value?.name ?? '').trim()
  const channels: string[] = Array.isArray(value?.channels)
    ? Array.from(new Set<string>(value.channels.map((channel: unknown) => String(channel).trim()).filter((channel: string) => channel.length > 0)))
    : []
  if (!name || channels.length === 0) return null

  return {
    id: String(value?.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    name,
    channels,
    createdAt: Number(value?.createdAt) || Date.now(),
  }
}

export async function readScanGroups(): Promise<ScanGroupsConfig> {
  const path = scanGroupsPath()
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    const rawGroups = Array.isArray(parsed) ? parsed : parsed?.groups
    const groups = Array.isArray(rawGroups)
      ? rawGroups.map(normalizeScanGroup).filter((group): group is ScanGroup => group !== null)
      : []
    return { groups }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { groups: [] }
    throw err
  }
}

export async function writeScanGroups(groups: ScanGroup[]): Promise<ScanGroupsConfig> {
  const path = scanGroupsPath()
  await mkdir(dirname(path), { recursive: true })
  const config = { groups }
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  return config
}

export async function upsertScanGroup(value: any): Promise<ScanGroupsConfig> {
  const group = normalizeScanGroup(value)
  if (!group) throw new Error('Scan group name and channels are required')

  const { groups } = await readScanGroups()
  const existingIdx = groups.findIndex(item => item.id === group.id || item.name.toLowerCase() === group.name.toLowerCase())
  const nextGroups = existingIdx >= 0
    ? groups.map((item, idx) => idx === existingIdx ? { ...group, id: item.id, createdAt: item.createdAt } : item)
    : [...groups, group]
  return writeScanGroups(nextGroups)
}

export async function deleteScanGroup(id: string): Promise<ScanGroupsConfig> {
  const { groups } = await readScanGroups()
  return writeScanGroups(groups.filter(group => group.id !== id))
}
