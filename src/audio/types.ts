// AudioLink seam (ARCHITECTURE: a transplanted service behind a narrow interface). The radio
// engages its remote-head SPP control only once the HFP audio profile is genuinely connected,
// so the connection sequence must bring audio up and CONFIRM it before opening the control
// socket. This interface is the minimal surface that the connect orchestration needs; the
// concrete BlueALSA implementation is injected (and faked in tests).

export type AudioLogger = (message: string) => void

export interface AbortOptions {
  readonly signal?: AbortSignal
}

export interface AudioLink {
  /** Resolve this radio's HFP source PCM path on the active adapter (e.g. /org/bluez/hci0). */
  pcmPath(address: string, adapterPath: string | null): string
  /** Ensure the (isolated, HFP-only) audio daemon is running. */
  ensureDaemon(opts?: AbortOptions): Promise<void>
  /** Wait until the radio's HFP source PCM registers — proof the HFP profile connected. */
  waitForPcm(pcm: string, timeoutMs: number, opts?: AbortOptions): Promise<void>
  /** The command that streams a PCM's raw bytes (8 kHz mono S16LE) to stdout, for RX capture. */
  captureCommand(pcm: string): { command: string; args: readonly string[] }
  /** This radio's HFP SINK PCM path — where mic audio (TX) is written. */
  pcmSinkPath(address: string, adapterPath: string | null): string
  /** The command whose STDIN accepts 8 kHz mono S16LE bytes and plays them to the sink (mic TX). */
  playCommand(sink: string): { command: string; args: readonly string[] }
}
