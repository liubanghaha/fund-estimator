/**
 * 收益卡片分享 — Canvas 2D 绘制
 * 生成一张精美的持仓概览卡片，可保存到相册分享到微信群/朋友圈
 */

const CARD_W = 600;
const CARD_H = 880;

function _init(canvas, w, h) {
  const dpr = wx.getWindowInfo().pixelRatio;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * 绘制分享卡片
 * @param {Object} canvas - Canvas 2D 节点
 * @param {Object} opts
 * @param {String} opts.todayProfit  - 今日估算收益
 * @param {String} opts.todayProfitRate - 今日收益率
 * @param {String} opts.totalAmount  - 持仓总市值
 * @param {String} opts.totalReturn  - 累计收益
 * @param {String} opts.totalReturnRate - 累计收益率
 * @param {Number} opts.fundCount    - 持有基金数量
 * @returns {Promise} - resolves when drawing complete (including QR code image)
 */
function drawShareCard(canvas, opts = {}) {
  const w = CARD_W, h = CARD_H;
  const ctx = _init(canvas, w, h);
  const theme = (typeof wx !== 'undefined') ? (wx.getStorageSync('theme') || 'red') : 'red';

  // === 背景 ===
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  // 顶部渐变装饰条
  const topGrad = ctx.createLinearGradient(0, 0, w, 0);
  topGrad.addColorStop(0, theme === 'red' ? '#E4393C' : '#1976D2');
  topGrad.addColorStop(1, theme === 'red' ? '#FF6B6B' : '#42A5F5');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, w, 6);

  // === 头部：品牌 ===
  const headY = 40;
  ctx.fillStyle = '#1A1A1A';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('🌿 韭菜估值宝', 40, headY);

  ctx.fillStyle = '#999';
  ctx.font = '16px sans-serif';
  ctx.fillText('估值有数 · 心中有底', 40, headY + 30);

  // 分隔线
  ctx.strokeStyle = '#F0F0F0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, headY + 56);
  ctx.lineTo(w - 40, headY + 56);
  ctx.stroke();

  // === 收益区 ===
  const profitY = headY + 100;
  const todayProfit = opts.todayProfit || '0.00';
  const todayRate = opts.todayProfitRate || '0.00';
  const amountVisible = opts.amountVisible !== false;
  const isUp = parseFloat(todayProfit) >= 0;
  const profitColor = isUp ? '#E4393C' : '#2E8B57';

  ctx.fillStyle = '#666';
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('今日估算收益', w / 2, profitY);

  // 收益率（大号，主视觉）
  const rateText = (parseFloat(todayRate) >= 0 ? '+' : '') + todayRate + '%';
  ctx.fillStyle = profitColor;
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(rateText, w / 2, profitY + 48);

  // 金额（小号，在收益率下方）
  const profitText = amountVisible ? ((isUp ? '+' : '') + '¥' + todayProfit) : '****';
  ctx.fillStyle = amountVisible ? profitColor : '#CCC';
  ctx.font = '20px sans-serif';
  ctx.fillText(profitText, w / 2, profitY + 82);

  // === 概览区 ===
  const overviewY = profitY + 150;
  ctx.strokeStyle = '#F0F0F0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, overviewY - 10);
  ctx.lineTo(w - 40, overviewY - 10);
  ctx.stroke();

  const ovLeft = 60;
  const ovValX = w - 60;

  ctx.fillStyle = '#999';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('持仓概览', ovLeft, overviewY + 20);

  const ov = overviewY + 50;

  function drawOvRow(y, label, value, valueColor) {
    ctx.fillStyle = '#666';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, ovLeft, y);
    ctx.fillStyle = valueColor || '#1A1A1A';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(value, ovValX, y);
  }

  const totalAmount = opts.totalAmount || '0.00';
  const totalReturn = opts.totalReturn || '0.00';
  const totalReturnRate = opts.totalReturnRate || '0.00';
  const fundCount = opts.fundCount || 0;
  const returnIsUp = parseFloat(totalReturn) >= 0;
  const retColor = returnIsUp ? '#E4393C' : '#2E8B57';

  drawOvRow(ov, '持仓市值', amountVisible ? '¥' + totalAmount : '****', '#1A1A1A');
  drawOvRow(ov + 38, '累计收益', amountVisible
    ? (returnIsUp ? '+' : '') + '¥' + totalReturn + '  (' + (returnIsUp ? '+' : '') + totalReturnRate + '%)'
    : '****', amountVisible ? retColor : '#1A1A1A');
  drawOvRow(ov + 76, '持有基金', fundCount + ' 只', '#1A1A1A');

  // 分隔线
  ctx.strokeStyle = '#F0F0F0';
  ctx.beginPath();
  ctx.moveTo(40, ov + 110);
  ctx.lineTo(w - 40, ov + 110);
  ctx.stroke();

  // === 二维码区 ===
  const qrY = ov + 140;
  const qrSize = 140;
  const qrX = w / 2 - qrSize / 2;

  // 引导文字 + 免责
  ctx.fillStyle = '#999';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('微信扫码查看持仓今日涨跌', w / 2, qrY + qrSize + 32);

  ctx.fillStyle = '#CCC';
  ctx.font = '12px sans-serif';
  ctx.fillText('投资有风险，本卡片仅为持仓信息展示，不构成投资建议', w / 2, qrY + qrSize + 60);

  // === 底部 ===
  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = '#BBB';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('韭菜估值宝 · 估值有数', w / 2, h - 14);

  // === 加载并绘制二维码 ===
  return new Promise((resolve) => {
    const qrcodePath = opts.qrcodePath || '/images/qrcode.jpg';
    const img = canvas.createImage();
    img.onload = () => {
      // 圆角裁剪
      ctx.save();
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.clip();
      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      ctx.restore();
      resolve({ w, h });
    };
    img.onerror = () => {
      // 加载失败，画占位框
      ctx.fillStyle = '#F8F8F8';
      ctx.strokeStyle = '#E0E0E0';
      ctx.lineWidth = 1.5;
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#CCC';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('小程序码', w / 2, qrY + qrSize / 2);
      resolve({ w, h });
    };
    img.src = qrcodePath;
  });
}

