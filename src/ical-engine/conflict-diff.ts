// 冲突变化比对
// 比较“原始日历”与“规则编辑 / 例外停用后”的 LOCATION 冲突对（仅当前查询范围内的生效实例）。
// 冲突对身份：LOCATION + 无序实例身份对（实例身份 = UID + 原始 recurrence key，与变更影响一致，
// 无序对按身份字典序固定）。因此实例改期仍关联同一对（重叠时长变化或消除），
// 改地点则旧地点对消除、新地点对新增。冲突检测复用 detectConflicts 的分组与半开区间判定。

import { detectConflicts } from './conflicts';
import { instanceIdentity } from './diff';
import type { Instance } from './types';

export type ConflictChangeKind =
  | 'added' // 仅当前（候选）侧存在的冲突对
  | 'removed' // 仅原始侧存在的冲突对
  | 'overlap-changed'; // 两侧都存在但 UTC 重叠时长变化

export interface ConflictPair {
  /** 冲突对身份：location|identityA|identityB（identityA < identityB） */
  pairKey: string;
  location: string;
  /** 无序实例身份对（uid#原始 recurrence key，字典序固定） */
  identityA: string;
  identityB: string;
  a: Instance;
  b: Instance;
  /** 半开区间交集时长（秒），相切为 0 */
  overlapSec: number;
}

export interface ConflictChange {
  kind: ConflictChangeKind;
  pairKey: string;
  location: string;
  identityA: string;
  identityB: string;
  /** 原始侧重叠秒数（added 为 0） */
  beforeOverlapSec: number;
  /** 当前侧重叠秒数（removed 为 0） */
  afterOverlapSec: number;
  /** 原始侧实例对（added 时为 null） */
  beforeA: Instance | null;
  beforeB: Instance | null;
  /** 当前侧实例对（removed 时为 null） */
  afterA: Instance | null;
  afterB: Instance | null;
}

export const CONFLICT_CHANGE_LABEL: Record<ConflictChangeKind, string> = {
  added: '新增',
  removed: '消除',
  'overlap-changed': '重叠变化',
};

/** 半开区间重叠判定（与 detectConflicts 一致：相切不算冲突） */
function overlaps(a: Instance, b: Instance): boolean {
  return a.startUtc < b.endUtc && b.startUtc < a.endUtc;
}

/**
 * 枚举一组生效实例中的全部冲突对（复用 detectConflicts 的 LOCATION 分组，
 * 组内再按半开区间谓词逐对判定，与 byKey 的冲突关系完全一致）。
 * 同一身份对在同一地点只保留重叠最长的一条（身份重复时的确定性兜底）。
 */
export function collectConflictPairs(instances: Instance[]): ConflictPair[] {
  const { groups } = detectConflicts(instances);
  const byKey = new Map<string, ConflictPair>();
  for (const g of groups) {
    const list = g.instances;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i];
        const y = list[j];
        if (!overlaps(x, y)) continue;
        const idX = instanceIdentity(x);
        const idY = instanceIdentity(y);
        const [a, b, identityA, identityB] =
          idX <= idY ? [x, y, idX, idY] : [y, x, idY, idX];
        const pairKey = `${g.location}|${identityA}|${identityB}`;
        const overlapSec = Math.min(a.endUtc, b.endUtc) - Math.max(a.startUtc, b.startUtc);
        const prev = byKey.get(pairKey);
        if (!prev || overlapSec > prev.overlapSec) {
          byKey.set(pairKey, {
            pairKey,
            location: g.location,
            identityA,
            identityB,
            a,
            b,
            overlapSec,
          });
        }
      }
    }
  }
  return [...byKey.values()].sort((p, q) => p.pairKey.localeCompare(q.pairKey));
}

/**
 * 比较两份生效实例集合的冲突对。
 * @param baseline 原始日历展开结果（无规则编辑、无例外停用）
 * @param current  当前编辑状态下的展开结果
 */
export function diffConflictPairs(baseline: Instance[], current: Instance[]): ConflictChange[] {
  const beforeMap = new Map(collectConflictPairs(baseline).map((p) => [p.pairKey, p]));
  const afterMap = new Map(collectConflictPairs(current).map((p) => [p.pairKey, p]));

  const changes: ConflictChange[] = [];

  for (const [key, after] of afterMap) {
    const before = beforeMap.get(key);
    if (!before) {
      changes.push({
        kind: 'added',
        pairKey: key,
        location: after.location,
        identityA: after.identityA,
        identityB: after.identityB,
        beforeOverlapSec: 0,
        afterOverlapSec: after.overlapSec,
        beforeA: null,
        beforeB: null,
        afterA: after.a,
        afterB: after.b,
      });
    } else if (before.overlapSec !== after.overlapSec) {
      // 同一对冲突持续存在，但 UTC 重叠时长变化（改期 / 改时长所致）
      changes.push({
        kind: 'overlap-changed',
        pairKey: key,
        location: after.location,
        identityA: after.identityA,
        identityB: after.identityB,
        beforeOverlapSec: before.overlapSec,
        afterOverlapSec: after.overlapSec,
        beforeA: before.a,
        beforeB: before.b,
        afterA: after.a,
        afterB: after.b,
      });
    }
    // 两侧重叠时长一致：冲突持续且无变化，不列出
  }

  for (const [key, before] of beforeMap) {
    if (!afterMap.has(key)) {
      changes.push({
        kind: 'removed',
        pairKey: key,
        location: before.location,
        identityA: before.identityA,
        identityB: before.identityB,
        beforeOverlapSec: before.overlapSec,
        afterOverlapSec: 0,
        beforeA: before.a,
        beforeB: before.b,
        afterA: null,
        afterB: null,
      });
    }
  }

  changes.sort((x, y) => {
    const tx = x.afterA?.startUtc ?? x.beforeA?.startUtc ?? 0;
    const ty = y.afterA?.startUtc ?? y.beforeA?.startUtc ?? 0;
    return tx - ty || x.location.localeCompare(y.location) || x.pairKey.localeCompare(y.pairKey);
  });
  return changes;
}
