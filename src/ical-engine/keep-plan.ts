// 冲突保留方案（必留约束下的加权区间调度，仅预览，不改日历）
//
// 语义：
// 1. 参与集 = 当前生效实例中 LOCATION trim 后与所选值精确相等、且为正时长
//    （endUtc > startUtc）的实例；已取消 / 已排除实例本就不在生效列表中，天然不参与；
//    零时长 / 负时长实例不参与。
// 2. 实例身份 = UID + 原始 recurrence key（与“变更影响”一致）；权重（非负整数，
//    默认 1）与必留标记按身份保存；实例从参与集消失后其设置保留但不再参与，
//    重新出现时自动恢复生效。
// 3. 区间一律按 UTC 半开区间 [startUtc, endUtc)：a 与 b 重叠 ⟺
//    a.start < b.end && b.start < a.end，相切（端点相等）不算重叠。
// 4. 必留项两两不得重叠，否则列出全部冲突对并判定无解，不输出方案。
// 5. 在包含全部必留项的无重叠子集中最大化权重总和；同分时依次按
//    “保留实例数更多” → “身份排序列表字典序最小” 决胜。
//
// 算法：必留区间互不重叠时把时间轴切成若干空隙；与必留项重叠的普通实例必被舍弃，
// 其余完整落入某一空隙（区间连通，不会跨空隙），各空隙独立求解经典加权区间调度
// （按终点排序 + DP），每空隙内同样按（权重, 数量, 字典序）三级决胜——
// 等长列表在并上公共不相交集合后字典序关系保持，故逐空隙最优即全局最优。

import type { Instance } from './types';
import { instanceIdentity } from './diff';

/** 单个实例的保留设置：权重（非负整数）与必留标记 */
export interface KeepSetting {
  weight: number;
  must: boolean;
}

export const DEFAULT_KEEP_WEIGHT = 1;

/** 参与实例：生效实例中同 LOCATION 的正时长实例 + 生效的设置值 */
export interface KeepParticipant {
  inst: Instance;
  /** 身份：UID + 原始 recurrence key */
  identity: string;
  /** 生效权重（非负整数，默认 1） */
  weight: number;
  must: boolean;
}

/** 必留项之间的重叠对 */
export interface MustConflictPair {
  a: KeepParticipant;
  b: KeepParticipant;
}

export interface KeepPlanResult {
  /** 全部参与实例（按开始时间排序） */
  participants: KeepParticipant[];
  /** ok=已输出最优方案；infeasible=必留项互相重叠，无解、不输出方案 */
  status: 'ok' | 'infeasible';
  /** 必留项之间的全部重叠对（仅 infeasible 时非空） */
  mustPairs: MustConflictPair[];
  /** 保留列表（按开始时间排序；infeasible 时为空） */
  kept: KeepParticipant[];
  /** 舍弃列表（按开始时间排序；infeasible 时为空） */
  discarded: KeepParticipant[];
  /** 因与某必留项重叠而必被舍弃的身份集合（UI 标注用） */
  blockedByMust: Set<string>;
  /** 保留列表的权重总和 */
  totalWeight: number;
}

/** 权重清洗：非负整数；非法输入回退默认值 1 */
export function sanitizeWeight(w: unknown): number {
  const n = typeof w === 'number' ? w : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_KEEP_WEIGHT;
  return Math.floor(n);
}

/**
 * 计算冲突保留方案。
 * @param instances 当前生效实例（不含已取消 / 已排除）
 * @param location  目标 LOCATION（trim 后精确匹配）
 * @param settings  身份 -> 权重 / 必留设置（消失项的条目被忽略）
 */
