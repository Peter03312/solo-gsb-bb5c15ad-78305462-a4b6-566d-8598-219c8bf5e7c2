// 场地周转审计
// 按当前生效实例的非空 LOCATION 分组，枚举同地点每对正时长实例：
//   - 原始 UTC 半开区间 [start, end) 相交（start_b < end_a，相切不算）→ 现有时间冲突；
//   - 原始时段不相交，但加入“前一实例结束后清场 + 后一实例开始前布场”的周转分钟后
//     半开缓冲区间相交（start_b - setup < end_a + teardown）→ 周转不足。
// 全部比较使用绝对时间（unix 秒），跨午夜与夏令时自动正确，不按本地日期/墙钟切断事件。
// 已取消 / 已排除实例不在生效列表中，天然不参与；零时长 / 负时长实例不参与。
// 布场 / 清场分钟按地点配置（0～240，默认 0），同一地点的全部实例共用一对设置。

import type { Instance } from './types';
import { instanceIdentity } from './diff';

export const MAX_TURNOVER_MINUTES = 240;
export const DEFAULT_TURNOVER_MINUTES = 0;

/** 单个地点的周转设置：活动前布场分钟、结束后清场分钟（0～240，默认 0） */
export interface TurnoverSetting {
  setupMin: number;
  teardownMin: number;
}

export type TurnoverKind =
  | 'conflict' // 原始时段相交：现有时间冲突
  | 'short'; // 原始时段不相交但缓冲后相交：周转不足

export interface TurnoverPair {
  kind: TurnoverKind;
  location: string;
  /** 冲突对身份：location|identityLo|identityHi（身份按字典序固定，无序对） */
  pairKey: string;
  /** 无序实例身份对中字典序较小 / 大者（UID#原始 recurrence key） */
  identityA: string;
  identityB: string;
  /** 时间更早的一侧（起点相同时按身份字典序） */
  first: Instance;
  /** 时间更晚的一侧 */
  second: Instance;
  /** 原始时段相交秒数（半开交集）；仅 conflict 时为正，相切为 0 */
  overlapSec: number;
  /** 实际间隔秒数 = second.start - first.end（相交时为负，即负的重叠秒）；绝对时间 */
  gapSec: number;
  /** 所需周转秒数 = first 清场 + second 布场（同地点共用设置） */
  requiredSec: number;
  /** 缺口秒数 = requiredSec - gapSec；仅 short 时为正（缓冲不足量） */
  shortfallSec: number;
  /** 该对判定时生效的布场 / 清场分钟（清洗后） */
  setupMin: number;
  teardownMin: number;
}

export const TURNOVER_LABEL: Record<TurnoverKind, string> = {
  conflict: '现有时间冲突',
  short: '周转不足',
};

/** 分钟数清洗：0～240 的非负整数；非法输入回退默认 0，小数向下取整，越界截断 */
export function sanitizeTurnoverMinutes(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_TURNOVER_MINUTES;
  return Math.min(MAX_TURNOVER_MINUTES, Math.max(0, Math.floor(n)));
}

/**
 * 计算场地周转审计对（全部非空 LOCATION 合并输出，已按起点排序）。
 * @param instances 当前生效实例（不含已取消 / 已排除）
 * @param settings  LOCATION -> 布场 / 清场分钟（缺失地点按 0/0）
 */
export function computeTurnoverAudit(
  instances: Instance[],
  settings: Readonly<Record<string, TurnoverSetting | undefined>>
): TurnoverPair[] {
  const byLocation = new Map<string, Instance[]>();
  for (const inst of instances) {
    const loc = inst.location.trim();
    if (!loc) continue;
    if (inst.endUtc <= inst.startUtc) continue; // 仅正时长实例
    const arr = byLocation.get(loc);
    if (arr) arr.push(inst);
    else byLocation.set(loc, [inst]);
  }

  const pairs: TurnoverPair[] = [];

  for (const [location, arr] of byLocation) {
    const raw = settings[location];
    const setupMin = raw ? sanitizeTurnoverMinutes(raw.setupMin) : DEFAULT_TURNOVER_MINUTES;
    const teardownMin = raw ? sanitizeTurnoverMinutes(raw.teardownMin) : DEFAULT_TURNOVER_MINUTES;
    const setupSec = setupMin * 60;
    const teardownSec = teardownMin * 60;
    const requiredSec = setupSec + teardownSec;

    // 同身份去重（理论上每序列唯一，防御），再按起点 / 身份排序
    const uniq = new Map<string, Instance>();
    for (const inst of arr) {
      const id = instanceIdentity(inst);
      if (!uniq.has(id)) uniq.set(id, inst);
    }
    const list = [...uniq.values()].sort(
      (a, b) =>
        a.startUtc - b.startUtc ||
        compareStr(instanceIdentity(a), instanceIdentity(b))
    );

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      // 缓冲区间 [start-setup, end+teardown) 是否相交取决于“a 清场后终点”与
      // “b 布场前起点”；对内层循环，a 的清场量为常量，但 b 的布场量也影响是否可
      // 提前终止，故 break 边界同时加上两者（设置按地点共用）。
      const bufferedEnd = a.endUtc + teardownSec + setupSec;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        // 半开缓冲区间 [start-setup, end+teardown)：相切（等号）不算相交
        if (b.startUtc >= bufferedEnd) break;

        const idA = instanceIdentity(a);
        const idB = instanceIdentity(b);
        const [idLo, idHi] = idA <= idB ? [idA, idB] : [idB, idA];
        // a 起点不晚于 b（起点相同则身份更小），故 max(start) = b.start
        const overlapSec = Math.min(a.endUtc, b.endUtc) - b.startUtc;
        const gapSec = b.startUtc - a.endUtc;

        if (b.startUtc < a.endUtc) {
          // 原始时段相交 → 现有时间冲突（与缓冲设置无关，恒列出）
          pairs.push({
            kind: 'conflict',
            location,
            pairKey: `${location}|${idLo}|${idHi}`,
            identityA: idLo,
            identityB: idHi,
            first: a,
            second: b,
            overlapSec,
            gapSec,
            requiredSec,
            shortfallSec: 0,
            setupMin,
            teardownMin,
          });
        } else {
          // 原始时段不相交（gap >= 0，相切 gap=0）但缓冲后相交 → 周转不足
          pairs.push({
            kind: 'short',
            location,
            pairKey: `${location}|${idLo}|${idHi}`,
            identityA: idLo,
            identityB: idHi,
            first: a,
            second: b,
            overlapSec: 0,
            gapSec,
            requiredSec,
            shortfallSec: requiredSec - gapSec,
            setupMin,
            teardownMin,
          });
        }
      }
    }
  }

  // 列表按起点（绝对时间）排序；同起点按地点、身份对稳定排序
  pairs.sort(
    (p, q) =>
      p.first.startUtc - q.first.startUtc ||
      p.location.localeCompare(q.location) ||
      p.pairKey.localeCompare(q.pairKey)
  );
  return pairs;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
