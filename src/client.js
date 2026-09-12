/**
 * dsh-context-guard 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * 提供一个界面：
 *  - settings.section「上下文守卫」：
 *      1) 压缩阈值：按供应商（provider）配置绝对 token 阈值，决定何时提醒收尾；
 *      2) 接力摘要：压缩时生成的确定性摘要文档（大小、预算比例、跨次继承等）；
 *      3) 续跑与收尾：压缩完成后的续跑分级策略与两段可编辑提示词。
 *
 * 阈值按供应商挂钩、使用绝对 token 数（如 300000）而非百分比：
 *  - 默认阈值：所有未单独配置的供应商生效；
 *  - 供应商阈值：按 provider 覆盖默认值。
 * 供应商列表来自 dsh 的 LLM 目录（remote.llm.listProviders()，即当前实际
 * 注册/激活的提供方）；llm remote 不可用时降级为手输文本框。
 *
 * 数据通道：remote.settings.*（settings Host Remote）读写 host 侧注册的
 * `context-guard` settings 命名空间；更新是**稀疏 patch**（只发本面板拥有的
 * 字段），host 插件实时 watch，保存即生效。提示词留空 = 关闭该注入，
 * 「填入默认」把组合层（base）的文本填回输入框。
 *
 * 样式使用 --dsw-* 主题变量，跟随全局亮/暗主题。
 */

