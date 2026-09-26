const cloud = require("wx-server-sdk");
const td = require("./_shared/trading-day");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 赎回费分档缓存（费率阶梯倒计时轻标的数据源）
 *
 * 每个工作日 05:00 刷新：拉东财 F10 费率页（fundf10.eastmoney.com/jjfl_{code}.html，
 * 静态 HTML、已在白名单域名），解析「赎回费率」分档表，存 fund_redemption_fees。
 *
 * 费率极少变动 → 每基金 7 天 TTL，首跑全量、之后每天只刷过期的。
 * 解析失败/无分档表（货币基金、C 份额等）→ tiers:[]，前端静默不显示徽章，不猜数据。
 *
 * tiers 形状（maxDays 升序，null = 无上限；rate 为百分比数字，null = 固定金额等非百分比档）：
 * [{ maxDays: 7, rate: 1.5 }, { maxDays: 365, rate: 0.5 }, { maxDays: 730, rate: 0.25 }, { maxDays: null, rate: 0 }]
 * 语义：持有天数 < maxDays 落在该档；跨过 maxDays 进入下一档（倒计时就是数这个边界）。
 */

const COLL = "fund_redemption_fees";
const STATUS_DOC = "redemption_fee_status";
const PAGE = 1000;
const FETCH_CONCURRENT = 10;
const BATCH_SLEEP_MS = 300;
const REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;

exports.main = async (event) => {
  // 安全：定时任务专用，拒绝客户端调用（防伪造费率数据）
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  const ev = event || {};
  const dryRun = !!ev.dryRun;
  const force = !!ev.force;
  // limit：只处理前 N 只（冒烟/灰度用，正常触发不传 = 全量）
  const limit = parseInt(ev.limit, 10) || 0;
  const t0 = Date.now();
  const el = () => Date.now() - t0;
  try {
    const today = td.bjDateStr();
    if (!dryRun && !force && !td.isTradingDay(today)) {
      return { code: 0, msg: `非交易日 ${today} 跳过` };
    }

    const codes = await getUniqueFundCodes();
    if (codes.length === 0) return { code: 0, msg: "无持仓基金" };

    await writeStatus("running", { today, fundCount: codes.length });

    // 7 天 TTL：只刷没有记录或 fetchedAt 过期的基金；force 绕过 TTL 全量重拉
    // （解析器修 bug 后用 force 强刷已写入的错误档位，不必等 7 天）
    const lastFetched = await readFetchedAt(codes);
    const now = Date.now();
    const staleCodes = force ? codes : codes.filter((c) => {
      const t = lastFetched[c];
      return !t || now - t > REFRESH_TTL_MS;
    });
    const fresh = codes.length - staleCodes.length;
    const needFetch = limit > 0 ? staleCodes.slice(0, limit) : staleCodes;

    let errors = 0, withTiers = 0, written = 0;
    const failedCodes = [];
    const docs = [];
    // 预算 + 边写边落：全量 force 重拉 2223 只 ≈ 压线 300s，东财稍慢即被杀；
    // 无边写时 docs 全在内存、超时整轮全丢且状态文档停在 running（二轮审查 P2）
    const FETCH_BUDGET_MS = 240000;
    for (let i = 0; i < needFetch.length; i += FETCH_CONCURRENT) {
      if (el() > FETCH_BUDGET_MS) {
        console.warn(`[refreshRedemptionFees] 预算到点，已处理 ${i}/${needFetch.length}，剩余次日重试`);
        break;
      }
      const batch = needFetch.slice(i, i + FETCH_CONCURRENT);
      const results = await Promise.all(batch.map((code) => fetchFeePage(code)));
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.err) {
          errors++;
          if (failedCodes.length < 20) failedCodes.push(batch[j]);
          continue;
        }
        if (r.doc.tiers.length > 0) withTiers++;
        docs.push(r.doc);
      }
      // 每 10 批（100 只）flush 一次，最坏损失收敛到一个批次
      if (docs.length >= FETCH_CONCURRENT * 10) {
        if (!dryRun) written += await upsertAll(docs);
        docs.length = 0;
      }
      if (i + FETCH_CONCURRENT < needFetch.length) {
        await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
      }
    }
    // 尾批不足 100 只的落库
    if (!dryRun && docs.length > 0) written += await upsertAll(docs);

    if (dryRun) {
      await writeStatus("done", { today, dryRun: true });
      return {
        code: 0, dryRun: true, today,
        codes: codes.length,
        fresh,
        checked: needFetch.length,
        writeWould: withTiers, withTiers, errors,
        failedCodes,
        costMs: el(),
      };
    }

    const result = {
      code: 0, today,
      codes: codes.length,
      fresh,
      checked: needFetch.length,
      written, withTiers, errors,
      failedCodes,
      costMs: el(),
    };
    await writeStatus("done", result);
    console.log(`[refreshRedemptionFees] ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    console.error("refreshRedemptionFees 失败:", e.message);
    await writeStatus("error", { msg: e.message }).catch(() => {});
    return { code: 500, msg: e.message };
  }
};

async function writeStatus(status, extra) {
  return db.collection("app_config").doc(STATUS_DOC).set({
    data: { status, ...extra, updatedAt: Date.now() }
  }).catch(() => {});
}

// 持仓基金代码（去重，_id 游标分页 + 显式定序）——与温度/季报快照同池
async function getUniqueFundCodes() {
  const all = [];
  let lastId = "";
  while (true) {
    const q = db.collection("holdings").field({ fundCode: true }).orderBy("_id", "asc").limit(PAGE);
    const res = lastId ? await q.where({ _id: _.gt(lastId) }).get() : await q.get();
    if (!res.data || res.data.length === 0) break;
    all.push(...res.data);
    if (res.data.length < PAGE) break;
    lastId = res.data[res.data.length - 1]._id;
  }
  return [...new Set(all.map((h) => h.fundCode).filter(Boolean))];
}

async function readFetchedAt(codes) {
  const map = {};
  for (let i = 0; i < codes.length; i += 100) {
    try {
      const res = await db.collection(COLL)
        .where({ fundCode: _.in(codes.slice(i, i + 100)) })
        .field({ fundCode: true, fetchedAt: true })
        .limit(PAGE).get();
      (res.data || []).forEach((d) => { if (d.fundCode) map[d.fundCode] = d.fetchedAt || 0; });
    } catch (e) { console.warn("[refreshRedemptionFees] 读缓存 TTL 失败:", e.message); }
  }
  return map;
}

function fetchFeePage(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/jjfl_${fundCode}.html`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const tiers = parseRedemptionTiers(body);
          resolve({ doc: { fundCode, tiers, ok: tiers.length > 0, fetchedAt: Date.now(), source: "f10-jjfl" } });
        } catch (e) { resolve({ err: e.message }); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ err: "timeout" }); });
    req.on("error", () => resolve({ err: "network" }));
  });
}

