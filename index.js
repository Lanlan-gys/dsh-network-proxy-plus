// dsh-network-proxy-plus — Host half.
//
// Drop-in replacement for `dsh-network-proxy` that works on DSH 0.2.x:
//
//   1. Configuration lives in this plugin's own `Config` schema with `volatile`
//      fields, which is what the 0.2.x settings seam projects into editable
//      forms. A volatile-only edit is committed into the running fiber's
//      references in place (`loader/volatile-update`), so the entry is never
//      remounted and the proxy switches instantly.
//   2. SOCKS5 / SOCKS5H endpoints are supported through a hand-rolled SOCKS5
//      connector handed to undici's `Agent({ connect })`. undici itself speaks
//      only HTTP(S) proxies, so a bare `ProxyAgent` could never reach a SOCKS
//      proxy such as 127.0.0.1:10809.
//   3. Loopback destinations bypass the proxy, matching DSH's own
//      `@deepseek-ai/dsh-http-proxy` policy, so local traffic never loops.

import { execFileSync } from 'node:child_process'
import net from 'node:net'
import tls from 'node:tls'
import z from '@deepseek-ai/schemastery'
import {
  Agent,
  EnvHttpProxyAgent,
  Pool,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici'

const LABEL = 'network-proxy-plus'

/** Every environment name that carries proxy configuration. */
const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]

/** The proxy environment as this process was launched with, restored by `system` mode. */
const inheritedProxyEnvironment = Object.fromEntries(
  PROXY_ENV_NAMES.map((name) => [name, process.env[name]]),
)

/** Loopback hosts a proxy cannot meaningfully reach. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0']

/**
 * Loopback entries published in `NO_PROXY`.
 *
 * A child process that inherits `ALL_PROXY` would otherwise send the harness's own
 * local traffic (a local model server, a dev server, a local registry) into the proxy,
 * where it can only fail — so the bypass is published, not merely applied internally.
 */
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]']

/** Merge the loopback bypass into a bypass list, preserving the caller's entries. */
function withLoopback(noProxy) {
  const entries = String(noProxy ?? '').split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (entries.includes('*')) return '*'
  const present = new Set(entries.map((entry) => entry.toLowerCase()))
  return [...entries, ...LOOPBACK_NO_PROXY.filter((entry) => !present.has(entry.toLowerCase()))].join(',')
}

// Every field is `volatile`, which is what makes this plugin's row editable from
// the running settings UI: a volatile-only edit is committed into the live config
// references instead of remounting the plugin, so the switch is instant.
export const Config = z.object({
  mode: z
    .union([
      z.const('system').description('Follow the operating system proxy settings'),
      z.const('custom').description('Use the proxy configured below'),
      z.const('direct').description('Ignore every proxy and connect directly'),
    ])
    .default('custom')
    .volatile(),
  protocol: z
    .union([
      z.const('socks5').description('SOCKS5 proxy'),
      z.const('socks5h').description('SOCKS5 proxy, resolved by the proxy'),
      z.const('http').description('HTTP proxy'),
      z.const('https').description('HTTPS proxy'),
    ])
    .default('socks5')
    .volatile(),
  host: z.string().default('127.0.0.1').description('Proxy address, for example 127.0.0.1').volatile(),
  port: z.number().min(1).max(65535).default(10809).description('Proxy port, for example 10809').volatile(),
  username: z.string().default('').description('Proxy username, empty when the proxy needs no authentication').volatile(),
  password: z.string().default('').description('Proxy password, empty when the proxy needs no authentication').volatile(),
})

const MODES = ['system', 'custom', 'direct']
const PROTOCOLS = ['socks5', 'socks5h', 'http', 'https']

/** Read a config field, whether it arrived as a volatile reference or a plain value. */
function readField(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined || current === null ? fallback : current
  }
  return value
}

/** Normalize a raw config into the plain settings object the rest of the module uses. */
function resolveSettings(config) {
  const mode = String(readField(config?.mode, 'system'))
  const protocol = String(readField(config?.protocol, 'socks5'))
  const host = String(readField(config?.host, '') ?? '').trim()
  const port = Number(readField(config?.port, 0))
  return {
    mode: MODES.includes(mode) ? mode : 'system',
    protocol: PROTOCOLS.includes(protocol) ? protocol : 'socks5',
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
    username: String(readField(config?.username, '') ?? ''),
    password: String(readField(config?.password, '') ?? ''),
  }
}

