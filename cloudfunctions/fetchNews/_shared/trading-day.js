/**
 * 交易日判断（服务端精简版）：复制自 miniprogram/utils/market-time.js。
 * ⚠️ 节假日表须与客户端同步维护：每年国务院办公厅通知发布后，两处一起更新。
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

function bjDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 3600000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function _isWeekday(dateStr) {
  const day = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return day >= 1 && day <= 5;
}

// 表内年份查表（工作日且非节假日），表外年份按工作日兜底：宁可白跑，不可漏发/错发
function isTradingDay(dateStr) {
  if (!dateStr) return false;
  const list = HOLIDAYS[dateStr.slice(0, 4)];
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

module.exports = { bjDateStr, isTradingDay, lastTradingDay, HOLIDAYS };
