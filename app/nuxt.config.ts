export default defineNuxtConfig({
  devtools: { enabled: false },
  ssr: false,
  app: {
    // Where the UI is mounted. Defaults to "/" so a fresh clone opens at
    // http://localhost:3030/ . To serve under a sub-path behind a reverse proxy
    // (e.g. nginx at /anytone/), set NUXT_APP_BASE_URL=/anytone/ in the
    // environment — see docs/DEPLOYMENT.md. (Nuxt reads this env var natively too.)
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      title: 'AnyTone AT-D578UVIII BT Controller',
      meta: [
        { name: 'application-name', content: 'AnyTone AT-D578UVIII BT Controller' },
        { name: 'apple-mobile-web-app-title', content: 'AT-D578UVIII' },
      ],
    },
  },
  experimental: {
    appManifest: false,
  },
  nitro: {
    // Enables defineWebSocketHandler (crossws) so server/routes/api/raw-ws.ts can
    // proxy the backend's loopback /raw/ws control bus to LAN clients (e.g. the
    // macOS relay) over the single LAN-facing :3030 port. See that handler.
    experimental: { websocket: true },
  },
  runtimeConfig: {
    serialServerUrl: process.env.ANYTONE_SERVER_URL || 'http://127.0.0.1:3010',
    public: {
      // Browser uses the Nuxt server proxy so remote clients do not need direct
      // access to the local serial process on the radio host.
      serialEventsUrl: '/api/events',
    },
  },
})