/** Whether a destination must skip the proxy. */
function isLoopback(hostname) {
  const host = String(hostname ?? '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (host === '') return false
  if (LOOPBACK_HOSTS.includes(host)) return true
  if (host.endsWith('.localhost')) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** Whether a URL must bypass the proxy: loopback, or a name the launch environment exempts. */
function bypasses(origin, noProxy) {
  let url
  try {
    url = origin instanceof URL ? origin : new URL(String(origin))
  } catch {
    return false
  }
  if (isLoopback(url.hostname)) return true
  const list = noProxy ?? ''
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const raw of list.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const [name, entryPort] = entry.includes(':') && entry.indexOf(':') === entry.lastIndexOf(':')
      ? [entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1)]
      : [entry, undefined]
    if (entryPort !== undefined && entryPort !== port) continue
    const candidate = name.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate === '') continue
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

/** Build the proxy URL for an HTTP(S) proxy endpoint. */
function httpProxyUrl(settings) {
  const scheme = settings.protocol === 'https' ? 'https' : 'http'
  const auth = settings.username === ''
    ? ''
    : `${encodeURIComponent(settings.username)}:${encodeURIComponent(settings.password)}@`
  return `${scheme}://${auth}${settings.host}:${settings.port}`
}

/** Build the proxy URL for a SOCKS endpoint. */
function socksProxyUrl(settings) {
  const scheme = settings.protocol === 'socks5h' ? 'socks5h' : 'socks5'
  const auth = settings.username === ''
    ? ''
    : `${encodeURIComponent(settings.username)}:${encodeURIComponent(settings.password)}@`
  return `${scheme}://${auth}${settings.host}:${settings.port}`
}

/** Human-readable SOCKS5 reply code. */
function socksReplyMessage(code) {
  switch (code) {
    case 0x01: return 'SOCKS5: general server failure'
    case 0x02: return 'SOCKS5: connection not allowed by ruleset'
    case 0x03: return 'SOCKS5: network unreachable'
    case 0x04: return 'SOCKS5: host unreachable'
    case 0x05: return 'SOCKS5: connection refused by the destination'
    case 0x06: return 'SOCKS5: TTL expired'
    case 0x07: return 'SOCKS5: command not supported'
    case 0x08: return 'SOCKS5: address type not supported'
    default: return `SOCKS5: request rejected (reply 0x${code.toString(16)})`
  }
}

/** Encode a destination address for a SOCKS5 CONNECT request. */
function encodeSocksAddress(host) {
  const family = net.isIP(host)
  if (family === 4) return Buffer.from([0x01, ...host.split('.').map((part) => Number(part))])
  if (family === 6) return Buffer.concat([Buffer.from([0x04]), parseIpv6(host)])
  const name = Buffer.from(host, 'utf8')
  if (name.length === 0 || name.length > 255) {
    throw new Error(`SOCKS5: destination host "${host}" is not usable as a domain name`)
  }
  return Buffer.concat([Buffer.from([0x03, name.length]), name])
}

/** Expand one IPv6 literal into its sixteen octets. */
function parseIpv6(host) {
  const text = host.replace(/^\[|\]$/g, '')
  const halves = text.split('::')
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length > 1 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  const expand = (groups) => groups.flatMap((group) => {
    if (group.includes('.')) {
      const octets = group.split('.').map((part) => Number(part))
      return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]]
    }
    return [Number.parseInt(group, 16)]
  })
  const headWords = expand(head)
  const tailWords = expand(tail)
  const missing = 8 - headWords.length - tailWords.length
  const words = [...headWords, ...new Array(Math.max(missing, 0)).fill(0), ...tailWords]
  const buffer = Buffer.alloc(16)
  for (let index = 0; index < 8; index += 1) buffer.writeUInt16BE(words[index] & 0xffff, index * 2)
  return buffer
}

/**
 * Build an undici connector that tunnels every TCP connection through a SOCKS5 proxy.
 *
 * The returned function follows undici's `buildConnector` contract: it receives the
 * destination origin and must answer with a socket already connected (and, for an
 * `https:` origin, already wrapped in TLS with ALPN negotiated).
 */
