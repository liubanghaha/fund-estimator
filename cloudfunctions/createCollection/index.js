const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const results = [];
  const collections = ["holdings", "watchlist", "transactions", "feedback", "fund_temperatures", "profit_snapshots", "h5_bindings", "migration_codes", "fund_navs", "fund_holdings_cache", "share_tokens", "promo_channels", "promo_visits", "ops_admins", "subscriptions", "push_logs", "analytics_launches", "app_config", "alert_settings"];

  for (const name of collections) {
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