/**
 * 绘制事件驱动温度卡（温度极值日自动切换的公共数据卡，产品规划"传播线"）
 * 纯数据陈述：只有温度分布数字，不含任何建议语义
 * @param {Object} opts - { date, low, mid, high, total }
 */
function drawEventCard(canvas, opts = {}) {
  const w = CARD_W, h = CARD_H;
  const ctx = _init(canvas, w, h);
  const theme = (typeof wx !== 'undefined') ? (wx.getStorageSync('theme') || 'red') : 'red';

  const { low = 0, mid = 0, high = 0, total = 0 } = opts;
  const pct = (n) => (total > 0 ? Math.round(n / total * 100) : 0);
  const highPct = pct(high), lowPct = pct(low);
  // 极值侧定主色：偏高红 / 偏低绿
  const extremeHigh = highPct >= lowPct;
  const mainColor = extremeHigh ? '#E4393C' : '#2E8B57';
  const extremePct = extremeHigh ? highPct : lowPct;
  const extremeText = extremeHigh ? '偏股基金温度偏高' : '偏股基金温度偏低';

  // === 背景与装饰 ===
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  const topGrad = ctx.createLinearGradient(0, 0, w, 0);
  topGrad.addColorStop(0, theme === 'red' ? '#E4393C' : '#1976D2');
  topGrad.addColorStop(1, theme === 'red' ? '#FF6B6B' : '#42A5F5');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, w, 6);

  // === 头部 ===
  ctx.fillStyle = '#1A1A1A';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('🌿 韭菜估值宝', 40, 40);
  ctx.fillStyle = '#999';
  ctx.font = '16px sans-serif';
  ctx.fillText('估值有数 · 心中有底', 40, 70);
  ctx.strokeStyle = '#F0F0F0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 96);
  ctx.lineTo(w - 40, 96);
  ctx.stroke();

  // === 主视觉：极值占比 ===
  ctx.fillStyle = '#666';
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('今日市场温度分布', w / 2, 150);

  ctx.fillStyle = mainColor;
  ctx.font = 'bold 110px sans-serif';
  ctx.fillText(extremePct + '%', w / 2, 268);

  ctx.fillStyle = '#333';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(extremeText, w / 2, 310);

  // === 分布条：偏低 / 适中 / 偏高 三段 ===
  const barY = 360, barH = 36, barW = w - 120;
  const wLow = total ? low / total * barW : 0;
  const wMid = total ? mid / total * barW : 0;
  const wHigh = total ? high / total * barW : 0;
  let x = 60;
  ctx.fillStyle = '#2E8B57';
  ctx.fillRect(x, barY, wLow, barH);
  x += wLow;
  ctx.fillStyle = '#D8D8D8';
  ctx.fillRect(x, barY, wMid, barH);
  x += wMid;
  ctx.fillStyle = '#E4393C';
  ctx.fillRect(x, barY, wHigh, barH);

  // 三段数值标签
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#2E8B57';
  ctx.fillText('偏低 ' + lowPct + '%', 60, barY + 70);
  ctx.fillStyle = '#888';
  ctx.textAlign = 'center';
  ctx.fillText('适中 ' + pct(mid) + '%', w / 2, barY + 70);
  ctx.fillStyle = '#E4393C';
  ctx.textAlign = 'right';
  ctx.fillText('偏高 ' + highPct + '%', w - 60, barY + 70);

  // === 说明区 ===
  ctx.fillStyle = '#BBB';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(opts.date + ' · 覆盖 ' + total + ' 只偏股基金', w / 2, barY + 110);
  ctx.fillText('温度为历史分位统计，不代表未来收益', w / 2, barY + 134);

  // === 二维码区 ===
  const qrY = barY + 170;
  const qrSize = 140;
  const qrX = w / 2 - qrSize / 2;
  ctx.fillStyle = '#999';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('微信扫码查看你持有基金的温度', w / 2, qrY + qrSize + 32);

  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = '#BBB';
  ctx.font = '12px sans-serif';
  ctx.fillText('韭菜估值宝 · 估值有数', w / 2, h - 14);

  return new Promise((resolve) => {
    const qrcodePath = opts.qrcodePath || '/images/qrcode.jpg';
    const img = canvas.createImage();
    img.onload = () => {
      ctx.save();
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.clip();
      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      ctx.restore();
      resolve({ w, h });
    };
    img.onerror = () => {
      ctx.fillStyle = '#F8F8F8';
      ctx.strokeStyle = '#E0E0E0';
      ctx.lineWidth = 1.5;
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#CCC';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('小程序码', w / 2, qrY + qrSize / 2);
      resolve({ w, h });
    };
    img.src = qrcodePath;
  });
}

