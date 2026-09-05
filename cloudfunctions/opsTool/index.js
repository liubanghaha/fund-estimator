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
      // （push_open 不在此列：打开率以服务端 push_logs.openedAt 为权威口径，避免双算）
      await ensureCollection("events");
      const cnt = (q) => db.collection("events").where(Object.assign({ ts: _.gte(since) }, q)).count();
      const [rt, subA, subR, subF, subD, sh, sf, sfHit, sfMiss, sl, slFail, lc] = await Promise.all([
        cnt({ event: "record_trade" }),
        cnt({ event: "sub_authorize", result: "accept" }),
        cnt({ event: "sub_authorize", result: "reject" }),
        cnt({ event: "sub_authorize", result: "fail" }),
        cnt({ event: "sub_authorize", result: "dismiss_banner" }),
        cnt({ event: "share" }),
        cnt({ event: "search_fund" }),
        cnt({ event: "search_fund", hit: true }),
        cnt({ event: "search_fund", hit: false }),
        cnt({ event: "share_landing" }),
        cnt({ event: "share_landing", err: "card_fail" }),
        cnt({ event: "landing_convert" }),
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
          share_landing: { total: sl.total, cardFail: slFail.total, arrived: Math.max(sl.total - slFail.total, 0), convert: lc.total },
        },
      } };
    }

    // ===== 推送灰度看板（P0-2：额度结余 / 打开率 / 取消订阅率）=====
    if (action === "pushReport") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const days = Math.min(Math.max(parseInt(event.days) || 7, 1), 90);
      const since = Date.now() - days * 86400000;
      const _ = db.command;

      // 1) 额度池快照：subscriptions（一次授权=+1，发送-1，43101 归零；收盘小结/净值播报/提醒共用一池）
      const subs = await readAll("subscriptions", 5000);
      const pool = subs.filter((s) => !s.scene || s.scene === "closing_brief");
      const quotaSum = pool.reduce((a, s) => a + (s.quota || 0), 0);

      // 2) 窗口内 push_logs 分场景聚合（scene: closing_brief/nav_brief/weekly_brief/pe_alert/rate_alert）
      const logs = [];
      {
        const PAGE = 100;
        let skip = 0;
        while (skip < 20000) {
          const res = await db.collection("push_logs").where({ sentAt: _.gte(since) }).skip(skip).limit(PAGE).get();
          logs.push(...(res.data || []));
          if ((res.data || []).length < PAGE) break;
          skip += PAGE;
        }
      }
      const byScene = {};
      const sentUsers = new Set(), unsubUsers = new Set();
      for (const log of logs) {
        const sc = log.scene || "closing_brief";
        const g = byScene[sc] || (byScene[sc] = { sent: 0, failed: 0, opened: 0, unsub: 0 });
        if (log.status === "sent") { g.sent++; sentUsers.add(log._openid); }
        else if (log.status === "failed") {
          g.failed++;
          // 43101 = 用户已取消订阅（发送失败，本地额度已同步归零）
          if (String(log.errMsg || "").indexOf("43101") !== -1) { g.unsub++; unsubUsers.add(log._openid); }
        }
        if (log.openedAt) g.opened++;
      }
      const scenes = Object.keys(byScene).map((k) => ({
        scene: k,
        sent: byScene[k].sent,
        opened: byScene[k].opened,
        openRate: byScene[k].sent ? +((byScene[k].opened / byScene[k].sent) * 100).toFixed(1) : null,
        unsub: byScene[k].unsub,
      })).sort((a, b) => b.sent - a.sent);
      const sentTotal = scenes.reduce((a, s) => a + s.sent, 0);
      const openedTotal = scenes.reduce((a, s) => a + s.opened, 0);

      return { code: 0, data: {
        days,
        quota: {
          usersTotal: pool.length,
          usersWithQuota: pool.filter((s) => (s.quota || 0) > 0).length,
          quotaSum, // 额度结余（灰度门禁：结余为正）
          avgPerUser: pool.length ? +(quotaSum / pool.length).toFixed(2) : 0,
        },
        opens: {
          sent: sentTotal,
          opened: openedTotal,
          openRate: sentTotal ? +((openedTotal / sentTotal) * 100).toFixed(1) : null, // 灰度门禁：≥15%
          scenes,
        },
        unsub: {
          users: unsubUsers.size, // 窗口内 43101 去重用户数
          rate: sentUsers.size ? +((unsubUsers.size / sentUsers.size) * 100).toFixed(1) : null,
        },
      } };
    }

    // ===== P0-1 老用户召回 =====
    // 目标筛选 → 50/50 send/control 分组落库 recall_state → 委托 dailyBriefing.recallPush 发送
    if (action === "recallSend") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const bucket = ["7d", "14d", "30d"].indexOf(event.bucket) !== -1 ? event.bucket : "7d";
      const limit = Math.min(Math.max(parseInt(event.limit) || 100, 10), 500);
      const dryRun = !!event.dryRun;
      const minDays = parseInt(bucket);
      const now = Date.now();
      const _ = db.command;

      // 1) 额度池：有额度 + 未退订召回（额度与双条同池，发送窗口须避开 15:30/21:30 扣费点）
      const subs = await readAll("subscriptions", 5000);
      const pool = subs.filter((s) => (!s.scene || s.scene === "closing_brief") && (s.quota || 0) > 0 && !s.recallOptOut);

      // 2) 最近启动时间（近 60 天启动记录；窗口外/无记录视为深度沉默，计入任何档位）
      const launches = [];
      {
        const PAGE = 100;
        let skip = 0;
        while (skip < 40000) {
          const res = await db.collection("analytics_launches").where({ ts: _.gte(now - 60 * 86400000) }).skip(skip).limit(PAGE).get();
          launches.push(...(res.data || []));
          if ((res.data || []).length < PAGE) break;
          skip += PAGE;
        }
      }
      const lastTs = {};
      for (const l of launches) {
        if (!l._openid || !l.ts) continue;
        if (!lastTs[l._openid] || l.ts > lastTs[l._openid]) lastTs[l._openid] = l.ts;
      }
      let targets = pool.map((s) => s._openid).filter((id) => {
        const lt = lastTs[id];
        return !lt || now - lt >= minDays * 86400000;
      });

      // 3) 频控：7 天内已发过召回的排除
      if (targets.length > 0) {
        const recentLogs = [];
        {
          const PAGE = 100;
          let skip = 0;
          while (skip < 5000) {
            const res = await db.collection("push_logs").where({
              kind: _.in(["recall_7d", "recall_14d", "recall_30d"]),
              sentAt: _.gte(now - 7 * 86400000),
            }).skip(skip).limit(PAGE).get();
            recentLogs.push(...(res.data || []));
            if ((res.data || []).length < PAGE) break;
            skip += PAGE;
          }
        }
        const recent = new Set(recentLogs.map((l) => l._openid));
        targets = targets.filter((id) => !recent.has(id));
      }

      // 4) 随机抽样 + 对半分组（send / control 对照实验）
      for (let i = targets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [targets[i], targets[j]] = [targets[j], targets[i]];
      }
      const selected = targets.slice(0, limit);
      const half = Math.ceil(selected.length / 2);
      const sendList = selected.slice(0, half).map((id) => ({ openid: id, bucket }));
      const controlList = selected.slice(half);

      if (dryRun) {
        return { code: 0, data: {
          dryRun: true, bucket, pool: pool.length, eligible: targets.length,
          sendCount: sendList.length, controlCount: controlList.length,
          sample: targets.slice(0, 5),
          briefPreview: { thing1: "韭菜估值宝", thing2: "你的持仓组合", thing3: "持仓温度有更新，来看看最新数据" },
        } };
      }

      if (sendList.length === 0) return { code: 0, data: { bucket, selected: 0, msg: "无符合条件用户" } };

      // 5) 分组落库 recall_state（send+control 都记，对照组不发只记录，报表对比用）
      await ensureCollection("recall_state");
      const batchTs = now;
      const docs = sendList.map((t) => ({ openid: t.openid, cohort: "send", bucket, batchTs, ts: batchTs }))
        .concat(controlList.map((id) => ({ openid: id, cohort: "control", bucket, batchTs, ts: batchTs })));
      for (let i = 0; i < docs.length; i += 20) {
        await Promise.all(docs.slice(i, i + 20).map((d) => db.collection("recall_state").add({ data: d }).catch(() => {})));
      }

      // 6) 委托 dailyBriefing 发送（跨函数调用无 OPENID，符合其"仅服务端"校验）
      const sendRes = await cloud.callFunction({
        name: "dailyBriefing",
        data: { action: "recallPush", targets: sendList },
      });
      const r = sendRes.result || {};
      return { code: 0, data: { bucket, selected: selected.length, sendCount: sendList.length, controlCount: controlList.length, sent: r.sent || 0, failed: r.failed || 0, batchTs } };
    }

    // 召回对照报表：send vs control 的 7 日回访率（回访 = 批次后 7 日内 analytics_launches 有记录）
    if (action === "recallReport") {
      if (!(await isAdmin(OPENID))) return { code: 403, msg: "无权限" };
      const _ = db.command;
      const states = await readAll("recall_state", 5000);
      if (states.length === 0) return { code: 0, data: { batches: [] } };
      const batches = {};
      for (const s of states) {
        const key = String(s.batchTs);
        batches[key] = batches[key] || { batchTs: s.batchTs, bucket: s.bucket, send: [], control: [] };
        batches[key][s.cohort === "control" ? "control" : "send"].push(s.openid);
      }
      const out = [];
      for (const key of Object.keys(batches).sort((a, b) => Number(b) - Number(a))) {
        const b = batches[key];
        // 批次后 7 日内的启动 openid 集合
        const revisitSet = new Set();
        {
          const PAGE = 100;
          let skip = 0;
          while (skip < 20000) {
            const res = await db.collection("analytics_launches").where({
              ts: _.gte(b.batchTs).and(_.lt(b.batchTs + 7 * 86400000)),
            }).skip(skip).limit(PAGE).get();
            (res.data || []).forEach((l) => { if (l._openid) revisitSet.add(l._openid); });
            if ((res.data || []).length < PAGE) break;
            skip += PAGE;
          }
        }
        // 发送组分母剔除发送失败用户（43101/失败）
        const sendIds = [...new Set(b.send)];
        const sentIds = new Set();
        if (sendIds.length) {
          const logs = [];
          {
            const PAGE = 100;
            let skip = 0;
            while (skip < 5000) {
              const res = await db.collection("push_logs").where({
                _openid: _.in(sendIds),
                kind: _.in(["recall_7d", "recall_14d", "recall_30d"]),
                sentAt: _.gte(b.batchTs),
              }).skip(skip).limit(PAGE).get();
              logs.push(...(res.data || []));
              if ((res.data || []).length < PAGE) break;
              skip += PAGE;
            }
          }
          logs.forEach((l) => { if (l.status === "sent") sentIds.add(l._openid); });
        }
        const rate = (ids) => {
          const uniq = [...new Set(ids)];
          if (!uniq.length) return null;
          const hit = uniq.filter((id) => revisitSet.has(id)).length;
          return { n: uniq.length, revisit: hit, rate: +((hit / uniq.length) * 100).toFixed(1) };
        };
        out.push({ batchTs: b.batchTs, bucket: b.bucket, send: rate([...sentIds]), control: rate(b.control) });
      }
      return { code: 0, data: { batches: out } };
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
