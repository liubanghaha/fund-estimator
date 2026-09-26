const cloud = require("wx-server-sdk");
const fd = require("./_shared/fund-data");
const td = require("./_shared/trading-day");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 轻量轮询接口：仅返回盘中收益率快照，用于高频轮询
// 替代原先每 15 秒调一次重型的 getPortfolio
exports.main = async (event) => {
  const srcSelf = (event && event.src) === "self";
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };

  try {
    const now = new Date();
    const bjDay = (now.getUTCDay() + (now.getUTCHours() + 8 >= 24 ? 1 : 0)) % 7;
    const bjHours = (now.getUTCHours() + 8) % 24;
    const totalMin = bjHours * 60 + now.getUTCMinutes();
    const today = fd.formatBJDate();   // 北京日期（原来按 UTC 取，非交易时段会差一天）
    const time = `${String(bjHours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

    // 非交易时段/非交易日返回空快照。todayProfitRate 必须为 null（而非占位 0）：
    // 0 是"确认为零收益"的真值语义，占位 0 曾把客户端冻结期缓存里的正确收益洗成 0
    // 时段边界（含 9:25 集合竞价段）与 getPortfolio 的"今天"起点一致，见 fd.OPEN_MIN；
    // 节假日也要挡（cron/前端只判"周内"）：休市日库里只有 snapshotProfit 写的历史假点，
    // 当今日返回会让走势页出现"股市没开却有今日曲线"
    const inTrading = bjDay >= 1 && bjDay <= 5 && fd.inTradingWindow(totalMin) && td.isTradingDay(today);
    if (!inTrading) {
      // 非交易时段回退"最近一个交易日的分钟点"（snapDate 标注所属日）：收益页缓存新鲜路径
      // 不跑全量 getPortfolio，此前这里回空占位导致周末/节假日打开时当天曲线整段空白。
      // 数值字段（todayProfitRate/todayProfit）仍为 null —— 沿用"非交易时段不动数值"的守卫，
      // 防止把缓存里正确的收益洗成 0（profit-chart-card-mismatch 的教训），客户端只读画曲线
      try {
        const start = fd.formatBJDate(new Date(Date.now() - 30 * 86400000));
        const fb = await db.collection("profit_snapshots")
          .where({ _openid: OPENID, date: _.gte(start) })
          .field({ date: true, points: true })
          .limit(60).get();
        const rows = (fb.data || []).sort((a, b) => b.date.localeCompare(a.date));
        // ≤today 且是交易日：交易日盘后取当天自己的点，周末/节假日回退最近交易日
        //（假日假点已删 + 写入侧有守卫，这里再用 isTradingDay 兜一层）
        const lastRow = rows.find((r) => r.date <= today && td.isTradingDay(r.date));
        if (lastRow && lastRow.points && lastRow.points.length > 0) {
          return { code: 0, data: { intradaySnapshots: lastRow.points, snapDate: lastRow.date, todayProfitRate: null, updateTime: "", inTrading: false } };
        }
      } catch (e) {
        console.warn("[portfolioLight] 非交易时段回退读取失败:", e.message);
      }
      return { code: 0, data: { intradaySnapshots: [], todayProfitRate: null, updateTime: "", inTrading: false } };
    }

    // 读取当日快照
    const snapRes = await db.collection("profit_snapshots")
      .where({ _openid: OPENID, date: today }).get();

    let intradaySnapshots = [];
    // 无点时保持 null：0 是"确认为零收益"的真值语义（见下），盘内 9:25-9:30 首个快照点落库前
    // 返回 0 会把收益页已渲染的收益洗成 0.00（客户端只挡 null）
    let todayProfitRate = null;
    let todayProfit = null;      // 今日收益金额（元）数据源一口径
    let todayProfitSelf = null;  // 今日收益金额 自算口径
    let updateTime = "";

    if (snapRes.data && snapRes.data.length > 0) {
      intradaySnapshots = snapRes.data[0].points || [];
      if (intradaySnapshots.length > 0) {
        // 取 time 最大的一点：两个写入方（分钟定时器 / 首页兜底）可能乱序 append，末元素未必最新
        let last = intradaySnapshots[0];
        for (const p of intradaySnapshots) {
          if (p && p.time && (!last || !last.time || p.time >= last.time)) last = p;
        }
        todayProfitRate = srcSelf ? (last.rateSelf != null ? last.rateSelf : (last.rate || 0)) : (last.rate || 0);
        // 金额取点里存好的（快照写入时用未舍入收益率算）；旧点无此字段则留 null，
        // 客户端退回「基准市值 × 2 位收益率」
        if (last.tp != null) todayProfit = last.tp;
        if (last.tpSelf != null) todayProfitSelf = last.tpSelf;
        updateTime = last.time || "";
      }
    }

    // 金额与收益率同源同口径：选中的口径缺金额时退回另一口径（与 rateSelf 的回退一致）
    const amountOut = srcSelf ? (todayProfitSelf != null ? todayProfitSelf : todayProfit) : todayProfit;

    return {
      code: 0,
      data: { intradaySnapshots, todayProfitRate, todayProfit: amountOut, updateTime, inTrading: true },
    };
  } catch (e) {
    console.error("portfolioLight 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};
