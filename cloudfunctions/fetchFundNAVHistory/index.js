const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const fd = require("./_shared/fund-data");

exports.main = async (event) => {
  const { fundCode, days = 80 } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const list = await fd.fetchNAVHistory(fundCode, days);
    return { code: 0, msg: "success", data: list };
  } catch (e) {
    console.error("获取历史净值失败:", e.message || e);
    return { code: 500, msg: "获取历史净值失败" };
  }
};