/**
 * 绘制周签（每周五收盘后/周末可生成，产品规划 NEXT：年度报告的工艺热身）
 * 纯数据陈述：本周收益 vs 沪深300、操作笔数、覆盖信息
 * @param {Object} opts - { rangeText, weekProfit, weekProfitRate, hsRate, opText, fundCount, earliestDate }
 */
function drawWeeklyCard(canvas, opts = {}) {
  const w = CARD_W, h = CARD_H;
  const ctx = _init(canvas, w, h);
  const theme = (typeof wx !== 'undefined') ? (wx.getStorageSync('theme') || 'red') : 'red';

  const weekRate = parseFloat(opts.weekProfitRate) || 0;
  const weekProfit = parseFloat(opts.weekProfit) || 0;
  const isUp = weekRate >= 0;
  const mainColor = isUp ? '#E4393C' : '#2E8B57';
  const amountVisible = opts.amountVisible !== false;

  // === 背景 / 装饰 / 头部（与收益卡同款） ===
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  const topGrad = ctx.createLinearGradient(0, 0, w, 0);
  topGrad.addColorStop(0, theme === 'red' ? '#E4393C' : '#1976D2');
  topGrad.addColorStop(1, theme === 'red' ? '#FF6B6B' : '#42A5F5');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, w, 6);
  ctx.fillStyle = '#1A1A1A';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('🌿 韭菜估值宝', 40, 40);
  ctx.fillStyle = '#999';
  ctx.font = '16px sans-serif';
  ctx.fillText('估值有数 · 心中有底', 40, 70);
  ctx.strokeStyle = '#F0F0F0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 96);
  ctx.lineTo(w - 40, 96);
  ctx.stroke();

  // === 主视觉 ===
  const cardTitle = opts.title || '本周收益';
  ctx.fillStyle = '#666';
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(cardTitle + ' · ' + (opts.rangeText || ''), w / 2, 150);

  ctx.fillStyle = mainColor;
  ctx.font = 'bold 96px sans-serif';
  ctx.fillText((isUp ? '+' : '') + weekRate + '%', w / 2, 264);

  ctx.fillStyle = amountVisible ? mainColor : '#CCC';
  ctx.font = '22px sans-serif';
  ctx.fillText(amountVisible ? ((weekProfit > 0 ? '+' : '') + '¥' + weekProfit) : '****', w / 2, 300);

  // === 沪深300 对比 ===
  const cmpY = 370;
  ctx.strokeStyle = '#F0F0F0';
  ctx.beginPath();
  ctx.moveTo(40, cmpY - 10);
  ctx.lineTo(w - 40, cmpY - 10);
  ctx.stroke();
  if (opts.hsRate != null) {
    const diff = +(weekRate - opts.hsRate).toFixed(2);
    const diffText = diff >= 0 ? '跑赢沪深300 ' + diff + ' 个百分点' : '跑输沪深300 ' + Math.abs(diff) + ' 个百分点';
    ctx.fillStyle = '#666';
    ctx.font = '18px sans-serif';
    ctx.fillText(diffText, w / 2, cmpY + 26);
  } else {
    ctx.fillStyle = '#BBB';
    ctx.font = '18px sans-serif';
    ctx.fillText('本周沪深300：--', w / 2, cmpY + 26);
  }

  // === 信息行 ===
  const infoY = cmpY + 76;
  const drawInfo = (y, label, value) => {
    ctx.fillStyle = '#999';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, w / 2 - 70, y);
    ctx.fillStyle = '#1A1A1A';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(value, w / 2 + 70, y);
  };
  drawInfo(infoY, '持有基金', (opts.fundCount || 0) + ' 只');
  drawInfo(infoY + 34, opts.opLabel || '本周操作', opts.opText || '0 笔');
  if (opts.earliestDate) drawInfo(infoY + 68, '收益自', opts.earliestDate + ' 起计');

  // === 分隔 + 二维码 ===
  const qrY = infoY + 120;
  const qrSize = 140;
  const qrX = w / 2 - qrSize / 2;
  ctx.fillStyle = '#999';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('微信扫码查看你的收益走势', w / 2, qrY + qrSize + 32);
  ctx.fillStyle = '#CCC';
  ctx.font = '12px sans-serif';
  ctx.fillText('纯数据陈述，不构成投资建议', w / 2, qrY + qrSize + 60);

  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = '#BBB';
  ctx.font = '12px sans-serif';
  ctx.fillText('韭菜估值宝 · 估值有数', w / 2, h - 14);

  return new Promise((resolve) => {
    const qrcodePath = opts.qrcodePath || '/images/qrcode.jpg';
    const img = canvas.createImage();
    img.onload = () => {
      ctx.save();
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.clip();
      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      ctx.restore();
      resolve({ w, h });
    };
    img.onerror = () => {
      ctx.fillStyle = '#F8F8F8';
      ctx.strokeStyle = '#E0E0E0';
      ctx.lineWidth = 1.5;
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#CCC';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('小程序码', w / 2, qrY + qrSize / 2);
      resolve({ w, h });
    };
    img.src = qrcodePath;
  });
}

