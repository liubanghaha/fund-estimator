const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, fundCode, fundName, fundCodes, group } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };

  const col = db.collection("watchlist");

  try {
    if (action === "add") {
      if (!fundCode || !fundName) return { code: 400, msg: "缺少基金信息" };
      if (fundCode.length !== 6 || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "基金代码格式错误" };
      if (fundName.length > 50) return { code: 400, msg: "基金名称过长" };
      const exist = await col.where({ _openid: OPENID, fundCode }).count();
      if (exist.total > 0) return { code: 0, msg: "已加自选" };
      await col.add({ data: { _openid: OPENID, fundCode, fundName, group: "", createTime: new Date() } });
      return { code: 0, msg: "加自选成功" };
    }

    if (action === "remove") {
      if (!fundCode) return { code: 400, msg: "缺少基金代码" };
      await col.where({ _openid: OPENID, fundCode }).remove();
      return { code: 0, msg: "取消自选" };
    }

    if (action === "list") {
      const res = await col.where({ _openid: OPENID }).orderBy("createTime", "desc").get();
      return { code: 0, data: res.data };
    }

    if (action === "check") {
      if (!fundCode) return { code: 400, msg: "缺少基金代码" };
      const exist = await col.where({ _openid: OPENID, fundCode }).count();
      return { code: 0, data: { followed: exist.total > 0 } };
    }

    if (action === "setGroup") {
      if (!fundCodes || !Array.isArray(fundCodes) || fundCodes.length === 0) return { code: 400, msg: "缺少基金代码" };
      if (typeof group !== "string") return { code: 400, msg: "缺少分组名称" };
      const name = group.trim().slice(0, 20);
      await col.where({ _openid: OPENID, fundCode: _.in(fundCodes) }).update({ data: { group: name } });
      return { code: 0, msg: "已更新分组" };
    }

    if (action === "getGroups") {
      const res = await col.where({ _openid: OPENID }).field({ group: true }).get();
      const groups = [...new Set(res.data.map(d => d.group || "").filter(g => g !== ""))].sort();
      return { code: 0, data: groups };
    }

    if (action === "tempMoves") {
      // 自选温度异动（2026-10-17，自选页摘要条用）：最近两个交易日的温度档位变化。
      // 口径与温度推送一致：low/mid/high 档位变化 = 异动；温度按天变，客户端日内缓存不跟轮询
      const codes = (Array.isArray(fundCodes) ? fundCodes : []).filter(c => /^\d{5,6}$/.test(c)).slice(0, 300);
      if (!codes.length) return { code: 0, data: { moves: [], date: "", prevDate: "" } };
      const td = require("./_shared/trading-day");
      // 最近两个有温度数据的交易日（任务缺行/假期时往前多扫几天）
      const days = [];
      for (let i = 0; i < 15 && days.length < 2; i++) {
        const ds = new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10);
        if (!td.isTradingDay(ds)) continue;
        const c = await db.collection("fund_temperatures").where({ date: ds, fundCode: _.in(codes.slice(0, 50)) }).count();
        if (c.total > 0) days.push(ds);
      }
      if (days.length < 2) return { code: 0, data: { moves: [], date: days[0] || "", prevDate: "" } };
      const sigByDay = {};
      for (let i = 0; i < codes.length; i += 100) {
        for (const ds of days) {
          const res = await db.collection("fund_temperatures")
            .where({ date: ds, fundCode: _.in(codes.slice(i, i + 100)) })
            .field({ fundCode: true, signal: true })
            .get();
          (res.data || []).forEach(t => {
            sigByDay[t.fundCode] = sigByDay[t.fundCode] || {};
            sigByDay[t.fundCode][ds] = t.signal;
          });
        }
      }
      const [curDay, prevDay] = days;
      const moves = Object.entries(sigByDay)
        .map(([fundCode, s]) => ({ fundCode, cur: s[curDay], prev: s[prevDay] }))
        .filter(m => m.cur && m.prev && m.cur !== "nodata" && m.prev !== "nodata" && m.cur !== m.prev);
      // 全量当前档位（自选行温度小圆点用；nodata 不出，前端不渲染）
      const signals = {};
      Object.entries(sigByDay).forEach(([fundCode, s]) => {
        if (s[curDay] && s[curDay] !== "nodata") signals[fundCode] = s[curDay];
      });
      return { code: 0, data: { date: curDay, prevDate: prevDay, moves, signals } };
    }

    if (action === "perf") {
      // 自选区间收益表（2026-10-17，表格化改版数据源）：添加后/近1周/近1月/近3年/近5年/成立来。
      // 数据源 = pingzhongdata 全量单位净值趋势（一次请求拿全历史，近3年/近5年/成立来没有
      // 就算不出来）。按日缓存 fund_perf_cache：当日首个打开的客户端现场拉（预算 50s，
      // 超预算的基金本轮出"--"，下一打开自动补齐），之后当天所有用户走缓存秒回。
      // 添加后 = 加自选日净值 → 最新净值（navAtAdd 首次覆盖到该基金时回填到自选行）。
      const wlRows = await col.where({ _openid: OPENID })
        .field({ fundCode: true, createTime: true, navAtAdd: true })
        .limit(1000).get();
      const items = (wlRows.data || []).filter(r => r.fundCode && /^\d{6}$/.test(r.fundCode));
      if (!items.length) return { code: 0, data: { date: "", funds: {} } };
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const codes = [...new Set(items.map(r => r.fundCode))];

      // 集合守卫必须在首次读取之前：2026-10-17 首版把 createCollection 放在读取后，
      // 集合不存在时读取直接抛 -502005，整个 perf 返回 500、客户端全 "--"
      try { await db.createCollection("fund_perf_cache"); } catch (e) { /* 已存在 */ }

      // 1) 当日缓存命中（旧模式缓存缺 m3/m6 字段 → 视为未命中重拉覆盖）
      const statsByCode = {};
      for (let i = 0; i < codes.length; i += 100) {
        const res = await db.collection("fund_perf_cache")
          .where({ fundCode: _.in(codes.slice(i, i + 100)), date: today })
          .get();
        (res.data || []).forEach(c => {
          if (typeof c.m3 === "number") statsByCode[c.fundCode] = c;
        });
      }

      // 2) 缺的现场拉趋势（预算 50s）：算六个区间数入缓存；顺带为该基金回填自选行 navAtAdd
      const missing = codes.filter(c => !statsByCode[c]);
      if (missing.length) {
        const started = Date.now();
        const CONCURRENT = 10;
        let fetched = 0;
        for (let i = 0; i < missing.length; i += CONCURRENT) {
          if (i > 0 && Date.now() - started >= 50000) {
            console.log(`[manageWatchlist][perf] 达 50s 预算，剩余 ${missing.length - i} 只本轮跳过`);
            break;
          }
          const batch = missing.slice(i, i + CONCURRENT);
          const trends = await Promise.all(batch.map(c => fetchNetWorthTrend(c)));
          await Promise.all(batch.map(async (code, j) => {
            const trend = trends[j];
            if (!trend || trend.length < 2) {
              // 负缓存：无趋势文件（968/货币等）当日不再反复拉（此前每开一次重拉一轮）
              const empty = { fundCode: code, date: today, lastNav: 0, w1: null, m1: null, m3: null, m6: null, y3: null, y5: null, incept: null };
              try {
                await db.collection("fund_perf_cache").doc(code).set({ data: empty });
                statsByCode[code] = empty;
                fetched++;
              } catch (e) { /* ignore */ }
              return;
            }
            const end = trend[trend.length - 1];
            const DAY = 86400000;
            const stats = {
              fundCode: code,
              date: today,
              lastNav: end[1],
              w1: intervalPct(trend, end[0] - 7 * DAY),
              m1: intervalPct(trend, end[0] - 30 * DAY),
              m3: intervalPct(trend, end[0] - 91 * DAY),
              m6: intervalPct(trend, end[0] - 183 * DAY),
              y3: intervalPct(trend, end[0] - 3 * 365 * DAY),
              y5: intervalPct(trend, end[0] - 5 * 365 * DAY),
              incept: +(((end[1] / trend[0][1]) - 1) * 100).toFixed(2),
            };
            try {
              await db.collection("fund_perf_cache").doc(code).set({ data: stats });
              statsByCode[code] = stats;
              fetched++;
            } catch (e) { /* 单只写失败不影响其余 */ }
            // 回填该基金的自选行 navAtAdd（一次性；此后添加后收益零成本可算）
            for (const r of items) {
              if (r.fundCode !== code || r.navAtAdd != null) continue;
              const ct = r.createTime ? new Date(r.createTime).getTime() : 0;
              if (!ct) continue;
              let base = trend[0];
              for (const p of trend) { if (p[0] <= ct) base = p; else break; }
              try { await col.doc(r._id).update({ data: { navAtAdd: base[1] } }); r.navAtAdd = base[1]; } catch (e) { /* ignore */ }
            }
          }));
        }
        console.log(`[manageWatchlist][perf] 现场拉取 ${fetched}/${missing.length}，缓存命中 ${codes.length - missing.length}`);
      }

      // 3) 温度异动 + 全量档位（2026-10-17 合并进 perf：一次请求供摘要条+行内温度，
      //    省一次云函数调用；口径与 tempMoves 一致：最近两个交易日 low/mid/high 档变=异动）
      const td = require("./_shared/trading-day");
      const tempDays = [];
      for (let i = 0; i < 15 && tempDays.length < 2; i++) {
        const ds = new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10);
        if (!td.isTradingDay(ds)) continue;
        const c = await db.collection("fund_temperatures").where({ date: ds, fundCode: _.in(codes.slice(0, 50)) }).count();
        if (c.total > 0) tempDays.push(ds);
      }
      let moves = [], signals = {};
      if (tempDays.length >= 2) {
        const sigByDay = {};
        for (let i = 0; i < codes.length; i += 100) {
          for (const ds of tempDays) {
            const res = await db.collection("fund_temperatures")
              .where({ date: ds, fundCode: _.in(codes.slice(i, i + 100)) })
              .field({ fundCode: true, signal: true })
              .get();
            (res.data || []).forEach(t => {
              sigByDay[t.fundCode] = sigByDay[t.fundCode] || {};
              sigByDay[t.fundCode][ds] = t.signal;
            });
          }
        }
        const [curDay, prevDay] = tempDays;
        moves = Object.entries(sigByDay)
          .map(([fundCode, s]) => ({ fundCode, cur: s[curDay], prev: s[prevDay] }))
          .filter(m => m.cur && m.prev && m.cur !== "nodata" && m.prev !== "nodata" && m.cur !== m.prev);
        Object.entries(sigByDay).forEach(([fundCode, s]) => {
          if (s[curDay] && s[curDay] !== "nodata") signals[fundCode] = s[curDay];
        });
      }

      // 4) 组装（added 按用户逐行算：navAtAdd 缺失出 "--"，待回填后下次展示）
      const funds = {};
      for (const r of items) {
        const s = statsByCode[r.fundCode];
        if (!s) { funds[r.fundCode] = emptyPerf(); continue; }
        const added = r.navAtAdd != null && s.lastNav > 0 ? +(((s.lastNav / r.navAtAdd) - 1) * 100).toFixed(2) : null;
        funds[r.fundCode] = {
          // 数值字段给表头排序用；Text/Cls 给渲染
          added: added, w1: s.w1, m1: s.m1, m3: s.m3, m6: s.m6, y3: s.y3, y5: s.y5, incept: s.incept,
          addedText: fmtPct(added).t, addedCls: fmtPct(added).c,
          w1Text: fmtPct(s.w1).t, w1Cls: fmtPct(s.w1).c,
          m1Text: fmtPct(s.m1).t, m1Cls: fmtPct(s.m1).c,
          m3Text: fmtPct(s.m3).t, m3Cls: fmtPct(s.m3).c,
          m6Text: fmtPct(s.m6).t, m6Cls: fmtPct(s.m6).c,
          y3Text: fmtPct(s.y3).t, y3Cls: fmtPct(s.y3).c,
          y5Text: fmtPct(s.y5).t, y5Cls: fmtPct(s.y5).c,
          inceptText: fmtPct(s.incept).t, inceptCls: fmtPct(s.incept).c,
        };
      }
      return { code: 0, data: { date: today, funds, moves, signals, tempDate: tempDays[0] || "" } };
    }

    if (action === "renameGroup") {
      if (!group || typeof group !== "string") return { code: 400, msg: "缺少原分组名" };
      const newName = (event.newGroup || "").trim().slice(0, 20);
      if (!newName) return { code: 400, msg: "新分组名不能为空" };
      const oldName = group.trim();
      await col.where({ _openid: OPENID, group: oldName }).update({ data: { group: newName } });
      return { code: 0, msg: "已重命名" };
    }

    if (action === "deleteGroup") {
      if (!group || typeof group !== "string") return { code: 400, msg: "缺少分组名" };
      const name = group.trim();
      await col.where({ _openid: OPENID, group: name }).update({ data: { group: "" } });
      return { code: 0, msg: "已删除分组" };
    }

    return { code: 400, msg: "无效操作" };
  } catch (e) {
    console.error("manageWatchlist error:", e);
    return { code: 500, msg: "操作失败" };
  }
};

