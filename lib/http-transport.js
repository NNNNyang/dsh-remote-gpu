// dsh-remote-gpu — host-side HTTP transport.
//
// Every route is registered twice, exactly the way the shipped dsh-remote
// plugin does it:
//
//   • on the Host web server, guarded by the Host/Origin fence, and
//   • on the Connection Fetch registry, which is the in-process `/api`
//     channel the Desktop renderer talks to.
//
// The Desktop renderer reaches the plugin under the `dsh-app:` protocol and
// therefore calls `/api/<route>`; a plain web host calls `/<route>` directly.
// Both spellings are served from the same handler.
//
// No third-party dependency: the plugin stays installable offline.

import { Readable } from 'node:stream'

/** Write a JSON body through a Node response. */
export function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * Host/Origin fence used when the Connection service is not mounted: a
 * cross-site request, a foreign Origin or a non-loopback Host is refused.
 * A request without any header is treated as in-process and allowed.
 * @param {any} req - Node request.
 * @returns {number|undefined} the rejection status, or undefined when allowed.
 */
export function fallbackRejection(req) {
  const headers = req?.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers.origin
  const host = headers.host
  if (origin && host) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      return 403
    }
    if (originHost !== host) return 403
  }
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return 403
  return undefined
}

/**
 * Wrap a route handler with the Connection fence when one is mounted.
 * @param {any} route - route with { path, methods, handler }.
 * @param {any} [connectionOf] - the Connection service, when mounted.
 */
export function guardRoute(route, connectionOf) {
  return {
    ...route,
    async handler(req, res) {
      const rejection = connectionOf
        ? connectionOf.requestRejection(req)
        : fallbackRejection(req)
      if (rejection) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await route.handler(req, res)
    },
  }
}

/** A minimal response shim that captures what a Node handler wrote. */
function createResponse() {
  let status = 200
  const headers = {}
  let settle
  const settled = new Promise((resolve) => {
    settle = resolve
  })
  return {
    settled,
    res: {
      get statusCode() {
        return status
      },
      set statusCode(value) {
        status = value
      },
      setHeader(name, value) {
        headers[String(name).toLowerCase()] = value
      },
      getHeader(name) {
        return headers[String(name).toLowerCase()]
      },
      removeHeader(name) {
        delete headers[String(name).toLowerCase()]
      },
      writeHead(code, extra) {
        status = code
        if (extra) {
          for (const [key, value] of Object.entries(extra)) {
            headers[key.toLowerCase()] = value
          }
        }
      },
      end(body) {
        settle({ status, headers, body: body === undefined ? '' : body })
      },
    },
  }
}

/**
 * Turn a route into an exact Connection Fetch route under `/api`.
 * @param {any} route - route with { path, methods, handler }.
 */
export function connectionRoute(route) {
  return {
    path: `/api${route.path}`,
    methods: route.methods ?? ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url)
      const buffer = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0)
      const req = Readable.from(buffer.length ? [buffer] : [])
      req.method = request.method
      req.url = `${route.path}${url.search}`
      req.headers = Object.fromEntries(request.headers.entries())
      const { res, settled } = createResponse()
      await Promise.race([route.handler(req, res), settled.then(() => undefined)])
      const { status, headers, body } = await settled
      return new Response(body, { status, headers })
    },
  }
}

/**
 * Register every route on the web server and on the Connection Fetch registry.
 * A route that cannot be registered on one of them never takes the other down.
 * @param {any} ctx - plugin context.
 * @param {any[]} routes - routes with { path, methods, handler }.
 */
export function registerHttpTransports(ctx, routes) {
  ctx.inject(['webServer'], (inner) => {
    const webServer = inner.get('webServer')
    const connection = inner.get('connection')
    inner.effect(() => {
      const disposers = routes.map((route) => webServer.register(guardRoute(route, connection)))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-remote-gpu.web-routes')
  })

  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    inner.effect(() => {
      const disposers = []
      const failed = []
      for (const route of routes) {
        try {
          disposers.push(connection.fetch.register(connectionRoute(route)))
        } catch (error) {
          failed.push(`${route.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failed.length > 0) {
        console.warn('[dsh-remote-gpu] some Connection Fetch routes did not register:', failed.join('; '))
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-remote-gpu.connection-routes')
  })
}
