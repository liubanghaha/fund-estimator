const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 运营增长 — 运营工具
 *
 *  action:
 *    checkAdmin      校验当前用户是否管理员
 *    registerAdmin   首次调用自动登记为管理员（首个打开运营助手页的微信即管理员）
 *    addAdmin        管理员添加其他管理员
 *    briefing        生成今日基金温度简报（低估/合理/高估分布 + 代表基金 + 可复制文案）
 *    listChannels    渠道列表（含各渠道访问数）
 *    addChannel      新建推广渠道
 *    removeChannel   删除推广渠道
 *    createCode      生成渠道小程序码（wxacode.getUnlimited → 云存储 → fileID）
 */

function bjDate() {
  const d = new Date(Date.now() + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function randChannelId() {
  return "c" + Math.random().toString(36).slice(2, 8);
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (e) { /* 已存在 */ }
}

async function isAdmin(openid) {
  if (!openid) return false;
  await ensureCollection("ops_admins");
  const res = await db.collection("ops_admins").where({ openid }).count();
  return res.total > 0;
}

// 分页读取集合（上限保护，避免超大集合拖垮函数）
async function readAll(collection, cap = 5000) {
  const PAGE = 100;
  const out = [];
  let skip = 0;
  while (skip < cap) {
    const res = await db.collection(collection).skip(skip).limit(PAGE).get();
    out.push(...(res.data || []));
    if ((res.data || []).length < PAGE) break;
    skip += PAGE;
  }
  return out.slice(0, cap);
}

// 按 date 字段分页读取（简报分布统计用）
async function readAllByDate(collection, date, cap = 2000) {
  const PAGE = 100;
  const out = [];
  let skip = 0;
  while (skip < cap) {
    const res = await db.collection(collection).where({ date }).skip(skip).limit(PAGE).get();
    out.push(...(res.data || []));
    if ((res.data || []).length < PAGE) break;
    skip += PAGE;
  }
  return out.slice(0, cap);
}

exports.main = async (event) => {
  const { action } = event || {};
  const { OPENID } = cloud.getWXContext();

  try {
    // ===== 管理员校验 =====
    if (action === "checkAdmin") {
      return { code: 0, data: { isAdmin: await isAdmin(OPENID) } };
    }

    if (action === "registerAdmin") {
      if (!OPENID) return { code: 0, data: { isAdmin: false } };
      await ensureCollection("ops_admins");
      const total = await db.collection("ops_admins").count();
      if (total.total === 0) {
        await db.collection("ops_admins").add({ data: { openid: OPENID, createTime: new Date() } });
        return { code: 0, data: { isAdmin: true, registered: true } };
      }
      return { code: 0, data: { isAdmin: await isAdmin(OPENID), registered: false } };
    }

    if (action === "addAdmin") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const { openid } = event;
      if (!openid || typeof openid !== "string") return { code: 400, msg: "缺少 openid" };
      await ensureCollection("ops_admins");
      const exist = await db.collection("ops_admins").where({ openid }).count();
      if (exist.total === 0) {
        await db.collection("ops_admins").add({ data: { openid, createTime: new Date() } });
      }
      return { code: 0 };
    }

    // ===== 埋点周报（P0-0 验证门禁：事件入库可查，先出 app_launch 时段占比）=====
    if (action === "trackReport") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const days = Math.min(Math.max(parseInt(event.days) || 7, 1), 90);
      const since = Date.now() - days * 86400000;
      const _ = db.command;

      // 启动时段占比（analytics_launches 存量直连，phase 三态口径同 _trackLaunch）
      const [phTrading, phAfter, phClosed] = await Promise.all([
        db.collection("analytics_launches").where({ ts: _.gte(since), phase: "trading" }).count(),
        db.collection("analytics_launches").where({ ts: _.gte(since), phase: "afterClose" }).count(),
        db.collection("analytics_launches").where({ ts: _.gte(since), phase: "closed" }).count(),
      ]);
      const launchTotal = phTrading.total + phAfter.total + phClosed.total;
      const pct = (n) => (launchTotal ? +((n / launchTotal) * 100).toFixed(1) : null);
      const launch = {
        total: launchTotal,
        trading: phTrading.total, afterClose: phAfter.total, closed: phClosed.total,
        tradingPct: pct(phTrading.total),
        afterClosePct: pct(phAfter.total),
        closedPct: pct(phClosed.total),
        nonTradingPct: pct(phAfter.total + phClosed.total), // 核心假设指标：非交易时段打开占比（3 个月 ≥15%）
      };

      // events 集合：各事件近 N 天计数 + 关键下钻
      await ensureCollection("events");
      const cnt = (q) => db.collection("events").where(Object.assign({ ts: _.gte(since) }, q)).count();
      const [rt, subA, subR, subF, subD, sh, sf, sfHit, sfMiss] = await Promise.all([
        cnt({ event: "record_trade" }),
        cnt({ event: "sub_authorize", result: "accept" }),
        cnt({ event: "sub_authorize", result: "reject" }),
        cnt({ event: "sub_authorize", result: "fail" }),
        cnt({ event: "sub_authorize", result: "dismiss_banner" }),
        cnt({ event: "share" }),
        cnt({ event: "search_fund" }),
        cnt({ event: "search_fund", hit: true }),
        cnt({ event: "search_fund", hit: false }),
      ]);
      const searchTotal = sfHit.total + sfMiss.total;
      return { code: 0, data: {
        days,
        launch,
        events: {
          record_trade: rt.total,
          sub_authorize: { accept: subA.total, reject: subR.total, fail: subF.total, dismiss: subD.total },
          share: sh.total,
          search_fund: { total: searchTotal, hit: sfHit.total, miss: sfMiss.total, hitRate: searchTotal ? +((sfHit.total / searchTotal) * 100).toFixed(1) : null },
        },
      } };
    }

    // ===== 温度简报 =====
    if (action === "briefing") {
      await ensureCollection("fund_temperatures");
      const today = bjDate();
      let date = today;
      // 今日无数据（未到凌晨计算或节假日），取最近有数据的一天
      let list = await readAllByDate("fund_temperatures", date, 2000);
      if (list.length === 0) {
        const latest = await db.collection("fund_temperatures").orderBy("date", "desc").limit(1).get();
        if (!latest.data || latest.data.length === 0) {
          return { code: 0, data: { empty: true, msg: "暂无温度数据，请先运行 computeFundTemperature 定时任务" } };
        }
        date = latest.data[0].date;
        list = await readAllByDate("fund_temperatures", date, 2000);
      }
      if (list.length === 0) return { code: 0, data: { empty: true, msg: "暂无温度数据" } };

      // 基金名称映射（holdings + watchlist，取第一条名称）
      const nameMap = {};
      try {
        const holdings = await readAll("holdings", 5000);
        holdings.forEach((h) => { if (h.fundCode && h.fundName && !nameMap[h.fundCode]) nameMap[h.fundCode] = h.fundName; });
      } catch (e) { console.error("[opsTool] 读 holdings 失败:", e.message); }
      try {
        const watch = await readAll("watchlist", 3000);
        watch.forEach((h) => { if (h.fundCode && h.fundName && !nameMap[h.fundCode]) nameMap[h.fundCode] = h.fundName; });
      } catch (e) { /* 读 watchlist 失败不影响 */ }

      const dist = { low: 0, mid: 0, high: 0, nodata: 0 };
      const lows = [], highs = [], mids = [];
      list.forEach((t) => {
        dist[t.signal] = (dist[t.signal] || 0) + 1;
        const name = nameMap[t.fundCode] || t.fundCode;
        if (t.signal === "low" && lows.length < 3) lows.push({ code: t.fundCode, name });
        else if (t.signal === "high" && highs.length < 3) highs.push({ code: t.fundCode, name });
        else if (t.signal === "mid" && mids.length < 2) mids.push({ code: t.fundCode, name });
      });

      // 生成可复制文案（措辞合规：只做数据陈述，不带定性判断词）
      const lines = [];
      lines.push(`🌡️ 今日基金温度（${date}）`);
      lines.push(`温度偏低 ${dist.low || 0} 只 · 温度适中 ${dist.mid || 0} 只 · 温度偏高 ${dist.high || 0} 只`);
      if (lows.length) lines.push(`估值温度低于 0.75：${lows.map((f) => f.name).join("、")}`);
      if (highs.length) lines.push(`估值温度高于 1.25：${highs.map((f) => f.name).join("、")}`);
      if (!lows.length && !highs.length && mids.length) lines.push(`估值温度 0.75~1.25 区间：${mids.map((f) => f.name).join("、")}`);
      lines.push("");
      lines.push("📱 你的持仓现在是什么温度？扫码查看 👇");

      return { code: 0, data: { date, dist, lows, highs, copy: lines.join("\n"), count: list.length } };
    }

    // ===== 渠道管理 =====
    if (action === "listChannels") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      await ensureCollection("promo_channels");
      const res = await db.collection("promo_channels").orderBy("createTime", "desc").limit(50).get();
      const channels = res.data || [];
      const visits = {};
      for (const c of channels) {
        try {
          const cnt = await db.collection("promo_visits").where({ channelId: c.channelId }).count();
          visits[c.channelId] = cnt.total;
        } catch (e) { visits[c.channelId] = 0; }
      }
      return {
        code: 0,
        data: {
          channels: channels.map((c) => ({
            channelId: c.channelId,
            name: c.name,
            fileID: c.fileID || "",
            visitCount: visits[c.channelId] || 0,
            createTime: c.createTime,
          })),
        },
      };
    }

    if (action === "addChannel") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const { name } = event;
      const trimmed = String(name || "").trim();
      if (!trimmed) return { code: 400, msg: "请输入渠道名称" };
      await ensureCollection("promo_channels");
      const channelId = randChannelId();
      await db.collection("promo_channels").add({
        data: { channelId, name: trimmed.slice(0, 20), fileID: "", createTime: new Date() },
      });
      return { code: 0, data: { channelId } };
    }

    if (action === "removeChannel") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const { channelId } = event;
      if (!channelId) return { code: 400 };
      await db.collection("promo_channels").where({ channelId }).remove();
      // 访问记录一并清理
      try { await db.collection("promo_visits").where({ channelId }).remove(); } catch (e) { /* ignore */ }
      return { code: 0 };
    }

    if (action === "createCode") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const { channelId } = event;
      if (!channelId) return { code: 400, msg: "缺少渠道 ID" };
      await ensureCollection("promo_channels");
      const res = await db.collection("promo_channels").where({ channelId }).get();
      const ch = res.data && res.data[0];
      if (!ch) return { code: 404, msg: "渠道不存在" };

      const codeRes = await cloud.openapi.wxacode.getUnlimited({
        scene: "c_" + channelId,          // 扫码进入首页 onLoad options.scene
        page: "pages/index/index",
        checkPath: false,
        envVersion: "release",
        width: 430,
      });
      const upload = await cloud.uploadFile({
        cloudPath: `promo-codes/${channelId}.png`,
        fileContent: codeRes.buffer,
      });
      await db.collection("promo_channels").doc(ch._id).update({ data: { fileID: upload.fileID } });
      return { code: 0, data: { fileID: upload.fileID } };
    }

    return { code: 400, msg: "未知操作: " + action };
  } catch (e) {
    console.error("[opsTool]", e);
    return { code: 500, msg: e.message };
  }
};