// ---- perf action 辅助（自选区间收益表） ----

// 拉全量单位净值趋势：pingzhongdata 一次返回成立以来的日频序列。
// 域名用 fund.eastmoney.com（f10.eastmoney.com 对非浏览器 UA 返回 403，2026-10-17 实测）。
// 返回 [[ts, nav], ...] 升序；拉不到/解析失败返回 null（968 互认、货币等无此文件）
function fetchNetWorthTrend(code) {
  return new Promise((resolve) => {
    const req = https.get(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
      headers: { Referer: "https://fund.eastmoney.com/" },
    }, (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const m = body.match(/Data_netWorthTrend\s*=\s*(\[.*?\]);/s);
          if (!m) return resolve(null);
          const arr = JSON.parse(m[1]);
          resolve((arr || [])
            .map(p => [p.x, p.y])
            .filter(p => p[0] > 0 && p[1] > 0)
            .sort((a, b) => a[0] - b[0]));
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// 区间涨幅：起点 = 不晚于 startTs 的最后一个净值点（比起点还早 → null，基金太年轻），
// 终点 = 最新点。负号基金成立不足该区间的列自然出 "--"
function intervalPct(trend, startTs) {
  if (!trend || trend.length < 2 || startTs <= trend[0][0]) return null;
  let start = trend[0];
  for (const p of trend) { if (p[0] <= startTs) start = p; else break; }
  const end = trend[trend.length - 1];
  return +(((end[1] / start[1]) - 1) * 100).toFixed(2);
}

// 百分比 → 展示字段：{t: "+1.24%", c: "up"|"down"|""}；null → "--"
function fmtPct(p) {
  if (p == null || !isFinite(p)) return { t: "--", c: "" };
  return { t: (p > 0 ? "+" : "") + p.toFixed(2) + "%", c: p > 0 ? "up" : p < 0 ? "down" : "" };
}

function emptyPerf() {
  const e = { t: "--", c: "" };
  return {
    addedText: e.t, addedCls: e.c, w1Text: e.t, w1Cls: e.c, m1Text: e.t, m1Cls: e.c,
    m3Text: e.t, m3Cls: e.c, m6Text: e.t, m6Cls: e.c,
    y3Text: e.t, y3Cls: e.c, y5Text: e.t, y5Cls: e.c, inceptText: e.t, inceptCls: e.c,
  };
}
