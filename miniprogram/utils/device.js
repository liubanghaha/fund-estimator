/**
 * 设备/平台判断（与「账户平台 platform」无关，别混）。
 *
 * 添加到桌面：安卓微信右上角胶囊菜单里有「添加到桌面」，加了之后桌面图标点开直达小程序；
 * iOS 系统不提供桌面快捷方式（微信侧限制），菜单里没有这一项，只能引导「添加到我的小程序」
 * （之后在微信首页下拉直达）。小程序侧也没有 API 能调用它、或检测用户是否已添加，只能引导。
 */
function isIOS() {
  try {
    return /ios/i.test(wx.getSystemInfoSync().platform || "");
  } catch (e) {
    return false;
  }
}

// 引导文案：首页气泡与「我的」页入口共用一套，避免两处说法分叉
function addShortcutGuide() {
  if (isIOS()) {
    return {
      kind: "myminiprogram",
      label: "添加到我的小程序",
      title: "添加到我的小程序",
      steps: [
        "点右上角「···」打开菜单",
        "选择「添加到我的小程序」",
        "之后在微信首页下拉，即可直达小程序",
      ],
      tip: "iOS 系统不提供桌面快捷方式，微信里最接近的用法是「添加到我的小程序」",
    };
  }
  return {
    kind: "desktop",
    label: "添加到桌面",
    title: "添加到桌面",
    steps: [
      "点右上角「···」打开菜单",
      "选择「添加到桌面」",
      "手机桌面出现图标，点开直达小程序",
    ],
    tip: "菜单里若没有这一项，请在手机设置中允许微信「创建桌面快捷方式」",
  };
}

module.exports = { isIOS, addShortcutGuide };
