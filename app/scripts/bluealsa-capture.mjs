#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

const DEFAULT_ADDR = 'AA:BB:CC:DD:EE:FF'
const DEFAULT_PCM = `/org/bluealsa/hci0/dev_${DEFAULT_ADDR.replace(/:/g, '_')}/hfphf/source`

const args = parseArgs(process.argv.slice(2))
const addr = args.addr || process.env.ANYTONE_BT_ADDR || DEFAULT_ADDR
const pcm = args.pcm || process.env.ANYTONE_BLUEALSA_PCM || DEFAULT_PCM
const stopWirePlumber = envFlag('ANYTONE_BLUEALSA_STOP_WIREPLUMBER', true)
const bluealsaCommand = process.env.ANYTONE_BLUEALSA_COMMAND || 'bluealsa'
const bluealsaCliCommand = process.env.ANYTONE_BLUEALSA_CLI_COMMAND || 'bluealsa-cli'
// Target the app's isolated BlueALSA instance (org.bluealsa.<suffix>) so we attach
// to its HFP PCM and never the system daemon. Our instance is always-on, so the
// "attach to existing" path is taken and we never spawn our own daemon here.
const bluealsaDbus = process.env.ANYTONE_BLUEALSA_DBUS ?? 'anytone'
const cliPre = bluealsaDbus ? ['-B', bluealsaDbus] : []
const bluetoothctlCommand = process.env.ANYTONE_BLUETOOTHCTL_COMMAND || 'bluetoothctl'
const sudoCommand = process.env.ANYTONE_SUDO_COMMAND || 'sudo'
const useSudo = envFlag('ANYTONE_BLUEALSA_SUDO', true)
const keepAlive = process.env.ANYTONE_BLUEALSA_KEEPALIVE || '30'
const logLevel = process.env.CAT_AUDIO_DEBUG === '1' ? 'debug' : 'warning'

let shuttingDown = false
let bluealsa = null
let opener = null
let wirePlumberStopped = false
let externalBluealsa = false

process.once('SIGINT', () => void shutdown(130))
process.once('SIGTERM', () => void shutdown(143))
process.stdout.on('error', () => void shutdown(0))

void main().catch(err => {
  console.error(`[bluealsa-capture] ${err?.message ?? err}`)
  void shutdown(1)
})

async function main() {
  // If the AnyTone control backend already runs BlueALSA, just attach to its PCM.
  const existing = spawnSync(bluealsaCliCommand, [...cliPre, 'list-pcms'], { encoding: 'utf8' })
  if (existing.status === 0) {
    externalBluealsa = true
    await waitForPcm(pcm, 8000)
    openPcm()
    return
  }

  if (stopWirePlumber) {
    run('systemctl', ['--user', 'stop', 'wireplumber'], { ignoreError: true })
    wirePlumberStopped = true
    await delay(1200)
  }

  const bluealsaArgs = ['-p', 'hfp-hf', '--keep-alive', keepAlive, '--loglevel', logLevel]
  bluealsa = spawnCommand(bluealsaCommand, bluealsaArgs, { sudo: useSudo, label: 'bluealsa' })
  bluealsa.stderr?.on('data', chunk => {
    if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
  })
  bluealsa.on('exit', (code, signal) => {
    if (!shuttingDown) console.error(`[bluealsa-capture] bluealsa exited (${signal ?? code})`)
  })

  await delay(1600)
  run(bluetoothctlCommand, ['connect', addr], { ignoreError: true })
  await waitForPcm(pcm, 15000)
  openPcm()
}

function openPcm() {
  opener = spawn(bluealsaCliCommand, [...cliPre, 'open', pcm], { stdio: ['ignore', 'pipe', 'pipe'] })
  opener.stdout.pipe(process.stdout)
  opener.stderr?.on('data', chunk => process.stderr.write(chunk))
  opener.on('error', err => {
    console.error(`[bluealsa-capture] cannot open BlueALSA PCM: ${err.message}`)
    void shutdown(1)
  })
  opener.on('close', code => {
    void shutdown(code === 0 ? 0 : code ?? 1)
  })
}

async function waitForPcm(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const result = spawnSync(bluealsaCliCommand, [...cliPre, 'list-pcms'], { encoding: 'utf8' })
    last = `${result.stdout || ''}${result.stderr || ''}`
    if (result.status === 0 && last.includes(path)) return
    await delay(350)
  }
  throw new Error(`BlueALSA PCM did not appear: ${path}${last ? ` (${last.trim()})` : ''}`)
}

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  if (opener && !opener.killed) opener.kill('SIGTERM')
  if (!externalBluealsa) {
    if (bluealsa && !bluealsa.killed) bluealsa.kill('SIGTERM')
    await delay(350)
    if (bluealsa && !bluealsa.killed) bluealsa.kill('SIGKILL')
    if (useSudo) run(sudoCommand, ['-n', 'pkill', '-x', 'bluealsa'], { ignoreError: true })
  }
  if (wirePlumberStopped) run('systemctl', ['--user', 'start', 'wireplumber'], { ignoreError: true })
  process.exit(code)
}

function spawnCommand(command, args, options = {}) {
  if (options.sudo) return spawn(sudoCommand, ['-n', command, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.ignoreError ? 'ignore' : 'inherit' })
  if (!options.ignoreError && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
  return result
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--addr') parsed.addr = argv[++i]
    else if (arg === '--pcm') parsed.pcm = argv[++i]
  }
  return parsed
}

function envFlag(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}
