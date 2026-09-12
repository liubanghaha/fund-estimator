
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
  // 按 null 断开折线为连续段（缺数据不跨空连接）
  _splitSegments(data, field, xp, yp, zeroY) {
    const segs = [];
    let cur = [];
    data.forEach((d, i) => {
      if (d[field] == null) { if (cur.length) { segs.push(cur); cur = []; } return; }
      cur.push({ x: xp(i), y: yp(d[field]) });
    });
    if (cur.length) segs.push(cur);
    return segs;
  },

  // Catmull-Rom → 三次贝塞尔：折线变平滑曲线，严格过每个数据点（值不改变，仅视觉圆滑）
  _smoothPolyline(ctx, pts) {
    if (!pts || pts.length === 0) return;
    if (pts.length === 1) { ctx.moveTo(pts[0].x, pts[0].y); return; }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y
      );
    }
  },

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

    // 利润涨跌色（按当日涨跌，而非相对开盘：正收益红色，负收益绿色）
    const lastProfitVal = [...valsA].pop();
    const profitColor = lastProfitVal >= 0 ? '#E4393C' : '#2E8B57';
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

      // 面积（仅收益线填充，与平滑折线同一路径，避免线面错位）
      if (cfg.isProfit) {
        const gradient = ctx.createLinearGradient(0, p.top, 0, h - p.bottom);
        const alpha = cfg.color === '#E4393C' ? 'rgba(228,57,60,0.08)' : 'rgba(46,139,87,0.08)';
        gradient.addColorStop(0, alpha);
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        const segs = this._splitSegments(data, cfg.field, xp, yp, zeroY);
        segs.forEach(seg => {
          ctx.beginPath();
          this._smoothPolyline(ctx, seg);
          ctx.lineTo(seg[seg.length - 1].x, zeroY);
          ctx.lineTo(seg[0].x, zeroY);
          ctx.closePath();
          ctx.fillStyle = gradient;
          ctx.fill();
        });
      }

      // 折线（平滑曲线：Catmull-Rom 过所有数据点，数值不变仅视觉圆滑；null 断开分段）
      ctx.beginPath();
      this._splitSegments(data, cfg.field, xp, yp, zeroY).forEach(seg => this._smoothPolyline(ctx, seg));
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // 图例（对齐历史走势）；无数据时显示 --（不误导为 0.00%）
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    const fmt = v => (v != null ? ((v > 0 ? '+' : '') + v.toFixed(2) + '%') : '--');
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
   * 通用「从左到右画出来」进场动画（全站折线类图表共用）。
   * opts:
   *   w, h            画布逻辑尺寸
   *   plot            { left, right, top, bottom }：决定扫掠范围与"刷白"区域
   *   draw(canvas)    把整张图画到传入的画布上（各图复用各自的原绘制函数；
   *                   有叠加层如买卖点标记时，一并画在里面，否则动画会把它擦掉）
   *   restore(ctx)    可选：刷白后补回静态底图——只有绘图区内含横向网格的图需要
   *   animate/duration
   * 实现：整图先烘到离屏画布，动画每帧只做「贴整图 + 把绘图区未画到的右段刷白」，
   * 每帧开销固定（不逐帧重算曲线），稳定 60fps；不触发 setData。
   */
  drawChartAnimated(canvas, opts = {}) {
    const { w = 340, h = 200, animate = true, duration = 1200, plot, draw, restore } = opts;
    this.cancelChartAnim();
    if (typeof draw !== 'function') return null;
    if (!animate || typeof wx.createOffscreenCanvas !== 'function') {
      draw(canvas);
      return null;
    }
    const dpr = wx.getSystemInfoSync().pixelRatio || 1;
    let off = null;
    try {
      off = wx.createOffscreenCanvas({ type: '2d', width: Math.ceil(w * dpr), height: Math.ceil(h * dpr) });
      draw(off); // 整图（含各图自己的网格/标记/标签）→ 离屏
    } catch (e) {
      draw(canvas); // 离屏不可用：退回静态整图
      return null;
    }

    const ctx = this._init(canvas, w, h);
    this._canvasNode = canvas;
    const P = plot || { left: 52, right: 12, top: 40, bottom: 36 };
    const x0 = P.left, x1 = w - P.right;
    const ph = h - P.top - P.bottom;
    const t0 = Date.now();
    this._animStart = t0;
    const token = this._animToken; // cancelChartAnim 已递增过，取当前值作为本次动画的身份
    const blitFull = () => {
      ctx.drawImage(off, 0, 0, Math.ceil(w * dpr), Math.ceil(h * dpr), 0, 0, w, h);
    };

    const step = () => {
      if (token !== this._animToken) return; // 已被取消/被新动画取代
      const raw = Math.min(1, (Date.now() - t0) / duration);
      const e = 1 - Math.pow(1 - raw, 2); // easeOutQuad：比 easeOutCubic 均匀，不会前段一下冲完
      const xLimit = x0 + (x1 - x0) * e;
      // 源矩形用离屏的**设备像素**，目标矩形用可见画布的**逻辑像素**（ctx 已按 dpr 缩放）
      ctx.drawImage(off, 0, 0, Math.ceil(w * dpr), Math.ceil(h * dpr), 0, 0, w, h);
      // 多刷 6px：曲线最后一个点正好落在 w-P.right 上，其线宽/抗锯齿会从边界露出小半截。
      // 末帧（raw=1）不刷，所以不会把内容真正遮掉。
      const tailW = raw < 1 ? (w - P.right + 6) - xLimit : 0;
      if (tailW > 0) {
        ctx.fillStyle = '#FFF';
        ctx.fillRect(xLimit, P.top, tailW, ph);
        if (typeof restore === 'function') restore(ctx);
      }
      if (raw < 1) {
        this._animRAF = canvas.requestAnimationFrame(step);
      } else {
        blitFull(); // 末帧补一次整图（幂等），确保收尾一定是完整的
        this._animRAF = null;
        this._animStart = 0;
      }
    };
    this._animRAF = canvas.requestAnimationFrame(step);

    // 兜底：requestAnimationFrame 会被系统暂停（页面切后台、画布不可见等），
    // 一旦停在中途，画布就永久停在半成品（2026-09-11 真机复现：曲线停在绘图区 82% 处不动）。
    // 定时器不受 rAF 暂停影响，到点直接贴完整图并终止这条动画链。
    if (this._animSafetyTimer) clearTimeout(this._animSafetyTimer);
    this._animSafetyTimer = setTimeout(() => {
      if (token !== this._animToken) return;
      if (this._animRAF && canvas.cancelAnimationFrame) {
        try { canvas.cancelAnimationFrame(this._animRAF); } catch (e) { /* ignore */ }
      }
      this._animRAF = null;
      this._animStart = 0;
      try { blitFull(); } catch (e) { /* ignore */ }
    }, duration + 400);
    return ctx;
  },

  /**
   * 当天走势「从左到右画出来」的进场动画（同花顺式出图效果）。
   * 实现方式：先用原 drawIntradayChart 把整图**画到离屏画布**（复用同一套绘制代码，
   * 画面与静态渲染逐像素一致），动画期间每帧只把离屏画布的左段 drawImage 到可见画布——
   * 每帧只有一次贴图，比逐帧重画整图快得多，所以更跟手、不掉帧。
   * 不触发 setData，纯 canvas 绘制，不引起页面重渲染。
   * opts.animate=false / 数据不足 2 点 / 不支持离屏画布时，回退为直接整图绘制。
   */
  drawIntradayChartAnimated(canvas, opts = {}) {
    const { w = 340, h = 200, data = [], animate = true, duration = 1200 } = opts;
    if (!animate || !data || data.length < 2) {
      this.cancelChartAnim(); // 先掐掉上一次动画：否则它的残余帧会把这次整图又刷成半成品
      return this.drawIntradayChart(canvas, opts);
    }
    return this.drawChartAnimated(canvas, {
      w, h, animate, duration,
      plot: opts.padding || { top: 40, right: 12, bottom: 36, left: 52 },
      draw: (c) => this.drawIntradayChart(c, opts),
      // 当天走势的绘图区里有横向网格 + 0% 基准虚线，属于静态底图，刷白后要补回来
      restore: (ctx) => {
        const g = this._lastIntradayDraw;
        if (!g || !g.yp || g.yMin == null || g.yMax == null) return;
        const P = g.p;
        ctx.strokeStyle = 'rgba(0,0,0,0.06)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 4; i++) {
          const val = g.yMax - (g.yMax - g.yMin) / 4 * i;
          ctx.beginPath(); ctx.moveTo(P.left, g.yp(val)); ctx.lineTo(g.w - P.right, g.yp(val)); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(P.left, g.yp(0)); ctx.lineTo(g.w - P.right, g.yp(0)); ctx.stroke();
        ctx.setLineDash([]);
      },
    });
  },

  // 是否有进场动画正在进行（轮询等"后台重绘"据此让路，避免把动画盖掉）。
  // 带自动过期：页面切后台时 requestAnimationFrame 不再触发、_animRAF 会一直挂着，
  // 若不设上限，调用方（如 30 秒轮询）会被永久挡住 → 开盘就看不到曲线更新。
  isAnimating(duration) {
    if (!this._animRAF) return false;
    const t = this._animStart || 0;
    if (t && Date.now() - t > (duration || 1200) + 800) {
      this._animRAF = null; // 视为已停摆，放行
      this._animStart = 0;
      return false;
    }
    return true;
  },

  // 打断进场动画（新渲染 / 触摸交互前调用）：否则动画会把触摸画上的十字线擦掉
  cancelChartAnim() {
    if (this._animSafetyTimer) { clearTimeout(this._animSafetyTimer); this._animSafetyTimer = null; }
    this._animToken = (this._animToken || 0) + 1; // 让已排队的帧回调与兜底定时器失效
    if (this._animRAF && this._canvasNode && this._canvasNode.cancelAnimationFrame) {
      try { this._canvasNode.cancelAnimationFrame(this._animRAF); } catch (e) { /* ignore */ }
    }
    this._animRAF = null;
    this._animStart = 0;
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
   * 样式与 drawIntradayChart 保持一致（X 轴标签/面积/颜色），避免触摸瞬间外观跳变
   */
  _drawIntradayFast(ctx) {
    const d = this._lastIntradayDraw;
    if (!d) return;
    this.cancelChartAnim(); // 触摸打断进场动画，立即整图可交互
    const { data, xp, yp, fieldA, fieldB, w, h, p, profitColor, indexColor, labelA, labelB } = d;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    const pw = w - p.left - p.right;

    // 网格（与主图一致）
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const val = d.yMax - (d.yMax - d.yMin) / 4 * i;
      ctx.beginPath(); ctx.moveTo(p.left, yp(val)); ctx.lineTo(w - p.right, yp(val)); ctx.stroke();
    }

    // 0% 基准
    const zeroY = yp(0);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(p.left, zeroY); ctx.lineTo(w - p.right, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    // 面积填充（收益线，与主图一致）
    const rateVals = data.map(d => d[fieldA]).filter(v => v != null);
    if (rateVals.length >= 2) {
      const gradient = ctx.createLinearGradient(0, p.top, 0, h - p.bottom);
      const alpha = profitColor === '#E4393C' ? 'rgba(228,57,60,0.08)' : 'rgba(46,139,87,0.08)';
      gradient.addColorStop(0, alpha);
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      this._splitSegments(data, fieldA, xp, yp, zeroY).forEach(seg => {
        ctx.beginPath();
        this._smoothPolyline(ctx, seg);
        ctx.lineTo(seg[seg.length - 1].x, zeroY);
        ctx.lineTo(seg[0].x, zeroY);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      });
    }

    // 两条线
    [{ f: fieldA, c: profitColor }, { f: fieldB, c: indexColor }].forEach(cfg => {
      const vals = data.map(d => d[cfg.f]).filter(v => v != null);
      if (vals.length < 2) return;
      ctx.beginPath();
      this._splitSegments(data, cfg.f, xp, yp, zeroY).forEach(seg => this._smoothPolyline(ctx, seg));
      ctx.strokeStyle = cfg.c;
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Y 轴标签（#999 与主图一致）
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = d.yMax - (d.yMax - d.yMin) / 4 * i;
      ctx.fillText(val.toFixed(1) + '%', p.left - 6, yp(val));
    }

    // X 轴时间标签（与主图 3 标签一致）
    ctx.fillStyle = '#999';
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    [
      { t: '09:30', pos: 0, a: 'left' },
      { t: '11:30/13:00', pos: 0.5, a: 'center' },
      { t: '15:00', pos: 1, a: 'right' },
    ].forEach(l => {
      ctx.textAlign = l.a;
      ctx.fillText(l.t, p.left + pw * l.pos, h - p.bottom + 6);
    });

    // 图例（#333 与主图一致）
    const idxVals = data.map(d => d[fieldB]).filter(v => v != null);
    const fmt = v => (v > 0 ? '+' : '') + (v != null ? v.toFixed(2) : '0.00') + '%';
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillStyle = profitColor; ctx.fillRect(p.left, 8, 14, 3);
    ctx.fillStyle = '#333'; ctx.textAlign = 'left';
    ctx.fillText((labelA || '我的收益').slice(0, 8) + ' ' + fmt(rateVals[rateVals.length - 1]), p.left + 18, 10);
    if (idxVals.length > 0) {
      ctx.fillStyle = indexColor; ctx.fillRect(p.left, 22, 14, 3);
      ctx.fillStyle = '#333';
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
    // tooltip 水平钳制在画布内（左缘不越过绘图区、右缘不出画布）
    const tx = Math.max(p.left, Math.min(w - p.right - tw - 8, cx - tw / 2 - 4));
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(tx, ty, tw + 8, lines.length * lh + 4);
    ctx.fillStyle = '#FFF';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, tx + 4, ty + 12 + i * lh));
  },

  _drawFastLine(ctx, d, opts) {
    this.cancelChartAnim(); // 触摸打断进场动画：否则动画每帧刷白会把十字线擦掉
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
    this.cancelChartAnim(); // 触摸打断进场动画，理由同 _drawFastLine
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
