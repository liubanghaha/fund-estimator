# 涨跌有数 — 代办清单

## 🔴 高优先级

- [ ] **清除泄露的密钥和私钥** — 百度 OCR API Key/Secret 硬编码在 `ocrScreenshot`、`ocrTransaction` 云函数中；`private.wx1473b1fa97b27717.key` 已入库。需重新生成密钥并加入 `.gitignore`。
- [ ] **批量保存改为云函数处理** — `add-holding/index.js` 的 `onSaveAll` 逐条串行调用 `fetchFundEstimate`（N 只基金 = N 次云函数调用），应改为一次云函数批量处理。
- [ ] **错误态加「重试」按钮** — 多数页面 `catch` 只打 `console.error` 不处理 UI，用户看到「加载失败」后无法重试。

## 🟡 中优先级

- [ ] **资产配置饼图** — 首页/收益页展示持仓按股票型/混合型/债券型的分布占比（利用 `fetchFundProfile` 已返回的 `fundType`）。
- [ ] **涨跌幅阈值订阅消息提醒** — 单日涨跌超过 ±3% 时通过微信订阅消息推送通知。
- [ ] **自选页空状态引导** — 无自选基金时展示「去搜索添加自选」入口（当前为空白）。
- [ ] **定投计算器** — 输入基金代码 + 每月定投金额 + 起始日期，计算定投至今总收益和年化收益率。
- [ ] **缓存加 TTL + 版本号** — `portfolio_cache`、`profit_detail_cache_v2`、`watchlist_cache` 等缓存永不过期，需加过期时间和版本号防止跨版本不兼容。

## 🟢 低优先级

- [ ] **收益截图分享** — Canvas 绘制持仓收益卡片（基金名称、持有金额、今日收益、累计收益率），保存到相册方便分享。
- [ ] **基金排行榜** — 利用东方财富排行接口展示近1月/近1年涨幅榜，辅助用户发现基金。
- [ ] **云函数合并减少冷启动** — 基金详情页需调 3 个云函数（`fetchFundEstimate` + `fetchFundNAVHistory` + `fetchFundProfile`），合并为单一 `fetchFundDetail`。
- [ ] **Canvas 轮询增量重绘** — 收益详情页每 15s 全量重绘 Canvas，改为仅更新末端数据点。
- [ ] **批量删除改为云函数批量操作** — `index.js` 的 `onBatchDelete` 逐条 `doc().remove()`，改为云函数 `where({ _id: _.in(ids) }).remove()`。
- [ ] **持仓重叠分析** — 多只基金持有同一只股票时计算实际个股总敞口，预警集中度风险。
- [ ] **年化收益率 XIRR** — 当前只显示简单收益率，加入考虑资金投入时间价值的 XIRR 真实年化收益率。