export function computeKeepPlan(
  instances: Instance[],
  location: string,
  settings: Readonly<Record<string, KeepSetting | undefined>>
): KeepPlanResult {
  const loc = location.trim();
  const seen = new Set<string>();
  const participants: KeepParticipant[] = [];
  for (const inst of instances) {
    if (inst.location.trim() !== loc) continue;
    if (inst.endUtc <= inst.startUtc) continue; // 仅正时长
    const identity = instanceIdentity(inst);
    if (seen.has(identity)) continue; // 同身份去重（理论上每序列唯一，防御）
    seen.add(identity);
    const s = settings[identity];
    participants.push({
      inst,
      identity,
      weight: s ? sanitizeWeight(s.weight) : DEFAULT_KEEP_WEIGHT,
      must: s?.must === true,
    });
  }
  participants.sort(
    (a, b) => a.inst.startUtc - b.inst.startUtc || compareStr(a.identity, b.identity)
  );

  // 必留项两两重叠检测（按起点排序后，起点 >= 当前终点即不可能再与之重叠）
  const musts = participants
    .filter((p) => p.must)
    .sort(
      (a, b) =>
        a.inst.startUtc - b.inst.startUtc ||
        a.inst.endUtc - b.inst.endUtc ||
        compareStr(a.identity, b.identity)
    );
  const mustPairs: MustConflictPair[] = [];
  for (let i = 0; i < musts.length; i++) {
    const a = musts[i];
    for (let j = i + 1; j < musts.length; j++) {
      const b = musts[j];
      if (b.inst.startUtc >= a.inst.endUtc) break; // 半开区间：相切不算重叠
      mustPairs.push({ a, b });
    }
  }
  if (mustPairs.length > 0) {
    return {
      participants,
      status: 'infeasible',
      mustPairs,
      kept: [],
      discarded: [],
      blockedByMust: new Set(),
      totalWeight: 0,
    };
  }

  // 必留区间互不重叠且按起点排序 → 终点亦单调递增，把时间轴切成 musts.length + 1 个空隙
  const gaps: KeepParticipant[][] = Array.from({ length: musts.length + 1 }, () => []);
  const blockedByMust = new Set<string>();
  const mustEnds = musts.map((m) => m.inst.endUtc);
  for (const p of participants) {
    if (p.must) continue;
    // 空隙下标 = 终点 <= p.start 的必留项个数（之前的必留项必不与 p 重叠）
    let lo = 0;
    let hi = mustEnds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mustEnds[mid] <= p.inst.startUtc) lo = mid + 1;
      else hi = mid;
    }
    const next = musts[lo];
    if (next && p.inst.endUtc > next.inst.startUtc) {
      // 与第 lo 个必留项重叠（p.start < next.end 由二分保证）；更靠后的必留项
      // 起点更晚，若与它们重叠则必已与本项重叠，故只需检查这一个。
      blockedByMust.add(p.identity);
      continue;
    }
    gaps[lo].push(p);
  }

  // 各空隙独立求解，汇总最优选择
  const chosenIds = new Set<string>();
  for (const gap of gaps) {
    if (gap.length === 0) continue;
    for (const id of solveGap(gap)) chosenIds.add(id);
  }

  const kept: KeepParticipant[] = [];
  const discarded: KeepParticipant[] = [];
  let totalWeight = 0;
  for (const p of participants) {
    if (p.must || chosenIds.has(p.identity)) {
      kept.push(p);
      totalWeight += p.weight;
    } else {
      discarded.push(p);
    }
  }
  return {
    participants,
    status: 'ok',
    mustPairs: [],
    kept,
    discarded,
    blockedByMust,
    totalWeight,
  };
}

/** 单个空隙的加权区间调度：最大化（权重和, 实例数, 身份列表字典序最小） */
function solveGap(gap: KeepParticipant[]): string[] {
  const items = [...gap].sort(
    (a, b) =>
      a.inst.endUtc - b.inst.endUtc ||
      a.inst.startUtc - b.inst.startUtc ||
      compareStr(a.identity, b.identity)
  );
  const n = items.length;
  const ends = items.map((p) => p.inst.endUtc);
  // prev[j] = [0, j) 中终点 <= items[j].start 的最右下标（-1 表示无）
  const prev = new Array<number>(n);
  for (let j = 0; j < n; j++) {
    let lo = -1;
    let hi = j - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ends[mid] <= items[j].inst.startUtc) lo = mid;
      else hi = mid - 1;
    }
    prev[j] = lo;
  }

  // dp[j] = 仅考虑前 j 个（按终点排序）实例的最优解
  const dp: DpVal[] = new Array<DpVal>(n + 1);
  dp[0] = { w: 0, c: 0, ids: [] };
  for (let j = 1; j <= n; j++) {
    const it = items[j - 1];
    const base = dp[prev[j - 1] + 1];
    const take: DpVal = {
      w: base.w + it.weight,
      c: base.c + 1,
      ids: insertSorted(base.ids, it.identity),
    };
    dp[j] = betterDp(dp[j - 1], take);
  }
  return dp[n].ids;
}

interface DpVal {
  /** 权重总和 */
  w: number;
  /** 实例数 */
  c: number;
  /** 已选身份（升序） */
  ids: string[];
}

/** 三级决胜：权重大者优 → 数量多者优 → 身份排序列表字典序小者优 */
function betterDp(x: DpVal, y: DpVal): DpVal {
  if (x.w !== y.w) return x.w > y.w ? x : y;
  if (x.c !== y.c) return x.c > y.c ? x : y;
  return compareIdList(x.ids, y.ids) <= 0 ? x : y;
}

/** 有序插入（保持升序） */
function insertSorted(ids: string[], id: string): string[] {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] < id) lo = mid + 1;
    else hi = mid;
  }
  return [...ids.slice(0, lo), id, ...ids.slice(lo)];
}

/** 身份列表字典序（按码元比较，保证跨环境确定性） */
function compareIdList(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return compareStr(a[i], b[i]);
  }
  return a.length - b.length;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
