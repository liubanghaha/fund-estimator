# CLAUDE.md — fund-estimator 项目专属

## 铁律

### 1. 数据先行，再动模板
页面渲染出问题了，第一步永远是在 JS 里 `console.log` 抓数据，确认数据到了客户端。数据不到查云函数，数据到了才查 WXML 模板。**禁止不看日志就改模板表达式。**

### 2. 新 API 先验域名
调新的外部 URL（stock quotes、index data 等），先确认域名在小程序白名单里。有效的白名单域名为：
- `api.fund.eastmoney.com`
- `fundf10.eastmoney.com`
- `fundgz.1234567.com.cn`
- `fundmobapi.eastmoney.com`
- `push2his.eastmoney.com`
- `web.ifzq.gtimg.cn`

不在白名单里的 API，要么走云函数代理，要么让用户手动加白名单。

### 3. 云函数出口限制
云函数 HTTPS 请求可能被远端拒绝（socket hang up），尤其是高并发场景。外部行情 API 优先走客户端 `wx.request`，不要死磕云函数。

### 4. Canvas 旧 API 的限制
- `ctx.draw()` 每次清空全量重绘，无法增量叠加
- 触摸滑动 tooltip 必然闪烁，**不接受**
- Canvas 2D (`type="2d"`) 是原生组件，**不能放在 scroll-view 里**（会飘、不跟滚）
- 折线图触摸交互的可行方案：旧 API + 单次点按展示 tooltip（2 秒自动消失）

### 5. 一次部署 = 云函数 + 前端
改云函数代码后要记得 `cli cloud functions deploy`，不能只传前端。

### 6. 调试流程
```
现象 → 加日志 → 看输出 → 定位 → 修改 → 验证
```
跳过日志直接改 = 浪费时间。

## 技术栈
- 微信小程序 + 云开发
- 部署：`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`
- 环境 ID：`cloudbase-d0gug00io7bfedd97`
- 当前分支：`optimize/global-cleanup`

## 待修复项
- 前十大持仓：港股今日涨跌因 API 域名限制显示 `--`
- 较上季度数据偶发 undefined
- profit-detail / fund-compare 折线图触摸未同步 fund-detail 的点按方案