window.__ModuleLoader__.load({
  id: '@feiyueve/dsh-context-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback } = React

    // ── 文案 ────────────────────────────────────────────────────────────────

    const T = {
      sectionLabel: '上下文守卫',
      hint: '上下文压力达到阈值时提醒 agent 收尾（hook 1）。阈值按供应商配置，使用绝对 token 数（如 300000）；未配置的供应商使用默认阈值；两者都未配置时回退到插件配置的百分比。',
      defaultLabel: '默认阈值（tokens）',
      defaultPlaceholder: '如 300000；留空或 0 = 未配置',
      providerLabel: '供应商',
      providerPlaceholder: '选择供应商',
      thresholdLabel: '阈值（tokens）',
      thresholdPlaceholder: '如 300000',
      add: '添加供应商',
      save: '保存',
      saved: '已保存',
      saveFailed: '保存失败：',
      loadFailed: '无法读取设置（host 未加载 context-guard？）：',
      empty: '（未配置任何供应商阈值）',
      remove: '移除',
      providersFailed: '供应商列表读取失败：',
      tokensHint: '提示：配置值以 token 数为准；不同供应商的上下文窗口不同，绝对值比百分比更可控。',

      // 接力摘要
      digestTitle: '接力摘要',
      digestHint: '压缩时把被裁区间确定性抽取成一份精简事实摘要（零模型调用），落盘为 epoch-<N>.digest.md；续跑提示会让 agent 先读它，需要细节再去会话日志里检索。',
      digestEnabled: '生成摘要文档',
      digestMaxTokens: '摘要上限（tokens）',
      digestMaxTokensHint: '摘要正文字数上限，默认 800。数值越大信息越多、回读越贵。',
      digestTargetRatio: '预算比例（被裁区间的占比）',
      digestTargetRatioHint: '预算 = min(上限, 被裁区间估算 tokens × 比例)，默认 0.45；预算越大摘要越完整。',
      digestCarryForward: '继承上一次摘要',
      digestCarryForwardHint: '把上一次摘要里仍然有效的事实（意图/文件/报错等）带进新摘要，否则第二段压缩会丢掉更早的历史。',
      digestEstimator: '计价方式',
      digestEstimatorHint: 'cjk：中文按 ~2 字/token 计价（更接近真实）；ascii：与宿主一致按 4 字符/token。',
      rawExcludeInjected: '归档中剔除宿主重发注入',
      rawExcludeInjectedHint: '剔除系统提示/AGENTS.md/skill 目录等每轮重发的内容。默认关闭（归档保持无损）。',
      writeRawArchive: '写完整原文归档',
      writeRawArchiveHint: '把被裁区间逐字另存为 epoch-<N>.raw.md。默认关闭：这份原文重录的体量与被压缩掉的上下文相当（实测一段 401 消息的区间 ≈286 KB / ≈106k tokens），整份读回等于把刚腾出的空间又填满；要细节请改从会话日志检索。',
      archiveLayout: '归档布局',
      archiveLayoutHint: 'session：按会话分目录（sessions/<会话id>/，推荐）；flat：全部平铺在 .handoff/ 根下（旧行为）。',

      // 续跑
      resumeTitle: '续跑与收尾',
      resumeHint: '压缩后自动注入续跑提示并唤醒 agent；短时间内反复压缩时按级别加强提示，达到上限则不再自动续跑（等用户确认）。',
      resumeEscalation: '按压缩频率分级',
      resumeEscalationHint: '窗口内第 2 次起提示「增量推进」，第 3 次起建议拆分/委派子 agent。上限抑制与此开关无关，始终生效。',
      resumeWindow: '统计窗口（分钟）',
      resumeWindowHint: '默认 30。窗口内出现新的人类消息会重新计数。',
      resumeMaxPerWindow: '上限（窗口内自动压缩次数）',
      resumeMaxPerWindowHint: '默认 5。达到即不再自动续跑，只留一条提示。',
      resumePrompt: '续跑提示词',
      resumePromptHint: '可用占位符：{{epoch}} {{window}} {{compactions}} {{digest}} {{raw}} {{intent}}；留空 = 关闭续跑注入。',
      wrapUpPrompt: '收尾提示词',
      wrapUpPromptHint: '可用占位符：{{todos}}；留空 = 关闭收尾提醒。',
      restoreDefault: '填入默认',
      templateEmpty: '（空 = 关闭该注入）',
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const css = [
      '/* dsh-context-guard: 上下文守卫设置分节 */',
      '.cg-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.cg-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.cg-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.cg-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.cg-input{box-sizing:border-box;width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.cg-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cg-select{box-sizing:border-box;width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.cg-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cg-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:center}',
      '.cg-row+.cg-row{margin-top:8px}',
      '.cg-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
      '.cg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.cg-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.cg-btn.danger{color:var(--dsw-alias-state-error-primary)}',
      '.cg-status{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.cg-status.error{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.cg-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.cg-group{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.cg-group-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.cg-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;min-width:0}',
      '.cg-check>span{flex:1 1 auto;min-width:0}',
      '.cg-check input{margin-top:2px}',
      '.cg-textarea{box-sizing:border-box;width:100%;min-height:88px;padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-family:inherit;resize:vertical}',
      '.cg-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cg-row-inline{display:flex;gap:8px;align-items:center;justify-content:space-between}',
      // 成对字段用 flex-wrap + flex-basis，而不是写死两列：容器够宽时自动两列，
      // 容器变窄（手机 WebView 内容区约 380px，或被宿主壳挤到更窄）时自动落成一列。
      // 这是内禀布局，不依赖视口宽度，所以在「宽视口 + 窄内容区」的壳里同样成立。
      '.cg-grid2{display:flex;flex-wrap:wrap;gap:12px}',
      '.cg-grid2>*{flex:1 1 200px;min-width:0}',
      // 保存行常驻：设置弹窗在手机上只有 ~510px 的滚动窗口，而本分节有 15 项、
      // 实测高 ~2100px（两个分组 1558px + 16 条说明 666px），保存按钮原本排在最后，
      // 要连滑三次才看得到 —— 用户报「移动端无法滚动、看不到下方的保存」即此。
      // 把保存行做成 sticky 贴在滚动区底部，保存与状态永远在屏幕上，够不够滚不再是前提。
      // 底色用弹窗同一套 surface token（浅色主题下即弹窗的 #fff），否则滚动时会透出内容。
      '.cg-actions{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:2px;padding:10px 0 6px;background:var(--dsw-alias-bg-base,#fff);border-top:1px solid var(--dsw-alias-border-l1,#dbe1e8)}',
      // 状态在左、按钮在右：长报错文案要能换行，且不许把按钮挤扁（flex 收缩默认允许）。
      '.cg-actions>.cg-status{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
      '.cg-actions>.cg-btn{flex:0 0 auto}',
      // 窄屏（手机 WebView 的 CSS 视口约 380–430px）一律单列：两列时每格只剩 ~180px，
      // 标签折成两三行、下拉被截断、说明文字变成窄条。这里按视口宽度收口（宽屏设置
      // 弹窗视口仍 ≥1000px，两列观感不变），比按容器宽度判断更可预期。
      '@media (max-width:640px){.cg-grid2{gap:10px}}',
      // 手机上再收一档间距与字号：滚动窗口本来就小，省下的都是要滑的距离。
      '@media (max-width:640px){.cg-root{gap:10px;padding-bottom:4px}.cg-group{gap:9px;padding:10px}.cg-hint{font-size:11px;line-height:16px}}',
      '@media (max-width:640px){.cg-grid2>*{flex-basis:100%}}',
      '@media (max-width:640px){.cg-row{grid-template-columns:minmax(0,1fr)}.cg-row>*{width:100%}}',
    ].join('\n')

    /**
     * 供应商下拉的来源：当前已注册（激活）的提供方（listProviders）。
     * 不合并可配置目录（listConfigurableProviders）——那会列出所有未配置
     * 的候选路由，用户只需看到当前 dsh 实际在用的那一个。
     * @returns {{ provider: string, displayName: string }[]}
     */
    function registeredProviders(registered) {
      return (registered ?? []).map(info => ({ provider: info.id, displayName: info.name }))
    }

    /** 数值输入回退：空串/NaN 用默认值。 */
    function numberOr(value, fallback) {
      const parsed = Number(value)
      return Number.isFinite(parsed) && value !== '' ? parsed : fallback
    }

    /** 复选框一行：标签 + 说明。 */
    function checkRow(label, hint, checked, onChange) {
      return React.createElement('label', { className: 'cg-check' },
        React.createElement('input', { type: 'checkbox', checked: checked, onChange: e => onChange(e.target.checked) }),
        React.createElement('span', null,
          React.createElement('span', null, label),
          hint !== undefined ? React.createElement('div', { className: 'cg-hint' }, hint) : null,
        ),
      )
    }

    /** 数字输入一行：标签 + 说明 + input。 */
    function numberField(label, hint, value, onChange, options) {
      const opts = options ?? {}
      return React.createElement('div', { className: 'cg-field' },
        React.createElement('label', { className: 'cg-label' }, label),
        React.createElement('input', {
          className: 'cg-input',
          type: 'number',
          min: opts.min,
          max: opts.max,
          step: opts.step ?? 1,
          value: value,
          placeholder: opts.placeholder,
          onChange: e => onChange(e.target.value),
        }),
        hint !== undefined ? React.createElement('div', { className: 'cg-hint' }, hint) : null,
      )
    }

    /** 下拉选择一行：标签 + 说明 + select。 */
    function selectField(label, hint, value, choices, onChange) {
      return React.createElement('div', { className: 'cg-field' },
        React.createElement('label', { className: 'cg-label' }, label),
        React.createElement('select', {
          className: 'cg-select',
          value: value,
          onChange: e => onChange(e.target.value),
        }, choices.map(choice => React.createElement('option', { key: choice.value, value: choice.value }, choice.label))),
        hint !== undefined ? React.createElement('div', { className: 'cg-hint' }, hint) : null,
      )
    }

    /** 文本域一行：标签 + 说明 + 「填入默认」+ textarea。 */
    function templateField(label, hint, value, onChange, onRestore) {
      return React.createElement('div', { className: 'cg-field' },
        React.createElement('div', { className: 'cg-row-inline' },
          React.createElement('label', { className: 'cg-label' }, label),
          React.createElement('button', { className: 'cg-btn', onClick: onRestore }, T.restoreDefault),
        ),
        React.createElement('textarea', {
          className: 'cg-textarea',
          value: value,
          placeholder: T.templateEmpty,
          onChange: e => onChange(e.target.value),
        }),
        hint !== undefined ? React.createElement('div', { className: 'cg-hint' }, hint) : null,
      )
    }

    /** 设置分节表单：阈值 + 接力摘要 + 续跑与收尾（同一个 settings 命名空间）。 */
    function GuardSection({ settings, llm }) {
      const remote = settings
      const [defaultTokens, setDefaultTokens] = useState('')
      const [rows, setRows] = useState([])
      const [providers, setProviders] = useState([])
      const [providerError, setProviderError] = useState(null)
      const [revision, setRevision] = useState(undefined)
      const [status, setStatus] = useState(null)
      const [digest, setDigest] = useState({
        enabled: true,
        maxTokens: '800',
        targetRatio: '0.45',
        carryForward: true,
        estimator: 'cjk',
        rawExcludeInjected: false,
        writeRawArchive: false,
        layout: 'session',
      })
      const [resume, setResume] = useState({
        escalation: true,
        windowMinutes: '30',
        maxPerWindow: '5',
        template: '',
        wrapTemplate: '',
      })
      const [base, setBase] = useState({})

      // 供应商列表 = 当前已注册（激活）的提供方（listProviders），不合并
      // 可配置目录，避免把未配置的候选路由（如 llm-pi-ai 的几十个）列进来。
      const loadProviders = useCallback(async () => {
        if (llm === undefined || typeof llm.listProviders !== 'function') return
        try {
          const registered = await llm.listProviders()
          if (!registered.ok) throw new Error(registered.error?.message ?? 'listProviders failed')
          setProviders(registeredProviders(registered.value))
          setProviderError(null)
        } catch (error) {
          setProviderError(T.providersFailed + String(error?.message ?? error))
        }
      }, [llm])

      const load = useCallback(async () => {
        try {
          const answer = await remote.describe()
          if (!answer.ok) throw new Error(answer.error?.message ?? 'describe failed')
          const view = (answer.value.namespaces ?? []).find(ns => ns.ns === 'context-guard')
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
          setDigest({
            enabled: value.digestEnabled !== false,
            maxTokens: String(value.digestMaxTokens ?? 800),
            targetRatio: String(value.digestTargetRatio ?? 0.45),
            carryForward: value.digestCarryForward !== false,
            estimator: value.digestTokenEstimator === 'ascii' ? 'ascii' : 'cjk',
            rawExcludeInjected: value.rawExcludeInjected === true,
            writeRawArchive: value.writeRawArchive === true,
            layout: value.archiveLayout === 'flat' ? 'flat' : 'session',
          })
          setResume({
            escalation: value.resumeEscalation !== false,
            windowMinutes: String(value.resumeWindowMinutes ?? 30),
            maxPerWindow: String(value.resumeMaxPerWindow ?? 5),
            template: value.resumePromptTemplate ?? '',
            wrapTemplate: value.wrapUpPromptTemplate ?? '',
          })
          setBase(view.base ?? {})
          setRevision(view.revision)
          setStatus(null)
        } catch (error) {
          setStatus({ error: true, text: T.loadFailed + String(error?.message ?? error) })
        }
      }, [remote])

      useEffect(() => { void load() }, [load])
      useEffect(() => { void loadProviders() }, [loadProviders])

      const save = async () => {
        const providerThresholds = rows
          .filter(row => row.provider.trim().length > 0)
          .map(row => ({
            provider: row.provider.trim(),
            thresholdTokens: numberOr(row.thresholdTokens, 1),
          }))
        // 稀疏 patch：只发本面板拥有的字段，其余命名空间字段不受影响。
        const patch = {
          defaultThresholdTokens: numberOr(defaultTokens, 0),
          providerThresholds,
          digestEnabled: digest.enabled,
          digestMaxTokens: numberOr(digest.maxTokens, 800),
          digestTargetRatio: numberOr(digest.targetRatio, 0.45),
          digestCarryForward: digest.carryForward,
          digestTokenEstimator: digest.estimator,
          rawExcludeInjected: digest.rawExcludeInjected,
          writeRawArchive: digest.writeRawArchive,
          archiveLayout: digest.layout,
          resumeEscalation: resume.escalation,
          resumeWindowMinutes: numberOr(resume.windowMinutes, 30),
          resumeMaxPerWindow: numberOr(resume.maxPerWindow, 5),
          resumePromptTemplate: resume.template,
          wrapUpPromptTemplate: resume.wrapTemplate,
        }
        try {
          const response = await remote.update('context-guard', patch, revision)
          if (!response.ok) throw new Error(response.error?.message ?? 'update failed')
          setRevision(response.value.revision)
          setStatus({ error: false, text: T.saved })
        } catch (error) {
          // 版本冲突（别处改过设置）时刷新 revision，避免用户反复撞同一个错。
          await load()
          setStatus({ error: true, text: T.saveFailed + String(error?.message ?? error) })
        }
      }

      const setRow = (index, field, value) => {
        setRows(rows.map((row, i) => i === index ? { ...row, [field]: value } : row))
      }

      // 目录可用时：下拉选择（含已保存但不在目录中的 provider，避免旧值丢失）。
      // 目录不可用时：手输文本框降级。
      const options = providers.length > 0
        ? [...providers, ...rows
            .map(row => row.provider)
            .filter(p => p.length > 0 && !providers.some(entry => entry.provider === p))
            .map(p => ({ provider: p, displayName: p }))]
        : []

      const providerField = (row, index) => options.length > 0
        ? React.createElement('select', {
            className: 'cg-select',
            value: row.provider,
            onChange: e => setRow(index, 'provider', e.target.value),
          },
            React.createElement('option', { value: '' }, T.providerPlaceholder),
            options.map(entry => React.createElement('option', { key: entry.provider, value: entry.provider },
              entry.displayName + ' (' + entry.provider + ')')),
          )
        : React.createElement('input', {
            className: 'cg-input',
            placeholder: T.providerPlaceholder,
            value: row.provider,
            onChange: e => setRow(index, 'provider', e.target.value),
          })

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
          providerError !== null
            ? React.createElement('div', { className: 'cg-status error' }, providerError)
            : null,
          rows.length === 0
            ? React.createElement('div', { className: 'cg-empty' }, T.empty)
            : rows.map((row, index) => React.createElement('div', { className: 'cg-row', key: index },
                providerField(row, index),
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
        ),
        React.createElement('div', { className: 'cg-hint' }, T.tokensHint),

        // ── 接力摘要 ──────────────────────────────────────────────────────
        React.createElement('div', { className: 'cg-group' },
          React.createElement('div', { className: 'cg-group-title' }, T.digestTitle),
          React.createElement('div', { className: 'cg-hint' }, T.digestHint),
          checkRow(T.digestEnabled, undefined, digest.enabled, value => setDigest({ ...digest, enabled: value })),
          React.createElement('div', { className: 'cg-grid2' },
            numberField(T.digestMaxTokens, T.digestMaxTokensHint, digest.maxTokens,
              value => setDigest({ ...digest, maxTokens: value }), { min: 80, step: 1 }),
            numberField(T.digestTargetRatio, T.digestTargetRatioHint, digest.targetRatio,
              value => setDigest({ ...digest, targetRatio: value }), { min: 0.05, max: 0.95, step: 0.05 }),
          ),
          checkRow(T.digestCarryForward, T.digestCarryForwardHint, digest.carryForward,
            value => setDigest({ ...digest, carryForward: value })),
          React.createElement('div', { className: 'cg-grid2' },
            selectField(T.digestEstimator, T.digestEstimatorHint, digest.estimator, [
              { value: 'cjk', label: 'cjk（中文按 2 字/token）' },
              { value: 'ascii', label: 'ascii（4 字符/token）' },
            ], value => setDigest({ ...digest, estimator: value })),
            selectField(T.archiveLayout, T.archiveLayoutHint, digest.layout, [
              { value: 'session', label: 'session（按会话分目录）' },
              { value: 'flat', label: 'flat（平铺，旧行为）' },
            ], value => setDigest({ ...digest, layout: value })),
          ),
          checkRow(T.writeRawArchive, T.writeRawArchiveHint, digest.writeRawArchive,
            value => setDigest({ ...digest, writeRawArchive: value })),
          checkRow(T.rawExcludeInjected, T.rawExcludeInjectedHint, digest.rawExcludeInjected,
            value => setDigest({ ...digest, rawExcludeInjected: value })),
        ),

        // ── 续跑与收尾 ────────────────────────────────────────────────────
        React.createElement('div', { className: 'cg-group' },
          React.createElement('div', { className: 'cg-group-title' }, T.resumeTitle),
          React.createElement('div', { className: 'cg-hint' }, T.resumeHint),
          checkRow(T.resumeEscalation, T.resumeEscalationHint, resume.escalation,
            value => setResume({ ...resume, escalation: value })),
          React.createElement('div', { className: 'cg-grid2' },
            numberField(T.resumeWindow, T.resumeWindowHint, resume.windowMinutes,
              value => setResume({ ...resume, windowMinutes: value }), { min: 1, step: 1 }),
            numberField(T.resumeMaxPerWindow, T.resumeMaxPerWindowHint, resume.maxPerWindow,
              value => setResume({ ...resume, maxPerWindow: value }), { min: 1, step: 1 }),
          ),
          templateField(T.resumePrompt, T.resumePromptHint, resume.template,
            value => setResume({ ...resume, template: value }),
            () => setResume({ ...resume, template: base.resumePromptTemplate ?? '' })),
          templateField(T.wrapUpPrompt, T.wrapUpPromptHint, resume.wrapTemplate,
            value => setResume({ ...resume, wrapTemplate: value }),
            () => setResume({ ...resume, wrapTemplate: base.wrapUpPromptTemplate ?? '' })),
        ),

        // 保存行与状态必须同在一个 sticky 容器里：状态留在末尾就落在容器之外，
        // 贴底只剩一个按钮，且状态更新时还会把容器高度顶变（sticky 行会跳）。
        React.createElement('div', { className: 'cg-actions' },
          status !== null
            ? React.createElement('div', { className: status.error ? 'cg-status error' : 'cg-status' }, status.text)
            : React.createElement('span', null),
          React.createElement('button', { className: 'cg-btn primary', onClick: () => void save() }, T.save),
        ),
      )
    }

    // 声明式注入：'remote.settings' 与 'remote.llm' 让 fiber 等待 api-remotes
    // 异步挂载的命名空间就绪后再执行 apply（与官方 ui-settings 客户端一致），
    // 避免 apply 早期读到 undefined 而静默放弃注册设置分节。
    const inject = ['remote', 'remote.settings', 'remote.llm']

    async function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const settings = ctx.remote.settings
      if (settings === undefined || typeof settings.describe !== 'function') return
      const llm = ctx.remote.llm
      const dispose = slots.inject('settings.section', () => {
        const register = slots.register({
          name: 'settings.section',
          id: 'context-guard',
          order: 32,
          label: T.sectionLabel,
          inject: () => ({ settings, llm }),
        }, GuardSection)
        return () => { register() }
      })
      ctx.effect(() => () => { dispose() }, 'context-guard: settings section')
    }

    exports.name = 'context-guard'
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
