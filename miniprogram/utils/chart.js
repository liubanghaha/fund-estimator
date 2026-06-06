/**
 * 共享折线图绘制工具。基于 Canvas 2D API（type="2d"），支持触摸 tooltip。
 */

const chart = {
  /**
   * 绘制单条折线图（含渐变填充、坐标轴）
   */
  drawLineChart(ctx, opts = {}) {
    const { w = 340, h = 200, data = [], xField = 'date', yField = 'value',
      color = '#E4393C', padding } = opts;
    const p = padding || { top: 24, right: 12, bottom: 36, left: 52 };
    const pw = w - p.left - p.right;
    const ph = h - p.top - p.bottom;

    const vals = data.map(d => d[yField]);
    if (vals.length < 2) return;
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;

    const xp = (i) => p.left + (pw / (data.length - 1)) * i;
    const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    // 背景
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    // 渐变填充
    const gradient = ctx.createLinearGradient(0, p.top, 0, h - p.bottom);
    const isUp = vals[vals.length - 1] >= vals[0];
    const fillColor = isUp ? 'rgba(228,57,60,0.10)' : 'rgba(46,139,87,0.10)';
    gradient.addColorStop(0, fillColor);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = xp(i), y = yp(d[yField]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(xp(data.length - 1), h - p.bottom);
    ctx.lineTo(xp(0), h - p.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 折线
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = xp(i), y = yp(d[yField]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Y 轴刻度
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(2), p.left - 6, yp(val));
    }

    // X 轴日期
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      const label = this._formatXLabel(data[idx][xField]);
      ctx.fillText(label, xp(idx), h - p.bottom + 8);
    }

    // 保存渲染数据供 tooltip 使用
    this._lastDraw = { data, xp, yp, yField, xField, w, h, p, yMin, yMax, vals };
  },

  /**
   * 绘制双线对比图
   */
  drawDualLineChart(ctx, opts = {}) {
    const { w = 340, h = 200, data = [], fieldA = 'rateA', fieldB = 'rateB',
      colorA = '#E4393C', colorB = '#1976D2',
      labelA = '', labelB = '', padding } = opts;
    const p = padding || { top: 36, right: 12, bottom: 36, left: 52 };
    const pw = w - p.left - p.right;
    const ph = h - p.top - p.bottom;

    const valsA = data.map(d => d[fieldA]).filter(v => v !== null);
    const valsB = data.map(d => d[fieldB]).filter(v => v !== null);
    const allVals = [...valsA, ...valsB];
    if (allVals.length === 0) return;
    const min = Math.min(...allVals), max = Math.max(...allVals);
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;

    const xp = (i) => p.left + (pw / (data.length - 1)) * i;
    const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    // 两条折线
    [fieldA, fieldB].forEach((field, idx) => {
      const color = idx === 0 ? colorA : colorB;
      let started = false;
      ctx.beginPath();
      data.forEach((d, i) => {
        if (d[field] === null) { started = false; return; }
        const x = xp(i), y = yp(d[field]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // 图例
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'middle';
    [ { color: colorA, label: labelA, y: 10 },
      { color: colorB, label: labelB, y: 22 } ].forEach(lg => {
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
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      ctx.fillText(data[idx].date.slice(5), xp(idx), h - p.bottom + 8);
    }

    this._lastDualDraw = { data, xp, yp, fieldA, fieldB, w, h, p, yMin, yMax,
      colorA, colorB, labelA, labelB, valsA, valsB, opts };
  },

  handleDualTouch(ctx, e, opts = {}) {
    const now = Date.now();
    if (this._dualTouchLastTime && now - this._dualTouchLastTime < 60) return;
    this._dualTouchLastTime = now;

    const d = this._lastDualDraw;
    if (!d || !d.data || d.data.length < 2) return;
    const { data, xp, yp, fieldA, fieldB, w, h, p, colorA, colorB, labelA, labelB } = d;

    const touch = e.touches[0];
    const px = touch.x;
    let nearest = 0, minDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(xp(i) - px);
      if (dist < minDist) { minDist = dist; nearest = i; }
    });

    // 快速重绘底图
    this._drawDualFast(ctx, d, opts);

    const pt = data[nearest];
    const va = pt[fieldA], vb = pt[fieldB];
    const cx = xp(nearest);

    // 竖线
    ctx.strokeStyle =('rgba(0,0,0,0.1)');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, p.top); ctx.lineTo(cx, h - p.bottom); ctx.stroke();

    // 数据点
    [ { v: va, c: colorA }, { v: vb, c: colorB } ].forEach(pt2 => {
      if (pt2.v === null) return;
      const y = yp(pt2.v);
      ctx.beginPath(); ctx.arc(cx, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.strokeStyle = pt2.c; ctx.lineWidth = 2; ctx.stroke();
    });

    // Tooltip
    const fmt = (v) => v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '--';
    const lines = [pt.date, (labelA || '').slice(0, 4) + ' ' + fmt(va)];
    if (vb != null) lines.push((labelB || '').slice(0, 4) + ' ' + fmt(vb));
    const maxLen = Math.max(...lines.map(l => l.length));
    const tw = maxLen * 7 + 8;
    const lh = 18;
    const ty = Math.max(p.top + 4, yp(Math.max(va || -999, vb || -999)) - 36);
    ctx.fillStyle =('rgba(0,0,0,0.75)');
    ctx.fillRect(cx - tw / 2 - 4, ty, tw + 8, lines.length * lh + 4);
    ctx.fillStyle = '#FFF';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, cx - tw / 2 + 4, ty + 12 + i * lh));
  },

  _drawFastLine(ctx, d, opts) {
    const { data, xp, yp, yField, w, h, p } = d;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    ctx.beginPath();
    data.forEach((d2, i) => {
      const x = xp(i), y = yp(d2[yField]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = opts.color || '#E4393C';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Y 轴刻度（保留，不跳过）
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = d.yMax - (d.yMax - d.yMin) / 4 * i;
      ctx.fillText(val.toFixed(2), p.left - 6, d.yp(val));
    }

    // X 轴日期
    ctx.fillStyle = '#CCC';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      ctx.fillText(this._formatXLabel(data[idx][d.xField]), xp(idx), h - p.bottom + 8);
    }
    this._lastDraw = d;
  },

  _drawDualFast(ctx, d, opts) {
    const { data, xp, yp, fieldA, fieldB, w, h, p, colorA, colorB } = d;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    [fieldA, fieldB].forEach((field, idx) => {
      const color = idx === 0 ? colorA : colorB;
      let started = false;
      ctx.beginPath();
      data.forEach((d2, i) => {
        if (d2[field] === null) { started = false; return; }
        const x = xp(i), y = yp(d2[field]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    ctx.fillStyle = '#CCC';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      ctx.fillText(data[idx].date.slice(5), xp(idx), h - p.bottom + 8);
    }
    this._lastDualDraw = d;
  },

  _formatXLabel(dateStr) {
    if (!dateStr) return '';
    return dateStr.slice(5); // "YYYY-MM-DD" → "MM-DD"
  },
};

module.exports = chart;