/**
 * 年度持仓报告长卡（产品规划 P1-4 前置 MVP）：全年收益 + 月度柱状 + 回撤/操作/费用/影子
 * 合规：标题与文案无"投资"字样；收益为名义口径，注明"历史演算不代表未来"
 * @param {Object} opts - { year, yearProfit, yearRate, hsRate, months:[{label,profit}], maxDD, opText, fundCount, feeText, shadowText, earliest, amountVisible }
 */
function drawAnnualCard(canvas, opts = {}) {
  const w = CARD_W, h = 1560;
  const ctx = _init(canvas, w, h);
  const theme = (typeof wx !== 'undefined') ? (wx.getStorageSync('theme') || 'red') : 'red';
  const amountVisible = opts.amountVisible !== false;
  const year = opts.year || 2026;
  const isUp = (opts.yearRate || 0) >= 0;
  const mainColor = isUp ? '#E4393C' : '#2E8B57';

  // 背景与头部
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  const topGrad = ctx.createLinearGradient(0, 0, w, 0);
  topGrad.addColorStop(0, theme === 'red' ? '#E4393C' : '#1976D2');
  topGrad.addColorStop(1, theme === 'red' ? '#FF6B6B' : '#42A5F5');
  ctx.fillRect(0, 0, w, 120);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('🌿 韭菜估值宝', 40, 52);
  ctx.font = '18px sans-serif';
  ctx.fillText('估值有数 · 心中有底', 40, 84);
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(year + ' 年度持仓报告', w - 40, 72);

  // 全年收益大字
  ctx.fillStyle = '#666';
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('全年收益（名义口径）', w / 2, 190);
  ctx.fillStyle = mainColor;
  ctx.font = 'bold 96px sans-serif';
  ctx.fillText((isUp ? '+' : '') + (opts.yearRate != null ? opts.yearRate : '--') + '%', w / 2, 300);
  ctx.font = '22px sans-serif';
  ctx.fillText(amountVisible ? ((opts.yearProfit > 0 ? '+' : '') + '¥' + (opts.yearProfit != null ? opts.yearProfit : '--')) : '¥****', w / 2, 340);

  // vs 沪深300
  if (opts.hsRate != null) {
    const diff = +((opts.yearRate || 0) - opts.hsRate).toFixed(2);
    ctx.fillStyle = '#666';
    ctx.font = '18px sans-serif';
    ctx.fillText('沪深300 同期 ' + (opts.hsRate > 0 ? '+' : '') + opts.hsRate + '%' + (diff !== 0 ? ' · ' + (diff >= 0 ? '跑赢 ' : '跑输 ') + Math.abs(diff) + ' 个百分点' : ' · 持平'), w / 2, 378);
  }

  // 月度收益柱状图
  const chartTop = 430, chartH = 380, chartBottom = chartTop + chartH;
  const months = opts.months || [];
  ctx.fillStyle = '#999';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('月度盈亏（元）', 40, chartTop - 16);
  if (months.length) {
    const vals = months.map(m => m.profit);
    const maxV = Math.max(...vals, 0), minV = Math.min(...vals, 0);
    const range = (maxV - minV) || 1;
    const zeroY = chartTop + (maxV / range) * chartH;
    ctx.strokeStyle = '#E5E5E5';
    ctx.beginPath(); ctx.moveTo(50, zeroY); ctx.lineTo(w - 50, zeroY); ctx.stroke();
    const bw = (w - 120) / months.length;
    months.forEach((m, i) => {
      const bh = Math.abs(m.profit) / range * chartH;
      const bx = 60 + i * bw + bw * 0.18;
      ctx.fillStyle = m.profit >= 0 ? '#E4393C' : '#2E8B57';
      if (m.profit >= 0) ctx.fillRect(bx, zeroY - bh, bw * 0.64, bh);
      else ctx.fillRect(bx, zeroY, bw * 0.64, bh);
      ctx.fillStyle = '#999';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(m.label, bx + bw * 0.32, chartBottom + 24);
    });
  }

  // 数字网格
  let gridY = chartBottom + 70;
  ctx.strokeStyle = '#F0F0F0';
  ctx.beginPath(); ctx.moveTo(40, gridY - 30); ctx.lineTo(w - 40, gridY - 30); ctx.stroke();
  const drawGridRow = (y, label, value) => {
    ctx.fillStyle = '#999'; ctx.font = '16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(label, 60, y);
    ctx.fillStyle = '#1A1A1A'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(value, w - 60, y);
  };
  drawGridRow(gridY, '最大回撤（年内）', opts.maxDD != null ? '-' + opts.maxDD + ' 元' : '--');
  drawGridRow(gridY + 38, '全年操作', opts.opText || '0 笔');
  drawGridRow(gridY + 76, '持有基金', (opts.fundCount || 0) + ' 只');
  drawGridRow(gridY + 114, '收益起点', opts.earliest || '--');
  gridY += 150;

  // 费用 / 影子（有数据才显示）
  if (opts.feeText) {
    ctx.fillStyle = '#666'; ctx.font = '16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('💸 持有费用', 60, gridY);
    ctx.fillStyle = '#1A1A1A'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(opts.feeText, w - 60, gridY);
    gridY += 36;
  }
  if (opts.shadowText) {
    ctx.fillStyle = '#666'; ctx.font = '16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('🔄 影子账户', 60, gridY);
    ctx.fillStyle = '#1A1A1A'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(opts.shadowText, w - 60, gridY);
    gridY += 36;
  }

  // 二维码区
  const qrY = gridY + 20;
  const qrSize = 140;
  const qrX = w / 2 - qrSize / 2;
  ctx.fillStyle = '#999';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('微信扫码生成你的年度报告', w / 2, qrY + qrSize + 32);
  ctx.fillStyle = '#CCC';
  ctx.font = '12px sans-serif';
  ctx.fillText('收益为名义口径的历史演算，不构成投资建议', w / 2, qrY + qrSize + 60);

  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = '#BBB';
  ctx.font = '12px sans-serif';
  ctx.fillText('韭菜估值宝 · 估值有数', w / 2, h - 14);

  return new Promise((resolve) => {
    const qrcodePath = opts.qrcodePath || '/images/qrcode.jpg';
    const img = canvas.createImage();
    img.onload = () => {
      ctx.save();
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.clip();
      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      ctx.restore();
      resolve({ w, h });
    };
    img.onerror = () => {
      ctx.fillStyle = '#F8F8F8';
      ctx.strokeStyle = '#E0E0E0';
      ctx.lineWidth = 1.5;
      _roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#CCC';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('小程序码', w / 2, qrY + qrSize / 2);
      resolve({ w, h });
    };
    img.src = qrcodePath;
  });
}

module.exports = { drawShareCard, drawEventCard, drawWeeklyCard, drawAnnualCard, CARD_W, CARD_H };
