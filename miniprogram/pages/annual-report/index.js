const api = require("../../utils/api");
const calc = require("../../utils/calculator");
const track = require("../../utils/track");
const shareCard = require("../../utils/shareCard");

// 2026 年度持仓报告（产品规划 P1-4 前置 MVP）：全年收益/月度盈亏/回撤/操作/费用/影子
// 数据全部客户端聚合：getPortfolio(260) 的 navHistoryMap 口径同收益页
Page({
  data: {
    theme: "red",
    loading: true,
    loadError: false,
    rendering: false,
    amountVisible: true,
    year: 2026,
    saved: false,
  },

  onLoad(options) {
    // 年度报告每年 1/1 放开，展示"刚结束的那一年"（年度账单式节奏）：
    // 默认 reportYear = 当前年 - 1（2027-01-01 首次放开 → 展示 2026 年度报告）
    const bjYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear();
    const year = parseInt(options && options.year, 10) || (bjYear - 1);
    this.setData({ theme: wx.getStorageSync("theme") || "red", year });
    try { this.setData({ amountVisible: wx.getStorageSync("amountVisible") !== false }); } catch (e) { /* ignore */ }
    track.track("annual_report_open", { year });
    this._load(year);
  },
  onShareAppMessage() {
    track.share({ sharePage: "annual_report" });
    return { title: "我的" + this.data.year + " 年度持仓报告", path: "/pages/annual-report/index" };
  },
  noop() {},

  _load(year) {
    const yearStart = new Date(year, 0, 1);
    const now = new Date(Date.now() + 8 * 3600000);
    const calendarDays = Math.ceil((now - yearStart) / 86400000);
    // 上限 800（服务端钳制值）：报告年可能是"往年"，查看时点在次年甚至更晚，
    // 260 交易日只够覆盖近期约 12 个月，会漏掉往年年初的数据
    const historyDays = Math.min(800, Math.ceil(calendarDays * 5 / 7) + 10);
    Promise.all([
      api.getPortfolio(historyDays),
      api.transactionList().catch(() => ({ result: { code: 0, data: [] } })),
      api.feeSummary().catch(() => null),
      api.transactionShadow().catch(() => null),
    ]).then(([pfRes, txRes, feeRes, shadowRes]) => {
      try {
        if (!pfRes.result || pfRes.result.code !== 0) throw new Error("load");
        const d = pfRes.result.data;
        const hs = d.holdings || [];
        if (!hs.length) throw new Error("empty");
        const navMap = d.navHistoryMap || {};
        const yStr = String(year);

        // 全年日收益 dc 与每日市值 dm（口径同收益页）
        const dc = {}, dm = {};
        hs.forEach(h => {
          let shares = parseFloat(h.shares || h.amount || 0);
          if (!shares && h.marketValue) { const cn = h.currentNav || h.buyPrice; if (cn > 0) shares = parseFloat(h.marketValue) / cn; }
          if (!shares) return;
          const hist = [...(navMap[h.fundCode] || [])].reverse();
          if (hist.length < 2) return;
          const sd = h.createTime ? calc.formatDate(h.createTime) : null;
          for (let i = 1; i < hist.length; i++) {
            if (sd && hist[i].date < sd) continue;
            const chg = (hist[i].nav - hist[i - 1].nav) * shares;
            if (hist[i].date.startsWith(yStr)) {
              dc[hist[i].date] = +((dc[hist[i].date] || 0) + chg).toFixed(2);
            }
            if (!dm[hist[i].date]) dm[hist[i].date] = 0;
            dm[hist[i].date] += hist[i].nav * shares;
          }
        });
        const dates = Object.keys(dm).filter(k => k.startsWith(yStr)).sort();
        if (dates.length < 5) throw new Error("empty");

        // 月度盈亏（金额口径，同盈亏日历）
        const months = [];
        for (let m = 1; m <= 12; m++) {
          const pfx = yStr + "-" + String(m).padStart(2, "0");
          let s = 0, has = false;
          for (const [dt, chg] of Object.entries(dc)) { if (dt.startsWith(pfx)) { s += chg; has = true; } }
          if (has) months.push({ label: m + "月", profit: +s.toFixed(2) });
        }

        // 累计曲线 + 年内最大回撤（金额口径）
        let cum = 0, peak = 0, maxDD = 0;
        const curve = dates.map(dt => {
          cum += dc[dt] || 0;
          if (cum > peak) peak = cum;
          const dd = peak - cum;
          if (dd > maxDD) maxDD = dd;
          return { date: dt.slice(5), value: +cum.toFixed(2) };
        });
        const yearProfit = +cum.toFixed(2);
        const startMv = (dm[dates[0]] || 0) - (dc[dates[0]] || 0);
        // 收益率与金额同口径：纯净值变动收益 / 年初市值。
        // 不可用"期末市值/年初市值"——年内加减仓的资金流会把市值增长率推得与收益金额严重背离
        const yearRate = startMv > 0 ? +((yearProfit / startMv) * 100).toFixed(2) : null;

        // 沪深300 同期（年初前最后收盘 → 最新）
        const fetchHs = api.fetchMarketIndexClient("000300", historyDays).catch(() => null);
        return fetchHs.then((idxRes) => {
          const rows = (idxRes && idxRes.result && idxRes.result.code === 0 && idxRes.result.data) || [];
          const inYear = rows.filter(r => r.date >= yStr + "-01-01");
          const prev = rows.filter(r => r.date < yStr + "-01-01").pop();
          const base = prev || inYear[0];
          const hsRate = (base && inYear.length && base.close > 0)
            ? +((inYear[inYear.length - 1].close / base.close - 1) * 100).toFixed(2) : null;
          const txs = (txRes.result && txRes.result.code === 0 && txRes.result.data) || [];
          const yearTxs = txs.filter(t => t.date && t.date.startsWith(yStr));
          const buys = yearTxs.filter(t => t.type === "buy").length;
          const fee = feeRes && feeRes.result && feeRes.result.code === 0 && feeRes.result.data;
          const shadow = shadowRes && shadowRes.result && shadowRes.result.code === 0 && shadowRes.result.data;
          this._report = {
            year, months, curve,
            yearProfit, yearRate, hsRate,
            maxDD: +maxDD.toFixed(0),
            opText: `全年操作 ${yearTxs.length} 笔（加仓 ${buys} / 减仓 ${yearTxs.length - buys}）`,
            fundCount: hs.length,
            feeText: fee && fee.hasData ? `年费约 ${fee.annualFee} 元（综合费率 ${fee.totalRate}%）` : "",
            shadowText: shadow && shadow.hasData && shadow.total != null ? (shadow.total >= 0 ? "+" : "") + shadow.total + " 元" : "",
            earliest: dates[0].slice(5),
          };
          this.setData({ loading: false }, () => {
            wx.nextTick(() => this._render());
          });
        });
      } catch (e) {
        this.setData({ loading: false, loadError: e.message === "empty" });
      }
    }).catch(() => this.setData({ loading: false, loadError: true }));
  },

  _render() {
    const query = wx.createSelectorQuery();
    query.select("#annualCanvas").fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      this._canvas = res[0].node;
      shareCard.drawAnnualCard(res[0].node, { ...this._report, amountVisible: this.data.amountVisible })
        .then(() => this.setData({ rendering: false }))
        .catch(() => this.setData({ rendering: false }));
    });
  },
  onSave() {
    if (!this._canvas) return;
    wx.canvasToTempFilePath({
      canvas: this._canvas,
      success: (res) => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => wx.showToast({ title: "已保存到相册", icon: "success" }),
          fail: () => wx.showToast({ title: "保存失败，请授权相册权限", icon: "none" }),
        });
      },
      fail: () => wx.showToast({ title: "生成图片失败", icon: "none" }),
    });
  },
  noop() {},
});
