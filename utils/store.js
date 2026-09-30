// store.js — 数据模型与本地存储封装
// 数据整体存于 wx.storage 的单 key;架构预留多名单(lists),首版 UI 只使用 activeListId 指向的名单。
// 「确定才占用」:点「确定选择」时,时间模式写 confirmLog(按天冷却),次数模式给该选项设 cooldown(按摇动次数冷却)。

/** 本地存储 key,带版本号便于未来迁移 */
const STORAGE_KEY = 'blindshake_data_v1';
/** 确定记录最大保留天数:需大于设置项允许的最大防重复天数,过期记录无判断价值 */
const LOG_RETENTION_DAYS = 90;
/** 权重下限:与单次降幅对齐,「减少推荐」最多点 3 次(1.0 → 0.25),概率降低但保留被摇中的机会 */
const WEIGHT_MIN = 0.25;
/** 权重初始值 */
const WEIGHT_INIT = 1.0;
/** 「减少推荐」单次降低的权重:按 25% 逐档下降(1.0 → 0.75 → 0.5 → 0.25) */
const WEIGHT_STEP = 0.25;
/** 设置项允许的防重复参数上限:天数与记录清理周期对应 */
const DEDUP_DAYS_MAX = 30;
const DEDUP_COUNT_MAX = 15;
/** 每个分组允许的最大选项数 */
const MAX_ITEMS_PER_LIST = 20;
/** 分组数量上限:分组对应决策场景,个人使用 6 个足够,同时避免标签条与切换弹层失控 */
const MAX_LISTS = 6;
/** 分组名称最大长度(字符):防止横向标签胶囊被超长名撑破 */
const MAX_LIST_NAME_LEN = 10;
/** 选项名称最大长度(字符):防止名单行与出奖面板被超长名撑破 */
const MAX_ITEM_NAME_LEN = 15;

/**
 * 生成短随机 id
 * @returns {string} 形如 "m3xk92f-a1b2c" 的高概率唯一串
 */
function genId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * 构造全新默认数据
 * @returns {object} 完整数据结构:单名单「我的选项」、无候选、无确定记录、默认按次数冷却(5 次)
 */
function defaultData() {
  return {
    version: 1,
    lists: [{ id: 'default', name: '我的选项', items: [] }],
    activeListId: 'default',
    confirmLog: [],
    settings: { dedupMode: 'count', dedupDays: 7, dedupCount: 5 },
  };
}

/**
 * 读取并修复数据:字段缺失或类型损坏时以默认值兜底合并
 * @returns {object} 结构保证完整的数据
 */
function read() {
  let data;
  try {
    data = wx.getStorageSync(STORAGE_KEY);
  } catch (e) {
    data = null;
  }
  const def = defaultData();
  if (!data || typeof data !== 'object') {
    return def;
  }
  // 逐字段兜底:storage 可能被外部工具改坏,任何一处损坏都不应导致整站崩溃
  if (!Array.isArray(data.lists) || data.lists.length === 0) {
    data.lists = def.lists;
  }
  data.lists = data.lists.map((list) => ({
    id: list.id || genId(),
    name: list.name || '未命名',
    items: Array.isArray(list.items)
      ? list.items.filter((it) => it && typeof it.name === 'string').map((it) => ({
          id: it.id || genId(),
          name: it.name,
          weight: typeof it.weight === 'number' && it.weight > 0 ? it.weight : WEIGHT_INIT,
          cooldown: typeof it.cooldown === 'number' && it.cooldown > 0 ? Math.floor(it.cooldown) : 0,
        }))
      : [],
  }));
  if (!data.lists.some((l) => l.id === data.activeListId)) {
    data.activeListId = data.lists[0].id;
  }
  if (!Array.isArray(data.confirmLog)) {
    data.confirmLog = [];
  }
  data.confirmLog = data.confirmLog.filter(
    (e) => e && typeof e.itemId === 'string' && typeof e.ts === 'number'
  );
  const s = data.settings || {};
  data.settings = {
    dedupMode: s.dedupMode === 'days' ? 'days' : 'count',
    dedupDays: clampInt(s.dedupDays, 1, DEDUP_DAYS_MAX, def.settings.dedupDays),
    dedupCount: clampInt(s.dedupCount, 1, DEDUP_COUNT_MAX, def.settings.dedupCount),
  };
  return data;
}

