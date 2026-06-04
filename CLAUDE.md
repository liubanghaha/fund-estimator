# CLAUDE.md

## Karpathy 编码原则

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## 项目专属铁律

### 0. 定位 → 方案 → 确认 → 开发（铁律第一条）
**禁止拿到问题就直接改代码。** 必须走完这四步：
1. **定位**：加日志 / 读数据 / 追踪代码路径，找到根因
2. **方案**：把根因和修复思路写清楚，发给用户
3. **确认**：等用户说"可以"或"做"
4. **开发**：用户确认后再动手写代码

跳过任何一步 = 浪费时间。改错一次带来的额外排查成本远高于多想 30 秒。

### 1. 数据先行，再动模板
渲染问题 → 先 `console.log` 确认数据到了客户端 → 数据不到查云函数 → 数据到了才改模板。

### 2. 新 API 先验域名
调外部 URL 先确认在微信小程序白名单。已有白名单：`api.fund.eastmoney.com`, `fundf10.eastmoney.com`, `fundgz.1234567.com.cn`, `fundmobapi.eastmoney.com`, `push2his.eastmoney.com`, `web.ifzq.gtimg.cn`。不在白名单里的优先走客户端 `wx.request`。

### 3. 云函数出口限制
云函数 HTTPS 请求可能被远端拒绝。外部行情 API 优先走客户端请求。

### 4. Canvas 旧 API 限制
- `ctx.draw()` 每次清空重绘，无法增量叠加，触摸滑动 tooltip 必然闪烁
- Canvas 2D (`type="2d"`) 是原生组件，不能放在 scroll-view 里
- 折线图触摸：旧 API + 点按展示 tooltip（2 秒自动消失）

### 5. 部署 = 云函数 + 前端
改云函数后要做 `cli cloud functions deploy`。

### 6. 调试流程：日志 → 定位 → 修改 → 验证

## 技术栈
- 微信小程序 + 云开发
- 部署 CLI：`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`
- 环境 ID：`cloudbase-d0gug00io7bfedd97`
- 当前分支：`optimize/global-cleanup`

## 待修复
- 港股今日涨跌：白名单域名不支持，需加白名单或另寻 API
- 较上季度数据偶发 undefined
- profit-detail / fund-compare 折线图触摸未同步
