# 韭菜养基宝 H5 迁移计划

## 目标

将微信小程序「韭菜养基宝」迁移为 H5 PWA（渐进式 Web 应用），安装到手机桌面后体验达到小程序/APP 级别。

---

## 核心决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 后端 | 不动，沿用 CloudBase 云函数 | 23 个云函数功能完整，H5 通过 CloudBase Web SDK 调用 |
| 前端 | React + TypeScript + Vite | 移动组件库生态好，TS 减少金融计算 Bug |
| UI 库 | Antd Mobile | 组件最全，风格接近原生 APP |
| 图表 | ECharts | K 线图/热力图/双轴对比一站式 |
| 状态 | zustand | 轻量，替代 wx.Storage 的全局状态 |
| PWA | vite-plugin-pwa + workbox | 桌面安装、离线缓存 |

## 项目结构

```
web/                          # H5 前端（新建）
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── public/
│   ├── manifest.json         # PWA 配置
│   └── icons/                # APP 图标
└── src/
    ├── main.tsx              # 入口
    ├── App.tsx               # 根组件（路由 + TabBar）
    ├── routes.tsx            # 路由配置
    ├── cloudbase.ts          # CloudBase SDK 初始化
    ├── auth.ts               # CloudBase 认证模块（微信网页授权）
    ├── api/                  # API 请求封装（替代 utils/api.js）
    │   └── index.ts          # 30+ 云函数调用方法
    ├── stores/               # zustand 状态管理
    │   ├── user.ts           # 用户信息
    │   ├── theme.ts          # 红/蓝主题
    │   └── cache.ts          # 本地缓存（替代 wx.Storage）
    ├── hooks/                # 自定义 Hooks
    │   ├── useToast.ts       # Toast 全局封装
    │   ├── useModal.ts       # Modal 全局封装
    │   └── useLoading.ts     # Loading 全局封装
    ├── utils/                # 工具模块
    │   ├── calculator.ts     # ← 从 miniprogram/utils/calculator.js 迁移（纯 JS 直接复用）
    │   └── shareCard.ts      # ← 从 miniprogram/utils/shareCard.js 迁移（Canvas API 调整）
    ├── components/           # 通用组件
    │   ├── AuthGuard/        # 路由守卫（登录校验）
    │   ├── TabBar/           # 底部导航栏
    │   ├── Charts/           # ECharts 图表组件
    │   │   ├── LineChart.tsx      # 折线图
    │   │   ├── DualLineChart.tsx  # 双线对比图
    │   │   ├── Heatmap.tsx        # 热力图
    │   │   └── IntradayChart.tsx  # 日内走势图
    │   ├── FundCard.tsx      # 基金卡片
    │   ├── SearchBar.tsx     # 搜索栏
    │   └── ShareCard.tsx     # 分享图生成
    ├── pages/                # 页面（11 个，按使用频率排序）
    │   ├── index/            # 首页 - 我的持仓
    │   ├── watchlist/        # 自选列表
    │   ├── fund-detail/      # 基金详情
    │   ├── profit-detail/    # 收益走势
    │   ├── search/           # 搜索基金
    │   ├── add-holding/      # 添加持仓
    │   ├── adjust-holding/   # 加减仓
    │   ├── fund-compare/     # 基金对比
    │   ├── correlation-matrix/ # 资产分析
    │   ├── user-center/      # 个人中心
    │   └── login/            # 登录页
    └── styles/               # 全局样式
        ├── theme.css         # 红/蓝双主题 CSS 变量
        └── global.css        # 全局样式
```

## ⚠️ 审查发现的阻塞问题（已解决）

### 问题一：用户身份认证断裂

**根因**：云函数依赖 `cloud.getWXContext().OPENID` 识别用户。小程序中由微信会话自动注入，H5 浏览器中该方法返回空值。

**影响范围**（6 个云函数）：

| 云函数 | 依赖方式 | 后果 |
|--------|---------|------|
| `userLogin` | 直接返回 OPENID | H5 下返回空 |
| `getPortfolio` | 按 OPENID 查持仓 | 查不到任何数据 |
| `manageHolding` | 按 OPENID CRUD | 401 未登录 |
| `manageWatchlist` | 按 OPENID CRUD | 401 未登录 |
| `manageTransaction` | 按 OPENID 查交易 | 401 未登录 |
| `snapshotProfit` | 遍历所有用户快照 | 功能正常但无法关联用户 |

不影响（纯数据查询，不依赖 OPENID）：其余 17 个云函数。

**解决方案 — CloudBase Web SDK 微信网页授权**：

```
小程序登录流程：
  wx.cloud.init() → wxContext.OPENID 自动获取

H5 登录流程（改动后）：
  auth.weixinAuthProvider().signInWithRedirect()  // 微信网页授权
  → 获取 OPENID
  → cloud.callFunction('userLogin') 传 OPENID
  → 云函数返回用户信息
  → 后续所有云调用携带登录态
```

前端改动：
- 新增 `src/auth.ts` — CloudBase 认证模块，封装微信网页授权
- 新增 `src/components/AuthGuard.tsx` — 路由守卫，未登录跳转登录页
- 修改 `pages/login/index.tsx` — 展示微信授权按钮

后端改动：
- **不需要改云函数代码**。CloudBase Web SDK `signInWithRedirect` 登录后，调用 `callFunction` 时 SDK 会自动在请求头中携带登录凭证，云函数内 `cloud.getWXContext().OPENID` 同样能获取到（这是 CloudBase 的跨端统一设计）。

---

### 问题二：客户端直连外部 API 被 CORS 拦截

