// SPA entry. Renders RadioState (via AppState) over the single /ws JSON-RPC link — no shims, no
// REST/SSE. The look is the PoC's: assets/app.css is its stylesheet, lifted verbatim, and the
// components reuse its class names.

import { createApp } from 'vue'
import App from './App.vue'
import './assets/app.css'

createApp(App).mount('#app')
