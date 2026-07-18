/**
 * 金融计算工具 — 从 miniprogram/utils/calculator.js 直接迁移
 */

export interface NAVPoint {
  date: string;
  nav: number;
  changeRate?: number;
}

export interface DrawdownResult {
  drawdown: number | null;
  peakDate: string | null;
  troughDate: string | null;
  currentDrawdown: number | null;
}

export interface PeriodReturns {
  day: number | null;
  week: number | null;
  month: number | null;
  threeMonth: number | null;
  sixMonth: number | null;
  year: number | null;
  threeYear: number | null;
}

const calculator = {
  /** 选择当前净值：实际已更新用实际值，否则用估算值，都没有用昨日净值 */
  selectNav(yesterdayNav: string | number, actualNav: string | number, estimatedNav: string | number): number {
    const nav = parseFloat(String(yesterdayNav));
    const aNav = parseFloat(String(actualNav));
    const eNav = parseFloat(String(estimatedNav));
    if (!isNaN(aNav) && aNav !== nav) return aNav;
    if (!isNaN(eNav)) return eNav;
    return !isNaN(aNav) ? aNav : nav;
  },

  /** 选择当前涨跌幅 */
  selectChangeRate(
    yesterdayNav: string | number,
    actualNav: string | number,
    estimatedChangeRate: string | number | null,
    actualChangeRate: string | number | null,
  ): number {
    const nav = parseFloat(String(yesterdayNav));
    const aNav = parseFloat(String(actualNav));
    if (!isNaN(aNav) && aNav !== nav) return parseFloat(String(actualChangeRate)) || 0;
    if (estimatedChangeRate != null) return parseFloat(String(estimatedChangeRate));
    return parseFloat(String(actualChangeRate)) || 0;
  },

  /** 格式化日期为 YYYY-MM-DD */
  formatDate(dateOrTs: Date | number | string): string {
    const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  /** 计算区间收益率 */
  calcPeriodReturns(history: NAVPoint[]): PeriodReturns {
    if (!history || history.length === 0) {
      return { day: null, week: null, month: null, threeMonth: null, sixMonth: null, year: null, threeYear: null };
    }
    const latest = history[0].nav;
    const g = (days: number): number | null => {
      if (history.length <= days) return null;
      const nav = history[days]?.nav;
      if (nav == null || isNaN(nav)) return null;
      return parseFloat((((latest - nav) / nav) * 100).toFixed(2));
    };
    return {
      day: history[0].changeRate || 0,
      week: g(4),
      month: g(19),
      threeMonth: g(64),
      sixMonth: g(129),
      year: g(249),
      threeYear: g(749),
    };
  },

  /** 格式化百分比 */
  formatPercent(value: string | number): string {
    const v = parseFloat(String(value));
    if (isNaN(v)) return '--';
    if (Math.abs(v) < 0.005) return '0.00%';
    return v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
  },

  /** 最大回撤 */
  calcMaxDrawdown(history: NAVPoint[]): DrawdownResult {
    if (!history || history.length < 5) {
      return { drawdown: null, peakDate: null, troughDate: null, currentDrawdown: null };
    }
    let peak = history[history.length - 1].nav;
    let peakDate = history[history.length - 1].date;
    let maxDD = 0;
    let ddPeakDate = peakDate;
    let ddTroughDate = peakDate;

    for (let i = history.length - 2; i >= 0; i--) {
      const nav = history[i].nav;
      if (!nav || nav <= 0) continue;
      if (nav > peak) {
        peak = nav;
        peakDate = history[i].date;
      }
      const dd = ((nav - peak) / peak) * 100;
      if (dd < maxDD) {
        maxDD = dd;
        ddPeakDate = peakDate;
        ddTroughDate = history[i].date;
      }
    }

    const currentDD = history[0].nav > 0 ? ((history[0].nav - peak) / peak) * 100 : null;
    return {
      drawdown: parseFloat(maxDD.toFixed(2)),
      peakDate: ddPeakDate,
      troughDate: ddTroughDate,
      currentDrawdown: currentDD != null ? parseFloat(currentDD.toFixed(2)) : null,
    };
  },

  /** 年化波动率 */
  calcVolatility(history: NAVPoint[]): number | null {
    if (!history || history.length < 20) return null;
    const returns: number[] = [];
    for (let i = 1; i < history.length; i++) {
      if (history[i].nav > 0 && history[i - 1].nav > 0) {
        returns.push((history[i].nav - history[i - 1].nav) / history[i - 1].nav);
      }
    }
    if (returns.length < 10) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    return parseFloat((Math.sqrt(variance) * Math.sqrt(250) * 100).toFixed(2));
  },

  /** 夏普比率（无风险利率 2.5%） */
  calcSharpe(history: NAVPoint[]): number | null {
    if (!history || history.length < 20) return null;
    const volatility = this.calcVolatility(history);
    if (!volatility || volatility === 0) return null;
    const days = Math.min(250, history.length);
    const latest = history[0].nav;
    const past = history[days - 1]?.nav;
    if (!past || past <= 0) return null;
    const annualizedReturn = (Math.pow(latest / past, 250 / days) - 1) * 100;
    const riskFree = 2.5;
    return parseFloat(((annualizedReturn - riskFree) / volatility).toFixed(2));
  },

  /** 滚动回撤序列 */
  calcRunningDrawdown(values: { value: number }[]): number[] {
    if (!values || values.length < 2) return [];
    let peak = values[0].value;
    const result: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i].value;
      if (v > peak) peak = v;
      result.push(parseFloat((((v - peak) / peak) * 100).toFixed(2)));
    }
    return result;
  },
};

export default calculator;