**根因**：`miniprogram/utils/api.js` 中有 4 个函数用 `wx.request` 从客户端直连东方财富/腾讯财经。小程序域名白名单允许跨域，浏览器 CORS 策略会拦截。

**影响函数**：

| 函数 | 调用域名 | H5 可用？ |
|------|---------|----------|
| `fetchMarketIndexClient` | push2his.eastmoney.com | ❌ CORS 拦截 |
| `fetchIndexIntradayClient` | push2his.eastmoney.com | ❌ CORS 拦截 |
| `fetchIndexIntradayTencent` | web.ifzq.gtimg.cn | ❌ CORS 拦截 |
| `fetchMarketIndexTencent` | web.ifzq.gtimg.cn | ❌ CORS 拦截 |

**解决方案**：全部改为通过云函数代理。项目中已有对应云函数：

| 客户端方法 | 替代云函数 |
|-----------|-----------|
| `fetchMarketIndexClient` | `fetchMarketIndex` |
| `fetchIndexIntradayClient` | `fetchIndexIntraday` |
| `fetchIndexIntradayTencent` | `fetchIndexIntraday` |
| `fetchMarketIndexTencent` | `fetchMarketIndex` |

只需将 `src/api/index.ts` 中这 4 个方法的实现从客户端 `wx.request` 改为 `app.callFunction()` 调用对应云函数即可，**不需要新增云函数**。

---

## 与原项目的关系

| 复用（不需要改动） | 不复用（需要重写） |
|-------------------|-------------------|
| `cloudfunctions/` 全部 23 个云函数 | `miniprogram/pages/*.wxml` → React JSX |
| `miniprogram/utils/calculator.js` 计算逻辑 | `miniprogram/pages/*.wxss` → CSS Modules |
| `miniprogram/utils/api.js` 接口调用模式 | `miniprogram/pages/*.js` 页面交互逻辑 |
| 红蓝主题色彩方案 | `miniprogram/utils/chart.js` → ECharts |
| 整体页面布局和交互逻辑 | 导航方式（wx.navigate → React Router） |
| CloudBase 数据库（不变） | 本地存储（wx.Storage → localStorage + zustand） |

## 执行步骤

### Step 1：搭建前端项目
- [x] 初始化 Vite + React + TypeScript 项目
- [ ] 安装依赖：react-router-dom, antd-mobile, zustand, echarts, vite-plugin-pwa, @cloudbase/js-sdk
- [ ] 配置 vite.config.ts
- [ ] 配置 tsconfig.json 路径别名
- [ ] 初始化 CloudBase Web SDK

### Step 2：通用基础设施
- [ ] **CloudBase 认证模块** — 微信网页授权登录，封装 `auth.weixinAuthProvider().signInWithRedirect()`
- [ ] **路由守卫组件** — 未登录时拦截敏感页面，跳转登录页
- [ ] API 请求封装 — `app.callFunction()` 对接 30+ 云函数（CORS 问题：客户端直连改为云函数代理）
- [ ] 路由配置（React Router，保持原有页面跳转逻辑）
- [ ] zustand 状态管理（user / theme / cache）
- [ ] 主题系统（红/蓝双主题 CSS 变量）
- [ ] Toast / Modal / Loading 全局封装
- [ ] TabBar 底部导航栏组件

### Step 3：工具模块迁移
- [ ] calculator.ts — 从 miniprogram/utils/calculator.js 迁移（纯 JS 直接复用）
- [ ] shareCard.ts — Canvas 图片生成（API 从 wx 改为浏览器标准 API）
- [ ] ECharts 图表组件封装（替代 miniprogram/utils/chart.js）

### Step 4：页面迁移（11 个页面）
按用户使用频率排序：

1. [ ] 首页（持仓列表）— pages/index
2. [ ] 自选列表 — pages/watchlist
3. [ ] 基金详情 — pages/fund-detail
4. [ ] 收益走势 — pages/profit-detail
5. [ ] 搜索基金 — pages/search
6. [ ] 添加持仓 — pages/add-holding
7. [ ] 加减仓 — pages/adjust-holding
8. [ ] 基金对比 — pages/fund-compare
9. [ ] 资产分析 — pages/correlation-matrix
10. [ ] 个人中心 — pages/user-center
11. [ ] 登录页 — pages/login

### Step 5：PWA 配置 + 部署
- [ ] manifest.json（APP 名称、图标、全屏模式）
- [ ] Service Worker（离线缓存静态资源 + API 数据）
- [ ] 前端构建部署到 CDN / 静态托管

## 关键差异点

| 功能 | 小程序 | H5 |
|------|--------|-----|
| 登录 | 微信静默登录 | 需要用户点一次微信授权 |
| 分享 | 微信聊天/朋友圈 | 系统分享面板 |
| 截图 OCR | wx.chooseMedia | `<input type="file" accept="image/*">` |
| 触感反馈 | wx.vibrateShort | navigator.vibrate() |
| 相册保存 | wx.saveImageToPhotosAlbum | Canvas → 长按保存 |
| 导航栏 | 原生 NavigationBar | 自定义顶栏 + 安全区域适配 |

## PWA 体验对标清单

| 体验点 | 实现方式 |
|--------|---------|
| 桌面图标 | manifest.json → 添加到桌面 |
| 全屏运行 | manifest display: standalone |
| 底部 Tab | Antd Mobile TabBar |
| 页面切换动画 | CSS transition（右滑进入/左滑返回） |
| 下拉刷新 | Antd Mobile PullToRefresh |
| 骨架屏 | Antd Mobile Skeleton |
| 启动画面 | manifest splash screen |
| 离线缓存 | Service Worker |
| 安全区域 | CSS env(safe-area-inset-*) |
