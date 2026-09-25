const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 一次性初始化集合。可传 only="集合名" 只建一个：一次连建 20+ 个会被云开发限流，
// 新加集合时用 only 单独建（否则排在后面的那个会静默建不成）
exports.main = async (event) => {
  const only = event && event.only;
  const results = [];
  const collections = ["holdings", "watchlist", "transactions", "feedback", "fund_temperatures", "profit_snapshots", "h5_bindings", "migration_codes", "fund_navs", "fund_holdings_cache", "fund_index_cache", "share_tokens", "promo_channels", "promo_visits", "ops_admins", "subscriptions", "push_logs", "analytics_launches", "events", "recall_state", "app_config", "alert_settings", "fund_estimate_deviations", "fund_fees"];
  const targets = only ? collections.filter((c) => c === only) : collections;
  if (only && targets.length === 0) return { code: -1, msg: `未知集合 ${only}` };

  for (const name of targets) {
    try {
      await db.createCollection(name);
      results.push(`${name}: 创建成功`);
    } catch (e) {
      if (e.errCode === -502005) {
        results.push(`${name}: 已存在`);
      } else {
        results.push(`${name}: ${e.message || "创建失败"}`);
      }
    }
  }

  return { code: 0, msg: results.join("; ") };
};
