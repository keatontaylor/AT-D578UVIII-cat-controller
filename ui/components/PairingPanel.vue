<script setup lang="ts">
// The idle-screen Bluetooth pairing surface — scan → pair → the radio appears in the header
// dropdown (shared radios list), matching the PoC's bt-panel look/feel.
import { onMounted, ref } from 'vue'
import { useRadio } from '../composables/useRadio'

const radio = useRadio()
const { radios, adapter, scanning, state } = radio

const btError = ref<string | null>(null)
const busyAddr = ref<string | null>(null)

async function run(addr: string | null, fn: () => Promise<unknown>): Promise<void> {
  busyAddr.value = addr
  btError.value = null
  try {
    await fn()
  } catch (e) {
    btError.value = (e as { message?: string })?.message ?? String(e)
  } finally {
    busyAddr.value = null
  }
}

const doScan = () => run(null, () => radio.scan())
const pair = (addr: string) => run(addr, () => radio.pair(addr))
const forget = (addr: string) => run(addr, () => radio.forget(addr))

onMounted(() => void radio.refreshRadios())
</script>

<template>
  <div class="idle-screen">
    <div class="idle-icon">📡</div>
    <p>Scan and pair your radio below, then select it above and <strong>Connect</strong>.</p>

    <div class="bt-panel">
      <div class="bt-panel-head">
        <strong>Bluetooth radios</strong>
        <span v-if="adapter" class="bt-adapter">
          adapter {{ adapter.address }} · {{ adapter.powered ? 'powered' : 'off' }}
        </span>
        <button class="btn btn-ghost" :disabled="scanning || !!busyAddr" @click="doScan">
          {{ scanning ? 'Scanning…' : 'Scan' }}
        </button>
      </div>
      <p v-if="btError" class="bt-error">{{ btError }}</p>
      <ul class="bt-radio-list">
        <li
          v-for="r in radios"
          :key="r.address"
          class="bt-radio"
          :class="{ 'bt-radio--active': r.address === state?.address }"
        >
          <span class="bt-radio-name">{{ r.name || r.address }}</span>
          <span class="bt-radio-addr">{{ r.address }}</span>
          <span class="bt-radio-flags">
            <span class="bt-flag" :class="r.paired ? 'bt-flag--ok' : 'bt-flag--warn'">{{ r.paired ? 'paired' : 'unpaired' }}</span>
            <span v-if="r.trusted" class="bt-flag bt-flag--ok">trusted</span>
            <span v-if="r.connected" class="bt-flag bt-flag--ok">connected</span>
          </span>
          <button v-if="!r.paired" class="btn btn-primary btn-sm" :disabled="!!busyAddr" @click="pair(r.address)">
            {{ busyAddr === r.address ? '…' : 'Pair' }}
          </button>
          <button
            v-else
            class="btn btn-ghost btn-sm"
            :disabled="!!busyAddr"
            title="Remove bond (forces a fresh pair next Connect)"
            @click="forget(r.address)"
          >
            {{ busyAddr === r.address ? '…' : 'Forget' }}
          </button>
        </li>
        <li v-if="!radios.length" class="bt-radio-empty">
          No radios known yet — power the radio on with Bluetooth enabled, then Scan.
        </li>
      </ul>
    </div>
  </div>
</template>
