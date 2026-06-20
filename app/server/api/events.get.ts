import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'

export default defineEventHandler((event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const target = new URL('/anytone/events', serialServerUrl)
  const res = event.node.res

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let upstreamResponse: IncomingMessage | null = null

    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      if (!res.headersSent) {
        reject(createError({ statusCode: 503, message: err.message }))
        return
      }
      if (!res.writableEnded) res.end()
      resolve()
    }

    const cleanup = () => {
      request.destroy()
      upstreamResponse?.destroy()
      finish()
    }

    const request = (target.protocol === 'https:' ? https : http).request(
      target,
      {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      },
      (upstream) => {
        upstreamResponse = upstream

        if (upstream.statusCode && upstream.statusCode >= 400) {
          upstream.resume()
          fail(new Error(`Serial event stream unavailable (${upstream.statusCode})`))
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })

        upstream.on('data', (chunk) => {
          if (!res.write(chunk)) upstream.pause()
        })
        res.on('drain', () => upstream.resume())
        upstream.on('end', () => {
          if (!res.writableEnded) res.end()
          finish()
        })
        upstream.on('error', fail)
      },
    )

    event.node.req.on('close', cleanup)
    res.on('close', cleanup)
    request.on('error', fail)
    request.end()
  })
})
