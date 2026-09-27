import { useEffect, useMemo, useState } from 'react';
import type { Instance } from '../ical-engine/types';
import { collectLocations } from '../ical-engine/free-windows';
import {
  MAX_TURNOVER_MINUTES,
  TURNOVER_LABEL,
  type TurnoverKind,
  type TurnoverPair,
  type TurnoverSetting,
} from '../ical-engine/turnover';
import { formatDuration, formatOffset, formatWall } from '../utils/format';

interface TurnoverAuditProps {
  /** 当前生效实例（已取消 / 已排除不参与） */
  instances: Instance[];
  /** 已按起点排序的全部审计对（conflict + short） */
  pairs: TurnoverPair[];
  /** LOCATION -> 布场 / 清场设置（按地点保留，页签切换不丢失） */
  settings: Record<string, TurnoverSetting>;
  onSettingsChange: (next: Record<string, TurnoverSetting>) => void;
  /** 当前全局选中实例的身份键，行高亮用 */
  selectedIdentity: string | null;
  /** 点击整行：定位双方实例与 ICS 源块 */
  onSelectPair: (pair: TurnoverPair) => void;
  /** 点击单侧实例名：仅定位该实例 */
  onSelectInstance: (inst: Instance) => void;
}

const FILTER_KINDS: TurnoverKind[] = ['conflict', 'short'];

/**
 * 场地周转审计面板：按非空 LOCATION 为每个地点配置活动前布场 / 结束后清场分钟
 * （0～240，默认 0），列出同地点正时长实例对中的现有时间冲突与周转不足。
 * 停用例外、编辑规则或调整展开范围后，pairs 随生效实例即时重算。
 */
