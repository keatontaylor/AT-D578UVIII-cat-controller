export interface CommandResult {
  command: string
  response?: string
  error?: string
  ok: boolean
}

export interface PresetExecuteResult {
  ok: boolean
  results: CommandResult[]
  state: object
}

// TODO_ANYTONE: preset (command-macro) execution is not implemented for the
// AnyTone 578.
//
// Dead scaffold endpoint: this proxied to a backend `/preset` route that does
// not exist, so it always failed with an opaque proxied error. A preset model
// that ran arbitrary command strings does not map cleanly to the AnyTone; the
// equivalent would map preset entries onto the confirmed BT writes (PTT,
// side-select, frequency, VFO mode) — that mapping does not exist yet.
//
// Kept as an explicit stub (not deleted) so cat-presets.json and the UI preset
// affordance survive until preset→BT-write mapping is implemented. The result
// interfaces above are preserved for that future implementation.
export default defineEventHandler((): PresetExecuteResult => {
  throw createError({
    statusCode: 501,
    message: 'Preset execution is not yet implemented for AnyTone 578 (no preset→BT-write mapping). See docs/ANYTONE_578_NOTES.md.',
  })
})
