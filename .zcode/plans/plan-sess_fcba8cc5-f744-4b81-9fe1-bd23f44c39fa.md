# H5 迁移方案（最终版）

## 核心决策
- **后端不动**：沿用 CloudBase 云函数，H5 前端通过 CloudBase Web SDK 调用
- **前端重写**：React + TypeScript + Vite + Antd Mobile + PWA
- **效果目标**：达到小程序/APP 级别体验（PWA 安装到桌面、全屏运行）

## 执行步骤

### 第一步：搭建前端项目
- Vite + React + TypeScript 项目初始化
- 安装依赖：react-router-dom, antd-mobile, zustand, echarts, vite-plugin-pwa
- 配置 PWA（manifest.json + Service Worker）
- 配置 CloudBase Web SDK

### 第二步：通用基础设施
- API 请求封装（对接 CloudBase 云函数）
- 路由配置（保持原有页面跳转逻辑）
- 状态管理（zustand 替代 wx.Storage）
- 主题系统（红/蓝双主题）
- Toast/Modal/Loading 全局封装
- TabBar 底部导航

### 第三步：工具模块迁移
- calculator.js（纯 JS 直接复用）
- chart.js → ECharts 组件
- shareCard.js → Canvas 图片生成

### 第四步：页面迁移（11个页面）
按用户使用频率排序：
首页（持仓）→ 自选 → 基金详情 → 收益走势 → 搜索 → 添加持仓 → 加减仓 → 基金对比 → 资产分析 → 个人中心 → 登录

### 第五步：PWA 优化 + 部署
- Service Worker 离线缓存
- manifest.json 全屏配置
- 前端部署到 CDN / 静态托管