// 解析「赎回费率」分档表：<label class="left">赎回费率</label> 小节后的第一张表，
// 两列（适用期限/赎回费率），如「小于7天 1.50%」「大于等于7天，小于365天 0.50%」
function parseRedemptionTiers(html) {
  const labelIdx = html.indexOf('<label class="left">赎回费率');
  if (labelIdx === -1) return [];
  const tableStart = html.indexOf('<table', labelIdx);
  if (tableStart === -1) return [];
  const tableEnd = html.indexOf('</table>', tableStart);
  if (tableEnd === -1) return [];
  const tbl = html.slice(tableStart, tableEnd);

  const tiers = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(tbl)) !== null) {
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td;
    while ((td = tdRe.exec(m[1])) !== null) {
      tds.push(td[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim());
    }
    if (tds.length < 2) continue;
    const rateMatch = tds[1].match(/([\d.]+)\s*%/);
    tiers.push({
      maxDays: parseUpperBoundDays(tds[0]),
      rate: rateMatch ? parseFloat(rateMatch[1]) : null, // "每笔X元"等非百分比档 → null
    });
  }
  // 校验：至少一行百分比费率，且档位须构成合法阶梯——
  // 无上界档（maxDays=null）至多一行且必须是最后一行（货币基金"不收赎回费+特殊条款"
  // 会产出多行 null，必须整表拒绝，宁可不显示，不显示错费率）
  if (!tiers.some((t) => typeof t.rate === "number")) return [];
  let lastBound = -1, nullCount = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.maxDays == null) {
      nullCount++;
      if (nullCount > 1 || i !== tiers.length - 1) return [];
      continue;
    }
    if (t.maxDays <= lastBound) return [];
    lastBound = t.maxDays;
  }
  return tiers;
}

// 「适用期限」文本 → 该档上界天数（null = 无上限/最后一档）。
// 「小于7天」→7；「大于等于7天，小于365天」→365；「大于等于730天」→null；「小于1年」→365
function parseUpperBoundDays(term) {
  if (!term) return null;
  if (term.indexOf("以上") !== -1 || term.indexOf("及以上") !== -1) return null;
  const ltIdx = term.indexOf("小于");
  if (ltIdx === -1) return null;
  const m = term.slice(ltIdx).match(/(\d+)\s*(天|年|月)?/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  const unit = m[2] || "天";
  if (unit === "年") return v * 365;
  if (unit === "月") return v * 30;
  return v;
}

async function upsertAll(docs) {
  let ok = 0;
  for (let i = 0; i < docs.length; i += 20) {
    const batch = docs.slice(i, i + 20);
    const results = await Promise.all(batch.map((d) =>
      db.collection(COLL).doc(d.fundCode)
        .set({ data: d })
        .then(() => true).catch(() => false)));
    ok += results.filter(Boolean).length;
  }
  return ok;
}
