# WeChat Mini Program Development

## 项目概况

这是微信小程序开发目录，包含多个云开发小程序项目（如 fund-estimator、miniprogram-1）。
技术栈：微信小程序原生框架（WXML + WXSS + JS）+ 微信云开发（云函数、云数据库）。

## 常用外部数据源

- 东方财富移动 API
- 天天基金 API
- 微信云开发 API

## 行为准则

1. **对接外部接口时不需确认**：直接按最合理的方案实现（RESTful 惯例、常见认证方式），不需要停下来向我确认。如遇到接口不可用导致功能受阻，在开发日志中记录即可。
2. **自主决策**：技术选型、API 调用方式、错误处理策略等，优先自行判断并直接实施。
3. **所有云函数部署、数据库操作等常规操作**均不需确认，直接执行。

## fund-estimator（涨跌有数）架构

小程序名：涨跌有数 | AppID：wx1473b1fa97b27717 | 云环境：cloudbase-d0gug00io7bfedd97

### 页面结构
- `pages/index/index` — 首页，展示持仓基金实时估值列表
- `pages/search/index` — 搜索基金（6 位代码）
- `pages/fund-detail/index` — 基金详情（估值+净值+档案+持仓）
- `pages/add-holding/index` — 添加持仓（输入代码+金额）
- `pages/user-center/index` — 用户中心（我的持仓）
- `pages/login/index` — 登录页

### 云函数
| 函数 | 用途 | 外部 API |
|---|---|---|
| `userLogin` | 获取 OPENID | 无 |
| `searchFund` | 按代码查基金 | 天天基金 |
| `fetchFundInfo` | 基金基本信息 | 天天基金 |
| `fetchFundEstimate` | 实时估算涨跌 | 天天基金 + 东方财富 |
| `fetchFundNAVHistory` | 历史净值 | 东方财富 |
| `fetchFundProfile` | 基金档案+持仓 | 东方财富（3 个接口并行） |
| `getPortfolio` | 持仓组合估值 | 天天基金 + 东方财富 |
| `createCollection` | 初始化数据库 | 无 |
| `ocrScreenshot` | 截图识别基金 | 微信 OCR + OCR.space |

### 数据库
- `holdings` 集合：`{ _openid, fundCode, fundName, amount, nav, createTime }`

### 部署
- 云函数：`cloudbase fn deploy --all --force`
- 小程序上传：`miniprogram-ci upload --pp . --pkp private.*.key --appid wx1473b1fa97b27717 -r 1`