/**
 * 数值钳制:非数字或越界时回到默认值
 * @param {*} v 待校验值
 * @param {number} min 下限
 * @param {number} max 上限
 * @param {number} fallback 非法时的默认值
 * @returns {number} 夹取后的整数
 */
function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 持久化写入
 * @param {object} data 完整数据;写入失败仅打日志,不中断调用方
 */
function write(data) {
  try {
    wx.setStorageSync(STORAGE_KEY, data);
  } catch (e) {
    console.error('[blindshake] 存储写入失败', e);
  }
}

/**
 * 启动初始化:存储为空时写入默认结构
 * @returns {object} 当前数据
 */
function init() {
  const data = read();
  write(data);
  return data;
}

/**
 * 取当前选中分组(首页摇一摇的数据来源)
 * @param {object} [data] 可传入已读数据省一次读取;缺省时自行读取
 * @returns {object} 分组对象 {id, name, items}
 */
function getList(data) {
  const d = data || read();
  return d.lists.find((l) => l.id === d.activeListId) || d.lists[0];
}

/**
 * 在当前分组中追加一个选项(重名/超长拦截,单组上限 MAX_ITEMS_PER_LIST)
 * @param {string} name 选项名称,前后空白会被裁掉
 * @returns {{ok: boolean, reason?: string}} ok=false 时 reason 为 'empty'|'dup'|'full'|'tooLong'
 */
function addItem(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_ITEM_NAME_LEN) return { ok: false, reason: 'tooLong' };
  const data = read();
  const list = getList(data);
  if (list.items.some((it) => it.name === trimmed)) {
    return { ok: false, reason: 'dup' };
  }
  if (list.items.length >= MAX_ITEMS_PER_LIST) {
    return { ok: false, reason: 'full' };
  }
  list.items.push({ id: genId(), name: trimmed, weight: WEIGHT_INIT, cooldown: 0 });
  write(data);
  return { ok: true };
}

/**
 * 批量导入:逐行添加并跳过重名;超长行截断到 MAX_ITEM_NAME_LEN 并计数(粘贴场景截断优于丢行),
 * 截断后落入的重名行照常跳过;超出单组上限的部分计入跳过
 * @param {string[]} names 选项名称数组(每项内部会 trim)
 * @returns {{added: number, skipped: number, full: boolean, truncated: number}} 新增/跳过数量、full 满员截断标记、truncated 超长截断行数
 */
function batchAdd(names) {
  let added = 0;
  let skipped = 0;
  let full = false;
  let truncated = 0;
  const data = read();
  const list = getList(data);
  names.forEach((raw) => {
    let name = (raw || '').trim();
    if (!name) return;
    if (name.length > MAX_ITEM_NAME_LEN) {
      name = name.slice(0, MAX_ITEM_NAME_LEN);
      truncated += 1;
    }
    if (list.items.length >= MAX_ITEMS_PER_LIST) {
      full = true;
      skipped += 1;
      return;
    }
    if (list.items.some((it) => it.name === name)) {
      skipped += 1;
      return;
    }
    list.items.push({ id: genId(), name, weight: WEIGHT_INIT, cooldown: 0 });
    added += 1;
  });
  write(data);
  return { added, skipped, full, truncated };
}

/**
 * 删除一个选项;其历史确定记录保留(仍参与时间模式冷却判断,直至自然过期)
 * @param {string} itemId 选项 id
 * @returns {boolean} 是否确实删除了
 */
function removeItem(itemId) {
  const data = read();
  const list = getList(data);
  const before = list.items.length;
  list.items = list.items.filter((it) => it.id !== itemId);
  write(data);
  return list.items.length < before;
}

/**
 * 降低某选项权重:每次减 WEIGHT_STEP(0.25),不低于 WEIGHT_MIN
 * 兼容旧数据:历史版本可能存过 0.1 这类低于下限的值,已处于最低档时保持不变(点「减少推荐」不会回升)
 * @param {string} itemId 选项 id
 * @returns {number|null} 新权重;选项不存在时返回 null
 */
