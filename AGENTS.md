# WeChat Mini Program Development

## 项目概况

微信小程序开发目录。技术栈：微信小程序原生框架（WXML + WXSS + JS）+ 微信云开发（云函数、云数据库）。

## 常用外部数据源

- 东方财富移动 API
- 天天基金 API
- 微信云开发 API

## 行为准则

### 核心流程
**定位 → 方案 → 确认 → 开发。禁止拿到问题就直接改代码。**

1. **定位**：加日志 / 读数据 / 追踪代码路径，找到根因
2. **方案**：把根因和修复思路写清楚，发给用户
3. **确认**：等用户说"可以"或"做"
4. **开发**：用户确认后再动手写代码

### 需求复述确认
收到需求后，先用自己的话复述理解，确认搞明白了再动手。
- 一句话说清楚：你要改什么、为什么改、预期效果是什么
- 如果不确定，直接问，不要猜
- 用户说"对"或"是"之后再执行

### 不确定时先问
需求不明确、多种实现方案拿不准、拿不准用户说的是哪个页面/哪个按钮时，先向用户确认再动手，避免返工。

### 自主决策
以下情况不需要停下来确认，直接判断并实施：
- 技术选型、API 调用方式、错误处理策略
- 对接外部接口（RESTful 惯例、常见认证方式）
- 云函数部署、数据库操作等常规操作
- 如遇到接口不可用导致功能受阻，在开发日志中记录即可

### 编码原则

1. **Think Before Coding** — 陈述假设，不隐藏困惑。有多个解读时呈现出来，有更简单方案时说出来。
2. **Simplicity First** — 只写解决问题的必要代码，不写推测性功能，不用单次调用的抽象。
3. **Surgical Changes** — 只改必须改的。不要顺手"优化"相邻代码、注释、格式。匹配现有风格。
4. **Goal-Driven Execution** — 多步骤任务先列计划，定义验证标准，循环直到验证通过。

### 调试流程
日志 → 定位 → 修改 → 验证

---

## fund-estimator（韭菜养基宝）架构

小程序名：韭菜养基宝 | AppID：wx1473b1fa97b27717 | 云环境：cloudbase-d0gug00io7bfedd97

### 页面结构
- `pages/index/index` — 首页，展示持仓基金实时估值列表
- `pages/search/index` — 搜索基金（6 位代码）
- `pages/fund-detail/index` — 基金详情（估值+净值+档案+持仓+风险指标+费用黑洞）
- `pages/add-holding/index` — 添加持仓（输入代码+金额）
- `pages/user-center/index` — 用户中心（反馈/关于/主题）
- `pages/login/index` — 登录页
- `pages/watchlist/index` — 自选列表（分组/排序/轮询）
- `pages/profit-detail/index` — 收益走势（日历/走势图）
- `pages/fund-compare/index` — 基金对比（双基金净值对比）
- `pages/adjust-holding/index` — 加减仓（OCR截图识别）
- `pages/sync-trade/index` — 交易记录同步
- `pages/correlation-matrix/index` — 资产分析（健康分+穿透+重合度）

### 云函数

| 函数 | 用途 | 外部 API |
|---|---|---|
| `userLogin` | 获取 OPENID | 无 |
| `searchFund` | 按代码查基金 | 天天基金 |
| `fetchFundInfo` | 基金基本信息 | 天天基金 |
| `fetchFundEstimate` | 实时估算涨跌 | 天天基金 + 东方财富 |
| `fetchFundNAVHistory` | 历史净值 | 东方财富 |
| `fetchFundProfile` | 基金档案+持仓 | 东方财富（3 个接口并行） |
| `fetchFundOverview` | 基金概览（估值+净值+档案） | 天天基金 + 东方财富 |
| `getPortfolio` | 持仓组合估值+温度+健康分 | 天天基金 + 东方财富 |
| `createCollection` | 初始化数据库 | 无 |
| `ocrScreenshot` | 截图识别基金 | 微信 OCR + OCR.space |
| `computeFundTemperature` | 定时计算估值温度 | 东方财富 |
| `dcaBacktest` | 定投回测 | 东方财富 |
| `computeCorrelation` | 持仓重合度分析 | 东方财富 |
| `snapshotProfit` | 分钟级收益快照 | 无 |

### 数据库
- `holdings`：`{ _openid, fundCode, fundName, shares, buyPrice, marketValue, createTime }`
- `fund_temperatures`：`{ fundCode, date, signal, normPE, detailPEs }`
- `transactions`：交易记录
- `watchlist`：自选列表
- `profit_snapshots`：盘中收益快照

### 已配置 API 白名单
`api.fund.eastmoney.com`, `fundf10.eastmoney.com`, `fundgz.1234567.com.cn`, `fundmobapi.eastmoney.com`, `push2his.eastmoney.com`, `web.ifzq.gtimg.cn`。不在白名单里的优先走客户端 `wx.request`。

### 部署
- 云函数：`cloudbase fn deploy --all --force`
- 小程序上传：`miniprogram-ci upload --pp . --pkp private.*.key --appid wx1473b1fa97b27717 -r 1`

### 已知问题
- 港股今日涨跌：白名单域名不支持
- 较上季度数据偶发 undefined
- profit-detail / fund-compare 折线图触摸未同步
