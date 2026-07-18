/**
 * 收益分享卡片 — Canvas 2D 绘制（从 miniprogram/utils/shareCard.js 迁移）
 * 适配浏览器 standard Canvas API
 */

const CARD_W = 600;
const CARD_H = 840;

let cachedTheme = 'red';

export function setShareCardTheme(theme: string) {
  cachedTheme = theme;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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

export interface ShareCardOpts {
  todayProfit?: string;
  todayProfitRate?: string;
  totalAmount?: string;
  totalReturn?: string;
  totalReturnRate?: string;
  fundCount?: number;
  amountVisible?: boolean;
  qrcodeSrc?: string;
}

export function drawShareCard(canvas: HTMLCanvasElement, opts: ShareCardOpts = {}): Promise<{ w: number; h: number }> {
  const w = CARD_W;
  const h = CARD_H;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const theme = cachedTheme;

  // 背景
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  // 顶部渐变装饰条
  const topGrad = ctx.createLinearGradient(0, 0, w, 0);
  topGrad.addColorStop(0, theme === 'red' ? '#E4393C' : '#1976D2');
  topGrad.addColorStop(1, theme === 'red' ? '#FF6B6B' : '#42A5F5');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, w, 6);

  // 头部品牌
  const headY = 40;
  ctx.fillStyle = '#1A1A1A';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('🌿 韭菜养基宝', 40, headY);
  ctx.fillStyle = '#999';
  ctx.font = '16px sans-serif';
  ctx.fillText('涨跌有数 · 心中有底', 40, headY + 30);

  // 分隔线
  ctx.strokeStyle = '#F0F0F0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, headY + 56);
  ctx.lineTo(w - 40, headY + 56);
  ctx.stroke();

  // 收益区
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

  const rateText = (parseFloat(todayRate) >= 0 ? '+' : '') + todayRate + '%';
  ctx.fillStyle = profitColor;
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText(rateText, w / 2, profitY + 48);

  const profitText = amountVisible ? ((isUp ? '+' : '') + '¥' + todayProfit) : '****';
  ctx.fillStyle = amountVisible ? profitColor : '#CCC';
  ctx.font = '20px sans-serif';
  ctx.fillText(profitText, w / 2, profitY + 82);

  // 概览区
  const overviewY = profitY + 150;
  ctx.strokeStyle = '#F0F0F0';
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

  function drawOvRow(y: number, label: string, value: string, valueColor?: string) {
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

  drawOvRow(ov, '持仓市值', amountVisible ? '¥' + totalAmount : '****');
  drawOvRow(
    ov + 38,
    '累计收益',
    amountVisible
      ? (returnIsUp ? '+' : '') + '¥' + totalReturn + '  (' + (returnIsUp ? '+' : '') + totalReturnRate + '%)'
      : '****',
    amountVisible ? retColor : undefined,
  );
  drawOvRow(ov + 76, '持有基金', fundCount + ' 只');

  ctx.strokeStyle = '#F0F0F0';
  ctx.beginPath();
  ctx.moveTo(40, ov + 110);
  ctx.lineTo(w - 40, ov + 110);
  ctx.stroke();

  // 二维码区
  const qrY = ov + 140;
  const qrSize = 140;
  const qrX = w / 2 - qrSize / 2;

  ctx.fillStyle = '#999';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('微信扫码查看我的持仓', w / 2, qrY + qrSize + 32);

  ctx.fillStyle = '#CCC';
  ctx.font = '12px sans-serif';
  ctx.fillText('投资有风险，本卡片仅为持仓信息展示，不构成投资建议', w / 2, qrY + qrSize + 60);

  // 底部
  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = '#BBB';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('韭菜养基宝 · 涨跌有数', w / 2, h - 14);

  // 二维码图片加载
  return new Promise((resolve) => {
    const qrcodeSrc = opts.qrcodeSrc || '/images/qrcode.jpg';
    const img = new Image();
    img.onload = () => {
      ctx.save();
      roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.clip();
      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      ctx.restore();
      resolve({ w, h });
    };
    img.onerror = () => {
      ctx.fillStyle = '#F8F8F8';
      ctx.strokeStyle = '#E0E0E0';
      ctx.lineWidth = 1.5;
      roundRect(ctx, qrX, qrY, qrSize, qrSize, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#CCC';
      ctx.font = '14px sans-serif';
      ctx.fillText('小程序码', w / 2, qrY + qrSize / 2);
      resolve({ w, h });
    };
    img.src = qrcodeSrc;
  });
}

/** 将 Canvas 转为 Blob（用于浏览器下载/分享） */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

export { CARD_W, CARD_H };