function reduceWeight(itemId) {
  const data = read();
  const list = getList(data);
  const item = list.items.find((it) => it.id === itemId);
  if (!item) return null;
  if (item.weight <= WEIGHT_MIN) return item.weight;
  item.weight = Math.max(WEIGHT_MIN, item.weight - WEIGHT_STEP);
  write(data);
  return item.weight;
}

/**
 * 恢复某选项权重为初始值
 * @param {string} itemId 选项 id
 * @returns {boolean} 选项是否存在
 */
function resetWeight(itemId) {
  const data = read();
  const list = getList(data);
  const item = list.items.find((it) => it.id === itemId);
  if (!item) return false;
  item.weight = WEIGHT_INIT;
  write(data);
  return true;
}

/**
 * 一键恢复全名单权重
 */
function resetAllWeights() {
  const data = read();
  getList(data).items.forEach((it) => {
    it.weight = WEIGHT_INIT;
  });
  write(data);
}

/**
 * 记录一次「确定选择」:写入确定记录(时间模式冷却依据);
 * 次数模式下同时给该选项设置冷却摇数
 * @param {string} itemId 选项 id
 * @returns {boolean} 选项是否存在(已删除的选项不记录)
 */
function confirmItem(itemId) {
  const data = read();
  const list = getList(data);
  const item = list.items.find((it) => it.id === itemId);
  if (!item) {
    return false;
  }
  const now = Date.now();
  const expireBefore = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  data.confirmLog = data.confirmLog.filter((e) => e.ts >= expireBefore);
  data.confirmLog.push({ itemId, ts: now });
  if (data.settings.dedupMode === 'count') {
    item.cooldown = data.settings.dedupCount;
  }
  write(data);
  return true;
}

/**
 * 冷却推进:每摇出一次结果后调用,次数模式下所有冷却中的选项剩余摇数 -1
 * @returns {number} 递减后仍在冷却中的选项数
 */
function tickCooldowns() {
  const data = read();
  let blocked = 0;
  getList(data).items.forEach((it) => {
    if (it.cooldown > 0) {
      it.cooldown -= 1;
      if (it.cooldown > 0) {
        blocked += 1;
      }
    }
  });
  write(data);
  return blocked;
}

/**
 * 清零全部冷却(「解锁全部」/切换到次数模式时使用)
 */
function resetCooldowns() {
  const data = read();
  getList(data).items.forEach((it) => {
    it.cooldown = 0;
  });
  write(data);
}

/**
 * 按当前模式统计被冷却排除的选项数:次数模式数冷却中的选项,时间模式数 N 天内确定过的选项
 * @returns {number} 冷却中的选项个数
 */
function getBlockedCount() {
  const data = read();
  const list = getList(data);
  if (data.settings.dedupMode === 'count') {
    return list.items.filter((it) => it.cooldown > 0).length;
  }
  const since = Date.now() - data.settings.dedupDays * 24 * 60 * 60 * 1000;
  const ids = new Set(data.confirmLog.filter((e) => e.ts >= since).map((e) => e.itemId));
  return list.items.filter((it) => ids.has(it.id)).length;
}

/**
 * 清空确定记录并解除全部冷却(「解锁全部」):所有选项立刻恢复可摇
 */
function clearConfirmLog() {
  const data = read();
  data.confirmLog = [];
  getList(data).items.forEach((it) => {
    it.cooldown = 0;
  });
  write(data);
}

/**
 * 局部更新设置项;切换到次数模式时清零历史冷却,从下一次确定开始计
 * @param {object} patch 仅传需要修改的字段,如 { dedupDays: 3 }
 */
function updateSettings(patch) {
  const data = read();
  const prevMode = data.settings.dedupMode;
  data.settings = Object.assign({}, data.settings, patch);
  if (patch.dedupMode === 'count' && prevMode !== 'count') {
    // 切回次数模式:在当前快照上清零历史冷却;
    // 不能调 resetCooldowns——它自读自写存储,随后的 write(data) 会把旧冷却覆盖回来
    getList(data).items.forEach((it) => { it.cooldown = 0; });
  }
  write(data);
}

