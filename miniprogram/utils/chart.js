
const _getChartColors = () => {
  const t = (typeof wx !== 'undefined') ? (wx.getStorageSync('theme') || 'blue') : 'blue';
  return t === 'red' ? { primary: '#E4393C', secondary: '#1976D2', red: '#E4393C', green: '#2E8B57', up: '#E4393C', down: '#2E8B57' }
    : { primary: '#1976D2', secondary: '#E4393C', red: '#E4393C', green: '#2E8B57', up: '#E4393C', down: '#2E8B57' };
};
/**
 * 共享折线图绘制工具。基于 Canvas 2D API。
 */

const chart = {
  _init(canvas, w, h) {
    const dpr = wx.getSystemInfoSync().pixelRatio;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return ctx;
  },

  drawLineChart(canvas, opts = {}) {
    const { w = 340, h = 200, data = [], xField = 'date', yField = 'value',
      color = '#1976D2', padding, isReturn = false } = opts;
    const p = padding || { top: 24, right: 24, bottom: 30, left: 52 };
    const pw = w - p.left - p.right, ph = h - p.top - p.bottom;

    const vals = data.map(d => d[yField]);
    if (vals.length < 2) return null;
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min > 0) min = 0;
    if (max < 0) max = 0;
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;

    const xp = (i) => p.left + (pw / (data.length - 1)) * i;
    const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    const ctx = this._init(canvas, w, h);

    ctx.fillStyle = '#FFF';
    ctx.fillRect(0, 0, w, h);

    // 渐变填充
    const isUp = vals[vals.length - 1] >= vals[0];
    const fillColor = isUp ? 'rgba(228,57,60,0.10)' : 'rgba(46,139,87,0.10)';
    const gradient = ctx.createLinearGradient(0, p.top, 0, h - p.bottom);
    gradient.addColorStop(0, fillColor);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    data.forEach((d, i) => { const x = xp(i), y = yp(d[yField]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.lineTo(xp(data.length - 1), h - p.bottom);
    ctx.lineTo(xp(0), h - p.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 折线
    ctx.beginPath();
    data.forEach((d, i) => { const x = xp(i), y = yp(d[yField]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Y 轴
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const suffix = isReturn ? '%' : '';
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(isReturn ? 1 : 2) + suffix, p.left - 6, yp(val));
    }

    // X 轴
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    const labelSteps = Math.min(data.length <= 120 ? 5 : 6, data.length);
    for (let i = 0; i < labelSteps; i++) {
      const idx = Math.round((i / (labelSteps - 1)) * (data.length - 1));
      const label = this._formatXLabel(data[idx][xField], data);
      ctx.textAlign = i === 0 ? 'left' : i === labelSteps - 1 ? 'right' : 'center';
      ctx.fillText(label, xp(idx), h - p.bottom + 8);
    }

    this._lastDraw = { data, xp, yp, yField, xField, w, h, p, yMin, yMax, vals, isReturn };
    return ctx;
  },

  drawDualLineChart(canvas, opts = {}) {
    const { w = 340, h = 200, data = [], fieldA = 'rateA', fieldB = 'rateB',
      colorA = '#E4393C', colorB = '#1976D2',
      labelA = '', labelB = '', padding } = opts;
    const p = padding || { top: 36, right: 12, bottom: 36, left: 52 };
    const pw = w - p.left - p.right, ph = h - p.top - p.bottom;

    const valsA = data.map(d => d[fieldA]).filter(v => v != null);
    const valsB = data.map(d => d[fieldB]).filter(v => v != null);
    const allVals = [...valsA, ...valsB];
    if (allVals.length === 0) return null;
    let min = Math.min(...allVals), max = Math.max(...allVals);
    if (min > 0) min = 0;
    if (max < 0) max = 0;
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;

    const xp = (i) => p.left + (pw / (data.length - 1)) * i;
    const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    const ctx = this._init(canvas, w, h);

    ctx.fillStyle = '#FFF';
    ctx.fillRect(0, 0, w, h);

    // 面积填充
    [fieldA, fieldB].forEach((field, idx) => {
      const color = idx === 0 ? colorA : colorB;
      const alpha = idx === 0 ? 'rgba(228,57,60,0.05)' : 'rgba(25,118,210,0.05)';
      ctx.beginPath();
      let first = false;
      data.forEach((d, i) => {
        if (d[field] == null) { first = false; return; }
        const x = xp(i), y = yp(d[field]);
        if (!first) { ctx.moveTo(x, y); first = true; } else ctx.lineTo(x, y);
      });
      if (!first) return;
      ctx.lineTo(xp(data.length - 1), yp(0));
      ctx.lineTo(xp(0), yp(0));
      ctx.closePath();
      ctx.fillStyle = alpha;
      ctx.fill();
    });

    // 折线
    [fieldA, fieldB].forEach((field, idx) => {
      const color = idx === 0 ? colorA : colorB;
      ctx.beginPath();
      let first = false;
      data.forEach((d, i) => {
        if (d[field] == null) { first = false; return; }
        const x = xp(i), y = yp(d[field]);
        if (!first) { ctx.moveTo(x, y); first = true; } else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // 图例
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'middle';
    [{ color: colorA, label: labelA, y: 10 }, { color: colorB, label: labelB, y: 22 }].forEach(lg => {
      if (!lg.label) return;
      ctx.fillStyle = lg.color;
      ctx.fillRect(p.left + 4, lg.y - 2, 12, 4);
      ctx.fillStyle = '#666';
      ctx.textAlign = 'left';
      ctx.fillText(lg.label.slice(0, 10), p.left + 20, lg.y);
    });

    // Y轴
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(1) + '%', p.left - 6, yp(val));
    }

    // X轴
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    const dSteps = Math.min(data.length <= 120 ? 5 : 6, data.length);
    for (let i = 0; i < dSteps; i++) {
      const idx = Math.round((i / (dSteps - 1)) * (data.length - 1));
      ctx.textAlign = i === 0 ? 'left' : i === dSteps - 1 ? 'right' : 'center';
      ctx.fillText(this._formatXLabel(data[idx].date, data), xp(idx), h - p.bottom + 8);
    }

    this._lastDualDraw = { data, xp, yp, fieldA, fieldB, w, h, p, yMin, yMax,
      colorA, colorB, labelA, labelB };
    return ctx;
  },

  handleDualTouch(ctx, e, opts = {}) {
    const now = Date.now();
    if (this._dualTouchLastTime && now - this._dualTouchLastTime < 60) return;
    this._dualTouchLastTime = now;

    const d = this._lastDualDraw;
    if (!d || !d.data || d.data.length < 2) return;
    const { data, xp, yp, fieldA, fieldB, w, h, p, colorA, colorB, labelA, labelB } = d;

    if (!e.touches || e.touches.length === 0) return;
    const touch = e.touches[0];
    const px = touch.x;
    let nearest = 0, minDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(xp(i) - px);
      if (dist < minDist) { minDist = dist; nearest = i; }
    });

    const pt = data[nearest];
    const va = pt[fieldA], vb = pt[fieldB];
    const cx = xp(nearest);

    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, p.top); ctx.lineTo(cx, h - p.bottom); ctx.stroke();

    [{ v: va, c: colorA }, { v: vb, c: colorB }].forEach(pt2 => {
      if (pt2.v == null) return;
      const y = yp(pt2.v);
      ctx.beginPath(); ctx.arc(cx, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.strokeStyle = pt2.c; ctx.lineWidth = 1; ctx.stroke();
    });

    const fmt = (v) => v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '--';
    const lines = [pt.date, (labelA || '').slice(0, 4) + ' ' + fmt(va)];
    if (vb != null) lines.push((labelB || '').slice(0, 4) + ' ' + fmt(vb));
    const maxLen = Math.max(...lines.map(l => l.length));
    const tw = maxLen * 7 + 8;
    const lh = 18;
    const ty = Math.max(p.top + 4, yp(Math.max(va || -999, vb || -999)) - 36);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(cx - tw / 2 - 4, ty, tw + 8, lines.length * lh + 4);
    ctx.fillStyle = '#FFF';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, cx - tw / 2 + 4, ty + 12 + i * lh));
  },

  _drawFastLine(ctx, d, opts) {
    const { data, xp, yp, yField, w, h, p, isReturn } = d;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    ctx.beginPath();
    data.forEach((d2, i) => {
      const x = xp(i), y = yp(d2[yField]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = opts.color || '#1976D2';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const suffix = isReturn ? '%' : '';
    for (let i = 0; i <= 4; i++) {
      const val = d.yMax - (d.yMax - d.yMin) / 4 * i;
      ctx.fillText(val.toFixed(isReturn ? 1 : 2) + suffix, p.left - 6, d.yp(val));
    }

    ctx.fillStyle = '#CCC';
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    const fSteps = Math.min(data.length <= 120 ? 5 : 6, data.length);
    for (let i = 0; i < fSteps; i++) {
      const idx = Math.round((i / (fSteps - 1)) * (data.length - 1));
      ctx.textAlign = i === 0 ? 'left' : i === fSteps - 1 ? 'right' : 'center';
      ctx.fillText(this._formatXLabel(data[idx][d.xField], data), xp(idx), h - p.bottom + 8);
    }
    this._lastDraw = d;
  },

  _drawDualFast(ctx, d, opts) {
    const { data, xp, yp, fieldA, fieldB, w, h, p, colorA, colorB } = d;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    [fieldA, fieldB].forEach((field, idx) => {
      const color = idx === 0 ? colorA : colorB;
      ctx.beginPath();
      let first = false;
      data.forEach((d2, i) => {
        if (d2[field] == null) { first = false; return; }
        const x = xp(i), y = yp(d2[field]);
        if (!first) { ctx.moveTo(x, y); first = true; } else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    ctx.fillStyle = '#CCC';
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    const dFSteps = Math.min(data.length <= 120 ? 5 : 6, data.length);
    for (let i = 0; i < dFSteps; i++) {
      const idx = Math.round((i / (dFSteps - 1)) * (data.length - 1));
      ctx.textAlign = i === 0 ? 'left' : i === dFSteps - 1 ? 'right' : 'center';
      ctx.fillText(this._formatXLabel(data[idx].date, data), xp(idx), h - p.bottom + 8);
    }
    this._lastDualDraw = d;
  },

  _formatXLabel(dateStr, data) {
    if (!dateStr) return '';
    if (data && data.length > 250) return dateStr.slice(0, 7);
    return dateStr.slice(5);
  },
};

module.exports = chart;
