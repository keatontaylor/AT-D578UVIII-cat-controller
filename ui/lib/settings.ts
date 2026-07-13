// Presentation helpers for radio settings — keep capitalization consistent everywhere a setting
// name or option value is shown (badges, dialog, values). The wire/protocol values stay lowercase
// (`off`, `digital`, `L1`); these are display-only.

/** snake_case setting key → Title Case label ("noise_reduction_rx" → "Noise Reduction Rx"). */
export function settingLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Option value → display form: uppercase the first letter, leave the rest ("off" → "Off",
 * "digital" → "Digital", "MicEnhance"/"L1"/"10min" unchanged). */
export function optionDisplay(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value
}

// ── Tile status colors ──────────────────────────────────────────────────────
// One color language across every grid tile: neutral/off values stay uncolored; a set value
// lights the tile. Blue = CTCSS/tone-qualified, purple = DCS-qualified, teal = both combined;
// intensity ramps (squelch level, TX power) run cool → hot.

export const TONE_COLORS = { ctcss: '#58a6ff', dcs: '#a371f7' } as const
const COMBO_TEAL = '#14b8a6'
/** 5-step yellow→red heat ramp shared by every "intensity" setting. Deliberately starts at
 * yellow, NOT green — green is reserved for running states (Scan, Packet TNC). */
const HEAT_RAMP = ['#fde047', '#fbbf24', '#f59e0b', '#f97316', '#f85149'] as const
/** Generic Off/On toggles light up hueless (white border/fill) — "engaged, nothing special" —
 * so they can never be confused with a color that carries meaning (blue = CTCSS, etc.). */
const LIT_NEUTRAL = '#e6edf3'
/** DMR color codes 0–15 mapped around the hue wheel (hsl i×22.5° at 70%/62%, pre-baked to hex
 * for the badge's hex-alpha tint). The hue IS the value — two cards on mismatched CCs visibly
 * disagree, which is the classic DMR failure mode. */
const CC_WHEEL = [
  '#e25a5a', '#e28d5a', '#e2c05a', '#d1e25a', '#9ee25a', '#6be25a', '#5ae27c', '#5ae2af',
  '#5ae2e2', '#5aafe2', '#5a7ce2', '#6b5ae2', '#9e5ae2', '#d15ae2', '#e25ac0', '#e25a8d',
] as const
/** Indigo = operating through/as DMR infrastructure (any non-Simplex DMR mode). */
const DMR_INFRA = '#818cf8'

/** Status color for a setting tile's current value, or null for neutral (off/default).
 * Handles both per-channel keys (camelCase, channel-settings catalogue) and global settings
 * (snake_case). Unknown keys light plain "On" values neutral-white so any enabled toggle reads. */
export function settingValueColor(key: string, value: string): string | null {
  switch (key) {
    case 'txPower':
      return { Low: HEAT_RAMP[0], Medium: HEAT_RAMP[2], High: HEAT_RAMP[3], Turbo: HEAT_RAMP[4] }[value] ?? null
    case 'squelchMode':
      // SQ (carrier only) is the "plain" mode; the qualified modes follow the tone palette.
      return { TONE: TONE_COLORS.ctcss, CDT: TONE_COLORS.dcs, 'C&T': COMBO_TEAL, 'C|T': COMBO_TEAL }[value] ?? null
    case 'analog_squelch_level': {
      const m = /^L([1-5])$/.exec(value)
      return m ? HEAT_RAMP[Number(m[1]) - 1]! : null
    }
    case 'digi_monitor':
      // its own hue pair — DigiMon is unrelated to the tone palette, so it must not share it:
      // cyan = monitoring one slot, pink = casting the wider net (both slots)
      return value === 'single' ? '#22d3ee' : value === 'double' ? '#ec4899' : null
    case 'colorCode': {
      const n = Number(value)
      return Number.isInteger(n) && n >= 0 && n < CC_WHEEL.length ? CC_WHEEL[n]! : null
    }
    case 'txInterrupt':
      // an intensity — rides the shared heat ramp (hot end stays reserved for restrictions)
      return value === 'Low Priority' ? HEAT_RAMP[1] : value === 'High Priority' ? HEAT_RAMP[3] : null
    case 'dmrMode':
      return value && value !== 'Simplex' ? DMR_INFRA : null
    // timeSlot stays neutral on purpose: it always has a value, and permanently-lit tiles
    // dilute "colored = noteworthy". The TS1/TS2 text carries it.
    case 'txProhibit':
    case 'smsForbid':
    case 'dataAckForbid':
      // the restriction family: red = this channel is blocking something
      return value === 'On' ? HEAT_RAMP[4] : null
    default:
      // channel-settings options are capitalized ('On'), global wire values lowercase ('on')
      return value === 'On' || value === 'on' ? LIT_NEUTRAL : null
  }
}

/** The AT-D578UVIII's own menu organization (user manual, "Settings → Radio Set" walk order —
 * the same order the catalogue was harvested in). Tones/audio/display/power follow the manual's
 * functional sub-headings within Radio Set; Bluetooth, Digital Monitor, and GPS are their own
 * top-level menus on the radio. Keys not listed (future decodes) land in "Other". */
export const SETTINGS_GROUPS: ReadonlyArray<{ title: string; keys: readonly string[] }> = [
  {
    title: 'Tones',
    keys: ['key_tone', 'digital_idle', 'analog_idle', 'startup_sound', 'talk_permit', 'd_reset_tone', 'sms_notify', 'call_ring'],
  },
  {
    title: 'Audio',
    keys: [
      'external_audio_jack', 'mic_speaker_set', 'max_volume_level', 'enhanced_sound', 'digital_mic_level',
      'analog_mic_level', 'noise_reduction_rx', 'noise_reduction_tx',
    ],
  },
  {
    title: 'Display',
    keys: [
      'back_light', 'backlight_time', 'channel_display', 'menu_exit_time', 'change_font_color',
      'channel_color_a', 'channel_color_b',
    ],
  },
  {
    title: 'Power & TX',
    keys: ['auto_power_off', 'tx_timer', 'tot_predict', 'activate_fan'],
  },
  {
    title: 'Operation',
    keys: [
      'sub_channel', 'frequency_step', 'tbst_select', 'vox_level', 'vox_delay',
      'scan_mode', 'dtmf_speed',
    ],
  },
  {
    title: 'Bluetooth',
    keys: ['bt_mic_gain', 'bt_speaker_gain', 'bt01_speaker_gain'],
  },
  {
    title: 'GPS',
    keys: ['gps', 'gps_mode', 'gps_area_sql'],
  },
]

/** Global settings surfaced on the channel cards instead of the Radio Settings dialog
 * (GlobalSettingCard in VfoCard): analog squelch on analog channels, DMR promiscuous monitor on
 * digital. Listed here so the dialog's "Other" fallback doesn't resurrect them. */
export const CHANNEL_CARD_SETTINGS: ReadonlySet<string> = new Set([
  'analog_squelch_level',
  'digi_monitor',
])
