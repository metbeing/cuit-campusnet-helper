#!/usr/bin/env node
/**
 * 校园网(成都信息工程大学 锐捷Portal/CAS 认证)自动登录脚本
 *
 * 流程:
 *   1. 确保连上校园网 WiFi(Cuit_WiFi), 检测网络: 204=已在线; 被劫持=未认证; 请求失败=网卡未就绪
 *   2. chromium 打开探测地址, 被网关重定向到门户登录页(保留 userip/usermac 参数)
 *   3. 在页面及所有 iframe 中找登录表单(门户的表单在 cas-sso 的 iframe 里)
 *   4. 填账号密码 -> 勾协议 -> 点「立即登录」-> 选择运营商
 *   5. 轮询确认联网成功
 *
 * 用法:
 *   node login.mjs           正常执行(开机任务调用的就是它)
 *   node login.mjs --check   只检测网络是否已通, 不开浏览器, 不需要账号密码
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(ROOT, 'logs');

const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });
/** 同时输出到控制台和 logs/run.log(计划任务隐藏运行时以文件日志为准) */
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'run.log'), line + '\n', 'utf8');
  } catch {
    /* 日志写不进去不影响登录流程 */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  for (const k of ['portalUrl', 'username', 'password', 'isp']) {
    if (!cfg[k]) throw new Error(`config.json 缺少字段: ${k}`);
    if (String(cfg[k]).includes('在这里填')) {
      throw new Error(`请先编辑 config.json 填好你的 ${k}(isp 填运营商名, 如 中国移动/中国电信/中国联通)`);
    }
  }
  return cfg;
}

let wifiFailCount = 0;
/** 发起 WiFi 连接: 调 wifi-connect.ps1(原生 WlanConnect 按配置文件名直连,
 *  不走 netsh 的网络枚举, 因此不需要系统位置服务和管理员权限) */
function ensureWifi(ssid) {
  if (!ssid) return;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'wifi-connect.ps1'), '-Name', ssid],
    { timeout: 20000, windowsHide: true },
    (err, stdout) => {
      const out = String(stdout || '').trim();
      if (err || !out.startsWith('OK')) {
        wifiFailCount++;
        if (wifiFailCount === 1 || wifiFailCount % 6 === 0) {
          log(`⚠ WiFi 连接失败(第${wifiFailCount}次): ${out || (err && err.message) || '未知错误'}`);
        }
      } else {
        log(`已发起 WiFi 连接: ${ssid}`);
      }
    }
  );
}

/**
 * 网络状态: online(已在线204) / captive(未认证但网卡已通) / offline(请求发不出去)
 */
async function netState(checkUrls, timeoutMs = 4000) {
  for (const url of checkUrls) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      return res.status === 204 ? 'online' : 'captive';
    } catch {
      /* 换下一个探测地址 */
    }
  }
  return 'offline';
}

async function waitOnline(checkUrls, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await netState(checkUrls)) === 'online') return true;
    await sleep(2000);
  }
  return false;
}

/** 校园网门户可达性(门户是纯内网 IP, 不依赖 DNS): 任何 HTTP 响应都说明在校园网内;
 *  无路由时(不在校园网) connect() 会立刻报错, 不会白等超时 */
