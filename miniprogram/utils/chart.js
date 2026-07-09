
const _getChartColors = () => {
  const t = (typeof wx !== 'undefined') ? (wx.getStorageSync('theme') || 'red') : 'blue';
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

  /**
   * 当天走势双线对比图（组合收益 vs 大盘指数）
   * data: [{ time: "09:31", rate: 0.12, indexRate: -0.05 }, ...]
   */
  drawIntradayChart(canvas, opts = {}) {
    const { w = 340, h = 200, data = [], fieldA = 'rate', fieldB = 'indexRate',
      labelA = '组合收益', labelB = '', padding } = opts;
    // 对齐历史走势图样式：padding、字号、网格、填充
    const p = padding || { top: 40, right: 12, bottom: 36, left: 52 };
    const pw = w - p.left - p.right, ph = h - p.top - p.bottom;

    const ctx = this._init(canvas, w, h);
    ctx.fillStyle = '#FFF';
    ctx.fillRect(0, 0, w, h);

    if (!data || data.length === 0) {
      ctx.fillStyle = '#BBB'; ctx.font = '12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('今日暂无分时数据', w / 2, h / 2);
      this._lastIntradayDraw = null;
      return ctx;
    }

    const valsA = data.map(d => d[fieldA]).filter(v => v != null);
    const valsB = data.map(d => d[fieldB]).filter(v => v != null);
    const allVals = [...valsA, ...valsB];
    if (allVals.length === 0) {
      ctx.fillStyle = '#BBB'; ctx.font = '12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('今日暂无分时数据', w / 2, h / 2);
      this._lastIntradayDraw = null;
      return ctx;
    }

    let min = Math.min(...allVals), max = Math.max(...allVals);
    if (min > 0) min = 0;
    if (max < 0) max = 0;
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;

    // 交易时段跳过午休：09:30-11:30 + 13:00-15:00，共 240 分钟，紧凑映射
    const xp = (i) => {
      const [hh, mm] = data[i].time.split(':').map(Number);
      const total = hh * 60 + mm;
      let ratio;
      if (total <= 690) ratio = (total - 570) / 240;      // 上午
      else if (total >= 780) ratio = (120 + total - 780) / 240; // 下午
      else ratio = 0.5; // 午休期间落在中间
      return p.left + pw * Math.max(0, Math.min(1, ratio));
    };
    const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
    const zeroY = yp(0);

    // 利润涨跌色（对齐历史走势：涨红跌绿）
    const lastProfitVal = [...valsA].pop();
    const firstProfitVal = valsA[0];
    const profitColor = lastProfitVal >= firstProfitVal ? '#E4393C' : '#2E8B57';
    const indexColor = '#1976D2';

    // 网格
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.beginPath(); ctx.moveTo(p.left, yp(val)); ctx.lineTo(w - p.right, yp(val)); ctx.stroke();
    }

    // 0% 基准虚线
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(p.left, zeroY); ctx.lineTo(w - p.right, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    // === 面积填充 & 折线 ===
    [
      { field: fieldA, color: profitColor, isProfit: true },
      { field: fieldB, color: indexColor, isProfit: false },
    ].forEach(cfg => {
      const vals = data.map(d => d[cfg.field]).filter(v => v != null);
      if (vals.length < 2) {
        return;
      }

      // 面积（仅收益线填充）
      if (cfg.isProfit) {
        const gradient = ctx.createLinearGradient(0, p.top, 0, h - p.bottom);
        const alpha = cfg.color === '#E4393C' ? 'rgba(228,57,60,0.08)' : 'rgba(46,139,87,0.08)';
        gradient.addColorStop(0, alpha);
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath();
        let started = false;
        data.forEach((d, i) => {
          if (d[cfg.field] == null) return;
          const x = xp(i), y = yp(d[cfg.field]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        });
        if (started) {
          const lastIdx = data.map((d, i) => d[cfg.field] != null ? i : -1).filter(i => i >= 0).pop();
          const firstIdx = data.findIndex(d => d[cfg.field] != null);
          ctx.lineTo(xp(lastIdx), zeroY);
          ctx.lineTo(xp(firstIdx), zeroY);
          ctx.closePath();
          ctx.fillStyle = gradient;
          ctx.fill();
        }
      }

      // 折线
      ctx.beginPath();
      let started = false;
      data.forEach((d, i) => {
        if (d[cfg.field] == null) return;
        const x = xp(i), y = yp(d[cfg.field]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = 1;
      ctx.stroke();

      // 末端点
      const lastPt = [...data].reverse().find(d => d[cfg.field] != null);
      if (lastPt) {
        const li = data.lastIndexOf(lastPt);
        ctx.beginPath(); ctx.arc(xp(li), yp(lastPt[cfg.field]), 3, 0, 2 * Math.PI);
        ctx.fillStyle = cfg.color; ctx.fill();
        ctx.strokeStyle = '#FFF'; ctx.lineWidth = 1; ctx.stroke();
      }
    });

    // 图例（对齐历史走势）
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    const fmt = v => (v > 0 ? '+' : '') + (v != null ? v.toFixed(2) : '0.00') + '%';
    ctx.fillStyle = profitColor; ctx.fillRect(p.left, 8, 14, 3);
    ctx.fillStyle = '#333'; ctx.textAlign = 'left';
    ctx.fillText((labelA || '我的收益').slice(0, 8) + ' ' + fmt(lastProfitVal), p.left + 18, 10);
    if (valsB.length > 0) {
      ctx.fillStyle = indexColor; ctx.fillRect(p.left, 22, 14, 3);
      ctx.fillStyle = '#333';
      ctx.fillText((labelB || '指数').slice(0, 8) + ' ' + fmt(valsB[valsB.length - 1]), p.left + 18, 24);
    }

    // Y轴标签
    ctx.fillStyle = '#999'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(1) + '%', p.left - 6, yp(val));
    }

    // X轴时间标签
    ctx.fillStyle = '#999'; ctx.font = '9px sans-serif'; ctx.textBaseline = 'top';
    [
      { t: '09:30', pos: 0, a: 'left' },
      { t: '11:30/13:00', pos: 0.5, a: 'center' },
      { t: '15:00', pos: 1, a: 'right' },
    ].forEach(l => {
      ctx.textAlign = l.a;
      ctx.fillText(l.t, p.left + pw * l.pos, h - p.bottom + 6);
    });

    this._lastIntradayDraw = { data, xp, yp, fieldA, fieldB, w, h, p, yMin, yMax,
      profitColor, indexColor, labelA, labelB };
    return ctx;
  },

  /**
   * 当天走势触摸交互
   */
  handleIntradayTouch(ctx, e) {
    const now = Date.now();
    if (this._intradayTouchTs && now - this._intradayTouchTs < 60) return;
    this._intradayTouchTs = now;

    const d = this._lastIntradayDraw;
    if (!d || !d.data || d.data.length < 2) return;
    const { data, xp, yp, fieldA, fieldB, w, h, p, profitColor, indexColor, labelA, labelB } = d;

    if (!e.touches || e.touches.length === 0) return;
    const px = e.touches[0].x;

    let nearest = 0, minDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(xp(i) - px);
      if (dist < minDist) { minDist = dist; nearest = i; }
    });

    const pt = data[nearest];
    const va = pt[fieldA], vb = pt[fieldB];
    const cx = xp(nearest);

    // 十字线
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, p.top); ctx.lineTo(cx, h - p.bottom); ctx.stroke();

    // 数据点高亮
    [{ v: va, c: profitColor }, { v: vb, c: indexColor }].forEach(pt2 => {
      if (pt2.v == null) return;
      const y = yp(pt2.v);
      ctx.beginPath(); ctx.arc(cx, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.strokeStyle = pt2.c; ctx.lineWidth = 1; ctx.stroke();
    });

    // 浮动 tooltip
    const fmt = (v) => v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '--';
    const lines = [pt.time || ''];
    lines.push((labelA || '组合').slice(0, 4) + ' ' + fmt(va));
    if (vb != null) lines.push((labelB || '指数').slice(0, 4) + ' ' + fmt(vb));
    const maxLen = Math.max(...lines.map(l => l.length));
    const tw = maxLen * 7 + 10;
    const lh = 18;
    const cy = va != null ? yp(va) : (vb != null ? yp(vb) : h / 2);
    let ty = cy - 40;
    if (ty < p.top + 2) ty = cy + 10;
    const tx = Math.max(p.left, Math.min(w - p.right - tw, cx - tw / 2));
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    const rr = 4;
    ctx.beginPath();
    ctx.moveTo(tx + rr, ty);
    ctx.lineTo(tx + tw - rr, ty);
    ctx.arcTo(tx + tw, ty, tx + tw, ty + rr, rr);
    ctx.lineTo(tx + tw, ty + lines.length * lh - rr);
    ctx.arcTo(tx + tw, ty + lines.length * lh, tx + tw - rr, ty + lines.length * lh, rr);
    ctx.lineTo(tx + rr, ty + lines.length * lh);
    ctx.arcTo(tx, ty + lines.length * lh, tx, ty + lines.length * lh - rr, rr);
    ctx.lineTo(tx, ty + rr);
    ctx.arcTo(tx, ty, tx + rr, ty, rr);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#FFF';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, tx + 6, ty + 10 + i * lh));
  },

  /**
   * 当天走势快速重绘（用于触摸时覆盖底图）
   */
  _drawIntradayFast(ctx) {
    const d = this._lastIntradayDraw;
    if (!d) return;
    const { data, xp, yp, fieldA, fieldB, w, h, p, profitColor, indexColor, labelA, labelB } = d;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    const pw = w - p.left - p.right;

    // 0% 基准
    const zeroY = yp(0);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(p.left, zeroY); ctx.lineTo(w - p.right, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    // 两条线（无面积填充）
    [{ f: fieldA, c: profitColor }, { f: fieldB, c: indexColor }].forEach(cfg => {
      const vals = data.map(d => d[cfg.f]).filter(v => v != null);
      if (vals.length < 2) return;
      ctx.beginPath();
      let started = false;
      data.forEach((d2, i) => {
        if (d2[cfg.f] == null) return; // skip null, keep connected
        const x = xp(i), y = yp(d2[cfg.f]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = cfg.c;
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Y 轴标签
    ctx.fillStyle = '#CCC';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = d.yMax - (d.yMax - d.yMin) / 4 * i;
      ctx.fillText(val.toFixed(1) + '%', p.left - 6, yp(val));
    }

    // X 轴时间标签
    ctx.fillStyle = '#CCC';
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    const timeLabels = [
      { time: '09:30', pos: 0, align: 'left' },
      { time: '10:30', pos: 0.25, align: 'center' },
      { time: '11:30', pos: 0.5, align: 'center' },
      { time: '13:00', pos: 0.5, align: 'center' },
      { time: '14:00', pos: 0.75, align: 'center' },
      { time: '15:00', pos: 1, align: 'right' },
    ];
    timeLabels.forEach(tl => {
      ctx.textAlign = tl.align;
      const x = p.left + pw * tl.pos;
      const labelY = h - p.bottom + 6;
      ctx.fillText(tl.time, x, tl.time === '13:00' ? labelY + 12 : labelY);
    });

    // 图例
    const rateVals = data.map(d => d[fieldA]).filter(v => v != null);
    const idxVals = data.map(d => d[fieldB]).filter(v => v != null);
    const fmt = v => (v > 0 ? '+' : '') + (v != null ? v.toFixed(2) : '0.00') + '%';
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillStyle = profitColor; ctx.fillRect(p.left, 8, 14, 3);
    ctx.fillStyle = '#999'; ctx.textAlign = 'left';
    ctx.fillText((labelA || '我的收益').slice(0, 8) + ' ' + fmt(rateVals[rateVals.length - 1]), p.left + 18, 10);
    if (idxVals.length > 0) {
      ctx.fillStyle = indexColor; ctx.fillRect(p.left, 22, 14, 3);
      ctx.fillStyle = '#999';
      ctx.fillText((labelB || '指数').slice(0, 8) + ' ' + fmt(idxVals[idxVals.length - 1]), p.left + 18, 24);
    }
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
