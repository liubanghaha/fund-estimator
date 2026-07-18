import cloudbase from '@cloudbase/js-sdk';

const app = cloudbase.init({ env: 'cloudbase-d0gug00io7bfedd97' });
const auth = app.auth({ persistence: 'local' });
let _ready = false;

async function ensureLogin() {
  if (_ready) return;
  const state = await auth.getLoginState();
  if (state?.user?.uid) { _ready = true; return; }
  await auth.anonymousAuthProvider().signIn();
  _ready = true;
}

export async function callFunction(name: string, data: Record<string, unknown> = {}) {
  await ensureLogin();
  console.log(`📞 ${name}`, data);
  const res = await app.callFunction({ name, data });
  return res;
}

export { auth };