function createSocksConnector(settings, options = {}) {
  const { timeout = 30000, tls: tlsOptions } = options
  const proxyHost = settings.host
  const proxyPort = settings.port
  const username = settings.username
  const password = settings.password
  const useAuth = username !== '' || password !== ''

  return function connect(params, callback) {
    const targetHost = params.hostname || params.host
    const secure = params.protocol === 'https:'
    const targetPort = params.port || (secure ? 443 : 80)
    const socket = net.connect({ host: proxyHost, port: proxyPort, localAddress: params.localAddress })
    let settled = false
    let buffer = Buffer.alloc(0)
    let waiting

    const settle = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        socket.destroy()
        callback(error)
      } else {
        callback(null, result)
      }
    }

    const timer = setTimeout(() => {
      settle(new Error(`SOCKS5: connecting to ${proxyHost}:${proxyPort} timed out`))
      socket.destroy()
    }, timeout)
    if (typeof timer.unref === 'function') timer.unref()

    const drainBuffer = () => {
      while (waiting !== undefined && buffer.length >= waiting.size) {
        const chunk = buffer.subarray(0, waiting.size)
        buffer = buffer.subarray(waiting.size)
        const resolve = waiting.resolve
        waiting = undefined
        resolve(chunk)
      }
    }

    const read = (size) => new Promise((resolve) => {
      waiting = { size, resolve }
      drainBuffer()
    })

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      drainBuffer()
    }
    const onError = (error) => settle(error)

    socket.on('data', onData)
    socket.on('error', onError)

    /** Detach this connector's own stream listeners before the socket changes hands. */
    const handOver = () => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      // Bytes that arrived past the reply belong to the tunnelled stream.
      if (buffer.length > 0) {
        socket.unshift(buffer)
        buffer = Buffer.alloc(0)
      }
    }

    const handshake = async () => {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.setNoDelay(true)

      const methods = useAuth ? [0x00, 0x02] : [0x00]
      socket.write(Buffer.from([0x05, methods.length, ...methods]))
      const greeting = await read(2)
      if (greeting[0] !== 0x05) throw new Error('SOCKS5: the peer did not answer as a SOCKS5 server')
      const method = greeting[1]
      if (method === 0xff) throw new Error('SOCKS5: the proxy rejected every offered authentication method')
      if (method === 0x02) {
        if (!useAuth) throw new Error('SOCKS5: the proxy requires a username and password')
        const user = Buffer.from(username, 'utf8')
        const pass = Buffer.from(password, 'utf8')
        socket.write(Buffer.concat([
          Buffer.from([0x01, user.length]), user,
          Buffer.from([pass.length]), pass,
        ]))
        const auth = await read(2)
        if (auth[1] !== 0x00) throw new Error('SOCKS5: the proxy rejected the username or password')
      } else if (method !== 0x00) {
        throw new Error(`SOCKS5: unsupported authentication method 0x${method.toString(16)}`)
      }

      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00]),
        encodeSocksAddress(targetHost),
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
      ]))

      const header = await read(4)
      if (header[0] !== 0x05) throw new Error('SOCKS5: malformed CONNECT reply')
      if (header[1] !== 0x00) throw new Error(socksReplyMessage(header[1]))
      const atyp = header[3]
      if (atyp === 0x01) await read(4)
      else if (atyp === 0x04) await read(16)
      else if (atyp === 0x03) await read((await read(1))[0])
      else throw new Error('SOCKS5: unknown address type in the CONNECT reply')
      await read(2)

      // Bytes that arrived past the reply belong to the tunnelled stream.
      handOver()

      if (!secure) {
        socket.setKeepAlive(true, 60e3)
        return socket
      }

      const secured = tls.connect({
        ...tlsOptions,
        socket,
        host: targetHost,
        port: targetPort,
        servername: params.servername || (net.isIP(targetHost) === 0 ? targetHost : undefined),
        ALPNProtocols: ['http/1.1'],
      })
      await new Promise((resolve, reject) => {
        secured.once('secureConnect', resolve)
        secured.once('error', reject)
      })
      secured.setKeepAlive(true, 60e3)
      return secured
    }

    handshake().then(
      (result) => {
        result.setNoDelay(true)
        settle(null, result)
      },
      (error) => settle(error),
    )
  }
}

