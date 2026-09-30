// manage.js — 管理页:候选名单增删、批量导入、权重管理、防重复设置
// 数据流:每次操作后调用 refresh() 从 store 重读并重算展示字段,保持单一数据源。
const store = require('../../utils/store');

Page({
  data: {
    /** 全部分组(含选项数),供分组条渲染 */
    lists: [],
    /** 当前选中分组 id */
    activeListId: '',
    /** 名单列表,含展示字段:weightPct 权重条宽度百分比、weightText 权重显示文本、isReduced 是否被降权 */
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
    /** 选项名称长度上限,供规则提示与输入计数展示 */
    maxItemNameLen: store.MAX_ITEM_NAME_LEN,
    /** 每组选项数上限,供规则提示展示 */
    maxItemsPerList: store.MAX_ITEMS_PER_LIST,
    /** 通用弹框状态:type 标识确认后的动作,其余字段透传给 app-dialog 组件 */
    dlg: {
      show: false,
      type: '',
      title: '',
      content: '',
      editable: false,
      placeholder: '',
      maxLength: 140,
      confirmText: '确定',
      danger: false,
    },
    /** 弹框当前操作的目标选项 id(renameItem/removeItem 用) */
    editingItemId: '',
  },

  // 职责:每次进入/返回本页时刷新数据(管理操作都可能改变存储)
  onShow() {
    this.refresh();
  },

  // 职责:打开通用弹框;每次从干净的默认模板开始合并 patch,
  // 避免上一次弹框的 content/danger 等字段残留到下一次(如删除确认后紧跟重命名)
  openDlg(patch) {
    const base = {
      show: false,
      type: '',
      title: '',
      content: '',
      editable: false,
      placeholder: '',
      maxLength: 140,
      confirmText: '确定',
      danger: false,
    };
    this.setData({ dlg: Object.assign(base, patch, { show: true }) });
  },

  // 职责:关闭通用弹框
  closeDlg() {
    this.setData({ 'dlg.show': false });
  },

  // 职责:弹框取消,直接关闭
  onDlgCancel() {
    this.closeDlg();
  },

  // 职责:弹框确认,按 dlg.type 分发业务;输入类校验失败时不关闭弹框,便于就地修改
  // @param {{detail: {content: string}}} e 组件 confirm 事件,content 为输入框内容(非输入弹框为空串)
  onDlgConfirm(e) {
    const content = e.detail.content;
    const type = this.data.dlg.type;
    if (type === 'addList') {
      const result = store.addList(content);
      if (!result.ok) {
        wx.showToast({ title: this.errorMsg(result.reason, 'list'), icon: 'none' });
        return;
      }
    } else if (type === 'renameList') {
      const result = store.renameList(store.getList().id, content);
      if (!result.ok) {
        wx.showToast({ title: this.errorMsg(result.reason, 'list'), icon: 'none' });
        return;
      }
    } else if (type === 'renameItem') {
      const result = store.renameItem(this.data.editingItemId, content);
      if (!result.ok) {
        wx.showToast({ title: this.errorMsg(result.reason, 'item'), icon: 'none' });
        return;
      }
    } else if (type === 'removeList') {
      store.removeList(store.getList().id);
    } else if (type === 'removeItem') {
      store.removeItem(this.data.editingItemId);
    } else if (type === 'resetAll') {
      store.resetAllWeights();
    } else if (type === 'clearLog') {
      store.clearConfirmLog();
    }
    this.closeDlg();
    this.refresh();
  },

  /**
   * 把 store 的失败原因转成用户提示
   * @param {string} reason 失败原因:'dup'|'full'|'tooLong'|'empty'|'missing'
   * @param {string} scope 主语范围:'list' 分组 / 'item' 选项
   * @returns {string} toast 文案
   */
  errorMsg(reason, scope) {
    const isList = scope === 'list';
    const noun = isList ? '分组名' : '名称';
    if (reason === 'dup') return isList ? '已有同名分组' : '这个名称已存在';
    if (reason === 'full') return `最多建 ${store.MAX_LISTS} 个分组`;
    if (reason === 'tooLong') return `${noun}最多 ${isList ? store.MAX_LIST_NAME_LEN : store.MAX_ITEM_NAME_LEN} 个字`;
    if (reason === 'empty') return `先输入${noun}`;
    if (reason === 'missing') return isList ? '分组不存在' : '选项不存在';
    return '操作失败';
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
      // 满权重显示 "1.0" 而非 "1";0.75/0.5/0.25 等档位均为精确小数,直接字符串化
      weightText: it.weight === store.WEIGHT_INIT ? '1.0' : String(it.weight),
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

  // 职责:弹「新建分组」输入弹框;校验与创建在 onDlgConfirm 的 addList 分支完成
  onAddList() {
    this.openDlg({
      type: 'addList',
      title: '新建分组',
      editable: true,
      placeholder: '分组名 10 字以内，如：吃什么',
      maxLength: store.MAX_LIST_NAME_LEN,
      confirmText: '创建',
    });
  },

  // 职责:弹「重命名分组」输入弹框,占位提示当前分组名
  onRenameList() {
    const list = store.getList();
    this.openDlg({
      type: 'renameList',
      title: '重命名分组',
      editable: true,
      placeholder: list.name,
      maxLength: store.MAX_LIST_NAME_LEN,
      confirmText: '保存',
    });
  },

  // 职责:弹「删除分组」确认弹框(危险操作);至少保留一个分组的前置检查
  onRemoveList() {
    const data = store.read();
    const list = store.getList(data);
    if (data.lists.length <= 1) {
      wx.showToast({ title: '至少保留一个分组', icon: 'none' });
      return;
    }
    this.openDlg({
      type: 'removeList',
      title: `删除分组「${list.name}」`,
      content: `分组内 ${list.items.length} 个选项将一并删除，确定删除？`,
      confirmText: '删除',
      danger: true,
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
    this.setData({ editingItemId: id });
    this.openDlg({
      type: 'renameItem',
      title: '修改选项名',
      editable: true,
      placeholder: item.name,
      maxLength: store.MAX_ITEM_NAME_LEN,
      confirmText: '保存',
    });
  },

  // 职责:同步单个添加输入框到 data
  onInputName(e) {
    this.setData({ inputName: e.detail.value });
  },

  // 职责:添加单个选项名称;超限时按钮已置灰,此处兜底拦截;空值/重名时 toast 提示,成功后清空输入框
  onAdd() {
    const name = this.data.inputName;
    if (name.length > store.MAX_ITEM_NAME_LEN) return;
    const result = store.addItem(name);
    if (!result.ok) {
      const msg = result.reason === 'dup' ? '这个已经在名单里啦'
        : result.reason === 'full' ? `每组最多 ${store.MAX_ITEMS_PER_LIST} 个`
        : result.reason === 'tooLong' ? `名称最多 ${store.MAX_ITEM_NAME_LEN} 个字`
        : '先输入名称';
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
    this.setData({ editingItemId: id });
    this.openDlg({
      type: 'removeItem',
      title: '删除候选',
      content: `确定删除「${item ? item.name : ''}」？`,
      confirmText: '删除',
      danger: true,
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

  // 职责:执行批量导入——按行拆分、去空白、重名跳过、超长截断,导入后 toast 汇总
  doImport() {
    const names = this.data.importText.split(/\n/);
    if (names.map((n) => n.trim()).filter(Boolean).length === 0) {
      wx.showToast({ title: '先粘贴几行内容', icon: 'none' });
      return;
    }
    const { added, skipped, full, truncated } = store.batchAdd(names);
    this.closeImport();
    this.refresh();
    let msg = full ? `每组上限 ${store.MAX_ITEMS_PER_LIST} 个，已新增 ${added} 个` : `新增 ${added} 个，跳过重复 ${skipped} 个`;
    if (truncated > 0) {
      msg += `，${truncated} 个超长名截为 ${store.MAX_ITEM_NAME_LEN} 字`;
    }
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

  // 职责:弹「恢复全部权重」确认弹框
  onResetAll() {
    this.openDlg({
      type: 'resetAll',
      title: '恢复全部权重',
      content: '所有被「减少推荐」的选项都将恢复为 1.0',
      confirmText: '恢复',
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

  // 职责:弹「清空冷却记录」确认弹框(危险操作)
  onClearLog() {
    this.openDlg({
      type: 'clearLog',
      title: '清空冷却记录',
      content: '清空后，所有冷却中的选项都会立即恢复可摇。',
      confirmText: '清空',
      danger: true,
    });
  },

  // 职责:空实现,用于 catchtouchmove 阻止导入弹层下的页面滚动穿透
  noop() {},
});
