// JSON-RPC 2.0 method router (UI_PROTOCOL). Validates the envelope + per-method params (Zod) and
// dispatches to the RadioController. The command response is a RECEIPT; the authoritative outcome
// arrives on the AppState stream (state.snapshot / RFC 7396 state.patch). Pure: parsed value in,
// response (or null for a notification) out — the ws binding owns the socket.

import { z } from 'zod'
import { CHANNEL_SETTINGS } from '../codec/channel-settings'
import { allSettings } from '../codec/settings-table'
import type { RadioController } from '../services/radio-service'
import { fail, idOf, ok, RpcErrorCode, RpcRequest, type RpcResponse } from './jsonrpc'

/** Thrown by a handler when params are semantically invalid (vs a transport/internal fault). */
export class InvalidParams extends Error {}

interface Method {
  readonly params: z.ZodTypeAny
  readonly handle: (c: RadioController, params: unknown) => unknown | Promise<unknown>
}

const NoParams = z.unknown()
const AddressParams = z.object({ address: z.string() })
const SettingParams = z.object({ name: z.string(), value: z.union([z.string(), z.number()]) })
const Side = z.enum(['a', 'b'])
const SideParams = z.object({ side: Side })
const ChannelSettingParams = z.object({ side: Side, key: z.string(), value: z.union([z.string(), z.number()]) })
const ChannelToneParams = z.object({
  side: Side,
  field: z.enum(['rx', 'tx']),
  type: z.enum(['off', 'ctc', 'dcs']),
  value: z.number().default(0),
  inverted: z.boolean().default(false),
})
const StepParams = z.object({ side: Side, dir: z.union([z.literal(1), z.literal(-1)]) })
const VfoModeParams = z.object({ side: Side, vfo: z.boolean() })
const FrequencyParams = z.object({ side: Side, field: z.enum(['rx', 'tx']), hz: z.number().int().positive() })
const VolumeParams = z.object({ side: Side, level: z.number().int().min(0).max(31) })
const ScanStartParams = z.object({
  side: Side,
  listIndex: z.number().int().nonnegative().nullable().optional(),
  listName: z.string().nullable().optional(),
})
const ChannelSelectParams = z.object({ side: Side, position: z.number().int().nonnegative() })
const ForceParams = z.object({ force: z.boolean().optional() })
const ZoneChannelsParams = z.object({ zoneIndex: z.number().int().nonnegative(), force: z.boolean().optional() })
const ZoneChannelSelectParams = z.object({
  side: Side,
  zoneIndex: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
})
const DmrDialParams = z.object({
  target: z.number().int().positive().nullable().optional(), // null/absent → clear
  callType: z.enum(['group', 'private']).optional(),
})

/** Run a state-mutating op, mapping argument/precondition errors to InvalidParams. */
function guard(fn: () => void): Record<string, never> {
  try {
    fn()
  } catch (e) {
    throw new InvalidParams((e as Error).message)
  }
  return {}
}

