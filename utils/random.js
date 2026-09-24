// random.js — 可用池过滤与加权随机
// 全部为纯函数,不依赖 wx,便于单测与复用。

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 计算当前被时间范围冷却排除的选项 id 集合(仅时间模式使用)
 * @param {Array<{itemId: string, ts: number}>} confirmLog 确定记录,按时间升序
 * @param {{dedupDays: number}} settings 冷却设置(取天数)
 * @param {number} now 当前时间戳(ms)
 * @returns {Set<string>} 被排除的选项 id 集合
 */
function getExcludedIds(confirmLog, settings, now) {
  const excluded = new Set();
  const since = now - settings.dedupDays * DAY_MS;
  confirmLog.forEach((entry) => {
    if (entry.ts >= since) {
      excluded.add(entry.itemId);
    }
  });
  return excluded;
}

/**
 * 过滤出当前可摇的候选:
 * 次数模式排除冷却摇数未归零的选项(cooldown 随每次摇出结果递减);
 * 时间模式排除 N 天内确定过的选项
 * @param {Array<{id: string, name: string, weight: number, cooldown?: number}>} items 全部候选
 * @param {Array<{itemId: string, ts: number}>} confirmLog 确定记录
 * @param {{dedupMode: string, dedupDays: number, dedupCount: number}} settings 冷却设置
 * @param {number} now 当前时间戳(ms)
 * @returns {Array} 可用候选子集(原对象引用,不拷贝)
 */
function getAvailableItems(items, confirmLog, settings, now) {
  if (settings.dedupMode === 'count') {
    return items.filter((it) => !(it.cooldown > 0));
  }
  const excluded = getExcludedIds(confirmLog, settings, now);
  return items.filter((it) => !excluded.has(it.id));
}

/**
 * 按权重轮盘赌随机选一个
 * @param {Array<{id: string, name: string, weight: number}>} items 候选,weight 必须为正
 * @returns {object|null} 命中的候选;空数组或总权重非正时返回 null
 */
function weightedPick(items) {
  if (!items || items.length === 0) {
    return null;
  }
  const effective = (it) => (typeof it.weight === 'number' && it.weight > 0 ? it.weight : 0);
  const total = items.reduce((sum, it) => sum + effective(it), 0);
  if (total <= 0) {
    return null;
  }
  let rest = Math.random() * total;
  for (let i = 0; i < items.length; i += 1) {
    rest -= effective(items[i]);
    if (rest < 0) {
      return items[i];
    }
  }
  // 浮点累加误差兜底:理论上不可达,返回最后一项保证不悬空
  return items[items.length - 1];
}

module.exports = { DAY_MS, getExcludedIds, getAvailableItems, weightedPick };