async function isPortalAlive(portalUrl, timeoutMs = 2500) {
  try {
    await fetch(portalUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

async function screenshot(page, name) {
  try {
    const file = path.join(LOG_DIR, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log(`已保存截图: ${path.basename(file)}`);
  } catch {
    /* 页面可能已关闭 */
  }
}

/**
 * 在 page 的所有 frame(含主文档)里找登录表单
 * 优先按 placeholder 精确匹配, 找不到再退回 input[type=password]
 * 返回 { frame, pwd, acc } 定位器, 找不到返回 null
 */
async function findLoginForm(page) {
  const candidates = [];
  for (const frame of page.frames()) {
    const pwdByPh = frame.locator('input[placeholder*="密码"], input[placeholder*="password" i]').first();
    if (await pwdByPh.isVisible().catch(() => false)) {
      const acc = frame.locator('input[placeholder*="账号"], input[name="username" i], input[placeholder*="user" i]').first();
      candidates.push({ frame, pwd: pwdByPh, acc: (await acc.isVisible().catch(() => false)) ? acc : null });
    }
  }
  if (candidates.length) return candidates[0];
  for (const frame of page.frames()) {
    const pwd = frame.locator('input[type="password"]').first();
    if (await pwd.isVisible().catch(() => false)) {
      const acc = frame.locator('input[type="text"]:visible, input[type="tel"]:visible').first();
      candidates.push({ frame, pwd, acc: (await acc.isVisible().catch(() => false)) ? acc : null });
    }
  }
  return candidates[0] || null;
}

/** 等登录表单出现(跨 frame) */
async function waitForLoginForm(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await findLoginForm(page)) return true;
    await sleep(1000);
  }
  return false;
}

/** 勾选协议: 真复选框 -> 自定义样式复选框 -> "请先阅读并同意"文字本身 */
async function agreeProtocol(frame) {
  const realBox = frame.locator('input[type="checkbox"]').first();
  if (await realBox.isVisible().catch(() => false)) {
    try {
      if (!(await realBox.isChecked())) await realBox.check({ force: true, timeout: 3000 });
      if (await realBox.isChecked()) return log('已勾选协议(复选框)');
    } catch {
      /* 继续走自定义样式兜底 */
    }
  }
  const custom = frame.locator('[class*="checkbox" i]:visible, [class*="check-box" i]:visible, [class*="agree" i]:visible').first();
  if (await custom.isVisible().catch(() => false)) {
    await custom.click({ timeout: 3000, force: true }).catch(() => {});
    return log('已尝试点击自定义协议勾选框');
  }
  const label = frame.getByText('请先阅读并同意').first();
  if (await label.isVisible().catch(() => false)) {
    await label.click({ timeout: 3000 }).catch(() => {});
    return log('已尝试点击协议文字');
  }
  log('未找到协议勾选框(可能不需要)');
}

/** 点击「立即登录」类按钮 */
async function clickLoginButton(frame) {
  const bad = /注销|退出|下线|自助|帮助|注册|忘记|修改/;
  const good = /登\s*录|上\s*网|认\s*证|login/i;
  const btns = await frame.locator('button, input[type="submit"], [role="button"], a').all();
  for (const b of btns) {
    const text = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').trim();
    if (text && text.length <= 8 && good.test(text) && !bad.test(text)) {
      if (await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 5000 });
        return log(`已点击「${text}」`);
      }
    }
  }
  throw new Error('找不到「立即登录」按钮');
}

/** 运营商候选名: 配置值 + 去掉"中国"前缀的短名(页面选项常写"移动/电信/联通") */
function ispCandidates(isp) {
  const short = isp.replace(/^中国/, '');
  const alias = { 移动: '中国移动', 电信: '中国电信', 联通: '中国联通' };
  return [...new Set([isp, short, alias[isp]].filter(Boolean))];
}

/**
 * "请选择服务"页: 点选运营商 -> 点「确定」
 * 页面选项文字可能是"移动"(非"中国移动"), 用候选名逐个精确匹配
 */
async function chooseService(page, isp, timeoutMs) {
  const cands = ispCandidates(isp);
  const deadline = Date.now() + timeoutMs;
  let seenTexts = [];
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const res = await frame
        .evaluate((candidates) => {
          const vis = (el) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 5 && r.height > 5;
          };
          // 叶子元素 + 按钮/列表项/标签, 取文字完全相等的那个
          const nodes = [...document.querySelectorAll('button, a, li, label, [role="button"], [role="radio"], span, div')]
            .filter(vis)
            .filter((el) => el.children.length === 0 || /^(BUTTON|LI|LABEL|A)$/.test(el.tagName));
          const texts = [...new Set(nodes.map((el) => (el.innerText || '').trim()).filter((t) => t && t.length <= 8))];
          for (const c of candidates) {
            const hit = nodes.find((el) => (el.innerText || '').trim() === c);
            if (hit) {
              hit.click();
              // 有些实现需要点整行/整卡片才生效, 再补一次最近的可点击祖先
              let p = hit.parentElement;
              for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
                const style = getComputedStyle(p);
                if (style.cursor === 'pointer' || /^(BUTTON|LI|LABEL|A)$/.test(p.tagName)) {
                  p.click();
                  break;
                }
              }
              return { clicked: c, texts };
            }
          }
          return { clicked: null, texts };
        }, cands)
        .catch(() => ({ clicked: null, texts: [] }));

      if (res.clicked) {
        log(`已选择服务: ${res.clicked}`);
        await sleep(700);
        // 点「确定」提交
        let confirmed = false;
        for (const b of await frame.locator('button:visible, [role="button"]:visible').all()) {
          const t = ((await b.innerText().catch(() => '')) || '').trim();
          if (/^确\s*定$|^确\s*认$/.test(t)) {
            await b.click({ timeout: 5000 }).catch(() => {});
            log('已点击「确定」');
            confirmed = true;
            break;
          }
        }
        if (!confirmed) log('未找到「确定」按钮(可能选中即自动提交)');
        return true;
      }
      if (res.texts.length) seenTexts = res.texts;
    }
    await sleep(800);
  }

  // 超时兜底: 页面可能已预选, 直接试一次「确定」
  log(`未见服务选项(候选: ${cands.join('/')}), 可见文字: ${seenTexts.slice(0, 12).join(' | ') || '(空)'}`);
  for (const frame of page.frames()) {
    for (const b of await frame.locator('button:visible').all()) {
      const t = ((await b.innerText().catch(() => '')) || '').trim();
      if (/^确\s*定$/.test(t)) {
        await b.click({ timeout: 5000 }).catch(() => {});
        log('已兜底点击「确定」');
        return true;
      }
    }
  }
  return false;
}

