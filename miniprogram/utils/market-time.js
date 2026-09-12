/**
 * 交易日时钟：全局缓存新鲜度统一按「数据只在交易日变化」判断。
 *
 * 三态：
 *  - trading   交易日 9:30~15:00（含午休，估值定格但保持短 TTL 简单处理）
 *  - afterClose 交易日 15:00~24:00（估值已收盘定格；净值当晚发布，发布后 actualDate=今天 即冻结）
 *  - closed    非交易日（周末/节假日）全天 + 交易日 0:00~9:30
 *
 * 节假日表来自国务院办公厅当年通知（只记工作日休市日；周末股市永不交易，调休上班日也不开市）。
 * 未收录的年份退化为「工作日=交易日」：宁可多拉一次，不可把交易日错标成休市导致数据不刷新。
 */

// 2026 年安排（国办发明电〔2025〕）：元旦 1/1-1/2；春节 2/16-2/20、2/23；
// 清明 4/6；劳动节 5/1、5/4-5/5；端午 6/19；中秋 9/25；国庆 10/1-10/2、10/5-10/7
const HOLIDAYS = {
  2026: [
    "2026-01-01", "2026-01-02",
    "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
    "2026-04-06",
    "2026-05-01", "2026-05-04", "2026-05-05",
    "2026-06-19",
    "2026-09-25",
    "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
  ],
};

// ---- 北京时间（UTC+8）基础 ----

function _bjNow() {
  return new Date(Date.now() + 8 * 3600000);
}

// 北京日期串 YYYY-MM-DD；offsetDays 为相对当前日的天数偏移
function bjDateStr(offsetDays = 0) {
  const d = _bjNow();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function _isWeekday(dateStr) {
  const day = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return day >= 1 && day <= 5;
}

// 是否交易日：表内年份查表（工作日且非节假日），表外年份按工作日兜底
function isTradingDay(dateStr) {
  if (!dateStr) return false;
  const year = dateStr.slice(0, 4);
  const list = HOLIDAYS[year];
  if (!list) return _isWeekday(dateStr);
  return _isWeekday(dateStr) && list.indexOf(dateStr) === -1;
}

// 最近一个 <= dateStr 的交易日（dateStr 缺省=今天，今天为交易日则返回今天）
function lastTradingDay(dateStr) {
  let d = dateStr || bjDateStr();
  for (let i = 0; i < 30; i++) {
    if (isTradingDay(d)) return d;
    const t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() - 1);
    d = t.toISOString().slice(0, 10);
  }
  return d;
}

// 当前市场三态
function marketPhase() {
  const bj = _bjNow();
  const today = bj.toISOString().slice(0, 10);
  if (!isTradingDay(today)) return "closed";
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  if (min >= 570 && min < 900) return "trading"; // 9:30~15:00
  if (min >= 900) return "afterClose";
  return "closed"; // 交易日凌晨~9:30，数据仍是上一交易日的
}

// 日期串对应交易日 15:00（北京）的时间戳；非交易日往前找最近交易日的收盘点
function _freezeTs(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 30 && !isTradingDay(d); i++) {
    const t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() - 1);
    d = t.toISOString().slice(0, 10);
  }
  return Date.parse(d + "T07:00:00Z"); // 15:00 北京 = 07:00 UTC
}

/**
 * 统一缓存新鲜度判断。
 * @param cache 缓存对象，需含 ts（写入时间戳）；actualDate 可选（数据所属净值日 YYYY-MM-DD）
 * @param opts.estimateTtl 盘中估值 TTL，默认 60s
 * @param opts.idleTtl 盘后待发布窗口（交易日 15:00 至净值发布）校验间隔，默认 30min
 * @param opts.finalAtClose 数据 15:00 收盘即定格（如指数行情，无晚间净值发布）：
 *                         盘后写入的缓存直接冻结；缺省时盘后走 idleTtl 窗口等净值发布
 * @returns true = 缓存即最新，无需网络请求
 *
 * 规则：
 *  - trading：now - ts < estimateTtl
 *  - afterClose：actualDate=今天（净值已发布）→ 冻结；否则每 idleTtl 静默校验一次
 *  - closed：actualDate=最近交易日 → 冻结（周末/节假日/早盘全免请求）
 *  - 无 actualDate 且 finalAtClose：写入时间在最近收盘点之后即视为定格（估值收盘后不再变）
 */
function isCacheFresh(cache, opts) {
  const estimateTtl = (opts && opts.estimateTtl) || 60 * 1000;
  const idleTtl = (opts && opts.idleTtl) || 30 * 60 * 1000;
  const finalAtClose = !!(opts && opts.finalAtClose);
  const ts = cache && cache.ts;
  if (!ts) return false;
  const phase = marketPhase();
  const now = Date.now();
  if (phase === "trading") return now - ts < estimateTtl;

  const today = bjDateStr();
  const dataDay = phase === "afterClose" ? today : lastTradingDay(today);
  const actualDate = cache && cache.actualDate;
  if (actualDate && actualDate >= dataDay) return true;
  if (!actualDate && finalAtClose && ts >= _freezeTs(dataDay)) return true;
  return now - ts < idleTtl;
}

// 午休 11:30~13:00（交易时段内估值不变化，轮询可休息；marketPhase 保持三态不动，
// 缓存 TTL 等既有调用方语义不受影响）
function isLunchBreak() {
  const bj = _bjNow();
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return min >= 690 && min < 780;
}

module.exports = {
  isTradingDay,
  lastTradingDay,
  marketPhase,
  isLunchBreak,
  bjDateStr,
  isCacheFresh,
  HOLIDAYS,
};
