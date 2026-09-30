// shake.js — 首页:摇一摇随机决策
// 流程:加速计检测摇动(阈值 + 1.5s 冷却)→ 老虎机滚动选项名 → 粒子定格 → 结果弹窗三按钮。
// 「确定才占用」:只有「确定选择」写入 confirmLog;弹窗打开期间不响应摇动,防止误触跳过。
const store = require('../../utils/store');
const { getAvailableItems, weightedPick } = require('../../utils/random');

/** 触发摇一摇的合加速度阈值(单位 g,静止时约 1,剧烈摇晃通常 > 2) */
const SHAKE_THRESHOLD = 1.8;
/** 两次触发之间的冷却毫秒数(防抖) */
const SHAKE_COOLDOWN_MS = 1500;
/** 老虎机滚动各步时长(ms):由快到慢,总时长 1.5s */
const ROLL_STEPS = [70, 70, 80, 90, 110, 130, 160, 200, 260, 330];
/** 连摇多少次未确定后,弹窗底部出现柔性提示 */
const STREAK_HINT_AT = 3;
/** 拉杆下拉触发所需的最小纵向位移(px) */
const LEVER_PULL_THRESHOLD = 20;
/** 定格到弹出结果弹窗之间的停顿(ms),让玩家先看清定格结果 */
const RESULT_PAUSE_MS = 700;
/** 放射纹背景画布尺寸(原图 px;画布以射线圆心为中心,条纹向四外延拓) */
const RAYS_W = 1400;
const RAYS_H = 5000;
/** 射线圆心在原图中的坐标(径向一致性搜索测得) */
const RAY_CX = 1030;
const RAY_CY = 435;
/** 机器盒对应的原图裁剪框(左上角 CROP_X/CROP_Y,宽 CROP_W) */
const CROP_X = 420;
const CROP_Y = 108;
const CROP_W = 1128;

