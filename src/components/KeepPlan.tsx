import { useEffect, useMemo, useState } from 'react';
import type { Instance } from '../ical-engine/types';
import { collectLocations } from '../ical-engine/free-windows';
import {
  computeKeepPlan,
  DEFAULT_KEEP_WEIGHT,
  type KeepParticipant,
  type KeepSetting,
} from '../ical-engine/keep-plan';
import { instanceId } from '../ical-engine/conflicts';
import { formatWall } from '../utils/format';

interface KeepPlanProps {
  /** 当前生效实例（已取消 / 已排除不参与） */
  instances: Instance[];
  /** 选中的 LOCATION（受控，随页签切换保留） */
  location: string;
  onLocationChange: (loc: string) => void;
  /** 身份（UID#recurrenceKey）-> 权重 / 必留设置；消失项的条目保留但不参与 */
  settings: Record<string, KeepSetting>;
  onSettingsChange: (next: Record<string, KeepSetting>) => void;
  /** 当前选中实例 key（点击行联动源码定位后高亮） */
  selectedKey: string | null;
  onSelectInstance: (inst: Instance) => void;
}

/**
 * 冲突保留方案面板：选定 LOCATION 后，为该地点正时长实例设置权重与必留标记，
 * 实时求解“包含全部必留项的无重叠子集权重最大化”并展示保留 / 舍弃列表。
 * 仅预览，不修改日历。
 */
export function KeepPlan({
  instances,
  location,
  onLocationChange,
  settings,
  onSettingsChange,
  selectedKey,
  onSelectInstance,
}: KeepPlanProps) {
  const locations = useMemo(() => collectLocations(instances), [instances]);

  // 范围 / 规则 / 例外状态变化 → instances 变化 → 立即重算；设置按身份保留
  const plan = useMemo(
    () => (location.trim() ? computeKeepPlan(instances, location, settings) : null),
    [instances, location, settings]
  );

  const patchSetting = (identity: string, patch: Partial<KeepSetting>): void => {
    const cur = settings[identity] ?? { weight: DEFAULT_KEEP_WEIGHT, must: false };
    onSettingsChange({ ...settings, [identity]: { ...cur, ...patch } });
  };

  return (
    <>
      <div className="filter-bar free-controls">
        <label title="只对 LOCATION 完全相同的正时长生效实例求解">
          LOCATION
          <select value={location} onChange={(e) => onLocationChange(e.target.value)}>
            <option value="">请选择…</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        {plan && (
          <span className="clock">
            参与 <b style={{ color: 'var(--text)' }}>{plan.participants.length}</b> · 必留{' '}
            <b style={{ color: 'var(--text)' }}>{plan.participants.filter((p) => p.must).length}</b>
            {plan.status === 'ok' && (
              <>
                {' '}· 总权重 <b className="keep-total">{plan.totalWeight}</b>
              </>
            )}
          </span>
        )}
      </div>

      {!location.trim() ? (
        <div className="empty-hint diff-empty">
          <div style={{ fontSize: 28, marginBottom: 6 }}>⚖️</div>
          选择 LOCATION 后，为该地点的正时长实例设置权重与必留标记，
          实时求出包含全部必留项的无重叠最大权重子集
          <div className="clock" style={{ marginTop: 4 }}>
            半开区间判定重叠（相切不算）；仅预览，不修改日历
          </div>
        </div>
      ) : plan ? (
        plan.status === 'infeasible' ? (
          <>
            <div className="free-msg error">
              ✕ 必留项互相重叠，无解——未输出方案。请调整必留标记（共 {plan.mustPairs.length} 对冲突）。
            </div>
            <div className="keep-pairs">
              {plan.mustPairs.map((pair, idx) => (
                <div className="keep-pair" key={`${pair.a.identity}|${pair.b.identity}`}>
                  <span className="keep-pair-no">冲突对 {idx + 1}</span>
                  <KeepInstLink p={pair.a} onSelect={onSelectInstance} />
                  <span className="clock">×</span>
                  <KeepInstLink p={pair.b} onSelect={onSelectInstance} />
                </div>
              ))}
            </div>
            <ParticipantTable
              participants={plan.participants}
              settings={settings}
              selectedKey={selectedKey}
              onSelectInstance={onSelectInstance}
              onPatchSetting={patchSetting}
            />
          </>
        ) : (
          <>
            <div className="keep-banner">
              <span>
                总权重 <b className="keep-total">{plan.totalWeight}</b>
              </span>
              <span>
                保留 <b style={{ color: 'var(--ok)' }}>{plan.kept.length}</b>
              </span>
              <span>
                舍弃 <b style={{ color: 'var(--cancelled)' }}>{plan.discarded.length}</b>
              </span>
              <span style={{ flex: 1 }} />
              <span className="clock">仅预览 · 不修改日历</span>
            </div>

            <div className="keep-section">
              <div className="keep-section-title kept">保留（{plan.kept.length}）</div>
              {plan.kept.length === 0 ? (
                <div className="empty-hint">没有可保留的实例</div>
              ) : (
                plan.kept.map((p) => (
                  <PlanRow
                    key={p.identity}
                    p={p}
                    tone="kept"
                    selected={selectedKey === instanceId(p.inst)}
                    onSelect={onSelectInstance}
                  />
                ))
              )}
            </div>

            <div className="keep-section">
              <div className="keep-section-title discarded">舍弃（{plan.discarded.length}）</div>
              {plan.discarded.length === 0 ? (
                <div className="empty-hint">没有需要舍弃的实例</div>
              ) : (
                plan.discarded.map((p) => (
                  <PlanRow
                    key={p.identity}
                    p={p}
                    tone="discarded"
                    blocked={plan.blockedByMust.has(p.identity)}
                    selected={selectedKey === instanceId(p.inst)}
                    onSelect={onSelectInstance}
                  />
                ))
              )}
            </div>

            <ParticipantTable
              participants={plan.participants}
              settings={settings}
              selectedKey={selectedKey}
              onSelectInstance={onSelectInstance}
              onPatchSetting={patchSetting}
            />
          </>
        )
      ) : null}
    </>
  );
}

