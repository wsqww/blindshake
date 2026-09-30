// dialog.js — 通用确认/输入弹框组件:统一替代原生 wx.showModal,视觉与项目弹窗一致
Component({
  options: {
    // 样式自足:遮罩/卡片/按钮全部在组件 wxss 定义,不依赖页面样式,两处引入表现一致
    styleIsolation: 'isolated',
  },
  properties: {
    /** 是否显示弹框 */
    show: { type: Boolean, value: false },
    /** 标题 */
    title: { type: String, value: '' },
    /** 说明文字(确认类弹框使用,可空) */
    content: { type: String, value: '' },
    /** 是否为输入弹框(新建/重命名场景) */
    editable: { type: Boolean, value: false },
    /** 输入框占位提示 */
    placeholder: { type: String, value: '' },
    /** 输入框最大长度(字符),透传原生 input 的 maxlength */
    maxLength: { type: Number, value: 140 },
    /** 输入框初始值(一般留空,用 placeholder 提示原名) */
    value: { type: String, value: '' },
    /** 确认按钮文字 */
    confirmText: { type: String, value: '确定' },
    /** 取消按钮文字 */
    cancelText: { type: String, value: '取消' },
    /** 危险操作:确认按钮显示为红色 */
    danger: { type: Boolean, value: false },
  },
  data: {
    /** 输入框当前内容,确认时随事件抛出 */
    inputValue: '',
    /** 确认按钮是否禁用:输入弹框中内容超过上限时置灰 */
    confirmDisabled: false,
  },
  observers: {
    // 每次打开时用外部 value 重置输入,避免残留上一次的输入内容
    show(visible) {
      if (visible) {
        this.setData({ inputValue: this.data.value });
      }
    },
    // 输入弹框中内容超过长度上限时禁用确认按钮(非输入弹框 editable=false 恒不禁用)
    'inputValue, maxLength, editable'(value, maxLength, editable) {
      this.setData({ confirmDisabled: editable && value.length > maxLength });
    },
  },
  methods: {
    // 职责:空实现,catchtouchmove 阻止弹框下页面滚动穿透
    noop() {},
    // 职责:同步输入框内容到 data
    onInput(e) {
      this.setData({ inputValue: e.detail.value });
    },
    // 职责:点确认按钮或键盘「完成」;超限禁用态与页面校验失败均可不关闭
    onConfirm() {
      if (this.data.confirmDisabled) return;
      this.triggerEvent('confirm', { content: this.data.inputValue });
    },
    // 职责:点取消按钮,通知页面关闭
    onCancel() {
      this.triggerEvent('cancel');
    },
  },
});
