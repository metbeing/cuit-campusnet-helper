/** E2E 测试: 注销当前会话 -> 立即用 login.mjs 自动登录 -> 验证联网
 *  一条命令跑完, 结果全部落盘 logs/run.log */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

async function netState() {
  for (const url of cfg.checkUrls) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      return res.status === 204 ? 'online' : 'captive';
    } catch {}
  }
  return 'offline';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findLoginForm(page) {
  for (const frame of page.frames()) {
    const pwd = frame.locator('input[placeholder*="密码"], input[placeholder*="password" i]').first();
    if (await pwd.isVisible().catch(() => false)) {
      const acc = frame.locator('input[placeholder*="账号"], input[name="username" i]').first();
      return { frame, pwd, acc: (await acc.isVisible().catch(() => false)) ? acc : null };
    }
  }
  return null;
}

console.log('[e2e] 步骤1: 登录自助中心...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto('http://10.254.241.66/self/', { timeout: 30000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const form = await findLoginForm(page);
if (!form) throw new Error('自助中心登录表单未出现');
if (form.acc) await form.acc.fill(cfg.username);
await form.pwd.fill(cfg.password);
const box = form.frame.locator('input[type="checkbox"]').first();
if (await box.isVisible().catch(() => false) && !(await box.isChecked())) await box.check({ force: true });
for (const b of await form.frame.locator('button').all()) {
  const t = ((await b.innerText().catch(() => '')) || '').trim();
  if (/^(立即)?登\s*录$/.test(t) && (await b.isVisible().catch(() => false))) { await b.click(); break; }
}
await page.waitForTimeout(8000);
console.log('[e2e] 登录后:', page.url().slice(0, 70));

console.log('[e2e] 步骤2: 打开在线设备页, 点击「下线」...');
await page.goto('http://10.254.241.66/self/my-devices', { timeout: 30000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const offBtn = page.locator('button', { hasText: /^下线$/ }).first();
await offBtn.click({ timeout: 8000 });
console.log('[e2e] 已点击「下线」');
// 若弹出确认框(页面内), 点确认
await sleep(1500);
for (const b of await page.locator('button:visible').all()) {
  const t = ((await b.innerText().catch(() => '')) || '').trim();
  if (/^(确\s*定|确\s*认)$/.test(t)) { await b.click(); console.log('[e2e] 已点确认'); break; }
}
await browser.close();

console.log('[e2e] 步骤3: 等待会话注销生效...');
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  const st = await netState();
  if (st !== 'online') { console.log(`[e2e] 网络已断开(state=${st}), 开始自动登录`); break;
  }
}

console.log('[e2e] 步骤4: 运行 login.mjs ...');
try {
  const out = execFileSync('node', ['login.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out.trimEnd());
} catch (e) {
  console.log((e.stdout || '') + '\n' + (e.stderr || ''));
}

const st = await netState();
console.log(`[e2e] 最终网络状态: ${st} ${st === 'online' ? '✓ E2E 测试通过' : '✗ 仍不在线, 需手动登录恢复'}`);
process.exit(st === 'online' ? 0 : 1);
