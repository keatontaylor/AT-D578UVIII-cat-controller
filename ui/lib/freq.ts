// Split a frequency (MHz) into the three display groups MHz·kHz·Hz the freq readout renders.
export function freqGroups(mhz: number | null): [string, string, string] {
  if (mhz == null) return ['---', '---', '---']
  const h = Math.max(0, Math.round(mhz * 1_000_000))
  return [
    String(Math.floor(h / 1_000_000)).padStart(3, ' '), // non-breaking space → right-align
    String(Math.floor((h % 1_000_000) / 1_000)).padStart(3, '0'),
    String(h % 1_000).padStart(3, '0'),
  ]
}
