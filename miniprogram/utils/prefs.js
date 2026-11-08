"use strict";
/**
 * 本地偏好统一读取（2026-11-08 审查收敛：amountVisible 5 份拷贝/theme 默认值漂移消除）。
 * 写入口唯一：首页（amountVisible/theme 的开关都在首页设置），其他页面只读。
 */
function isAmountVisible() {
  const v = wx.getStorageSync("amountVisible");
  return v === "" ? true : !!v;
}

function getTheme() {
  return wx.getStorageSync("theme") || "red";
}

module.exports = { isAmountVisible, getTheme };
