/**
 * dsh-context-guard 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * 提供一个界面：
 *  - settings.section「压缩阈值」：配置 context-guard 的上下文压力阈值。
 *
 * 阈值按供应商（provider）挂钩、使用绝对 token 数（如 300000）而非百分比：
 *  - 默认阈值：所有未单独配置的供应商生效；
 *  - 供应商阈值：按 provider 覆盖默认值。
 *
 * 数据通道：remote.settings.*（settings Host Remote）读写 host 侧注册的
 * `context-guard` settings 命名空间；host 插件实时 watch，保存即生效。
 * 样式使用 --dsw-* 主题变量，跟随全局亮/暗主题。
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback } = React

    // ── 文案 ────────────────────────────────────────────────────────────────

    const T = {
      sectionLabel: '压缩阈值',
      hint: '上下文压力达到阈值时提醒 agent 收尾（hook 1）。阈值按供应商配置，使用绝对 token 数（如 300000）；未配置的供应商使用默认阈值；两者都未配置时回退到插件配置的百分比。',
      defaultLabel: '默认阈值（tokens）',
      defaultPlaceholder: '如 300000；留空或 0 = 未配置',
      providerLabel: '供应商',
      providerPlaceholder: '如 deepseek',
      thresholdLabel: '阈值（tokens）',
      thresholdPlaceholder: '如 300000',
      add: '添加供应商',
      save: '保存',
      saved: '已保存',
      saveFailed: '保存失败：',
      loadFailed: '无法读取设置（host 未加载 context-guard？）：',
      empty: '（未配置任何供应商阈值）',
      remove: '移除',
      tokensHint: '提示：配置值以 token 数为准；不同供应商的上下文窗口不同，绝对值比百分比更可控。',
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const css = [
      '/* dsh-context-guard: 压缩阈值设置分节 */',
      '.cg-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.cg-hint{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.cg-field{display:flex;flex-direction:column;gap:6px}',
      '.cg-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.cg-input{box-sizing:border-box;width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.cg-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cg-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center}',
      '.cg-row+.cg-row{margin-top:8px}',
      '.cg-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
      '.cg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.cg-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.cg-btn.danger{color:var(--dsw-alias-state-error-primary)}',
      '.cg-status{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.cg-status.error{color:var(--dsw-alias-state-error-primary)}',
      '.cg-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
    ].join('\n')

    /** 设置分节表单：默认阈值 + 按供应商的绝对 token 阈值。 */
    function ThresholdSection({ api }) {
      const remote = api?.settings
      const [defaultTokens, setDefaultTokens] = useState('')
      const [rows, setRows] = useState([])
      const [revision, setRevision] = useState(undefined)
      const [status, setStatus] = useState(null)

      const load = useCallback(async () => {
        try {
          const answer = await remote.describe()
          const view = (answer.namespaces ?? []).find(ns => ns.ns === 'context-guard')
          if (view === undefined) {
            setStatus({ error: true, text: 'context-guard 命名空间未注册（host 插件未加载？）' })
            return
          }
          const value = view.value ?? {}
          setDefaultTokens(value.defaultThresholdTokens > 0 ? String(value.defaultThresholdTokens) : '')
          setRows((value.providerThresholds ?? []).map(entry => ({
            provider: entry.provider,
            thresholdTokens: String(entry.thresholdTokens),
          })))
          setRevision(view.revision)
          setStatus(null)
        } catch (error) {
          setStatus({ error: true, text: T.loadFailed + String(error?.message ?? error) })
        }
      }, [remote])

      useEffect(() => { void load() }, [load])

      const save = async () => {
        const providerThresholds = rows
          .filter(row => row.provider.trim().length > 0)
          .map(row => ({
            provider: row.provider.trim(),
            thresholdTokens: Number(row.thresholdTokens),
          }))
        const patch = {
          defaultThresholdTokens: Number(defaultTokens) > 0 ? Number(defaultTokens) : 0,
          providerThresholds,
        }
        try {
          const view = await remote.update('context-guard', patch, revision)
          setRevision(view.revision)
          setStatus({ error: false, text: T.saved })
        } catch (error) {
          setStatus({ error: true, text: T.saveFailed + String(error?.message ?? error) })
        }
      }

      const setRow = (index, field, value) => {
        setRows(rows.map((row, i) => i === index ? { ...row, [field]: value } : row))
      }

      return React.createElement('div', { className: 'cg-root' },
        React.createElement('style', null, css),
        React.createElement('div', { className: 'cg-hint' }, T.hint),
        React.createElement('div', { className: 'cg-field' },
          React.createElement('label', { className: 'cg-label' }, T.defaultLabel),
          React.createElement('input', {
            className: 'cg-input',
            type: 'number',
            min: 0,
            step: 1,
            placeholder: T.defaultPlaceholder,
            value: defaultTokens,
            onChange: e => setDefaultTokens(e.target.value),
          }),
        ),
        React.createElement('div', { className: 'cg-field' },
          React.createElement('label', { className: 'cg-label' }, T.providerLabel),
          rows.length === 0
            ? React.createElement('div', { className: 'cg-empty' }, T.empty)
            : rows.map((row, index) => React.createElement('div', { className: 'cg-row', key: index },
                React.createElement('input', {
                  className: 'cg-input',
                  placeholder: T.providerPlaceholder,
                  value: row.provider,
                  onChange: e => setRow(index, 'provider', e.target.value),
                }),
                React.createElement('input', {
                  className: 'cg-input',
                  type: 'number',
                  min: 1,
                  step: 1,
                  placeholder: T.thresholdPlaceholder,
                  value: row.thresholdTokens,
                  onChange: e => setRow(index, 'thresholdTokens', e.target.value),
                }),
                React.createElement('button', {
                  className: 'cg-btn danger',
                  onClick: () => setRows(rows.filter((_, i) => i !== index)),
                }, T.remove),
              )),
        ),
        React.createElement('div', { className: 'cg-row', style: { gridTemplateColumns: '1fr auto' } },
          React.createElement('button', {
            className: 'cg-btn',
            onClick: () => setRows([...rows, { provider: '', thresholdTokens: '' }]),
          }, T.add),
          React.createElement('button', { className: 'cg-btn primary', onClick: () => void save() }, T.save),
        ),
        status !== null
          ? React.createElement('div', { className: status.error ? 'cg-status error' : 'cg-status' }, status.text)
          : null,
        React.createElement('div', { className: 'cg-hint' }, T.tokensHint),
      )
    }

    const inject = ['remote']

    async function apply(ctx) {
      const remote = ctx.remote
      if (remote === undefined || typeof remote.settings?.describe !== 'function') return
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const dispose = slots.inject('settings.section', () => {
        const register = slots.register({
          name: 'settings.section',
          id: 'context-guard',
          order: 32,
          label: T.sectionLabel,
          inject: () => ({ settings: remote.settings }),
        }, ThresholdSection)
        return () => { register() }
      })
      ctx.effect(() => () => { dispose() }, 'context-guard: settings section')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
