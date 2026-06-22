<template>
  <div class="app">
    <!-- ── Header / Connection Bar ── -->
    <header class="header">
      <div class="header-brand">
        <span class="brand-logo">AT-D578UVIII</span>
        <span class="brand-sub">BT / Wired Controller</span>
      </div>

      <div class="conn-bar">
        <select v-model="selectedDropdown" class="sel" :disabled="state.connected">
          <option v-for="p in transportOptions" :key="p.value" :value="p.value">
            {{ p.label }}<template v-if="p.manufacturer"> — {{ p.manufacturer }}</template>
          </option>
        </select>

        <button class="btn" :class="state.connected ? 'btn-danger' : 'btn-primary'" @click="toggleConnection" :disabled="connecting">
          {{ connecting ? '…' : state.connected ? 'Disconnect' : 'Connect' }}
        </button>
      </div>

      <div v-show="state.connected" class="audio-listener" :class="{ 'audio-listener--active': audioListening, 'audio-listener--reconnecting': audioWebRtcState === 'reconnecting' }">
        <button class="btn btn-ghost" @click="toggleAudio" :disabled="audioBusy || audioStatus?.available === false" :title="audioTitle">
          {{ audioToggleLabel }}
        </button>
        <button
          class="btn btn-ghost btn-audio-fallback"
          :class="{ 'btn-audio-fallback--active': audioReceiveMode === 'playback' }"
          :disabled="audioBusy || audioStatus?.available === false"
          :title="audioPlaybackTitle"
          @click="togglePlaybackAudio"
        >{{ audioPlaybackToggleLabel }}</button>
        <button
          class="btn btn-ghost"
          :class="{ 'btn-tx--active': audioMicActive }"
          :disabled="!audioReadyForTx || !state.connected || audioTxActive || audioTxBusy || (txProhibited && !audioMicActive)"
          :title="audioMicTitle"
          @click="toggleAudioMic"
        >{{ audioMicLabel }}</button>
        <button
          class="btn btn-ghost btn-audio-stats"
          :class="{ 'btn-audio-stats--active': webrtcStatsOpen }"
          :disabled="!webrtcStatsAvailable"
          :title="webrtcStatsTitle"
          @click="toggleWebRtcStats"
        >Stats</button>
        <span class="audio-listener-label">{{ audioLabel }}</span>
        <!-- Live-audio playback sink. Kept in the DOM (it is where WebRTC/
             playback audio actually plays) but visually hidden — the in-page
             Start/Stop button drives it, and MediaSession still exposes it on
             the lock screen. The inline now-playing UI + native controls were
             redundant with the Start/Stop button, so they were removed. -->
        <audio
          ref="audioPlayerRef"
          class="webrtc-media-player webrtc-media-player--hidden"
          playsinline
          webkit-playsinline="true"
          x-webkit-airplay="allow"
          preload="none"
          @play="onAudioElementPlay"
          @pause="onAudioElementPause"
          @ended="onAudioElementPause"
          @error="onAudioElementError"
        />
      </div>
    </header>

    <!-- ── Error banner ── -->
    <div v-if="lastError" class="error-banner">
      {{ lastError }}
      <button class="close-btn" @click="lastError = null">✕</button>
    </div>

    <!-- ── Main dashboard (only when connected) ── -->
    <main v-if="state.connected" class="dashboard">

      <!-- ── VFO Section ── -->
      <section class="vfo-section">
        <!-- SUB VFO -->
        <div class="vfo-card sub-card"
          :class="{
            'vfo-card--tx-vfo':    state.txVfo === 1,
            'vfo-card--inactive':  state.rxMode === 'single' && state.txVfo === 0 && state.split,
            'vfo-card--rx-only':   state.rxMode === 'dual' && state.txVfo === 0,
            'vfo-card--switchable': state.rxMode === 'single' && state.txVfo === 0 && !state.split,
            'vfo-card--selectable': state.connected && state.txVfo !== 1,
          }"
          @click="switchToVfoFromCard('1', $event)"
        >
          <div class="vfo-header">
            <div class="vfo-title-row">
              <span class="vfo-label">SUB</span>
              <span class="memory-state-badge" :class="memoryBadgeClass('1')">{{ subMemoryDisplay }}</span>
              <span v-if="state.txVfo === 1" class="tx-vfo-badge">TX/RX</span>
              <span v-else class="rx-vfo-badge">RX</span>
            </div>
            <div class="vfo-control-row">
              <span class="band-sel vfo-readout zone-readout" :title="zoneBadgeTitle('1')">{{ zoneBadgeValue('1') }}</span>
            </div>
            <div class="vfo-step-row">
              <div class="channel-control">
                <button class="channel-step-btn channel-step-btn--label" :disabled="channelStepBusy || !state.connected" @click.stop="sendTxRxChannelStep('DN', '1')" title="Channel down" aria-label="Channel down">Ch −</button>
                <button class="channel-step-btn channel-step-btn--label" :disabled="channelStepBusy || !state.connected" @click.stop="sendTxRxChannelStep('UP', '1')" title="Channel up" aria-label="Channel up">Ch +</button>
              </div>
              <div class="channel-control zone-control">
                <button class="channel-step-btn channel-step-btn--label" :disabled="zoneStepBusy || !state.connected" @click.stop="sendZoneStep('ZONE_DN', '1')" title="Zone down" aria-label="Zone down">Zone −</button>
                <button class="channel-step-btn channel-step-btn--label" :disabled="zoneStepBusy || !state.connected" @click.stop="sendZoneStep('ZONE_UP', '1')" title="Zone up" aria-label="Zone up">Zone +</button>
              </div>
            </div>
          </div>
          <div class="sql-row">
            <span class="sql-badge sql-badge--mode" :style="modeBadgeStyle(state.subMode)" title="Mode (read-only)">{{ state.subMode ?? '--' }}</span>
            <span v-if="state.subMode === 'DMR' && (state.subContactName || state.subContactTg)" class="sql-badge sql-badge--contact" title="DMR contact (call type)">
              {{ vfoContactPrefix('1') }} {{ state.subContactName || state.subContactTg }}<span v-if="state.subContactName && state.subContactTg" class="sql-tone">{{ state.subContactTg }}</span>
            </span>
            <span v-if="vfoDmrLiveTalkgroup('1')" class="sql-badge sql-badge--dmr-live" title="Incoming DMR call on a different talkgroup">
              {{ vfoDmrLiveTalkgroup('1') }}
            </span>
            <span v-if="vfoDmrCallerDisplay('1')" class="sql-badge sql-badge--dmr-caller" title="DMR caller">
              {{ vfoDmrCallerDisplay('1') }}
            </span>
            <!-- TX frequency now shown in the dedicated split-freq-row below. -->
          </div>
          <div class="freq-block">
          <div class="freq-row">
            <!--div class="freq-display freq-sub">
              {{ formatFreq(state.subFreq) }}
            </div>
            <div class="freq-sep" / -->
            <div
              class="freq-tuner freq-sub"
              :class="{ 'freq-tx': (state.txState || state.mox) && state.txVfo === 1, 'freq-tuner--editable': isFrequencyEditable('1') }"
              :title="frequencyEditTitle('1')"
              :role="isFrequencyEditable('1') ? 'button' : undefined"
              :tabindex="isFrequencyEditable('1') ? 0 : undefined"
              @click="openFrequencyEditor('1')"
              @keydown.enter.space.prevent="openFrequencyEditor('1')"
            >
              <template v-for="(group, gi) in freqGroups(state.subFreq)" :key="gi">
                <span v-if="gi > 0" class="freq-dot">.</span>
                <div class="freq-group">{{ group }}</div>
              </template>
            </div>
            <span class="freq-unit">MHz</span>
          </div>
          <div class="split-freq-row">
            <span class="split-freq-label">TX</span>
            <div
              class="split-freq-tuner"
              :class="{ 'split-freq-tuner--editable': isFrequencyEditable('1'), 'split-freq-tuner--prohibited': state.subTxProhibit }"
              :title="txFrequencyEditTitle('1')"
              :role="isFrequencyEditable('1') ? 'button' : undefined"
              :tabindex="isFrequencyEditable('1') ? 0 : undefined"
              @click="openTxFrequencyEditor('1')"
              @keydown.enter.space.prevent="openTxFrequencyEditor('1')"
            >
              <template v-for="(group, gi) in freqGroups(vfoTxFreq('1'))" :key="gi">
                <span v-if="gi > 0" class="freq-dot">.</span>
                <div class="freq-group">{{ group }}</div>
              </template>
            </div>
            <span class="split-freq-unit">MHz</span>
          </div>
          <BandwidthDisplay
            :mode="state.subMode"
            :bandwidth="state.subBandwidth"
          />
          </div>
          <SMeter :value="state.subSmeter" label="SUB S-meter" />
          <LevelBar v-if="(state.sqlRfMode===0)||((state.sqlRfMode===2)&&isRfGainMode(state.subMode))" :value="state.rfGainSub" label="RF GAIN" color="linear-gradient(90deg,#f59e0b,#fcd34d)" />
          <LevelBar v-if="(state.sqlRfMode===1)||((state.sqlRfMode===2)&&(!isRfGainMode(state.subMode)))" :value="state.sqSub" label="SQUELCH" color="linear-gradient(90deg,#f59e0b,#fcd34d)" />
          <!-- Per-channel settings (2f writes) for SUB/B — editing selects this side first. -->
          <section v-if="state.connected && state.subChannelSettings.length" class="status-section channel-settings">
            <div class="ctl-box" :class="{ 'ctl-box--open': vfoMemoryModeBusy === '1' }" role="button" tabindex="0" :title="vfoMemoryModeTitle('1')" @click.stop="toggleVfoMemoryMode('1')" @keydown.enter.space.prevent="toggleVfoMemoryMode('1')">
              <StatusBadge label="VFO/MEM" :value="vfoMemoryModeButtonLabel('1')" :active="vfoMemoryModeBusy === '1'" color-active="#58a6ff" />
            </div>
            <div v-if="state.subRxTone" class="ctl-box" :class="{ 'ctl-box--open': tonePopup?.vfo === '1' && tonePopup?.field === 'rx' }" role="button" tabindex="0" title="Edit RX Tone (SUB)" @click.stop="openTonePopup('1', 'rx')" @keydown.enter.space.prevent="openTonePopup('1', 'rx')">
              <StatusBadge label="RX Tone" :value="state.subRxTone.display" :active="tonePopup?.vfo === '1' && tonePopup?.field === 'rx'" color-active="#58a6ff" />
            </div>
            <div v-if="state.subTxTone" class="ctl-box" :class="{ 'ctl-box--open': tonePopup?.vfo === '1' && tonePopup?.field === 'tx' }" role="button" tabindex="0" title="Edit TX Tone (SUB)" @click.stop="openTonePopup('1', 'tx')" @keydown.enter.space.prevent="openTonePopup('1', 'tx')">
              <StatusBadge label="TX Tone" :value="state.subTxTone.display" :active="tonePopup?.vfo === '1' && tonePopup?.field === 'tx'" color-active="#58a6ff" />
            </div>
            <div v-if="state.subMode === 'DMR'" class="ctl-box" :class="{ 'ctl-box--open': manualDialPopup === '1' }" role="button" tabindex="0" title="Manual dial DMR contact (SUB)" @click.stop="openManualDialPopup('1')" @keydown.enter.space.prevent="openManualDialPopup('1')">
              <StatusBadge label="Manual Dial" :value="manualDialBadgeValue" :active="manualDialPopup === '1' || !!state.manualDial" :color-active="state.manualDial ? '#f59e0b' : '#58a6ff'" />
            </div>
            <div
              v-for="cs in state.subChannelSettings"
              :key="cs.key"
              class="ctl-box"
              :class="{ 'ctl-box--open': settingPopupSide === 'B' && settingPopup === cs.key }"
              role="button"
              tabindex="0"
              :title="`Edit ${cs.label} (SUB)`"
              @click.stop="openChannelSettingPopup('1', cs.key)"
              @keydown.enter.space.prevent="openChannelSettingPopup('1', cs.key)"
            >
              <StatusBadge :label="cs.label" :value="cs.display" :active="settingPopupSide === 'B' && settingPopup === cs.key" color-active="#58a6ff" />
            </div>
          </section>
        </div>

        <!-- MAIN VFO -->
        <div class="vfo-card main-card"
             :class="{
            'vfo-card--tx-vfo':    state.txVfo === 0,
            'vfo-card--inactive':  state.rxMode === 'single' && state.txVfo === 1 && state.split,
            'vfo-card--rx-only':   state.rxMode === 'dual' && state.txVfo === 1,
            'vfo-card--switchable': state.rxMode === 'single' && state.txVfo === 1 && !state.split,
            'vfo-card--selectable': state.connected && state.txVfo !== 0,
          }"
          @click="switchToVfoFromCard('0', $event)"
        >
          <div class="vfo-header">
            <div class="vfo-title-row">
              <span class="vfo-label">MAIN</span>
              <span class="memory-state-badge" :class="memoryBadgeClass('0')">{{ mainMemoryDisplay }}</span>
              <span v-if="state.txVfo === 0" class="tx-vfo-badge">TX/RX</span>
              <span v-else class="rx-vfo-badge">RX</span>
            </div>
            <div class="vfo-control-row">
              <span class="band-sel vfo-readout zone-readout" :title="zoneBadgeTitle('0')">{{ zoneBadgeValue('0') }}</span>
            </div>
            <div class="vfo-step-row">
              <div class="channel-control">
                <button class="channel-step-btn channel-step-btn--label" :disabled="channelStepBusy || !state.connected" @click.stop="sendTxRxChannelStep('DN', '0')" title="Channel down" aria-label="Channel down">Ch −</button>
                <button class="channel-step-btn channel-step-btn--label" :disabled="channelStepBusy || !state.connected" @click.stop="sendTxRxChannelStep('UP', '0')" title="Channel up" aria-label="Channel up">Ch +</button>
              </div>
              <div class="channel-control zone-control">
                <button class="channel-step-btn channel-step-btn--label" :disabled="zoneStepBusy || !state.connected" @click.stop="sendZoneStep('ZONE_DN', '0')" title="Zone down" aria-label="Zone down">Zone −</button>
                <button class="channel-step-btn channel-step-btn--label" :disabled="zoneStepBusy || !state.connected" @click.stop="sendZoneStep('ZONE_UP', '0')" title="Zone up" aria-label="Zone up">Zone +</button>
              </div>
            </div>
          </div>
          <div class="sql-row">
            <span class="sql-badge sql-badge--mode" :style="modeBadgeStyle(state.mainMode)" title="Mode (read-only)">{{ state.mainMode ?? '--' }}</span>
            <span v-if="state.mainMode === 'DMR' && (state.mainContactName || state.mainContactTg)" class="sql-badge sql-badge--contact" title="DMR contact (call type)">
              {{ vfoContactPrefix('0') }} {{ state.mainContactName || state.mainContactTg }}<span v-if="state.mainContactName && state.mainContactTg" class="sql-tone">{{ state.mainContactTg }}</span>
            </span>
            <span v-if="vfoDmrLiveTalkgroup('0')" class="sql-badge sql-badge--dmr-live" title="Incoming DMR call on a different talkgroup">
              {{ vfoDmrLiveTalkgroup('0') }}
            </span>
            <span v-if="vfoDmrCallerDisplay('0')" class="sql-badge sql-badge--dmr-caller" title="DMR caller">
              {{ vfoDmrCallerDisplay('0') }}
            </span>
            <!-- TX frequency now shown in the dedicated split-freq-row below. -->
          </div>
          <div class="freq-block">
          <div class="freq-row">
            <!-- div class="freq-display" :class="{ 'freq-tx': state.txState || state.mox }">
              {{ formatFreq(state.mainFreq) }}
            </div>
            <div class="freq-sep" / -->
            <div
              class="freq-tuner"
              :class="{ 'freq-tx': (state.txState || state.mox) && state.txVfo === 0, 'freq-tuner--editable': isFrequencyEditable('0') }"
              :title="frequencyEditTitle('0')"
              :role="isFrequencyEditable('0') ? 'button' : undefined"
              :tabindex="isFrequencyEditable('0') ? 0 : undefined"
              @click="openFrequencyEditor('0')"
              @keydown.enter.space.prevent="openFrequencyEditor('0')"
            >
              <template v-for="(group, gi) in freqGroups(state.mainFreq)" :key="gi">
                <span v-if="gi > 0" class="freq-dot">.</span>
                <div class="freq-group">{{ group }}</div>
              </template>
            </div>
            <span class="freq-unit">MHz</span>
          </div>
          <div class="split-freq-row">
            <span class="split-freq-label">TX</span>
            <div
              class="split-freq-tuner"
              :class="{ 'split-freq-tuner--editable': isFrequencyEditable('0'), 'split-freq-tuner--prohibited': state.mainTxProhibit }"
              :title="txFrequencyEditTitle('0')"
              :role="isFrequencyEditable('0') ? 'button' : undefined"
              :tabindex="isFrequencyEditable('0') ? 0 : undefined"
              @click="openTxFrequencyEditor('0')"
              @keydown.enter.space.prevent="openTxFrequencyEditor('0')"
            >
              <template v-for="(group, gi) in freqGroups(vfoTxFreq('0'))" :key="gi">
                <span v-if="gi > 0" class="freq-dot">.</span>
                <div class="freq-group">{{ group }}</div>
              </template>
            </div>
            <span class="split-freq-unit">MHz</span>
          </div>
          <BandwidthDisplay
            :mode="state.mainMode"
            :bandwidth="state.mainBandwidth"
          />
          </div>
          <SMeter :value="state.mainSmeter" label="MAIN S-meter" />
          <LevelBar v-if="(state.sqlRfMode===0)||((state.sqlRfMode===2)&&isRfGainMode(state.mainMode))" :value="state.rfGainMain" label="RF GAIN" color="linear-gradient(90deg,#f59e0b,#fcd34d)" />
          <LevelBar v-if="(state.sqlRfMode===1)||((state.sqlRfMode===2)&&(!isRfGainMode(state.mainMode)))" :value="state.sqMain" label="SQUELCH" color="linear-gradient(90deg,#f59e0b,#fcd34d)" />
          <!-- Per-channel settings (2f writes) for MAIN/A — editing selects this side first. -->
          <section v-if="state.connected && state.mainChannelSettings.length" class="status-section channel-settings">
            <div class="ctl-box" :class="{ 'ctl-box--open': vfoMemoryModeBusy === '0' }" role="button" tabindex="0" :title="vfoMemoryModeTitle('0')" @click.stop="toggleVfoMemoryMode('0')" @keydown.enter.space.prevent="toggleVfoMemoryMode('0')">
              <StatusBadge label="VFO/MEM" :value="vfoMemoryModeButtonLabel('0')" :active="vfoMemoryModeBusy === '0'" color-active="#58a6ff" />
            </div>
            <div v-if="state.mainRxTone" class="ctl-box" :class="{ 'ctl-box--open': tonePopup?.vfo === '0' && tonePopup?.field === 'rx' }" role="button" tabindex="0" title="Edit RX Tone (MAIN)" @click.stop="openTonePopup('0', 'rx')" @keydown.enter.space.prevent="openTonePopup('0', 'rx')">
              <StatusBadge label="RX Tone" :value="state.mainRxTone.display" :active="tonePopup?.vfo === '0' && tonePopup?.field === 'rx'" color-active="#58a6ff" />
            </div>
            <div v-if="state.mainTxTone" class="ctl-box" :class="{ 'ctl-box--open': tonePopup?.vfo === '0' && tonePopup?.field === 'tx' }" role="button" tabindex="0" title="Edit TX Tone (MAIN)" @click.stop="openTonePopup('0', 'tx')" @keydown.enter.space.prevent="openTonePopup('0', 'tx')">
              <StatusBadge label="TX Tone" :value="state.mainTxTone.display" :active="tonePopup?.vfo === '0' && tonePopup?.field === 'tx'" color-active="#58a6ff" />
            </div>
            <div v-if="state.mainMode === 'DMR'" class="ctl-box" :class="{ 'ctl-box--open': manualDialPopup === '0' }" role="button" tabindex="0" title="Manual dial DMR contact (MAIN)" @click.stop="openManualDialPopup('0')" @keydown.enter.space.prevent="openManualDialPopup('0')">
              <StatusBadge label="Manual Dial" :value="manualDialBadgeValue" :active="manualDialPopup === '0' || !!state.manualDial" :color-active="state.manualDial ? '#f59e0b' : '#58a6ff'" />
            </div>
            <div
              v-for="cs in state.mainChannelSettings"
              :key="cs.key"
              class="ctl-box"
              :class="{ 'ctl-box--open': settingPopupSide === 'A' && settingPopup === cs.key }"
              role="button"
              tabindex="0"
              :title="`Edit ${cs.label} (MAIN)`"
              @click.stop="openChannelSettingPopup('0', cs.key)"
              @keydown.enter.space.prevent="openChannelSettingPopup('0', cs.key)"
            >
              <StatusBadge :label="cs.label" :value="cs.display" :active="settingPopupSide === 'A' && settingPopup === cs.key" color-active="#58a6ff" />
            </div>
          </section>
        </div>

      </section>

      <!-- ── Radio Settings ── -->
      <section class="status-panel">
        <div class="status-panel-header">
          <span class="scope-title">Radio Settings</span>
        </div>
        <!-- One uniform grid of badge-boxes. Writable settings are click-to-edit
             boxes (popup editor → 08 write); read-only ones (Fan/GPS) are plain
             badges. All driven by the backend RADIO_SETTINGS projection. -->
        <div class="status-section">
          <template v-if="state.connected">
            <template v-for="s in state.settings" :key="s.key">
              <div
                v-if="s.writable"
                class="ctl-box"
                :class="{ 'ctl-box--open': settingPopup === s.key }"
                role="button"
                tabindex="0"
                :title="`Edit ${s.label}`"
                @click="openSettingPopup(s.key)"
                @keydown.enter.space.prevent="openSettingPopup(s.key)"
              >
                <StatusBadge :label="s.label" :value="s.display" :active="settingPopup === s.key" color-active="#58a6ff" />
              </div>
              <StatusBadge v-else :label="s.label" :value="s.display" />
            </template>
          </template>
        </div>
      </section>

      <!-- ── Zones / Channels (click a zone to reveal its channels inline) ── -->
      <section class="zones-panel">
        <div class="zones-header">
          <span class="scope-title">Zones / Channels</span>
          <span v-if="zoneList.length" class="zones-count">{{ zoneList.length }}</span>
          <span class="zones-target">Target {{ activeVfo === '0' ? 'MAIN' : 'SUB' }}</span>
          <button class="btn btn-ghost btn-sm zones-refresh-btn" :disabled="zonesBusy || !state.connected" @click="loadZones(true)">{{ zonesBusy ? '…' : 'Refresh' }}</button>
        </div>
        <div v-if="zonesBusy && !zoneList.length" class="zones-empty">Enumerating zones…</div>
        <div v-else-if="!zoneList.length" class="zones-empty">No zones</div>
        <div v-else class="zone-accordion">
          <div
            v-for="zone in zoneList"
            :key="zone.index"
            class="zone-group"
            :class="{ 'zone-group--open': expandedZone && expandedZone.index === zone.index }"
          >
            <button
              type="button"
              class="zone-row"
              :class="{ 'zone-row--active': activeZoneName === zone.name }"
              @click="toggleZone(zone.index)"
            >
              <span class="zone-row-caret">{{ expandedZone && expandedZone.index === zone.index ? '▾' : '▸' }}</span>
              <span class="zone-row-name">{{ zone.name }}</span>
              <span v-if="activeZoneName === zone.name" class="zone-row-badge">active</span>
              <span class="zone-row-count">{{ zone.channels.length }} ch</span>
            </button>
            <div v-if="expandedZone && expandedZone.index === zone.index" class="zone-channels channels-list">
              <div v-if="!zone.channels.length" class="zones-empty zones-empty--sm">No channels in this zone</div>
              <button
                v-for="ch in zone.channels"
                :key="ch.index"
                type="button"
                class="ch-badge"
                :class="{ 'ch-badge--active': activeZoneName === zone.name && activeChannelNumber === ch.channelNumber }"
                :disabled="channelJumpBusy != null"
                :title="`Go to ${zone.name} · MEM ${String(ch.channelNumber).padStart(5, '0')} · ${ch.name}`"
                @click="jumpToChannel(zone.index, ch.index)"
              >
                <span class="ch-freq">{{ ch.name }}</span>
                <span v-if="channelJumpBusy === `${zone.index}:${ch.index}`" class="ch-sql">…</span>
                <span v-else class="ch-sql">{{ String(ch.channelNumber).padStart(5, '0') }}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- ── Bottom panels row ── -->
      <div class="bottom-panels">



        <!-- Squelch recordings timeline -->
        <section class="recordings-panel">
          <div class="recordings-header">
            <div class="recordings-title-row">
              <span class="scope-title">Recordings</span>
              <span class="channels-count">{{ recordings.length }}</span>
              <span class="recording-state" :class="{ 'recording-state--on': recordingEnabled }">
                {{ recordingEnabled ? 'Recording squelch' : 'Recorder off' }}
              </span>
            </div>
            <div class="recordings-header-actions">
              <button class="btn btn-ghost btn-sm" :disabled="recordingBusy" @click="refreshRecordings">Refresh</button>
              <button
                class="btn btn-sm"
                :class="recordingEnabled ? 'btn-danger' : 'btn-primary'"
                :disabled="recordingBusy"
                @click="toggleRecordingEnabled"
              >{{ recordingEnabled ? 'Stop Recorder' : 'Record Squelch' }}</button>
            </div>
          </div>
          <div class="recordings-controls">
            <button class="btn btn-ghost btn-sm" @click="shiftRecordingWindow(-1)">&lt;</button>
            <button class="btn btn-ghost btn-sm" @click="setRecordingWindowNow">Now</button>
            <button class="btn btn-ghost btn-sm" @click="shiftRecordingWindow(1)">&gt;</button>
            <span class="recording-controls-label">Window</span>
            <span class="btn-select-wrap">
              <select v-model.number="recordingRangeHours" @change="loadRecordings">
                <option :value="0.25">15 min</option>
                <option :value="0.5">30 min</option>
                <option :value="1">1 hr</option>
                <option :value="6">6 hr</option>
                <option :value="24">24 hr</option>
                <option :value="168">7d</option>
              </select>
            </span>
            <span class="recording-controls-label">Channel</span>
            <span class="btn-select-wrap">
              <select v-model="recordingChannelFilter">
                <option value="all">All</option>
                <option v-for="lane in recordingChannelOptions" :key="lane.key" :value="lane.key">{{ lane.label }}</option>
              </select>
            </span>
            <span class="recording-controls-label">Min Length</span>
            <label class="recording-duration-filter" title="Hide clips shorter than this duration">
              <input v-model.number="recordingMinDurationSeconds" type="range" min="0" max="60" step="1" />
              <span>{{ recordingMinDurationLabel }}</span>
            </label>
            <span class="recording-controls-label">Skip Tail</span>
            <label class="recording-duration-filter" title="Jump to the next clip this many seconds before playback ends">
              <input v-model.number="recordingTailSkipSeconds" type="range" min="0" max="5" step="0.25" />
              <span>{{ recordingTailSkipLabel }}</span>
            </label>
            <span class="recording-transport">
              <button class="btn btn-ghost btn-sm" :disabled="!recordingPlaybackCanPlay" @click="toggleRecordingPlayback">
                {{ recordingPlaybackPlaying ? 'Pause' : 'Play' }}
              </button>
              <button class="btn btn-ghost btn-sm" :disabled="!recordingPlaybackCanPlay" @click="playNextRecordingClip">Next</button>
              <span class="recording-playback-status">{{ recordingPlaybackStatus }}</span>
            </span>
          </div>
          <div class="recordings-window-label">
            {{ formatRecordingDateTime(recordingWindowStart) }} - {{ formatRecordingDateTime(recordingDisplayEnd) }}
          </div>
          <div class="recordings-timeline-shell">
            <div
              class="recordings-timeline-scroll"
              :class="{ 'is-dragging': recordingsDrag !== null }"
              ref="timelineRef"
              @mousedown="onTimelineMouseDown"
              @wheel="onTimelineWheel"
              @touchstart="onTimelineTouchStart"
              @touchmove="onTimelineTouchMove"
              @touchend="onTimelineTouchEnd"
              @touchcancel="onTimelineTouchEnd"
            >
              <div class="recordings-timeline" :style="recordingTimelineStyle">
                <div v-if="recordingPlayheadVisible" class="recording-playhead-layer" aria-hidden="true">
                  <div />
                  <div class="recording-playhead-track">
                    <div class="recording-playhead" :style="{ left: recordingPlayheadLeft + '%' }">
                      <span class="recording-playhead-handle" />
                    </div>
                  </div>
                </div>
                <div class="recordings-axis">
                  <span class="recordings-lane-label recordings-axis-label">Channel</span>
                  <div class="recordings-axis-track">
                    <span
                      v-for="tick in recordingTimelineTicks"
                      :key="tick.time"
                      class="recordings-tick"
                      :style="{ left: tick.left + '%' }"
                    >{{ tick.label }}</span>
                  </div>
                </div>
                <div v-if="recordingLanes.length === 0" class="recordings-empty">No recordings in this window.</div>
                <div v-for="lane in recordingLanes" :key="lane.key" class="recordings-lane">
                  <button class="recordings-lane-label" @click="recordingChannelFilter = lane.key">{{ lane.label }}</button>
                  <div class="recordings-lane-track">
                    <button
                      v-for="clip in lane.clips"
                      :key="clip.id"
                      type="button"
                      class="recording-block"
                      :class="{ 'recording-block--selected': selectedRecordingId === clip.id, 'recording-block--active': clip.endedAt === null, 'recording-block--tx': clip.kind === 'tx' }"
                      :style="recordingBlockStyle(clip)"
                      :title="recordingClipTitle(clip)"
                      @click="selectRecording(clip)"
                    >
                      <span>{{ recordingBlockLabel(clip) }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="selectedRecording" class="recording-inspector">
            <div class="recording-inspector-meta">
              <span class="recording-inspector-title">{{ selectedRecording.laneLabel }}</span>
              <span>{{ formatRecordingDateTime(selectedRecording.startedAt) }}</span>
              <span>{{ formatRecordingDuration(selectedRecording.durationMs) }}</span>
              <span v-if="selectedRecording.kind === 'tx'" class="recording-kind-pill recording-kind-pill--tx">TX</span>
              <span v-if="selectedRecording.mode">{{ selectedRecording.mode }}</span>
              <span v-if="selectedRecording.freq">{{ formatRecordingFreq(selectedRecording.freq) }}</span>
              <span v-if="selectedRecording.scanGroupNames.length">{{ selectedRecording.scanGroupNames.join(', ') }}</span>
            </div>
            <audio
              v-show="showInspectorPlayer"
              ref="recordingInspectorAudioRef"
              class="recording-player"
              :src="selectedRecordingAudioUrl"
              controls
              preload="metadata"
              @play="onRecordingInspectorPlay"
              @timeupdate="onRecordingInspectorTimeUpdate"
              @ended="onRecordingInspectorEnded"
            />
            <div class="recording-inspector-actions">
              <button class="btn btn-ghost btn-sm" :class="{ 'btn-audio-stats--active': showInspectorPlayer }" @click="showInspectorPlayer = !showInspectorPlayer">{{ showInspectorPlayer ? 'Hide Player' : 'Player' }}</button>
              <a class="btn btn-ghost btn-sm" :href="selectedRecordingAudioUrl" :download="selectedRecording.fileName">Download</a>
              <button class="btn btn-ghost btn-sm" @click="deleteRecordingClip(selectedRecording.id)">Delete</button>
            </div>
          </div>
          <audio
            ref="recordingPlaybackAudioRef"
            class="recording-playback-audio"
            preload="metadata"
            @timeupdate="onRecordingPlaybackTimeUpdate"
            @ended="onRecordingPlaybackEnded"
          />
        </section>



      </div>

      <!-- ── Raw HEX query input ── -->
      <section class="cmd-section">
        <span class="cmd-label">Raw HEX:</span>
        <input
          v-model="manualCmd"
          class="cmd-input"
          placeholder="e.g. 04 5A 07 00 00 00"
          @keydown.enter="sendManualCommand"
          spellcheck="false"
        />
        <button class="btn btn-primary btn-sm" :disabled="manualCommandBusy" @click="sendManualCommand">
          {{ manualCommandBusy ? 'Sending...' : 'Send Hex' }}
        </button>
        <span class="cmd-hint">Read frames only: 6-byte <code>04</code> queries or <code>61</code> wake.</span>
        <span class="cmd-response" v-if="manualResponse">→ {{ manualResponse }}</span>
      </section>
    </main>

    <!-- ── Not connected screen ── -->
    <div v-else class="idle-screen">
      <div class="idle-icon">📡</div>
      <p>Scan and pair your radio below, then select it above and <strong>Connect</strong>.</p>

      <!-- Bluetooth pairing panel: scan -> pair -> the radio appears in the dropdown. -->
      <div v-if="selectedTransport === 'bt'" class="bt-panel">
        <div class="bt-panel-head">
          <strong>Bluetooth radios</strong>
          <span v-if="btStatus?.adapter" class="bt-adapter">
            adapter {{ btStatus.adapter.address }} · {{ btStatus.adapter.powered ? 'powered' : 'off' }}
          </span>
          <button class="btn btn-ghost" :disabled="btScanning || btBusy" @click="scanRadios">{{ btScanning ? 'Scanning…' : 'Scan' }}</button>
        </div>
        <p v-if="btError" class="bt-error">{{ btError }}</p>
        <ul class="bt-radio-list">
          <li
            v-for="r in btRadios"
            :key="r.address"
            class="bt-radio"
            :class="{ 'bt-radio--active': r.address === btStatus?.address }"
          >
            <span class="bt-radio-name">{{ r.name || r.address }}</span>
            <span class="bt-radio-addr">{{ r.address }}</span>
            <span class="bt-radio-flags">
              <span class="bt-flag" :class="r.paired ? 'bt-flag--ok' : 'bt-flag--warn'">{{ r.paired ? 'paired' : 'unpaired' }}</span>
              <span v-if="r.trusted" class="bt-flag bt-flag--ok">trusted</span>
              <span v-if="r.connected" class="bt-flag bt-flag--ok">connected</span>
            </span>
            <button v-if="!r.paired" class="btn btn-primary btn-sm" :disabled="btBusy" @click="pairRadio(r.address)">Pair</button>
            <button v-else class="btn btn-ghost btn-sm" :disabled="btBusy" @click="forgetRadio(r.address)" title="Remove bond (forces a fresh pair next Connect)">Forget</button>
          </li>
          <li v-if="!btRadios.length" class="bt-radio-empty">No radios known yet — power the radio on, make it pairable, then Scan.</li>
        </ul>
      </div>
    </div>

    <button
      v-if="state.connected && audioMicActive"
      class="floating-ptt"
      :class="{
        'floating-ptt--ready': audioReadyForTx && audioTxAvailable && !audioTxBusy && !pttConfirmedActive,
        'floating-ptt--busy': audioTxBusy,
        'floating-ptt--active': pttConfirmedActive,
      }"
      :disabled="!audioReadyForTx || !state.connected || audioTxActive || audioTxBusy || txProhibited"
      :title="audioTxTitle"
      :aria-pressed="pttConfirmedActive"
      aria-label="Hold to transmit"
      @pointerdown.prevent="onAudioTxPointerDown"
      @pointerup.prevent="onAudioTxPointerUp"
      @pointercancel.prevent="onAudioTxPointerCancel"
      @contextmenu.prevent
    >
      <span class="floating-ptt-main">{{ floatingPttMain }}</span>
      <span class="floating-ptt-sub">{{ floatingPttSub }}</span>
    </button>

    <footer class="footer">
      <span>AnyTone AT-D578UVIII · <span v-if="state.firmware?.display">Display: {{ state.firmware.display }} · </span>
        <span v-if="state.firmware?.main">Firmware: {{ state.firmware.main }} · </span>
        <span v-if="state.firmware?.dsp">Dsp: {{ state.firmware.dsp }} · </span>
        <span v-if="state.firmware?.sdr">Sdr: {{ state.firmware.sdr }} · </span>
        <span v-if="state.firmware?.spa1">Opt: {{ state.firmware.spa1 }} · </span>
        <span v-if="state.firmware?.fc80">Fc80: {{ state.firmware.fc80 }} · </span> Last update: {{ lastUpdateTime }}</span>
    </footer>

    <!-- ── CTCSS tone picker modal (teleported to body) ── -->
    <Teleport to="body">
      <div
        v-if="ctcssPopupVfo !== null"
        class="tone-modal-backdrop"
        @click.self="closeCtcssPopup"
      >
        <div
          ref="ctcssDialogRef"
          class="tone-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="'CTCSS Tone — ' + (ctcssPopupVfo === '0' ? 'MAIN' : 'SUB')"
        >
          <div class="tone-modal-header">
            <span class="tone-modal-title">CTCSS Tone — {{ ctcssPopupVfo === '0' ? 'MAIN' : 'SUB' }}</span>
            <button class="tone-modal-close" @click="closeCtcssPopup" aria-label="Close">✕</button>
          </div>
          <div class="ctcss-tone-grid">
            <button
              v-for="(hz, idx) in CTCSS_TONES"
              :key="idx"
              class="ctcss-tone-btn"
              :class="{ 'ctcss-tone-btn--active': (ctcssPopupVfo === '0' ? state.mainCtcssTone : state.subCtcssTone) === idx }"
              @click="selectCtcssTone(ctcssPopupVfo, idx)"
            >{{ hz.toFixed(1) }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ── DCS code picker modal (teleported to body) ── -->
    <Teleport to="body">
      <div
        v-if="dcsPopupVfo !== null"
        class="tone-modal-backdrop"
        @click.self="closeDcsPopup"
      >
        <div
          ref="dcsDialogRef"
          class="tone-modal tone-modal--dcs"
          role="dialog"
          aria-modal="true"
          :aria-label="'DCS Code — ' + (dcsPopupVfo === '0' ? 'MAIN' : 'SUB')"
        >
          <div class="tone-modal-header">
            <span class="tone-modal-title">DCS Code — {{ dcsPopupVfo === '0' ? 'MAIN' : 'SUB' }}</span>
            <button class="tone-modal-close" @click="closeDcsPopup" aria-label="Close">✕</button>
          </div>
          <div class="dcs-code-grid">
            <button
              v-for="(code, idx) in DCS_CODES"
              :key="idx"
              class="ctcss-tone-btn"
              :class="{ 'ctcss-tone-btn--active': (dcsPopupVfo === '0' ? state.mainDcsCode : state.subDcsCode) === idx }"
              @click="selectDcsCode(dcsPopupVfo, idx)"
            >D{{ String(code).padStart(3, '0') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ── RX/TX Tone popup (CTCSS/DCS): pick type, then value ── -->
    <Teleport to="body">
      <div v-if="tonePopup" class="tone-modal-backdrop" @click.self="closeTonePopup">
        <div class="tone-modal tone-modal--dcs" role="dialog" aria-modal="true" :aria-label="tonePopupTitle">
          <div class="tone-modal-header">
            <span class="tone-modal-title">{{ tonePopupTitle }}</span>
            <button class="tone-modal-close" @click="closeTonePopup" aria-label="Close">✕</button>
          </div>
          <div class="tone-type-row">
            <button class="setting-enum-btn" :class="{ 'setting-enum-btn--active': toneDraftType === 'off' }" :disabled="toneBusy" @click="applyTone('off', 0)">Off</button>
            <button class="setting-enum-btn" :class="{ 'setting-enum-btn--active': toneDraftType === 'ctc' }" :disabled="toneBusy" @click="toneDraftType = 'ctc'">CTCSS</button>
            <button class="setting-enum-btn" :class="{ 'setting-enum-btn--active': toneDraftType === 'dcs' }" :disabled="toneBusy" @click="toneDraftType = 'dcs'">DCS</button>
          </div>
          <div v-if="toneDraftType === 'ctc'" class="ctcss-tone-grid">
            <button
              v-for="(hz, idx) in CTCSS_TONES"
              :key="idx"
              class="ctcss-tone-btn"
              :class="{ 'ctcss-tone-btn--active': tonePopupCurrent?.type === 'ctc' && tonePopupCurrent?.value === idx + 1 }"
              :disabled="toneBusy"
              @click="applyTone('ctc', idx + 1)"
            >{{ hz.toFixed(1) }}</button>
          </div>
          <template v-else-if="toneDraftType === 'dcs'">
            <label class="tone-dcs-invert">
              <input v-model="toneDraftInverted" type="checkbox" :disabled="toneBusy" />
              <span>Inverted (D…I)</span>
            </label>
            <div class="dcs-code-grid">
              <button
                v-for="(code, idx) in DCS_CODES"
                :key="idx"
                class="ctcss-tone-btn"
                :class="{ 'ctcss-tone-btn--active': tonePopupCurrent?.type === 'dcs' && tonePopupCurrent?.value === code }"
                :disabled="toneBusy"
                @click="applyTone('dcs', code, toneDraftInverted)"
              >D{{ String(code).padStart(3, '0') }}{{ toneDraftInverted ? 'I' : 'N' }}</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- ── Mode picker modal (teleported to body) ── -->
    <Teleport to="body">
      <div
        v-if="modePopupVfo !== null"
        class="tone-modal-backdrop"
        @click.self="closeModePopup"
      >
        <div
          ref="modeDialogRef"
          class="tone-modal mode-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="'Mode — ' + (modePopupVfo === '0' ? 'MAIN' : 'SUB')"
        >
          <div class="tone-modal-header">
            <span class="tone-modal-title">Mode — {{ modePopupVfo === '0' ? 'MAIN' : 'SUB' }}</span>
            <button class="tone-modal-close" @click="closeModePopup" aria-label="Close">✕</button>
          </div>
          <div class="mode-btn-grid">
            <button
              v-for="m in MODES"
              :key="m.code"
              class="mode-modal-btn"
              :style="modeBadgeStyle(m.label)"
              :class="{ 'mode-modal-btn--active': (modePopupVfo === '0' ? state.mainMode : state.subMode) === m.label }"
              @click="selectModeFromPopup(modePopupVfo, m.label)"
            >{{ m.label }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ── Radio setting editor popup (teleported to body) ── -->
    <Teleport to="body">
      <div
        v-if="settingPopupItem"
        class="tone-modal-backdrop"
        @click.self="closeSettingPopup"
      >
        <div
          class="tone-modal setting-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="settingPopupItem.label"
        >
          <div class="tone-modal-header">
            <span class="tone-modal-title">{{ settingPopupItem.label }}</span>
            <button class="tone-modal-close" @click="closeSettingPopup" aria-label="Close">✕</button>
          </div>
          <!-- Numeric: − value + with Done -->
          <div v-if="settingPopupItem.type === 'num'" class="setting-edit-num">
            <div class="setting-edit-stepper">
              <button class="setting-edit-btn" :disabled="settingDraft <= (settingPopupItem.min ?? 0)" @click="settingDraft = Math.max(settingPopupItem.min ?? 0, settingDraft - 1)" aria-label="Decrease">−</button>
              <span class="setting-edit-value">{{ settingDraft }}</span>
              <button class="setting-edit-btn" :disabled="settingDraft >= (settingPopupItem.max ?? 0)" @click="settingDraft = Math.min(settingPopupItem.max ?? 0, settingDraft + 1)" aria-label="Increase">+</button>
            </div>
            <input
              type="range"
              class="setting-edit-range"
              :min="settingPopupItem.min ?? 0"
              :max="settingPopupItem.max ?? 0"
              :value="settingDraft"
              @input="settingDraft = Number(($event.target as HTMLInputElement).value)"
            />
            <button class="btn btn-primary setting-edit-done" :disabled="settingBusy === settingPopupItem.key" @click="applySettingDraft">
              {{ settingBusy === settingPopupItem.key ? 'Saving…' : 'Done' }}
            </button>
          </div>
          <!-- Enum: option list with checkmark -->
          <div v-else class="setting-edit-enum">
            <button
              v-for="opt in settingPopupItem.options ?? []"
              :key="opt.value"
              class="setting-enum-btn"
              :class="{ 'setting-enum-btn--active': settingPopupItem.value === opt.value }"
              :disabled="settingBusy === settingPopupItem.key"
              @click="selectSettingEnum(opt.value)"
            >
              <span class="setting-enum-label">{{ opt.label }}</span>
              <span v-if="settingPopupItem.value === opt.value" class="setting-enum-check">✓</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ── DMR manual-dial popup (teleported to body) ── -->
    <Teleport to="body">
      <div
        v-if="manualDialPopup !== null"
        class="tone-modal-backdrop"
        @click.self="closeManualDialPopup"
      >
        <div
          class="tone-modal setting-modal manual-dial-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Manual Dial"
        >
          <div class="tone-modal-header">
            <span class="tone-modal-title">Manual Dial — {{ manualDialPopup === '0' ? 'MAIN' : 'SUB' }}</span>
            <button class="tone-modal-close" @click="closeManualDialPopup" aria-label="Close">✕</button>
          </div>
          <div class="manual-dial-body">
            <div class="manual-dial-status" :class="{ 'manual-dial-status--on': !!state.manualDial }">
              <span v-if="state.manualDial">Dialed: <strong>{{ state.manualDial.callType === 'private' ? 'Private' : 'Group' }} {{ state.manualDial.target }}</strong></span>
              <span v-else>Using channel contact</span>
            </div>
            <label class="manual-dial-label">Target TG / DMR ID</label>
            <input
              v-model="manualDialInput"
              class="dmr-dial-input"
              inputmode="numeric"
              placeholder="e.g. 3223436"
              :disabled="manualDialBusy"
              @keydown.enter.prevent="applyManualDial"
            />
            <div class="manual-dial-types">
              <button class="dmr-dial-type" :class="{ 'dmr-dial-type--on': manualDialType === 'group' }" :disabled="manualDialBusy" @click="manualDialType = 'group'">Group Call</button>
              <button class="dmr-dial-type" :class="{ 'dmr-dial-type--on': manualDialType === 'private' }" :disabled="manualDialBusy" @click="manualDialType = 'private'">Private Call</button>
            </div>
            <button class="btn btn-primary setting-edit-done" :disabled="manualDialBusy || !manualDialDigits" @click="applyManualDial">
              {{ manualDialBusy ? 'Working…' : 'Dial' }}
            </button>
            <button class="btn btn-ghost manual-dial-restore" :disabled="manualDialBusy || !state.manualDial" @click="restoreChannelContact">
              Restore channel contact
            </button>
            <p class="manual-dial-note">The next PTT calls the dialed target instead of the channel's programmed contact, until restored.</p>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ── Band picker modal (teleported to body) ── -->
    <Teleport to="body">
      <div
        v-if="bandPopupVfo !== null"
        class="tone-modal-backdrop"
        @click.self="closeBandPopup"
      >
        <div
          ref="bandDialogRef"
          class="tone-modal band-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="'Band — ' + (bandPopupVfo === '0' ? 'MAIN' : 'SUB')"
        >
          <div class="tone-modal-header">
            <span class="tone-modal-title">Band — {{ bandPopupVfo === '0' ? 'MAIN' : 'SUB' }}</span>
            <button class="tone-modal-close" @click="closeBandPopup" aria-label="Close">✕</button>
          </div>
          <div class="band-btn-grid">
            <button
              v-for="b in BANDS"
              :key="b.code"
              class="band-modal-btn"
              :class="{ 'band-modal-btn--active': (bandPopupVfo === '0' ? mainBandCode : subBandCode) === b.code }"
              @click="selectBandFromPopup(bandPopupVfo, b.code)"
            >{{ b.label }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Direct frequency entry -->
    <Teleport to="body">
      <div
        v-if="frequencyEditVfo !== null"
        class="tone-modal-backdrop"
        @click.self="closeFrequencyEditor"
      >
        <form class="tone-modal value-modal" role="dialog" aria-modal="true" @submit.prevent="applyFrequencyEditor">
          <div class="tone-modal-header">
            <span class="tone-modal-title">Set Frequency - {{ frequencyEditVfo === '0' ? 'MAIN' : 'SUB' }}</span>
            <button type="button" class="tone-modal-close" @click="closeFrequencyEditor" aria-label="Close">✕</button>
          </div>
          <label class="value-field-label" for="frequency-entry">Frequency in MHz</label>
          <input
            id="frequency-entry"
            ref="frequencyInputRef"
            v-model="frequencyInput"
            class="value-number-input value-number-input--wide"
            type="text"
            inputmode="decimal"
            placeholder="438.625000"
            autocomplete="off"
          />
          <div class="value-hint">Examples: <code>438.625</code>, <code>145.310</code>, or raw Hz.</div>
          <div class="value-actions">
            <button type="button" class="btn btn-ghost" @click="closeFrequencyEditor">Cancel</button>
            <button type="submit" class="btn btn-primary">Set</button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- TX frequency entry -->
    <Teleport to="body">
      <div
        v-if="txFrequencyEditVfo !== null"
        class="tone-modal-backdrop"
        @click.self="closeTxFrequencyEditor"
      >
        <form class="tone-modal value-modal" role="dialog" aria-modal="true" @submit.prevent="applyTxFrequencyEditor">
          <div class="tone-modal-header">
            <span class="tone-modal-title">Set TX Frequency - {{ txFrequencyEditVfo === '0' ? 'MAIN' : 'SUB' }}</span>
            <button type="button" class="tone-modal-close" @click="closeTxFrequencyEditor" aria-label="Close">✕</button>
          </div>
          <label class="value-field-label" for="tx-frequency-entry">TX frequency in MHz</label>
          <input
            id="tx-frequency-entry"
            ref="txFrequencyInputRef"
            v-model="txFrequencyInput"
            class="value-number-input value-number-input--wide"
            type="text"
            inputmode="decimal"
            placeholder="467.675000"
            autocomplete="off"
          />
          <div class="value-hint">Writes the TX frequency to the selected side (CAT <code>2f 04</code>).</div>
          <div class="value-actions">
            <button type="button" class="btn btn-ghost" @click="closeTxFrequencyEditor">Cancel</button>
            <button type="submit" class="btn btn-primary">Set TX</button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- Radio memory write entry -->
    <Teleport to="body">
      <div
        v-if="radioMemoryWriteVfo !== null"
        class="tone-modal-backdrop"
        @click.self="closeRadioMemoryWriter"
      >
        <form class="tone-modal value-modal memory-write-modal" role="dialog" aria-modal="true" @submit.prevent="saveRadioMemory">
          <div class="tone-modal-header">
            <span class="tone-modal-title">Save Radio Memory - {{ radioMemoryWriteVfo === '0' ? 'MAIN' : 'SUB' }}</span>
            <button type="button" class="tone-modal-close" @click="closeRadioMemoryWriter" aria-label="Close">✕</button>
          </div>
          <div class="memory-write-grid">
            <label class="memory-write-field">
              <span>Slot</span>
              <input v-model.number="radioMemoryWriteForm.channel" class="value-number-input" type="number" inputmode="numeric" min="1" max="99" />
            </label>
            <label class="memory-write-field">
              <span>Name</span>
              <input v-model="radioMemoryWriteForm.tag" class="value-number-input memory-write-text" type="text" maxlength="12" autocomplete="off" />
            </label>
            <label class="memory-write-field memory-write-field--wide">
              <span>RX Frequency MHz</span>
              <input v-model="radioMemoryWriteForm.freqInput" class="value-number-input memory-write-text" type="text" inputmode="decimal" autocomplete="off" />
            </label>
            <label class="memory-write-field">
              <span>Mode</span>
              <select v-model="radioMemoryWriteForm.mode" class="scan-vfo-select memory-write-select">
                <option v-for="m in MODES" :key="m.code" :value="m.label">{{ m.label }}</option>
              </select>
            </label>
            <label class="memory-write-field">
              <span>Tone SQL</span>
              <select v-model.number="radioMemoryWriteForm.sqlType" class="scan-vfo-select memory-write-select">
                <option v-for="option in sqlTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label v-if="radioMemoryWriteUsesCtcss" class="memory-write-field memory-write-field--wide">
              <span>CTCSS Tone</span>
              <select v-model.number="radioMemoryWriteForm.ctcssTone" class="scan-vfo-select memory-write-select">
                <option v-for="(hz, idx) in CTCSS_TONES" :key="idx" :value="idx">{{ hz.toFixed(1) }} Hz</option>
              </select>
            </label>
            <label v-if="radioMemoryWriteUsesDcs" class="memory-write-field memory-write-field--wide">
              <span>DCS Code</span>
              <select v-model.number="radioMemoryWriteForm.dcsCode" class="scan-vfo-select memory-write-select">
                <option v-for="(code, idx) in DCS_CODES" :key="idx" :value="idx">D{{ String(code).padStart(3, '0') }}</option>
              </select>
            </label>
            <label class="memory-write-check memory-write-field--wide">
              <input v-model="radioMemoryWriteForm.split" type="checkbox" />
              <span>Store split TX frequency</span>
            </label>
            <label v-if="radioMemoryWriteForm.split" class="memory-write-field memory-write-field--wide">
              <span>TX Frequency MHz</span>
              <input v-model="radioMemoryWriteForm.splitFreqInput" class="value-number-input memory-write-text" type="text" inputmode="decimal" autocomplete="off" />
            </label>
          </div>
          <div v-if="radioMemoryOverwriteLabel" class="value-hint">{{ radioMemoryOverwriteLabel }}</div>
          <div class="value-hint">Writes real radio memory using CAT <code>MW</code>, <code>MT</code>, and <code>MZ</code>.</div>
          <div class="value-actions">
            <button type="button" class="btn btn-ghost" @click="closeRadioMemoryWriter">Cancel</button>
            <button type="submit" class="btn btn-primary" :disabled="radioMemoryWriteBusy">
              {{ radioMemoryWriteBusy ? 'Saving...' : 'Save Memory' }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- Tap-friendly numeric editor -->
    <Teleport to="body">
      <div
        v-if="valueEditor"
        class="tone-modal-backdrop"
        @click.self="closeValueEditor"
      >
        <form class="tone-modal value-modal" role="dialog" aria-modal="true" @submit.prevent="applyValueEditor">
          <div class="tone-modal-header">
            <span class="tone-modal-title">{{ valueEditor.title }}</span>
            <button type="button" class="tone-modal-close" @click="closeValueEditor" aria-label="Close">✕</button>
          </div>
          <div class="value-current">
            <span>{{ valueEditor.label }}</span>
            <strong>{{ valueEditorValue }}{{ valueEditor.unit ?? '' }}</strong>
          </div>
          <input
            v-model.number="valueEditorValue"
            class="value-range"
            type="range"
            :min="valueEditor.min"
            :max="valueEditor.max"
            :step="valueEditor.step"
          />
          <div class="value-step-row">
            <button type="button" class="value-step-btn" @click="stepValueEditor(-1)">-</button>
            <input
              v-model.number="valueEditorValue"
              class="value-number-input"
              type="number"
              inputmode="numeric"
              :min="valueEditor.min"
              :max="valueEditor.max"
              :step="valueEditor.step"
            />
            <button type="button" class="value-step-btn" @click="stepValueEditor(1)">+</button>
          </div>
          <div class="value-actions">
            <button type="button" class="btn btn-ghost" @click="closeValueEditor">Cancel</button>
            <button type="submit" class="btn btn-primary">Set</button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- WebRTC connection diagnostics -->
    <Teleport to="body">
      <div
        v-if="webrtcStatsOpen"
        class="tone-modal-backdrop"
        @click.self="closeWebRtcStats"
      >
        <div class="tone-modal webrtc-stats-modal" role="dialog" aria-modal="true" aria-label="WebRTC connection stats">
          <div class="tone-modal-header">
            <span class="tone-modal-title">WebRTC Stats</span>
            <button type="button" class="tone-modal-close" @click="closeWebRtcStats" aria-label="Close">✕</button>
          </div>

          <div class="webrtc-stats-body">
            <div class="webrtc-stats-toolbar">
              <span
                class="webrtc-stats-pill"
                :class="{
                  'webrtc-stats-pill--live': audioWebRtcState === 'connected',
                  'webrtc-stats-pill--reconnecting': audioWebRtcState === 'reconnecting',
                }"
              >
                {{ audioWebRtcState === 'reconnecting' ? 'Reconnecting' : audioReceiveMode === 'webrtc' && audioListening ? 'Live' : 'Disconnected' }}
              </span>
              <span v-if="webrtcStats?.collectedAt" class="webrtc-stats-updated">
                Updated {{ formatStatsTime(webrtcStats.collectedAt) }}
              </span>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="webrtcStatsLoading" @click="refreshWebRtcStats">
                {{ webrtcStatsLoading ? 'Refreshing…' : 'Refresh' }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="copyWebRtcDiagnostics">
                {{ webrtcDiagnosticsCopied ? 'Copied' : 'Copy JSON' }}
              </button>
            </div>

            <div v-if="webrtcStatsError" class="webrtc-stats-error">{{ webrtcStatsError }}</div>

            <div v-if="!webrtcStats && !webrtcStatsLoading" class="webrtc-stats-empty">
              Start remote audio to collect WebRTC connection stats.
            </div>

            <div v-if="webrtcStats" class="webrtc-stats-grid">
              <section class="webrtc-stat-card">
                <h3>Connection</h3>
                <dl class="webrtc-stat-list">
                  <template v-for="row in webrtcConnectionRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </template>
                </dl>
              </section>

              <section class="webrtc-stat-card">
                <h3>Candidate Pair</h3>
                <dl v-if="webrtcCandidateRows.length" class="webrtc-stat-list">
                  <template v-for="row in webrtcCandidateRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </template>
                </dl>
                <p v-else class="webrtc-stats-empty">No selected candidate pair yet.</p>
              </section>

              <section class="webrtc-stat-card">
                <h3>Inbound Audio</h3>
                <dl v-if="webrtcInboundRows.length" class="webrtc-stat-list">
                  <template v-for="row in webrtcInboundRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </template>
                </dl>
                <p v-else class="webrtc-stats-empty">No inbound audio report yet.</p>
              </section>

              <section class="webrtc-stat-card">
                <h3>Outbound Audio</h3>
                <dl v-if="webrtcOutboundRows.length" class="webrtc-stat-list">
                  <template v-for="row in webrtcOutboundRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </template>
                </dl>
                <p v-else class="webrtc-stats-empty">No outbound audio report yet.</p>
              </section>

              <section class="webrtc-stat-card">
                <h3>Radio Host</h3>
                <dl v-if="webrtcServerRows.length" class="webrtc-stat-list">
                  <template v-for="row in webrtcServerRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </template>
                </dl>
                <p v-else class="webrtc-stats-empty">No server session stats yet.</p>
              </section>

              <section class="webrtc-stat-card">
                <h3>Squelch</h3>
                <dl v-if="webrtcSquelchRows.length" class="webrtc-stat-list">
                  <template v-for="row in webrtcSquelchRows" :key="row.label">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </template>
                </dl>
                <p v-else class="webrtc-stats-empty">No squelch stats yet.</p>
              </section>
            </div>

            <details v-if="webrtcStats" class="webrtc-stats-raw">
              <summary>Raw selected stats</summary>
              <pre>{{ webrtcRawStats }}</pre>
            </details>

            <section class="webrtc-stat-card webrtc-diagnostics-card">
              <h3>Diagnostics</h3>
              <div class="webrtc-diagnostics-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="copyWebRtcDiagnostics">
                  {{ webrtcDiagnosticsCopied ? 'Copied' : 'Copy JSON' }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="selectWebRtcDiagnostics">Select JSON</button>
                <button type="button" class="btn btn-ghost btn-sm" @click="clearWebRtcDiagnostics">Clear</button>
              </div>
              <ol v-if="webrtcDiagnosticRecent.length" class="webrtc-diagnostics-list">
                <li v-for="item in webrtcDiagnosticRecent" :key="item.seq">
                  <span>{{ formatWebRtcDiagnosticTime(item) }}</span>
                  <strong>{{ item.event }}</strong>
                  <code v-if="item.data">{{ formatWebRtcDiagnosticData(item.data) }}</code>
                </li>
              </ol>
              <p v-else class="webrtc-stats-empty">No WebRTC diagnostic events yet.</p>
              <textarea
                ref="webrtcDiagnosticsTextRef"
                class="webrtc-diagnostics-json"
                readonly
                :value="webrtcDiagnosticsJson"
                @focus="selectWebRtcDiagnostics"
              />
            </section>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import SMeter from '~/components/SMeter.vue'
import LevelBar from '~/components/LevelBar.vue'
import StatusBadge from '~/components/StatusBadge.vue'
import {
  DEFAULT_WEBRTC_OPUS_OPTIONS,
  normalizeWebRtcOpusOptions,
  summarizeOpusSdp,
  tuneOpusSessionDescription,
  type WebRtcOpusOptions,
} from '~/utils/webrtc-sdp'

// ----------- state -----------

interface PortInfo {
  path: string
  label?: string
  manufacturer?: string
  transport?: string
  address?: string | null
}

interface AudioProfile {
  transport?: string
  engine?: string
  backend?: string
  input?: string
  output?: string
  rxChannels?: string
  txChannels?: string
  txBackend?: string
  txOutput?: string
  txSampleRate?: string
  sampleRate?: string
  gain?: string
  filter?: string
  highpass?: string
  squelchGate?: boolean
}

interface RadioInfo {
  hiSwr: boolean
  recording: boolean
  playing: boolean
  tx: boolean
  txInhibit: boolean
  tuning: boolean
  scanning: boolean
  squelchOpen: boolean
}

interface RadioMemory {
  channel: string
  freq: number | null
  mode: string | null
  tag: string | null
  sqlType: number | null
  vfoMode: string | null
  split: boolean | null
  splitFreq: number | null
}

// One radio setting, projected display-ready by the backend (RADIO_SETTINGS).
// `writable` items open an editor popup; others render as read-only badges.
interface SettingItem {
  key: string
  label: string
  value: number | null      // raw byte
  display: string           // formatted (enum label or numeric)
  writable: boolean
  type: 'enum' | 'num'
  min: number | null
  max: number | null
  editValue: number | null  // numeric on-screen value to seed the stepper
  options: { value: number; label: string }[] | null
}

// Per-side RX/TX tone state (CTCSS/DCS) for the tone popup.
interface ToneState {
  type: 'off' | 'ctc' | 'dcs'
  value: number          // ctc: 1-based CTCSS index · dcs: DCS code (e.g. 23)
  inverted?: boolean
  display: string        // 'Off' | 'CTC 88.5' | 'DCS D023'
}

// Zone/channel picker entries from the backend enumeration endpoints.
interface ChannelEntry { index: number; channelNumber: number; name: string }
interface ZoneEntry { index: number; name: string; channels: ChannelEntry[] }

interface TransceiverState {
  connected: boolean
  transport: string
  transportLabel: string
  transportMode: string | null
  transportLink: string | null
  transportFraming: string | null
  audio: AudioProfile | null
  port: string | null
  baudRate: number
  autoInfo: boolean
  mainFreq: number | null
  subFreq: number | null
  mainTxFreq: number | null
  subTxFreq: number | null
  mainMode: string | null
  subMode: string | null
  mainSmeter: number | null
  subSmeter: number | null
  txState: boolean
  mox: boolean
  split: boolean
  memorySplit: boolean
  rawSplit: boolean | null
  vfoSplit: boolean
  vfoSplitFreq: number | null
  lock: boolean | null
  agcMain: string | null
  rfGainMain: number | null
  afGainMain: number | null
  sqMain: number | null
  agcSub: string | null
  rfGainSub: number | null
  afGainSub: number | null
  sqSub: number | null
  sqlRfMode: number | null
  powerLevel: number | null
  radioInfo: RadioInfo | null
  amcLevel: number | null
  micGain: number | null
  // All radio settings, projected display-ready (editable + read-only).
  settings: SettingItem[]
  channelSettingsSide: 'A' | 'B' | null
  mainChannelSettings: SettingItem[]
  subChannelSettings: SettingItem[]
  mainRxTone: ToneState | null
  mainTxTone: ToneState | null
  subRxTone: ToneState | null
  subTxTone: ToneState | null
  usbOutLevel: number | null
  usbOutLevelByMode: Record<'ssb' | 'am' | 'fm' | 'data', number | null>
  usbModGain: number | null
  usbModGainByMode: Record<'ssb' | 'am' | 'fm' | 'data', number | null>
  speechProc: boolean | null
  speechProcLevel: number | null
  funcKnob: string | null
  vox: boolean | null
  voxGain: number | null
  txVfo: 0 | 1 | null
  txProhibited: boolean
  mainTxProhibit: boolean
  subTxProhibit: boolean
  rxMode: 'dual' | 'single' | null
  mainVfoMode: string | null
  subVfoMode: string | null
  mainMemoryChannel: string | null
  subMemoryChannel: string | null
  mainMemoryTag: string | null
  subMemoryTag: string | null
  radioMemories: RadioMemory[]
  radioMemoryScanActive: boolean
  radioMemoryScanProgress: number
  radioMemoryScanTotal: number
  radioMemoryScanError: string | null
  pseudoScanActive: boolean
  pseudoScanVfo: '0' | '1' | null
  pseudoScanChannels: string[]
  pseudoScanIndex: number
  pseudoScanCurrentChannel: string | null
  pseudoScanWaiting: boolean
  pseudoScanBusy: boolean
  pseudoScanLastMeter: number | null
  pseudoScanLastSquelch: number | null
  pseudoScanPauseReason: string | null
  pseudoScanError: string | null
  mainSqlType: number | null
  subSqlType: number | null
  mainCtcssTone: number | null
  subCtcssTone: number | null
  mainDcsCode: number | null
  subDcsCode: number | null
  dnrMain: string | null
  dnrSub: string | null
  mainBandwidth: number | null
  subBandwidth: number | null
  mainShift: number | null
  subShift: number | null
  narrowMain: boolean | null
  narrowSub: boolean | null
  mainTxPower: string | null
  subTxPower: string | null
  mainContactName: string | null
  mainContactTg: string | null
  mainContactCallType: 'private' | 'group' | 'all' | null
  subContactName: string | null
  subContactTg: string | null
  subContactCallType: 'private' | 'group' | 'all' | null
  dmrActivity: {
    id: number
    alias: string | null
    active: boolean
    isUser: boolean
    callsign: string | null
    name: string | null
    location: string | null
    talkgroup: number | null
    colorCode: number | null
    slot: number | null
    private: boolean
    at: number
  } | null
  dmrCallVfo: 0 | 1 | null
  manualDial: {
    target: string
    callType: 'group' | 'private'
  } | null
  mainZone: string | null
  subZone: string | null
  mainZonePosition: number | null
  subZonePosition: number | null
  rfAttenuator: boolean
  preAmpHf: number | null
  preAmpVhf: boolean | null
  preAmpUhf: boolean | null
  scopeSide: boolean | null
  scope: { mode: number | null, span: number | null, speed: number | null, level: number | null, att: number | null, color: number | null, marker: boolean | null } | null
  firmware: { main: string | null, display: string | null, sdr: string | null, dsp: string | null, spa1: string | null, fc80: string | null } | null,
  antSelect: number | null
  lastUpdate: number
  error: string | null
}

const defaultState = (): TransceiverState => ({
  connected: false,
  transport: 'bt',
  transportLabel: 'Bluetooth',
  transportMode: 'EXTERNAL BT MODE',
  transportLink: 'rfcomm',
  transportFraming: 'raw',
  audio: null,
  port: null,
  baudRate: 38400,
  autoInfo: false,
  mainFreq: null,
  subFreq: null,
  mainTxFreq: null,
  subTxFreq: null,
  mainMode: null,
  subMode: null,
  mainSmeter: null,
  subSmeter: null,
  txState: false,
  mox: false,
  split: false,
  memorySplit: false,
  rawSplit: null,
  vfoSplit: false,
  vfoSplitFreq: null,
  lock: null,
  agcMain: null,
  rfGainMain: null,
  afGainMain: null,
  sqMain: null,
  agcSub: null,
  rfGainSub: null,
  afGainSub: null,
  sqSub: null,
  sqlRfMode: null,
  powerLevel: null,
  radioInfo: null,
  amcLevel: null,
  micGain: null,
  settings: [],
  channelSettingsSide: null,
  mainChannelSettings: [],
  subChannelSettings: [],
  mainRxTone: null,
  mainTxTone: null,
  subRxTone: null,
  subTxTone: null,
  usbOutLevel: null,
  usbOutLevelByMode: { ssb: null, am: null, fm: null, data: null },
  usbModGain: null,
  usbModGainByMode: { ssb: null, am: null, fm: null, data: null },
  speechProc: null,
  speechProcLevel: null,
  funcKnob: null,
  vox: null,
  voxGain: null,
  txVfo: null,
  txProhibited: false,
  mainTxProhibit: false,
  subTxProhibit: false,
  rxMode: null,
  mainVfoMode: null,
  subVfoMode: null,
  mainMemoryChannel: null,
  subMemoryChannel: null,
  mainMemoryTag: null,
  subMemoryTag: null,
  radioMemories: [],
  radioMemoryScanActive: false,
  radioMemoryScanProgress: 0,
  radioMemoryScanTotal: 0,
  radioMemoryScanError: null,
  pseudoScanActive: false,
  pseudoScanVfo: null,
  pseudoScanChannels: [],
  pseudoScanIndex: 0,
  pseudoScanCurrentChannel: null,
  pseudoScanWaiting: false,
  pseudoScanBusy: false,
  pseudoScanLastMeter: null,
  pseudoScanLastSquelch: null,
  pseudoScanPauseReason: null,
  pseudoScanError: null,
  mainSqlType: null, subSqlType: null,
  mainCtcssTone: null, subCtcssTone: null,
  mainDcsCode: null, subDcsCode: null,
  dnrMain: null,
  dnrSub: null,
  mainBandwidth: null,
  subBandwidth: null,
  mainShift: null,
  subShift: null,
  narrowMain: null,
  narrowSub: null,
  mainTxPower: null,
  subTxPower: null,
  mainContactName: null,
  mainContactTg: null,
  mainContactCallType: null,
  subContactName: null,
  subContactTg: null,
  subContactCallType: null,
  dmrActivity: null,
  dmrCallVfo: null,
  manualDial: null,
  mainZone: null,
  subZone: null,
  mainZonePosition: null,
  subZonePosition: null,
  rfAttenuator: false,
  preAmpHf: null,
  preAmpVhf: null,
  preAmpUhf: null,
  scopeSide: null,
  scope: null,
  firmware: { main: null, display: null, sdr: null, dsp: null, spa1: null, fc80: null },
  antSelect: null,
  lastUpdate: Date.now(),
  error: null,
})

interface ChannelConfig {
  id: string
  freq: number
  mode: string | null
  sqlType: number | null
  ctcssIdx: number | null
  dcsIdx: number | null
}

interface ScanGroup {
  id: string
  name: string
  channels: string[]
  createdAt: number
}

interface RecordingSettings {
  enabled: boolean
  tailMs: number
  minDurationMs: number
}

interface RecordingStatus {
  settings: RecordingSettings
  active: RecordingClip[]
  lastError: string | null
}

interface RecordingClip {
  id: string
  kind: 'rx' | 'tx'
  side: 'main' | 'sub'
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  fileName: string
  relativePath: string
  contentType: string
  bytes: number | null
  laneKey: string
  laneLabel: string
  freq: number | null
  mode: string | null
  vfoMode: string | null
  memoryChannel: string | null
  memoryTag: string | null
  scanGroupNames: string[]
  rxMode: string | null
  txVfo: 0 | 1 | null
  meter: number | null
  squelch: number | null
  error: string | null
}

interface RecordingLane {
  key: string
  label: string
  clips: RecordingClip[]
}

interface RadioMemoryWriteForm {
  channel: number
  tag: string
  freqInput: string
  mode: string
  split: boolean
  splitFreqInput: string
  sqlType: number
  ctcssTone: number
  dcsCode: number
}

interface AudioStatus {
  enabled: boolean
  available: boolean
  transport: string
  engine: string
  backend: string
  input: string
  output: string
  txBackend: string
  txOutput: string
  txChannels: string
  txSampleRate: string
  channels: string
  bitrate: string
  sampleRate: string
  filter: string
  gain: string
  limiter: boolean
  limit: string
  macosBufferSize: string
  squelchGate: boolean
  squelchPollMs: number
  squelchRampMs: number
  webrtcOpus?: WebRtcOpusOptions
  contentType: string
  message: string | null
}

type ValueEditorKey = 'pwr' | 'usbOut' | 'usbMod' | 'amc' | 'proc' | 'voxGain' | 'dnrMain' | 'dnrSub'
type WebRtcAudioState = 'idle' | 'starting' | 'connected' | 'reconnecting' | 'failed'
type AudioReceiveMode = 'idle' | 'webrtc' | 'playback'

interface ValueEditor {
  key: ValueEditorKey
  title: string
  label: string
  min: number
  max: number
  step: number
  unit?: string
}

interface WebRtcStatsRow {
  label: string
  value: string
}

interface WebRtcServerStatus {
  sessions: WebRtcServerSession[]
}

interface WebRtcRxMix {
  mainGain: number
  subGain: number
  mainMuted: boolean
  subMuted: boolean
}

interface WebRtcServerSession {
  id?: string
  connectionState?: string
  iceConnectionState?: string
  txFrames?: number
  txBytes?: number
  txResampledFrames?: number
  txDroppedFrames?: number
  txGatedFrames?: number
  txPeak?: number
  txSinkActive?: boolean
  txOutputActive?: boolean
  txOutputError?: string | null
  rxChannelCount?: number
  rxInputChannelCount?: number
  rxOutputChannelCount?: number
  rxActiveChannel?: number
  rxMix?: WebRtcRxMix
  rxSquelchEnabled?: boolean
  rxSquelchTargets?: number[]
  rxSquelchGains?: number[]
  rxSquelch?: {
    open?: boolean
    mainOpen?: boolean
    subOpen?: boolean
    mainMeter?: number | null
    subMeter?: number | null
    mainSquelch?: number | null
    subSquelch?: number | null
    rxMode?: 'single' | 'dual'
    txVfo?: 0 | 1 | null
    modes?: string[]
    error?: string | null
  }
}

type WebRtcStatsRecord = Record<string, unknown>

interface WebRtcStatsSnapshot {
  collectedAt: number
  sessionId: string | null
  connection: {
    connectionState: string
    iceConnectionState: string
    iceGatheringState: string
    signalingState: string
  } | null
  selectedCandidatePair: WebRtcStatsRecord | null
  localCandidate: WebRtcStatsRecord | null
  remoteCandidate: WebRtcStatsRecord | null
  inboundAudio: WebRtcStatsRecord | null
  inboundCodec: WebRtcStatsRecord | null
  outboundAudio: WebRtcStatsRecord | null
  outboundCodec: WebRtcStatsRecord | null
  remoteInboundAudio: WebRtcStatsRecord | null
  serverSession: WebRtcServerSession | null
  serverError: string | null
}

interface WebRtcDiagnosticEvent {
  seq: number
  run: number
  t: number
  elapsedMs: number
  event: string
  data?: Record<string, unknown>
}

interface CommandResponse {
  ok: boolean
  state: TransceiverState
}

interface RawHexResponse {
  request: string
  response: string
  length: number
}

const state = ref<TransceiverState>(defaultState())

const PSEUDO_SCAN_UI_FLUSH_MS = 120
const PSEUDO_SCAN_STATUS_UPDATE_MS = 250
const PSEUDO_SCAN_DEFERRED_STATE_KEYS = new Set<keyof TransceiverState>([
  'lastUpdate',
  'mainSmeter',
  'subSmeter',
  'sqMain',
  'sqSub',
  'mainFreq',
  'subFreq',
  'mainMode',
  'subMode',
  'mainVfoMode',
  'subVfoMode',
  'mainMemoryChannel',
  'subMemoryChannel',
  'mainMemoryTag',
  'subMemoryTag',
  'pseudoScanIndex',
  'pseudoScanCurrentChannel',
  'pseudoScanWaiting',
  'pseudoScanBusy',
  'pseudoScanLastMeter',
  'pseudoScanLastSquelch',
  'pseudoScanPauseReason',
])

let pendingPseudoScanState: Partial<TransceiverState> | null = null
let pseudoScanUiFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingPseudoScanStatus: string | null = null
let pseudoScanStatusTimer: ReturnType<typeof setTimeout> | null = null
let pseudoScanStatusLastUpdate = 0
let lastAudioMediaSessionKey = ''
let pendingAudioMediaSessionKey: string | null = null

function applyState(next: Partial<TransceiverState>) {
  Object.assign(state.value, next)
  if (next.transport === 'bt' || next.transport === 'wired') selectedTransport.value = next.transport
}

function hasPatch(patch: Record<string, unknown>) {
  return Object.keys(patch).length > 0
}

function queuePseudoScanState(next: Partial<TransceiverState>) {
  pendingPseudoScanState = { ...(pendingPseudoScanState ?? {}), ...next }
  if (pseudoScanUiFlushTimer) return
  pseudoScanUiFlushTimer = setTimeout(flushPendingPseudoScanState, PSEUDO_SCAN_UI_FLUSH_MS)
}

function clearPendingPseudoScanState() {
  if (pseudoScanUiFlushTimer) clearTimeout(pseudoScanUiFlushTimer)
  pseudoScanUiFlushTimer = null
  pendingPseudoScanState = null
}

function flushPendingPseudoScanState() {
  if (pseudoScanUiFlushTimer) clearTimeout(pseudoScanUiFlushTimer)
  pseudoScanUiFlushTimer = null
  const next = pendingPseudoScanState
  pendingPseudoScanState = null
  if (!next) return
  applyState(next)
  if ('pseudoScanPauseReason' in next) scheduleAudioMediaSessionUpdate()
}

function applySseDelta(changes: Partial<TransceiverState>) {
  if (changes.connected === false || changes.pseudoScanActive === false) {
    clearPendingPseudoScanState()
    applyState(changes)
    scheduleAudioMediaSessionUpdate()
    return
  }

  const shouldDeferScanUi = state.value.pseudoScanActive || changes.pseudoScanActive === true
  if (!shouldDeferScanUi) {
    applyState(changes)
    scheduleAudioMediaSessionUpdate()
    return
  }

  const immediate: Record<string, unknown> = {}
  const deferred: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(changes)) {
    if (PSEUDO_SCAN_DEFERRED_STATE_KEYS.has(key as keyof TransceiverState)) deferred[key] = value
    else immediate[key] = value
  }

  if (hasPatch(immediate)) {
    applyState(immediate as Partial<TransceiverState>)
    scheduleAudioMediaSessionUpdate()
  }
  if (hasPatch(deferred)) queuePseudoScanState(deferred as Partial<TransceiverState>)
}

const ports = ref<PortInfo[]>([])
const selectedTransport = ref<'bt' | 'wired'>('bt')
const connecting = ref(false)
const lastError = ref<string | null>(null)
const manualCmd = ref('')

// ── Bluetooth pairing panel state ──
interface BtRadio { address: string; name?: string | null; paired?: boolean; trusted?: boolean; connected?: boolean }
interface BtStatus { ok: boolean; address?: string; configuredAddress?: string | null; adapter?: { address: string; powered: boolean } | null; radios?: BtRadio[]; error?: string }
const btStatus = ref<BtStatus | null>(null)
const btRadios = ref<BtRadio[]>([])
const btScanning = ref(false)
const btBusy = ref(false)
const btError = ref<string | null>(null)

const BT_STEP_LABELS: Record<string, string> = {
  adapter: 'Powering adapter…',
  discover: 'Searching for radio…',
  pair: 'Pairing…',
  trust: 'Trusting…',
  paired: 'Paired — bringing up audio…',
  connect: 'Connecting…',
  ready: 'Opening control link…',
}
const btStepLabel = computed(() => BT_STEP_LABELS[(state.value as any).btStep as string] || 'Connecting…')

async function loadBtStatus() {
  if (selectedTransport.value !== 'bt') return
  try {
    const data = await $fetch<BtStatus>('/api/bt/status')
    btStatus.value = data
    if (data.ok && Array.isArray(data.radios)) btRadios.value = data.radios
    btError.value = data.ok ? null : (data.error ?? 'Bluetooth unavailable')
  } catch (e: any) {
    btError.value = e.data?.message ?? e.message ?? 'Bluetooth status failed'
  }
}

async function scanRadios() {
  btScanning.value = true
  btError.value = null
  try {
    const data = await $fetch<{ ok: boolean; radios: BtRadio[] }>('/api/bt/scan', { method: 'POST', body: {} })
    if (data.radios) btRadios.value = data.radios
    await loadBtStatus()
  } catch (e: any) {
    btError.value = e.data?.message ?? e.message ?? 'Scan failed'
  } finally {
    btScanning.value = false
  }
}

async function pairRadio(address: string) {
  btBusy.value = true
  btError.value = null
  try {
    await $fetch('/api/bt/pair', { method: 'POST', body: { address } })
    await Promise.all([loadBtStatus(), refreshPorts()])
    // Newly paired radio is now a dropdown entry — select it.
    if (transportOptions.value.some(o => o.value === address)) selectedDropdown.value = address
  } catch (e: any) {
    btError.value = e.data?.message ?? e.message ?? 'Pairing failed'
  } finally {
    btBusy.value = false
  }
}

async function forgetRadio(address: string) {
  btBusy.value = true
  btError.value = null
  try {
    await $fetch('/api/bt/forget', { method: 'POST', body: { address } })
    await Promise.all([loadBtStatus(), refreshPorts()])
  } catch (e: any) {
    btError.value = e.data?.message ?? e.message ?? 'Forget failed'
  } finally {
    btBusy.value = false
  }
}
const manualResponse = ref('')
const manualCommandBusy = ref(false)
// Dropdown options: each paired BT radio is its own entry (value = its address) so
// multiple D578s can be picked individually, plus the wired transport. `value` is
// what the <select> binds; `transport` is the kind ('bt'|'wired') used everywhere
// else; `address` pins a specific radio (null = generic / first available).
const transportOptions = computed(() => {
  const options = ports.value
    .map(port => {
      const transport = (port.transport || port.path) as 'bt' | 'wired'
      const address = port.address ?? (transport === 'bt' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(port.path || '') ? port.path : null)
      return {
        value: transport === 'wired' ? 'wired' : (address || 'bt'),
        transport,
        address,
        label: port.label || (transport === 'wired' ? 'Wired digirig' : 'Bluetooth'),
        manufacturer: port.manufacturer,
      }
    })
    .filter(port => port.transport === 'bt' || port.transport === 'wired')
  return options.length ? options : [
    { value: 'bt', transport: 'bt' as const, address: null, label: 'Bluetooth', manufacturer: 'AnyTone Bluetooth' },
    { value: 'wired', transport: 'wired' as const, address: null, label: 'Wired digirig', manufacturer: 'Digirig serial + ALSA' },
  ]
})
// Which specific paired radio is selected (null = generic BT / configured default).
const selectedRadioAddr = ref<string | null>(null)
// Single source the <select> binds to; maps the chosen option back onto
// selectedTransport (kind) + selectedRadioAddr (specific radio).
const selectedDropdown = computed<string>({
  get() {
    if (selectedTransport.value === 'wired') return 'wired'
    return selectedRadioAddr.value || 'bt'
  },
  set(val: string) {
    if (val === 'wired') { selectedTransport.value = 'wired'; selectedRadioAddr.value = null }
    else if (val === 'bt') { selectedTransport.value = 'bt'; selectedRadioAddr.value = null }
    else { selectedTransport.value = 'bt'; selectedRadioAddr.value = val }
  },
})
const audioStatus = ref<AudioStatus | null>(null)
const audioStatusLoading = ref(false)
const audioBusy = ref(false)
const audioListening = ref(false)
const audioReceiveMode = ref<AudioReceiveMode>('idle')
const audioWebRtcState = ref<WebRtcAudioState>('idle')
const audioWebRtcReconnectAttempt = ref(0)
const audioTxAvailable = ref(false)
const audioTxActive = ref(false)
const audioTxBusy = ref(false)
const pttIntent = ref(false)
const audioTxError = ref<string | null>(null)
const audioBufferedMs = ref(0)
const audioUnderflow = ref(false)
const audioRxMutedForTx = ref(false)
const audioMicActive = ref(false)
const webrtcStatsOpen = ref(false)
const webrtcStatsLoading = ref(false)
const webrtcStatsError = ref<string | null>(null)
const webrtcStats = ref<WebRtcStatsSnapshot | null>(null)
const webrtcDiagnostics = ref<WebRtcDiagnosticEvent[]>([])
const webrtcDiagnosticsCopied = ref(false)
const frequencyEditVfo = ref<'0' | '1' | null>(null)
const frequencyInput = ref('')
const frequencyInputRef = ref<HTMLInputElement | null>(null)
const txFrequencyEditVfo = ref<'0' | '1' | null>(null)
const txFrequencyInput = ref('')
const txFrequencyInputRef = ref<HTMLInputElement | null>(null)
const vfoMemoryModeBusy = ref<'0' | '1' | null>(null)
const radioMemoryWriteVfo = ref<'0' | '1' | null>(null)
const radioMemoryWriteBusy = ref(false)
const radioMemoryWriteForm = ref<RadioMemoryWriteForm>({
  channel: 1,
  tag: '',
  freqInput: '',
  mode: 'FM',
  split: false,
  splitFreqInput: '',
  sqlType: 0,
  ctcssTone: 0,
  dcsCode: 0,
})
const audioPlayerRef = ref<HTMLAudioElement | null>(null)
const valueEditor = ref<ValueEditor | null>(null)
const valueEditorValue = ref(0)
const speechProcBusy = ref(false)
const voxBusy = ref(false)
const preAmpBusy    = ref(false)
const antSelectBusy = ref(false)
const rxModeBusy = ref(false)
const splitBusy = ref(false)
const savedChannels = ref<ChannelConfig[]>([])
const scanGroups = ref<ScanGroup[]>([])
const memoryBusy = ref(false)
const pseudoScanSelectedChannels = ref<string[]>([])
const pseudoScanTargetVfo = ref<'0' | '1'>('0')
const recordings = ref<RecordingClip[]>([])
const recordingStatus = ref<RecordingStatus | null>(null)
const recordingBusy = ref(false)
const recordingRangeHours = ref(0.5)
const recordingWindowEnd = ref(Date.now())
const RECORDING_FUTURE_PADDING = 0.25
const RECORDING_LANE_LABEL_WIDTH = 150
const recordingDisplayEnd = computed(() => {
  const range = recordingRangeHours.value * 60 * 60 * 1000
  return recordingWindowEnd.value + range * RECORDING_FUTURE_PADDING
})
const recordingChannelFilter = ref('all')
const recordingMinDurationSeconds = ref(0)
const recordingTailSkipSeconds = ref(1)
const selectedRecordingId = ref<string | null>(null)
const timelineRef = ref<HTMLElement | null>(null)
const recordingPlaybackAudioRef = ref<HTMLAudioElement | null>(null)
const recordingInspectorAudioRef = ref<HTMLAudioElement | null>(null)
// The inspector's native per-clip <audio> player is redundant with the timeline
// transport, so it's collapsed by default behind a "Player" toggle.
const showInspectorPlayer = ref(false)
const webrtcDiagnosticsTextRef = ref<HTMLTextAreaElement | null>(null)
const recordingPlayheadTime = ref(Date.now())
const recordingPlaybackPlaying = ref(false)
const recordingPlaybackLoading = ref(false)
const recordingPlaybackClipId = ref<string | null>(null)
const recordingsLoadTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const recordingsDrag = ref<{ startX: number; startWindowEnd: number; moved: boolean } | null>(null)
const recordingsTouch = ref<{
  x1: number; y1: number; x2?: number; y2?: number
  startWindowEnd: number; startRange: number; startDist?: number
} | null>(null)

function scheduleRecordingLoad() {
  if (recordingsLoadTimer.value) clearTimeout(recordingsLoadTimer.value)
  recordingsLoadTimer.value = setTimeout(() => {
    recordingsLoadTimer.value = null
    void loadRecordings()
  }, 200)
}

function onTimelineMouseDown(e: MouseEvent) {
  if ((e.target as HTMLElement)?.closest('button, select, audio, option')) return
  recordingsDrag.value = { startX: e.clientX, startWindowEnd: recordingWindowEnd.value, moved: false }
  window.addEventListener('mousemove', onTimelineMouseMove)
  window.addEventListener('mouseup', onTimelineMouseUp)
}

function onTimelineMouseMove(e: MouseEvent) {
  const drag = recordingsDrag.value
  if (!drag) return
  const el = timelineRef.value
  if (!el) return
  const dx = e.clientX - drag.startX
  if (Math.abs(dx) > 3) drag.moved = true
  const range = recordingRangeHours.value * 60 * 60 * 1000
  const msPerPixel = range / el.clientWidth * 0.35
  recordingWindowEnd.value = drag.startWindowEnd - dx * msPerPixel
}

function onTimelineMouseUp(e: MouseEvent) {
  window.removeEventListener('mousemove', onTimelineMouseMove)
  window.removeEventListener('mouseup', onTimelineMouseUp)
  const drag = recordingsDrag.value
  recordingsDrag.value = null
  if (drag && !drag.moved) setRecordingPlayheadFromClientX(e.clientX)
  if (drag?.moved) scheduleRecordingLoad()
}

function setRecordingPlayheadFromClientX(clientX: number) {
  const next = recordingTimelineTimeFromClientX(clientX)
  if (next === null) return
  recordingPlayheadTime.value = next
  if (recordingPlaybackPlaying.value) void startRecordingPlaybackAtPlayhead()
}

function recordingTimelineTimeFromClientX(clientX: number) {
  const el = timelineRef.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const trackWidth = Math.max(1, rect.width - RECORDING_LANE_LABEL_WIDTH)
  const fraction = Math.max(0, Math.min(1, (clientX - rect.left - RECORDING_LANE_LABEL_WIDTH) / trackWidth))
  return recordingWindowStart.value + (recordingDisplayEnd.value - recordingWindowStart.value) * fraction
}

function onTimelineWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  const el = timelineRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const mouseFraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const oldRange = recordingRangeHours.value
  const zoomFactor = e.deltaY > 0 ? 1.06 : 1 / 1.06
  const newRange = Math.max(0.25, Math.min(336, oldRange * zoomFactor))
  if (newRange === oldRange) return
  const oldDisplayEnd = recordingDisplayEnd.value
  const oldWindowStart = recordingWindowStart.value
  const oldSpan = oldDisplayEnd - oldWindowStart
  const mouseTime = oldWindowStart + oldSpan * mouseFraction
  recordingRangeHours.value = newRange
  const newSpan = newRange * 60 * 60 * 1000
  recordingWindowEnd.value = mouseTime - newSpan * (mouseFraction - RECORDING_FUTURE_PADDING)
  scheduleRecordingLoad()
}

function onTimelineTouchStart(e: TouchEvent) {
  if (e.touches.length === 1) {
    recordingsTouch.value = {
      x1: e.touches[0].clientX, y1: e.touches[0].clientY,
      startWindowEnd: recordingWindowEnd.value, startRange: recordingRangeHours.value,
    }
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    recordingsTouch.value = {
      x1: e.touches[0].clientX, y1: e.touches[0].clientY,
      x2: e.touches[1].clientX, y2: e.touches[1].clientY,
      startWindowEnd: recordingWindowEnd.value, startRange: recordingRangeHours.value,
      startDist: Math.sqrt(dx * dx + dy * dy),
    }
  }
}

function onTimelineTouchMove(e: TouchEvent) {
  const ts = recordingsTouch.value
  if (!ts) return
  const el = timelineRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const range = recordingRangeHours.value * 60 * 60 * 1000

  if (e.touches.length === 1 && ts.x2 === undefined) {
    // One-finger drag → pan
    const dx = e.touches[0].clientX - ts.x1
    const msPerPixel = range / el.clientWidth
    recordingWindowEnd.value = ts.startWindowEnd - dx * msPerPixel
  } else if (e.touches.length === 2 && ts.startDist !== undefined) {
    // Pinch → zoom
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const scale = dist / ts.startDist
    if (scale < 0.98 || scale > 1.02) {
      let newRange = ts.startRange / scale
      newRange = Math.max(0.25, Math.min(336, newRange))
      const pinchCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const mouseFraction = Math.max(0, Math.min(1, (pinchCenterX - rect.left) / rect.width))
      const oldDisplayEnd = recordingDisplayEnd.value
      const oldWindowStart = recordingWindowStart.value
      const oldSpan = oldDisplayEnd - oldWindowStart
      const mouseTime = oldWindowStart + oldSpan * mouseFraction
      recordingRangeHours.value = newRange
      const newSpan = newRange * 60 * 60 * 1000
      recordingWindowEnd.value = mouseTime - newSpan * (mouseFraction - RECORDING_FUTURE_PADDING)
    }
  }
}

function onTimelineTouchEnd() {
  recordingsTouch.value = null
  scheduleRecordingLoad()
}

const SCAN_GROUPS_STORAGE_KEY = 'cat_scan_groups'

function loadChannels() {
  try {
    const raw = localStorage.getItem('cat_channels')
    savedChannels.value = raw ? JSON.parse(raw) : []
  } catch { savedChannels.value = [] }
}
function persistChannels() {
  localStorage.setItem('cat_channels', JSON.stringify(savedChannels.value))
}

function normalizeScanGroup(value: any): ScanGroup | null {
  const name = String(value?.name ?? '').trim()
  const channels: string[] = Array.isArray(value?.channels)
    ? Array.from(new Set<string>(value.channels.map((channel: unknown) => String(channel).trim()).filter((channel: string) => channel.length > 0)))
    : []
  if (!name || channels.length === 0) return null
  return {
    id: String(value?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    name,
    channels,
    createdAt: Number(value?.createdAt ?? Date.now()),
  }
}

async function loadScanGroups() {
  try {
    const data = await $fetch<{ groups: ScanGroup[] }>('/api/scan-groups')
    scanGroups.value = Array.isArray(data.groups)
      ? data.groups.map(normalizeScanGroup).filter((group): group is ScanGroup => group !== null)
      : []

    try {
      // One-time migration for groups saved by older browser-local builds.
      const rawLocal = localStorage.getItem(SCAN_GROUPS_STORAGE_KEY)
      if (rawLocal) {
        const localGroups = JSON.parse(rawLocal)
        if (Array.isArray(localGroups)) {
          for (const group of localGroups.map(normalizeScanGroup).filter((item): item is ScanGroup => item !== null)) {
            if (!scanGroups.value.some(existing => existing.name.toLowerCase() === group.name.toLowerCase())) {
              const updated = await $fetch<{ groups: ScanGroup[] }>('/api/scan-groups', { method: 'POST', body: group })
              scanGroups.value = updated.groups
            }
          }
        }
        localStorage.removeItem(SCAN_GROUPS_STORAGE_KEY)
      }
    } catch { localStorage.removeItem(SCAN_GROUPS_STORAGE_KEY) }
  } catch (e: any) {
    lastError.value = e.message
    scanGroups.value = []
  }
}
const moxBusy = ref(false)
const txVfoBusy = ref(false)
const lockBusy   = ref(false)
const narrowBusy = ref(false)
const agcBusy    = ref(false)
let eventSource: EventSource | null = null
let recordingsTimer: ReturnType<typeof setInterval> | null = null
let recordingPlaybackToken = 0
let recordingTailSkipPending = false
let recordingInspectorTailSkipPending = false
let recordingPlaybackMonitorTimer: ReturnType<typeof setInterval> | null = null
let audioContext: AudioContext | null = null
let audioProcessor: ScriptProcessorNode | null = null
let audioWorkletNode: AudioWorkletNode | null = null
let audioWorkletModuleUrl: string | null = null
let audioAbortController: AbortController | null = null
let audioReader: ReadableStreamDefaultReader<Uint8Array> | null = null
let audioPeerConnection: RTCPeerConnection | null = null
let audioElement: HTMLAudioElement | null = null
let audioWebRtcSessionId: string | null = null
let audioMicStream: MediaStream | null = null
let audioMicTrack: MediaStreamTrack | null = null
let audioMicSender: RTCRtpSender | null = null
let audioTxDesired = false
let audioTxTransitionId = 0
let audioTxPointerId: number | null = null
let audioStreamToken = 0
let audioLastSample = 0
let audioNeedsRamp = true
let audioRefillingBuffer = true
let audioBufferWaiter: (() => void) | null = null
let audioQueue: Float32Array[] = []
let audioQueueOffset = 0
let audioQueuedSamples = 0
let webrtcStatsTimer: ReturnType<typeof setInterval> | null = null
let webrtcStatsRefreshInFlight = false
let audioMediaSessionTimer: ReturnType<typeof setTimeout> | null = null
let rxAudioMixRequestId = 0
let audioIceReconnectTimer: ReturnType<typeof setTimeout> | null = null
let audioIceRestartTimer: ReturnType<typeof setTimeout> | null = null
let audioIceRestartInFlight = false
let audioIceReconnectDeadline = 0
let audioWebRtcFlowWatchdogTimer: ReturnType<typeof setInterval> | null = null
let audioWebRtcFlowWatchdogBusy = false
let audioWebRtcLastFlowAt = 0
let audioWebRtcLastInboundPackets: number | null = null
let audioWebRtcLastInboundBytes: number | null = null
let audioWebRtcLastPairBytesReceived: number | null = null
let webrtcDiagnosticSeq = 0
let webrtcDiagnosticRun = 0
let webrtcDiagnosticStartedAt = 0
let audioPlaybackPrimerContext: AudioContext | null = null
let audioPlaybackPrimerOscillator: OscillatorNode | null = null
let audioPlaybackPrimerStream: MediaStream | null = null

const AUDIO_PROCESSOR_SIZE = 1024
const PCM_PLAYBACK_CHANNEL_COUNT = 1
const AUDIO_START_BUFFER_SECONDS = 0.25
const AUDIO_TARGET_BUFFER_SECONDS = 0.5
const AUDIO_MAX_BUFFER_SECONDS = 1.2
const AUDIO_RAMP_SAMPLES = 128

const WEBRTC_ICE_RECONNECT_GRACE_MS = 30_000
const WEBRTC_ICE_RESTART_DELAY_MS = 1_500
const WEBRTC_ICE_RESTART_RETRY_MS = 3_000
const WEBRTC_ICE_RESTART_MAX_ATTEMPTS = 2
const WEBRTC_DIAGNOSTIC_MAX_EVENTS = 300
const WEBRTC_FLOW_WATCHDOG_INTERVAL_MS = 1000
const WEBRTC_FLOW_STALL_MS = 3000

const REMOTE_TX_PREROLL_MS = 300
const REMOTE_TX_TAIL_MS = 600
const VFO_MEMORY_MODE_COMMAND_CODES: Record<string, string> = {
  VFO: '00',
  MT: '10',
  MEMORY: '11',
  PMS: '20',
  '5MHz MEMORY': '51',
  EMG: '91',
}
// $fetch is baseURL-aware, but raw fetch/EventSource/element src URLs are not;
// those must be prefixed when the app is served under a path (e.g. /anytone/).
const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/$/, '')
const withAppBase = (path: string) => `${appBaseURL}${path}`
const AUDIO_MEDIA_ARTWORK_SOURCE = withAppBase('/media/radio.svg?v=3')
const AUDIO_MEDIA_ARTWORK_SIZES = [96, 256, 512] as const
const audioMediaArtwork = ref(mediaArtworkFromSource(AUDIO_MEDIA_ARTWORK_SOURCE, 'image/svg+xml'))

// ----------- computed -----------

const lastUpdateTime = computed(() => {
  if (!state.value.connected) return '--'
  const d = new Date(state.value.lastUpdate)
  return d.toLocaleTimeString()
})

const audioLabel = computed(() => {
  if (audioStatusLoading.value) return 'Checking audio…'
  if (audioReceiveMode.value === 'playback') {
    if (audioListening.value) return 'Playback-only audio live'
    if (audioBusy.value) return 'Playback-only audio connecting'
  }
  if (audioWebRtcState.value === 'starting') return 'Remote audio connecting'
  if (audioListening.value) {
    if (audioWebRtcState.value === 'reconnecting') {
      const attempt = audioWebRtcReconnectAttempt.value ? ` · retry ${audioWebRtcReconnectAttempt.value}` : ''
      return `Remote audio reconnecting${attempt}`
    }
    if (audioTxActive.value) return 'Remote audio live · TX active'
    if (audioTxAvailable.value) return 'Remote audio live · TX ready'
    return audioTxError.value ? 'Remote audio live · TX unavailable' : 'Remote audio live'
  }
  if (!audioStatus.value) return 'Audio not checked'
  if (!audioStatus.value.enabled) return 'Audio disabled'
  if (!audioStatus.value.available) return 'Audio unavailable'
  return `Audio ready: ${audioStatus.value.backend} ${audioStatus.value.input}`
})

const audioToggleLabel = computed(() => {
  if (audioBusy.value) return 'Audio…'
  return audioListening.value || audioWebRtcState.value !== 'idle' ? 'Disable Audio' : 'Enable Audio'
})

const audioPlaybackToggleLabel = computed(() => {
  if (audioBusy.value && audioReceiveMode.value === 'playback') return 'Playback…'
  return audioReceiveMode.value === 'playback' ? 'Stop Playback' : 'Playback Only'
})

const audioReadyForTx = computed(() => audioReceiveMode.value === 'webrtc' && audioListening.value && isAudioPeerReadyForTx())
// TX Prohibit on the selected channel — block all PTT/mic paths and grey them out.
const txProhibited = computed(() => state.value.txProhibited === true)

const audioMediaTitle = computed(() => {
  return mediaVfoSummary(activeVfo.value)
})

const audioMediaArtist = computed(() => {
  if (state.value.rxMode === 'single') return ''
  return mediaVfoSummary(rxOnlyVfo.value)
})

const audioMediaAlbum = computed(() => {
  const streamState = audioReceiveMode.value === 'playback' ? 'HTTP RX' : audioTxActive.value ? 'Remote TX' : 'Remote RX'
  if (state.value.connected) return `${streamState} · ${state.value.port ?? 'AT-D578UVIII'}`
  return streamState
})

const audioTitle = computed(() => {
  if (audioListening.value) return 'Stop remote audio'
  if (audioStatus.value?.message) return audioStatus.value.message
  if (audioStatus.value?.available) return 'Listen to the radio audio input from this browser'
  return 'Remote audio requires CAT_AUDIO_ENABLED=1 on the radio host'
})

const audioPlaybackTitle = computed(() => {
  if (audioReceiveMode.value === 'playback') return 'Stop playback-only HTTP audio'
  if (audioStatus.value?.message) return audioStatus.value.message
  return 'Explicit playback-only HTTP audio for browsers that cannot establish WebRTC. TX/PTT is disabled in this mode.'
})

const audioTxTitle = computed(() => {
  if (txProhibited.value) return 'TX is prohibited on this channel (RX only) — change the channel to transmit'
  if (!state.value.connected) return 'Connect to the radio before transmitting'
  if (audioReceiveMode.value === 'playback') return 'Playback-only HTTP audio does not support microphone/PTT'
  if (audioListening.value && audioWebRtcState.value === 'reconnecting') return 'Audio is reconnecting before transmit is available'
  if (audioTxError.value) return audioTxError.value
  if (!audioTxAvailable.value) return 'Hold to request microphone access and transmit'
  return 'Hold to transmit browser microphone audio to the radio'
})

const audioMicLabel = computed(() => {
  if (audioTxBusy.value) return 'Mic…'
  if (!audioMicActive.value && audioTxAvailable.value) return 'Mic Ready'
  return audioMicActive.value ? 'Disable Mic' : 'Enable Mic'
})

const audioMicTitle = computed(() => {
  if (txProhibited.value) return 'TX is prohibited on this channel (RX only) — change the channel to transmit'
  if (!state.value.connected) return 'Connect to the radio before enabling the microphone'
  if (audioReceiveMode.value === 'playback') return 'Playback-only HTTP audio does not support microphone/PTT'
  if (!audioListening.value) return 'Enable audio before enabling the microphone'
  if (!audioReadyForTx.value) return 'Wait for WebRTC audio to reconnect before enabling the microphone'
  if (audioTxActive.value || audioTxBusy.value) return 'Cannot change microphone while transmitting'
  if (!audioMicActive.value && audioTxAvailable.value) return 'Microphone permission is ready for PTT'
  return audioMicActive.value
    ? 'Release the browser microphone without stopping receive audio'
    : 'Request and keep the browser microphone hot for PTT'
})

const webrtcStatsTitle = computed(() => {
  if (webrtcStatsAvailable.value) return 'Show WebRTC connection statistics and diagnostics'
  return 'Start remote audio to view WebRTC connection statistics'
})

const webrtcStatsAvailable = computed(() => {
  return audioReceiveMode.value === 'webrtc' || !!audioPeerConnection || !!audioWebRtcSessionId || webrtcDiagnostics.value.length > 0
})

const webrtcConnectionRows = computed<WebRtcStatsRow[]>(() => {
  const stats = webrtcStats.value
  return [
    statRow('Session', stats?.sessionId),
    statRow('Browser state', stats?.connection?.connectionState),
    statRow('ICE state', stats?.connection?.iceConnectionState),
    statRow('ICE gathering', stats?.connection?.iceGatheringState),
    statRow('Signaling', stats?.connection?.signalingState),
    statRow('Server error', stats?.serverError),
  ].filter(row => row.value !== '--')
})

const webrtcCandidateRows = computed<WebRtcStatsRow[]>(() => {
  const stats = webrtcStats.value
  const pair = stats?.selectedCandidatePair
  return [
    statRow('State', pair?.state),
    statRow('Nominated', pair?.nominated),
    statRow('RTT', pair?.currentRoundTripTime, 'currentRoundTripTime'),
    statRow('Bytes received', pair?.bytesReceived, 'bytesReceived'),
    statRow('Bytes sent', pair?.bytesSent, 'bytesSent'),
    statRow('Packets received', pair?.packetsReceived),
    statRow('Packets sent', pair?.packetsSent),
    statRow('Outgoing bitrate', pair?.availableOutgoingBitrate, 'availableOutgoingBitrate'),
    statRow('Incoming bitrate', pair?.availableIncomingBitrate, 'availableIncomingBitrate'),
    statRow('Local candidate', formatCandidate(stats?.localCandidate)),
    statRow('Remote candidate', formatCandidate(stats?.remoteCandidate)),
  ].filter(row => row.value !== '--')
})

const webrtcInboundRows = computed<WebRtcStatsRow[]>(() => {
  const stats = webrtcStats.value
  return [
    statRow('Codec', formatCodec(stats?.inboundCodec)),
    ...statsReportRows(stats?.inboundAudio, [
      ['Packets received', 'packetsReceived'],
      ['Packets lost', 'packetsLost'],
      ['Bytes received', 'bytesReceived'],
      ['Jitter', 'jitter'],
      ['Jitter buffer delay', 'jitterBufferDelay'],
      ['Concealed samples', 'concealedSamples'],
      ['Concealment events', 'concealmentEvents'],
      ['Audio level', 'audioLevel'],
      ['Total energy', 'totalAudioEnergy'],
      ['Samples duration', 'totalSamplesDuration'],
    ]),
  ].filter(row => row.value !== '--')
})

const webrtcOutboundRows = computed<WebRtcStatsRow[]>(() => {
  const stats = webrtcStats.value
  return [
    statRow('Codec', formatCodec(stats?.outboundCodec)),
    ...statsReportRows(stats?.outboundAudio, [
      ['Packets sent', 'packetsSent'],
      ['Bytes sent', 'bytesSent'],
      ['Retransmit packets', 'retransmittedPacketsSent'],
      ['Retransmit bytes', 'retransmittedBytesSent'],
      ['Send delay', 'totalPacketSendDelay'],
      ['NACK count', 'nackCount'],
      ['Quality limit', 'qualityLimitationReason'],
    ]),
    ...statsReportRows(stats?.remoteInboundAudio, [
      ['Remote RTT', 'roundTripTime'],
      ['Remote packets lost', 'packetsLost'],
      ['Remote fraction lost', 'fractionLost'],
      ['Remote jitter', 'jitter'],
    ]),
  ].filter(row => row.value !== '--')
})

const webrtcServerRows = computed<WebRtcStatsRow[]>(() => {
  const session = webrtcStats.value?.serverSession
  return [
    statRow('Server state', session?.connectionState),
    statRow('Server ICE', session?.iceConnectionState),
    statRow('RX input channels', session?.rxInputChannelCount),
    statRow('RX output channels', session?.rxOutputChannelCount),
    statRow('Active RX channel', formatRxChannel(session?.rxActiveChannel)),
    statRow('MAIN mix', formatRxMixSide(session?.rxMix, 'main')),
    statRow('SUB mix', formatRxMixSide(session?.rxMix, 'sub')),
    statRow('Squelch enabled', session?.rxSquelchEnabled),
    statRow('Squelch target', formatNumberArray(session?.rxSquelchTargets)),
    statRow('Squelch gain', formatNumberArray(session?.rxSquelchGains)),
    statRow('TX sink active', session?.txSinkActive),
    statRow('TX output active', session?.txOutputActive),
    statRow('TX output error', session?.txOutputError),
    statRow('TX frames', session?.txFrames),
    statRow('TX bytes', session?.txBytes, 'txBytes'),
    statRow('TX gated frames', session?.txGatedFrames),
    statRow('TX dropped frames', session?.txDroppedFrames),
    statRow('TX resampled frames', session?.txResampledFrames),
    statRow('TX peak', session?.txPeak),
  ].filter(row => row.value !== '--')
})

const webrtcSquelchRows = computed<WebRtcStatsRow[]>(() => {
  const squelch = webrtcStats.value?.serverSession?.rxSquelch
  return [
    statRow('Active VFO', squelch?.txVfo === 1 ? 'SUB' : squelch?.txVfo === 0 ? 'MAIN' : null),
    statRow('RX mode', squelch?.rxMode),
    statRow('Any open', squelch?.open),
    statRow('MAIN meter / SQL', formatMeterSquelch(squelch?.mainMeter, squelch?.mainSquelch)),
    statRow('MAIN open', squelch?.mainOpen),
    statRow('SUB meter / SQL', formatMeterSquelch(squelch?.subMeter, squelch?.subSquelch)),
    statRow('SUB open', squelch?.subOpen),
    statRow('Modes', squelch?.modes?.join(', ')),
    statRow('Error', squelch?.error),
  ].filter(row => row.value !== '--')
})

const webrtcRawStats = computed(() => JSON.stringify(webrtcStats.value, null, 2))
const webrtcDiagnosticsJson = computed(() => JSON.stringify(webrtcDiagnostics.value, null, 2))
const webrtcDiagnosticRecent = computed(() => webrtcDiagnostics.value.slice(-40).reverse())

const floatingPttMain = computed(() => {
  if (txProhibited.value) return 'NO TX'
  if (pttConfirmedActive.value) return 'SPEAK'
  if (audioTxBusy.value) return 'WAIT'
  if (audioReceiveMode.value === 'playback') return 'RX'
  if (audioListening.value && audioWebRtcState.value === 'reconnecting') return 'WAIT'
  if (!audioListening.value) return 'LISTEN'
  if (!audioTxAvailable.value) return 'MIC'
  return 'PTT'
})

const floatingPttSub = computed(() => {
  if (txProhibited.value) return 'TX prohibited'
  if (pttConfirmedActive.value) return 'TX ON'
  if (audioTxBusy.value) return 'arming'
  if (audioReceiveMode.value === 'playback') return 'playback only'
  if (audioListening.value && audioWebRtcState.value === 'reconnecting') return 'reconnecting'
  if (!audioListening.value) return 'start audio'
  if (!audioTxAvailable.value) return audioTxError.value ? 'unavailable' : 'hold to allow'
  return 'hold to talk'
})

const radioTxActive = computed(() => state.value.txState || state.value.mox)
// Red "transmitting" state. radioTxActive is the radio's txState echoed back over
// SSE, which can lag or drop under the heavy frame traffic during a transmission;
// audioTxActive is the local confirmation that the TX1 command round-tripped and
// the mic is live (an equally-strong "we keyed the radio" signal). Accept either
// so the indicator reliably turns red while actually transmitting.
const pttConfirmedActive = computed(() => pttIntent.value && (radioTxActive.value || audioTxActive.value))
const activeVfo = computed<'0' | '1'>(() => state.value.txVfo === 1 ? '1' : '0')
const rxOnlyVfo = computed<'0' | '1'>(() => activeVfo.value === '0' ? '1' : '0')
const activeVfoMode = computed(() => activeVfo.value === '0' ? state.value.mainVfoMode : state.value.subVfoMode)
const activeVfoFrequency = computed(() => activeVfo.value === '0' ? state.value.mainFreq : state.value.subFreq)

const speechProcLabel = computed(() => {
  if (state.value.speechProc === null) return '--'
  return state.value.speechProc ? 'ON' : 'OFF'
})

const mainMemoryDisplay = computed(() => memoryDisplay('0'))
const subMemoryDisplay = computed(() => memoryDisplay('1'))

function pseudoScanVfoIsScanning(vfo: '0' | '1') {
  return state.value.pseudoScanActive && state.value.pseudoScanVfo === vfo && state.value.pseudoScanPauseReason !== 'signal'
}

function memoryDisplay(vfo: '0' | '1') {
  if (pseudoScanVfoIsScanning(vfo)) return 'SCANNING'

  const mode = vfoMemoryMode(vfo)
  if (!mode || isVfoLikeMode(mode)) return 'VFO mode'
  if (!isMemoryLikeVfoMode(mode)) return mode

  const channel = vfo === '0' ? state.value.mainMemoryChannel : state.value.subMemoryChannel
  const tag = vfo === '0' ? state.value.mainMemoryTag : state.value.subMemoryTag
  const modeLabel: Record<string, string> = {
    MEMORY: 'MEM',
    MT: 'MT',
    QMB: 'QMB',
    PMS: 'PMS',
    '5MHz MEMORY': '5MHz',
    EMG: 'EMG',
  }
  return [modeLabel[mode] ?? mode, channel, tag].filter(Boolean).join(' ')
}

function memoryBadgeClass(vfo: '0' | '1'): string {
  if (pseudoScanVfoIsScanning(vfo)) return 'memory-state-badge--scan'
  return isMemoryLikeVfoMode(vfoMemoryMode(vfo)) ? '' : 'memory-state-badge--vfo'
}

const MEMORY_LIKE_VFO_MODES = new Set(['MEMORY', 'MT', 'QMB', 'PMS', '5MHz MEMORY', 'EMG'])

function isMemoryLikeVfoMode(mode: string | null): boolean {
  return mode != null && MEMORY_LIKE_VFO_MODES.has(mode)
}

function isVfoLikeMode(mode: string | null): boolean {
  return mode === 'VFO' || mode === 'P'
}

// ----------- band data -----------

const BANDS = [
  { code: '00', label: '1.8 MHz',   freqMin:   1_800_000, freqMax:   2_000_000 },
  { code: '01', label: '3.5 MHz',   freqMin:   3_500_000, freqMax:   4_000_000 },
  { code: '02', label: '5 MHz',     freqMin:   5_000_000, freqMax:   5_500_000 },
  { code: '03', label: '7 MHz',     freqMin:   7_000_000, freqMax:   7_300_000 },
  { code: '04', label: '10 MHz',    freqMin:  10_000_000, freqMax:  10_200_000 },
  { code: '05', label: '14 MHz',    freqMin:  14_000_000, freqMax:  14_400_000 },
  { code: '06', label: '18 MHz',    freqMin:  18_000_000, freqMax:  18_200_000 },
  { code: '07', label: '21 MHz',    freqMin:  21_000_000, freqMax:  21_500_000 },
  { code: '08', label: '24.5 MHz',  freqMin:  24_500_000, freqMax:  25_000_000 },
  { code: '09', label: '28 MHz',    freqMin:  28_000_000, freqMax:  30_000_000 },
  { code: '10', label: '50 MHz',    freqMin:  50_000_000, freqMax:  54_000_000 },
  { code: '11', label: '70 MHz/GEN',freqMin:  70_000_000, freqMax: 108_000_000 },
  { code: '12', label: 'AIR',       freqMin: 108_000_000, freqMax: 144_000_000 },
  { code: '13', label: '144 MHz',   freqMin: 144_000_000, freqMax: 148_000_000 },
  { code: '14', label: '430 MHz',   freqMin: 430_000_000, freqMax: 450_000_000 },
] as const

// Non-ham band labels (not covered by the radio's ham BANDS table above). The
// AnyTone can TX *and* RX on GMRS, so GMRS is NOT marked "RX".
// NOAA weather (WX) is genuinely receive-only, so it keeps the "RX" label.
const EXTRA_BANDS = [
  { label: 'WX RX', freqMin: 162_390_000, freqMax: 162_560_000 },
  { label: 'GMRS',  freqMin: 462_550_000, freqMax: 462_725_001 },
  { label: 'GMRS',  freqMin: 467_550_000, freqMax: 467_725_001 },
] as const

function freqToBandCode(hz: number | null): string | null {
  if (!hz) return null
  return BANDS.find(b => hz >= b.freqMin && hz < b.freqMax)?.code ?? null
}

function freqToBandLabel(hz: number | null): string {
  if (!hz) return 'band…'

  const txBand = BANDS.find(b => hz >= b.freqMin && hz < b.freqMax)
  if (txBand) return txBand.label

  const extraBand = EXTRA_BANDS.find(b => hz >= b.freqMin && hz < b.freqMax)
  if (extraBand) return extraBand.label

  if (hz >= 1_000_000) return `${Math.floor(hz / 1_000_000)} MHz RX`
  if (hz >= 1_000) return `${Math.round(hz / 1_000)} kHz RX`
  return `${hz} Hz RX`
}

const mainBandCode = computed(() => freqToBandCode(state.value.mainFreq))
const subBandCode  = computed(() => freqToBandCode(state.value.subFreq))
const mainBandLabel = computed(() => freqToBandLabel(state.value.mainFreq))
const subBandLabel  = computed(() => freqToBandLabel(state.value.subFreq))

const bandBusy = ref(false)
const channelStepBusy = ref(false)
const zoneStepBusy = ref(false)
const sqlTypeBusy = ref(false)
const attBusy = ref(false)
const attClickable = computed(() =>
  (state.value.mainFreq != null && state.value.mainFreq < 75000000) ||
  (state.value.subFreq  != null && state.value.subFreq  < 75000000)
)

async function selectBand(vfo: '0' | '1', code: string) {
  if (bandBusy.value || !code) return
  bandBusy.value = true
  try {
    // BS P1 P2 P2 ; — P1=0 main / 1 sub, P2P2=2-digit band code (zero-padded)
    // Do NOT assign state here — BS uses sendCommandNoWait so the returned state
    // is pre-command (stale). The real update arrives via SSE after the transceiver
    // processes the command.
    await $fetch('/api/command', {
      method: 'POST',
      body: { command: `BS${vfo}${code}` },
    })
    if (state.value.firmware?.spa1 === null ) {
      /* do nothing */
    }
    else {
      await $fetch('/api/command', {
        method: 'POST',
        body: { command: `EX030704` },
      })
    }
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    bandBusy.value = false
  }
}

async function sendUp(vfo: '0' | '1' = activeVfo.value) {
  await sendTxRxChannelStep('UP', vfo)
}

async function sendDn(vfo: '0' | '1' = activeVfo.value) {
  await sendTxRxChannelStep('DN', vfo)
}

function nextRadioMemoryForVfo(vfo: '0' | '1', direction: -1 | 1): RadioMemory | null {
  const memories = [...(state.value.radioMemories ?? [])]
    .sort((a, b) => radioMemorySortKey(a.channel) - radioMemorySortKey(b.channel))
  if (memories.length === 0) return null

  const currentChannel = vfo === '0' ? state.value.mainMemoryChannel : state.value.subMemoryChannel
  const currentIdx = currentChannel ? memories.findIndex(memory => memory.channel === currentChannel) : -1
  if (currentIdx >= 0) return memories[(currentIdx + direction + memories.length) % memories.length]

  if (!currentChannel) return direction > 0 ? memories[0] : memories[memories.length - 1]
  const currentSort = radioMemorySortKey(currentChannel)
  if (direction > 0) return memories.find(memory => radioMemorySortKey(memory.channel) > currentSort) ?? memories[0]
  return [...memories].reverse().find(memory => radioMemorySortKey(memory.channel) < currentSort) ?? memories[memories.length - 1]
}

async function stepRadioMemoryForVfo(vfo: '0' | '1', direction: -1 | 1): Promise<boolean> {
  if (!isMemoryLikeVfoMode(vfoMemoryMode(vfo))) return false
  const nextMemory = nextRadioMemoryForVfo(vfo, direction)
  if (!nextMemory) return false
  await applyRadioMemoryToVfo(nextMemory, vfo)
  await waitMs(250)
  await refreshVfoStatus(vfo)
  return true
}

async function sendTxRxChannelStep(command: 'UP' | 'DN', vfo: '0' | '1' = activeVfo.value) {
  if (channelStepBusy.value) return
  channelStepBusy.value = true
  try {
    if (await stepRadioMemoryForVfo(vfo, command === 'UP' ? 1 : -1)) return
    const data = await $fetch<CommandResponse>('/api/command', {
      method: 'POST',
      body: { command, vfo },
    })
    if (data.state) applyState(data.state)
    else await refreshVfoStatus(vfo)
    updateAudioMediaSession()
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    channelStepBusy.value = false
  }
}

async function sendZoneStep(command: 'ZONE_UP' | 'ZONE_DN', vfo: '0' | '1' = activeVfo.value) {
  if (zoneStepBusy.value) return
  zoneStepBusy.value = true
  try {
    const data = await $fetch<CommandResponse>('/api/command', {
      method: 'POST',
      body: { command, vfo },
    })
    if (data.state) applyState(data.state)
    else await refreshVfoStatus(vfo)
    updateAudioMediaSession()
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    zoneStepBusy.value = false
  }
}

// ----------- Zone selector panel -----------
// Zones are enumerated from the radio (04 2b, cached on the backend) once at
// connect and shown as an always-visible clickable list after Operating Controls.
// Clicking a zone changes it on the ACTIVE side (08 39 acts on the selected side).

// Full zone→channels map, enumerated by the server at connect (and on Refresh).
const zoneList = ref<ZoneEntry[]>([])
const zonesBusy = ref(false)
const expandedZoneIndex = ref<number | null>(null) // which zone's channels are shown
const channelJumpBusy = ref<string | null>(null)    // "zone:pos" being jumped to

// The active side's current zone name / memory number, for highlighting.
const activeZoneName = computed<string | null>(() => activeVfo.value === '0' ? state.value.mainZone : state.value.subZone)
const activeChannelNumber = computed<number | null>(() => {
  // state field may be a memory number or (fallback) a zone-name string; coerce.
  const v = activeVfo.value === '0' ? state.value.mainMemoryChannel : state.value.subMemoryChannel
  return v == null ? null : Number(v)
})

// The zone whose channels are shown: the user-expanded one, else the active zone.
const expandedZone = computed<ZoneEntry | null>(() => {
  if (expandedZoneIndex.value != null) return zoneList.value.find(z => z.index === expandedZoneIndex.value) ?? null
  return zoneList.value.find(z => z.name === activeZoneName.value) ?? null
})

async function loadZones(force = false) {
  if (zonesBusy.value) return
  zonesBusy.value = true
  try {
    const data = await $fetch<{ zones: ZoneEntry[] }>(`/api/zones${force ? '?force=1' : ''}`)
    zoneList.value = data.zones ?? []
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    zonesBusy.value = false
  }
}

// Expand a zone to reveal its channels (cached — no radio call). Toggles closed if
// the same zone is tapped again; tapping the active zone clears back to the default.
function toggleZone(zoneIndex: number) {
  expandedZoneIndex.value = expandedZoneIndex.value === zoneIndex ? null : zoneIndex
}

// Jump the active side directly to a zone + in-zone channel position (ZC). One tap
// navigates to the channel's zone and the channel.
async function jumpToChannel(zoneIndex: number, position: number) {
  const key = `${zoneIndex}:${position}`
  if (channelJumpBusy.value != null) return
  channelJumpBusy.value = key
  try {
    const side = activeVfo.value === '1' ? 'B' : 'A'
    const data = await $fetch<CommandResponse>('/api/command', { method: 'POST', body: { command: `ZC:${side}:${zoneIndex}:${position}`, vfo: activeVfo.value } })
    if (data.state) applyState(data.state)
    else await refreshVfoStatus(activeVfo.value)
    updateAudioMediaSession()
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    channelJumpBusy.value = null
  }
}

// ----------- Radio settings (RADIO_SETTINGS projection) -----------
// state.settings is a display-ready array from the backend. Writable items open
// the editor popup (enum option list / numeric stepper) and POST /api/setting;
// the backend writes the 08 opcode and re-reads to reconcile.

const settingBusy = ref<string | null>(null)
const settingPopup = ref<string | null>(null)     // open setting's key
const settingDraft = ref(0)                        // numeric editor working value
// null = a global RADIO_SETTINGS item; 'A'/'B' = a per-side CHANNEL_SETTINGS item
// (edited inside that side's VFO card; the write selects the side first).
const settingPopupSide = ref<'A' | 'B' | null>(null)
function settingListFor(side: 'A' | 'B' | null): SettingItem[] {
  if (side === 'A') return state.value.mainChannelSettings
  if (side === 'B') return state.value.subChannelSettings
  return state.value.settings
}
const settingPopupItem = computed<SettingItem | null>(() => settingListFor(settingPopupSide.value).find(s => s.key === settingPopup.value) ?? null)

function openSettingPopup(key: string, side: 'A' | 'B' | null = null) {
  const item = settingListFor(side).find(s => s.key === key)
  if (!item || !item.writable) return
  settingPopupSide.value = side
  settingPopup.value = key
  // Numeric editor seeds from the current on-screen value (else the min).
  settingDraft.value = item.editValue ?? item.min ?? 0
}

// Open the editor for a per-side channel setting. vfo '0' = MAIN/A, '1' = SUB/B.
function openChannelSettingPopup(vfo: '0' | '1', key: string) {
  openSettingPopup(key, vfo === '1' ? 'B' : 'A')
}

function closeSettingPopup() {
  settingPopup.value = null
  settingPopupSide.value = null
}

async function applySettingDraft() {
  const item = settingPopupItem.value
  if (!item) return
  await setSetting(item.key, settingDraft.value)
  closeSettingPopup()
}

async function selectSettingEnum(value: number) {
  const item = settingPopupItem.value
  if (!item) return
  await setSetting(item.key, value)
  closeSettingPopup()
}

async function setSetting(key: string, value: number) {
  if (settingBusy.value) return
  settingBusy.value = key
  try {
    const side = settingPopupSide.value
    const data = side
      ? await $fetch<{ state: TransceiverState }>('/api/channel-setting', { method: 'POST', body: { key, value, side } })
      : await $fetch<{ state: TransceiverState }>('/api/setting', { method: 'POST', body: { key, value } })
    if (data.state) applyState(data.state)
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    settingBusy.value = null
  }
}

// ── DMR manual dial ──────────────────────────────────────────
// Sticky target override: dial a TG / DMR ID + call type, and the next PTT(s)
// transmit to it instead of the channel's programmed contact, until cleared.
// Mirrors the radio's own manual-dial 56 frame (see backend manualDialPttTail).
const manualDialInput = ref('')
const manualDialType = ref<'group' | 'private'>('group')
const manualDialBusy = ref(false)
const manualDialPopup = ref<'0' | '1' | null>(null)   // open dial popup's VFO
const manualDialDigits = computed(() => manualDialInput.value.replace(/\D/g, ''))
// Settings-box value: the active dialed target, or "Channel" when using the contact.
const manualDialBadgeValue = computed(() => {
  const dial = state.value.manualDial
  if (!dial) return 'Off'
  return `${dial.callType === 'private' ? 'PVT' : 'GRP'} ${dial.target}`
})

function openManualDialPopup(vfo: '0' | '1') {
  manualDialPopup.value = vfo
  manualDialInput.value = state.value.manualDial?.target ?? ''
  manualDialType.value = state.value.manualDial?.callType ?? 'group'
}

function closeManualDialPopup() {
  manualDialPopup.value = null
}

async function applyManualDial() {
  if (manualDialBusy.value || !manualDialDigits.value) return
  manualDialBusy.value = true
  try {
    const data = await $fetch<{ state: TransceiverState }>('/api/dmr-dial', { method: 'POST', body: { target: manualDialDigits.value, callType: manualDialType.value } })
    if (data.state) applyState(data.state)
    closeManualDialPopup()
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    manualDialBusy.value = false
  }
}

async function restoreChannelContact() {
  if (manualDialBusy.value) return
  manualDialBusy.value = true
  try {
    const data = await $fetch<{ state: TransceiverState }>('/api/dmr-dial', { method: 'POST', body: { clear: true } })
    if (data.state) applyState(data.state)
    manualDialInput.value = ''
    closeManualDialPopup()
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    manualDialBusy.value = false
  }
}

// ── RX/TX tone popup (CTCSS/DCS) ─────────────────────────────
// One popup per RX/TX tone: pick a type (Off/CTC/DCS) then a value. Writes the
// 2f tone frame via /api/channel-tone (selecting the side first).
const tonePopup = ref<{ vfo: '0' | '1'; field: 'rx' | 'tx' } | null>(null)
const toneDraftType = ref<'off' | 'ctc' | 'dcs'>('off')
const toneDraftInverted = ref(false)
const toneBusy = ref(false)

function vfoTone(vfo: '0' | '1', field: 'rx' | 'tx'): ToneState | null {
  if (field === 'rx') return vfo === '0' ? state.value.mainRxTone : state.value.subRxTone
  return vfo === '0' ? state.value.mainTxTone : state.value.subTxTone
}
const tonePopupCurrent = computed(() => tonePopup.value ? vfoTone(tonePopup.value.vfo, tonePopup.value.field) : null)
const tonePopupTitle = computed(() => {
  if (!tonePopup.value) return ''
  return `${tonePopup.value.field === 'rx' ? 'RX' : 'TX'} Tone — ${tonePopup.value.vfo === '0' ? 'MAIN' : 'SUB'}`
})

function openTonePopup(vfo: '0' | '1', field: 'rx' | 'tx') {
  tonePopup.value = { vfo, field }
  const cur = vfoTone(vfo, field)
  toneDraftType.value = cur?.type ?? 'off'
  toneDraftInverted.value = !!cur?.inverted
}
function closeTonePopup() { tonePopup.value = null }

async function applyTone(type: 'off' | 'ctc' | 'dcs', value: number, inverted = false) {
  const pop = tonePopup.value
  if (!pop || toneBusy.value) return
  toneBusy.value = true
  try {
    const side = pop.vfo === '1' ? 'B' : 'A'
    const data = await $fetch<{ state: TransceiverState }>('/api/channel-tone', { method: 'POST', body: { field: pop.field, type, value, inverted, side } })
    if (data.state) applyState(data.state)
    closeTonePopup()
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    toneBusy.value = false
  }
}

// ----------- CTCSS / DCS lookup -----------

/** CTCSS tone frequencies (Hz) indexed 0–49 */
const CTCSS_TONES: readonly number[] = [
   67.0,  69.3,  71.9,  74.4,  77.0,  79.7,  82.5,  85.4,  88.5,  91.5,
   94.8,  97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3,
  131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9,
  171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5,
  203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
]

/** DCS codes indexed 0–103 */
const DCS_CODES: readonly number[] = [
   23,  25,  26,  31,  32,  36,  43,  47,  51,  53,  54,  65,  71,  72,  73,
   74, 114, 115, 116, 122, 125, 131, 132, 134, 143, 145, 152, 155, 156, 162,
  165, 172, 174, 205, 212, 223, 225, 226, 243, 244, 245, 246, 251, 252, 255,
  261, 263, 265, 266, 271, 274, 306, 311, 315, 325, 331, 332, 343, 346, 351,
  356, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 446, 452, 454, 455,
  462, 464, 465, 466, 503, 506, 516, 523, 526, 532, 546, 565, 606, 612, 624,
  627, 631, 632, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754,
]

const SQL_TYPE_LABELS: Record<number, string> = {
  0: 'OFF', 1: 'CTCSS ENC', 2: 'CTCSS SQL', 3: 'DCS', 4: 'PR FREQ', 5: 'REV TONE',
}

const sqlTypeOptions = Object.entries(SQL_TYPE_LABELS).map(([value, label]) => ({ value: Number(value), label }))

const SQL_RFG_MODE_LABELS: Record<number, string> = {
  0: 'RF', 1: 'SQL', 2: 'SQL FM',
}

const SQL_TYPE_COLORS: Record<number, string> = {
  0: '#6b7280',
  1: '#22d3ee', 2: '#22d3ee',   // CTCSS — cyan
  3: '#a78bfa',                  // DCS   — purple
  4: '#f59e0b', 5: '#f59e0b',   // special — amber
}

const FM_MODES = new Set(['FM', 'FM-N', 'DATA-FM', 'DATA-FM-N', 'C4FM-DN', 'C4FM-VW', 'AMS'])

function isFmMode(mode: string | null): boolean {
  return mode != null && FM_MODES.has(mode)
}

const DNR_MODES = new Set(['USB', 'LSB', 'CW-U', 'CW-L', 'AM', 'AM-N', 'DATA-L', 'DATA-U', 'PSK', 'RTTY-L', 'RTTY-U'])

function isDnrMode(mode: string | null): boolean {
  return mode != null && DNR_MODES.has(mode)
}

const DNR_MIN = 0
const DNR_MAX = 10
const POWER_MIN = 5

const powerLevelEditable = computed(() => state.value.powerLevel != null && state.value.powerLevel >= POWER_MIN)

function formatPowerLevel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '--'
  if (value === 0) return '<1 W'
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
  return `${text} W`
}

function powerMax(): number {
  return state.value.firmware?.spa1 === null ? 10 : 100
}

function powerCommand(value: number): string {
  const typePwr = state.value.firmware?.spa1 === null ? '1' : '2'
  return `PC${typePwr}${String(value).padStart(3, '0')}`
}

function openValueEditor(editor: ValueEditor, value: number | null) {
  if (value == null) return
  valueEditor.value = editor
  valueEditorValue.value = Math.max(editor.min, Math.min(editor.max, value))
}

function closeValueEditor() {
  valueEditor.value = null
}

function stepValueEditor(direction: -1 | 1) {
  const editor = valueEditor.value
  if (!editor) return
  const next = valueEditorValue.value + direction * editor.step
  valueEditorValue.value = Math.max(editor.min, Math.min(editor.max, next))
}

function openPowerEditor() {
  const value = state.value.powerLevel
  if (value == null || value < POWER_MIN) return
  openValueEditor({ key: 'pwr', title: 'RF Power', label: 'Power', min: POWER_MIN, max: powerMax(), step: 1, unit: ' W' }, value)
}

function openUsbModGainEditor() {
  openValueEditor({ key: 'usbMod', title: 'USB MOD Gain', label: 'USB MOD', min: 0, max: 100, step: 1 }, state.value.usbModGain)
}

function openUsbOutLevelEditor() {
  openValueEditor({ key: 'usbOut', title: 'USB OUT Level', label: 'USB OUT', min: 0, max: 100, step: 1 }, state.value.usbOutLevel)
}

function openAmcEditor() {
  openValueEditor({ key: 'amc', title: 'AMC Level', label: 'AMC', min: 1, max: 100, step: 1 }, state.value.amcLevel)
}

function openProcLevelEditor() {
  openValueEditor({ key: 'proc', title: 'Processor Level', label: 'PROC', min: 0, max: 100, step: 1 }, state.value.speechProcLevel)
}

function openVoxGainEditor() {
  openValueEditor({ key: 'voxGain', title: 'VOX Gain', label: 'VOX', min: 0, max: 100, step: 1 }, state.value.voxGain)
}

function openDnrEditor(vfo: '0' | '1') {
  const mode = vfo === '0' ? state.value.mainMode : state.value.subMode
  if (!isDnrMode(mode)) return
  const raw = vfo === '0' ? state.value.dnrMain : state.value.dnrSub
  const value = raw == null || raw === 'OFF' ? 0 : Number(raw)
  if (!Number.isFinite(value)) return
  openValueEditor({
    key: vfo === '0' ? 'dnrMain' : 'dnrSub',
    title: `${vfo === '0' ? 'MAIN' : 'SUB'} DNR`,
    label: 'DNR',
    min: DNR_MIN,
    max: DNR_MAX,
    step: 1,
  }, value)
}

async function applyValueEditor() {
  const editor = valueEditor.value
  if (!editor) return
  const next = Math.round(Math.max(editor.min, Math.min(editor.max, Number(valueEditorValue.value))))
  let command: string

  switch (editor.key) {
    case 'pwr':
      command = powerCommand(next)
      break
    case 'usbMod':
      command = remoteTxUsbModGainCommand(next)
      break
    case 'usbOut':
      command = remoteUsbOutLevelCommand(next)
      break
    case 'amc':
      command = `AO${String(next).padStart(3, '0')}`
      break
    case 'proc':
      command = `PL${String(next).padStart(3, '0')}`
      break
    case 'voxGain':
      command = `VG${String(next).padStart(3, '0')}`
      break
    case 'dnrMain':
      command = `RL0${String(next).padStart(2, '0')}`
      break
    case 'dnrSub':
      command = `RL1${String(next).padStart(2, '0')}`
      break
  }

  try {
    await $fetch('/api/command', { method: 'POST', body: { command } })
    closeValueEditor()
  } catch (e: any) {
    lastError.value = e.message
  }
}

const RF_GAIN_MODES = new Set(['LSB', 'USB', 'CW-U', 'CW-L', 'RTTY-L', 'RTTY-U', 'DATA-L', 'DATA-U', 'PSK'])

function isRfGainMode(mode: string | null): boolean {
  return mode != null && RF_GAIN_MODES.has(mode)
}

/** Human-readable SQL type label */
function sqlTypeLabel(type: number | null): string {
  return type != null ? (SQL_TYPE_LABELS[type] ?? String(type)) : '--'
}

/** Zone badge: name plus 1-based channel scroll position within the zone. */
function zoneBadgeValue(vfo: '0' | '1'): string {
  if (!isMemoryLikeVfoMode(vfoMemoryMode(vfo))) return 'Direct Frequency'
  const zone = vfo === '0' ? state.value.mainZone : state.value.subZone
  const position = vfo === '0' ? state.value.mainZonePosition : state.value.subZonePosition
  if (!zone) return '--'
  return position != null ? `${zone} · ${position}` : zone
}

function zoneBadgeTitle(vfo: '0' | '1'): string {
  return isMemoryLikeVfoMode(vfoMemoryMode(vfo)) ? 'Zone' : 'VFO direct frequency'
}

/** CSS color for the SQL type badge */
function sqlTypeColor(type: number | null): string {
  return type != null ? (SQL_TYPE_COLORS[type] ?? '#6b7280') : '#6b7280'
}

/**
 * Returns the tone/code string to display next to the SQL type.
 * For CTCSS: "127.3 Hz"; for DCS: "D156"; for type 0 (OFF): null.
 */
function toneDisplay(
  sqlType: number | null,
  ctcssTone: number | null,
  dcsCode: number | null,
): string | null {
  if (sqlType === null || sqlType === 0) return null
  if (sqlType === 3) {
    // DCS
    if (dcsCode === null || dcsCode < 0 || dcsCode >= DCS_CODES.length) return null
    return `D${String(DCS_CODES[dcsCode]).padStart(3, '0')}`
  }
  // CTCSS (types 1, 2, 4, 5) — type 4/5 may also use the stored CTCSS tone
  if (ctcssTone !== null && ctcssTone >= 0 && ctcssTone < CTCSS_TONES.length) {
    return `${CTCSS_TONES[ctcssTone].toFixed(1)} Hz`
  }
  return null
}

function vfoMode(vfo: '0' | '1'): string | null {
  return vfo === '0' ? state.value.mainMode : state.value.subMode
}

function vfoSqlType(vfo: '0' | '1'): number | null {
  return vfo === '0' ? state.value.mainSqlType : state.value.subSqlType
}

function vfoCtcssTone(vfo: '0' | '1'): number | null {
  return vfo === '0' ? state.value.mainCtcssTone : state.value.subCtcssTone
}

function vfoDcsCode(vfo: '0' | '1'): number | null {
  return vfo === '0' ? state.value.mainDcsCode : state.value.subDcsCode
}

function vfoToneSqlVisible(vfo: '0' | '1'): boolean {
  const sqlType = vfoSqlType(vfo)
  return isFmMode(vfoMode(vfo)) && sqlType !== null && sqlType !== 0
}

function vfoToneDisplay(vfo: '0' | '1'): string | null {
  return toneDisplay(vfoSqlType(vfo), vfoCtcssTone(vfo), vfoDcsCode(vfo))
}

function vfoDmrCallerDisplay(vfo: '0' | '1'): string | null {
  if (vfoMode(vfo) !== 'DMR') return null
  // Only on the attributed side (same latch logic as the meter / live TG badge).
  if (state.value.dmrCallVfo == null || Number(vfo) !== state.value.dmrCallVfo) return null
  const activity = state.value.dmrActivity
  if (!activity?.isUser) return null
  const parts = [
    activity.callsign || (activity.id ? `ID ${activity.id}` : null),
    activity.name,
    activity.location,
  ].filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' · ') : null
}

// The live incoming talkgroup of an in-progress DMR call (from the radio's 0x59
// push), surfaced only when it differs from the channel's programmed contact —
// e.g. Digital Monitor "dual" hears traffic on a TG the channel isn't set to.
// dmrActivity is global to the radio's DMR receiver, so it shows on the DMR side.
// Prefix for the programmed DMR contact badge: a Group call is a talkgroup (TG),
// a Private call is a unit ID (e.g. a hotspot channel set to PARROT), All Call is
// broadcast. Decoded from the channel's call-class byte (server contactCallType).
function vfoContactPrefix(vfo: '0' | '1'): string {
  const t = vfo === '0' ? state.value.mainContactCallType : state.value.subContactCallType
  return t === 'private' ? 'Priv' : t === 'all' ? 'All' : 'TG'
}

function vfoDmrLiveTalkgroup(vfo: '0' | '1'): string | null {
  if (vfoMode(vfo) !== 'DMR') return null
  // Only on the side the call is attributed to (matched, else active) — same latch
  // logic as the meter. Null until the call locks, so nothing shows before then.
  if (state.value.dmrCallVfo == null || Number(vfo) !== state.value.dmrCallVfo) return null
  const activity = state.value.dmrActivity
  if (!activity?.active) return null
  const isPrivate = activity.private === true
  // Group: the incoming talkgroup. Private: the call peer's DMR id.
  const value = isPrivate ? activity.id : activity.talkgroup
  if (value == null) return null
  // A group call on your own channel's TG is normal traffic (the contact badge
  // already shows it) — suppress. Private calls always show.
  if (!isPrivate) {
    const channelTg = vfo === '0' ? state.value.mainContactTg : state.value.subContactTg
    if (channelTg != null && String(channelTg) === String(value)) return null
  }
  // CC/slot ride the live 5e stream (byte 7 / byte 12); slot is 0-based → TS1/TS2.
  let label = `${isPrivate ? 'PRIV' : 'TG'} ${value}`
  if (activity.colorCode != null) label += ` · CC ${activity.colorCode}`
  if (activity.slot != null) label += ` · TS${activity.slot + 1}`
  return label
}

function vfoTxFrequencyDisplay(vfo: '0' | '1'): string | null {
  const txHz = vfo === '0' ? state.value.mainTxFreq : state.value.subTxFreq
  const rxHz = vfo === '0' ? state.value.mainFreq : state.value.subFreq
  if (txHz == null || txHz === rxHz) return null
  return `${(txHz / 1_000_000).toFixed(5)} MHz`
}

function vfoSqlBadgeStyle(vfo: '0' | '1') {
  const color = sqlTypeColor(vfoSqlType(vfo))
  return { background: `${color}28`, borderColor: color, color }
}

function splitFreqLabel(hz: number | null): string | null {
  if (hz == null) return null
  const mhz = hz % 1000 === 0
    ? (hz / 1_000_000).toFixed(3)
    : (hz / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return `${mhz} MHz`
}

function activeMemoryForVfo(vfo: '0' | '1'): RadioMemory | null {
  const mode = vfo === '0' ? state.value.mainVfoMode : state.value.subVfoMode
  if (!isMemoryLikeVfoMode(mode)) return null
  const channel = vfo === '0' ? state.value.mainMemoryChannel : state.value.subMemoryChannel
  if (!channel) return null
  return state.value.radioMemories.find(memory => memory.channel === channel) ?? null
}

function memorySplitDisplay(vfo: '0' | '1'): string | null {
  const memory = activeMemoryForVfo(vfo)
  if (!memory?.split || !memory.splitFreq) return null
  return `TX ${splitFreqLabel(memory.splitFreq)}`
}

function vfoInfoRowVisible(vfo: '0' | '1'): boolean {
  return Boolean(vfoToneSqlVisible(vfo) || memorySplitDisplay(vfo))
}

// ----------- helpers -----------

function formatFreq(hz: number | null): string {
  if (hz == null) return '---.---.---'
  const mhz = hz / 1_000_000
  // Format as XXX.XXX.XXX
  const [intPart, decPart = ''] = mhz.toFixed(6).split('.')
  const d = decPart.padEnd(6, '0')
  return `${intPart.padStart(3, ' ')}.${d.slice(0, 3)}.${d.slice(3)}`
}

function mediaFreq(hz: number | null): string {
  if (hz == null) return '---.---'
  return `${(hz / 1_000_000).toFixed(3)}`
}

function mediaArtworkFromSource(src: string, type: string) {
  return AUDIO_MEDIA_ARTWORK_SIZES.map(size => ({
    src,
    sizes: `${size}x${size}`,
    type,
  }))
}

async function loadAudioMediaArtwork() {
  try {
    audioMediaArtwork.value = await renderSvgArtworkAsPng(AUDIO_MEDIA_ARTWORK_SOURCE)
    updateAudioMediaSession()
  } catch {
    audioMediaArtwork.value = mediaArtworkFromSource(AUDIO_MEDIA_ARTWORK_SOURCE, 'image/svg+xml')
  }
}

function renderSvgArtworkAsPng(src: string) {
  return new Promise<Array<{ src: string; sizes: string; type: string }>>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try {
        const artwork = AUDIO_MEDIA_ARTWORK_SIZES.map(size => {
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('Canvas is unavailable')
          ctx.drawImage(image, 0, 0, size, size)
          return { src: canvas.toDataURL('image/png'), sizes: `${size}x${size}`, type: 'image/png' }
        })
        resolve(artwork)
      } catch (err) {
        reject(err)
      }
    }
    image.onerror = () => reject(new Error('Could not load media artwork'))
    image.src = src
  })
}

function mediaVfoSummary(vfo: '0' | '1'): string {
  const label = vfo === '0' ? 'MAIN' : 'SUB'
  if (pseudoScanVfoIsScanning(vfo)) return `${label} SCANNING`

  const freq = vfo === '0' ? state.value.mainFreq : state.value.subFreq
  const vfoMode = vfo === '0' ? state.value.mainVfoMode : state.value.subVfoMode
  const channel = vfo === '0' ? state.value.mainMemoryChannel : state.value.subMemoryChannel
  const tag = vfo === '0' ? state.value.mainMemoryTag : state.value.subMemoryTag
  const modeLabel: Record<string, string> = {
    VFO: 'VFO',
    P: 'VFO',
    MEMORY: 'MEM',
    MT: 'MT',
    QMB: 'QMB',
    PMS: 'PMS',
    '5MHz MEMORY': '5MHz',
    EMG: 'EMG',
  }
  const stateLabel = modeLabel[vfoMode ?? 'VFO'] ?? vfoMode ?? 'VFO'
  const memoryName = stateLabel === 'VFO' ? null : (tag ?? channel)
  return [label, stateLabel, memoryName, mediaFreq(freq)].filter(Boolean).join(' ')
}

/** Split frequency in Hz into three 3-digit display groups: [MHz, kHz, Hz] */
function freqGroups(hz: number | null): [string, string, string] {
  if (hz == null) return ['---', '---', '---']
  const h = Math.max(0, Math.round(hz))
  const mhz = Math.floor(h / 1_000_000)
  const khz = Math.floor((h % 1_000_000) / 1_000)
  const hz3 = h % 1_000
  return [
    String(mhz).padStart(3, '\u00a0'),  // non-breaking space → right-aligned in monospace
    String(khz).padStart(3, '0'),
    String(hz3).padStart(3, '0'),
  ]
}

function frequencyInputValue(hz: number | null): string {
  if (hz == null) return ''
  return (hz / 1_000_000).toFixed(6).replace(/\.0+$|0+$/g, '').replace(/\.$/, '')
}

function frequencyEditBlockedReason(): string | null {
  if (!state.value.connected) return 'Connect to the radio before changing frequency'
  if (radioTxActive.value) return 'Cannot change frequency while transmitting'
  if (state.value.pseudoScanActive) return 'Stop pseudo scan before changing frequency'
  if (state.value.radioMemoryScanActive) return 'Wait for memory scan to finish before changing frequency'
  return null
}

function isFrequencyEditable(_vfo: '0' | '1'): boolean {
  return frequencyEditBlockedReason() === null
}

function frequencyEditTitle(_vfo: '0' | '1'): string {
  return frequencyEditBlockedReason() ?? 'Tap to enter RX frequency'
}

function openFrequencyEditor(vfo: '0' | '1') {
  const blocked = frequencyEditBlockedReason()
  if (blocked) {
    lastError.value = blocked
    return
  }
  const current = vfo === '0' ? state.value.mainFreq : state.value.subFreq
  frequencyEditVfo.value = vfo
  frequencyInput.value = frequencyInputValue(current)
  nextTick(() => frequencyInputRef.value?.focus())
}

function closeFrequencyEditor() {
  frequencyEditVfo.value = null
}

function parseFrequencyInput(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '')
  if (!normalized) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed >= 1000 ? parsed : parsed * 1_000_000)
}

async function setVfoReceiveFrequency(vfo: '0' | '1', hz: number, updateLocal = false) {
  const side = vfo === '0' ? 'A' : 'B'
  await $fetch('/api/frequency', { method: 'POST', body: { band: 'rx', hz: Math.round(hz), side } })
  if (updateLocal) {
    if (vfo === '0') state.value.mainFreq = Math.round(hz)
    else state.value.subFreq = Math.round(hz)
  }
}

async function applyFrequencyEditor() {
  const vfo = frequencyEditVfo.value
  if (!vfo) return
  const blocked = frequencyEditBlockedReason()
  if (blocked) {
    lastError.value = blocked
    closeFrequencyEditor()
    return
  }
  const hz = parseFrequencyInput(frequencyInput.value)
  if (hz == null || hz < FREQ_MIN || hz > FREQ_MAX) {
    lastError.value = 'Enter a valid frequency in MHz'
    return
  }
  try {
    await setVfoReceiveFrequency(vfo, hz, true)
    closeFrequencyEditor()
  } catch (e: any) {
    lastError.value = e.message
  }
}

const FREQ_STEP_MHZ = 1_000_000
const FREQ_STEP_HZ  = 100
const FREQ_MIN      = 100_000       // 100 kHz
const FREQ_MAX      = 999_999_990   // 4 BCD bytes of Hz/10
const TX_FREQ_MIN   = 30_000
const TX_FREQ_MAX   = 470_000_000

// Effective TX frequency for a side: the radio's reported TX field, falling back
// to RX (simplex). The TX row always renders this so the layout stays consistent
// even when TX == RX.
function vfoTxFreq(vfo: '0' | '1'): number | null {
  const tx = vfo === '0' ? state.value.mainTxFreq : state.value.subTxFreq
  const rx = vfo === '0' ? state.value.mainFreq : state.value.subFreq
  return tx ?? rx
}

function txFrequencyEditTitle(_vfo: '0' | '1'): string {
  return frequencyEditBlockedReason() ?? 'Tap to enter TX frequency'
}

function openTxFrequencyEditor(vfo: '0' | '1') {
  const blocked = frequencyEditBlockedReason()
  if (blocked) {
    lastError.value = blocked
    return
  }
  txFrequencyEditVfo.value = vfo
  txFrequencyInput.value = frequencyInputValue(vfoTxFreq(vfo))
  nextTick(() => txFrequencyInputRef.value?.focus())
}

function closeTxFrequencyEditor() {
  txFrequencyEditVfo.value = null
}

async function applyTxFrequencyEditor() {
  const vfo = txFrequencyEditVfo.value
  if (!vfo) return
  const blocked = frequencyEditBlockedReason()
  if (blocked) {
    lastError.value = blocked
    closeTxFrequencyEditor()
    return
  }
  const hz = parseFrequencyInput(txFrequencyInput.value)
  if (hz == null || hz < TX_FREQ_MIN || hz > TX_FREQ_MAX) {
    lastError.value = 'Enter a valid TX frequency in MHz'
    return
  }
  if (await setVfoTransmitFrequency(vfo, hz, true)) closeTxFrequencyEditor()
}

async function setVfoTransmitFrequency(vfo: '0' | '1', hz: number, updateLocal = false): Promise<boolean> {
  const side = vfo === '0' ? 'A' : 'B'
  try {
    await $fetch('/api/frequency', { method: 'POST', body: { band: 'tx', hz: Math.round(hz), side } })
    if (updateLocal) {
      if (vfo === '0') state.value.mainTxFreq = Math.round(hz)
      else state.value.subTxFreq = Math.round(hz)
    }
    return true
  } catch (e: any) {
    lastError.value = e.message
    return false
  }
}

async function onTxFreqWheel(vfo: '0' | '1', groupIdx: number, event: WheelEvent) {
  if (!isFrequencyEditable(vfo)) return
  const current = vfoTxFreq(vfo)
  if (current == null) return
  event.preventDefault()
  const direction = event.deltaY < 0 ? 1 : -1
  const mode = vfoMode(vfo)
  const khzStep = mode != null && FM_MODES.has(mode) ? 5_000 : 1_000
  const step = groupIdx === 0 ? FREQ_STEP_MHZ : groupIdx === 1 ? khzStep : FREQ_STEP_HZ
  const newFreq = Math.max(TX_FREQ_MIN, Math.min(TX_FREQ_MAX, current + direction * step))
  if (newFreq === current) return
  await setVfoTransmitFrequency(vfo, newFreq, true)
}

async function onFreqWheel(vfo: '0' | '1', groupIdx: number, event: WheelEvent) {
  if (!isFrequencyEditable(vfo)) return
  const current = vfo === '0' ? state.value.mainFreq : state.value.subFreq
  if (current == null) return
  event.preventDefault()
  const direction = event.deltaY < 0 ? 1 : -1
  const mode = vfo === '0' ? state.value.mainMode : state.value.subMode
  const khzStep = mode != null && FM_MODES.has(mode) ? 5_000 : 1_000
  const step = groupIdx === 0 ? FREQ_STEP_MHZ : groupIdx === 1 ? khzStep : FREQ_STEP_HZ
  const newFreq = Math.max(FREQ_MIN, Math.min(FREQ_MAX, current + direction * step))
  if (newFreq === current) return
  try {
    await setVfoReceiveFrequency(vfo, newFreq)
  } catch (e: any) {
    lastError.value = e.message
  }
}

const MODE_COLORS: Record<string, string> = {
  LSB: '#3b82f6',
  USB: '#8b5cf6',
  'CW-U': '#f59e0b',
  'CW-L': '#f59e0b',
  FM: '#10b981',
  'FM-N': '#10b981',
  AM: '#ef4444',
  'AM-N': '#ef4444',
  'RTTY-L': '#ec4899',
  'RTTY-U': '#ec4899',
  'DATA-L': '#06b6d4',
  'DATA-U': '#06b6d4',
  PSK: '#a78bfa',
  'C4FM-DN': '#34d399',
  'C4FM-VW': '#34d399',
}

function modeBadgeStyle(mode: string | null) {
  const hex = mode ? (MODE_COLORS[mode] ?? '#6b7280') : '#6b7280'
  // Match the other sql-badges: translucent fill + solid border + colored text,
  // tinted by the mode's color (digital vs analog).
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const n = parseInt(full, 16)
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
  return { background: `rgba(${rgb}, .14)`, borderColor: `rgba(${rgb}, .72)`, color: hex }
}

// MD command mode list: { code: CAT hex char, label: mode name }
const MODES = [
  { code: '0', label: 'AMS' },
  { code: '1', label: 'LSB' },
  { code: '2', label: 'USB' },
  { code: '3', label: 'CW-U' },
  { code: '7', label: 'CW-L' },
  { code: '5', label: 'AM' },
  { code: 'D', label: 'AM-N' },
  { code: '4', label: 'FM' },
  { code: 'B', label: 'FM-N' },
  { code: '6', label: 'RTTY-L' },
  { code: '9', label: 'RTTY-U' },
  { code: '8', label: 'DATA-L' },
  { code: 'C', label: 'DATA-U' },
  { code: 'A', label: 'DATA-FM' },
  { code: 'F', label: 'DATA-FM-N' },
  { code: 'E', label: 'PSK' },
  { code: 'H', label: 'C4FM-DN' },
  { code: 'I', label: 'C4FM-VW' },
] as const

const modeBusy = ref(false)

// Modes that carry an implicit Narrow flag (NA=1); all others → NA=0
const NARROW_MODES = new Set(['FM-N', 'AM-N', 'DATA-FM-N'])

async function selectMode(vfo: '0' | '1', label: string) {
  if (modeBusy.value || !label) return
  const entry = MODES.find(m => m.label === label)
  if (!entry) return
  modeBusy.value = true
  try {
    // MD P1 P2 ; — P1=0 main / 1 sub, P2=mode code
    await $fetch('/api/command', { method: 'POST', body: { command: `MD${vfo}${entry.code}` } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    modeBusy.value = false
  }
}

// ── Band picker modal ────────────────────────────────────

const bandPopupVfo  = ref<'0' | '1' | null>(null)
const bandDialogRef = ref<HTMLElement | null>(null)

function openBandPopup(vfo: '0' | '1') {
  bandPopupVfo.value = vfo
  nextTick(() => {
    const dialog = bandDialogRef.value
    if (!dialog) return
    const active = dialog.querySelector<HTMLElement>('.band-modal-btn--active')
    const first  = dialog.querySelector<HTMLElement>('.band-modal-btn')
    ;(active ?? first)?.focus()
  })
}

function closeBandPopup() {
  bandPopupVfo.value = null
}

async function selectBandFromPopup(vfo: '0' | '1', code: string) {
  closeBandPopup()
  await selectBand(vfo, code)
}

// ── Mode picker modal ────────────────────────────────────

const modePopupVfo  = ref<'0' | '1' | null>(null)
const modeDialogRef = ref<HTMLElement | null>(null)

function openModePopup(vfo: '0' | '1') {
  modePopupVfo.value = vfo
  nextTick(() => {
    const dialog = modeDialogRef.value
    if (!dialog) return
    const active = dialog.querySelector<HTMLElement>('.mode-modal-btn--active')
    const first  = dialog.querySelector<HTMLElement>('.mode-modal-btn')
    ;(active ?? first)?.focus()
  })
}

function closeModePopup() {
  modePopupVfo.value = null
}

async function selectModeFromPopup(vfo: '0' | '1', label: string) {
  closeModePopup()
  await selectMode(vfo, label)
}

// ----------- API calls -----------

async function refreshPorts() {
  try {
    const data = await $fetch<{ ports: PortInfo[] }>('/api/ports')
    ports.value = data.ports
    // Restore the saved dropdown selection (a radio address, or 'bt'/'wired');
    // fall back to the legacy transport-kind key, then to the first option.
    const saved = localStorage.getItem('anytone_target')
      || localStorage.getItem('anytone_transport')
      || localStorage.getItem('cat_port')
    if (saved && transportOptions.value.some(option => option.value === saved)) {
      selectedDropdown.value = saved
    } else if (!transportOptions.value.some(option => option.value === selectedDropdown.value)) {
      selectedDropdown.value = transportOptions.value[0]?.value ?? 'bt'
    }
  } catch (e: any) {
    lastError.value = e.message ?? 'Failed to list transports'
  }
}

async function loadAudioStatus() {
  audioStatusLoading.value = true
  try {
    audioStatus.value = await $fetch<AudioStatus>('/api/audio/status')
  } catch (e: any) {
    audioStatus.value = {
      enabled: false,
      available: false,
      transport: state.value.connected ? state.value.transport : selectedTransport.value,
      engine: '',
      backend: '',
      input: '',
      output: '',
      txBackend: '',
      txOutput: '',
      txChannels: '1',
      txSampleRate: '',
      channels: '1',
      bitrate: '',
      sampleRate: '',
      filter: '',
      gain: '',
      limiter: false,
      limit: '',
      macosBufferSize: '',
      squelchGate: false,
      squelchPollMs: 0,
      squelchRampMs: 0,
      contentType: 'application/octet-stream',
      message: e.message ?? 'Cannot check audio status',
    }
  } finally {
    audioStatusLoading.value = false
  }
}

async function toggleAudio() {
  if (audioListening.value || audioAbortController || audioPeerConnection) {
    stopAudio()
    return
  }
  const initialPlayback = primeAudioPlaybackFromGesture()
  await startAudio(initialPlayback)
}

async function togglePlaybackAudio() {
  const wasPlayback = audioReceiveMode.value === 'playback'
  if (wasPlayback || audioListening.value || audioAbortController || audioPeerConnection) {
    stopAudio()
    if (wasPlayback) return
  }

  audioBusy.value = true
  lastError.value = null
  const initialPlayback = startPlaybackAudioFromGesture()
  await finishPlaybackAudioStart(initialPlayback)
}

async function startAudio(initialPlayback?: Promise<boolean>) {
  audioBusy.value = true
  lastError.value = null
  try {
    await loadAudioStatus()
    if (!audioStatus.value?.available) {
      lastError.value = audioStatus.value?.message ?? 'Audio streaming is not available'
      stopAudio()
      return
    }

    await startWebRtcAudio(initialPlayback)
  } catch (e: any) {
    stopAudio()
    lastError.value = e.message ?? 'Could not start audio playback'
  } finally {
    audioBusy.value = false
  }
}

function startPlaybackAudioFromGesture() {
  const element = audioPlayerRef.value

  closeWebRtcStats()
  clearWebRtcReconnectTimers()
  stopWebRtcFlowWatchdog()
  releaseAudioPlaybackPrimer()
  if (element) configureAudioElement(element)
  audioReceiveMode.value = 'playback'
  audioWebRtcState.value = 'idle'
  audioElement = element

  if (element) {
    element.pause()
    element.srcObject = null
    element.removeAttribute('src')
    element.load()
  }
  setBrowserAudioSessionType('playback')
  setupAudioMediaSessionHandlers()
  updateAudioMediaSession()
  return startPcmAudio().then(() => true, (e: any) => {
    lastError.value = e?.message ?? 'Could not start low-latency HTTP audio'
    return false
  })
}

async function finishPlaybackAudioStart(initialPlayback: Promise<boolean>) {
  audioBusy.value = true
  try {
    await loadAudioStatus()
    if (!audioStatus.value?.available) throw new Error(audioStatus.value?.message ?? 'Audio streaming is not available')

    const ok = await initialPlayback
    if (!ok) throw new Error(lastError.value ?? 'Playback-only HTTP audio failed. Tap HTTP Audio again.')

    audioListening.value = true
    updateAudioMediaSession()
  } catch (e: any) {
    stopAudio()
    lastError.value = e.message ?? 'Could not start playback-only audio'
  } finally {
    audioBusy.value = false
  }
}

function playbackAudioStreamUrl() {
  const sampleRate = encodeURIComponent(audioStatus.value?.sampleRate || '48000')
  return `/api/audio/stream?format=pcm&sampleRate=${sampleRate}&channels=${PCM_PLAYBACK_CHANNEL_COUNT}&exclusive=1&t=${Date.now()}`
}

async function startWebRtcAudio(initialPlayback?: Promise<boolean>) {
  if (!window.RTCPeerConnection) throw new Error('This browser does not support WebRTC playback')
  await nextTick()
  clearWebRtcReconnectTimers()
  startWebRtcDiagnosticRun('start-webrtc-audio')
  audioReceiveMode.value = 'webrtc'
  audioWebRtcState.value = 'starting'
  audioWebRtcReconnectAttempt.value = 0
  logWebRtcDiagnostic('audio-start', {
    online: navigator.onLine,
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    userActivation: browserUserActivationState(),
    opus: currentWebRtcOpusOptions(),
  })

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })
  logWebRtcDiagnostic('peer-created', peerConnectionDiagnosticState(pc))
  attachWebRtcDiagnosticListeners(pc)
  const stream = new MediaStream()
  const element = audioPlayerRef.value
  if (!element) throw new Error('Audio player element is not available')
  configureAudioElement(element)

  audioPeerConnection = pc
  audioElement = element

  const initialPlay = initialPlayback ?? (element.srcObject || element.currentSrc ? playAudioElement(element, 'initial') : Promise.resolve(false))
  setBrowserAudioSessionType('playback')
  setupAudioMediaSessionHandlers()
  updateAudioMediaSession()

  // One mono bidirectional audio section keeps mobile audio routing predictable.
  audioMicSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender

  pc.ontrack = (event) => {
    logWebRtcDiagnostic('remote-track', {
      kind: event.track.kind,
      readyState: event.track.readyState,
      streams: event.streams.length,
    })
    const remoteStream = event.streams[0] ?? stream
    if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track)
    element.srcObject = remoteStream
    releaseAudioPlaybackPrimer()
    logWebRtcDiagnostic('remote-stream-attached', audioElementDiagnosticState(element))
    void playAudioElement(element, 'remote-track').then((ok) => {
      if (!ok) lastError.value = 'Audio playback was blocked. Tap Disable Audio, then Enable Audio again.'
    })
    audioListening.value = true
    updateAudioMediaSession()
  }

  const offer = tuneOpusSessionDescription(await pc.createOffer(), currentWebRtcOpusOptions())
  logWebRtcDiagnostic('initial-offer-created', {
    sdp: summarizeSdp(offer.sdp),
    ...peerConnectionDiagnosticState(pc),
  })
  await pc.setLocalDescription(offer)
  logWebRtcDiagnostic('initial-local-description-set', {
    sdp: summarizeSdp(pc.localDescription?.sdp),
    ...peerConnectionDiagnosticState(pc),
  })
  await waitForIceGathering(pc)
  logWebRtcDiagnostic('initial-ice-gathering-done', {
    sdp: summarizeSdp(pc.localDescription?.sdp),
    ...peerConnectionDiagnosticState(pc),
  })
  if (!pc.localDescription) throw new Error('Could not create WebRTC offer')

  logWebRtcDiagnostic('initial-offer-post', { sdp: summarizeSdp(pc.localDescription.sdp) })
  const data = await $fetch<{ sessionId: string; answer: RTCSessionDescriptionInit }>('/api/audio/webrtc', {
    method: 'POST',
    body: {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp,
    },
  })

  audioWebRtcSessionId = data.sessionId
  logWebRtcDiagnostic('initial-answer-received', {
    sessionId: data.sessionId,
    sdp: summarizeSdp(data.answer.sdp),
  })
  void syncWebRtcRxMix()
  await pc.setRemoteDescription(data.answer)
  logWebRtcDiagnostic('initial-remote-description-set', peerConnectionDiagnosticState(pc))

  await waitForInitialWebRtcConnection(pc)

  await initialPlay
  markWebRtcConnected(pc)

  // Post-connection handler: keep transient cellular handoffs alive and try ICE restart.
  pc.oniceconnectionstatechange = null
  pc.oniceconnectionstatechange = () => handleWebRtcIceStateChange(pc)
  pc.onconnectionstatechange = () => handleWebRtcConnectionStateChange(pc)
}

function configureAudioElement(element: HTMLAudioElement) {
  element.autoplay = true
  ;(element as HTMLAudioElement & { playsInline?: boolean }).playsInline = true
  element.controls = true
  element.muted = audioRxMutedForTx.value
  element.setAttribute('webkit-playsinline', 'true')
  element.setAttribute('x-webkit-airplay', 'allow')
}

function primeAudioPlaybackFromGesture() {
  const element = audioPlayerRef.value
  if (!element) return undefined
  configureAudioElement(element)
  const primer = ensureAudioPlaybackPrimer()
  if (primer && !element.srcObject && !element.currentSrc) element.srcObject = primer
  return playAudioElement(element, 'gesture-prime')
}

function ensureAudioPlaybackPrimer() {
  if (audioPlaybackPrimerStream?.getAudioTracks().some(track => track.readyState === 'live')) return audioPlaybackPrimerStream
  releaseAudioPlaybackPrimer()

  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return null

  try {
    const context = new AudioContextClass()
    const destination = context.createMediaStreamDestination()
    const gain = context.createGain()
    const oscillator = context.createOscillator()
    gain.gain.value = 0
    oscillator.connect(gain)
    gain.connect(destination)
    oscillator.start()
    void context.resume().catch(() => {})
    audioPlaybackPrimerContext = context
    audioPlaybackPrimerOscillator = oscillator
    audioPlaybackPrimerStream = destination.stream
    logWebRtcDiagnostic('audio-playback-primer-created', { userActivation: browserUserActivationState() })
    return audioPlaybackPrimerStream
  } catch (e: any) {
    logWebRtcDiagnostic('audio-playback-primer-error', { message: e?.message ?? String(e), userActivation: browserUserActivationState() })
    releaseAudioPlaybackPrimer()
    return null
  }
}

function releaseAudioPlaybackPrimer() {
  try { audioPlaybackPrimerOscillator?.stop() } catch {}
  try { audioPlaybackPrimerOscillator?.disconnect() } catch {}
  audioPlaybackPrimerOscillator = null
  audioPlaybackPrimerStream?.getTracks().forEach(track => track.stop())
  audioPlaybackPrimerStream = null
  const context = audioPlaybackPrimerContext
  audioPlaybackPrimerContext = null
  context?.close().catch(() => {})
}

function playAudioElement(element: HTMLAudioElement, reason: string): Promise<boolean> {
  const logPlaybackDiagnostic = shouldLogAudioPlaybackDiagnostic(reason)
  try {
    const result = element.play()
    if (!result) {
      if (logPlaybackDiagnostic) logWebRtcDiagnostic('audio-element-play-started', { reason, ...audioElementDiagnosticState(element), userActivation: browserUserActivationState() })
      return Promise.resolve(true)
    }

    return result.then(() => {
      if (logPlaybackDiagnostic) logWebRtcDiagnostic('audio-element-play-started', { reason, ...audioElementDiagnosticState(element), userActivation: browserUserActivationState() })
      return true
    }).catch((e: any) => {
      if (logPlaybackDiagnostic) {
        logWebRtcDiagnostic('audio-element-play-blocked', {
          reason,
          message: e?.message ?? String(e),
          name: e?.name ?? null,
          ...audioElementDiagnosticState(element),
          userActivation: browserUserActivationState(),
        })
      }
      return false
    })
  } catch (e: any) {
    if (logPlaybackDiagnostic) {
      logWebRtcDiagnostic('audio-element-play-error', {
        reason,
        message: e?.message ?? String(e),
        name: e?.name ?? null,
        ...audioElementDiagnosticState(element),
        userActivation: browserUserActivationState(),
      })
    }
    return Promise.resolve(false)
  }
}

function shouldLogAudioPlaybackDiagnostic(reason: string) {
  return audioReceiveMode.value !== 'playback' || !reason.includes('playback')
}

function audioElementDiagnosticState(element: HTMLAudioElement) {
  const stream = element.srcObject instanceof MediaStream ? element.srcObject : null
  return {
    paused: element.paused,
    muted: element.muted,
    autoplay: element.autoplay,
    readyState: element.readyState,
    networkState: element.networkState,
    currentSrc: element.currentSrc ? 'set' : '',
    srcObject: summarizeMediaStream(stream),
    error: element.error ? { code: element.error.code, message: element.error.message } : null,
  }
}

function summarizeMediaStream(stream: MediaStream | null) {
  if (!stream) return null
  return {
    id: stream.id,
    active: stream.active,
    audioTracks: stream.getAudioTracks().map(summarizeMediaStreamTrack),
    videoTracks: stream.getVideoTracks().map(summarizeMediaStreamTrack),
  }
}

function summarizeMediaStreamTrack(track: MediaStreamTrack) {
  return {
    kind: track.kind,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
  }
}

function browserUserActivationState() {
  const activation = (navigator as unknown as { userActivation?: { isActive?: boolean; hasBeenActive?: boolean } }).userActivation
  return {
    isActive: activation?.isActive ?? null,
    hasBeenActive: activation?.hasBeenActive ?? null,
  }
}

function handleWebRtcIceStateChange(pc: RTCPeerConnection) {
  if (!isCurrentAudioPeer(pc)) return
  if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
    markWebRtcConnected(pc)
  } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
    enterWebRtcReconnecting(pc)
  } else if (pc.iceConnectionState === 'closed') {
    stopAudio()
  }
  if (webrtcStatsOpen.value) void refreshWebRtcStats()
}

function handleWebRtcConnectionStateChange(pc: RTCPeerConnection) {
  if (!isCurrentAudioPeer(pc)) return
  if (pc.connectionState === 'connected') {
    markWebRtcConnected(pc)
  } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
    enterWebRtcReconnecting(pc)
  } else if (pc.connectionState === 'closed') {
    stopAudio()
  }
  if (webrtcStatsOpen.value) void refreshWebRtcStats()
}

function waitForInitialWebRtcConnection(pc: RTCPeerConnection) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish('timeout'), 10000)
    const mediaTimer = setInterval(check, 250)

    const finish = (reason: 'connected' | 'media-playback' | 'failed' | 'timeout') => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(mediaTimer)
      pc.removeEventListener('iceconnectionstatechange', check)
      pc.removeEventListener('connectionstatechange', check)
      logWebRtcDiagnostic(`initial-connection-${reason}`, peerConnectionDiagnosticState(pc))
      if (reason === 'connected' || reason === 'media-playback') {
        void logWebRtcStatsDiagnostic('initial-ice-connected-stats', pc)
        resolve()
      } else if (reason === 'failed') {
        void logWebRtcStatsDiagnostic('initial-ice-failed-stats', pc)
        reject(new Error('WebRTC ICE connection failed'))
      } else {
        void logWebRtcStatsDiagnostic('initial-ice-timeout-stats', pc)
        reject(new Error('WebRTC connection timed out'))
      }
    }

    function check() {
      logWebRtcDiagnostic('initial-connection-check', peerConnectionDiagnosticState(pc))
      if (isWebRtcConnected(pc)) finish('connected')
      else if (hasLiveRemoteAudioPlayback()) finish('media-playback')
      else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') finish('failed')
      else if (pc.connectionState === 'closed' || pc.iceConnectionState === 'closed') finish('failed')
    }

    pc.addEventListener('iceconnectionstatechange', check)
    pc.addEventListener('connectionstatechange', check)
    check()
  })
}

function markWebRtcConnected(pc: RTCPeerConnection) {
  if (!isCurrentAudioPeer(pc)) return
  const wasConnected = audioWebRtcState.value === 'connected'
  clearWebRtcReconnectTimers()
  audioWebRtcState.value = 'connected'
  audioListening.value = true
  startWebRtcFlowWatchdog(pc)
  logWebRtcDiagnostic(wasConnected ? 'connected-confirmed' : 'connected', peerConnectionDiagnosticState(pc))
  void logWebRtcStatsDiagnostic('connected-stats', pc)
  updateAudioMediaSession()
}

function enterWebRtcReconnecting(pc: RTCPeerConnection) {
  if (!isCurrentAudioPeer(pc)) return
  if (isWebRtcConnected(pc)) {
    markWebRtcConnected(pc)
    return
  }

  if (audioWebRtcState.value !== 'reconnecting') {
    audioWebRtcReconnectAttempt.value = 0
    audioIceReconnectDeadline = Date.now() + WEBRTC_ICE_RECONNECT_GRACE_MS
    logWebRtcDiagnostic('reconnect-start', {
      ...peerConnectionDiagnosticState(pc),
      graceMs: WEBRTC_ICE_RECONNECT_GRACE_MS,
    })
    void logWebRtcStatsDiagnostic('reconnect-start-stats', pc)
  } else {
    logWebRtcDiagnostic('reconnect-observed', peerConnectionDiagnosticState(pc))
  }

  audioWebRtcState.value = 'reconnecting'
  audioListening.value = true
  audioTxAvailable.value = false
  stopWebRtcFlowWatchdog()
  if (audioTxActive.value || audioTxBusy.value) void stopAudioTx()
  updateAudioMediaSession()

  if (!audioIceReconnectTimer) {
    const delay = Math.max(0, audioIceReconnectDeadline - Date.now())
    audioIceReconnectTimer = setTimeout(() => expireWebRtcReconnect(pc), delay)
  }

  scheduleWebRtcIceRestart(pc, pc.iceConnectionState === 'failed' || pc.connectionState === 'failed' ? 0 : WEBRTC_ICE_RESTART_DELAY_MS)
}

function expireWebRtcReconnect(pc: RTCPeerConnection) {
  audioIceReconnectTimer = null
  if (!isCurrentAudioPeer(pc)) return
  if (isWebRtcConnected(pc)) {
    markWebRtcConnected(pc)
    return
  }
  audioWebRtcState.value = 'failed'
  logWebRtcDiagnostic('reconnect-timeout', peerConnectionDiagnosticState(pc))
  void logWebRtcStatsDiagnostic('reconnect-timeout-stats', pc)
  lastError.value = 'WebRTC audio connection was lost. Re-enable audio to reconnect.'
  stopAudio()
}

function scheduleWebRtcIceRestart(pc: RTCPeerConnection, delayMs: number) {
  if (!isCurrentAudioPeer(pc) || audioIceRestartTimer || audioIceRestartInFlight) return
  if (audioWebRtcReconnectAttempt.value >= WEBRTC_ICE_RESTART_MAX_ATTEMPTS) return
  if (audioIceReconnectDeadline && Date.now() >= audioIceReconnectDeadline) return

  const delay = Math.max(0, Math.min(delayMs, Math.max(0, audioIceReconnectDeadline - Date.now())))
  logWebRtcDiagnostic('ice-restart-scheduled', {
    delayMs: delay,
    attempt: audioWebRtcReconnectAttempt.value + 1,
    remainingMs: audioIceReconnectDeadline ? Math.max(0, audioIceReconnectDeadline - Date.now()) : null,
    ...peerConnectionDiagnosticState(pc),
  })
  audioIceRestartTimer = setTimeout(() => {
    audioIceRestartTimer = null
    void attemptWebRtcIceRestart(pc)
  }, delay)
}

async function attemptWebRtcIceRestart(pc: RTCPeerConnection) {
  if (!isCurrentAudioPeer(pc) || isWebRtcConnected(pc) || audioWebRtcState.value !== 'reconnecting') return
  if (audioWebRtcReconnectAttempt.value >= WEBRTC_ICE_RESTART_MAX_ATTEMPTS) return
  if (audioIceReconnectDeadline && Date.now() >= audioIceReconnectDeadline) return

  if (pc.signalingState !== 'stable') {
    scheduleWebRtcIceRestart(pc, 500)
    return
  }

  audioIceRestartInFlight = true
  audioWebRtcReconnectAttempt.value += 1
  logWebRtcDiagnostic('ice-restart-attempt-start', {
    attempt: audioWebRtcReconnectAttempt.value,
    ...peerConnectionDiagnosticState(pc),
  })
  void logWebRtcStatsDiagnostic('ice-restart-attempt-start-stats', pc)
  try {
    await renegotiateWebRtcIce(pc)
    logWebRtcDiagnostic('ice-restart-renegotiation-complete', {
      attempt: audioWebRtcReconnectAttempt.value,
      ...peerConnectionDiagnosticState(pc),
    })
  } catch (e: any) {
    logWebRtcDiagnostic('ice-restart-renegotiation-error', {
      attempt: audioWebRtcReconnectAttempt.value,
      message: e?.message ?? String(e),
      ...peerConnectionDiagnosticState(pc),
    })
    if (isCurrentAudioPeer(pc) && audioWebRtcState.value === 'reconnecting') {
      console.warn('[webrtc-audio] ICE restart failed:', e?.message ?? e)
    }
  } finally {
    if (isCurrentAudioPeer(pc)) audioIceRestartInFlight = false
  }

  if (!isCurrentAudioPeer(pc) || isWebRtcConnected(pc) || audioWebRtcState.value !== 'reconnecting') return
  if (needsWebRtcIceRestart(pc) && audioWebRtcReconnectAttempt.value < WEBRTC_ICE_RESTART_MAX_ATTEMPTS) {
    scheduleWebRtcIceRestart(pc, WEBRTC_ICE_RESTART_RETRY_MS)
  }
}

async function renegotiateWebRtcIce(pc: RTCPeerConnection) {
  const sessionId = audioWebRtcSessionId
  if (!sessionId) throw new Error('WebRTC audio session is not ready')

  pc.restartIce?.()
  logWebRtcDiagnostic('ice-restart-requested', {
    sessionId,
    attempt: audioWebRtcReconnectAttempt.value,
    ...peerConnectionDiagnosticState(pc),
  })
  const offer = tuneOpusSessionDescription(await pc.createOffer({ iceRestart: true }), currentWebRtcOpusOptions())
  logWebRtcDiagnostic('ice-restart-offer-created', {
    attempt: audioWebRtcReconnectAttempt.value,
    sdp: summarizeSdp(offer.sdp),
    ...peerConnectionDiagnosticState(pc),
  })
  await pc.setLocalDescription(offer)
  logWebRtcDiagnostic('ice-restart-local-description-set', {
    attempt: audioWebRtcReconnectAttempt.value,
    sdp: summarizeSdp(pc.localDescription?.sdp),
    ...peerConnectionDiagnosticState(pc),
  })
  const gatheringResult = await waitForIceRestartGathering(pc, offer.sdp)
  logWebRtcDiagnostic('ice-restart-gathering-done', {
    attempt: audioWebRtcReconnectAttempt.value,
    result: gatheringResult,
    sdp: summarizeSdp(pc.localDescription?.sdp),
    ...peerConnectionDiagnosticState(pc),
  })
  if (!pc.localDescription?.sdp) throw new Error('Could not create WebRTC ICE restart offer')

  logWebRtcDiagnostic('ice-restart-offer-post', {
    sessionId,
    attempt: audioWebRtcReconnectAttempt.value,
    sdp: summarizeSdp(pc.localDescription.sdp),
  })
  const data = await $fetch<{ sessionId: string; answer: RTCSessionDescriptionInit }>(`/api/audio/webrtc/${sessionId}/renegotiate`, {
    method: 'POST',
    body: { sdp: pc.localDescription.sdp },
  })

  logWebRtcDiagnostic('ice-restart-answer-received', {
    sessionId: data.sessionId,
    attempt: audioWebRtcReconnectAttempt.value,
    sdp: summarizeSdp(data.answer.sdp),
  })
  if (!isCurrentAudioPeer(pc)) return
  await pc.setRemoteDescription(data.answer)
  logWebRtcDiagnostic('ice-restart-remote-description-set', {
    attempt: audioWebRtcReconnectAttempt.value,
    ...peerConnectionDiagnosticState(pc),
  })
  void logWebRtcStatsDiagnostic('ice-restart-remote-description-stats', pc)
}

function isCurrentAudioPeer(pc: RTCPeerConnection) {
  return audioPeerConnection === pc && pc.signalingState !== 'closed'
}

function isAudioPeerReadyForTx() {
  const pc = audioPeerConnection
  if (!pc || pc.signalingState === 'closed' || !audioWebRtcSessionId || !audioMicSender) return false
  if (audioWebRtcState.value === 'idle' || audioWebRtcState.value === 'reconnecting' || audioWebRtcState.value === 'failed') return false
  return audioWebRtcState.value === 'connected' || isWebRtcConnected(pc) || hasLiveRemoteAudioPlayback()
}

function hasLiveRemoteAudioPlayback() {
  const element = audioElement ?? audioPlayerRef.value
  const stream = element?.srcObject instanceof MediaStream ? element.srcObject : null
  return !!element && !element.paused && !!stream?.getAudioTracks().some(track => track.readyState === 'live')
}

function isWebRtcConnected(pc: RTCPeerConnection) {
  return pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed'
}

function needsWebRtcIceRestart(pc: RTCPeerConnection) {
  return pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed'
}

function clearWebRtcReconnectTimers() {
  if (audioIceReconnectTimer) clearTimeout(audioIceReconnectTimer)
  if (audioIceRestartTimer) clearTimeout(audioIceRestartTimer)
  audioIceReconnectTimer = null
  audioIceRestartTimer = null
  audioIceRestartInFlight = false
  audioIceReconnectDeadline = 0
  audioWebRtcReconnectAttempt.value = 0
}

function startWebRtcFlowWatchdog(pc: RTCPeerConnection) {
  if (!isCurrentAudioPeer(pc)) return
  if (audioWebRtcFlowWatchdogTimer) clearInterval(audioWebRtcFlowWatchdogTimer)
  audioWebRtcFlowWatchdogTimer = null
  resetWebRtcFlowWatchdog()
  logWebRtcDiagnostic('flow-watchdog-start', {
    intervalMs: WEBRTC_FLOW_WATCHDOG_INTERVAL_MS,
    stallMs: WEBRTC_FLOW_STALL_MS,
    ...peerConnectionDiagnosticState(pc),
  })
  audioWebRtcFlowWatchdogTimer = setInterval(() => {
    void checkWebRtcFlowWatchdog(pc)
  }, WEBRTC_FLOW_WATCHDOG_INTERVAL_MS)
}

function stopWebRtcFlowWatchdog() {
  if (audioWebRtcFlowWatchdogTimer) clearInterval(audioWebRtcFlowWatchdogTimer)
  audioWebRtcFlowWatchdogTimer = null
  audioWebRtcFlowWatchdogBusy = false
  resetWebRtcFlowWatchdog()
}

function resetWebRtcFlowWatchdog() {
  audioWebRtcLastFlowAt = 0
  audioWebRtcLastInboundPackets = null
  audioWebRtcLastInboundBytes = null
  audioWebRtcLastPairBytesReceived = null
}

async function checkWebRtcFlowWatchdog(pc: RTCPeerConnection) {
  if (audioWebRtcFlowWatchdogBusy || !isCurrentAudioPeer(pc) || audioWebRtcState.value !== 'connected') return
  audioWebRtcFlowWatchdogBusy = true

  try {
    const report = await pc.getStats()
    const reports = Array.from(report.values()).map(value => value as unknown as WebRtcStatsRecord)
    const inboundAudio = reports.find(item => item.type === 'inbound-rtp' && isAudioReport(item)) ?? null
    const selectedPair = findSelectedCandidatePair(report, reports)
    const inboundPackets = statsNumber(inboundAudio?.packetsReceived)
    const inboundBytes = statsNumber(inboundAudio?.bytesReceived)
    const pairBytesReceived = statsNumber(selectedPair?.bytesReceived)
    const now = Date.now()

    if (!audioWebRtcLastFlowAt) {
      audioWebRtcLastFlowAt = now
      audioWebRtcLastInboundPackets = inboundPackets
      audioWebRtcLastInboundBytes = inboundBytes
      audioWebRtcLastPairBytesReceived = pairBytesReceived
      logWebRtcDiagnostic('flow-watchdog-baseline', {
        inboundPackets,
        inboundBytes,
        pairBytesReceived,
        ...peerConnectionDiagnosticState(pc),
      })
      return
    }

    const hasInboundCounter = inboundPackets !== null || inboundBytes !== null
    const inboundAdvanced = hasInboundCounter && (
      (inboundPackets !== null && audioWebRtcLastInboundPackets !== null && inboundPackets > audioWebRtcLastInboundPackets) ||
      (inboundBytes !== null && audioWebRtcLastInboundBytes !== null && inboundBytes > audioWebRtcLastInboundBytes)
    )
    const pairAdvanced = !hasInboundCounter && pairBytesReceived !== null && audioWebRtcLastPairBytesReceived !== null && pairBytesReceived > audioWebRtcLastPairBytesReceived

    if (inboundAdvanced || pairAdvanced) audioWebRtcLastFlowAt = now

    audioWebRtcLastInboundPackets = inboundPackets
    audioWebRtcLastInboundBytes = inboundBytes
    audioWebRtcLastPairBytesReceived = pairBytesReceived

    const stalledMs = now - audioWebRtcLastFlowAt
    if (stalledMs < WEBRTC_FLOW_STALL_MS) return

    if (currentWebRtcOpusOptions().usedtx) {
      audioWebRtcLastFlowAt = now
      logWebRtcDiagnostic('flow-watchdog-paused-for-dtx', {
        stalledMs,
        inboundPackets,
        inboundBytes,
        pairBytesReceived,
        selectedCandidatePair: summarizeCandidatePair(selectedPair),
        ...peerConnectionDiagnosticState(pc),
      })
      return
    }

    logWebRtcDiagnostic('flow-watchdog-stalled', {
      stalledMs,
      inboundPackets,
      inboundBytes,
      pairBytesReceived,
      selectedCandidatePair: summarizeCandidatePair(selectedPair),
      ...peerConnectionDiagnosticState(pc),
    })
    void logWebRtcStatsDiagnostic('flow-watchdog-stalled-stats', pc)
    enterWebRtcReconnecting(pc)
  } catch (e: any) {
    logWebRtcDiagnostic('flow-watchdog-error', { message: e?.message ?? String(e) })
  } finally {
    audioWebRtcFlowWatchdogBusy = false
  }
}

function statsNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function startWebRtcDiagnosticRun(reason: string) {
  webrtcDiagnosticRun += 1
  if (!webrtcDiagnosticStartedAt) webrtcDiagnosticStartedAt = Date.now()
  logWebRtcDiagnostic('diagnostic-run-start', { reason, run: webrtcDiagnosticRun })
}

function logWebRtcDiagnostic(event: string, data: Record<string, unknown> = {}) {
  const now = Date.now()
  if (!webrtcDiagnosticStartedAt) webrtcDiagnosticStartedAt = now
  const entry: WebRtcDiagnosticEvent = {
    seq: ++webrtcDiagnosticSeq,
    run: webrtcDiagnosticRun,
    t: now,
    elapsedMs: now - webrtcDiagnosticStartedAt,
    event,
    data: sanitizeWebRtcDiagnosticData(data),
  }
  webrtcDiagnostics.value = [...webrtcDiagnostics.value, entry].slice(-WEBRTC_DIAGNOSTIC_MAX_EVENTS)
  console.debug('[webrtc-audio]', event, entry.data ?? {})
}

function sanitizeWebRtcDiagnosticData(data: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || typeof value === 'function') continue
    sanitized[key] = sanitizeWebRtcDiagnosticValue(value)
  }
  return sanitized
}

function sanitizeWebRtcDiagnosticValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(sanitizeWebRtcDiagnosticValue)
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined && typeof item !== 'function') output[key] = sanitizeWebRtcDiagnosticValue(item)
    }
    return output
  }
  return String(value)
}

function peerConnectionDiagnosticState(pc: RTCPeerConnection) {
  return {
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
  }
}

function attachWebRtcDiagnosticListeners(pc: RTCPeerConnection) {
  pc.addEventListener('signalingstatechange', () => {
    if (audioPeerConnection !== pc) return
    logWebRtcDiagnostic('signaling-state-change', peerConnectionDiagnosticState(pc))
  })
  pc.addEventListener('iceconnectionstatechange', () => {
    if (audioPeerConnection !== pc) return
    logWebRtcDiagnostic('ice-connection-state-change', peerConnectionDiagnosticState(pc))
    void logWebRtcStatsDiagnostic('ice-connection-state-stats', pc)
  })
  pc.addEventListener('connectionstatechange', () => {
    if (audioPeerConnection !== pc) return
    logWebRtcDiagnostic('connection-state-change', peerConnectionDiagnosticState(pc))
    void logWebRtcStatsDiagnostic('connection-state-stats', pc)
  })
  pc.addEventListener('icegatheringstatechange', () => {
    if (audioPeerConnection !== pc) return
    logWebRtcDiagnostic('ice-gathering-state-change', {
      ...peerConnectionDiagnosticState(pc),
      localDescription: summarizeSdp(pc.localDescription?.sdp),
    })
  })
  pc.addEventListener('icecandidate', (event) => {
    if (audioPeerConnection !== pc) return
    logWebRtcDiagnostic('local-ice-candidate', summarizeIceCandidate(event.candidate))
  })
}

function summarizeSdp(sdp: string | null | undefined) {
  if (!sdp) return { length: 0, candidates: 0, candidateTypes: {}, protocols: {}, iceUfrag: null, opus: summarizeOpusSdp(sdp) }
  const candidateLines = sdp.split('\n').filter(line => line.startsWith('a=candidate:'))
  return {
    length: sdp.length,
    candidates: candidateLines.length,
    candidateTypes: countValues(candidateLines.map(candidateTypeFromLine)),
    protocols: countValues(candidateLines.map(candidateProtocolFromLine)),
    iceUfrag: sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim() ?? null,
    opus: summarizeOpusSdp(sdp),
  }
}

function currentWebRtcOpusOptions() {
  return normalizeWebRtcOpusOptions(audioStatus.value?.webrtcOpus ?? DEFAULT_WEBRTC_OPUS_OPTIONS)
}

function summarizeIceCandidate(candidate: RTCIceCandidate | RTCIceCandidateInit | null | undefined) {
  if (!candidate) return { endOfCandidates: true }
  const init = typeof (candidate as RTCIceCandidate).toJSON === 'function'
    ? (candidate as RTCIceCandidate).toJSON()
    : candidate as RTCIceCandidateInit
  const line = init.candidate || ''
  return {
    endOfCandidates: false,
    sdpMid: init.sdpMid ?? null,
    sdpMLineIndex: init.sdpMLineIndex ?? null,
    usernameFragment: init.usernameFragment ?? null,
    candidateType: candidateTypeFromLine(line),
    protocol: candidateProtocolFromLine(line),
    length: line.length,
  }
}

function candidateTypeFromLine(line: string | null | undefined) {
  return String(line || '').match(/\styp\s+(\S+)/)?.[1] ?? 'unknown'
}

function candidateProtocolFromLine(line: string | null | undefined) {
  const parts = String(line || '').trim().split(/\s+/)
  return parts[2]?.toLowerCase() ?? 'unknown'
}

function countValues(values: Array<string | null | undefined>) {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value || 'unknown'] = (counts[value || 'unknown'] ?? 0) + 1
  return counts
}

async function logWebRtcStatsDiagnostic(event: string, pc: RTCPeerConnection) {
  if (!isCurrentAudioPeer(pc)) return
  try {
    const report = await pc.getStats()
    const reports = Array.from(report.values()).map(value => value as unknown as WebRtcStatsRecord)
    const selectedCandidatePair = findSelectedCandidatePair(report, reports)
    const localCandidates = reports.filter(item => item.type === 'local-candidate')
    const remoteCandidates = reports.filter(item => item.type === 'remote-candidate')
    const candidatePairs = reports.filter(item => item.type === 'candidate-pair')
    logWebRtcDiagnostic(event, {
      ...peerConnectionDiagnosticState(pc),
      selectedCandidatePair: summarizeCandidatePair(selectedCandidatePair),
      candidatePairStates: countValues(candidatePairs.map(item => String(item.state ?? 'unknown'))),
      localCandidateTypes: countValues(localCandidates.map(item => String(item.candidateType ?? 'unknown'))),
      localCandidateProtocols: countValues(localCandidates.map(item => String(item.protocol ?? 'unknown'))),
      localCandidateNetworks: countValues(localCandidates.map(item => String(item.networkType ?? 'unknown'))),
      remoteCandidateTypes: countValues(remoteCandidates.map(item => String(item.candidateType ?? 'unknown'))),
      remoteCandidateProtocols: countValues(remoteCandidates.map(item => String(item.protocol ?? 'unknown'))),
    })
  } catch (e: any) {
    logWebRtcDiagnostic(`${event}-error`, { message: e?.message ?? String(e) })
  }
}

function summarizeCandidatePair(pair: WebRtcStatsRecord | null | undefined) {
  if (!pair) return null
  return {
    state: pair.state ?? null,
    nominated: pair.nominated ?? null,
    selected: pair.selected ?? null,
    currentRoundTripTime: pair.currentRoundTripTime ?? null,
    availableOutgoingBitrate: pair.availableOutgoingBitrate ?? null,
    availableIncomingBitrate: pair.availableIncomingBitrate ?? null,
    bytesSent: pair.bytesSent ?? null,
    bytesReceived: pair.bytesReceived ?? null,
    packetsSent: pair.packetsSent ?? null,
    packetsReceived: pair.packetsReceived ?? null,
  }
}

function clearWebRtcDiagnostics() {
  webrtcDiagnostics.value = []
  webrtcDiagnosticsCopied.value = false
  webrtcDiagnosticSeq = 0
  webrtcDiagnosticRun = 0
  webrtcDiagnosticStartedAt = 0
}

function selectWebRtcDiagnostics() {
  const el = webrtcDiagnosticsTextRef.value
  if (!el) return
  el.focus()
  el.select()
  el.setSelectionRange(0, el.value.length)
}

async function copyWebRtcDiagnostics() {
  webrtcDiagnosticsCopied.value = false
  try {
    await navigator.clipboard?.writeText(webrtcDiagnosticsJson.value)
    webrtcDiagnosticsCopied.value = true
  } catch {
    selectWebRtcDiagnostics()
    try {
      document.execCommand('copy')
      webrtcDiagnosticsCopied.value = true
    } catch {}
  }
  if (webrtcDiagnosticsCopied.value) setTimeout(() => { webrtcDiagnosticsCopied.value = false }, 1500)
}

function formatWebRtcDiagnosticTime(item: WebRtcDiagnosticEvent) {
  return `+${(item.elapsedMs / 1000).toFixed(1)}s`
}

function formatWebRtcDiagnosticData(data: Record<string, unknown>) {
  return JSON.stringify(data)
}

function onBrowserOnline() {
  logWebRtcDiagnostic('browser-online', {
    online: navigator.onLine,
    webRtcState: audioWebRtcState.value,
    peer: audioPeerConnection ? peerConnectionDiagnosticState(audioPeerConnection) : null,
  })
  if (audioPeerConnection) void logWebRtcStatsDiagnostic('browser-online-stats', audioPeerConnection)
}

function onBrowserOffline() {
  logWebRtcDiagnostic('browser-offline', {
    online: navigator.onLine,
    webRtcState: audioWebRtcState.value,
    peer: audioPeerConnection ? peerConnectionDiagnosticState(audioPeerConnection) : null,
  })
  if (audioPeerConnection) void logWebRtcStatsDiagnostic('browser-offline-stats', audioPeerConnection)
}

function onVisibilityChange() {
  logWebRtcDiagnostic('visibility-change', {
    visibilityState: document.visibilityState,
    online: navigator.onLine,
    webRtcState: audioWebRtcState.value,
    peer: audioPeerConnection ? peerConnectionDiagnosticState(audioPeerConnection) : null,
  })
}

function toggleWebRtcStats() {
  if (webrtcStatsOpen.value) closeWebRtcStats()
  else openWebRtcStats()
}

function openWebRtcStats() {
  webrtcStatsOpen.value = true
  void refreshWebRtcStats()
  startWebRtcStatsPolling()
}

function closeWebRtcStats() {
  webrtcStatsOpen.value = false
  stopWebRtcStatsPolling()
}

function startWebRtcStatsPolling() {
  stopWebRtcStatsPolling()
  webrtcStatsTimer = setInterval(() => { void refreshWebRtcStats() }, 1000)
}

function stopWebRtcStatsPolling() {
  if (webrtcStatsTimer) clearInterval(webrtcStatsTimer)
  webrtcStatsTimer = null
}

async function refreshWebRtcStats() {
  if (webrtcStatsRefreshInFlight) return

  const pc = audioPeerConnection
  const sessionId = audioWebRtcSessionId
  if (!pc && !sessionId) {
    webrtcStatsError.value = 'No active WebRTC audio session.'
    return
  }

  webrtcStatsRefreshInFlight = true
  webrtcStatsLoading.value = true
  webrtcStatsError.value = null

  try {
    const browserStats = pc ? await collectBrowserWebRtcStats(pc) : emptyBrowserWebRtcStats()
    let serverSession: WebRtcServerSession | null = null
    let serverError: string | null = null

    try {
      const serverStatus = await $fetch<WebRtcServerStatus>('/api/audio/webrtc/status')
      serverSession = serverStatus.sessions.find(session => session.id === sessionId) ?? serverStatus.sessions[0] ?? null
    } catch (e: any) {
      serverError = e.message ?? 'Could not fetch server WebRTC stats'
    }

    webrtcStats.value = {
      ...browserStats,
      collectedAt: Date.now(),
      sessionId,
      serverSession,
      serverError,
    }
  } catch (e: any) {
    webrtcStatsError.value = e.message ?? 'Could not collect WebRTC stats'
  } finally {
    webrtcStatsLoading.value = false
    webrtcStatsRefreshInFlight = false
  }
}

async function collectBrowserWebRtcStats(pc: RTCPeerConnection): Promise<Omit<WebRtcStatsSnapshot, 'collectedAt' | 'sessionId' | 'serverSession' | 'serverError'>> {
  const report = await pc.getStats()
  const reports = Array.from(report.values()).map(value => value as unknown as WebRtcStatsRecord)
  const selectedCandidatePair = findSelectedCandidatePair(report, reports)
  const inboundAudio = reports.find(item => item.type === 'inbound-rtp' && isAudioReport(item)) ?? null
  const outboundAudio = reports.find(item => item.type === 'outbound-rtp' && isAudioReport(item)) ?? null
  const remoteInboundAudio = reports.find(item => item.type === 'remote-inbound-rtp' && isAudioReport(item)) ?? null

  return {
    connection: {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
    },
    selectedCandidatePair: pickStatsReport(selectedCandidatePair, [
      'state',
      'nominated',
      'selected',
      'bytesReceived',
      'bytesSent',
      'packetsReceived',
      'packetsSent',
      'currentRoundTripTime',
      'totalRoundTripTime',
      'availableOutgoingBitrate',
      'availableIncomingBitrate',
      'requestsReceived',
      'requestsSent',
      'responsesReceived',
      'responsesSent',
      'consentRequestsSent',
      'localCandidateId',
      'remoteCandidateId',
    ]),
    localCandidate: pickStatsReport(statsReportById(report, selectedCandidatePair?.localCandidateId), [
      'candidateType',
      'protocol',
      'address',
      'ip',
      'port',
      'networkType',
      'relayProtocol',
      'url',
    ]),
    remoteCandidate: pickStatsReport(statsReportById(report, selectedCandidatePair?.remoteCandidateId), [
      'candidateType',
      'protocol',
      'address',
      'ip',
      'port',
      'networkType',
      'relayProtocol',
      'url',
    ]),
    inboundAudio: pickStatsReport(inboundAudio, [
      'kind',
      'mediaType',
      'packetsReceived',
      'packetsLost',
      'bytesReceived',
      'jitter',
      'jitterBufferDelay',
      'jitterBufferEmittedCount',
      'totalSamplesReceived',
      'totalSamplesDuration',
      'concealedSamples',
      'concealmentEvents',
      'insertedSamplesForDeceleration',
      'removedSamplesForAcceleration',
      'audioLevel',
      'totalAudioEnergy',
      'codecId',
    ]),
    inboundCodec: pickStatsReport(codecForReport(report, inboundAudio), ['mimeType', 'clockRate', 'channels', 'sdpFmtpLine', 'payloadType']),
    outboundAudio: pickStatsReport(outboundAudio, [
      'kind',
      'mediaType',
      'packetsSent',
      'bytesSent',
      'retransmittedPacketsSent',
      'retransmittedBytesSent',
      'totalPacketSendDelay',
      'nackCount',
      'qualityLimitationReason',
      'codecId',
    ]),
    outboundCodec: pickStatsReport(codecForReport(report, outboundAudio), ['mimeType', 'clockRate', 'channels', 'sdpFmtpLine', 'payloadType']),
    remoteInboundAudio: pickStatsReport(remoteInboundAudio, [
      'kind',
      'mediaType',
      'packetsLost',
      'fractionLost',
      'roundTripTime',
      'totalRoundTripTime',
      'jitter',
    ]),
  }
}

function emptyBrowserWebRtcStats(): Omit<WebRtcStatsSnapshot, 'collectedAt' | 'sessionId' | 'serverSession' | 'serverError'> {
  return {
    connection: null,
    selectedCandidatePair: null,
    localCandidate: null,
    remoteCandidate: null,
    inboundAudio: null,
    inboundCodec: null,
    outboundAudio: null,
    outboundCodec: null,
    remoteInboundAudio: null,
  }
}

function findSelectedCandidatePair(report: RTCStatsReport, reports: WebRtcStatsRecord[]) {
  const transport = reports.find(item => item.type === 'transport' && typeof item.selectedCandidatePairId === 'string')
  const transportPair = statsReportById(report, transport?.selectedCandidatePairId)
  if (transportPair) return transportPair

  return reports.find(item => item.type === 'candidate-pair' && item.selected === true)
    ?? reports.find(item => item.type === 'candidate-pair' && item.nominated === true && item.state === 'succeeded')
    ?? reports.find(item => item.type === 'candidate-pair' && item.state === 'succeeded')
    ?? null
}

function isAudioReport(report: WebRtcStatsRecord) {
  const kind = String(report.kind ?? report.mediaType ?? '').toLowerCase()
  return kind === 'audio'
}

function codecForReport(report: RTCStatsReport, stats: WebRtcStatsRecord | null) {
  return statsReportById(report, stats?.codecId)
}

function statsReportById(report: RTCStatsReport, id: unknown) {
  if (typeof id !== 'string') return null
  return (report.get(id) as unknown as WebRtcStatsRecord | undefined) ?? null
}

function pickStatsReport(report: WebRtcStatsRecord | null | undefined, keys: string[]) {
  if (!report) return null
  const picked: WebRtcStatsRecord = {
    id: report.id,
    type: report.type,
    timestamp: report.timestamp,
  }
  for (const key of keys) {
    if (report[key] !== undefined) picked[key] = report[key]
  }
  return picked
}

function statsReportRows(report: WebRtcStatsRecord | null | undefined, fields: Array<[string, string]>) {
  if (!report) return []
  return fields
    .map(([label, key]) => statRow(label, report[key], key))
    .filter(row => row.value !== '--')
}

function statRow(label: string, value: unknown, key = ''): WebRtcStatsRow {
  return {
    label,
    value: key ? formatStatsField(key, value) : formatPlainStatsValue(value),
  }
}

function formatStatsField(key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value !== 'number') return formatPlainStatsValue(value)

  const normalized = key.toLowerCase()
  if (normalized.includes('bytes')) return formatBytes(value)
  if (normalized.includes('bitrate')) return formatBitrate(value)
  if (
    normalized.includes('roundtrip') ||
    normalized.includes('delay') ||
    normalized === 'jitter' ||
    normalized.includes('duration')
  ) return formatSeconds(value)
  if (normalized.includes('level') || normalized.includes('energy') || normalized.includes('fraction')) return value.toFixed(4)
  return formatNumber(value)
}

function formatPlainStatsValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return formatNumber(value)
  if (Array.isArray(value)) return value.map(item => formatPlainStatsValue(item)).join(', ')
  return String(value)
}

function formatStatsTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString()
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return '--'
  if (Number.isInteger(value)) return value.toLocaleString()
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return '--'
  if (Math.abs(value) >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`
  if (Math.abs(value) >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value.toLocaleString()} B`
}

function formatBitrate(value: number) {
  if (!Number.isFinite(value)) return '--'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)} kbps`
  return `${value.toFixed(0)} bps`
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value)) return '--'
  if (Math.abs(value) < 1) return `${(value * 1000).toFixed(1)} ms`
  return `${value.toFixed(2)} s`
}

function formatCandidate(candidate: WebRtcStatsRecord | null | undefined) {
  if (!candidate) return null
  const address = candidate.address ?? candidate.ip
  const endpoint = address && candidate.port ? `${address}:${candidate.port}` : address
  return [candidate.candidateType, candidate.protocol, endpoint, candidate.networkType]
    .filter(value => value !== null && value !== undefined && value !== '')
    .join(' · ') || null
}

function formatCodec(codec: WebRtcStatsRecord | null | undefined) {
  if (!codec) return null
  const clock = typeof codec.clockRate === 'number' ? `${formatNumber(codec.clockRate)} Hz` : null
  const channels = typeof codec.channels === 'number' ? `${codec.channels} ch` : null
  return [codec.mimeType, clock, channels].filter(Boolean).join(' · ') || null
}

function formatRxChannel(channel: number | null | undefined) {
  if (channel === 0) return '0 · MAIN left'
  if (channel === 1) return '1 · SUB right'
  return null
}

function formatNumberArray(values: number[] | null | undefined) {
  if (!values?.length) return null
  return values.map(value => Number.isFinite(value) ? value.toFixed(3).replace(/\.000$/, '') : '--').join(', ')
}

function formatMeterSquelch(meter: number | null | undefined, squelch: number | null | undefined) {
  if (meter === null || meter === undefined || squelch === null || squelch === undefined) return null
  return `${meter} / ${squelch}`
}

function clearPlaybackAudioQueue() {
  if (audioWorkletNode) {
    audioWorkletNode.port.postMessage({ type: 'clear' })
    audioBufferedMs.value = 0
    audioUnderflow.value = false
    return
  }
  resetAudioQueue()
}

async function syncWebRtcRxMix(reportErrors = false) {
  const sessionId = audioWebRtcSessionId
  const requestId = ++rxAudioMixRequestId
  if (!sessionId) return false

  try {
    await $fetch(`/api/audio/webrtc/${sessionId}/rx-mix`, {
      method: 'POST',
      body: currentRxAudioMix(),
    })
    if (requestId === rxAudioMixRequestId && webrtcStatsOpen.value) void refreshWebRtcStats()
    return true
  } catch (e: any) {
    if (reportErrors) lastError.value = e.message ?? 'Could not update remote RX audio mix'
    return false
  }
}

function currentRxAudioMix(): WebRtcRxMix {
  return {
    mainGain: 1,
    subGain: 1,
    mainMuted: false,
    subMuted: false,
  }
}

function formatRxMixSide(mix: WebRtcRxMix | null | undefined, side: 'main' | 'sub') {
  if (!mix) return null
  const gain = side === 'main' ? mix.mainGain : mix.subGain
  const muted = side === 'main' ? mix.mainMuted : mix.subMuted
  return `${Math.round(gain * 100)}%${muted ? ' · muted' : ''}`
}

async function prepareAudioTxTrack() {
  audioTxAvailable.value = false
  audioTxError.value = null

  if (!navigator.mediaDevices?.getUserMedia) {
    audioTxError.value = 'This browser does not support microphone capture.'
    return
  }

  try {
    setBrowserAudioSessionType('play-and-record')
    audioMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1, max: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
    audioMicTrack = audioMicStream.getAudioTracks()[0] ?? null
    if (!audioMicTrack) throw new Error('No microphone audio track was provided')
    audioMicTrack.enabled = true
    audioTxAvailable.value = false
  } catch (e: any) {
    setBrowserAudioSessionType('playback')
    audioTxError.value = e.message ?? 'Microphone permission is required for TX. iOS requires HTTPS.'
    audioMicStream?.getTracks().forEach(track => track.stop())
    audioMicStream = null
    audioMicTrack = null
    audioMicActive.value = false
    audioTxAvailable.value = false
  }
}

async function ensureAudioTxTrack() {
  if (!audioWebRtcSessionId) throw new Error('WebRTC audio session is not ready')
  if (!audioReadyForTx.value) throw new Error('Wait for WebRTC audio to reconnect before transmitting')

  if (!audioMicTrack) {
    const pc = audioPeerConnection
    if (!pc) throw new Error('WebRTC connection is not available')
    await prepareAudioTxTrack()
    if (!audioMicTrack) {
      throw new Error(audioTxError.value ?? 'Microphone is not available')
    }
  }

  if (!audioMicSender) throw new Error('WebRTC TX sender is not ready. Restart Listen and try again.')

  if (audioMicSender.track !== audioMicTrack) {
    await audioMicSender.replaceTrack(audioMicTrack)
    confirmTxAudioStream()
  }
  audioMicActive.value = true
}

async function confirmTxAudioStream() {
  const ok = await waitForTxPackets(5000)
  audioTxAvailable.value = ok
}

async function waitForTxPackets(timeoutMs: number): Promise<boolean> {
  const pc = audioPeerConnection
  if (!pc) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const report = await pc.getStats()
    const values = Array.from(report.values()) as any[]
    const outbound = values.find(
      (r: any) => r.type === 'outbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')
    )
    if (outbound && outbound.packetsSent > 0) {
      const pair = values.find((r: any) => r.type === 'candidate-pair' && (r.selected || r.nominated))
      if (pair && pair.currentRoundTripTime > 0) return true
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

async function stopAudioMic() {
  if (audioTxActive.value || audioTxBusy.value) return
  await releaseAudioMic(false)
}

async function releaseAudioMic(keepTxAvailable: boolean) {

  try {
    await audioMicSender?.replaceTrack(null)
  } catch {
    // The sender may already be closed if the WebRTC session is stopping.
  }

  audioMicTrack?.stop()
  audioMicStream?.getTracks().forEach(track => track.stop())
  audioMicTrack = null
  audioMicStream = null
  audioMicActive.value = false
  audioTxAvailable.value = keepTxAvailable ? audioTxAvailable.value : false
  audioTxError.value = null
  setBrowserAudioSessionType('playback')
}

async function toggleAudioMic() {
  if (audioTxActive.value || audioTxBusy.value) return

  if (audioMicActive.value) {
    await stopAudioMic()
    return
  }

  try {
    if (!audioListening.value && !audioPeerConnection) await startAudio()
    await ensureAudioTxTrack()
  } catch (e: any) {
    lastError.value = e.message ?? 'Could not enable microphone'
  }
}

async function startAudioTx() {
  audioTxDesired = true
  setRxMutedForTx(true)
  const transitionId = ++audioTxTransitionId
  if (audioTxActive.value || audioTxBusy.value) return
  if (!state.value.connected) {
    lastError.value = 'Connect to the radio before transmitting'
    setRxMutedForTx(false)
    return
  }
  if (!audioReadyForTx.value) {
    lastError.value = 'Wait for WebRTC audio to reconnect before transmitting'
    setRxMutedForTx(false)
    return
  }
  if (!audioWebRtcSessionId) {
    lastError.value = 'WebRTC audio session is not ready'
    setRxMutedForTx(false)
    return
  }

  try {
    await ensureAudioTxTrack()
  } catch (e: any) {
    lastError.value = e.message ?? 'Microphone is not available for TX'
    setRxMutedForTx(false)
    return
  }

  audioTxBusy.value = true
  pttIntent.value = true
  try {
    if (!audioTxDesired || transitionId !== audioTxTransitionId) { pttIntent.value = false; return }

    await new Promise(r => setTimeout(r, REMOTE_TX_PREROLL_MS))
    if (!audioTxDesired || transitionId !== audioTxTransitionId) {
      pttIntent.value = false
      setRxMutedForTx(false)
      return
    }

    await $fetch('/api/command', { method: 'POST', body: { command: 'TX1' } })
    audioTxActive.value = true
    if (!audioTxDesired || transitionId !== audioTxTransitionId) {
      pttIntent.value = false
      audioTxActive.value = false
      await $fetch('/api/command', { method: 'POST', body: { command: 'TX0' } }).catch(() => {})
      setRxMutedForTx(false)
      return
    }
  } catch (e: any) {
    pttIntent.value = false
    await $fetch('/api/command', { method: 'POST', body: { command: 'TX0' } }).catch(() => {})
    audioTxDesired = false
    setRxMutedForTx(false)
    lastError.value = e.message ?? 'Could not start TX'
  } finally {
    audioTxBusy.value = false
    if (!audioTxDesired && audioTxActive.value) void stopAudioTx()
  }
}

async function stopAudioTx() {
  audioTxDesired = false
  pttIntent.value = false
  audioTxTransitionId++
  if (!audioTxActive.value && !audioTxBusy.value) return

  if (audioTxBusy.value) return
  audioTxBusy.value = true

  try {
    await new Promise(r => setTimeout(r, REMOTE_TX_TAIL_MS))
    await $fetch('/api/command', { method: 'POST', body: { command: 'TX0' } })
  } catch (e: any) {
    lastError.value = e.message ?? 'Could not stop TX'
  } finally {
    audioTxActive.value = false
    setRxMutedForTx(false)
    audioTxBusy.value = false
  }
}

function setRxMutedForTx(muted: boolean) {
  audioRxMutedForTx.value = muted
  if (audioElement) audioElement.muted = muted
  audioWorkletNode?.port.postMessage({ type: 'mute', muted })
}

function remoteTxUsbModGainCommand(value: number): string {
  const mode = (activeVfo.value === '0' ? state.value.mainMode : state.value.subMode) ?? 'FM'
  const gain = String(Math.max(0, Math.min(100, value))).padStart(3, '0')
  if (['LSB', 'USB', 'CW-U', 'CW-L', 'PSK'].includes(mode)) return `EX010114${gain}`
  if (['AM', 'AM-N'].includes(mode)) return `EX010214${gain}`
  if (mode.startsWith('DATA')) return `EX010414${gain}`
  return `EX010313${gain}`
}

function remoteUsbOutLevelCommand(value: number): string {
  const mode = (activeVfo.value === '0' ? state.value.mainMode : state.value.subMode) ?? 'FM'
  const level = String(Math.max(0, Math.min(100, value))).padStart(3, '0')
  if (['LSB', 'USB', 'CW-U', 'CW-L', 'PSK'].includes(mode)) return `EX010111${level}`
  if (['AM', 'AM-N'].includes(mode)) return `EX010211${level}`
  if (mode.startsWith('DATA')) return `EX010411${level}`
  return `EX010311${level}`
}

function onAudioTxPointerDown(event: PointerEvent) {
  if (audioTxPointerId !== null) return
  audioTxPointerId = event.pointerId
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  void startAudioTx()
}

function onAudioTxPointerUp(event: PointerEvent) {
  if (audioTxPointerId !== null && event.pointerId !== audioTxPointerId) return
  try { (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId) } catch {}
  audioTxPointerId = null
  void stopAudioTx()
}

function onAudioTxPointerCancel(event: PointerEvent) {
  if (audioTxPointerId !== null && event.pointerId !== audioTxPointerId) return
  audioTxPointerId = null
  void stopAudioTx()
}

async function startPcmAudio() {
  resetAudioQueue()
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) throw new Error('This browser does not support Web Audio playback')

  try {
    audioContext = new AudioContextClass({ latencyHint: 'interactive', sampleRate: 48000 })
  } catch {
    audioContext = new AudioContextClass({ latencyHint: 'interactive' })
  }
  await audioContext.resume()

  audioAbortController = new AbortController()
  const token = ++audioStreamToken
  const sampleRate = Math.round(audioContext.sampleRate)
  const response = await fetch(withAppBase(`/api/audio/stream?format=pcm&sampleRate=${sampleRate}&channels=${PCM_PLAYBACK_CHANNEL_COUNT}&exclusive=1&t=${Date.now()}`), {
    cache: 'no-store',
    signal: audioAbortController.signal,
  })

  if (!response.ok || !response.body) {
    const message = response.status === 503 ? await response.text() : `Audio stream failed (${response.status})`
    throw new Error(message)
  }

  audioReader = response.body.getReader()
  void readAudioStream(audioReader, token, PCM_PLAYBACK_CHANNEL_COUNT)
  await waitForAudioBuffer(token, sampleRate)
  if (token !== audioStreamToken) return

  await startPcmAudioOutput(sampleRate)
  audioListening.value = true
}

async function startPcmAudioOutput(sampleRate: number) {
  if (!audioContext) throw new Error('Audio context is not available')

  if (audioContext.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      await startPcmAudioWorklet(sampleRate)
      return
    } catch (e: any) {
      console.warn('[audio] AudioWorklet unavailable, using ScriptProcessor:', e?.message ?? e)
    }
  }

  audioProcessor = audioContext.createScriptProcessor(AUDIO_PROCESSOR_SIZE, 0, 1)
  audioProcessor.onaudioprocess = writeAudioOutput
  audioProcessor.connect(audioContext.destination)
}

async function startPcmAudioWorklet(sampleRate: number) {
  if (!audioContext) throw new Error('Audio context is not available')

  const source = `
class AnytonePcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.queueOffset = 0
    this.queuedSamples = 0
    this.refilling = true
    this.needsRamp = true
    this.lastSample = 0
    this.underflow = false
    this.muted = false
    this.startBufferSamples = Math.round(sampleRate * ${AUDIO_START_BUFFER_SECONDS})
    this.targetBufferSamples = Math.round(sampleRate * ${AUDIO_TARGET_BUFFER_SECONDS})
    this.maxBufferSamples = Math.round(sampleRate * ${AUDIO_MAX_BUFFER_SECONDS})
    this.rampSamples = ${AUDIO_RAMP_SAMPLES}
    this.lastStatusFrame = 0
    this.port.onmessage = (event) => this.handleMessage(event.data)
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'samples' && message.samples) {
      this.enqueue(message.samples)
    } else if (message.type === 'mute') {
      this.muted = message.muted === true
    } else if (message.type === 'clear') {
      this.clear()
    }
  }

  enqueue(samples) {
    if (!samples.length) return
    this.queue.push(samples)
    this.queuedSamples += samples.length
    if (this.queuedSamples > this.maxBufferSamples) {
      this.dropSamples(this.queuedSamples - this.targetBufferSamples)
      this.needsRamp = true
    }
    this.postStatus(false)
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0]
    if (!output) return true
    let outputOffset = 0

    if (this.muted) {
      this.dropSamples(this.queuedSamples)
      this.writeRampedSilence(output, 0)
      this.underflow = false
      this.postStatus()
      return true
    }

    if (this.refilling && this.queuedSamples < this.startBufferSamples) {
      this.writeRampedSilence(output, 0)
      this.underflow = true
      this.postStatus()
      return true
    }

    if (this.refilling) {
      this.refilling = false
      this.needsRamp = true
    }

    while (outputOffset < output.length && this.queue.length > 0) {
      const source = this.queue[0]
      const available = source.length - this.queueOffset
      const count = Math.min(available, output.length - outputOffset)
      this.copySamples(output, outputOffset, source, this.queueOffset, count)
      outputOffset += count
      this.queueOffset += count
      this.queuedSamples -= count
      if (this.queueOffset >= source.length) {
        this.queue.shift()
        this.queueOffset = 0
      }
    }

    if (outputOffset < output.length) {
      this.writeRampedSilence(output, outputOffset)
      this.underflow = true
      this.refilling = true
    } else {
      this.underflow = false
    }
    this.postStatus()
    return true
  }

  copySamples(output, outputOffset, source, sourceOffset, count) {
    let copied = 0
    if (this.needsRamp && count > 0) {
      const rampCount = Math.min(this.rampSamples, count)
      for (let i = 0; i < rampCount; i++) {
        const t = (i + 1) / rampCount
        output[outputOffset + i] = source[sourceOffset + i] * t + this.lastSample * (1 - t)
      }
      copied = rampCount
      this.needsRamp = false
    }
    if (copied < count) output.set(source.subarray(sourceOffset + copied, sourceOffset + count), outputOffset + copied)
    this.lastSample = output[outputOffset + count - 1] || this.lastSample
  }

  writeRampedSilence(output, offset) {
    const available = output.length - offset
    if (available <= 0) return
    const rampCount = Math.min(this.rampSamples, available)
    for (let i = 0; i < rampCount; i++) output[offset + i] = this.lastSample * (1 - ((i + 1) / rampCount))
    if (offset + rampCount < output.length) output.fill(0, offset + rampCount)
    this.lastSample = 0
    this.needsRamp = true
  }

  dropSamples(count) {
    let remaining = count
    while (remaining > 0 && this.queue.length > 0) {
      const source = this.queue[0]
      const available = source.length - this.queueOffset
      const dropped = Math.min(available, remaining)
      this.queueOffset += dropped
      this.queuedSamples -= dropped
      remaining -= dropped
      if (this.queueOffset >= source.length) {
        this.queue.shift()
        this.queueOffset = 0
      }
    }
  }

  clear() {
    this.queue = []
    this.queueOffset = 0
    this.queuedSamples = 0
    this.refilling = true
    this.needsRamp = true
    this.lastSample = 0
    this.underflow = false
  }

  postStatus(force = false) {
    if (!force && currentFrame - this.lastStatusFrame < sampleRate / 4) return
    this.lastStatusFrame = currentFrame
    this.port.postMessage({ type: 'status', queuedSamples: this.queuedSamples, underflow: this.underflow })
  }
}

registerProcessor('anytone-pcm-player', AnytonePcmPlayer)
`
  audioWorkletModuleUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
  await audioContext.audioWorklet.addModule(audioWorkletModuleUrl)
  audioWorkletNode = new AudioWorkletNode(audioContext, 'anytone-pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })
  audioWorkletNode.port.onmessage = (event) => {
    const message = event.data
    if (!message || message.type !== 'status') return
    audioBufferedMs.value = sampleRate > 0 ? (message.queuedSamples / sampleRate) * 1000 : 0
    audioUnderflow.value = message.underflow === true && audioListening.value
  }
  audioWorkletNode.port.postMessage({ type: 'mute', muted: audioRxMutedForTx.value })
  audioWorkletNode.connect(audioContext.destination)
  flushAudioQueueToWorklet()
}

function flushAudioQueueToWorklet() {
  if (!audioWorkletNode) return
  while (audioQueue.length > 0) {
    const source = audioQueue.shift()!
    const samples = audioQueueOffset > 0 ? source.slice(audioQueueOffset) : source
    audioWorkletNode.port.postMessage({ type: 'samples', samples }, [samples.buffer])
    audioQueueOffset = 0
  }
  audioQueuedSamples = 0
}

function waitForIceGathering(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, 2000)
    function done() {
      clearTimeout(timeout)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

function waitForIceRestartGathering(pc: RTCPeerConnection, baseSdp?: string | null) {
  const base = summarizeSdp(baseSdp)
  const baseUfrag = typeof base.iceUfrag === 'string' ? base.iceUfrag : null
  const startedAt = Date.now()

  return new Promise<Record<string, unknown>>((resolve) => {
    const timeout = setTimeout(() => done('timeout'), 10000)

    function done(reason: string) {
      clearTimeout(timeout)
      pc.removeEventListener('icegatheringstatechange', check)
      pc.removeEventListener('icecandidate', onCandidate)
      const current = summarizeSdp(pc.localDescription?.sdp)
      resolve({
        reason,
        elapsedMs: Date.now() - startedAt,
        baseCandidates: base.candidates,
        candidates: current.candidates,
        iceUfrag: current.iceUfrag,
        iceGatheringState: pc.iceGatheringState,
      })
    }

    function hasRestartCandidates() {
      const current = summarizeSdp(pc.localDescription?.sdp)
      return current.iceUfrag === baseUfrag && Number(current.candidates) > Number(base.candidates)
    }

    function check() {
      if (pc.iceGatheringState === 'complete' && hasRestartCandidates()) done('complete-with-candidates')
    }

    function onCandidate(event: RTCPeerConnectionIceEvent) {
      if (!event.candidate && hasRestartCandidates()) done('end-of-candidates')
    }

    pc.addEventListener('icegatheringstatechange', check)
    pc.addEventListener('icecandidate', onCandidate)

    setTimeout(() => {
      if (hasRestartCandidates() && pc.iceGatheringState === 'complete') done('delayed-complete-with-candidates')
    }, 0)
  })
}

function setBrowserAudioSessionType(type: string) {
  const audioSession = (navigator as unknown as { audioSession?: { type?: string } }).audioSession
  if (!audioSession) return
  try { audioSession.type = type } catch {}
}

type BrowserMediaPlaybackState = 'none' | 'paused' | 'playing'

type BrowserMediaSession = {
  metadata: unknown
  playbackState: BrowserMediaPlaybackState
  setActionHandler?: (action: string, handler: (() => void) | null) => void
}

function browserMediaSession() {
  return (navigator as unknown as { mediaSession?: BrowserMediaSession }).mediaSession ?? null
}

function audioMediaSessionKey() {
  const artwork = audioMediaArtwork.value.map(item => `${item.src}:${item.sizes ?? ''}:${item.type ?? ''}`).join('|')
  return [audioMediaTitle.value, audioMediaArtist.value, audioMediaAlbum.value, artwork].join('\u0000')
}

function setupAudioMediaSessionHandlers() {
  const session = browserMediaSession()
  if (!session?.setActionHandler) return

  const handlers: Array<[string, () => void]> = [
    ['play', () => {
      const element = audioElement ?? audioPlayerRef.value
      if (audioReceiveMode.value === 'playback') {
        if (audioContext) {
          void audioContext.resume().then(() => updateAudioMediaSessionPlaybackState()).catch(() => {})
        } else if (!audioBusy.value) {
          void togglePlaybackAudio()
        }
      } else if (audioPeerConnection && element) {
        void playAudioElement(element, 'media-session').then(() => updateAudioMediaSessionPlaybackState())
      } else if (!audioBusy.value) {
        const initialPlayback = primeAudioPlaybackFromGesture()
        void startAudio(initialPlayback)
      }
    }],
    ['pause', () => {
      if (audioReceiveMode.value === 'playback' && audioContext) {
        void audioContext.suspend().then(() => updateAudioMediaSessionPlaybackState()).catch(() => {})
        return
      }
      const element = audioElement ?? audioPlayerRef.value
      element?.pause()
      updateAudioMediaSessionPlaybackState()
    }],
    ['seekbackward', () => { void sendTxRxChannelStep('DN') }],
    ['seekforward', () => { void sendTxRxChannelStep('UP') }],
  ]

  for (const [action, handler] of handlers) {
    try { session.setActionHandler(action, handler) } catch {}
  }

  for (const action of ['stop', 'seekto', 'previoustrack', 'nexttrack', 'skipad']) {
    try { session.setActionHandler(action, null) } catch {}
  }
}

function updateAudioMediaSession() {
  const session = browserMediaSession()
  if (!session) return
  const mediaKey = audioMediaSessionKey()

  const MetadataCtor = (window as unknown as {
    MediaMetadata?: new (init: {
      title?: string
      artist?: string
      album?: string
      artwork?: Array<{ src: string; sizes?: string; type?: string }>
    }) => unknown
  }).MediaMetadata

  if (MetadataCtor && mediaKey !== lastAudioMediaSessionKey) {
    try {
      session.metadata = new MetadataCtor({
        title: audioMediaTitle.value,
        artist: audioMediaArtist.value,
        album: audioMediaAlbum.value,
        artwork: audioMediaArtwork.value,
      })
    } catch {}
  }
  lastAudioMediaSessionKey = mediaKey

  setupAudioMediaSessionHandlers()
  updateAudioMediaSessionPlaybackState()
}

function scheduleAudioMediaSessionUpdate() {
  if (!audioListening.value) return
  const mediaKey = audioMediaSessionKey()
  if (!audioMediaSessionTimer && mediaKey === lastAudioMediaSessionKey) return
  if (audioMediaSessionTimer && mediaKey === pendingAudioMediaSessionKey) return
  pendingAudioMediaSessionKey = mediaKey
  if (audioMediaSessionTimer) clearTimeout(audioMediaSessionTimer)
  audioMediaSessionTimer = setTimeout(() => {
    audioMediaSessionTimer = null
    pendingAudioMediaSessionKey = null
    updateAudioMediaSession()
  }, 120)
}

function updateAudioMediaSessionPlaybackState() {
  const session = browserMediaSession()
  if (!session) return
  const element = audioElement ?? audioPlayerRef.value
  if (audioReceiveMode.value === 'playback' && audioContext) {
    try { session.playbackState = audioListening.value && audioContext.state !== 'suspended' ? 'playing' : 'paused' } catch {}
    return
  }
  const playbackState: BrowserMediaPlaybackState = audioListening.value
    ? (element && !element.paused ? 'playing' : 'paused')
    : 'none'
  try { session.playbackState = playbackState } catch {}
}

function clearAudioMediaSession() {
  if (audioMediaSessionTimer) clearTimeout(audioMediaSessionTimer)
  audioMediaSessionTimer = null
  pendingAudioMediaSessionKey = null
  lastAudioMediaSessionKey = ''
  const session = browserMediaSession()
  if (!session) return
  try { session.playbackState = 'none' } catch {}
  try { session.metadata = null } catch {}
}

function onAudioElementPlay() {
  const pc = audioPeerConnection
  if (pc && audioWebRtcState.value !== 'connected') {
    logWebRtcDiagnostic('audio-element-play-while-not-connected', {
      appState: audioWebRtcState.value,
      readyForTx: isAudioPeerReadyForTx(),
      ...peerConnectionDiagnosticState(pc),
    })
    if (isWebRtcConnected(pc)) markWebRtcConnected(pc)
  }
  updateAudioMediaSessionPlaybackState()
}

function onAudioElementPause() {
  updateAudioMediaSessionPlaybackState()
}

function onAudioElementError() {
  const element = audioElement ?? audioPlayerRef.value
  if (!element) return
  if (audioReceiveMode.value !== 'playback') logWebRtcDiagnostic('audio-element-error', audioElementDiagnosticState(element))
  if (audioReceiveMode.value !== 'playback') return
  lastError.value = element.error?.message || 'Playback-only audio stream failed.'
  stopAudio()
}

function stopAudio() {
  if (audioReceiveMode.value !== 'playback') {
    logWebRtcDiagnostic('audio-stop', {
      hadPeerConnection: !!audioPeerConnection,
      sessionId: audioWebRtcSessionId,
      state: audioWebRtcState.value,
    })
  }
  closeWebRtcStats()
  clearWebRtcReconnectTimers()
  stopWebRtcFlowWatchdog()
  audioReceiveMode.value = 'idle'
  audioWebRtcState.value = 'idle'
  audioStreamToken++
  audioTxDesired = false
  pttIntent.value = false
  audioTxTransitionId++
  audioTxPointerId = null
  audioMicSender = null

  if (audioTxActive.value) {
    $fetch('/api/command', { method: 'POST', body: { command: 'TX0' } }).catch(() => {})
  }
  audioTxActive.value = false
  audioTxAvailable.value = false
  audioTxBusy.value = false
  releaseAudioPlaybackPrimer()

  const sessionId = audioWebRtcSessionId
  audioWebRtcSessionId = null
  if (sessionId) {
    $fetch(`/api/audio/webrtc/${sessionId}`, { method: 'DELETE' }).catch(() => {})
  }

  const pc = audioPeerConnection
  audioPeerConnection = null
  pc?.close()

  const element = audioElement ?? audioPlayerRef.value
  audioElement = null
  if (element) {
    element.pause()
    element.srcObject = null
    element.removeAttribute('src')
    element.load()
  }

  audioMicTrack?.stop()
  audioMicTrack = null
  audioMicStream?.getTracks().forEach(track => track.stop())
  audioMicStream = null
  audioMicActive.value = false
  setBrowserAudioSessionType('playback')

  const controller = audioAbortController
  audioAbortController = null
  controller?.abort()

  const reader = audioReader
  audioReader = null
  reader?.cancel().catch(() => {})

  if (audioProcessor) {
    audioProcessor.onaudioprocess = null
    audioProcessor.disconnect()
    audioProcessor = null
  }

  if (audioWorkletNode) {
    try { audioWorkletNode.port.postMessage({ type: 'clear' }) } catch {}
    try { audioWorkletNode.disconnect() } catch {}
    audioWorkletNode = null
  }

  if (audioWorkletModuleUrl) {
    URL.revokeObjectURL(audioWorkletModuleUrl)
    audioWorkletModuleUrl = null
  }

  const context = audioContext
  audioContext = null
  context?.close().catch(() => {})

  resetAudioQueue()
  audioListening.value = false
  audioBusy.value = false
  clearAudioMediaSession()
  audioBufferWaiter?.()
  audioBufferWaiter = null
}

function waitForAudioBuffer(token: number, sampleRate: number) {
  return new Promise<void>((resolve) => {
    if (token !== audioStreamToken || hasStartBuffer(sampleRate)) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      audioBufferWaiter = null
      resolve()
    }, 1200)

    audioBufferWaiter = () => {
      clearTimeout(timer)
      audioBufferWaiter = null
      resolve()
    }
  })
}

async function readAudioStream(reader: ReadableStreamDefaultReader<Uint8Array>, token: number, channelCount = 1) {
  let pending = new Uint8Array(0)
  const frameBytes = Math.max(1, channelCount) * 2

  try {
    while (token === audioStreamToken) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value?.length) continue

      let bytes = value
      if (pending.length) {
        bytes = new Uint8Array(pending.length + value.length)
        bytes.set(pending)
        bytes.set(value, pending.length)
        pending = new Uint8Array(0)
      }

      const remainder = bytes.length % frameBytes
      if (remainder !== 0) {
        pending = bytes.slice(bytes.length - remainder)
        bytes = bytes.slice(0, bytes.length - remainder)
      }

      enqueueAudioSamples(pcm16ToFloat32(bytes, channelCount))
    }
  } catch (e: any) {
    if (token === audioStreamToken && e.name !== 'AbortError') {
      lastError.value = e.message ?? 'Audio stream failed'
    }
  } finally {
    if (token === audioStreamToken) stopAudio()
  }
}

function pcm16ToFloat32(bytes: Uint8Array, channelCount = 1): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (channelCount <= 1) {
    const samples = new Float32Array(bytes.byteLength / 2)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768
    }
    return samples
  }

  const mix = currentRxAudioMix()
  const mainGain = mix.mainMuted ? 0 : mix.mainGain
  const subGain = mix.subMuted ? 0 : mix.subGain
  const frames = Math.floor(bytes.byteLength / (channelCount * 2))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const frameOffset = i * channelCount * 2
    const main = view.getInt16(frameOffset, true) / 32768
    const sub = channelCount > 1 ? view.getInt16(frameOffset + 2, true) / 32768 : 0
    samples[i] = clampFloat32(main * mainGain + sub * subGain)
  }
  return samples
}

function clampFloat32(value: number) {
  return Math.max(-1, Math.min(1, value))
}

function enqueueAudioSamples(samples: Float32Array) {
  if (samples.length === 0) return
  if (audioWorkletNode) {
    audioWorkletNode.port.postMessage({ type: 'samples', samples }, [samples.buffer])
    return
  }
  audioQueue.push(samples)
  audioQueuedSamples += samples.length
  trimAudioQueueLatency()
  updateAudioBufferedMs()
  if (audioBufferWaiter && hasStartBuffer()) audioBufferWaiter()
}

function writeAudioOutput(event: AudioProcessingEvent) {
  const output = event.outputBuffer.getChannelData(0)
  let outputOffset = 0

  if (audioRxMutedForTx.value) {
    dropAudioSamples(audioQueuedSamples)
    writeRampedSilence(output, 0)
    audioUnderflow.value = false
    updateAudioBufferedMs()
    return
  }

  if (audioRefillingBuffer && !hasStartBuffer()) {
    writeRampedSilence(output, 0)
    audioUnderflow.value = audioListening.value
    updateAudioBufferedMs()
    return
  }

  if (audioRefillingBuffer) {
    audioRefillingBuffer = false
    audioNeedsRamp = true
  }

  while (outputOffset < output.length && audioQueue.length > 0) {
    const source = audioQueue[0]
    const available = source.length - audioQueueOffset
    const count = Math.min(available, output.length - outputOffset)
    copyAudioSamples(output, outputOffset, source, audioQueueOffset, count)

    outputOffset += count
    audioQueueOffset += count
    audioQueuedSamples -= count

    if (audioQueueOffset >= source.length) {
      audioQueue.shift()
      audioQueueOffset = 0
    }
  }

  if (outputOffset < output.length) {
    writeRampedSilence(output, outputOffset)
    audioUnderflow.value = audioListening.value
    audioRefillingBuffer = true
  } else {
    audioUnderflow.value = false
  }

  updateAudioBufferedMs()
}

function trimAudioQueueLatency() {
  const sampleRate = audioContext?.sampleRate || Number(audioStatus.value?.sampleRate) || 44100
  const maxSamples = Math.round(sampleRate * AUDIO_MAX_BUFFER_SECONDS)
  const targetSamples = Math.round(sampleRate * AUDIO_TARGET_BUFFER_SECONDS)
  if (audioQueuedSamples <= maxSamples) return
  dropAudioSamples(audioQueuedSamples - targetSamples)
  audioNeedsRamp = true
}

function dropAudioSamples(count: number) {
  let remaining = count
  while (remaining > 0 && audioQueue.length > 0) {
    const source = audioQueue[0]
    const available = source.length - audioQueueOffset
    const dropped = Math.min(available, remaining)
    audioQueueOffset += dropped
    audioQueuedSamples -= dropped
    remaining -= dropped

    if (audioQueueOffset >= source.length) {
      audioQueue.shift()
      audioQueueOffset = 0
    }
  }
}

function resetAudioQueue() {
  audioQueue = []
  audioQueueOffset = 0
  audioQueuedSamples = 0
  audioLastSample = 0
  audioNeedsRamp = true
  audioRefillingBuffer = true
  audioBufferedMs.value = 0
  audioUnderflow.value = false
}

function updateAudioBufferedMs() {
  const sampleRate = audioContext?.sampleRate || Number(audioStatus.value?.sampleRate) || 44100
  audioBufferedMs.value = sampleRate > 0 ? (audioQueuedSamples / sampleRate) * 1000 : 0
}

function hasStartBuffer(sampleRate = audioContext?.sampleRate || Number(audioStatus.value?.sampleRate) || 44100) {
  return audioQueuedSamples >= Math.round(sampleRate * AUDIO_START_BUFFER_SECONDS)
}

function copyAudioSamples(output: Float32Array, outputOffset: number, source: Float32Array, sourceOffset: number, count: number) {
  let copied = 0

  if (audioNeedsRamp && count > 0) {
    const rampCount = Math.min(AUDIO_RAMP_SAMPLES, count)
    for (let i = 0; i < rampCount; i++) {
      const t = (i + 1) / rampCount
      output[outputOffset + i] = source[sourceOffset + i] * t + audioLastSample * (1 - t)
    }
    copied = rampCount
    audioNeedsRamp = false
  }

  if (copied < count) {
    output.set(source.subarray(sourceOffset + copied, sourceOffset + count), outputOffset + copied)
  }

  audioLastSample = output[outputOffset + count - 1] ?? audioLastSample
}

function writeRampedSilence(output: Float32Array, offset: number) {
  const available = output.length - offset
  if (available <= 0) return

  const rampCount = Math.min(AUDIO_RAMP_SAMPLES, available)
  for (let i = 0; i < rampCount; i++) {
    output[offset + i] = audioLastSample * (1 - ((i + 1) / rampCount))
  }

  if (offset + rampCount < output.length) {
    output.fill(0, offset + rampCount)
  }

  audioLastSample = 0
  audioNeedsRamp = true
}

async function toggleConnection() {
  if (state.value.connected) {
    connecting.value = true
    try {
      if (state.value.pseudoScanActive) await stopPseudoScan()
      stopEventSource()
      await $fetch('/api/disconnect', { method: 'POST' })
      const transport = selectedTransport.value
      applyState(defaultState())
      selectedTransport.value = transport
      await loadAudioStatus()
      void loadBtStatus()
    } catch (e: any) {
      lastError.value = e.message
    } finally {
      connecting.value = false
    }
  } else {
    connecting.value = true
    try {
      const data = await $fetch<{ ok: boolean; state: TransceiverState }>('/api/connect', {
        method: 'POST',
        body: { transport: selectedTransport.value, address: selectedRadioAddr.value },
      })
      applyState(data.state)
      localStorage.setItem('anytone_target', selectedDropdown.value)
      await loadAudioStatus()
      startEventSource()
    } catch (e: any) {
      lastError.value = e.message ?? 'Connection failed'
    } finally {
      connecting.value = false
    }
  }
}

/** One-shot status fetch — used after manual commands/presets for immediate feedback. */
async function pollStatus() {
  try {
    const data = await $fetch<TransceiverState>('/api/status')
    applyState(data)
  } catch {
    // ignore transient errors
  }
}

/**
 * Open a Server-Sent Events connection through the Nuxt server.
 * The serial server pushes state updates whenever the transceiver sends an AI response
 * or the S-meter / params polls complete — no client-side interval required.
 */
function startEventSource() {
  stopEventSource()
  const config = useRuntimeConfig()
  const es = new EventSource(withAppBase(config.public.serialEventsUrl))

  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as (TransceiverState & { _delta?: true })
      if (msg._delta) {
        // Delta frame — merge only the changed fields into the current state.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _delta, ...changes } = msg
        applySseDelta(changes as Partial<TransceiverState>)
        if (changes.connected === false) stopEventSource()
      } else {
        // Full-state frame (sent on initial connect / reconnect).
        clearPendingPseudoScanState()
        applyState(msg as TransceiverState)
        scheduleAudioMediaSessionUpdate()
        if (!msg.connected) stopEventSource()
      }
    } catch { /* malformed frame */ }
  }

  es.onerror = () => {
    // EventSource reconnects automatically; nothing to do here.
    // If the transceiver was disconnected the server will push connected:false
    // which will close the EventSource via the onmessage handler.
  }

  eventSource = es
}

function stopEventSource() {
  clearPendingPseudoScanState()
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}

async function toggleSpeechProc() {
  if (speechProcBusy.value || state.value.speechProc === null) return
  speechProcBusy.value = true
  try {
    const cmd = state.value.speechProc ? 'PR10' : 'PR11'
    const data = await $fetch<{ response: string; state: TransceiverState }>('/api/command', {
      method: 'POST',
      body: { command: cmd },
    })
    applyState(data.state)
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    speechProcBusy.value = false
  }
}

async function toggleVox() {
  if (voxBusy.value || state.value.vox === null) return
  voxBusy.value = true
  try {
    // VX P1 ; — P1: 0=OFF, 1=ON
    const cmd = state.value.vox ? 'VX0' : 'VX1'
    const data = await $fetch<{ response: string; state: TransceiverState }>('/api/command', {
      method: 'POST',
      body: { command: cmd },
    })
    applyState(data.state)
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    voxBusy.value = false
  }
}

async function togglePreAmpHf() {
  if (preAmpBusy.value || state.value.preAmpHf === null) return
  preAmpBusy.value = true
  try {
    // PA 0 P2 ; — P2: 0=IPO, 1=AMP1, 2=AMP2 (cycles 0→1→2→0)
    const next = ((state.value.preAmpHf) + 1) % 3
    await $fetch('/api/command', { method: 'POST', body: { command: `PA0${next}` } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    preAmpBusy.value = false
  }
}

async function toggleRfSql() {
  if (preAmpBusy.value || state.value.sqlRfMode === null) return
  preAmpBusy.value = true
  try {
    const next = (state.value.sqlRfMode + 1) % 3
    await $fetch('/api/command', { method: 'POST', body: { command: `EX030102${next}` } })
  } catch (e: any) { lastError.value = e.message } finally { preAmpBusy.value = false }
  try {
    await $fetch('/api/command', { method: 'POST', body: { command: `EX030102` } })
  } catch (e: any) { lastError.value = e.message } finally {  }
}

async function togglePreAmpVhf() {
  if (preAmpBusy.value || state.value.preAmpVhf === null) return
  preAmpBusy.value = true
  try {
    // PA P1 P2 ; — P1=1 (VHF), P2: 0=OFF, 1=ON
    const cmd = state.value.preAmpVhf ? 'PA10' : 'PA11'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    preAmpBusy.value = false
  }
}

async function togglePreAmpUhf() {
  if (preAmpBusy.value || state.value.preAmpUhf === null) return
  preAmpBusy.value = true
  try {
    // PA P1 P2 ; — P1=2 (UHF), P2: 0=OFF, 1=ON
    const cmd = state.value.preAmpUhf ? 'PA20' : 'PA21'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    preAmpBusy.value = false
  }
}

async function toggleAntSelect1() {
  if (antSelectBusy.value || state.value.antSelect === null) return
  antSelectBusy.value = true
  try {
    const cmd = 'EX0307040'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
    await $fetch('/api/command', { method: 'POST', body: { command: `EX030704`} })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    antSelectBusy.value = false
  }
}

async function toggleAntSelect2() {
  if (antSelectBusy.value || state.value.antSelect === null) return
  antSelectBusy.value = true
  try {
    const cmd = 'EX0307041'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
    await $fetch('/api/command', { method: 'POST', body: { command: `EX030704`} })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    antSelectBusy.value = false
  }
}

async function toggleAtt() {
  if (attBusy.value) return
  attBusy.value = true
  try {
    // RA 0 P2 ; — P2: 0=OFF, 1=ON
    const cmd = state.value.rfAttenuator ? 'RA00' : 'RA01'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    attBusy.value = false
  }
}

async function toggleLock() {
  if (lockBusy.value || state.value.lock === null) return
  lockBusy.value = true
  try {
    // LK P1 ; — P1: 0=OFF, 1=ON
    const cmd = state.value.lock ? 'LK0' : 'LK1'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    lockBusy.value = false
  }
}

// GT P1 P2 ; — P1=VFO(0/1), P2=0(OFF) 1(FAST) 2(MID) 3(SLOW) 4(AUTO-F) 5(AUTO-M) 6(AUTO-S)
const AGC_CYCLE = ['0', '1', '2', '3', '4', '5', '6'] as const
const AGC_LABEL_TO_CODE: Record<string, string> = {
  'OFF': '0', 'FAST': '1', 'MID': '2', 'SLOW': '3', 'AUTO-F': '4', 'AUTO-M': '5', 'AUTO-S': '6',
}

async function cycleAgc(vfo: '0' | '1') {
  if (agcBusy.value) return
  const current = vfo === '0' ? state.value.agcMain : state.value.agcSub
  if (current === null) return
  const code    = AGC_LABEL_TO_CODE[current] ?? '0'
  const nextCode = AGC_CYCLE[(AGC_CYCLE.indexOf(code as typeof AGC_CYCLE[number]) + 1) % AGC_CYCLE.length]
  const nextCodeToSend = (parseInt(nextCode, 10)  > 4) ? '0' : nextCode
  agcBusy.value = true
  try {
    await $fetch('/api/command', { method: 'POST', body: { command: `GT${vfo}${nextCodeToSend}` } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    agcBusy.value = false
  }
}

async function toggleNarrow(vfo: '0' | '1') {
  if (narrowBusy.value) return
  const current = vfo === '0' ? state.value.narrowMain : state.value.narrowSub
  if (current === null) return
  narrowBusy.value = true
  try {
    // NA P1 P2 ; — P1=VFO(0/1), P2=0(OFF)/1(ON)
    await $fetch('/api/command', { method: 'POST', body: { command: `NA${vfo}${current ? '0' : '1'}` } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    narrowBusy.value = false
  }
}

const SQL_TYPE_MAX = 5

async function cycleSqlType(vfo: '0' | '1', current: number | null) {
  if (sqlTypeBusy.value || current === null) return
  sqlTypeBusy.value = true
  try {
    const next = current >= SQL_TYPE_MAX ? 0 : current + 1
    // CT P1 P2 ; — P1=VFO (0/1), P2=type (0-5)
    await $fetch('/api/command', {
      method: 'POST',
      body: { command: `CT${vfo}${next}` },
    })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    sqlTypeBusy.value = false
  }
}

async function setSquelch(vfo: '0' | '1', value: number) {
  const val = Math.max(0, Math.min(255, value))
  // SQ P1 xxx ; — P1=0 main / 1 sub, xxx=000-255 (3 digits, zero-padded)
  await $fetch('/api/command', {
    method: 'POST',
    body: { command: `SQ${vfo}${String(val).padStart(3, '0')}` },
  }).catch((e: any) => { lastError.value = e.message })
}

async function setRfGain(vfo: '0' | '1', value: number) {
  const val = Math.max(0, Math.min(255, value))
  // RG P1 xxx ; — P1=0 main / 1 sub, xxx=000-255 (3 digits, zero-padded)
  await $fetch('/api/command', {
    method: 'POST',
    body: { command: `RG${vfo}${String(val).padStart(3, '0')}` },
  }).catch((e: any) => { lastError.value = e.message })
}

async function setAfGain(vfo: '0' | '1', value: number) {
  const val = Math.max(0, Math.min(255, value))
  // AG P1 xxx ; — P1=0 main / 1 sub, xxx=000-255 (3 digits, zero-padded)
  await $fetch('/api/command', {
    method: 'POST',
    body: { command: `AG${vfo}${String(val).padStart(3, '0')}` },
  }).catch((e: any) => { lastError.value = e.message })
}

async function toggleMox() {
  if (moxBusy.value) return
  moxBusy.value = true
  const nextMox = !state.value.mox
  try {
    // MX P1 ; — P1: 0=OFF, 1=ON
    const cmd = nextMox ? 'MX1' : 'MX0'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    moxBusy.value = false
  }
}

async function switchToVfo(vfo: '0' | '1') {
  if (txVfoBusy.value) return
  txVfoBusy.value = true
  try {
    await $fetch('/api/command', { method: 'POST', body: { command: `FT${vfo}` } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    txVfoBusy.value = false
  }
}

const VFO_CARD_CONTROL_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '.bw-display',
  '.freq-tuner--editable',
  '.split-freq-tuner',
  '.rx-audio-row',
  '.level-bar',
  '.rx-vfo-badge',
  '.status-section',
].join(',')

function switchToVfoFromCard(vfo: '0' | '1', event: MouseEvent) {
  if (state.value.txVfo === Number(vfo)) return

  const target = event.target instanceof Element ? event.target : null
  if (target?.closest(VFO_CARD_CONTROL_SELECTOR)) return

  void switchToVfo(vfo)
}

async function sendCommandAndSync(command: string) {
  const data = await $fetch<CommandResponse>('/api/command', { method: 'POST', body: { command } })
  if (data.state) applyState(data.state)
  return data
}

async function refreshVfoStatus(vfo: '0' | '1') {
  const queries = [`MC${vfo}`, `VM${vfo}`, vfo === '0' ? 'IF' : 'OI', 'ST', 'MZ00000']
  for (const command of queries) {
    await $fetch('/api/command', { method: 'POST', body: { command } }).catch(() => {})
    await new Promise(r => setTimeout(r, 80))
  }
  await new Promise(r => setTimeout(r, 250))
  const latest = await $fetch<TransceiverState>('/api/status')
  applyState(latest)
  updateAudioMediaSession()
}

async function restoreVfoMemorySelection(vfo: '0' | '1', mode: string | null, channel: string | null) {
  if (!mode || mode === 'VFO') return
  const modeCode = VFO_MEMORY_MODE_COMMAND_CODES[mode] ?? (channel ? '11' : null)
  if (channel) {
    await sendCommandAndSync(`MC${vfo}${channel}`)
    await new Promise(r => setTimeout(r, 150))
  }
  if (modeCode) {
    await sendCommandAndSync(`VM${vfo}${modeCode}`)
    await new Promise(r => setTimeout(r, 150))
  }
}

async function toggleRxMode() {
  if (rxModeBusy.value) return
  rxModeBusy.value = true
  try {
    // FR P1 P2 ; — P1P2: 00=Dual receive, 01=Single receive
    const toDual = state.value.rxMode !== 'dual'
    const memorySnapshot = toDual ? [
      { vfo: '0' as const, mode: state.value.mainVfoMode, channel: state.value.mainMemoryChannel },
      { vfo: '1' as const, mode: state.value.subVfoMode, channel: state.value.subMemoryChannel },
    ] : []
    if (toDual && state.value.split) {
      throw new Error('Turn split off before enabling dual receive.')
    }
    if (toDual && state.value.memorySplit) {
      for (const item of memorySnapshot) {
        if (!item.mode || item.mode === 'VFO') continue
        await sendCommandAndSync(`VM${item.vfo}00`)
        await new Promise(r => setTimeout(r, 300))
        await sendCommandAndSync(`VM${item.vfo}`)
      }
    }
    const cmd = toDual ? 'FR00' : 'FR01'
    await sendCommandAndSync(cmd)
    await new Promise(r => setTimeout(r, 500))
    await sendCommandAndSync('FR')
    for (const item of memorySnapshot) {
      await restoreVfoMemorySelection(item.vfo, item.mode, item.channel)
    }
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    rxModeBusy.value = false
  }
}

async function toggleSplit() {
  if (splitBusy.value) return
  splitBusy.value = true
  try {
    // ST P1 ; — P1: 0=OFF, 1=ON
    const cmd = state.value.split ? 'ST0' : 'ST1'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
    await new Promise(r => setTimeout(r, 1000))
    applyState(await $fetch<TransceiverState>('/api/status'))
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    splitBusy.value = false
  }
}

async function toggleSwap() {
  if (splitBusy.value) return
  splitBusy.value = true
  try {
    // ST P1 ; — P1: 0=OFF, 1=ON
    const cmd = 'SV'
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    splitBusy.value = false
  }
}

async function sendManualCommand() {
  const raw = manualCmd.value.trim()
  if (!raw || manualCommandBusy.value) return
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (!hex) return
  if (hex.length % 2 !== 0) {
    lastError.value = 'Raw HEX must contain complete bytes.'
    return
  }

  manualCommandBusy.value = true
  try {
    const data = await $fetch<RawHexResponse>('/api/raw-query', {
      method: 'POST',
      body: { hex },
    })
    manualCmd.value = data.request
    manualResponse.value = data.response || '<no response>'
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    manualCommandBusy.value = false
  }
}

// ── CTCSS tone picker modal ──────────────────────────────

const ctcssPopupVfo  = ref<'0' | '1' | null>(null)
const ctcssDialogRef = ref<HTMLElement | null>(null)

function openCtcssPopup(vfo: '0' | '1') {
  ctcssPopupVfo.value = vfo
  nextTick(() => {
    const dialog = ctcssDialogRef.value
    if (!dialog) return
    const active = dialog.querySelector<HTMLElement>('.ctcss-tone-btn--active')
    const first  = dialog.querySelector<HTMLElement>('.ctcss-tone-btn')
    ;(active ?? first)?.focus()
  })
}

function closeCtcssPopup() {
  ctcssPopupVfo.value = null
}

async function selectCtcssTone(vfo: '0' | '1', idx: number) {
  closeCtcssPopup()
  try {
    // CN P1 P2 P3P3P3 — P1=VFO(0/1), P2=0(CTCSS), P3P3P3=3-digit zero-padded index
    const cmd = `CN${vfo}0${String(idx).padStart(3, '0')}`
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  }
}

// ── DCS code picker modal ────────────────────────────────

const dcsPopupVfo  = ref<'0' | '1' | null>(null)
const dcsDialogRef = ref<HTMLElement | null>(null)

function openDcsPopup(vfo: '0' | '1') {
  dcsPopupVfo.value = vfo
  nextTick(() => {
    const dialog = dcsDialogRef.value
    if (!dialog) return
    const active = dialog.querySelector<HTMLElement>('.ctcss-tone-btn--active')
    const first  = dialog.querySelector<HTMLElement>('.ctcss-tone-btn')
    ;(active ?? first)?.focus()
  })
}

function closeDcsPopup() {
  dcsPopupVfo.value = null
}

async function selectDcsCode(vfo: '0' | '1', idx: number) {
  closeDcsPopup()
  try {
    // CN P1 P2 P3P3P3 — P1=VFO(0/1), P2=1(DCS), P3P3P3=3-digit zero-padded index
    const cmd = `CN${vfo}1${String(idx).padStart(3, '0')}`
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
  } catch (e: any) {
    lastError.value = e.message
  }
}

// ── Saved channels ──────────────────────────────────────

const radioMemoryWriteUsesCtcss = computed(() => [1, 2, 4, 5].includes(Number(radioMemoryWriteForm.value.sqlType)))
const radioMemoryWriteUsesDcs = computed(() => Number(radioMemoryWriteForm.value.sqlType) === 3)

const radioMemoryOverwriteLabel = computed(() => {
  const channel = memoryChannelFromNumber(radioMemoryWriteForm.value.channel)
  if (!channel) return null
  const existing = state.value.radioMemories.find(memory => memory.channel === channel)
  return existing ? `Slot ${channel} currently contains ${radioMemoryTitle(existing)}. Saving will overwrite it.` : `Suggested free slot ${channel}.`
})

function memoryChannelFromNumber(value: number | string): string | null {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 99) return null
  return String(numeric).padStart(5, '0')
}

function suggestRadioMemorySlot(): number {
  const used = new Set(
    state.value.radioMemories
      .map(memory => /^00\d{3}$/.test(memory.channel) ? Number(memory.channel) : null)
      .filter((channel): channel is number => channel !== null && channel >= 1 && channel <= 99),
  )
  for (let channel = 1; channel <= 99; channel += 1) {
    if (!used.has(channel)) return channel
  }
  return 99
}

function radioMemoryWriteClickable(vfo: '0' | '1'): boolean {
  const freq = vfo === '0' ? state.value.mainFreq : state.value.subFreq
  return Boolean(
    state.value.connected &&
    freq !== null &&
    !radioMemoryWriteBusy.value &&
    !radioTxActive.value &&
    !state.value.pseudoScanActive &&
    !state.value.radioMemoryScanActive,
  )
}

function openRadioMemoryWriter(vfo: '0' | '1') {
  if (!radioMemoryWriteClickable(vfo)) {
    if (radioTxActive.value) lastError.value = 'Cannot write memory while transmitting'
    else if (state.value.pseudoScanActive) lastError.value = 'Stop pseudo scan before writing a memory'
    else if (state.value.radioMemoryScanActive) lastError.value = 'Wait for memory scan to finish before writing a memory'
    return
  }

  const freq = vfo === '0' ? state.value.mainFreq : state.value.subFreq
  if (freq == null) return
  const activeMemory = activeMemoryForVfo(vfo)
  const memorySplitFreq = activeMemory?.splitFreq ?? null
  const vfoSplitFreq = activeVfo.value === vfo && state.value.vfoSplit ? state.value.vfoSplitFreq : null
  const splitFreq = memorySplitFreq ?? vfoSplitFreq
  const sqlType = vfoSqlType(vfo) ?? 0

  radioMemoryWriteForm.value = {
    channel: suggestRadioMemorySlot(),
    tag: (vfo === '0' ? state.value.mainMemoryTag : state.value.subMemoryTag) ?? '',
    freqInput: frequencyInputValue(freq),
    mode: vfoMode(vfo) ?? 'FM',
    split: splitFreq != null,
    splitFreqInput: frequencyInputValue(splitFreq ?? freq),
    sqlType,
    ctcssTone: vfoCtcssTone(vfo) ?? 0,
    dcsCode: vfoDcsCode(vfo) ?? 0,
  }
  radioMemoryWriteVfo.value = vfo
}

function closeRadioMemoryWriter() {
  if (radioMemoryWriteBusy.value) return
  radioMemoryWriteVfo.value = null
}

async function saveRadioMemory() {
  const vfo = radioMemoryWriteVfo.value
  if (!vfo || radioMemoryWriteBusy.value) return
  if (radioTxActive.value) {
    lastError.value = 'Cannot write memory while transmitting'
    return
  }
  if (state.value.pseudoScanActive) {
    lastError.value = 'Stop pseudo scan before writing a memory'
    return
  }
  if (state.value.radioMemoryScanActive) {
    lastError.value = 'Wait for memory scan to finish before writing a memory'
    return
  }

  const form = radioMemoryWriteForm.value
  const channel = memoryChannelFromNumber(form.channel)
  if (!channel) {
    lastError.value = 'Choose a memory slot from 1 to 99'
    return
  }
  const freq = parseFrequencyInput(form.freqInput)
  if (freq == null || freq < TX_FREQ_MIN || freq > TX_FREQ_MAX) {
    lastError.value = 'Enter a valid RX frequency in MHz'
    return
  }
  const mode = MODES.some(item => item.label === form.mode) ? form.mode : null
  if (!mode) {
    lastError.value = 'Choose a valid mode'
    return
  }
  const splitFreq = form.split ? parseFrequencyInput(form.splitFreqInput) : null
  if (form.split && (splitFreq == null || splitFreq < TX_FREQ_MIN || splitFreq > TX_FREQ_MAX)) {
    lastError.value = 'Enter a valid TX frequency in MHz'
    return
  }

  const sqlType = Number(form.sqlType)
  const payload: Record<string, unknown> = {
    vfo,
    channel,
    tag: form.tag,
    freq,
    mode,
    sqlType,
    splitFreq,
  }
  if ([1, 2, 4, 5].includes(sqlType)) payload.ctcssTone = Number(form.ctcssTone)
  if (sqlType === 3) payload.dcsCode = Number(form.dcsCode)

  radioMemoryWriteBusy.value = true
  try {
    const data = await $fetch<CommandResponse>('/api/memory-write', { method: 'POST', body: payload })
    if (data.state) applyState(data.state)
    radioMemoryWriteVfo.value = null
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    radioMemoryWriteBusy.value = false
  }
}

function saveChannelFromVfo(vfo: '0' | '1') {
  const freq     = vfo === '0' ? state.value.mainFreq    : state.value.subFreq
  const mode     = vfo === '0' ? state.value.mainMode    : state.value.subMode
  const sqlType  = vfo === '0' ? state.value.mainSqlType : state.value.subSqlType
  const ctcssIdx = vfo === '0' ? state.value.mainCtcssTone : state.value.subCtcssTone
  const dcsIdx   = vfo === '0' ? state.value.mainDcsCode   : state.value.subDcsCode
  if (freq == null) return
  savedChannels.value = [
    ...savedChannels.value,
    { id: Date.now().toString(), freq, mode: mode ?? null, sqlType: sqlType ?? null, ctcssIdx: ctcssIdx ?? null, dcsIdx: dcsIdx ?? null },
  ]
  persistChannels()
}

async function applyChannel(ch: ChannelConfig) {
  const vfo = activeVfo.value
  const cmds: string[] = []
  cmds.push((vfo === '0' ? 'FA' : 'FB') + String(ch.freq).padStart(9, '0'))
  if (ch.mode) {
    const entry = MODES.find(m => m.label === ch.mode)
    if (entry) {
      cmds.push(`MD${vfo}${entry.code}`)
    }
  }
  if (ch.sqlType !== null) cmds.push(`CT${vfo}${ch.sqlType}`)
  if (ch.ctcssIdx !== null) cmds.push(`CN${vfo}0${String(ch.ctcssIdx).padStart(3, '0')}`)
  if (ch.dcsIdx !== null)   cmds.push(`CN${vfo}1${String(ch.dcsIdx).padStart(3, '0')}`)
  for (const cmd of cmds) {
    await $fetch('/api/command', { method: 'POST', body: { command: cmd } })
      .catch((e: any) => { lastError.value = e.message })
  }
}

function deleteChannel(id: string) {
  savedChannels.value = savedChannels.value.filter(c => c.id !== id)
  persistChannels()
}

const sortedChannels = computed(() =>
  [...savedChannels.value].sort((a, b) => a.freq - b.freq)
)

const sortedRadioMemories = computed(() =>
  [...(state.value.radioMemories ?? [])].sort((a, b) => radioMemorySortKey(a.channel) - radioMemorySortKey(b.channel))
)

const pseudoScanActive = computed(() => state.value.pseudoScanActive)

const pseudoScanUsesActiveVfo = computed(() =>
  state.value.pseudoScanActive && state.value.pseudoScanVfo === activeVfo.value
)

const serverPseudoScanChannels = computed(() => state.value.pseudoScanChannels ?? [])

const pseudoScanChannels = computed(() =>
  state.value.pseudoScanActive && serverPseudoScanChannels.value.length > 0
    ? serverPseudoScanChannels.value
    : pseudoScanSelectedChannels.value
)

const pseudoScanMemories = computed(() =>
  sortedRadioMemories.value.filter(memory => pseudoScanChannels.value.includes(memory.channel))
)

const pseudoScanSelectedCount = computed(() => pseudoScanChannels.value.length)

const canSaveScanGroup = computed(() => !pseudoScanActive.value && pseudoScanSelectedChannels.value.length > 0)

const pseudoScanCurrentMemory = computed(() => {
  const channel = state.value.pseudoScanCurrentChannel
  if (channel) return sortedRadioMemories.value.find(memory => memory.channel === channel) ?? null
  return pseudoScanMemories.value[state.value.pseudoScanIndex] ?? null
})

const pseudoScanTargetLabel = computed(() => {
  const vfo = state.value.pseudoScanActive ? state.value.pseudoScanVfo ?? pseudoScanTargetVfo.value : pseudoScanTargetVfo.value
  return vfo === '1' ? 'SUB' : 'MAIN'
})

const pseudoScanStartBlockedByTx = computed(() => pseudoScanTxBlocks())

const canStartPseudoScan = computed(() =>
  state.value.connected && !pseudoScanStartBlockedByTx.value && !state.value.pseudoScanActive && pseudoScanSelectedChannels.value.length > 0
)

const pseudoScanStatusRaw = computed(() => {
  if (!state.value.pseudoScanActive) {
    if (state.value.pseudoScanError) return state.value.pseudoScanError
    if (pseudoScanSelectedCount.value === 0) return 'Select memories to build a scan group.'
    if (pseudoScanStartBlockedByTx.value) return 'Radio is transmitting; scan can start when TX clears.'
    return `${pseudoScanSelectedCount.value} memories selected for ${pseudoScanTargetLabel.value}.`
  }

  const memory = pseudoScanCurrentMemory.value
  const channel = state.value.pseudoScanCurrentChannel
  const meter = state.value.pseudoScanLastMeter
  const squelch = state.value.pseudoScanLastSquelch
  const signal = meter == null || squelch == null ? 'signal --' : `signal ${meter}/${squelch}`
  const prefix = state.value.pseudoScanPauseReason === 'tx'
    ? 'Paused for TX'
    : state.value.pseudoScanPauseReason === 'signal'
      ? 'Paused on signal'
      : state.value.pseudoScanBusy
        ? 'Tuning'
        : 'Scanning'
  return [prefix, pseudoScanTargetLabel.value, memory ? radioMemoryLabel(memory) : channel ? `MEM ${channel}` : null, signal].filter(Boolean).join(' · ')
})

const pseudoScanStatus = ref('')

function setPseudoScanStatus(status: string) {
  pseudoScanStatus.value = status
  pseudoScanStatusLastUpdate = Date.now()
}

function clearPendingPseudoScanStatus() {
  if (pseudoScanStatusTimer) clearTimeout(pseudoScanStatusTimer)
  pseudoScanStatusTimer = null
  pendingPseudoScanStatus = null
}

function schedulePseudoScanStatus(status: string) {
  if (!state.value.pseudoScanActive) {
    clearPendingPseudoScanStatus()
    setPseudoScanStatus(status)
    return
  }

  const elapsed = Date.now() - pseudoScanStatusLastUpdate
  if (!pseudoScanStatusTimer && elapsed >= PSEUDO_SCAN_STATUS_UPDATE_MS) {
    pendingPseudoScanStatus = null
    setPseudoScanStatus(status)
    return
  }

  pendingPseudoScanStatus = status
  if (pseudoScanStatusTimer) return
  pseudoScanStatusTimer = setTimeout(() => {
    pseudoScanStatusTimer = null
    const next = pendingPseudoScanStatus
    pendingPseudoScanStatus = null
    if (next !== null) setPseudoScanStatus(next)
  }, Math.max(0, PSEUDO_SCAN_STATUS_UPDATE_MS - elapsed))
}

watch(pseudoScanStatusRaw, schedulePseudoScanStatus, { immediate: true })

const channelsPanelCount = computed(() => sortedChannels.value.length + sortedRadioMemories.value.length)

const recordingEnabled = computed(() => recordingStatus.value?.settings.enabled === true)
const recordingWindowStart = computed(() => {
  const range = recordingRangeHours.value * 60 * 60 * 1000
  return recordingWindowEnd.value - range * (1 - RECORDING_FUTURE_PADDING)
})
const recordingTimelineStyle = computed(() => ({ width: '100%' }))
const recordingMinDurationLabel = computed(() => {
  const seconds = Math.max(0, Math.round(recordingMinDurationSeconds.value))
  return seconds === 0 ? 'Any' : `${seconds}s+`
})
const recordingTailSkipLabel = computed(() => {
  const seconds = Math.max(0, Number(recordingTailSkipSeconds.value) || 0)
  return seconds === 0 ? 'Off' : `${seconds.toFixed(seconds % 1 === 0 ? 0 : 2)}s`
})

const recordingChannelOptions = computed<RecordingLane[]>(() => {
  const lanes = new Map<string, RecordingLane>()
  for (const clip of recordings.value) {
    if (!lanes.has(clip.laneKey)) lanes.set(clip.laneKey, { key: clip.laneKey, label: clip.laneLabel, clips: [] })
  }
  return [...lanes.values()].sort((a, b) => a.label.localeCompare(b.label))
})

const filteredRecordingClips = computed(() => {
  const from = recordingWindowStart.value
  const to = recordingDisplayEnd.value
  const minDurationMs = Math.max(0, Math.round(recordingMinDurationSeconds.value)) * 1000
  return recordings.value.filter(clip => {
    const clipEnd = clip.endedAt ?? Date.now()
    if (clip.startedAt > to || clipEnd < from) return false
    if (minDurationMs > 0 && recordingClipDurationMs(clip) < minDurationMs) return false
    return recordingChannelFilter.value === 'all' || clip.laneKey === recordingChannelFilter.value
  })
})

const recordingLanes = computed<RecordingLane[]>(() => {
  const lanes = new Map<string, RecordingLane>()
  for (const clip of filteredRecordingClips.value) {
    const lane = lanes.get(clip.laneKey) ?? { key: clip.laneKey, label: clip.laneLabel, clips: [] }
    lane.clips.push(clip)
    lanes.set(clip.laneKey, lane)
  }
  return [...lanes.values()].sort((a, b) => a.label.localeCompare(b.label))
})

const selectedRecording = computed(() => filteredRecordingClips.value.find(clip => clip.id === selectedRecordingId.value) ?? null)
const selectedRecordingAudioUrl = computed(() => selectedRecording.value ? withAppBase(`/api/recordings/${encodeURIComponent(selectedRecording.value.id)}`) : '')
const recordingPlayableClips = computed(() => filteredRecordingClips.value
  .filter(clip => clip.endedAt !== null && (clip.durationMs ?? 0) > 0 && (clip.bytes ?? 0) > 0)
  .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)))
const recordingPlaybackClip = computed(() => recordings.value.find(clip => clip.id === recordingPlaybackClipId.value) ?? null)
const recordingPlaybackCanPlay = computed(() => recordingPlayableClips.value.length > 0 && !recordingPlaybackLoading.value)
const recordingPlayheadVisible = computed(() => recordingPlayheadTime.value >= recordingWindowStart.value && recordingPlayheadTime.value <= recordingDisplayEnd.value)
const recordingPlayheadLeft = computed(() => {
  const span = Math.max(1, recordingDisplayEnd.value - recordingWindowStart.value)
  return Math.max(0, Math.min(100, ((recordingPlayheadTime.value - recordingWindowStart.value) / span) * 100))
})
const recordingPlaybackStatus = computed(() => {
  const clip = recordingPlaybackClip.value
  const time = formatRecordingDateTime(recordingPlayheadTime.value)
  if (recordingPlaybackLoading.value) return 'Loading...'
  if (recordingPlaybackPlaying.value && clip) return `Playing ${clip.laneLabel} @ ${time}`
  return `Cursor ${time}`
})

const recordingTimelineTicks = computed(() => {
  const ticks: { time: number; left: number; label: string }[] = []
  const count = recordingRangeHours.value >= 24 ? 9 : recordingRangeHours.value >= 6 ? 7 : 5
  const span = recordingDisplayEnd.value - recordingWindowStart.value
  for (let idx = 0; idx < count; idx += 1) {
    const left = (idx / (count - 1)) * 100
    const time = recordingWindowStart.value + span * (left / 100)
    ticks.push({ time, left, label: formatRecordingTick(time) })
  }
  return ticks
})

async function loadRecordingStatus() {
  try {
    recordingStatus.value = await $fetch<RecordingStatus>('/api/recordings/status')
  } catch (e: any) {
    lastError.value = e.message
  }
}

async function loadRecordings() {
  try {
    const data = await $fetch<{ clips: RecordingClip[]; status: RecordingStatus }>('/api/recordings', {
      query: { from: recordingWindowStart.value, to: recordingWindowEnd.value },
    })
    recordings.value = data.clips
    recordingStatus.value = data.status
    if (selectedRecordingId.value && !recordings.value.some(clip => clip.id === selectedRecordingId.value)) selectedRecordingId.value = null
    if (recordingPlaybackClipId.value && !recordings.value.some(clip => clip.id === recordingPlaybackClipId.value)) stopRecordingPlayback()
  } catch (e: any) {
    lastError.value = e.message
  }
}

async function refreshRecordings() {
  await Promise.all([loadRecordingStatus(), loadRecordings()])
}

async function toggleRecordingEnabled() {
  if (recordingBusy.value) return
  recordingBusy.value = true
  try {
    recordingStatus.value = await $fetch<RecordingStatus>('/api/recordings/status', {
      method: 'POST',
      body: { enabled: !recordingEnabled.value },
    })
    await loadRecordings()
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    recordingBusy.value = false
  }
}

function shiftRecordingWindow(direction: -1 | 1) {
  const shiftMs = recordingRangeHours.value * 60 * 60 * 1000 * 0.5
  recordingWindowEnd.value += direction * shiftMs
  void loadRecordings()
}

function setRecordingWindowNow() {
  recordingWindowEnd.value = Date.now()
  void loadRecordings()
}

function selectRecording(clip: RecordingClip) {
  selectedRecordingId.value = clip.id
  recordingPlayheadTime.value = clip.startedAt
  if (recordingPlaybackPlaying.value) void playRecordingClip(clip, clip.startedAt)
}

function recordingAudioUrlForClip(clip: RecordingClip) {
  // Must be app-base-prefixed: a raw <audio>.src bypasses Nuxt's base-aware
  // $fetch, so under /anytone/ a bare path is routed by nginx to the wrong app
  // (the catch-all :3000) and 404s — which silently broke transport Play/Next.
  return withAppBase(`/api/recordings/${encodeURIComponent(clip.id)}`)
}

function recordingClipEndTime(clip: RecordingClip) {
  return clip.endedAt ?? clip.startedAt + (clip.durationMs ?? 0)
}

function recordingClipDurationMs(clip: RecordingClip) {
  if (typeof clip.durationMs === 'number' && Number.isFinite(clip.durationMs)) return Math.max(0, clip.durationMs)
  return Math.max(0, (clip.endedAt ?? Date.now()) - clip.startedAt)
}

function findRecordingClipAtOrAfter(time: number) {
  const from = Math.max(time, recordingWindowStart.value)
  return recordingPlayableClips.value.find(clip => clip.startedAt <= from && recordingClipEndTime(clip) > from)
    ?? recordingPlayableClips.value.find(clip => clip.startedAt >= from)
    ?? null
}

async function toggleRecordingPlayback() {
  if (recordingPlaybackPlaying.value) {
    pauseRecordingPlayback()
    return
  }
  await startRecordingPlaybackAtPlayhead()
}

async function startRecordingPlaybackAtPlayhead() {
  const clip = findRecordingClipAtOrAfter(recordingPlayheadTime.value)
  if (!clip) {
    stopRecordingPlayback(false)
    return
  }
  await playRecordingClip(clip, Math.max(recordingPlayheadTime.value, clip.startedAt))
}

async function playNextRecordingClip() {
  const current = recordingPlaybackClip.value
  const nextStart = current ? recordingClipEndTime(current) + 1 : recordingPlayheadTime.value + 1
  recordingPlayheadTime.value = nextStart
  const next = findRecordingClipAtOrAfter(nextStart)
  if (!next) {
    stopRecordingPlayback(false)
    return
  }
  await playRecordingClip(next, Math.max(nextStart, next.startedAt))
}

async function playRecordingClip(clip: RecordingClip, startTime: number) {
  const audio = recordingPlaybackAudioRef.value
  if (!audio) return

  const token = ++recordingPlaybackToken
  recordingTailSkipPending = false
  recordingInspectorAudioRef.value?.pause()
  const clipEnd = recordingClipEndTime(clip)
  const clipDurationSeconds = Math.max(0, (clipEnd - clip.startedAt) / 1000)
  const offsetSeconds = Math.max(0, Math.min(clipDurationSeconds, (startTime - clip.startedAt) / 1000))
  recordingPlaybackLoading.value = true
  recordingPlaybackClipId.value = clip.id
  selectedRecordingId.value = clip.id
  recordingPlayheadTime.value = clip.startedAt + offsetSeconds * 1000

  try {
    audio.pause()
    audio.src = recordingAudioUrlForClip(clip)
    audio.load()
    await waitForRecordingAudioMetadata(audio)
    if (token !== recordingPlaybackToken) return
    try {
      const safeDuration = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.05) : offsetSeconds
      audio.currentTime = Math.min(offsetSeconds, safeDuration)
    } catch { /* currentTime can reject before metadata on some browsers */ }
    await audio.play()
    if (token !== recordingPlaybackToken) return
    recordingPlaybackPlaying.value = true
    startRecordingPlaybackMonitor()
  } catch (e: any) {
    if (token === recordingPlaybackToken) {
      recordingPlaybackPlaying.value = false
      recordingPlaybackClipId.value = null
      lastError.value = e?.message ?? 'Recording playback failed'
    }
  } finally {
    if (token === recordingPlaybackToken) recordingPlaybackLoading.value = false
  }
}

function waitForRecordingAudioMetadata(audio: HTMLAudioElement) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      audio.removeEventListener('loadedmetadata', done)
      audio.removeEventListener('canplay', done)
      audio.removeEventListener('error', fail)
    }
    const done = () => {
      cleanup()
      resolve()
    }
    const fail = () => {
      cleanup()
      reject(new Error('Recording audio failed to load'))
    }
    const timer = setTimeout(done, 1500)
    audio.addEventListener('loadedmetadata', done)
    audio.addEventListener('canplay', done)
    audio.addEventListener('error', fail)
  })
}

function pauseRecordingPlayback() {
  recordingPlaybackToken++
  recordingTailSkipPending = false
  stopRecordingPlaybackMonitor()
  recordingPlaybackAudioRef.value?.pause()
  recordingPlaybackPlaying.value = false
  recordingPlaybackLoading.value = false
}

function stopRecordingPlayback(clearClip = true) {
  pauseRecordingPlayback()
  if (clearClip) recordingPlaybackClipId.value = null
}

function onRecordingPlaybackTimeUpdate() {
  updateRecordingPlaybackProgress()
}

function updateRecordingPlaybackProgress() {
  const audio = recordingPlaybackAudioRef.value
  const clip = recordingPlaybackClip.value
  if (!audio || !clip) return
  recordingPlayheadTime.value = clip.startedAt + audio.currentTime * 1000
  maybeSkipRecordingTail(audio, clip)
}

function startRecordingPlaybackMonitor() {
  stopRecordingPlaybackMonitor()
  recordingPlaybackMonitorTimer = setInterval(updateRecordingPlaybackProgress, 100)
}

function stopRecordingPlaybackMonitor() {
  if (!recordingPlaybackMonitorTimer) return
  clearInterval(recordingPlaybackMonitorTimer)
  recordingPlaybackMonitorTimer = null
}

function maybeSkipRecordingTail(audio: HTMLAudioElement, clip: RecordingClip) {
  const skipSeconds = Math.max(0, Number(recordingTailSkipSeconds.value) || 0)
  if (skipSeconds <= 0 || recordingTailSkipPending || recordingPlaybackLoading.value || !recordingPlaybackPlaying.value) return
  const endSeconds = recordingPlaybackEndSeconds(audio, clip)
  if (endSeconds <= 0 || audio.currentTime < Math.max(0, endSeconds - skipSeconds)) return

  recordingTailSkipPending = true
  void playNextRecordingClip().finally(() => {
    recordingTailSkipPending = false
  })
}

function recordingPlaybackEndSeconds(audio: HTMLAudioElement, clip: RecordingClip) {
  const clipSeconds = recordingClipDurationMs(clip) / 1000
  return Number.isFinite(audio.duration) && audio.duration > 0
    ? Math.max(audio.duration, clipSeconds)
    : clipSeconds
}

function onRecordingInspectorPlay() {
  if (recordingPlaybackPlaying.value || recordingPlaybackLoading.value) stopRecordingPlayback()
  recordingInspectorTailSkipPending = false
}

function onRecordingInspectorTimeUpdate() {
  const audio = recordingInspectorAudioRef.value
  const clip = selectedRecording.value
  if (!audio || !clip) return
  recordingPlayheadTime.value = clip.startedAt + audio.currentTime * 1000
  maybeSkipRecordingInspectorTail(audio, clip)
}

function maybeSkipRecordingInspectorTail(audio: HTMLAudioElement, clip: RecordingClip) {
  const skipSeconds = Math.max(0, Number(recordingTailSkipSeconds.value) || 0)
  if (skipSeconds <= 0 || recordingInspectorTailSkipPending || audio.paused) return
  const endSeconds = recordingPlaybackEndSeconds(audio, clip)
  if (endSeconds <= 0 || audio.currentTime < Math.max(0, endSeconds - skipSeconds)) return

  recordingInspectorTailSkipPending = true
  void playNextRecordingInspectorClip().finally(() => {
    recordingInspectorTailSkipPending = false
  })
}

async function playNextRecordingInspectorClip() {
  const current = selectedRecording.value
  const audio = recordingInspectorAudioRef.value
  if (!current || !audio) return

  const nextStart = recordingClipEndTime(current) + 1
  recordingPlayheadTime.value = nextStart
  const next = findRecordingClipAtOrAfter(nextStart)
  if (!next) {
    audio.pause()
    return
  }

  selectedRecordingId.value = next.id
  recordingPlayheadTime.value = next.startedAt
  await nextTick()

  const nextAudio = recordingInspectorAudioRef.value
  if (!nextAudio) return
  try {
    nextAudio.pause()
    nextAudio.load()
    await waitForRecordingAudioMetadata(nextAudio)
    nextAudio.currentTime = 0
    await nextAudio.play()
  } catch (e: any) {
    lastError.value = e?.message ?? 'Recording playback failed'
  }
}

function onRecordingInspectorEnded() {
  if (Math.max(0, Number(recordingTailSkipSeconds.value) || 0) > 0) void playNextRecordingInspectorClip()
}

function onRecordingPlaybackEnded() {
  const clip = recordingPlaybackClip.value
  if (clip) recordingPlayheadTime.value = recordingClipEndTime(clip)
  void playNextRecordingClip()
}

async function deleteRecordingClip(id: string) {
  if (!window.confirm('Delete this recording?')) return
  if (recordingPlaybackClipId.value === id) stopRecordingPlayback()
  try {
    const data = await $fetch<{ clips: RecordingClip[]; status: RecordingStatus }>(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' })
    recordings.value = data.clips
    recordingStatus.value = data.status
    if (selectedRecordingId.value === id) selectedRecordingId.value = null
  } catch (e: any) {
    lastError.value = e.message
  }
}

function recordingBlockStyle(clip: RecordingClip) {
  const span = Math.max(1, recordingDisplayEnd.value - recordingWindowStart.value)
  const start = Math.max(clip.startedAt, recordingWindowStart.value)
  const end = Math.min(clip.endedAt ?? Date.now(), recordingDisplayEnd.value)
  const left = ((start - recordingWindowStart.value) / span) * 100
  const width = Math.max(0.7, ((end - start) / span) * 100)
  return { left: `${left}%`, width: `${width}%` }
}

function recordingBlockLabel(clip: RecordingClip): string {
  const duration = formatRecordingDuration(clip.durationMs)
  const label = duration === '--' ? 'live' : duration
  return clip.kind === 'tx' ? `TX ${label}` : label
}

function recordingClipTitle(clip: RecordingClip): string {
  return [
    clip.laneLabel,
    clip.kind === 'tx' ? 'TX' : null,
    formatRecordingDateTime(clip.startedAt),
    formatRecordingDuration(clip.durationMs),
    clip.scanGroupNames.join(', '),
  ].filter(Boolean).join(' · ')
}

function formatRecordingDateTime(value: number): string {
  return new Date(value).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatRecordingTick(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatRecordingDuration(value: number | null): string {
  if (value == null) return '--'
  const seconds = Math.max(1, Math.round(value / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${seconds}s`
}

function formatRecordingFreq(freq: number): string {
  return `${(freq / 1_000_000).toFixed(3)} MHz`
}

function radioMemorySortKey(channel: string): number {
  if (/^00\d{3}$/.test(channel)) return Number(channel)
  const pms = /^P-(\d{2})([LU])$/.exec(channel)
  if (pms) return 1000 + Number(pms[1]) * 2 + (pms[2] === 'U' ? 1 : 0)
  if (/^500\d{2}$/.test(channel)) return 2000 + Number(channel.substring(3))
  if (channel === 'EMGCH') return 3000
  return 9000
}

function chLabel(ch: ChannelConfig): string {
  const mhz = (ch.freq / 1_000_000).toFixed(3)
  return `${mhz}${ch.mode ? ' ' + ch.mode : ''}`
}

function chSqlLabel(ch: ChannelConfig): string | null {
  if (!ch.sqlType) return null
  if (ch.sqlType === 1 || ch.sqlType === 2) {
    const hz = ch.ctcssIdx !== null ? CTCSS_TONES[ch.ctcssIdx]?.toFixed(1) : null
    return hz ? `${sqlTypeLabel(ch.sqlType)} ${hz}Hz` : sqlTypeLabel(ch.sqlType)
  }
  if (ch.sqlType === 3) {
    const code = ch.dcsIdx !== null ? DCS_CODES[ch.dcsIdx] : null
    return code != null ? `DCS D${String(code).padStart(3, '0')}` : 'DCS'
  }
  return sqlTypeLabel(ch.sqlType)
}

function radioMemoryLabel(mem: RadioMemory): string {
  const freq = mem.freq ? (mem.freq / 1_000_000).toFixed(3) : null
  return [`MEM ${mem.channel}`, freq, mem.mode].filter(Boolean).join(' ')
}

function radioMemoryTitle(mem: RadioMemory): string {
  return [radioMemoryLabel(mem), mem.tag].filter(Boolean).join(' · ')
}

function isActiveRadioMemory(mem: RadioMemory): boolean {
  const channel = activeVfo.value === '0' ? state.value.mainMemoryChannel : state.value.subMemoryChannel
  return channel === mem.channel && isMemoryLikeVfoMode(activeVfoMode.value)
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function vfoMemoryMode(vfo: '0' | '1'): string | null {
  return vfo === '0' ? state.value.mainVfoMode : state.value.subVfoMode
}

function vfoMemoryModeButtonLabel(vfo: '0' | '1'): string {
  const mode = vfoMemoryMode(vfo)
  return isMemoryLikeVfoMode(mode) ? 'MEM' : isVfoLikeMode(mode) ? 'VFO' : '--'
}

function vfoMemoryModeTitle(vfo: '0' | '1'): string {
  const label = vfo === '0' ? 'MAIN' : 'SUB'
  const mode = vfoMemoryMode(vfo)
  return isMemoryLikeVfoMode(mode)
    ? `Switch ${label} to VFO mode`
    : `Switch ${label} to memory mode`
}

async function toggleVfoMemoryMode(vfo: '0' | '1') {
  if (vfoMemoryModeBusy.value) return
  if (!state.value.connected) {
    lastError.value = 'Connect to the radio before changing VFO/memory mode'
    return
  }
  if (radioTxActive.value) {
    lastError.value = 'Cannot change VFO/memory mode while transmitting'
    return
  }
  if (state.value.pseudoScanActive) {
    lastError.value = 'Stop pseudo scan before changing VFO/memory mode'
    return
  }
  if (state.value.radioMemoryScanActive) {
    lastError.value = 'Wait for memory scan to finish before changing VFO/memory mode'
    return
  }
  vfoMemoryModeBusy.value = vfo
  try {
    const nextCommand = isMemoryLikeVfoMode(vfoMemoryMode(vfo)) ? `VM${vfo}00` : `VM${vfo}11`
    const data = await $fetch<CommandResponse>('/api/command', { method: 'POST', body: { command: nextCommand } })
    if (data.state) applyState(data.state)
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    vfoMemoryModeBusy.value = null
  }
}

function pseudoScanTxBlocks(): boolean {
  return radioTxActive.value
}

async function applyRadioMemoryToVfo(mem: RadioMemory, vfo: '0' | '1') {
  const needsMemoryMode = !isMemoryLikeVfoMode(vfoMemoryMode(vfo))
  await $fetch('/api/command', { method: 'POST', body: { command: `MC${vfo}${mem.channel}` } })
  if (needsMemoryMode) {
    await waitMs(200)
    await $fetch('/api/command', { method: 'POST', body: { command: `VM${vfo}11` } })
  }
}

function isPseudoScanMemorySelected(channel: string): boolean {
  return pseudoScanChannels.value.includes(channel)
}

function togglePseudoScanMemory(channel: string, selected: boolean) {
  if (pseudoScanActive.value) return
  const current = pseudoScanSelectedChannels.value
  pseudoScanSelectedChannels.value = selected
    ? current.includes(channel) ? current : [...current, channel]
    : current.filter(item => item !== channel)
}

function togglePseudoScanMemoryFromEvent(channel: string, event: Event) {
  const input = event.target instanceof HTMLInputElement ? event.target : null
  togglePseudoScanMemory(channel, input?.checked === true)
}

function selectedPseudoScanChannelsInMemoryOrder(): string[] {
  const selected = new Set(pseudoScanSelectedChannels.value)
  return sortedRadioMemories.value.map(memory => memory.channel).filter(channel => selected.has(channel))
}

function availableScanGroupChannels(group: ScanGroup): string[] {
  const available = new Set(sortedRadioMemories.value.map(memory => memory.channel))
  return group.channels.filter(channel => available.has(channel))
}

function scanGroupAvailableCount(group: ScanGroup): number {
  return availableScanGroupChannels(group).length
}

function scanGroupTitle(group: ScanGroup): string {
  const availableCount = scanGroupAvailableCount(group)
  return `${group.name}: ${availableCount}/${group.channels.length} memories available`
}

function isScanGroupSelected(group: ScanGroup): boolean {
  const channels = availableScanGroupChannels(group)
  if (channels.length === 0 || channels.length !== pseudoScanSelectedChannels.value.length) return false
  const selected = new Set(pseudoScanSelectedChannels.value)
  return channels.every(channel => selected.has(channel))
}

async function saveScanGroupFromSelection() {
  if (!canSaveScanGroup.value) return
  const channels = selectedPseudoScanChannelsInMemoryOrder()
  if (channels.length === 0) {
    lastError.value = 'Select radio memories before saving a scan group.'
    return
  }

  const name = window.prompt('Scan group name', `Group ${scanGroups.value.length + 1}`)?.trim()
  if (!name) return

  const existingIdx = scanGroups.value.findIndex(group => group.name.toLowerCase() === name.toLowerCase())
  const group: ScanGroup = existingIdx >= 0
    ? { ...scanGroups.value[existingIdx], name, channels }
    : { id: Date.now().toString(), name, channels, createdAt: Date.now() }
  try {
    const data = await $fetch<{ groups: ScanGroup[] }>('/api/scan-groups', { method: 'POST', body: group })
    scanGroups.value = data.groups
  } catch (e: any) {
    lastError.value = e.message
  }
}

function applyScanGroup(group: ScanGroup) {
  if (pseudoScanActive.value) return
  const channels = availableScanGroupChannels(group)
  if (channels.length === 0) {
    lastError.value = `No available memories in scan group ${group.name}.`
    return
  }
  pseudoScanSelectedChannels.value = channels
}

async function deleteScanGroup(id: string) {
  if (pseudoScanActive.value) return
  try {
    const data = await $fetch<{ groups: ScanGroup[] }>(`/api/scan-groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
    scanGroups.value = data.groups
  } catch (e: any) {
    lastError.value = e.message
  }
}

function selectAllPseudoScanMemories() {
  if (pseudoScanActive.value) return
  pseudoScanSelectedChannels.value = sortedRadioMemories.value.map(memory => memory.channel)
}

function clearPseudoScanMemories() {
  if (pseudoScanActive.value) return
  pseudoScanSelectedChannels.value = []
}

async function togglePseudoScan() {
  if (pseudoScanActive.value) {
    await stopPseudoScan()
    return
  }
  await startPseudoScan()
}

async function startPseudoScan() {
  if (!canStartPseudoScan.value) return
  try {
    const data = await $fetch<CommandResponse>('/api/pseudo-scan', {
      method: 'POST',
      body: { action: 'start', vfo: pseudoScanTargetVfo.value, channels: pseudoScanSelectedChannels.value },
    })
    if (data.state) applyState(data.state)
  } catch (e: any) {
    lastError.value = e.message
  }
}

async function stopPseudoScan() {
  try {
    const data = await $fetch<CommandResponse>('/api/pseudo-scan', {
      method: 'POST',
      body: { action: 'stop' },
    })
    if (data.state) applyState(data.state)
  } catch (e: any) {
    lastError.value = e.message
  }
}

async function selectRadioMemory(mem: RadioMemory) {
  if (memoryBusy.value || pseudoScanUsesActiveVfo.value) return
  memoryBusy.value = true
  try {
    await applyRadioMemoryToVfo(mem, activeVfo.value)
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    memoryBusy.value = false
  }
}

async function returnActiveVfoToVfo() {
  if (memoryBusy.value || pseudoScanUsesActiveVfo.value || !isMemoryLikeVfoMode(activeVfoMode.value)) return
  memoryBusy.value = true
  try {
    await $fetch('/api/command', { method: 'POST', body: { command: `VM${activeVfo.value}00` } })
  } catch (e: any) {
    lastError.value = e.message
  } finally {
    memoryBusy.value = false
  }
}

// ----------- lifecycle -----------

onMounted(async () => {
  setupAudioMediaSessionHandlers()
  window.addEventListener('online', onBrowserOnline)
  window.addEventListener('offline', onBrowserOffline)
  document.addEventListener('visibilitychange', onVisibilityChange)
  void loadAudioMediaArtwork()
  const savedTransport = localStorage.getItem('anytone_transport') || localStorage.getItem('cat_port')
  if (savedTransport === 'bt' || savedTransport === 'wired') selectedTransport.value = savedTransport
  loadChannels()
  await Promise.all([refreshPorts(), loadAudioStatus(), loadScanGroups(), refreshRecordings()])
  // Sync with server state (e.g. after page reload while transceiver is already connected)
  const s = await $fetch<TransceiverState>('/api/status')
  applyState(s)
  if (s.connected) startEventSource()
  if (!s.connected) void loadBtStatus()
  recordingsTimer = setInterval(() => {
    if (recordingEnabled.value) {
      if (Date.now() - recordingWindowEnd.value < 90_000) recordingWindowEnd.value = Date.now()
      void loadRecordings()
    }
  }, 15_000)
})

watch(selectedTransport, () => { if (!state.value.connected) void loadBtStatus() })

// Load the zone list once the radio connects (and clear it on disconnect). Fires
// on a fresh connect and on the initial applyState if already connected at load.
watch(() => state.value.connected, (connected) => {
  // The server enumerates every zone's channels during startup; just fetch the
  // ready-made map once connected.
  if (connected) void loadZones()
  else { zoneList.value = []; expandedZoneIndex.value = null }
})

watch(audioListening, () => {
  updateAudioMediaSession()
})

watch([recordingChannelFilter, recordingMinDurationSeconds], () => {
  if (recordingPlaybackPlaying.value) void startRecordingPlaybackAtPlayhead()
})

watch([
  audioTxActive,
  audioRxMutedForTx,
  () => state.value.rxMode,
  () => state.value.txVfo,
  () => state.value.lastUpdate,
  () => state.value.mainFreq,
  () => state.value.subFreq,
  () => state.value.mainMode,
  () => state.value.subMode,
  () => state.value.mainVfoMode,
  () => state.value.subVfoMode,
  () => state.value.mainMemoryChannel,
  () => state.value.subMemoryChannel,
  () => state.value.mainMemoryTag,
  () => state.value.subMemoryTag,
], () => {
  scheduleAudioMediaSessionUpdate()
})

watch(sortedRadioMemories, (memories) => {
  if (state.value.pseudoScanActive) return
  const available = new Set(memories.map(memory => memory.channel))
  const next = pseudoScanSelectedChannels.value.filter(channel => available.has(channel))
  if (next.length !== pseudoScanSelectedChannels.value.length) pseudoScanSelectedChannels.value = next
})

onUnmounted(() => {
  window.removeEventListener('online', onBrowserOnline)
  window.removeEventListener('offline', onBrowserOffline)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (recordingsTimer) clearInterval(recordingsTimer)
  recordingsTimer = null
  stopEventSource()
  clearPendingPseudoScanStatus()
  stopRecordingPlayback()
  stopAudio()
})
</script>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface2: #21262d;
  --border: #505152;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --radius: 8px;
  --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  min-height: 100vh;
}

html,
body {
  overflow-x: hidden;
}

.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.header-brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-shrink: 0;
}

.brand-logo {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 2px;
  color: var(--accent);
  font-family: var(--font-mono);
}

.brand-sub {
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.conn-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 1;
  flex-wrap: wrap;
  min-width: 260px;
}

.sel {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: var(--radius);
  padding: 5px 10px;
  font-size: 13px;
  flex: 1;
  min-width: 160px;
  cursor: pointer;
}
/* Pin the select + Connect button to the same explicit height so the native
   select's text (which renders a touch high) lines up exactly with the button. */
.conn-bar .sel,
.conn-bar > .btn {
  height: 30px;
  box-sizing: border-box;
  line-height: normal;
}

.sel:disabled { opacity: 0.5; cursor: default; }

.btn {
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity .15s;
  white-space: nowrap;
}

.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--accent); color: #0d1117; }
.btn-danger { background: var(--red); color: #fff; }
.btn-tx { background: rgba(248,81,73,.2); color: var(--red); border: 1px solid rgba(248,81,73,.55); }
.btn-tx--active { background: var(--red); color: #fff; }
.btn-ghost { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.btn-select-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}
.recordings-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.recording-controls-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}
.recording-duration-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}
.recording-duration-filter input {
  width: 110px;
  accent-color: var(--accent);
}
.recording-duration-filter span {
  min-width: 34px;
}
.recording-transport {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.recording-playback-status {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}
.btn-select-wrap select {
  appearance: none;
  -webkit-appearance: none;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0;
  outline: none;
}

.conn-status {
  font-size: 12px;
  font-family: var(--font-mono);
  padding: 4px 10px;
  border-radius: 20px;
  white-space: nowrap;
  flex-shrink: 0;
}

.status-ok { background: rgba(63,185,80,.15); color: var(--green); }
.status-off { background: rgba(139,148,158,.1); color: var(--text-muted); }

.audio-listener {
  display: grid;
  grid-template-columns: repeat(4, max-content) minmax(160px, 1fr) minmax(320px, 520px);
  align-items: center;
  gap: 8px;
  flex: 1 1 100%;
  width: 100%;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: rgba(88, 166, 255, .08);
}

.audio-listener .btn {
  min-width: 0;
}

.audio-listener--active {
  border-color: rgba(63, 185, 80, .6);
  background: rgba(63, 185, 80, .12);
}

.audio-listener--reconnecting {
  border-color: rgba(210, 153, 34, .7);
  background: rgba(210, 153, 34, .12);
}

.audio-listener-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 12px;
}

.audio-listener--active .audio-listener-label { color: var(--green); }
.audio-listener--reconnecting .audio-listener-label { color: var(--yellow); }

.webrtc-player-shell {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
  opacity: .72;
}

.webrtc-player-shell--active {
  opacity: 1;
}

.webrtc-now-playing {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
}

.webrtc-now-title,
.webrtc-now-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.webrtc-now-title {
  color: var(--text);
  font-size: 11px;
  font-weight: 800;
}

.webrtc-now-subtitle {
  color: var(--text-muted);
  font-size: 10px;
}

.webrtc-media-player {
  display: block;
  width: 100%;
  min-width: 0;
  height: 32px;
}

/* Hidden playback sink: still plays audio (and feeds MediaSession), just not
   shown — the Start/Stop button is the visible control. */
.webrtc-media-player--hidden {
  display: none;
}

.btn-audio-stats--active {
  border-color: rgba(88, 166, 255, .65);
  color: var(--accent);
  background: rgba(88, 166, 255, .12);
}

.btn-audio-fallback--active {
  border-color: rgba(210, 153, 34, .7);
  color: var(--yellow);
  background: rgba(210, 153, 34, .12);
}

/* DMR manual-dial popup (settings-pane "Manual Dial" box opens this).
   Matches the radio-setting popup: same outer body padding + theme vars. */
.manual-dial-modal { width: 300px; }

.manual-dial-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
}

.manual-dial-status {
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-2, #161b22);
  border: 1px solid var(--border);
  color: var(--text-dim, #9ca3af);
}

.manual-dial-status--on {
  background: rgba(245, 158, 11, .14);
  border-color: rgba(245, 158, 11, .6);
  color: #fcd34d;
}

.manual-dial-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--text-dim, #9ca3af);
}

.dmr-dial-input {
  width: 100%;
  box-sizing: border-box;
  height: 38px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2, #161b22);
  color: var(--text, #e6edf3);
  font-family: var(--font-mono);
  font-size: 16px;
}

.manual-dial-types {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.dmr-dial-type {
  padding: 10px;
  font-size: 13px;
  font-weight: 700;
  border-radius: 8px;
  background: var(--surface-2, #161b22);
  border: 1px solid var(--border);
  color: var(--text-dim, #9ca3af);
  cursor: pointer;
}

.dmr-dial-type--on {
  background: rgba(56, 189, 248, .18);
  border-color: var(--accent, #58a6ff);
  color: #7dd3fc;
}

.manual-dial-restore {
  width: 100%;
}

.manual-dial-note {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-dim, #9ca3af);
}

.floating-ptt {
  position: fixed;
  right: max(18px, env(safe-area-inset-right));
  bottom: max(20px, calc(env(safe-area-inset-bottom) + 16px));
  z-index: 80;
  width: 118px;
  height: 118px;
  border-radius: 999px;
  border: 2px solid rgba(139, 148, 158, .45);
  background: radial-gradient(circle at 35% 28%, #30363d, #161b22 68%);
  color: var(--text-muted);
  box-shadow: 0 18px 45px rgba(0, 0, 0, .45);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-family: var(--font-mono);
  user-select: none;
  touch-action: none;
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease, background .12s ease;
}

.floating-ptt-main {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: .08em;
}

.floating-ptt-sub {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.floating-ptt--ready {
  border-color: rgba(63, 185, 80, .9);
  background: radial-gradient(circle at 35% 28%, rgba(63, 185, 80, .38), rgba(35, 134, 54, .2) 46%, #161b22 76%);
  color: #aff5b4;
  box-shadow: 0 18px 45px rgba(0, 0, 0, .45), 0 0 24px rgba(63, 185, 80, .22);
}

.floating-ptt--busy {
  border-color: rgba(245, 158, 11, .9);
  color: #fde68a;
  background: radial-gradient(circle at 35% 28%, rgba(245, 158, 11, .44), rgba(120, 53, 15, .24) 48%, #161b22 78%);
}

.floating-ptt--active {
  border-color: rgba(248, 81, 73, 1);
  color: #fff;
  background: radial-gradient(circle at 35% 28%, #ff8f87, #ef4444 45%, #7f1d1d 82%);
  box-shadow: 0 18px 45px rgba(0, 0, 0, .45), 0 0 34px rgba(248, 81, 73, .55);
  transform: scale(1.04);
}

/* Disabled: stay fully opaque (no see-through "watermark" over the card
   underneath) — just dim the colors so it reads as a deliberate, inactive
   button rather than bleed-through. Exclude the active (transmitting) state:
   the button is :disabled during TX (to block re-press), but it must still show
   the red "transmitting" color rather than being greyed out by this rule. */
.floating-ptt:disabled:not(.floating-ptt--active) {
  cursor: default;
  transform: none;
  border-color: rgba(139, 148, 158, .3);
  background: radial-gradient(circle at 35% 28%, #262c34, #12161c 70%);
  color: rgba(139, 148, 158, .7);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .5);
}

.floating-ptt:not(:disabled):active {
  transform: scale(.97);
}

/* ── Error banner ── */
.error-banner {
  background: rgba(248,81,73,.12);
  border-bottom: 1px solid var(--red);
  color: var(--red);
  padding: 8px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.close-btn {
  background: none;
  border: none;
  color: var(--red);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}

/* ── Dashboard ── */
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  flex: 1;
}

/* ── VFO section ── */
.vfo-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}

@media (max-width: 720px) {
  .vfo-section { grid-template-columns: 1fr; }
}

.vfo-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  position: relative;
  min-width: 0;
}

.main-card { border-left: 3px solid #444; }
.sub-card  { border-left: 3px solid #444; }

/* Active (TX) VFO — full orange border */
.vfo-card--tx-vfo {
  border-left: 3px solid #c35910;
  box-shadow: 0 0 0 1px rgba(249, 115, 22, .15), inset 0 0 20px rgba(249, 115, 22, .04);
}

/* Single-receive inactive VFO — greyed out, non-interactive */
.vfo-card--inactive {
  opacity: .35;
  filter: grayscale(.4);
}

/* Dual-watch RX-only side: visually secondary, read-only. */
.vfo-card--rx-only {
  opacity: .82;
  filter: grayscale(.12);
}

/* Single-receive inactive VFO in non-split mode. */
.vfo-card--switchable {
  opacity: .35;
  filter: grayscale(.4);
}

/* Non-active side: click the card to make it the active TX/RX side (FT0/FT1). */
.vfo-card--selectable {
  cursor: pointer;
}

.rx-audio-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.rx-audio-row .level-bar {
  flex: 1;
  min-width: 0;
  margin-top: 0;
}

.rx-audio-mute {
  flex-shrink: 0;
  min-width: 54px;
  min-height: 24px;
  padding: 4px 8px;
  border: 1px solid rgba(139, 148, 158, .45);
  border-radius: 5px;
  color: var(--text-muted);
  background: rgba(139, 148, 158, .08);
  cursor: pointer;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
}

.rx-audio-mute:hover {
  border-color: rgba(248, 81, 73, .45);
  color: var(--text);
}

.rx-audio-mute--active {
  border-color: rgba(248, 81, 73, .6);
  color: var(--red);
  background: rgba(248, 81, 73, .13);
}

/* TX VFO badge in the card header */
.tx-vfo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  min-height: 30px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--red);
  background: rgba(248, 81, 73, .15);
  border: 1px solid rgba(248, 81, 73, .4);
  border-radius: 4px;
  padding: 6px 8px;
  white-space: nowrap;
  flex-shrink: 0;
}

.rx-vfo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  min-height: 30px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--green);
  background: rgba(81, 248, 73, .15);
  border: 1px solid rgba(81, 248, 73, .4);
  border-radius: 4px;
  padding: 6px 8px;
  white-space: nowrap;
  flex-shrink: 0;
}

.vfo-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  margin-bottom: 12px;
}

.vfo-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.vfo-control-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  width: 100%;
}

.band-sel {
  flex: 1;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 5px;
  min-height: 38px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono);
  cursor: pointer;
  min-width: 0;
  text-align: center;
  white-space: nowrap;
  transition: border-color .15s;
}

.band-sel:hover:not(:disabled) {
  border-color: var(--accent);
}

/* ── Band picker modal ── */
.band-modal {
  width: 280px;
}

.band-btn-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 12px;
}

.band-modal-btn {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  padding: 9px 4px;
  background: var(--surface-2, #1e2330);
  border: 2px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  cursor: pointer;
  text-align: center;
  white-space: nowrap;
  transition: background .1s, border-color .1s;
  outline: none;
}

.band-modal-btn:hover {
  background: rgba(59, 130, 246, .2);
  border-color: #3b82f6;
  color: #93c5fd;
}

.band-modal-btn:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 1px;
}

.band-modal-btn--active {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
  font-weight: 700;
}

.band-sel:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.band-sel:disabled {
  opacity: .45;
  cursor: default;
}

.vfo-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text-muted);
  font-weight: 600;
}

.memory-state-badge {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .7px;
  color: #fcd34d;
  background: rgba(245, 158, 11, .12);
  border: 1px solid rgba(245, 158, 11, .45);
  border-radius: 4px;
  padding: 6px 8px;
  max-width: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-state-badge--vfo {
  color: #93c5fd;
  background: rgba(59, 130, 246, .12);
  border-color: rgba(59, 130, 246, .45);
}

.memory-state-badge--scan {
  color: #fef08a;
  background: rgba(234, 179, 8, .16);
  border-color: rgba(234, 179, 8, .55);
}

.mode-sel {
  background: #6b7280;
  border: none;
  border-radius: 4px;
  color: #fff;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  min-height: 38px;
  padding: 8px 10px;
  cursor: pointer;
  transition: filter .15s;
  text-align: center;
  white-space: nowrap;
}

.mode-sel:hover:not(:disabled) {
  filter: brightness(1.15);
}

.vfo-readout {
  align-items: center;
  cursor: default;
  display: inline-flex;
  justify-content: center;
}

.band-sel.vfo-readout:hover {
  border-color: var(--border);
}

.mode-sel.vfo-readout:hover {
  filter: none;
}

/* ── Mode picker modal ── */
.mode-modal {
  width: 300px;
}

.mode-btn-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 12px;
}

.btn-up {
  flex: 0 0 54px;
  width: 54px;
}

.mode-modal-btn {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 9px 4px;
  border: 2px solid transparent;
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
  text-align: center;
  transition: filter .1s, border-color .1s;
  outline: none;
}

.mode-modal-btn:hover {
  filter: brightness(1.2);
}

.mode-modal-btn:focus-visible {
  outline: 2px solid rgba(255, 255, 255, .8);
  outline-offset: 1px;
}

.mode-modal-btn--active {
  border-color: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .35);
}

.mode-sel:focus {
  outline: 2px solid rgba(255,255,255,.5);
  outline-offset: 1px;
}

.mode-sel:disabled {
  opacity: .45;
  cursor: default;
}

.mode-sel option {
  background: #1c2128;
  color: #e6edf3;
  font-weight: 600;
}

.sql-cycle-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
}

.sql-cycle-val {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.freq-display {
  font-family: var(--font-mono);
  font-size: 42px;
  font-weight: 300;
  letter-spacing: 2px;
  color: #e6edf3;
  line-height: 1;
  transition: color .2s;
  white-space: nowrap;
}

.freq-display.freq-tx { color: var(--red); }
.freq-sub { font-size: 42px; color: #c9d1d9; }

.freq-sep {
  width: 1px;
  align-self: stretch;
  background: var(--border);
  margin: 2px 6px;
  flex-shrink: 0;
}

.freq-tuner {
  display: flex;
  align-items: baseline;
  font-family: var(--font-mono);
  font-size: clamp(30px, 4vw, 42px);
  font-weight: 300;
  letter-spacing: 2px;
  color: #e6edf3;
  line-height: 1;
  white-space: nowrap;
  min-width: 0;
}

.freq-tuner--editable {
  cursor: pointer;
  border-radius: 6px;
}

.freq-tuner--editable:hover .freq-group {
  background: rgba(88, 166, 255, .12);
}

.freq-tuner.freq-sub { font-size: clamp(30px, 4vw, 42px); color: #c9d1d9; }
.freq-tuner.freq-tx  { color: var(--red); }

.freq-dot {
  color: var(--text-muted);
  pointer-events: none;
  user-select: none;
  letter-spacing: 0;
  margin: 0 3px;
}

.freq-group {
  display: inline-block;
  width: 3ch;
  text-align: right;
  border-radius: 4px;
  padding: 0 2px;
  user-select: none;
  transition: background .1s, color .1s;
}

.freq-tuner--editable .freq-group {
  cursor: pointer;
}

.freq-tuner--editable .freq-group:hover {
  background: rgba(255, 255, 255, .1);
  color: #fff;
}

.freq-tuner--editable.freq-tx .freq-group:hover {
  background: rgba(239, 68, 68, .2);
}

.split-freq-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: -6px 0 12px;
  color: var(--text-muted);
  /* Inside .freq-block: forced onto its own line below the RX row, above the
     bandwidth visual. */
  order: 2;
  flex: 1 0 100%;
}

/* TX frequency is always shown; edit affordance is enabled when writes are safe. */

.split-freq-label {
  padding: 2px 6px;
  border: 1px solid rgba(248, 81, 73, .55);
  border-radius: 999px;
  background: rgba(248, 81, 73, .14);
  color: var(--red);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .08em;
}

.split-freq-tuner {
  display: flex;
  align-items: baseline;
  border-radius: 6px;
  color: #fca5a5;
  cursor: default;
  font-family: var(--font-mono);
  font-size: clamp(18px, 2.3vw, 24px);
  font-weight: 500;
  letter-spacing: 1px;
}

.split-freq-tuner .freq-group {
  cursor: default;
}

/* TX Prohibit on this side: strike through the TX frequency — you can't TX here. */
.split-freq-tuner--prohibited .freq-group,
.split-freq-tuner--prohibited .freq-dot {
  text-decoration: line-through;
  text-decoration-thickness: 2px;
  opacity: .65;
}

.split-freq-tuner:hover .freq-group {
  background: transparent;
  color: inherit;
}

.split-freq-tuner--editable {
  cursor: pointer;
}

.split-freq-tuner--editable .freq-group {
  cursor: pointer;
}

.split-freq-tuner--editable:hover .freq-group,
.split-freq-tuner--editable .freq-group:hover {
  background: rgba(248, 81, 73, .16);
  color: #fff;
}

.split-freq-unit {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

/* Wraps the RX freq row, the TX split row, and the bandwidth visual into one
   flex context so the bandwidth can share the RX line on desktop (top-right) but
   drop below BOTH frequencies on mobile via order/flex-basis. */
.freq-block {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 6px;
  margin-top: 22px;
}

.sql-row + .freq-block {
  margin-top: 8px;
}

.freq-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
  min-width: 0;
  order: 0;
  flex: 1 1 auto;
}

/* Desktop: bandwidth rides the right edge of the RX line. */
.freq-block > .bw-display {
  order: 1;
  margin-left: auto;
}

.freq-unit {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 2px;
  padding-top: 18px;
  padding-left: 4px;
}

/* ── Status section ── */
.status-section {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Per-channel settings rendered inside each VFO card — separated from the
   meters above by a thin rule. */
.channel-settings {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.channel-control {
  display: inline-flex;
  align-items: stretch;
  gap: 4px;
}

/* Channel/zone step buttons on their own row beneath zone+mode, spanning the
   full panel width: two equal groups (Ch left, Zone right), buttons fill. */
.vfo-step-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  width: 100%;
  margin-top: 3px;
  margin-bottom: 10px;
}
.vfo-step-row .channel-control {
  flex: 1 1 0;
}
.vfo-step-row .channel-control .channel-step-btn {
  flex: 1 1 0;
  min-height: 34px;
}
.vfo-step-row .zone-control {
  margin-left: 0;
}
.channel-step-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  padding: 0 8px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
  color: var(--text, #e2e8f0);
  background: var(--surface2);
  border: 1px solid var(--border, #334155);
  border-radius: 6px;
  cursor: pointer;
  transition: background .12s, border-color .12s;
}
/* Zone-name readout sits where band used to be; let it grow with the name. */
.zone-readout {
  min-width: 7ch;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.channel-step-btn--label {
  font-size: 13px;
  white-space: nowrap;
}

.channel-step-btn:hover:not(:disabled) {
  background: #38bdf8;
  border-color: #38bdf8;
  color: #0b1220;
}
.channel-step-btn:disabled {
  opacity: .4;
  cursor: not-allowed;
}

.status-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}

.status-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* ── Presets section ── */
/* ── Saved channels panel ── */
.channels-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  flex: 0 0 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.channels-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.channels-count {
  font-size: 10px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1px 6px;
  color: var(--text-muted);
}

.channels-target,
.channels-scan {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: .08em;
}

.channels-memory-btn {
  margin-left: auto;
}

.channels-subheader {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: .08em;
}

.scan-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid rgba(88, 166, 255, .22);
  border-radius: 6px;
  background: rgba(88, 166, 255, .06);
}

.scan-controls-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.scan-selected,
.scan-status,
.scan-target {
  color: var(--text-muted);
  font-size: 11px;
}

.scan-selected,
.scan-target span {
  text-transform: uppercase;
  letter-spacing: .08em;
}

.scan-target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.scan-vfo-select {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
}

.scan-status {
  font-family: var(--font-mono);
}

.scan-groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid rgba(63, 185, 80, .24);
  border-radius: 6px;
  background: rgba(63, 185, 80, .06);
}

.scan-groups-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.scan-group-entry {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid transparent;
  border-radius: 7px;
}

.scan-group-entry--active {
  border-color: rgba(63, 185, 80, .5);
}

.scan-group-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 4px 8px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px 0 0 6px;
  color: var(--text);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: nowrap;
}

.scan-group-btn:hover:not(:disabled) {
  border-color: var(--green);
  background: rgba(63, 185, 80, .1);
}

.scan-group-btn:disabled,
.scan-group-del:disabled {
  cursor: default;
  opacity: .55;
}

.scan-group-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.scan-group-count {
  color: var(--text-muted);
  font-size: 10px;
  flex-shrink: 0;
}

.scan-group-del {
  padding: 0 7px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-left: 0;
  border-radius: 0 6px 6px 0;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}

.scan-group-del:hover:not(:disabled) {
  color: #ef4444;
  background: rgba(239, 68, 68, .12);
}

.recordings-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  flex: 0 0 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.recordings-header,
.recordings-controls,
.recording-inspector {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.recordings-header {
  justify-content: space-between;
}

.recordings-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.recording-state {
  border: 1px solid rgba(139, 148, 158, .35);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .08em;
  padding: 2px 8px;
  text-transform: uppercase;
}

.recording-state--on {
  border-color: rgba(248, 81, 73, .6);
  background: rgba(248, 81, 73, .12);
  color: #fca5a5;
}

.recordings-window-label {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.recordings-timeline-shell {
  border: 1px solid rgba(88, 166, 255, .18);
  border-radius: 8px;
  background: rgba(13, 17, 23, .42);
  overflow: hidden;
}

.recordings-timeline-scroll {
  overflow-x: hidden;
  overflow-y: auto;
  cursor: grab;
  touch-action: none;
}

.recordings-timeline-scroll.is-dragging {
  cursor: grabbing;
  user-select: none;
}

.recordings-timeline {
  position: relative;
  width: 100%;
}

.recording-playhead-layer {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  pointer-events: none;
  z-index: 5;
}

.recording-playhead-track {
  position: relative;
}

.recording-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  transform: translateX(-1px);
  background: rgba(248, 81, 73, .95);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .45), 0 0 12px rgba(248, 81, 73, .55);
}

.recording-playhead-handle {
  position: absolute;
  top: 0;
  left: 50%;
  width: 9px;
  height: 9px;
  transform: translate(-50%, -2px) rotate(45deg);
  border-radius: 2px;
  background: #f85149;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .55);
}

.recordings-axis,
.recordings-lane {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
}

.recordings-axis {
  border-bottom: 1px solid rgba(80, 81, 82, .55);
  color: var(--text-muted);
  font-size: 10px;
  height: 28px;
}

.recordings-axis-track,
.recordings-lane-track {
  position: relative;
}

.recordings-axis-track {
  background: linear-gradient(90deg, rgba(88, 166, 255, .14) 1px, transparent 1px) 0 0 / 20% 100%;
}

.recordings-tick {
  position: absolute;
  top: 8px;
  transform: translateX(-50%);
  white-space: nowrap;
}

.recordings-lane {
  min-height: 38px;
  border-bottom: 1px solid rgba(80, 81, 82, .35);
}

.recordings-lane:last-child {
  border-bottom: 0;
}

.recordings-lane-label {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 10px;
  border: 0;
  border-right: 1px solid rgba(80, 81, 82, .55);
  background: rgba(22, 27, 34, .82);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

button.recordings-lane-label {
  cursor: pointer;
}

button.recordings-lane-label:hover {
  color: var(--text);
}

.recordings-axis-label {
  text-transform: uppercase;
  letter-spacing: .08em;
}

.recordings-lane-track {
  background: linear-gradient(90deg, rgba(88, 166, 255, .08) 1px, transparent 1px) 0 0 / 20% 100%;
}

.recording-block {
  position: absolute;
  top: 7px;
  bottom: 7px;
  min-width: 8px;
  border: 1px solid rgba(88, 166, 255, .75);
  border-radius: 5px;
  background: linear-gradient(90deg, rgba(88, 166, 255, .65), rgba(34, 211, 238, .42));
  color: #fff;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 800;
  overflow: hidden;
  padding: 0 5px;
  text-align: left;
  white-space: nowrap;
}

.recording-block--active {
  border-color: rgba(248, 81, 73, .9);
  background: linear-gradient(90deg, rgba(248, 81, 73, .75), rgba(249, 115, 22, .45));
}

.recording-block--tx {
  border-color: rgba(16, 185, 129, .85);
  background: linear-gradient(90deg, rgba(16, 185, 129, .75), rgba(74, 222, 128, .46));
}

.recording-block--tx.recording-block--active {
  border-color: rgba(34, 197, 94, .95);
  background: linear-gradient(90deg, rgba(34, 197, 94, .82), rgba(132, 204, 22, .52));
}

.recording-block--selected {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, .32);
}

.recordings-empty {
  padding: 18px;
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
}

.recording-inspector {
  border: 1px solid rgba(88, 166, 255, .18);
  border-radius: 8px;
  background: rgba(88, 166, 255, .06);
  padding: 8px;
}

.recording-inspector-meta {
  display: flex;
  align-items: center;
  flex: 1;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.recording-inspector-title {
  color: var(--text);
  font-weight: 800;
}

.recording-kind-pill {
  border-radius: 999px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .08em;
  padding: 2px 7px;
}

.recording-kind-pill--tx {
  border: 1px solid rgba(16, 185, 129, .65);
  background: rgba(16, 185, 129, .12);
  color: #86efac;
}

.recording-player {
  height: 32px;
  max-width: 360px;
  min-width: 240px;
}

.recording-playback-audio {
  display: none;
}

.channels-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.memory-entry {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid transparent;
  border-radius: 7px;
}

.memory-entry--selected {
  border-color: rgba(88, 166, 255, .38);
}

.scan-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-right: 0;
  border-radius: 6px 0 0 6px;
  cursor: pointer;
}

.scan-check input {
  cursor: pointer;
}

.scan-check:has(input:disabled) {
  opacity: .55;
  cursor: default;
}

.channels-empty {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

.ch-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color .15s, background .15s;
  font-size: 10px;
  font-family: var(--font-mono);
  white-space: nowrap;
}

.ch-badge:hover {
  border-color: #f97316;
  background: rgba(249, 115, 22, .08);
}

.ch-badge--memory {
  appearance: none;
  text-align: left;
  border-radius: 0 6px 6px 0;
}

.ch-badge--active {
  border-color: #f97316;
  background: rgba(249, 115, 22, .14);
}

.ch-badge:disabled {
  opacity: .55;
  cursor: default;
}

.ch-freq {
  color: var(--text);
  font-weight: 600;
}

.ch-sql {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}

.ch-del {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 3px;
  flex-shrink: 0;
}

.ch-del:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, .12);
}

/* ── Manual command ── */
.cmd-section {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 16px;
}

.cmd-label {
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  white-space: nowrap;
}

.cmd-input {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 5px 10px;
  font-family: var(--font-mono);
  font-size: 13px;
  width: 200px;
}

.cmd-input:focus { outline: 2px solid var(--accent); }

.cmd-hint {
  color: var(--text-muted);
  font-size: 11px;
}

.cmd-hint code {
  color: var(--text);
  font-family: var(--font-mono);
}

.cmd-response {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--green);
  padding: 3px 8px;
  background: rgba(63,185,80,.08);
  border-radius: 4px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Idle screen ── */
.idle-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 40px;
}

.idle-icon { font-size: 64px; line-height: 1; }
.idle-screen p { font-size: 15px; line-height: 1.6; }
.idle-hint { font-size: 13px; }
.idle-hint code {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  font-family: var(--font-mono);
  color: var(--text);
}

/* ── Bluetooth pairing panel (idle screen) ── */
.bt-panel {
  margin: 22px auto 0;
  width: 100%;
  max-width: 760px;
  text-align: left;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.bt-panel-head { display: flex; align-items: center; gap: 10px; }
.bt-panel-head strong { font-size: 14px; }
.bt-adapter { font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); margin-left: auto; }
.bt-panel-head .btn { margin-left: 10px; }
.bt-error { color: var(--danger, #e0564f); font-size: 13px; margin: 8px 0 0; }
.bt-radio-list { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.bt-radio {
  display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
}
.bt-radio--active { border-color: var(--accent, #4a9eff); }
.bt-radio-name { font-weight: 600; font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.bt-radio-addr { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); }
.bt-radio-flags { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.bt-flag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; background: var(--surface2); color: var(--text-dim); }
.bt-flag--ok { background: rgba(74, 158, 255, 0.18); color: var(--accent, #4a9eff); }
.bt-flag--warn { background: rgba(224, 86, 79, 0.16); color: var(--danger, #e0564f); }
.bt-radio-empty { font-size: 13px; color: var(--text-dim); }
.status-busy { color: var(--accent, #4a9eff); }

/* ── SQL / CTCSS / DCS info row inside VFO card ── */
.sql-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 28px;
  margin: 8px 0 4px;
}

.sql-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  box-sizing: border-box;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.8px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sql-badge--tone,
.sql-badge--dmr-caller,
.sql-badge--dmr-live {
  max-width: min(100%, 360px);
}

.sql-badge--split {
  background: rgba(248, 81, 73, .14);
  border-color: rgba(248, 81, 73, .72);
  color: #fca5a5;
  font-family: var(--font-mono);
}

.sql-badge--txfreq {
  background: rgba(245, 158, 11, .14);
  border-color: rgba(245, 158, 11, .72);
  color: #fcd34d;
  font-family: var(--font-mono);
}

.sql-badge--power {
  background: rgba(251, 146, 60, .14);
  border-color: rgba(251, 146, 60, .7);
  color: #fdba74;
  font-family: var(--font-mono);
}

.sql-badge--contact {
  background: rgba(56, 189, 248, .14);
  border-color: rgba(56, 189, 248, .7);
  color: #7dd3fc;
  font-family: var(--font-mono);
}

.sql-badge--dmr-caller {
  background: rgba(16, 185, 129, .14);
  border-color: rgba(16, 185, 129, .72);
  color: #86efac;
}

/* Live incoming call on a talkgroup the channel isn't set to (Digital Monitor). */
.sql-badge--dmr-live {
  background: rgba(245, 158, 11, .16);
  border-color: rgba(245, 158, 11, .78);
  color: #fcd34d;
  font-family: var(--font-mono);
  animation: sql-badge-live-pulse 1.4s ease-in-out infinite;
}

@keyframes sql-badge-live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .55; }
}

.sql-tone {
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
  color: currentColor;
}

/* ── Bottom panels row ── */
.bottom-panels {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}

/* ── Footer ── */
.footer {
  padding: 8px 20px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
}

.footer-fw {
  font-family: var(--font-mono);
  color: var(--text-dim, #9ca3af);
  letter-spacing: 0.04em;
}

/* ── DNR wheel wrapper ── */
.dnr-wrap { display: inline-flex; }
.dnr-wrap--active { cursor: ns-resize; }
.dnr-wrap--editable { cursor: pointer; }
.dnr-wrap--editable:focus-visible {
  outline: 2px solid #58a6ff;
  outline-offset: 2px;
  border-radius: 6px;
}

/* ── CTCSS / DCS tone picker modals ── */
.tone-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, .65);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.tone-modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .85);
  width: 360px;
  max-width: calc(100vw - 24px);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tone-modal--dcs {
  width: 450px;
}

.value-modal {
  width: 420px;
  padding-bottom: 14px;
}

.memory-write-modal {
  width: 520px;
}

.webrtc-stats-modal {
  width: 920px;
  max-height: 86vh;
}

.tone-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 9px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tone-modal-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .07em;
  color: var(--text-dim, #9ca3af);
}

.tone-modal-close {
  background: none;
  border: none;
  color: var(--text-dim, #9ca3af);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background .1s, color .1s;
}

.tone-modal-close:hover {
  background: rgba(255, 255, 255, .1);
  color: var(--text);
}

.webrtc-stats-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  overflow: auto;
}

.webrtc-stats-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.webrtc-stats-pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid rgba(139, 148, 158, .4);
  color: var(--text-muted);
  background: rgba(139, 148, 158, .1);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.webrtc-stats-pill--live {
  border-color: rgba(63, 185, 80, .5);
  color: var(--green);
  background: rgba(63, 185, 80, .12);
}

.webrtc-stats-pill--reconnecting {
  border-color: rgba(210, 153, 34, .55);
  color: var(--yellow);
  background: rgba(210, 153, 34, .12);
}

.webrtc-stats-updated {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  margin-right: auto;
}

.webrtc-stats-error {
  border: 1px solid rgba(248, 81, 73, .35);
  border-radius: 6px;
  color: var(--red);
  background: rgba(248, 81, 73, .09);
  padding: 8px 10px;
  font-size: 12px;
}

.webrtc-stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.webrtc-stat-card {
  min-width: 0;
  border: 1px solid rgba(80, 81, 82, .72);
  border-radius: 8px;
  background: rgba(13, 17, 23, .42);
  padding: 10px 12px;
}

.webrtc-stat-card h3 {
  margin-bottom: 9px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.webrtc-stat-list {
  display: grid;
  grid-template-columns: minmax(110px, .72fr) minmax(0, 1fr);
  gap: 6px 10px;
  align-items: baseline;
}

.webrtc-stat-list dt {
  color: var(--text-muted);
  font-size: 11px;
}

.webrtc-stat-list dd {
  min-width: 0;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  text-align: right;
}

.webrtc-stats-empty {
  color: var(--text-muted);
  font-size: 12px;
}

.webrtc-stats-raw {
  border: 1px solid rgba(80, 81, 82, .72);
  border-radius: 8px;
  background: rgba(13, 17, 23, .42);
  color: var(--text-muted);
  font-size: 12px;
}

.webrtc-stats-raw summary {
  cursor: pointer;
  padding: 9px 12px;
  color: var(--text);
}

.webrtc-stats-raw pre {
  max-height: 260px;
  overflow: auto;
  border-top: 1px solid rgba(80, 81, 82, .72);
  padding: 10px 12px;
  color: #c9d1d9;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.webrtc-diagnostics-card {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.webrtc-diagnostics-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.webrtc-diagnostics-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 220px;
  overflow: auto;
  list-style: none;
}

.webrtc-diagnostics-list li {
  display: grid;
  grid-template-columns: 54px minmax(120px, .55fr) minmax(0, 1fr);
  gap: 7px;
  align-items: baseline;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
}

.webrtc-diagnostics-list strong {
  color: var(--text);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.webrtc-diagnostics-list code {
  color: #c9d1d9;
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.webrtc-diagnostics-json {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  border: 1px solid rgba(80, 81, 82, .72);
  border-radius: 7px;
  background: rgba(1, 4, 9, .72);
  color: #c9d1d9;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.45;
  padding: 9px;
}

.value-field-label {
  margin: 16px 18px 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--text-muted);
}

.value-current {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 8px;
  color: var(--text-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .08em;
}

.value-current strong {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 24px;
  letter-spacing: 0;
}

.value-range {
  width: calc(100% - 36px);
  margin: 8px 18px 14px;
  accent-color: var(--accent);
}

.value-step-row {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) 58px;
  gap: 10px;
  padding: 0 18px;
}

.value-step-btn,
.value-number-input {
  min-height: 46px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface2);
  color: var(--text);
  font-family: var(--font-mono);
}

.value-step-btn {
  cursor: pointer;
  font-size: 24px;
  font-weight: 800;
}

.value-number-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 20px;
  text-align: center;
}

.value-number-input--wide {
  width: calc(100% - 36px);
  margin: 0 18px;
  text-align: left;
}

.value-hint {
  margin: 8px 18px 0;
  color: var(--text-muted);
  font-size: 12px;
}

.value-hint code {
  font-family: var(--font-mono);
  color: var(--text);
}

.memory-write-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 18px 0;
}

.memory-write-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.memory-write-field--wide {
  grid-column: 1 / -1;
}

.memory-write-field span,
.memory-write-check span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.memory-write-text {
  text-align: left;
  font-size: 15px;
}

.memory-write-select {
  width: 100%;
  min-height: 46px;
  font-size: 13px;
}

.memory-write-check {
  display: inline-flex;
  align-items: center;
  gap: 9px;
}

.value-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 18px 0;
}

.ctcss-tone-grid,
.dcs-code-grid {
  padding: 10px;
  overflow-y: auto;
  display: grid;
  gap: 4px;
}

.ctcss-tone-grid {
  grid-template-columns: repeat(5, 1fr);
}

/* RX/TX tone popup: type selector + DCS inverted toggle. */
.tone-type-row {
  display: flex;
  gap: 6px;
  padding: 10px 10px 0;
}
.tone-type-row .setting-enum-btn { flex: 1; justify-content: center; }
.tone-dcs-invert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0;
  font-size: 13px;
  color: var(--text-muted);
}

.dcs-code-grid {
  grid-template-columns: repeat(6, 1fr);
}

.ctcss-tone-btn {
  font-size: 10px;
  padding: 6px 2px;
  background: var(--surface-2, #1e2330);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  cursor: pointer;
  text-align: center;
  transition: background .1s, border-color .1s, outline .1s;
  outline: none;
}

.ctcss-tone-btn:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 1px;
}

.ctcss-tone-btn:hover {
  background: rgba(59, 130, 246, .25);
  border-color: #3b82f6;
  color: #93c5fd;
}

.ctcss-tone-btn--active {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
  font-weight: 700;
}

@media (max-width: 760px) {
  body { font-size: 13px; }

  .header {
    gap: 10px;
    padding: 10px 12px;
    align-items: stretch;
  }

  .header-brand,
  .conn-bar,
  .conn-status,
  .audio-listener {
    width: 100%;
  }

  .header-brand {
    justify-content: space-between;
    align-items: center;
  }

  .brand-logo { font-size: 20px; }
  .brand-sub { font-size: 10px; }

  .conn-bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    min-width: 0;
    gap: 6px;
  }

  .sel {
    min-width: 0;
    width: 100%;
  }

  .conn-status {
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
  }

  /* 2×2 grid on phones for bigger tap targets (Enable Audio / HTTP Audio /
     Enable Mic / Stats). The label + hidden player still span the full width. */
  .audio-listener {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .audio-listener .btn {
    width: 100%;
    padding-inline: 6px;
  }

  .audio-listener-label {
    grid-column: 1 / -1;
    width: 100%;
    text-align: left;
  }

  .webrtc-player-shell {
    grid-column: 1 / -1;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
  }

  .webrtc-now-playing {
    width: 100%;
  }

  .webrtc-media-player {
    width: 100%;
  }

  .floating-ptt {
    width: 106px;
    height: 106px;
    right: 14px;
    bottom: max(14px, calc(env(safe-area-inset-bottom) + 12px));
  }

  .floating-ptt-main {
    font-size: 21px;
  }

  .dashboard {
    gap: 12px;
    padding: 12px;
    /* Clear the fixed floating-PTT (bottom-right) so the last card's content
       isn't permanently hidden behind it when scrolled to the bottom. */
    padding-bottom: 140px;
  }

  .vfo-section {
    gap: 12px;
  }

  /* Bluetooth radio rows: stack so the name, flags, and Pair/Forget action
     wrap instead of clipping off the right edge of the card. */
  .bt-radio-name {
    flex: 1 1 100%;
  }

  .bt-radio-flags {
    margin-left: 0;
  }

  .bt-radio > .btn {
    margin-left: auto;
  }

  .vfo-card {
    padding: 12px;
  }

  .vfo-header {
    gap: 6px;
    margin-bottom: 10px;
  }

  .vfo-control-row {
    gap: 6px;
  }

  .vfo-label {
    flex: 0 0 auto;
    letter-spacing: 1.5px;
  }

  .band-sel {
    flex: 1 1 96px;
    min-height: 44px;
    padding: 10px 9px;
    font-size: 12px;
  }

  .mode-sel {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 10px 11px;
    font-size: 12px;
  }

  .btn-up {
    width: 58px;
    flex: 0 0 58px;
  }

  .tx-vfo-badge,
  .rx-vfo-badge,
  .memory-state-badge {
    min-height: 34px;
    padding-top: 8px;
    padding-bottom: 8px;
  }

  .freq-block {
    margin-top: 14px;
  }

  .freq-row {
    gap: 4px;
    flex-basis: 100%;
  }

  /* Stack order on mobile: RX (0) → TX split row (1) → bandwidth (2), so the
     channel-width visual sits below both frequencies, not between them. */
  .split-freq-row {
    order: 1;
  }

  .freq-tuner,
  .freq-tuner.freq-sub {
    font-size: clamp(27px, 8.2vw, 34px);
    letter-spacing: 0;
  }

  .freq-dot {
    margin: 0 1px;
  }

  .freq-group {
    padding: 0 1px;
  }

  .freq-unit {
    padding-top: 12px;
    padding-left: 1px;
    letter-spacing: 1px;
  }

  .freq-block > .bw-display {
    order: 2;
    flex: 1 0 100%;
    min-width: 0;
    max-width: none;
    margin: 8px 0 0;
  }

  .status-section {
    gap: 6px;
  }

  .status-section > .badge,
  .status-section > .dnr-wrap {
    flex: 1 1 78px;
    min-width: 0;
  }

  .dnr-wrap .badge {
    width: 100%;
  }

  .status-section .badge {
    padding: 5px 6px;
    min-width: 0;
  }

  .bottom-panels {
    gap: 12px;
  }

  .scope-panel,
  .status-panel,
  .channels-panel,
  .recordings-panel,
  .presets-section,
  .cmd-section {
    width: 100%;
    padding: 12px;
  }

  .scope-controls {
    gap: 6px;
  }

  .scope-sep {
    display: none;
  }

  .scope-btn-group {
    width: 100%;
  }

  .scope-group-lbl {
    width: 44px;
  }

  .scope-btn {
    flex: 1 1 auto;
    padding-inline: 5px;
  }

  .channels-list,
  .presets-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }

  .ch-badge {
    min-width: 0;
    white-space: normal;
  }

  .ch-freq,
  .ch-sql {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .presets-grid .preset-btn {
    min-width: 0;
    max-width: none;
    width: 100%;
  }

  .presets-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .cmd-input {
    width: auto;
    flex: 1 1 160px;
    min-width: 0;
  }

  .cmd-response {
    flex-basis: 100%;
    max-width: none;
  }

  .footer {
    padding: 8px 12px;
    text-align: center;
    line-height: 1.5;
  }

  .tone-modal-backdrop {
    align-items: center;
    padding: 12px;
  }

  .tone-modal,
  .tone-modal--dcs,
  .webrtc-stats-modal,
  .mode-modal,
  .band-modal {
    width: 100%;
    max-height: 88vh;
  }

  .webrtc-stats-grid {
    grid-template-columns: 1fr;
  }

  .webrtc-stat-list {
    grid-template-columns: minmax(96px, .55fr) minmax(0, 1fr);
  }

  .memory-write-grid {
    grid-template-columns: 1fr;
  }

  .ctcss-tone-grid,
  .dcs-code-grid,
  .mode-btn-grid,
  .band-btn-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 420px) {
  .conn-bar {
    grid-template-columns: minmax(0, 1fr) 120px;
  }

  .conn-bar .btn {
    width: 100%;
  }

  .freq-tuner,
  .freq-tuner.freq-sub {
    font-size: clamp(24px, 7.8vw, 30px);
  }

  .channels-list,
  .presets-grid {
    grid-template-columns: 1fr;
  }

  .ctcss-tone-grid,
  .dcs-code-grid,
  .mode-btn-grid,
  .band-btn-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* ── Editable setting badge-boxes (Operating Controls) ── */
/* A clickable wrapper around StatusBadge so an editable control looks identical
   to a status box but opens the floating editor on click. */
.ctl-box {
  cursor: pointer;
  border-radius: var(--radius, 8px);
  transition: box-shadow .12s, transform .05s;
}
.ctl-box:hover { box-shadow: 0 0 0 1px var(--accent, #58a6ff) inset; }
.ctl-box:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: 1px; }
.ctl-box:active { transform: translateY(1px); }
.ctl-box--open { box-shadow: 0 0 0 1px var(--accent, #58a6ff) inset; }

/* Floating editor popup (reuses .tone-modal shell). */
.setting-modal { width: 300px; }
.setting-edit-num {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 20px 18px;
}
.setting-edit-stepper {
  display: flex;
  align-items: center;
  gap: 18px;
}
.setting-edit-btn {
  width: 44px;
  height: 44px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2, #161b22);
  color: var(--text, #e6edf3);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.setting-edit-btn:disabled { opacity: .35; cursor: default; }
.setting-edit-value {
  min-width: 48px;
  text-align: center;
  font-size: 30px;
  font-variant-numeric: tabular-nums;
}
.setting-edit-range { width: 100%; accent-color: var(--accent, #58a6ff); }
.setting-edit-done { width: 100%; }
.setting-edit-enum {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  /* Long option lists (e.g. the 50-entry CTCSS picker) scroll inside the modal. */
  max-height: min(60vh, 420px);
  overflow-y: auto;
}
.setting-enum-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2, #161b22);
  color: var(--text, #e6edf3);
  font-size: 14px;
  cursor: pointer;
}
.setting-enum-btn--active { border-color: var(--accent, #58a6ff); }
.setting-enum-btn:disabled { opacity: .5; cursor: default; }
.setting-enum-check { color: var(--accent, #58a6ff); font-weight: 700; }

/* ── Zone selector panel ── */
.zones-panel {
  /* The .dashboard flex column already provides the 16px inter-pane gap — no
     extra margin here (it was double-spacing this pane from the one above). */
  padding: 14px 16px;
  background: var(--surface, #0d1117);
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
}
.zones-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.zones-count {
  font-size: 11px;
  color: var(--text-muted, #8b949e);
  background: var(--surface-2, #161b22);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1px 8px;
}
.zones-target { font-size: 11px; color: var(--text-muted, #8b949e); }
.zones-refresh-btn { margin-left: auto; }
.zones-empty {
  padding: 14px;
  text-align: center;
  color: var(--text-muted, #8b949e);
  font-size: 13px;
}
.zones-empty--sm { padding: 8px; font-size: 12px; }

/* Zone accordion: a vertical list of zone rows; the open zone reveals its channels
   (ch-badge flex-wrap) indented beneath it. */
.zone-accordion { display: flex; flex-direction: column; gap: 4px; }
.zone-group {
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}
.zone-group--open { border-color: var(--accent, #58a6ff); }
.zone-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: var(--surface2, #161b22);
  border: 0;
  color: var(--text, #e6edf3);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.zone-row:hover { background: rgba(88, 166, 255, .08); }
.zone-row--active { background: rgba(16, 185, 129, .10); }
.zone-row-caret { color: var(--text-muted, #8b949e); width: 12px; }
.zone-row-name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zone-row-badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, .5);
  border-radius: 9px;
  padding: 1px 7px;
}
.zone-row-count { font-size: 11px; color: var(--text-muted, #8b949e); }
.zone-channels {
  /* .channels-list provides the flex-wrap; this just frames the nested area. */
  padding: 8px 10px 10px;
  background: var(--surface, #0d1117);
  border-top: 1px solid var(--border);
}
</style>