/**
 * 新建分组(重名/超长/数量拦截),建成后自动切换为当前分组
 * @param {string} name 分组名,前后空白会被裁掉
 * @returns {{ok: boolean, reason?: string, id?: string}} ok=false 时 reason 为 'empty'|'dup'|'tooLong'|'full'
 */
function addList(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_LIST_NAME_LEN) return { ok: false, reason: 'tooLong' };
  const data = read();
  if (data.lists.length >= MAX_LISTS) return { ok: false, reason: 'full' };
  if (data.lists.some((l) => l.name === trimmed)) {
    return { ok: false, reason: 'dup' };
  }
  const list = { id: genId(), name: trimmed, items: [] };
  data.lists.push(list);
  data.activeListId = list.id;
  write(data);
  return { ok: true, id: list.id };
}

/**
 * 重命名分组(与其他分组重名/超长拦截)
 * @param {string} listId 分组 id
 * @param {string} name 新名称
 * @returns {{ok: boolean, reason?: string}} reason: 'empty'|'dup'|'tooLong'|'missing'
 */
function renameList(listId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_LIST_NAME_LEN) return { ok: false, reason: 'tooLong' };
  const data = read();
  const list = data.lists.find((l) => l.id === listId);
  if (!list) return { ok: false, reason: 'missing' };
  if (data.lists.some((l) => l.id !== listId && l.name === trimmed)) {
    return { ok: false, reason: 'dup' };
  }
  list.name = trimmed;
  write(data);
  return { ok: true };
}

/**
 * 删除分组:至少保留一个分组;连带清理组内选项的确定记录(冷却随选项删除自然消失)
 * @param {string} listId 分组 id
 * @returns {{ok: boolean, reason?: string}} reason: 'last'|'missing'
 */
function removeList(listId) {
  const data = read();
  if (data.lists.length <= 1) {
    return { ok: false, reason: 'last' };
  }
  const list = data.lists.find((l) => l.id === listId);
  if (!list) return { ok: false, reason: 'missing' };
  const removedIds = new Set(list.items.map((it) => it.id));
  data.lists = data.lists.filter((l) => l.id !== listId);
  data.confirmLog = data.confirmLog.filter((e) => !removedIds.has(e.itemId));
  if (data.activeListId === listId) {
    data.activeListId = data.lists[0].id;
  }
  write(data);
  return { ok: true };
}

/**
 * 重命名选项(当前分组内重名/超长拦截)
 * @param {string} itemId 选项 id
 * @param {string} name 新名称
 * @returns {{ok: boolean, reason?: string}} reason: 'empty'|'dup'|'tooLong'|'missing'
 */
function renameItem(itemId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_ITEM_NAME_LEN) return { ok: false, reason: 'tooLong' };
  const data = read();
  const list = getList(data);
  const item = list.items.find((it) => it.id === itemId);
  if (!item) return { ok: false, reason: 'missing' };
  if (list.items.some((it) => it.id !== itemId && it.name === trimmed)) {
    return { ok: false, reason: 'dup' };
  }
  item.name = trimmed;
  write(data);
  return { ok: true };
}

/**
 * 切换当前分组;id 不存在时静默忽略
 * @param {string} listId 分组 id
 */
function setActiveList(listId) {
  const data = read();
  if (data.lists.some((l) => l.id === listId)) {
    data.activeListId = listId;
    write(data);
  }
}

module.exports = {
  WEIGHT_INIT,
  WEIGHT_MIN,
  DEDUP_DAYS_MAX,
  DEDUP_COUNT_MAX,
  MAX_ITEMS_PER_LIST,
  MAX_LISTS,
  MAX_LIST_NAME_LEN,
  MAX_ITEM_NAME_LEN,
  genId,
  defaultData,
  read,
  init,
  getList,
  addList,
  renameList,
  removeList,
  renameItem,
  setActiveList,
  addItem,
  batchAdd,
  removeItem,
  reduceWeight,
  resetWeight,
  resetAllWeights,
  confirmItem,
  tickCooldowns,
  resetCooldowns,
  getBlockedCount,
  clearConfirmLog,
  updateSettings,
};
