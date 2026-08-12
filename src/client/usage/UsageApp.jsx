/* =============================================================
   Usage feed — per-call token usage table (mirrors commandcode.ai
   /settings/usage: Time | Input | Output | Model | Mode | Status |
   Credits | Trace ID)
   ============================================================= */

import { useEffect, useMemo, useState } from 'react';
import { U } from '../shared/utils.js';
import { ThemeToggle } from '../shared/ThemeToggle.jsx';
import { sourceIcon, sourceIconScale } from '../dashboard/source-icons.js';
import '../dashboard/styles.css';

const PAGE_SIZE = 200;

// Source cell: brand icon when available, otherwise the colored dot.
function SourceTag({ source }) {
  const icon = sourceIcon(source);
  return (
    <span className="tag">
      {icon
        ? <img className="tag-icon" src={icon} alt="" style={{ transform: `scale(${sourceIconScale(source)})` }} />
        : <span className="tag-dot" style={{ background: U.getSourceColor(source) }}/>}
      {source}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────
// Column definitions — mirror the official usage table headers.
// Timing/Mode/Status/Trace ID aren't recorded per call yet; the
// columns render "—" when the field is absent.
// ───────────────────────────────────────────────────────────────
const COLUMNS = [
  {
    field: 'eventTime', title: 'Time', width: 160,
    render: r => <span className="mono" style={{fontSize: 11.5}}>{U.formatTs(r.eventTime)}</span>
  },
  {
    field: 'source', title: 'Source', width: 140,
    render: r => <SourceTag source={r.source} />
  },
  {
    field: 'inputTokens', title: 'Input Tokens', hozAlign: 'right', width: 110,
    render: r => <span className="mono">{U.fmt.format(r.inputTokens)}</span>
  },
  {
    field: 'outputTokens', title: 'Output Tokens', hozAlign: 'right', width: 110,
    render: r => <span className="mono">{U.fmt.format(r.outputTokens)}</span>
  },
  {
    field: 'durationMs', title: 'Timing', hozAlign: 'right', width: 90,
    render: r => r.durationMs != null
      ? <span className="mono">{r.durationMs < 1000 ? `${r.durationMs}ms` : `${(r.durationMs / 1000).toFixed(1)}s`}</span>
      : <span className="muted">—</span>
  },
  {
    field: 'model', title: 'Model', width: 200,
    render: r => <span className="mono" style={{fontSize: 11.5}}>{r.model}</span>
  },
  {
    field: 'mode', title: 'Mode', width: 90,
    render: r => r.mode ? <span className="muted">{r.mode}</span> : <span className="muted">—</span>
  },
  {
    field: 'status', title: 'Status', width: 90,
    render: r => r.status
      ? <span className={`status-badge status-${r.status}`}>{r.status}</span>
      : <span className="muted">—</span>
  },
  {
    field: 'costUSD', title: 'Credits', hozAlign: 'right', width: 110,
    render: r => r.costUSD > 0
      ? <span style={{color:'var(--c-amber)', fontWeight:600}}>{U.fmtCost4(r.costUSD)}</span>
      : <span className="muted">—</span>
  },
  {
    field: 'eventKey', title: 'Trace ID', width: 220,
    render: r => <span className="mono" style={{fontSize: 10.5, color:'var(--muted)'}}>{r.eventKey || r.id || '—'}</span>
  }
];

// ───────────────────────────────────────────────────────────────
// Main page
// ───────────────────────────────────────────────────────────────
export function UsageApp() {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sourceFilter, setSourceFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [q, setQ] = useState('');
  const [sources, setSources] = useState([]);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useMemo(() => async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (sourceFilter) params.set('source', sourceFilter);
      if (modelFilter) params.set('model', modelFilter);
      const res = await fetch(`/api/usage?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.time || []);
      setTotal(data.total || 0);
      // Source/model dropdowns come from the server (whole-table distinct),
      // so every source is selectable regardless of the current page.
      if (data.sources) setSources(data.sources);
      if (data.models) setModels(data.models);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [offset, sourceFilter, modelFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (!q) return rows;
    const needle = q.toLowerCase();
    return rows.filter(r =>
      [r.source, r.model, r.eventKey, String(r.inputTokens), String(r.outputTokens)]
        .some(v => String(v ?? '').toLowerCase().includes(needle))
    );
  }, [rows, q]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <div className="brand-mark">TS</div>
            <div>
              <h1>Token Studio</h1>
              <p className="brand-sub">个人 AI Token 消耗看板</p>
            </div>
          </div>
          <div className="page-switch">
            <a href="/" className="page-chip">看板</a>
            <a href="/review" className="page-chip">复盘</a>
            <span className="page-chip active">流水</span>
          </div>
        </div>
        <div className="topbar-right">
          <ThemeToggle />
        </div>
      </div>

      <div className="content">
        <div className="filter-bar">
          <div className="filter-row">
            <div className="search-box">
              <input
                className="search-input"
                placeholder="搜索来源 / 模型 / Trace ID…"
                value={q}
                onChange={e => setQ(e.target.value)}
              />
            </div>
            <select
              className="search-input"
              style={{maxWidth: 180}}
              value={sourceFilter}
              onChange={e => { setSourceFilter(e.target.value); setOffset(0); }}
            >
              <option value="">全部来源</option>
              {sources.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              className="search-input"
              style={{maxWidth: 220}}
              value={modelFilter}
              onChange={e => { setModelFilter(e.target.value); setOffset(0); }}
            >
              <option value="">全部模型</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="muted" style={{fontSize: 12, marginLeft: 'auto'}}>
              共 <b style={{color:'var(--text)'}}>{U.fmt.format(total)}</b> 次调用
            </span>
          </div>
          <div className="filter-row" style={{justifyContent:'flex-end', gap: 8, marginTop: 8}}>
            <button className="btn" disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              ← 上一页
            </button>
            <span className="muted" style={{fontSize: 12}}>{page} / {pages}</span>
            <button className="btn" disabled={offset + PAGE_SIZE >= total || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}>
              下一页 →
            </button>
          </div>
        </div>

        {error && <div className="run-row error">加载失败：{error}</div>}

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">调用流水</h2>
              <p className="panel-sub">逐次调用的 Token 消耗（最近优先）</p>
            </div>
            {loading && <span className="muted" style={{fontSize: 12}}>加载中…</span>}
          </div>
          <div className="table-wrap" style={{maxHeight: 'calc(100vh - 260px)', overflow: 'auto'}}>
            <table className="dt">
              <thead>
                <tr>
                  {COLUMNS.map(c => (
                    <th key={c.field || c.title}
                      style={{width: c.width, textAlign: c.hozAlign === 'right' ? 'right' : 'left'}}>
                      {c.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={COLUMNS.length} style={{textAlign:'center', padding:'30px', color:'var(--muted)'}}>
                    {rows ? '暂无数据' : '加载中…'}
                  </td></tr>
                )}
                {filtered.map((r, i) => (
                  <tr key={r.id || `${r.eventKey}-${i}`}>
                    {COLUMNS.map(c => (
                      <td key={c.field || c.title} style={{textAlign: c.hozAlign === 'right' ? 'right' : 'left'}}>
                        {c.render ? c.render(r) : r[c.field]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
