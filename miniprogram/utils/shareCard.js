/**
 * 收益卡片分享 — Canvas 2D 绘制
 * 生成一张精美的持仓概览卡片，可保存到相册分享到微信群/朋友圈
 */

const CARD_W = 600;
const CARD_H = 840;

function _init(canvas, w, h) {
  const dpr = wx.getSystemInfoSync().pixelRatio;
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
  ctx.fillText('🌿 养基笔记', 40, headY);

  ctx.fillStyle = '#999';
  ctx.font = '16px sans-serif';
  ctx.fillText('数据仅供参考 · 不构成投资建议', 40, headY + 30);

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
  ctx.fillText('微信扫码查看我的持仓', w / 2, qrY + qrSize + 32);

  ctx.fillStyle = '#CCC';
  ctx.font = '12px sans-serif';
  ctx.fillText('投资有风险，本卡片仅为持仓信息展示，不构成投资建议', w / 2, qrY + qrSize + 60);

  // === 底部 ===
  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = '#BBB';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('养基笔记 · 持仓记录', w / 2, h - 14);

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

module.exports = { drawShareCard, CARD_W, CARD_H };
