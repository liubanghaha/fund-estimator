/**
 * 本地开发代理 — 用 CloudBase Node SDK 调用云函数
 * 前端通过这个代理调用云函数，绕过 Web SDK 的登录限制
 * 使用方式：node dev-proxy.mjs
 */
import express from 'express';
import cors from 'cors';
import cloudbase from '@cloudbase/node-sdk';

const app = express();
app.use(cors());
app.use(express.json());

const tcb = cloudbase.init({ env: 'cloudbase-d0gug00io7bfedd97' });

app.post('/api/:functionName', async (req, res) => {
  const { functionName } = req.params;
  const data = req.body || {};

  console.log(`📞 ${functionName}(${JSON.stringify(data).slice(0, 100)})`);

  try {
    const result = await tcb.callFunction({ name: functionName, data });
    console.log(`✅ ${functionName} →`, JSON.stringify(result).slice(0, 150));
    res.json(result);
  } catch (e) {
    console.error(`❌ ${functionName} 失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 代理已启动: http://localhost:${PORT}`);
  console.log('   H5 前端将通过此代理调用云函数\n');
});