/** 保留 / 舍弃列表行：点击联动源码定位 */
function PlanRow({
  p,
  tone,
  blocked,
  selected,
  onSelect,
}: {
  p: KeepParticipant;
  tone: 'kept' | 'discarded';
  blocked?: boolean;
  selected: boolean;
  onSelect: (inst: Instance) => void;
}) {
  return (
    <div
      className={`keep-row ${tone} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(p.inst)}
      title="点击在左侧 ICS 源码中定位该实例"
    >
      <span className="keep-row-time">
        {formatWall(p.inst.startUtc, p.inst.tzid, p.inst.isAllDay)}
        <span className="clock"> 至 {formatWall(p.inst.endUtc, p.inst.tzid, p.inst.isAllDay)}</span>
      </span>
      <span className="keep-row-summary">{p.inst.summary || '（无标题）'}</span>
      {p.must && <span className="keep-must-badge">必留</span>}
      {blocked && (
        <span className="tag" title="与某个必留实例时间重叠，必被舍弃">
          与必留项重叠
        </span>
      )}
      <span className="keep-row-weight">权重 {p.weight}</span>
    </div>
  );
}

/** 必留冲突对中的实例链接 */
function KeepInstLink({ p, onSelect }: { p: KeepParticipant; onSelect: (inst: Instance) => void }) {
  return (
    <a className="keep-inst-link" onClick={() => onSelect(p.inst)} title="点击在左侧 ICS 源码中定位该实例">
      {p.inst.summary || '（无标题）'}
      <span className="clock" style={{ marginLeft: 4 }}>
        {formatWall(p.inst.startUtc, p.inst.tzid, p.inst.isAllDay)}
      </span>
    </a>
  );
}

/** 参与实例设置表：权重（非负整数，默认 1）+ 必留勾选 */
function ParticipantTable({
  participants,
  settings,
  selectedKey,
  onSelectInstance,
  onPatchSetting,
}: {
  participants: KeepParticipant[];
  settings: Record<string, KeepSetting>;
  selectedKey: string | null;
  onSelectInstance: (inst: Instance) => void;
  onPatchSetting: (identity: string, patch: Partial<KeepSetting>) => void;
}) {
  return (
    <div className="keep-section">
      <div className="keep-section-title">参与实例设置（{participants.length}）</div>
      {participants.length === 0 ? (
        <div className="empty-hint">该 LOCATION 下当前范围内没有正时长的生效实例</div>
      ) : (
        <table className="instance-table keep-table">
          <thead>
            <tr>
              <th style={{ width: 158 }}>开始（声明时区墙钟）</th>
              <th>事件</th>
              <th style={{ width: 76 }}>权重</th>
              <th style={{ width: 52 }}>必留</th>
            </tr>
          </thead>
          <tbody>
            {participants.map((p) => (
              <tr
                key={p.identity}
                className={`instance-row ${selectedKey === instanceId(p.inst) ? 'selected' : ''}`}
                onClick={() => onSelectInstance(p.inst)}
                title="点击在左侧 ICS 源码中定位该实例"
              >
                <td className="cell-time">
                  {formatWall(p.inst.startUtc, p.inst.tzid, p.inst.isAllDay)}
                  <br />
                  <span className="clock">
                    至 {formatWall(p.inst.endUtc, p.inst.tzid, p.inst.isAllDay)}
                  </span>
                </td>
                <td>{p.inst.summary || <em style={{ color: 'var(--excluded)' }}>（无标题）</em>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <WeightInput
                    identity={p.identity}
                    weight={settings[p.identity]?.weight ?? p.weight}
                    onCommit={(w) => onPatchSetting(p.identity, { weight: w })}
                  />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={p.must}
                    onChange={(e) => onPatchSetting(p.identity, { must: e.target.checked })}
                    title="必留：方案必须包含该实例；必留项互相重叠则无解"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 权重输入：本地草稿态，合法（非负整数）即提交，失焦回显生效值 */
function WeightInput({
  identity,
  weight,
  onCommit,
}: {
  identity: string;
  weight: number;
  onCommit: (w: number) => void;
}) {
  const [draft, setDraft] = useState(String(weight));
  useEffect(() => {
    setDraft(String(weight));
  }, [identity, weight]);
  return (
    <input
      type="number"
      min={0}
      step={1}
      className="keep-weight-input"
      value={draft}
      title="非负整数权重，默认 1"
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (/^\d+$/.test(raw)) onCommit(Math.floor(Number(raw)));
      }}
      onBlur={() => setDraft(String(weight))}
    />
  );
}