const METHODS: Record<string, Method> = {
  // state + discovery
  'state.get': { params: NoParams, handle: (c) => c.appState },
  'link.stats': { params: NoParams, handle: (c) => c.linkReport() },
  'bt.scan': { params: NoParams, handle: (c) => c.scan() },
  'bt.list': { params: NoParams, handle: (c) => c.listRadios() },
  'bt.adapter': { params: NoParams, handle: (c) => c.adapterInfo() },
  'bt.pair': {
    params: AddressParams,
    handle: async (c, p) => ({ address: await c.pair((p as z.infer<typeof AddressParams>).address) }),
  },
  'bt.forget': {
    params: AddressParams,
    handle: async (c, p) => {
      await c.forget((p as z.infer<typeof AddressParams>).address)
      return { address: (p as z.infer<typeof AddressParams>).address }
    },
  },
  // connection lifecycle
  connect: {
    params: AddressParams,
    handle: async (c, p) => {
      await c.connect((p as z.infer<typeof AddressParams>).address)
      return c.appState
    },
  },
  disconnect: {
    params: NoParams,
    handle: async (c) => {
      await c.disconnect()
      return c.appState
    },
  },
  // live ops
  'setting.set': {
    params: SettingParams,
    handle: (c, p) => {
      const { name, value } = p as z.infer<typeof SettingParams>
      return guard(() => c.setSetting(name, value))
    },
  },
  'ptt.key': { params: NoParams, handle: (c) => guard(() => c.key()) },
  'ptt.unkey': { params: NoParams, handle: (c) => guard(() => c.unkey()) },
  // dismiss the persistent AppState.error banner (works while disconnected — no guard)
  'error.dismiss': {
    params: NoParams,
    handle: (c) => {
      c.clearError()
      return {}
    },
  },
  // channel/zone/side writes (per-side; the engine selects the side first as needed)
  'side.select': {
    params: SideParams,
    handle: (c, p) => guard(() => c.chooseSide((p as z.infer<typeof SideParams>).side)),
  },
  'vfo.setMode': {
    params: VfoModeParams,
    handle: (c, p) => {
      const { side, vfo } = p as z.infer<typeof VfoModeParams>
      return guard(() => c.setVfoMode(side, vfo))
    },
  },
  'channel.step': {
    params: StepParams,
    handle: (c, p) => {
      const { side, dir } = p as z.infer<typeof StepParams>
      return guard(() => c.stepChannel(side, dir))
    },
  },
  'zone.step': {
    params: StepParams,
    handle: (c, p) => {
      const { side, dir } = p as z.infer<typeof StepParams>
      return guard(() => c.stepZone(side, dir))
    },
  },
  'channel.setting': {
    params: ChannelSettingParams,
    handle: (c, p) => {
      const { side, key, value } = p as z.infer<typeof ChannelSettingParams>
      return guard(() => c.setChannelSetting(side, key, value))
    },
  },
  'channel.frequency': {
    params: FrequencyParams,
    handle: (c, p) => {
      const { side, field, hz } = p as z.infer<typeof FrequencyParams>
      return guard(() => c.setFrequency(side, field, hz))
    },
  },
  // Per-side volume knob (08 4a). With the speaker routed to the rear jack, this is also the
  // wired (Digirig) capture level.
  'channel.volume': {
    params: VolumeParams,
    handle: (c, p) => {
      const { side, level } = p as z.infer<typeof VolumeParams>
      return guard(() => c.setVolume(side, level))
    },
  },
  'channel.tone': {
    params: ChannelToneParams,
    handle: (c, p) => {
      const { side, field, type, value, inverted } = p as z.infer<typeof ChannelToneParams>
      return guard(() => c.setChannelTone(side, field, type, value, inverted))
    },
  },
  // Native scan (57 48 / 2f 2b). `scan.lists` is request/response catalogue metadata; start/stop
  // act on the selected side and their outcome flows back on the state stream (scan slice).
  'scan.lists': { params: ForceParams, handle: (c, p) => c.listScanLists((p as z.infer<typeof ForceParams>).force) },
  'scan.start': {
    params: ScanStartParams,
    handle: (c, p) => {
      const { side, listIndex, listName } = p as z.infer<typeof ScanStartParams>
      return guard(() => c.startScan(side, listIndex ?? null, listName ?? null))
    },
  },
  'scan.stop': { params: NoParams, handle: (c) => guard(() => c.stopScan()) },
  // Channel picker: list the selected zone's channels (read), and jump to one (absolute select).
  'zone.channels': {
    params: SideParams,
    handle: (c, p) => c.listChannels((p as z.infer<typeof SideParams>).side),
  },
  'channel.select': {
    params: ChannelSelectParams,
    handle: (c, p) => {
      const { side, position } = p as z.infer<typeof ChannelSelectParams>
      return guard(() => c.selectChannel(side, position))
    },
  },
  // "Go anywhere" picker: enumerate every zone, lazily read a zone's channels, and jump to a
  // channel in ANY zone (switches zone then selects the channel).
  'zone.list': { params: ForceParams, handle: (c, p) => c.listZones((p as z.infer<typeof ForceParams>).force) },
  'zone.channelsIn': {
    params: ZoneChannelsParams,
    handle: (c, p) => {
      const { zoneIndex, force } = p as z.infer<typeof ZoneChannelsParams>
      return c.listZoneChannels(zoneIndex, force)
    },
  },
  'channel.selectIn': {
    params: ZoneChannelSelectParams,
    handle: (c, p) => {
      const { side, zoneIndex, position } = p as z.infer<typeof ZoneChannelSelectParams>
      return guard(() => c.selectZoneChannel(side, zoneIndex, position))
    },
  },
  // Manual DMR dial: a local sticky override for the next PTT (no radio write until you key).
  'dmr.dial': {
    params: DmrDialParams,
    handle: (c, p) => {
      const d = p as z.infer<typeof DmrDialParams>
      return guard(() => (d.target == null ? c.clearManualDial() : c.setManualDial(d.target, d.callType ?? 'group')))
    },
  },
  // Static settings metadata (option tables) — kept OUT of the state; the UI fetches it once to
  // render the editable settings (state stays values-only).
  'settings.catalogue': {
    params: NoParams,
    handle: () =>
      allSettings.map((s) => ({ name: s.name, options: s.options ?? null, description: s.description, menu: s.menu })),
  },
  // Per-channel setting metadata (options + description + mode filter) — the editor for the 2f
  // channel settings; the live values come from the decoded channel block in state.
  'channelSettings.catalogue': {
    params: NoParams,
    handle: () =>
      CHANNEL_SETTINGS.map((s) => ({ key: s.key, label: s.label, options: s.options, description: s.description, modes: s.modes ?? null })),
  },
}

/** Dispatch one parsed request. Returns the response, or null for a notification. */
export async function dispatch(controller: RadioController, raw: unknown): Promise<RpcResponse | null> {
  const parsed = RpcRequest.safeParse(raw)
  if (!parsed.success) return fail(idOf(raw), RpcErrorCode.InvalidRequest, 'invalid request')

  const { id, method, params } = parsed.data
  const isNotification = id === undefined
  const entry = METHODS[method]
  if (!entry) {
    return isNotification ? null : fail(id, RpcErrorCode.MethodNotFound, `method not found: ${method}`)
  }

  const pr = entry.params.safeParse(params)
  if (!pr.success) {
    return isNotification ? null : fail(id, RpcErrorCode.InvalidParams, 'invalid params', pr.error.issues)
  }

  try {
    const result = await entry.handle(controller, pr.data)
    return isNotification ? null : ok(id, result)
  } catch (e) {
    if (e instanceof InvalidParams) {
      return isNotification ? null : fail(id, RpcErrorCode.InvalidParams, e.message)
    }
    return isNotification ? null : fail(id, RpcErrorCode.InternalError, (e as Error).message)
  }
}

export const methodNames: readonly string[] = Object.keys(METHODS)
