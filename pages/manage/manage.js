// manage.js — 管理页:候选名单增删、批量导入、权重管理、防重复设置
// 数据流:每次操作后调用 refresh() 从 store 重读并重算展示字段,保持单一数据源。
const store = require('../../utils/store');

Page({
  data: {
    /** 全部分组(含选项数),供分组条渲染 */
    lists: [],
    /** 当前选中分组 id */
    activeListId: '',
    /** 名单列表,含展示字段:weightPct 权重条宽度百分比、isReduced 是否被降权 */
    items: [],
    /** 是否存在被降权的选项,控制「全部恢复」区块显隐 */
    hasReduced: false,
    /** 单个添加输入框内容 */
    inputName: '',
    /** 批量导入弹层开关 */
    importOpen: false,
    /** 批量导入 textarea 内容 */
    importText: '',
    /** 冷却设置 {dedupMode, dedupDays, dedupCount} */
    settings: {},
    /** 当前冷却中的选项个数(按当前模式统计) */
    blockedCount: 0,
  },

  // 职责:每次进入/返回本页时刷新数据(管理操作都可能改变存储)
  onShow() {
    this.refresh();
  },

  // 职责:从 store 重读数据并计算展示字段;副作用:setData 覆盖 items/hasReduced/settings/logCount
  refresh() {
    const data = store.read();
    const list = store.getList(data);
    const items = list.items.map((it) => ({
      id: it.id,
      name: it.name,
      weight: it.weight,
      weightPct: Math.round(it.weight * 100),
      isReduced: it.weight < store.WEIGHT_INIT,
    }));
    this.setData({
      lists: data.lists.map((l) => ({ id: l.id, name: l.name, count: l.items.length })),
      activeListId: data.activeListId,
      items,
      hasReduced: items.some((it) => it.isReduced),
      settings: data.settings,
      blockedCount: store.getBlockedCount(),
    });
  },

  /**
   * 切换当前分组(首页摇一摇随选中分组变化)
   * @param {{currentTarget: {dataset: {id: string}}}} e 分组标签点击事件
   */
  onSelectList(e) {
    store.setActiveList(e.currentTarget.dataset.id);
    this.refresh();
  },

  // 职责:弹输入框新建分组(重名拦截);成功后自动切换到新分组,便于直接添加选项
  onAddList() {
    wx.showModal({
      title: '新建分组',
      editable: true,
      placeholderText: '输入分组名,如:吃什么、去哪玩',
      success: (r) => {
        if (!r.confirm) return;
        const result = store.addList(r.content);
        if (!result.ok) {
          const msg = result.reason === 'dup' ? '已有同名分组' : '先输入分组名';
          wx.showToast({ title: msg, icon: 'none' });
          return;
        }
        this.refresh();
      },
    });
  },

  // 职责:弹输入框重命名当前分组(与其他分组重名拦截)
  onRenameList() {
    const list = store.getList();
    wx.showModal({
      title: '重命名分组',
      editable: true,
      placeholderText: list.name,
      success: (r) => {
        if (!r.confirm) return;
        const result = store.renameList(list.id, r.content);
        if (!result.ok) {
          const msg = result.reason === 'dup' ? '已有同名分组' : result.reason === 'empty' ? '先输入分组名' : '分组不存在';
          wx.showToast({ title: msg, icon: 'none' });
          return;
        }
        this.refresh();
      },
    });
  },

  // 职责:删除当前分组(至少保留一个);二次确认并说明连带删除的选项数
  onRemoveList() {
    const data = store.read();
    const list = store.getList(data);
    if (data.lists.length <= 1) {
      wx.showToast({ title: '至少保留一个分组', icon: 'none' });
      return;
    }
    wx.showModal({
      title: `删除分组「${list.name}」`,
      content: `分组内 ${list.items.length} 个选项将一并删除,确定删除?`,
      confirmText: '删除',
      confirmColor: '#e6554f',
      success: (r) => {
        if (!r.confirm) return;
        store.removeList(list.id);
        this.refresh();
      },
    });
  },

  /**
   * 修改选项名:点击选项名称触发,当前分组内重名拦截
   * @param {{currentTarget: {dataset: {id: string}}}} e 选项名称点击事件
   */
  onRenameItem(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find((it) => it.id === id);
    if (!item) return;
    wx.showModal({
      title: '修改选项名',
      editable: true,
      placeholderText: item.name,
      success: (r) => {
        if (!r.confirm) return;
        const result = store.renameItem(id, r.content);
        if (!result.ok) {
          const msg = result.reason === 'dup' ? '这个名称已存在' : result.reason === 'empty' ? '先输入名称' : '选项不存在';
          wx.showToast({ title: msg, icon: 'none' });
          return;
        }
        this.refresh();
      },
    });
  },

  // 职责:同步单个添加输入框到 data
  onInputName(e) {
    this.setData({ inputName: e.detail.value });
  },

  // 职责:添加单个选项名称;空值/重名时 toast 提示,成功后清空输入框
  onAdd() {
    const name = this.data.inputName;
    const result = store.addItem(name);
    if (!result.ok) {
      const msg = result.reason === 'dup' ? '这个已经在名单里啦' : result.reason === 'full' ? '每组最多 20 个' : '先输入名称';
      wx.showToast({ title: msg, icon: 'none' });
      return;
    }
    this.setData({ inputName: '' });
    this.refresh();
  },

  /**
   * 删除单个选项:二次确认后删除
   * @param {{currentTarget: {dataset: {id: string}}}} e 行内删除按钮事件
   */
  onRemove(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find((it) => it.id === id);
    wx.showModal({
      title: '删除候选',
      content: `确定删除「${item ? item.name : ''}」?`,
      confirmText: '删除',
      confirmColor: '#e6554f',
      success: (r) => {
        if (!r.confirm) return;
        store.removeItem(id);
        this.refresh();
      },
    });
  },

  // 职责:打开批量导入弹层
  openImport() {
    this.setData({ importOpen: true, importText: '' });
  },

  // 职责:关闭批量导入弹层
  closeImport() {
    this.setData({ importOpen: false, importText: '' });
  },

  // 职责:同步批量导入 textarea 内容
  onImportText(e) {
    this.setData({ importText: e.detail.value });
  },

  // 职责:执行批量导入——按行拆分、去空白、重名跳过,导入后 toast 汇总
  doImport() {
    const names = this.data.importText.split(/\n/);
    if (names.map((n) => n.trim()).filter(Boolean).length === 0) {
      wx.showToast({ title: '先粘贴几行内容', icon: 'none' });
      return;
    }
    const { added, skipped, full } = store.batchAdd(names);
    this.closeImport();
    this.refresh();
    const msg = full ? `每组上限 20 个,已新增 ${added} 个` : `新增 ${added} 个,跳过重复 ${skipped} 个`;
    wx.showToast({ title: msg, icon: 'none' });
  },

  /**
   * 恢复单个选项权重为 1.0
   * @param {{currentTarget: {dataset: {id: string}}}} e 行内恢复按钮事件
   */
  onResetWeight(e) {
    store.resetWeight(e.currentTarget.dataset.id);
    this.refresh();
  },

  // 职责:一键恢复全部权重,带二次确认
  onResetAll() {
    wx.showModal({
      title: '恢复全部权重',
      content: '所有被「减少推荐」的选项都将恢复为 1.0',
      confirmText: '恢复',
      success: (r) => {
        if (!r.confirm) return;
        store.resetAllWeights();
        this.refresh();
      },
    });
  },

  // 职责:切换冷却模式为「时间范围」
  onModeDays() {
    store.updateSettings({ dedupMode: 'days' });
    this.refresh();
  },

  // 职责:切换冷却模式为「按次数」
  onModeCount() {
    store.updateSettings({ dedupMode: 'count' });
    this.refresh();
  },

  /**
   * 调整时间范围天数(滑块落定时写入)
   * @param {{detail: {value: number}}} e slider change 事件
   */
  onDaysChange(e) {
    store.updateSettings({ dedupDays: Math.round(e.detail.value) });
    this.refresh();
  },

  /**
   * 调整次数模式的家数(滑块落定时写入)
   * @param {{detail: {value: number}}} e slider change 事件
   */
  onCountChange(e) {
    store.updateSettings({ dedupCount: Math.round(e.detail.value) });
    this.refresh();
  },

  // 职责:清空冷却记录(时间模式确定记录 + 次数模式冷却),带后果说明的二次确认
  onClearLog() {
    wx.showModal({
      title: '清空冷却记录',
      content: '清空后,所有冷却中的选项都会立即恢复可摇。',
      confirmText: '清空',
      confirmColor: '#e6554f',
      success: (r) => {
        if (!r.confirm) return;
        store.clearConfirmLog();
        this.refresh();
      },
    });
  },

  // 职责:空实现,用于 catchtouchmove 阻止导入弹层下的页面滚动穿透
  noop() {},
});
