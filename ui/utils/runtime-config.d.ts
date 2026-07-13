declare module 'nuxt/schema' {
  interface RuntimeConfig {
    serialServerUrl: string
  }

  interface PublicRuntimeConfig {
    serialEventsUrl: string
  }
}

export {}
