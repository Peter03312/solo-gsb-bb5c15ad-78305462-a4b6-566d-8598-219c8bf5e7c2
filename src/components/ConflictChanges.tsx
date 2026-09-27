import { useMemo, useState } from 'react';
import type { Instance } from '../ical-engine/types';
import {
  CONFLICT_CHANGE_LABEL,
  type ConflictChange,
  type ConflictChangeKind,
} from '../ical-engine/conflict-diff';
import { formatDuration, formatWall } from '../utils/format';

interface ConflictChangesProps {
  changes: ConflictChange[];
  /** 当前全局选中实例的身份键（uid#recurrenceKey），用于行高亮 */
  selectedIdentity: string | null;
  onSelect: (change: ConflictChange) => void;
}

const FILTER_KINDS: ConflictChangeKind[] = ['added', 'removed', 'overlap-changed'];

export function ConflictChanges({ changes, selectedIdentity, onSelect }: ConflictChangesProps) {
  const [filter, setFilter] = useState<ConflictChangeKind | 'all'>('all');

  const counts = useMemo(() => {
    const map = new Map<ConflictChangeKind, number>();
    for (const c of changes) map.set(c.kind, (map.get(c.kind) ?? 0) + 1);
    return map;
  }, [changes]);

  const rows = useMemo(
    () => (filter === 'all' ? changes : changes.filter((c) => c.kind === filter)),
    [changes, filter]
  );

  return (
    <>
      <div className="filter-bar diff-filter">
        <button
          className={filter === 'all' ? 'chip active' : 'chip'}
          onClick={() => setFilter('all')}
        >
          全部（{changes.length}）
        </button>
        {FILTER_KINDS.map((k) => (
          <button
            key={k}
            className={`chip ${k} ${filter === k ? 'active' : ''}`}
            onClick={() => setFilter(k)}
            disabled={!counts.has(k)}
          >
            {CONFLICT_CHANGE_LABEL[k]}（{counts.get(k) ?? 0}）
          </button>
        ))}
      </div>

      {changes.length === 0 ? (
        <div className="empty-hint diff-empty">
          <div style={{ fontSize: 28, marginBottom: 6 }}>🕊️</div>
          当前范围内 LOCATION 冲突没有变化
          <div className="clock" style={{ marginTop: 4 }}>
            编辑 RRULE 或停用例外后，这里会立即重算新增 / 消除 / 重叠时长变化的冲突对
          </div>
        </div>
      ) : (
        <div className="diff-list">
          {rows.map((c) => (
            <PairRow
              key={c.pairKey}
              change={c}
              selected={selectedIdentity !== null && selectedIdentity === c.identityA}
              onClick={() => onSelect(c)}
            />
          ))}
          {rows.length === 0 && (
            <div className="empty-hint">该变化类型下没有匹配项</div>
          )}
        </div>
      )}
    </>
  );
}

function PairRow({
  change,
  selected,
  onClick,
}: {
  change: ConflictChange;
  selected: boolean;
  onClick: () => void;
}) {
  // 展示以“有效一侧”为准：新增 / 重叠变化看当前侧，消除看原始侧
  const a = change.afterA ?? change.beforeA;
  const b = change.afterB ?? change.beforeB;
  if (!a || !b) return null;
  const allDay = a.isAllDay && b.isAllDay;

  return (
    <div
      className={`diff-row cpair-row ${change.kind} ${selected ? 'selected' : ''}`}
      onClick={onClick}
      title="点击定位双方实例与 ICS 原文"
    >
      <div className="diff-head">
        <span className={`diff-badge ${change.kind}`}>
          {CONFLICT_CHANGE_LABEL[change.kind]}
        </span>
        <span className="diff-title">{change.location}</span>
        <span className="cpair-overlap">{overlapText(change, allDay)}</span>
      </div>
      <div className="diff-fields">
        <MemberLine
          label="甲"
          inst={a}
          before={change.kind === 'overlap-changed' ? change.beforeA : null}
        />
        <MemberLine
          label="乙"
          inst={b}
          before={change.kind === 'overlap-changed' ? change.beforeB : null}
        />
      </div>
      <div className="diff-ident clock">
        冲突对身份：
        <span className="diff-key-mono">{change.identityA}</span>
        {' × '}
        <span className="diff-key-mono">{change.identityB}</span>
      </div>
    </div>
  );
}

/** 冲突对中的一方：重叠变化时若被改期，同时给出前后时间 */
function MemberLine({
  label,
  inst,
  before,
}: {
  label: string;
  inst: Instance;
  before: Instance | null;
}) {
  const moved =
    before !== null && (before.startUtc !== inst.startUtc || before.endUtc !== inst.endUtc);
  return (
    <div className="field-diff">
      <span className="field-name">{label}</span>
      <span className="cpair-summary">{inst.summary || '（无标题）'}</span>
      {moved && before ? (
        <>
          <span className="val before">{fmtRange(before)}</span>
          <span className="arrow">→</span>
          <span className="val after">{fmtRange(inst)}</span>
        </>
      ) : (
        <span className="val">{fmtRange(inst)}</span>
      )}
    </div>
  );
}

function overlapText(c: ConflictChange, allDay: boolean): string {
  if (c.kind === 'added') return `重叠 ${formatOverlap(c.afterOverlapSec, allDay)}`;
  if (c.kind === 'removed') return `原重叠 ${formatOverlap(c.beforeOverlapSec, allDay)}`;
  return `重叠 ${formatOverlap(c.beforeOverlapSec, allDay)} → ${formatOverlap(c.afterOverlapSec, allDay)}`;
}

/** 重叠时长：全天事件按整天数显示，其余按时长 */
function formatOverlap(sec: number, allDay: boolean): string {
  if (allDay && sec % 86400 === 0) return `${sec / 86400} 天`;
  return formatDuration(sec, false);
}

/** 实例时间范围（声明时区墙钟）；跨天时给出完整终点 */
function fmtRange(inst: Instance): string {
  const s = formatWall(inst.startUtc, inst.tzid, inst.isAllDay);
  const e = formatWall(inst.endUtc, inst.tzid, inst.isAllDay);
  if (inst.isAllDay) return `${s} ~ ${e}`;
  return s.slice(0, 10) === e.slice(0, 10) ? `${s}–${e.slice(11)}` : `${s} → ${e}`;
}