Page({
  data: {
    /** 展示卡上正在滚动/定格显示的文案 */
    displayText: '?',
    /** 当前选中分组名,顶栏展示,摇一摇即从该分组随机 */
    activeListName: '',
    /** 当前选中分组 id,弹层高亮用 */
    activeListId: '',
    /** 分组切换弹层开关(打开期间不响应摇动) */
    listPickerOpen: false,
    /** 候选为空的引导弹框开关 */
    emptyDlg: false,
    /** 弹层渲染的全部分组(含选项数) */
    lists: [],
    /** 是否处于老虎机滚动中(滚动期间忽略再次触发) */
    rolling: false,
    /** 结果弹窗开关 */
    showResult: false,
    /** 弹窗模式:normal 出结果 / exhausted 候选被防重复耗尽 */
    resultMode: 'normal',
    /** 当前弹出的结果候选 {id, name, weight} */
    result: null,
    /** 连续摇出且未「确定」的次数,用于柔性提示 */
    streak: 0,
    /** 连摇提示是否可见 */
    hintVisible: false,
    /** 庆祝粒子是否播放(wx:if 重建节点以触发动画) */
    particlesOn: false,
    /** 滚筒当前一格的滚动时长(ms),随减速步进变长;定格弹跳时复用为弹跳时长 */
    reelDuration: 120,
    /** 定格弹跳动画开关(仅出结果瞬间播放一次) */
    settling: false,
    /** 结果已定格但弹窗尚未弹出(停顿期间不响应摇动) */
    resultPending: false,
    /** 粒子节点索引数组,供 wx:for 渲染 12 个粒子 */
    particleIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    /** 六滚筒窗的定格符号:★/?/7 交替呼应头像卷轴窗(仅装饰,滚动时闪烁) */
    reelSymbols: [
      { ch: '★', cls: 'sy-star' },
      { ch: '?', cls: 'sy-q' },
      { ch: '7', cls: 'sy-7' },
      { ch: '7', cls: 'sy-7' },
      { ch: '?', cls: 'sy-q' },
      { ch: '★', cls: 'sy-star' },
    ],
    /** 放射纹背景的定位样式(alignRays 实测后写入) */
    raysStyle: '',
    /** 背景是否已完成对位(完成前隐藏,避免闪现错位背景) */
    raysReady: false,
    /** 自定义导航(px):标题框直接取胶囊实测矩形,navBottom 为胶囊底缘(下方内容从此起排) */
    menuTop: 0,
    menuHeight: 32,
    navBottom: 76,
  },

  /** 上次摇动触发时间戳,用于冷却判断 */
  lastShakeAt: 0,
  /** 老虎机滚动定时器句柄,页面卸载时清理 */
  rollTimer: null,
  /** 定格弹跳动画复位定时器句柄 */
  settleTimer: null,
  /** 结果弹窗延迟弹出定时器句柄 */
  resultTimer: null,
  /** 加速计监听是否已开启(onShow/onHide 反复进出时防重复注册) */
  motionActive: false,

  // 职责:页面加载时创建绑定 this 的加速计回调(wx 全局回调不保证 this 指向页面实例),并测量自定义导航占位
  onLoad() {
    this.motionHandler = (res) => this.handleMotion(res);
    this.loadBarMetrics();
  },

  // 职责:实测微信胶囊矩形,标题框与其完全重合保证垂直同轴;navBottom 供下方内容起排;异常时按状态栏兜底
  loadBarMetrics() {
    const info = wx.getWindowInfo();
    const menu = wx.getMenuButtonBoundingClientRect();
    if (!menu || !menu.height || !menu.top) {
      const top = info.statusBarHeight + 4;
      this.setData({ menuTop: top, menuHeight: 32, navBottom: top + 32 + 4 });
      return;
    }
    this.setData({ menuTop: menu.top, menuHeight: menu.height, navBottom: menu.top + menu.height });
  },

  // 职责:首次布局完成后对位整页放射纹背景
  onReady() {
    this.alignRays();
  },

  // 职责:窗口尺寸变化(iPad 分屏/旋转,需 app.json resizable)时重测导航占位并重新对位放射纹背景
  onResize() {
    this.loadBarMetrics();
    this.alignRays();
  },

  // 职责:进入页面时刷新当前分组名与 id(可能刚在管理页增删/切换过分组),并开启摇一摇监听
  onShow() {
    this.refreshListMeta();
    this.startMotion();
  },

  // 职责:实测机器盒的页面位置,把整页放射纹背景的射线圆心对齐到机器原画对应点(背景图本身包含机器本体,对齐即无缝)
  alignRays() {
    wx.createSelectorQuery().in(this)
      .select('.machine')
      .boundingClientRect((rect) => {
        if (!rect) return;
        // 显示比例 = 机器盒实际宽 / 原图裁剪框宽;射线圆心换算到页面坐标后,反推背景图左上角
        const scale = rect.width / CROP_W;
        const cx = rect.left + (RAY_CX - CROP_X) * scale;
        const cy = rect.top + (RAY_CY - CROP_Y) * scale;
        this.setData({
          raysStyle: `left:${cx - (RAYS_W / 2) * scale}px;top:${cy - (RAYS_H / 2) * scale}px;width:${RAYS_W * scale}px;height:${RAYS_H * scale}px;`,
          raysReady: true,
        });
      })
      .exec();
  },

  // 职责:从存储读取当前分组名与 id 并更新展示;副作用:setData 两个字段
  refreshListMeta() {
    const data = store.read();
    this.setData({
      activeListName: store.getList(data).name,
      activeListId: data.activeListId,
    });
  },

  // 职责:打开分组切换弹层;副作用:读取全部分组并 setData
  onOpenListPicker() {
    const data = store.read();
    this.setData({
      listPickerOpen: true,
      lists: data.lists.map((l) => ({ id: l.id, name: l.name, count: l.items.length })),
      activeListId: data.activeListId,
    });
  },

  // 职责:关闭分组切换弹层
  onCloseListPicker() {
    this.setData({ listPickerOpen: false });
  },

  /**
   * 弹层内选择分组:切换后旧结果作废、连摇计数清零
   * @param {{currentTarget: {dataset: {id: string}}}} e 分组选项点击事件
   */
  onSelectGroup(e) {
    const id = e.currentTarget.dataset.id;
    store.setActiveList(id);
    wx.vibrateShort({ type: 'light' });
    this.setData({
      listPickerOpen: false,
      activeListName: store.getList().name,
      activeListId: id,
      displayText: '?',
      streak: 0,
      hintVisible: false,
    });
  },

  // 职责:弹层内「添加分组」——关闭弹层并跳转管理页
  onAddGroupFromPicker() {
    this.setData({ listPickerOpen: false });
    wx.navigateTo({ url: '/pages/manage/manage' });
  },

  // 职责:离开页面(前后台切换/跳转管理页)停止监听,避免后台持续触发与耗电
  onHide() {
    this.stopMotion();
  },

  // 职责:页面卸载时停止监听并清理滚动/弹跳定时器
  onUnload() {
    this.stopMotion();
    if (this.rollTimer) {
      clearTimeout(this.rollTimer);
      this.rollTimer = null;
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.resultTimer) {
      clearTimeout(this.resultTimer);
      this.resultTimer = null;
    }
  },

  // 职责:开启加速计并注册回调;副作用:this.motionActive 置位、注册全局监听
  startMotion() {
    if (this.motionActive) return;
    this.motionActive = true;
    wx.startAccelerometer({ interval: 'game' });
    wx.onAccelerometerChange(this.motionHandler);
  },

  // 职责:停止加速计并注销回调;副作用:this.motionActive 复位、注销全局监听
  stopMotion() {
    if (!this.motionActive) return;
    this.motionActive = false;
    wx.offAccelerometerChange(this.motionHandler);
    wx.stopAccelerometer();
  },

  /**
   * 加速计回调:合加速度超阈值且不在冷却/滚动/弹窗状态时触发一次随机
   * @param {{x: number, y: number, z: number}} res 三轴加速度,单位 g
   */
  handleMotion(res) {
    const force = Math.sqrt(res.x * res.x + res.y * res.y + res.z * res.z);
    if (force < SHAKE_THRESHOLD) return;
    const now = Date.now();
    if (now - this.lastShakeAt < SHAKE_COOLDOWN_MS) return;
    // 弹窗/弹层/停顿期间必须点按钮,不响应摇动(防误触跳过结果)
    if (this.data.rolling || this.data.showResult || this.data.listPickerOpen || this.data.resultPending) return;
    this.lastShakeAt = now;
    this.spin();
  },

  /**
   * 执行一次随机:按数据状态分流到空池引导 / 耗尽弹窗 / 单家直出 / 老虎机滚动
   * 副作用:可能 setData 多个状态字段、写定时器、弹出 modal
   */
  spin() {
    // 弹窗打开时按钮路径会先关闭弹窗再进入,此处兜底拦截滚动中的重复触发
    if (this.data.rolling) return;
    const data = store.read();
    const list = store.getList(data);
    const items = list.items;
    const now = Date.now();
    const available = getAvailableItems(items, data.confirmLog, data.settings, now);

    if (items.length === 0) {
      // 弹「还没有候选」通用弹框,确认后由 wxml 的 bindconfirm 跳转管理页
      this.setData({ emptyDlg: true });
      return;
    }
    if (available.length === 0) {
      // 冷却把候选占满:也推进一次冷却(避免小池子死锁)并提供解锁入口
      store.tickCooldowns();
      this.setData({ showResult: true, resultMode: 'exhausted', result: null, particlesOn: false });
      return;
    }
    if (available.length === 1) {
      // 只剩一个选项,直接出结果,不做假随机
      this.presentResult(available[0], false);
      return;
    }

    // 先按加权随机定好赢家,滚动内容只是展示(保证概率语义正确)
    const winner = weightedPick(available);
    this.setData({ rolling: true, showResult: false, particlesOn: false, reelDuration: ROLL_STEPS[0] });
    let step = 0;
    const tick = () => {
      if (step >= ROLL_STEPS.length) {
        this.presentResult(winner, true);
        return;
      }
      const flash = available[Math.floor(Math.random() * available.length)];
      const delay = ROLL_STEPS[step];
      // 滚筒每格的动画时长与步进同步:越往后越慢,呈现减速定格
      this.setData({ displayText: flash.name, reelDuration: delay });
      step += 1;
      this.rollTimer = setTimeout(tick, delay);
    };
    tick();
  },

  /**
   * 定格展示结果并弹出弹窗
   * @param {{id: string, name: string, weight: number}} item 摇中的候选
   * @param {boolean} withFx 是否播放老虎机定格效果(粒子 + 震动);单家直出时不播
   */
  presentResult(item, withFx) {
    const streak = this.data.streak + 1;
    this.setData({
      displayText: item.name,
      rolling: false,
      settling: withFx,
      reelDuration: 450,
      result: item,
      resultMode: 'normal',
      resultPending: true,
      showResult: false,
      streak,
      hintVisible: streak >= STREAK_HINT_AT,
      particlesOn: withFx,
    });
    if (withFx) {
      wx.vibrateShort({ type: 'medium' });
      // 弹跳动画播放一次后复位,避免后续渲染重复触发
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.setData({ settling: false });
      }, 500);
    }
    // 定格先停留片刻让玩家看清结果,再弹出操作弹窗
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      this.resultTimer = null;
      this.setData({ showResult: true, resultPending: false });
    }, RESULT_PAUSE_MS);
    // 每摇出一次结果,次数模式下冷却中的选项剩余摇数 -1
    store.tickCooldowns();
  },

  // 职责:取消尚未弹出的结果弹窗(跳转管理页等场景下避免返回后突然弹出)
  clearPendingResult() {
    if (this.resultTimer) {
      clearTimeout(this.resultTimer);
      this.resultTimer = null;
    }
    if (this.data.resultPending) {
      this.setData({ resultPending: false });
    }
  },

  // 职责:关闭结果弹窗;副作用:showResult/particlesOn 复位,streak 保留(未确定不清零)
  closeResult() {
    this.setData({ showResult: false, result: null, particlesOn: false, hintVisible: false });
  },

  // 职责:「确定选择」——写入确定记录、清零连摇、关闭弹窗
  onConfirm() {
    const result = this.data.result;
    if (!result) return;
    const ok = store.confirmItem(result.id);
    if (!ok) {
      // 摇出后进管理页删除了该选项再回来点确定的极端场景
      wx.showToast({ title: '该选项已被删除', icon: 'none' });
    }
    this.setData({ streak: 0, hintVisible: false });
    this.closeResult();
  },

  // 职责:「重新随机」——立刻再摇一次
  onReroll() {
    this.setData({ showResult: false, particlesOn: false });
    this.spin();
  },

  // 职责:「减少推荐」——当前结果权重降 25%(最低 0.25)后再摇一次;被删选项时仅提示
  onReduceAndReroll() {
    const result = this.data.result;
    if (!result) return;
    const weight = store.reduceWeight(result.id);
    if (weight === null) {
      wx.showToast({ title: '该选项已被删除', icon: 'none' });
      this.closeResult();
      return;
    }
    this.setData({ showResult: false, particlesOn: false });
    this.spin();
  },

  // 职责:「解锁全部」——清空防重复记录后立即再摇
  onUnlock() {
    store.clearConfirmLog();
    this.setData({ showResult: false, particlesOn: false });
    this.spin();
  },

  // 职责:关闭「还没有候选」引导弹框(弹框取消按钮)
  onCloseEmptyDlg() {
    this.setData({ emptyDlg: false });
  },

  // 职责:跳转管理页;取消未弹出结果与滚动链并复位动效状态,避免返回后弹窗凭空出现
  goManage() {
    this.clearPendingResult();
    if (this.rollTimer) {
      clearTimeout(this.rollTimer);
      this.rollTimer = null;
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.setData({ showResult: false, rolling: false, settling: false, particlesOn: false, listPickerOpen: false, emptyDlg: false });
    wx.navigateTo({ url: '/pages/manage/manage' });
  },

  // 职责:点按拉杆触发——与摇动同路径
  onTapShake() {
    if (this.data.rolling || this.data.showResult || this.data.listPickerOpen || this.data.resultPending) return;
    this.spin();
  },

  /**
   * 拉杆触摸开始:记录起始纵坐标,复位本次手势的下拉触发标记
   * @param {{touches: Array<{clientY: number}>}} e 触摸事件
   */
  onLeverTouchStart(e) {
    const t = e.touches && e.touches[0];
    this.leverStartY = t ? t.clientY : null;
    this.leverPullFired = false;
  },

  /**
   * 拉杆触摸移动:向下滑动超过阈值即触发一次摇一摇(每次手势只触发一次,点按仍走 bindtap)
   * @param {{touches: Array<{clientY: number}>}} e 触摸事件
   */
  onLeverTouchMove(e) {
    if (this.leverPullFired || this.leverStartY == null) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (t.clientY - this.leverStartY >= LEVER_PULL_THRESHOLD) {
      this.leverPullFired = true;
      this.onTapShake();
    }
  },

  // 职责:拉杆触摸结束,复位手势状态
  onLeverTouchEnd() {
    this.leverStartY = null;
    this.leverPullFired = false;
  },

  // 职责:空实现,用于 catchtouchmove 阻止弹窗遮罩下的页面滚动穿透
  noop() {},
});
