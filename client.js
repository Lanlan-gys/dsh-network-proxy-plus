// dsh-network-proxy-plus — web client half.
//
// Registers one page in Settings (`settings.section`), so the proxy lives in the
// settings sidebar next to 启动动画 / 桌宠配置 instead of hiding inside a row.
//
// The page reads and writes this plugin's own profile entry through the `settings`
// remote namespace, so what it saves is the row's Config, which the Host half applies
// to undici's global dispatcher immediately.
//
// Every color below is one of this build's `--dsw-*` theme tokens; styles are inline
// objects, so unmounting removes them with the component and nothing leaks onto the
// page's stylesheet.

window.__ModuleLoader__.load({
  id: 'dsh-network-proxy-plus',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Profile entry id of this plugin's loader row — also the settings namespace key. */
    const SETTINGS_NS = 'network-proxy-plus'
    const NS = 'settings.networkProxyPlus'
    const MODES = ['system', 'custom', 'direct']
    const PROTOCOLS = ['socks5', 'socks5h', 'http', 'https']
    const PROTOCOL_LABELS = { socks5: 'SOCKS5', socks5h: 'SOCKS5H', http: 'HTTP', https: 'HTTPS' }

    const zh = {
      title: '网络代理',
      nav: '网络代理',
      description: '配置 DeepSeek Harness 访问网络的方式，保存后立即生效。',
      outbound: '网络出口',
      details: '代理地址',
      system: '跟随系统',
      custom: '自定义代理',
      direct: '直连',
      type: '类型',
      address: '地址',
      port: '端口',
      apply: '应用',
      saving: '正在应用…',
      ready: '已生效',
      invalidPort: '端口必须是 1–65535 之间的整数',
      invalidAddress: '请填写代理地址，例如 127.0.0.1',
      unavailable: '网络代理设置不可用',
      hint: '回环地址（localhost、127.0.0.1、::1、0.0.0.0）始终直连，不会经过代理，因此本地服务与内网地址不受影响。',
      systemHint: '读取操作系统当前的代理设置；Windows 下不支持 PAC 自动配置脚本。',
      directHint: '忽略所有代理设置，全部直接连接。',
      customHint: 'SOCKS5 只写入 ALL_PROXY 给子进程，HTTP(S) 代理另外写入 HTTP_PROXY / HTTPS_PROXY。',
    }
    const en = {
      title: 'Network proxy',
      nav: 'Network proxy',
      description: 'Configure how DeepSeek Harness reaches the network; changes apply immediately.',
      outbound: 'Outbound',
      details: 'Proxy endpoint',
      system: 'Follow system',
      custom: 'Custom proxy',
      direct: 'Direct',
      type: 'Type',
      address: 'Address',
      port: 'Port',
      apply: 'Apply',
      saving: 'Applying…',
      ready: 'Active',
      invalidPort: 'The port must be an integer between 1 and 65535',
      invalidAddress: 'Enter a proxy address, for example 127.0.0.1',
      unavailable: 'Network proxy settings are unavailable',
      hint: 'Loopback addresses (localhost, 127.0.0.1, ::1, 0.0.0.0) always connect directly, so local services and intranet hosts are never routed through the proxy.',
      systemHint: 'Reads the operating system proxy. Windows PAC scripts are not supported.',
      directHint: 'Ignore every proxy setting and connect directly.',
      customHint: 'SOCKS5 publishes ALL_PROXY for child processes; HTTP(S) proxies also publish HTTP_PROXY / HTTPS_PROXY.',
    }

    /** Clone-on-update snapshot store, read through `useSyncExternalStore`. */
    function createSnapshotStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        update(recipe) {
          const next = { ...state }
          recipe(next)
          state = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    const EMPTY = {
      status: 'idle',
      error: null,
      writable: false,
      mode: 'custom',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 10809,
      revision: 0,
      saved: 0,
    }

    function messageOf(responseOrError) {
      if (responseOrError && typeof responseOrError === 'object' && 'ok' in responseOrError) {
        const error = responseOrError.error
        if (typeof error === 'string') return error
        if (error && typeof error.message === 'string') return error.message
        return 'request failed'
      }
      if (responseOrError instanceof Error) return responseOrError.message
      return String(responseOrError)
    }

    class NetworkProxyController {
      constructor(remote) {
        this.remote = remote
        this.view = undefined
        this.generation = 0
        this.store = createSnapshotStore(EMPTY)
      }

      async load() {
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        try {
          const response = await this.remote.settings.describe()
          if (generation !== this.generation) return
          if (!response || response.ok !== true) throw new Error(messageOf(response))
          const view = (response.value?.namespaces ?? []).find((entry) => entry.ns === SETTINGS_NS)
          if (!view) {
            this.view = undefined
            this.store.update((state) => { state.status = 'unavailable'; state.writable = false })
            return
          }
          this.accept(view, response.value?.writable !== false)
        } catch (error) {
          if (generation !== this.generation) return
          this.fail(error)
        }
      }

      async save(patch) {
        if (!this.view || !this.store.getSnapshot().writable) return
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'saving'; state.error = null })
        try {
          const ops = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
          const response = await this.remote.settings.mutate(SETTINGS_NS, ops, this.view.revision)
          if (generation !== this.generation) return
          if (!response || response.ok !== true) throw new Error(messageOf(response))
          this.accept(response.value, true)
        } catch (error) {
          if (generation !== this.generation) return
          this.store.update((state) => { state.status = 'error'; state.error = messageOf(error) })
          // A rejected write leaves the stored form authoritative; re-read it once.
          this.load()
        }
      }

      accept(view, writable) {
        if (!view || typeof view !== 'object') return
        const value = view.value && typeof view.value === 'object' ? view.value : {}
        const saved = this.store.getSnapshot().saved
        this.view = view
        this.store.update((state) => {
          state.status = 'ready'
          state.error = null
          state.writable = writable
          state.mode = MODES.includes(value.mode) ? value.mode : 'custom'
          state.protocol = PROTOCOLS.includes(value.protocol) ? value.protocol : 'socks5'
          state.host = typeof value.host === 'string' ? value.host : '127.0.0.1'
          const port = Number(value.port)
          state.port = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 10809
          state.revision = typeof view.revision === 'number' ? view.revision : 0
          state.saved = saved + 1
        })
      }

      fail(error) {
        this.store.update((state) => {
          state.status = 'error'
          state.error = messageOf(error)
        })
      }

      dispose() {
        this.generation += 1
        this.view = undefined
      }
    }

    const CSS = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        padding: '4px 0 24px',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      head: { display: 'flex', flexDirection: 'column', gap: '6px' },
      title: { fontSize: '18px', lineHeight: '26px', fontWeight: '600' },
      description: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '18px 20px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardTitle: { fontSize: '13px', lineHeight: '20px', fontWeight: '600' },
      modes: { display: 'inline-flex', alignSelf: 'flex-start', gap: '2px', padding: '3px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '9px', background: 'var(--dsw-alias-bg-layer-2)' },
      mode: {
        height: '32px',
        padding: '0 14px',
        border: '0',
        borderRadius: '7px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '13px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      modeActive: {
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: '600',
        boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
      },
      fieldRow: { display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: '12px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '16px' },
      input: {
        boxSizing: 'border-box',
        height: '36px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '0 11px',
        font: 'inherit',
        fontSize: '13px',
        outline: 'none',
      },
      apply: {
        height: '36px',
        padding: '0 18px',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: '8px',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: '500',
        cursor: 'pointer',
      },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
      status: { fontSize: '12px', lineHeight: '18px' },
    }

    function hintFor(mode, t) {
      if (mode === 'system') return t('systemHint')
      if (mode === 'direct') return t('directHint')
      return t('customHint')
    }

    function NetworkProxyPage({ controller, useProxy, t }) {
      const state = useProxy((snapshot) => snapshot)
      const [draft, setDraft] = React.useState({})

      React.useEffect(() => { controller.load() }, [controller])
      React.useEffect(() => { setDraft({}) }, [state.saved])

      const busy = state.status === 'loading' || state.status === 'saving'
      const disabled = busy || !state.writable
      const protocol = draft.protocol ?? state.protocol
      const host = draft.host ?? state.host
      const port = draft.port ?? String(state.port)
      const portNumber = Number(port)
      const portValid = /^\d+$/.test(port.trim()) && portNumber >= 1 && portNumber <= 65535
      const hostValid = host.trim() !== ''
      const changed = protocol !== state.protocol || host.trim() !== state.host || portNumber !== state.port
      const canApply = !disabled && portValid && hostValid && changed

      const chooseMode = (mode) => {
        if (mode === state.mode || disabled) return
        controller.save({ mode })
      }
      const applyCustom = (event) => {
        event.preventDefault()
        if (!canApply) return
        controller.save({ mode: 'custom', protocol, host: host.trim(), port: portNumber })
      }

      if (state.status === 'unavailable') {
        return h('div', { style: CSS.page },
          h('div', { style: CSS.head }, h('div', { style: CSS.title }, t('title'))),
          h('div', { style: CSS.card }, h('div', { style: CSS.hint }, t('unavailable'))),
        )
      }

      const status = state.error
        || (state.status === 'saving' ? t('saving') : state.status === 'ready' && state.saved > 1 ? t('ready') : '')
      const statusColor = state.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'

      return h('div', { style: CSS.page },
        h('div', { style: CSS.head },
          h('div', { style: CSS.title }, t('title')),
          h('div', { style: CSS.description }, t('description')),
        ),
        h('div', { style: CSS.card },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { style: CSS.cardTitle }, t('outbound')),
            h('div', { style: CSS.modes, role: 'radiogroup', 'aria-label': t('outbound') },
              MODES.map((mode) => h('button', {
                key: mode,
                type: 'button',
                role: 'radio',
                'aria-checked': state.mode === mode,
                disabled,
                style: { ...CSS.mode, ...(state.mode === mode ? CSS.modeActive : null) },
                onClick: () => chooseMode(mode),
              }, t(mode))),
            ),
            h('div', { style: CSS.hint }, hintFor(state.mode, t)),
          ),
          state.mode === 'custom' && h('form', { style: { display: 'flex', flexDirection: 'column', gap: '12px' }, onSubmit: applyCustom },
            h('div', { style: CSS.cardTitle }, t('details')),
            h('div', { style: CSS.fieldRow },
              h('label', { style: CSS.field },
                h('span', { style: CSS.label }, t('type')),
                h('select', {
                  style: { ...CSS.input, cursor: disabled ? 'default' : 'pointer', minWidth: '120px' },
                  value: protocol,
                  disabled,
                  onChange: (event) => setDraft((current) => ({ ...current, protocol: event.target.value })),
                }, PROTOCOLS.map((option) => h('option', { key: option, value: option }, PROTOCOL_LABELS[option]))),
              ),
              h('label', { style: { ...CSS.field, flex: '1 1 160px', minWidth: '140px' } },
                h('span', { style: CSS.label }, t('address')),
                h('input', {
                  style: CSS.input,
                  type: 'text',
                  value: host,
                  disabled,
                  spellCheck: false,
                  autoComplete: 'off',
                  placeholder: '127.0.0.1',
                  onChange: (event) => setDraft((current) => ({ ...current, host: event.target.value })),
                }),
              ),
              h('label', { style: CSS.field },
                h('span', { style: CSS.label }, t('port')),
                h('input', {
                  style: { ...CSS.input, width: '104px' },
                  type: 'text',
                  inputMode: 'numeric',
                  value: port,
                  disabled,
                  placeholder: '10809',
                  onChange: (event) => setDraft((current) => ({ ...current, port: event.target.value })),
                }),
              ),
              h('button', {
                type: 'submit',
                style: { ...CSS.apply, opacity: canApply ? '1' : '0.5', cursor: canApply ? 'pointer' : 'default' },
                disabled: !canApply,
              }, t('apply')),
            ),
            port.trim() !== '' && !portValid && h('div', {
              style: { ...CSS.status, color: 'var(--dsw-alias-state-error-primary)' },
              role: 'alert',
            }, t('invalidPort')),
            host.trim() === '' && h('div', {
              style: { ...CSS.status, color: 'var(--dsw-alias-state-error-primary)' },
              role: 'alert',
            }, t('invalidAddress')),
          ),
          status !== '' && h('div', {
            style: { ...CSS.status, color: statusColor },
            role: state.error ? 'alert' : 'status',
          }, status),
        ),
        h('div', { style: CSS.hint }, t('hint')),
      )
    }

    const inject = ['slots', 'locale', 'remote', 'remote.settings']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'network-proxy-plus: dictionaries')
      const t = ctx.locale.bind(NS)
      const controller = new NetworkProxyController(ctx.remote)
      const useProxy = (selector) => React.useSyncExternalStore(
        (listener) => controller.store.subscribe(listener),
        () => selector(controller.store.getSnapshot()),
        () => selector(controller.store.getSnapshot()),
      )
      ctx.effect(() => () => { controller.dispose() }, 'network-proxy-plus: controller')
      // The inject faces travel by closure, so the page only relies on the
      // registration options the slot documents (`id`, `order`, `label`).
      const Page = () => h(NetworkProxyPage, { controller, useProxy, t })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'network-proxy-plus',
        order: 28,
        label: () => t('nav'),
      }, Page))
    }

    return { inject, apply }
  },
})
