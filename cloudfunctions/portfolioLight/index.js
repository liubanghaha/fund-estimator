const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 轻量轮询接口：仅返回盘中收益率快照，用于高频轮询
// 替代原先每 15 秒调一次重型的 getPortfolio
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };

  try {
    const now = new Date();
    const bjDay = (now.getUTCDay() + (now.getUTCHours() + 8 >= 24 ? 1 : 0)) % 7;
    const bjHours = (now.getUTCHours() + 8) % 24;
    const totalMin = bjHours * 60 + now.getUTCMinutes();
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const time = `${String(bjHours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

    // 非交易时段返回空快照
    const inTrading = bjDay >= 1 && bjDay <= 5 && ((totalMin >= 570 && totalMin < 690) || (totalMin >= 780 && totalMin <= 900));
    if (!inTrading) {
      return { code: 0, data: { intradaySnapshots: [], todayProfitRate: 0, updateTime: "", inTrading: false } };
    }

    // 读取当日快照
    const snapRes = await db.collection("profit_snapshots")
      .where({ _openid: OPENID, date: today }).get();

    let intradaySnapshots = [];
    let todayProfitRate = 0;
    let updateTime = "";

    if (snapRes.data && snapRes.data.length > 0) {
      intradaySnapshots = snapRes.data[0].points || [];
      if (intradaySnapshots.length > 0) {
        const last = intradaySnapshots[intradaySnapshots.length - 1];
        todayProfitRate = last.rate || 0;
        updateTime = last.time || "";
      }
    }

    return {
      code: 0,
      data: { intradaySnapshots, todayProfitRate, updateTime, inTrading: true },
    };
  } catch (e) {
    console.error("portfolioLight 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};
