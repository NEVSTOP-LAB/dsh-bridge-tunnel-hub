/**
 * 设置页的浏览器半边：状态、立即更新、配置、最近 24 小时日志。
 *
 * 页面数据全部来自同源的 Host 路由（`/__dsh-bridge-tunnel-hub/*`），不读浏览器存储，
 * 也不依赖其它插件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bridge-tunnel-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const LOCALE_NS = 'bridgeTunnelHub'
    const API = {
      status: '/__dsh-bridge-tunnel-hub/status',
      logs: '/__dsh-bridge-tunnel-hub/logs',
      publish: '/__dsh-bridge-tunnel-hub/publish',
      config: '/__dsh-bridge-tunnel-hub/config',
    }
    const LOG_HOURS = 24
    const REFRESH_MS = 15000

    const zh = {
      title: '隧道地址汇总',
      intro: '把本机 dsh-bridge 的公网隧道地址写进一个 Gist，并在这里手动刷新、改配置、看运行日志。',
      status: '当前状态',
      machine: '机器名',
      address: '公网地址',
      lastPublish: '最近一次上报',
      nextHeartbeat: '下次整点刷新',
      lastError: '最近错误',
      gist: '汇总 Gist',
      openGist: '打开 Gist',
      none: '（无）',
      publishNow: '立即更新',
      publishing: '正在更新…',
      refresh: '刷新',
      published: '已提交更新',
      config: '配置',
      configHint: '保存后插件会按新配置重新加载；token 留空表示继续使用本机 gh 登录。',
      save: '保存配置',
      saving: '正在保存…',
      saved: '已保存，插件正在重新加载',
      tokenConfigured: '已设置（留空保持不变）',
      tokenHint: '留空时使用本机 gh 登录；多台机器写同一个 Gist 需同一账号的 token',
      logs: '运行日志（最近 24 小时）',
      logsHint: '只显示最近 24 小时；日志文件按大小轮转，不会无限增长。',
      logsEmpty: '最近 24 小时没有日志',
      logFile: '日志文件',
      secondsAgo: '{n} 秒前',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      daysAgo: '{n} 天前',
      loadFailed: '读取失败：',
      missingHost: '本机 Host 路由未就绪，稍后刷新重试。',
      field_machineName: '机器名',
      field_gistUrl: 'Gist 链接',
      field_gistId: 'Gist ID',
      field_token: 'GitHub token',
      field_heartbeatHours: '整点刷新间隔（小时，0 关闭）',
      field_scanIntervalSec: '扫描间隔（秒）',
      field_probeTimeoutMs: '探活超时（毫秒）',
      field_autoPublish: '自动上报',
      field_manualUrl: '手动地址（兜底）',
      field_logPath: 'cloudflared 日志路径',
      field_bridgeConfigPath: 'dsh-bridge 配置路径',
    }

    const en = {
      title: 'Bridge tunnel hub',
      intro: "Publishes this machine's dsh-bridge tunnel address into a gist; refresh, reconfigure and read logs here.",
      status: 'Status',
      machine: 'Machine',
      address: 'Public address',
      lastPublish: 'Last publish',
      nextHeartbeat: 'Next hourly refresh',
      lastError: 'Last error',
      gist: 'Registry gist',
      openGist: 'Open gist',
      none: '(none)',
      publishNow: 'Publish now',
      publishing: 'Publishing…',
      refresh: 'Refresh',
      published: 'Update submitted',
      config: 'Configuration',
      configHint: 'Saving reloads the plugin with the new configuration; leave the token empty to keep using the local gh login.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; the plugin is reloading',
      tokenConfigured: 'Configured (leave empty to keep)',
      tokenHint: 'Leave empty to use the local gh login; every machine writing one gist needs a token of the same account',
      logs: 'Logs (last 24 hours)',
      logsHint: 'Only the last 24 hours are shown. The log file rotates by size and never grows without bound.',
      logsEmpty: 'No log entries in the last 24 hours',
      logFile: 'Log file',
      secondsAgo: '{n}s ago',
      minutesAgo: '{n}m ago',
      hoursAgo: '{n}h ago',
      daysAgo: '{n}d ago',
      loadFailed: 'Load failed: ',
      missingHost: 'Host routes are not ready yet; refresh later.',
      field_machineName: 'Machine name',
      field_gistUrl: 'Gist URL',
      field_gistId: 'Gist ID',
      field_token: 'GitHub token',
      field_heartbeatHours: 'Hourly refresh interval (hours, 0 disables)',
      field_scanIntervalSec: 'Scan interval (seconds)',
      field_probeTimeoutMs: 'Probe timeout (ms)',
      field_autoPublish: 'Auto publish',
      field_manualUrl: 'Manual address (fallback)',
      field_logPath: 'cloudflared log path',
      field_bridgeConfigPath: 'dsh-bridge config path',
    }

    const FIELD_ORDER = [
      'machineName', 'gistUrl', 'gistId', 'token',
      'heartbeatHours', 'scanIntervalSec', 'probeTimeoutMs', 'autoPublish',
      'manualUrl', 'logPath', 'bridgeConfigPath',
    ]
    const NUMBER_FIELDS = new Set(['heartbeatHours', 'scanIntervalSec', 'probeTimeoutMs'])

    async function api(path, options) {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || `HTTP ${response.status}`)
      }
      return body
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function formatTime(iso) {
      if (!iso) return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return iso
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    }

    function formatAge(iso, t) {
      if (!iso) return ''
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 60) return t('secondsAgo').replace('{n}', String(seconds))
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('minutesAgo').replace('{n}', String(minutes))
      const hours = Math.round(minutes / 60)
      if (hours < 48) return t('hoursAgo').replace('{n}', String(hours))
      return t('daysAgo').replace('{n}', String(Math.round(hours / 24)))
    }

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        padding: '8px 4px 32px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      intro: {
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.6,
        maxWidth: 720,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      sectionTitle: {
        fontSize: 13,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      },
      row: {
        display: 'grid',
        gridTemplateColumns: '132px 1fr',
        gap: 12,
        alignItems: 'baseline',
      },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      value: { wordBreak: 'break-all', lineHeight: 1.5 },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '5px 14px',
        fontSize: 12,
        cursor: 'pointer',
      },
      primaryButton: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        borderRadius: 6,
        padding: '5px 14px',
        fontSize: 12,
        cursor: 'pointer',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '5px 8px',
        fontSize: 12,
      },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: 1.5 },
      message: { fontSize: 12, lineHeight: 1.5 },
      logs: {
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 320,
        overflowY: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      logRow: { display: 'grid', gridTemplateColumns: '132px 48px 1fr', gap: 8, lineHeight: 1.5 },
      logTime: { color: 'var(--dsw-alias-label-secondary)' },
      levelInfo: { color: 'var(--dsw-alias-state-success-primary)' },
      levelWarn: { color: 'var(--dsw-alias-state-warn-primary)' },
      levelError: { color: 'var(--dsw-alias-state-error-primary)' },
      link: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none' },
    }

    function levelStyle(level) {
      if (level === 'warn') return styles.levelWarn
      if (level === 'error') return styles.levelError
      return styles.levelInfo
    }

    function ValueRow({ label, children }) {
      return h('div', { style: styles.row },
        h('div', { style: styles.label }, label),
        h('div', { style: styles.value }, children))
    }

    function formFrom(config) {
      const form = {}
      for (const key of FIELD_ORDER) form[key] = config[key] === undefined ? '' : String(config[key])
      form.autoPublish = config.autoPublish !== false
      return form
    }

    function SettingsPage(_props) {
      const [status, setStatus] = useState(null)
      const [config, setConfig] = useState(null)
      const [form, setForm] = useState(null)
      const [logs, setLogs] = useState([])
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)

      const t = _props && typeof _props.t === 'function' ? _props.t : (key) => key

      const loadStatus = useCallback(async () => {
        try {
          const data = await api(API.status)
          setStatus(data.status)
          setConfig(data.config)
          setForm((current) => current ?? formFrom(data.config))
        } catch (error) {
          setMessage({ kind: 'error', text: t('loadFailed') + (error && error.message ? error.message : String(error)) })
        }
      }, [t])

      const loadLogs = useCallback(async () => {
        try {
          const data = await api(`${API.logs}?hours=${LOG_HOURS}&limit=300`)
          setLogs(Array.isArray(data.entries) ? data.entries : [])
        } catch {
          // 日志读取失败不打断页面
        }
      }, [])

      useEffect(() => {
        void loadStatus()
        void loadLogs()
        const timer = setInterval(() => {
          void loadStatus()
          void loadLogs()
        }, REFRESH_MS)
        return () => clearInterval(timer)
      }, [loadStatus, loadLogs])

      const publishNow = useCallback(async () => {
        setBusy('publish')
        setMessage(null)
        try {
          await api(API.publish, { method: 'POST', body: '{}' })
          setMessage({ kind: 'ok', text: t('published') })
          await loadStatus()
          await loadLogs()
        } catch (error) {
          setMessage({ kind: 'error', text: t('loadFailed') + (error && error.message ? error.message : String(error)) })
        } finally {
          setBusy('')
        }
      }, [loadStatus, loadLogs, t])

      const saveConfig = useCallback(async () => {
        if (!form) return
        setBusy('save')
        setMessage(null)
        const patch = {}
        for (const key of FIELD_ORDER) {
          if (key === 'token' && form.token === '' && config && config.tokenConfigured) continue
          if (key === 'token' && form.token === '') continue
          if (key === 'autoPublish') patch[key] = Boolean(form[key])
          else if (NUMBER_FIELDS.has(key)) {
            const parsed = Number(form[key])
            if (Number.isFinite(parsed)) patch[key] = parsed
          } else if (form[key] !== '') patch[key] = form[key]
          else patch[key] = ''
        }
        try {
          await api(API.config, { method: 'POST', body: JSON.stringify(patch) })
          setMessage({ kind: 'ok', text: t('saved') })
          setTimeout(() => { void loadStatus() }, 1500)
        } catch (error) {
          setMessage({ kind: 'error', text: t('loadFailed') + (error && error.message ? error.message : String(error)) })
        } finally {
          setBusy('')
        }
      }, [form, config, loadStatus, t])

      if (!status || !form) {
        return h('div', { style: styles.page },
          h('div', { style: styles.sectionTitle }, t('title')),
          h('div', { style: styles.intro }, message ? message.text : t('missingHost')))
      }

      const tunnel = status.tunnel || {}
      const publish = status.publish || {}
      const heartbeat = status.heartbeat || {}
      const gist = status.gist || {}

      return h('div', { style: styles.page },
        h('div', { style: styles.sectionTitle }, t('title')),
        h('div', { style: styles.intro }, t('intro')),

        h('div', { style: styles.card },
          h('div', { style: styles.sectionTitle }, t('status')),
          h(ValueRow, { label: t('machine') }, (status.machine && status.machine.name) || ''),
          h(ValueRow, { label: t('address') },
            tunnel.url
              ? h('a', { href: tunnel.url, target: '_blank', rel: 'noreferrer', style: styles.link }, tunnel.url)
              : t('none')),
          h(ValueRow, { label: t('lastPublish') },
            publish.ok
              ? `${formatTime(publish.at)}（${formatAge(publish.at, t)}）`
              : (publish.error || t('none'))),
          h(ValueRow, { label: t('nextHeartbeat') }, heartbeat.nextAt ? formatTime(heartbeat.nextAt) : t('none')),
          publish.error ? h(ValueRow, { label: t('lastError') }, h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, publish.error)) : null,
          h(ValueRow, { label: t('gist') },
            gist.url
              ? h('a', { href: gist.url, target: '_blank', rel: 'noreferrer', style: styles.link }, gist.id || t('openGist'))
              : t('none')),
          h('div', { style: styles.actions },
            h('button', {
              type: 'button',
              style: styles.primaryButton,
              disabled: busy === 'publish',
              onClick: () => { void publishNow() },
            }, busy === 'publish' ? t('publishing') : t('publishNow')),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy !== '',
              onClick: () => { void loadStatus(); void loadLogs() },
            }, t('refresh'))),
          message ? h('div', { style: { ...styles.message, color: message.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, message.text) : null),

        h('div', { style: styles.card },
          h('div', { style: styles.sectionTitle }, t('config')),
          h('div', { style: styles.hint }, t('configHint')),
          ...FIELD_ORDER.map((key) => {
            const value = form[key]
            if (key === 'autoPublish') {
              return h('label', { key, style: { ...styles.row, cursor: 'pointer' } },
                h('span', { style: styles.label }, t('field_' + key)),
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(value),
                  onChange: (event) => setForm((current) => ({ ...current, [key]: event.target.checked })),
                }))
            }
            const isNumber = NUMBER_FIELDS.has(key)
            const placeholder = key === 'token' && config && config.tokenConfigured ? t('tokenConfigured') : ''
            return h('label', { key, style: styles.row },
              h('span', { style: styles.label }, t('field_' + key)),
              h('span', null,
                h('input', {
                  style: styles.input,
                  type: key === 'token' ? 'password' : (isNumber ? 'number' : 'text'),
                  value: value,
                  placeholder,
                  onChange: (event) => setForm((current) => ({ ...current, [key]: event.target.value })),
                }),
                key === 'token' ? h('div', { style: styles.hint }, t('tokenHint')) : null))
          }),
          h('div', { style: styles.actions },
            h('button', {
              type: 'button',
              style: styles.primaryButton,
              disabled: busy === 'save',
              onClick: () => { void saveConfig() },
            }, busy === 'save' ? t('saving') : t('save')))),

        h('div', { style: styles.card },
          h('div', { style: styles.sectionTitle }, t('logs')),
          h('div', { style: styles.hint }, t('logsHint')),
          logs.length === 0
            ? h('div', { style: styles.hint }, t('logsEmpty'))
            : h('ul', { style: styles.logs }, ...logs.map((entry, index) => h('li', {
                key: `${entry.t}-${index}`,
                style: styles.logRow,
              },
              h('span', { style: styles.logTime }, formatTime(entry.t)),
              h('span', { style: levelStyle(entry.level) }, entry.level),
              h('span', null, entry.msg)))),
          (status.files && status.files.logs)
            ? h('div', { style: styles.hint }, `${t('logFile')}: ${status.files.logs}`)
            : null))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(LOCALE_NS)
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'bridge-tunnel-hub: dictionaries')

        ctx.effect(
          () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'bridge-tunnel-hub',
            order: 26,
            label: () => t('title'),
            locale: LOCALE_NS,
          }, (props) => h(SettingsPage, { ...props, t }))),
          'bridge-tunnel-hub: settings section',
        )

        ctx.effect(
          () => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
            name: 'settings.section.icon',
            id: 'bridge-tunnel-hub',
            order: 26,
          }, (props) => h('svg', {
            viewBox: '0 0 24 24',
            width: (props && props.size) || 16,
            height: (props && props.size) || 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            'aria-hidden': true,
          },
          h('circle', { cx: 12, cy: 12, r: 3.2 }),
          h('path', { d: 'M12 8.8V4M12 15.2V20M8.8 12H4M15.2 12H20' })))),
          'bridge-tunnel-hub: settings icon',
        )
      },
    }
  },
})