/** Proxy settings the operating system reports. */
function parseWindowsProxyServer(value) {
  const entries = String(value ?? '').split(';').map((entry) => entry.trim()).filter(Boolean)
  if (!entries.length) return {}
  const named = Object.fromEntries(entries.flatMap((entry) => {
    const separator = entry.indexOf('=')
    return separator < 0 ? [] : [[entry.slice(0, separator).toLowerCase(), entry.slice(separator + 1)]]
  }))
  const fallback = entries.find((entry) => !entry.includes('='))
  const normalize = (candidate) => {
    if (!candidate) return undefined
    return /^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`
  }
  return {
    httpProxy: normalize(named.http ?? fallback),
    httpsProxy: normalize(named.https ?? named.http ?? fallback),
  }
}

function readWindowsSystemProxy() {
  const script = [
    "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
    '[pscustomobject]@{',
    'ProxyEnable=[int]$p.ProxyEnable;',
    'ProxyServer=[string]$p.ProxyServer;',
    'ProxyOverride=[string]$p.ProxyOverride;',
    'AutoConfigURL=[string]$p.AutoConfigURL',
    '}|ConvertTo-Json -Compress',
  ].join('')
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const config = JSON.parse(output)
  if (!config.ProxyEnable) {
    if (config.AutoConfigURL) throw new Error('Windows PAC proxy scripts are not supported; choose the custom proxy mode instead')
    return {}
  }
  const proxies = parseWindowsProxyServer(config.ProxyServer)
  if (!proxies.httpProxy && !proxies.httpsProxy) {
    throw new Error('The Windows system proxy is enabled but no proxy server is configured')
  }
  return {
    ...proxies,
    noProxy: String(config.ProxyOverride ?? '')
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && entry !== '<local>')
      .join(','),
  }
}

/** Proxy settings the operating system reports. */
function systemProxyOptions() {
  if (process.platform === 'win32') return readWindowsSystemProxy()
  return {
    httpProxy: inheritedProxyEnvironment.HTTP_PROXY ?? inheritedProxyEnvironment.http_proxy,
    httpsProxy: inheritedProxyEnvironment.HTTPS_PROXY ?? inheritedProxyEnvironment.https_proxy,
    noProxy: inheritedProxyEnvironment.NO_PROXY ?? inheritedProxyEnvironment.no_proxy,
  }
}

/** Build the HTTP(S)-proxy dispatcher: bypass loopback, tunnel everything else. */
function httpProxyDispatcher(settings, noProxy) {
  const uri = httpProxyUrl(settings)
  return new Agent({
    factory(origin, options) {
      const target = origin instanceof URL ? origin : new URL(String(origin))
      if (bypasses(target, noProxy)) return new Pool(target, { ...options, connect: undefined })
      // `proxyTunnel: false` keeps plain-HTTP requests in absolute form instead of
      // demanding a CONNECT tunnel, which is what a browser does and what every
      // local HTTP proxy accepts; HTTPS still upgrades to CONNECT.
      return new ProxyAgent({ ...options, uri, proxyTunnel: false })
    },
  })
}

/** Build the SOCKS dispatcher: every origin tunnels through the SOCKS connector except loopback. */
function socksDispatcher(settings, noProxy) {
  const connector = createSocksConnector(settings)
  return new Agent({
    connect: connector,
    factory(origin, options) {
      const target = origin instanceof URL ? origin : new URL(String(origin))
      return new Pool(target, bypasses(target, noProxy) ? { ...options, connect: undefined } : options)
    },
  })
}

/** The dispatcher one settings value asks for. */
function dispatcherFor(settings, noProxy) {
  if (settings.mode === 'direct') return new Agent()
  if (settings.mode === 'system') {
    const options = systemProxyOptions()
    if (!options.httpProxy && !options.httpsProxy) return new Agent()
    return new EnvHttpProxyAgent(options)
  }
  if (settings.host === '' || settings.port === 0) {
    throw new Error('Set a proxy address and port before choosing the custom proxy mode')
  }
  if (settings.protocol === 'socks5' || settings.protocol === 'socks5h') {
    return socksDispatcher(settings, noProxy)
  }
  return httpProxyDispatcher(settings, noProxy)
}

/** Restore the launch-time proxy environment. */
function restoreInheritedProxyEnvironment() {
  for (const name of PROXY_ENV_NAMES) {
    const value = inheritedProxyEnvironment[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
}

/** Clear every proxy environment name. */
function clearProxyEnvironment() {
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
}

/**
 * Publish the settings to the environment child processes inherit.
 *
 * A SOCKS endpoint is published through `ALL_PROXY` only: `HTTP_PROXY` and
 * `HTTPS_PROXY` carrying a `socks5://` value would break every HTTP-only client
 * (curl reads SOCKS from `ALL_PROXY` and nothing else).
 */
function applyProxyEnvironment(settings, noProxy) {
  if (settings.mode === 'direct') {
    clearProxyEnvironment()
    return
  }
  if (settings.mode === 'system') {
    restoreInheritedProxyEnvironment()
    return
  }
  if (settings.protocol === 'socks5' || settings.protocol === 'socks5h') {
    clearProxyEnvironment()
    const url = socksProxyUrl(settings)
    process.env.ALL_PROXY = url
    process.env.all_proxy = url
  } else {
    const url = httpProxyUrl(settings)
    process.env.HTTP_PROXY = url
    process.env.HTTPS_PROXY = url
    process.env.ALL_PROXY = url
    process.env.http_proxy = url
    process.env.https_proxy = url
    process.env.all_proxy = url
  }
  const inheritedNoProxy = inheritedProxyEnvironment.NO_PROXY ?? inheritedProxyEnvironment.no_proxy
  const value = withLoopback(noProxy === undefined || noProxy === '' ? inheritedNoProxy : noProxy)
  process.env.NO_PROXY = value
  process.env.no_proxy = value
}

export function apply(ctx, config) {
  /** Signature of the settings currently installed. */
  let installed
  /** The dispatcher this plugin installed last, closed when it is replaced. */
  let owned
  /** The dispatcher this plugin replaced, restored on disposal. */
  let previous
  /** Whether the installation has already recorded a failure, to avoid log spam. */
  let reportedFailure

  const sync = () => {
    const settings = resolveSettings(config)
    const signature = JSON.stringify(settings)
    if (signature === installed) return
    const inheritedNoProxy = inheritedProxyEnvironment.NO_PROXY ?? inheritedProxyEnvironment.no_proxy
    let next
    try {
      next = dispatcherFor(settings, inheritedNoProxy)
    } catch (error) {
      if (reportedFailure !== signature) {
        reportedFailure = signature
        ctx.logger.warn(`%s: ${error instanceof Error ? error.message : String(error)}`, LABEL)
      }
      return
    }
    reportedFailure = undefined
    if (installed === undefined) previous = getGlobalDispatcher()
    setGlobalDispatcher(next)
    try {
      applyProxyEnvironment(settings, inheritedNoProxy)
    } catch (error) {
      ctx.logger.warn(`%s: could not publish the proxy environment: ${error instanceof Error ? error.message : String(error)}`, LABEL)
    }
    const stale = owned
    owned = next
    installed = signature
    if (stale !== undefined && stale !== next && typeof stale.close === 'function') {
      // Let in-flight requests finish before the superseded dispatcher closes.
      Promise.resolve(stale.close()).catch(() => {})
    }
    ctx.logger.info('%s: %s', LABEL, describe(settings))
  }

  const describe = (settings) => {
    if (settings.mode === 'direct') return 'direct connection'
    if (settings.mode === 'system') return 'following the system proxy'
    return `custom proxy ${settings.protocol}://${settings.host}:${settings.port}`
  }

  ctx.effect(() => {
    const disposers = [
      // Committed volatile-only edits are announced on the owning fiber.
      ctx.on('loader/volatile-update', () => { sync() }),
      // And every settings form write republishes the document afterwards.
      ctx.on('settings/document-updated', () => { sync() }),
      ctx.on('app-boot/config-reload', () => { sync() }),
    ]
    sync()
    return () => {
      for (const dispose of disposers) dispose()
      if (previous !== undefined && owned !== undefined) {
        setGlobalDispatcher(previous)
        const stale = owned
        owned = undefined
        if (typeof stale.close === 'function') Promise.resolve(stale.close()).catch(() => {})
      }
      restoreInheritedProxyEnvironment()
    }
  }, `${LABEL}: proxy dispatcher`)

  ctx.logger.info('%s: mounted', LABEL)
}

export { createSocksConnector, dispatcherFor, parseWindowsProxyServer, resolveSettings }