export function TurnoverAudit({
  instances,
  pairs,
  settings,
  onSettingsChange,
  selectedIdentity,
  onSelectPair,
  onSelectInstance,
}: TurnoverAuditProps) {
  const locations = useMemo(() => collectLocations(instances), [instances]);
  const [location, setLocation] = useState('');
  const [filter, setFilter] = useState<TurnoverKind | 'all'>('all');

  const counts = useMemo(() => {
    const map = new Map<TurnoverKind, number>();
    for (const p of pairs) map.set(p.kind, (map.get(p.kind) ?? 0) + 1);
    return map;
  }, [pairs]);

  const rows = useMemo(() => {
    const loc = location.trim();
    return pairs.filter((p) => (!loc || p.location === loc) && (filter === 'all' || p.kind === filter));
  }, [pairs, location, filter]);

  const patchSetting = (loc: string, patch: Partial<TurnoverSetting>): void => {
    const cur = settings[loc] ?? { setupMin: 0, teardownMin: 0 };
    onSettingsChange({ ...settings, [loc]: { ...cur, ...patch } });
  };

  const shownLocations = useMemo(
    () => (location.trim() ? [] : locations),
    [location, locations]
  );

  return (
    <>
      <div className="filter-bar free-controls">
        <label title="只展示所选 LOCATION 的审计对与设置；留空=全部地点">
          LOCATION
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">全部地点</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>
        {location.trim() && (
          <PerLocationInputs
            location={location.trim()}
            settings={settings}
            onPatch={patchSetting}
          />
        )}
        <span style={{ flex: 1 }} />
        <span className="clock">
          冲突 <b style={{ color: 'var(--conflict)' }}>{counts.get('conflict') ?? 0}</b> · 周转不足{' '}
          <b style={{ color: 'var(--warn)' }}>{counts.get('short') ?? 0}</b>
        </span>
      </div>

      {location.trim() ? null : shownLocations.length === 0 ? (
        <div className="empty-hint diff-empty">
          <div style={{ fontSize: 28, marginBottom: 6 }}>🚪</div>
          当前展开范围内没有带非空 LOCATION 的正时长生效实例
        </div>
      ) : (
        <table className="instance-table turnover-setting-table">
          <thead>
            <tr>
              <th>LOCATION</th>
              <th style={{ width: 150 }}>活动前布场（分钟）</th>
              <th style={{ width: 150 }}>结束后清场（分钟）</th>
              <th style={{ width: 90 }}>审计对</th>
            </tr>
          </thead>
          <tbody>
            {shownLocations.map((loc) => {
              const n = pairs.filter((p) => p.location === loc).length;
              const nShort = pairs.filter((p) => p.location === loc && p.kind === 'short').length;
              return (
                <tr key={loc} className="instance-row" title="为该地点设置统一的布场 / 清场分钟（0～240）">
                  <td>{loc}</td>
                  <td>
                    <MinuteInput
                      value={settings[loc]?.setupMin ?? 0}
                      onCommit={(v) => patchSetting(loc, { setupMin: v })}
                    />
                  </td>
                  <td>
                    <MinuteInput
                      value={settings[loc]?.teardownMin ?? 0}
                      onCommit={(v) => patchSetting(loc, { teardownMin: v })}
                    />
                  </td>
                  <td className="clock">
                    {n === 0 ? (
                      '—'
                    ) : (
                      <>
                        <b style={{ color: n > nShort ? 'var(--conflict)' : 'var(--text-dim)' }}>{n}</b>
                        {nShort > 0 && (
                          <>
                            {' '}
                            <span style={{ color: 'var(--warn)' }}>（缺口 {nShort}）</span>
                          </>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="filter-bar diff-filter">
        <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>
          全部（{pairs.length}）
        </button>
        {FILTER_KINDS.map((k) => (
          <button
            key={k}
            className={`chip ${k === 'conflict' ? 'removed' : 'overlap-changed'} ${filter === k ? 'active' : ''}`}
            onClick={() => setFilter(k)}
            disabled={!counts.has(k)}
          >
            {TURNOVER_LABEL[k]}（{counts.get(k) ?? 0}）
          </button>
        ))}
        <span className="clock" style={{ marginLeft: 'auto' }}>
          全部按 UTC 绝对时间半开区间判定（跨午夜 / 跨 DST 不切断）
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty-hint diff-empty">
          <div style={{ fontSize: 28, marginBottom: 6 }}>✅</div>
          {pairs.length === 0
            ? '同地点的正时长实例之间没有时间冲突，周转时间也充足'
            : '该筛选条件下没有匹配的审计对'}
          <div className="clock" style={{ marginTop: 4 }}>
            为地点设置布场 / 清场分钟后，原始时段不相交但缓冲不足的实例对会标为「周转不足」；
            停用例外、编辑规则或调整展开范围后立即重算
          </div>
        </div>
      ) : (
        <table className="instance-table turnover-table">
          <thead>
            <tr>
              <th style={{ width: 108 }}>类型 / 地点</th>
              <th style={{ width: 218 }}>先结束实例 → 后开始实例</th>
              <th style={{ width: 82 }}>实际间隔</th>
              <th style={{ width: 96 }}>所需周转</th>
              <th>缺口</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <TurnoverRow
                key={p.pairKey}
                pair={p}
                selected={
                  selectedIdentity !== null &&
                  (selectedIdentity === p.identityA || selectedIdentity === p.identityB)
                }
                onSelect={() => onSelectPair(p)}
                onSelectInstance={onSelectInstance}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** 单地点视图下的布场 / 清场分钟输入 */
function PerLocationInputs({
  location,
  settings,
  onPatch,
}: {
  location: string;
  settings: Record<string, TurnoverSetting>;
  onPatch: (loc: string, patch: Partial<TurnoverSetting>) => void;
}) {
  const cur = settings[location] ?? { setupMin: 0, teardownMin: 0 };
  return (
    <>
      <label title="该地点每个实例开始前需要的布场分钟（0～240，默认 0）">
        前布场
        <MinuteInput value={cur.setupMin} onCommit={(v) => onPatch(location, { setupMin: v })} />
        分钟
      </label>
      <label title="该地点每个实例结束后需要的清场分钟（0～240，默认 0）">
        后清场
        <MinuteInput value={cur.teardownMin} onCommit={(v) => onPatch(location, { teardownMin: v })} />
        分钟
      </label>
    </>
  );
}

function TurnoverRow({
  pair,
  selected,
  onSelect,
  onSelectInstance,
}: {
  pair: TurnoverPair;
  selected: boolean;
  onSelect: () => void;
  onSelectInstance: (inst: Instance) => void;
}) {
  const { first, second } = pair;
  return (
    <tr
      className={`instance-row turnover-row ${pair.kind} ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      title="点击定位双方实例的 ICS 源块（切回生效实例表，另一方源块红框高亮）"
    >
      <td>
        <span className={`turnover-badge ${pair.kind}`}>{TURNOVER_LABEL[pair.kind]}</span>
        <br />
        <span className="clock">{pair.location}</span>
      </td>
      <td>
        <MemberCell inst={first} tone="first" onSelectInstance={onSelectInstance} />
        <div className="clock turnover-arrow">
          {pair.kind === 'conflict'
            ? '▼ 原始时段相交 ▼'
            : `▼ 实际间隔 ${formatDuration(pair.gapSec, false)} ▼`}
        </div>
        <MemberCell inst={second} tone="second" onSelectInstance={onSelectInstance} />
      </td>
      <td className={pair.kind === 'conflict' ? 'turnover-overlap' : 'turnover-gap'}>
        {pair.kind === 'conflict'
          ? `重叠 ${formatDuration(pair.overlapSec, first.isAllDay && second.isAllDay)}`
          : formatDuration(pair.gapSec, false)}
      </td>
      <td className="clock">
        {pair.requiredSec > 0 ? (
          `${pair.setupMin} + ${pair.teardownMin} = ${pair.requiredSec / 60} 分钟`
        ) : (
          '0 分钟'
        )}
      </td>
      <td>
        {pair.kind === 'conflict' ? (
          <span className="clock" title="原始时段已相交，先解决时间冲突">
            —
          </span>
        ) : (
          <span className="turnover-short" title={`所需 ${pair.requiredSec / 60} 分钟 − 实际间隔 ${Math.floor(pair.gapSec / 60)} 分钟`}>
            缺 {formatDuration(pair.shortfallSec, false)}
          </span>
        )}
      </td>
    </tr>
  );
}

/** 审计对中的一方实例：摘要可点击单侧定位，时间按各自声明时区墙钟显示 */
function MemberCell({
  inst,
  tone,
  onSelectInstance,
}: {
  inst: Instance;
  tone: 'first' | 'second';
  onSelectInstance: (inst: Instance) => void;
}) {
  return (
    <div className="turnover-member">
      <a
        className={`turnover-member-name ${tone}`}
        title="点击仅定位该实例"
        onClick={(e) => {
          e.stopPropagation();
          onSelectInstance(inst);
        }}
      >
        {inst.summary || '（无标题）'}
      </a>
      <span className="clock">
        {fmtRange(inst)} · {formatOffset(inst.utcOffsetSec)}
      </span>
    </div>
  );
}

/** 分钟输入：本地草稿态，0～240 整数即时提交（非法保持草稿，失焦回显生效值） */
function MinuteInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <input
      type="number"
      min={0}
      max={MAX_TURNOVER_MINUTES}
      step={1}
      className="keep-weight-input"
      value={draft}
      title="0～240 的整数分钟，默认 0；越界自动截断，小数向下取整"
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (/^\d+$/.test(raw)) onCommit(Math.min(MAX_TURNOVER_MINUTES, Number(raw)));
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

function fmtRange(inst: Instance): string {
  const s = formatWall(inst.startUtc, inst.tzid, inst.isAllDay);
  const e = formatWall(inst.endUtc, inst.tzid, inst.isAllDay);
  if (inst.isAllDay) return `${s} ~ ${e}`;
  return s.slice(0, 10) === e.slice(0, 10) ? `${s}–${e.slice(11)}` : `${s} → ${e}`;
}
