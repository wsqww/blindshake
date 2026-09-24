// app.js — 小程序入口,负责启动时初始化本地存储
const store = require('./utils/store');

App({
  // 职责:小程序启动时确保存储中存在结构完整的数据;无副作用之外的行为
  onLaunch() {
    store.init();
  },
});