async function doLogin(cfg, attempt) {
  const portalHost = new URL(cfg.portalUrl).host;
  const browser = await chromium.launch({ headless: !!cfg.headless });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    // 先访问探测地址, 未认证时网关会 302 到带 userip/usermac 参数的门户入口
    try {
      await page.goto(cfg.checkUrls[0], { timeout: 20000, waitUntil: 'domcontentloaded' });
    } catch {
      /* 超时也继续, 下面直接开门户 */
    }
    if (!page.url().includes(portalHost)) {
      await page.goto(cfg.portalUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    log(`第${attempt}次尝试, 当前页面: ${page.url()}`);

    if (!(await waitForLoginForm(page, 25000))) {
      await screenshot(page, 'fail-无登录表单');
      throw new Error('25s 内未出现登录表单');
    }

    const { frame, pwd, acc } = await findLoginForm(page);
    if (acc) {
      const current = (await acc.inputValue().catch(() => '')) || '';
      if (!current.trim()) {
        await acc.fill(cfg.username, { timeout: 5000 });
        log('已填写账号');
      } else {
        log(`表单已带出账号(${current.slice(0, 3)}***), 不重复填写`);
      }
    } else {
      log('未发现账号输入框(页面应已自动带出账号)');
    }
    await pwd.fill(cfg.password, { timeout: 5000 });
    log('已填写密码');

    await agreeProtocol(frame);
    await sleep(800);
    await clickLoginButton(frame);

    // 登录后弹出"请选择服务": 选运营商 -> 确定
    await chooseService(page, cfg.isp, 15000);
    return true;
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const checkOnly = process.argv.slice(2).includes('--check');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

  if (checkOnly) {
    const st = await netState(raw.checkUrls);
    log(st === 'online' ? '网络已通(已在线) ✓' : `网络未通(${st === 'captive' ? '未认证, 需登录' : '网卡未就绪/无网络'})`);
    return st === 'online' ? 0 : 1;
  }

  // 等网卡就绪: 仅在确认离线时才发连接指令(节流 5s, 避免在线后多发导致二次闪断), captive 立刻开始登录
  log('检测网络...');
  const deadline = Date.now() + (raw.waitNetworkSeconds || 90) * 1000;
  let st = await netState(raw.checkUrls);
  let lastWifiAttempt = 0;
  while (st === 'offline' && Date.now() < deadline) {
    const now = Date.now();
    if (now - lastWifiAttempt >= 5000) {
      ensureWifi(raw.wifiName);
      lastWifiAttempt = now;
    }
    await sleep(1500);
    st = await netState(raw.checkUrls);
  }
  if (st === 'online') {
    log('已在线, 无需登录 ✓');
    return 0;
  }
  // 统一前置门禁: 无论 offline(无网络/网卡未就绪) 还是 captive(可能是别处的认证页),
  // 都先确认校园网门户可达 —— 门户是纯内网 IP 且不依赖 DNS, 只有真在校园网才可能连通。
  // 不可达即判定"不在校园网", 干净退出, 不做任何改动、不空转。
  let portalAlive = false;
  for (let i = 0; i < 2 && !portalAlive; i++) {
    if (i) await sleep(1500);
    portalAlive = await isPortalAlive(raw.portalUrl);
  }
  if (!portalAlive) {
    log(`未联网(${st})且校园网门户不可达 → 判定当前不在校园网环境, 直接退出(不做任何改动)`);
    return 0;
  }
  log('校园网门户可达, 继续登录流程');

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    log(`✗ ${e.message}`);
    return 2;
  }

  const maxAttempts = cfg.maxAttempts || 3;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      if (await doLogin(cfg, i) && (await waitOnline(cfg.checkUrls, 45000))) {
        log('=== 校园网登录成功, 网络已通 ✓ ===');
        return 0;
      }
      log('登录动作完成但联网检测未通过(账号密码有误? 运营商未点中?)');
    } catch (e) {
      log(`第${i}次尝试失败: ${e.message}`);
    }
    if (i < maxAttempts) {
      log(`${cfg.attemptIntervalSeconds || 10}s 后重试...`);
      await sleep((cfg.attemptIntervalSeconds || 10) * 1000);
    }
  }
  log('=== 自动登录失败, 详见 logs/ 目录截图, 可把截图发我排查 ===');
  return 1;
}

process.exitCode = await main();
