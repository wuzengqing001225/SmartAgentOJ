const { execFile, execFileSync } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { randomUUID } = require('crypto');
const bcrypt  = require('bcryptjs');
const session = require('express-session');

// ============================================================
// 目录与配置初始化
// ============================================================
const dataDir       = path.join(__dirname, '..', 'data');
const usersDir      = path.join(dataDir, 'users');
const problemsFile  = path.join(dataDir, 'problems.json');
const configPath    = path.join(dataDir, 'config.json');
const promptsPath   = path.join(dataDir, 'prompts.json');
const accountsFile  = path.join(usersDir, 'accounts.json');
const passwordsFile = path.join(usersDir, 'passwords.json');

fs.mkdirSync(usersDir, { recursive: true });

// 自动迁移旧的根目录 config.json
const oldConfigPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath) && fs.existsSync(oldConfigPath)) {
  fs.copyFileSync(oldConfigPath, configPath);
  fs.unlinkSync(oldConfigPath);
  console.log('[配置] config.json 已迁移到 data/config.json');
}
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({ deepseekApiKey: 'YOUR_API_KEY_HERE' }, null, 2));
}

let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// ============================================================
// 登录失败计数（内存，重启清零；锁定状态持久化到 accounts.json）
// ============================================================
// 锁定状态写在 account.lockedAt 字段里，failCount 写在 account.loginFailCount
function getLoginFailCount(account) {
  return account.loginFailCount || 0;
}

function isAccountLocked(account) {
  return !!account.locked;
}

function recordLoginFail(accountId) {
  const accounts = loadAccounts();
  if (!accounts[accountId]) return;
  const maxAttempts = config.loginMaxAttempts ?? 5;
  accounts[accountId].loginFailCount = (accounts[accountId].loginFailCount || 0) + 1;
  if (accounts[accountId].loginFailCount >= maxAttempts) {
    accounts[accountId].locked   = true;
    accounts[accountId].lockedAt = new Date().toISOString();
  }
  saveAccounts(accounts);
}

function resetLoginFail(accountId) {
  const accounts = loadAccounts();
  if (!accounts[accountId]) return;
  accounts[accountId].loginFailCount = 0;
  accounts[accountId].locked         = false;
  accounts[accountId].lockedAt       = null;
  saveAccounts(accounts);
}

function unlockAccount(accountId) {
  resetLoginFail(accountId);
}

// macOS SDK
let macosxSdkArgs = [];
if (process.platform === 'darwin') {
  try {
    const sdkPath = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf-8' }).trim();
    macosxSdkArgs = ['-isysroot', sdkPath, `-I${sdkPath}/usr/include/c++/v1`];
  } catch {}
}

// ============================================================
// 账号系统
// ============================================================
function loadAccounts() {
  try {
    if (fs.existsSync(accountsFile)) return JSON.parse(fs.readFileSync(accountsFile, 'utf-8'));
  } catch {}
  return {};
}

function saveAccounts(accounts) {
  fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
}

function loadPasswords() {
  try {
    if (fs.existsSync(passwordsFile)) return JSON.parse(fs.readFileSync(passwordsFile, 'utf-8'));
  } catch {}
  return {};
}

function savePasswords(passwords) {
  fs.writeFileSync(passwordsFile, JSON.stringify(passwords, null, 2));
}

function generateAccountId(existingIds) {
  const chars = '0123456789abcdef'; // 纯十六进制，编号可直接作为 CSS 颜色
  const existing = new Set(existingIds);
  let id = '';
  do {
    id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (existing.has(id));
  return id;
}

// ============================================================
// 用户数据目录路径辅助
// ============================================================
function getUserDir(userId) {
  return path.join(usersDir, userId);
}

function getUserStudentDir(userId) {
  return path.join(getUserDir(userId), 'student');
}

function getUserProblemsDir(userId) {
  return path.join(getUserDir(userId), 'problems');
}

function ensureUserDirs(userId) {
  fs.mkdirSync(getUserStudentDir(userId), { recursive: true });
  fs.mkdirSync(getUserProblemsDir(userId), { recursive: true });
}

// ============================================================
// Prompts — 从 prompts.json 加载，方便修改
// ============================================================
let PROMPTS = {};

function loadPrompts() {
  try {
    if (fs.existsSync(promptsPath)) {
      PROMPTS = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
    } else {
      console.warn('[提示词] prompts.json 不存在');
    }
  } catch (e) {
    console.warn('[提示词] 加载失败：', e.message);
  }
}

loadPrompts();

// ============================================================
// 题库加载
// ============================================================
let problemsData = {};
if (fs.existsSync(problemsFile)) {
  try {
    problemsData = JSON.parse(fs.readFileSync(problemsFile, 'utf-8'));
    console.log(`[题库] 已加载 ${Object.keys(problemsData).length} 道题目`);
  } catch (e) { console.warn('[题库] 加载失败：', e.message); }
}

// ============================================================
// 用量统计持久化（按日）
// ============================================================
const PRICING = { prompt: 0.14, completion: 0.28 };

function getUserUsageFile(userId) {
  return path.join(getUserStudentDir(userId), 'usage.json');
}

function loadUserUsage(userId) {
  const file = getUserUsageFile(userId);
  try {
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return {
        dailyRecords: d.dailyRecords || {},
        total: d.total || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      };
    }
  } catch {}
  return { dailyRecords: {}, total: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 } };
}

function saveUserUsage(userId, usage) {
  ensureUserDirs(userId);
  fs.writeFileSync(getUserUsageFile(userId), JSON.stringify(usage, null, 2));
}

function recordUsage(userId, usageData) {
  const usage = loadUserUsage(userId);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (!usage.dailyRecords[today]) {
    usage.dailyRecords[today] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
  }
  const day = usage.dailyRecords[today];
  day.calls          += 1;
  day.promptTokens   += usageData.promptTokens     || 0;
  day.completionTokens += usageData.completionTokens || 0;
  day.totalTokens    += usageData.totalTokens      || 0;
  day.cost           += usageData.cost             || 0;
  usage.total.calls          += 1;
  usage.total.promptTokens   += usageData.promptTokens     || 0;
  usage.total.completionTokens += usageData.completionTokens || 0;
  usage.total.totalTokens    += usageData.totalTokens      || 0;
  usage.total.cost           += usageData.cost             || 0;
  saveUserUsage(userId, usage);
}

// ============================================================
// 回顾数据持久化（用户级）
// ============================================================
function getUserReviewFile(userId) {
  return path.join(getUserStudentDir(userId), 'review.json');
}

function loadReview(userId) {
  try {
    const f = getUserReviewFile(userId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {}
  return [];
}

function saveReview(userId, data) {
  ensureUserDirs(userId);
  fs.writeFileSync(getUserReviewFile(userId), JSON.stringify(data, null, 2));
}

// ============================================================
// 自定义题目 ID 管理（用户级）
// ============================================================
function getUserCustomProbFile(userId) {
  return path.join(getUserStudentDir(userId), 'custom_problems.json');
}

function loadCustomProblems(userId) {
  try {
    const f = getUserCustomProbFile(userId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {}
  return {};
}

function saveCustomProblems(userId, data) {
  ensureUserDirs(userId);
  fs.writeFileSync(getUserCustomProbFile(userId), JSON.stringify(data, null, 2));
}

function generateCustomId(existingIds) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const existing = new Set(existingIds);
  let id = '';
  do {
    id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (existing.has(id));
  return id;
}

// ============================================================
// 题目文件夹路径辅助函数（用户级）
// ============================================================
function safeName(name, maxLen = 64) {
  return String(name).replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, maxLen) || 'unknown';
}

function getProblemDir(userId, problemId) {
  return path.join(getUserProblemsDir(userId), safeName(problemId));
}

function getSessionsDir(userId, problemId) {
  return path.join(getProblemDir(userId, problemId), 'sessions');
}

function getCodesDir(userId, problemId) {
  return path.join(getProblemDir(userId, problemId), 'codes');
}

function ensureProblemDirs(userId, problemId) {
  fs.mkdirSync(getSessionsDir(userId, problemId), { recursive: true });
  fs.mkdirSync(getCodesDir(userId, problemId),    { recursive: true });
}

function codeQaFilePath(userId, problemId) {
  return path.join(getProblemDir(userId, problemId), 'code-qa.json');
}

// ============================================================
// 对话进程 CRUD
// ============================================================
function sessionFilePath(userId, problemId, key) {
  return path.join(getSessionsDir(userId, problemId), `${safeName(key)}.json`);
}

function listSessions(userId, problemId) {
  const dir = getSessionsDir(userId, problemId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          return {
            key:          d.key || f.replace('.json', ''),
            name:         d.name || d.key || f.replace('.json', ''),
            messageCount: (d.history || []).length,
            updatedAt:    d.updatedAt || null,
            createdAt:    d.createdAt || null,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.key === 'main') return -1;
        if (b.key === 'main') return 1;
        return (a.createdAt || '').localeCompare(b.createdAt || '');
      });
  } catch { return []; }
}

function loadSession(userId, problemId, key) {
  const p = sessionFilePath(userId, problemId, key);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function createSession(userId, problemId, preferredName) {
  const existing = listSessions(userId, problemId);
  let key;
  if (!existing.find(s => s.key === 'main')) {
    key = 'main';
  } else {
    const subCount = existing.filter(s => s.key !== 'main').length;
    key = `sub${subCount + 1}`;
  }
  const name = preferredName || key;
  const now  = new Date().toISOString();
  const data = { key, name, history: [], createdAt: now, updatedAt: now };
  ensureProblemDirs(userId, problemId);
  fs.writeFileSync(sessionFilePath(userId, problemId, key), JSON.stringify(data, null, 2));
  return { key, name };
}

function saveSessionHistory(userId, problemId, key, history, blocks) {
  ensureProblemDirs(userId, problemId);
  const existing = loadSession(userId, problemId, key) || {};
  const data = {
    key:       existing.key   || key,
    name:      existing.name  || key,
    history:   history || [],
    blocks:    blocks || existing.blocks || [],
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sessionFilePath(userId, problemId, key), JSON.stringify(data, null, 2));
}

function renameSession(userId, problemId, key, newName) {
  const p = sessionFilePath(userId, problemId, key);
  if (!fs.existsSync(p)) return false;
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  data.name      = newName.trim();
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return true;
}

function deleteSession(userId, problemId, key) {
  const p = sessionFilePath(userId, problemId, key);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ============================================================
// 代码文件 CRUD
// ============================================================
function generateCodeFilename(problemId, userId) {
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const dd  = String(now.getDate()).padStart(2, '0');
  const hh  = String(now.getHours()).padStart(2, '0');
  const mi  = String(now.getMinutes()).padStart(2, '0');
  const base = `${problemId}-${yy}${mm}${dd}-${hh}${mi}`;

  if (!userId) return base;

  const dir = getCodesDir(userId, problemId);
  if (!fs.existsSync(dir)) return base;

  const existing = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));

  if (!existing.includes(base)) return base;

  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function codeFilePath(userId, problemId, filename) {
  return path.join(getCodesDir(userId, problemId), `${safeName(filename)}.json`);
}

function listCodes(userId, problemId) {
  const dir = getCodesDir(userId, problemId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          return {
            filename:    d.filename || f.replace('.json', ''),
            description: d.description || '',
            createdAt:   d.createdAt || null,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  } catch { return []; }
}

function loadCode(userId, problemId, filename) {
  const p = codeFilePath(userId, problemId, filename);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function saveCode(userId, problemId, filename, code, description) {
  ensureProblemDirs(userId, problemId);
  const existing = loadCode(userId, problemId, filename) || {};
  const data = {
    filename,
    code:        code        !== undefined ? code        : (existing.code || ''),
    description: description !== undefined ? description : (existing.description || ''),
    createdAt:   existing.createdAt || new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };
  fs.writeFileSync(codeFilePath(userId, problemId, filename), JSON.stringify(data, null, 2));
  return data;
}

// ============================================================
// 每日调用次数限制检查
// ============================================================
function checkDailyLimit(userId, role, tempApiKey) {
  if (tempApiKey) return null; // 用户使用个人 key，无限制

  const limits = config.dailyCallLimit || {};
  const limit  = limits[role] ?? 50;
  if (limit < 0) return null; // -1 = 无限制

  const today   = new Date().toISOString().slice(0, 10);
  const usage   = loadUserUsage(userId);
  const todayCalls = (usage.dailyRecords[today] || {}).calls || 0;
  if (todayCalls >= limit) {
    return `今日调用次数已达上限（${limit} 次），请明天再试`;
  }
  return null;
}

// ============================================================
// DeepSeek API 调用（复用）
// ============================================================
async function callDeepSeek(messages, { temperature = 0.7, max_tokens = 4096 } = {}, userId = null, sessionApiKey = null) {
  // 优先使用会话内用户自己上传的 key
  const apiKey = sessionApiKey || config.deepseekApiKey;
  if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') throw new Error('请在设置中配置 DeepSeek API Key');

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: 'deepseek-chat', messages, max_tokens, temperature }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const usage = data.usage || {};
  const cost  = (usage.prompt_tokens || 0) * PRICING.prompt / 1e6 +
                (usage.completion_tokens || 0) * PRICING.completion / 1e6;

  if (userId) {
    recordUsage(userId, {
      promptTokens:     usage.prompt_tokens     || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens:      usage.total_tokens      || 0,
      cost,
    });
  }

  return { reply: data.choices?.[0]?.message?.content || '' };
}

// ============================================================
const _wm = Buffer.from('WmVuZ3FpbmcgV3UgfCB3dXplbmdxaW5nQG91dGxvb2suY29t', 'base64').toString();

// ============================================================
// Routes
// ============================================================
module.exports = function (app) {

  // Session 配置（secret 从 config.json 读取）
  app.use(session({
    secret: config.sessionSecret || 'sng-smartoj-fallback-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }, // 7天
  }));

  app.use((_req, res, next) => {
    res.setHeader('X-Powered-By', `SNG/${Buffer.from(_wm).toString('base64').slice(0, 8)}`);
    res.setHeader('X-App-Rev',    `${Buffer.from(_wm).toString('base64')}`);
    next();
  });

  // 认证中间件
  function requireAuth(req, res, next) {
    if (!req.session.userId) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: '请先登录', needLogin: true });
      }
      return res.redirect('/login');
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ success: false, error: '请先登录', needLogin: true });
    const role = req.session.role;
    if (role !== 'admin' && role !== 'superadmin') {
      return res.status(403).json({ success: false, error: '权限不足' });
    }
    next();
  }

  function requireSuperAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ success: false, error: '请先登录', needLogin: true });
    if (req.session.role !== 'superadmin') {
      return res.status(403).json({ success: false, error: '需要超级管理员权限' });
    }
    next();
  }

  // ── 页面路由 ──────────────────────────────────────────────
  app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('login');
  });

  app.get('/', requireAuth, (req, res) => res.render('index'));

  app.get('/admin', requireAdmin, (req, res) => res.render('admin'));

  // ── 认证 API ──────────────────────────────────────────────

  // 登录
  app.post('/api/auth/login', (req, res) => {
    let { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: '请填写用户名和密码' });

    // 防御性去掉 # 前缀（不论前端是否已处理）
    username = username.replace(/^#+/, '').trim();

    const accounts  = loadAccounts();
    const passwords = loadPasswords();

    // 支持用账号编号或用户名登录
    let account = null;
    if (accounts[username]) {
      account = accounts[username];
    } else {
      account = Object.values(accounts).find(a => a.username === username);
    }

    if (!account) return res.json({ success: false, error: '账号不存在' });

    // 检查是否已停用
    if (account.disabled) {
      return res.json({ success: false, error: '账号已被停用，请联系管理员', disabled: true });
    }

    // 检查是否已锁定
    if (isAccountLocked(account)) {
      return res.json({ success: false, error: '账号已被锁定，请联系管理员解锁', locked: true });
    }

    const hash = passwords[account.id];
    if (!hash || !bcrypt.compareSync(password, hash)) {
      recordLoginFail(account.id);
      // 重新读取最新状态，返回剩余次数
      const updated   = loadAccounts()[account.id];
      const maxAttempts = config.loginMaxAttempts ?? 5;
      const failCount   = updated.loginFailCount || 0;
      if (updated.locked) {
        return res.json({ success: false, error: '密码错误次数过多，账号已被锁定，请联系管理员解锁', locked: true });
      }
      const remaining = maxAttempts - failCount;
      return res.json({ success: false, error: `密码错误，还可尝试 ${remaining} 次` });
    }

    // 登录成功，重置失败计数
    resetLoginFail(account.id);

    req.session.userId     = account.id;
    req.session.username   = account.username;
    req.session.role       = account.role;
    req.session.tempApiKey = null;

    res.json({ success: true, user: { id: account.id, username: account.username, role: account.role } });
  });

  // 注册
  app.post('/api/auth/register', (req, res) => {
    const { email, username, password, displayName, studentId } = req.body;
    if (!email || !username || !password) return res.json({ success: false, error: '请填写邮箱、用户名和密码' });
    if (password.length < 6) return res.json({ success: false, error: '密码至少6位' });
    if (studentId && !/^\d{12}$/.test(studentId)) return res.json({ success: false, error: '学生证编号需为12位数字' });

    const accounts  = loadAccounts();
    const passwords = loadPasswords();

    // 用户名重名检查
    if (Object.values(accounts).some(a => a.username === username)) {
      return res.json({ success: false, error: '用户名已被使用，请换一个' });
    }

    const newId = generateAccountId(Object.keys(accounts));
    const hash  = bcrypt.hashSync(password, 12);

    accounts[newId] = {
      id: newId,
      email,
      username,
      displayName: displayName || '',
      studentId:   studentId   || '',
      role: 'user',
      createdAt: new Date().toISOString(),
    };
    passwords[newId] = hash;

    saveAccounts(accounts);
    savePasswords(passwords);
    ensureUserDirs(newId);

    res.json({ success: true, accountId: newId });
  });

  // 登出
  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  // 获取当前用户信息
  app.get('/api/auth/me', (req, res) => {
    if (!req.session.userId) return res.json({ success: false, loggedIn: false });
    const accounts = loadAccounts();
    const account  = accounts[req.session.userId];
    if (!account) return res.json({ success: false, loggedIn: false });
    res.json({ success: true, loggedIn: true, user: {
      id: account.id,
      email: account.email,
      username: account.username,
      displayName: account.displayName || '',
      studentId: account.studentId || '',
      role: account.role,
    }});
  });

  // 用户上传个人临时 API Key（会话级，退出清除）
  app.post('/api/auth/temp-apikey', requireAuth, (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey?.startsWith('sk-')) return res.json({ success: false, error: 'API Key 格式不正确（应以 sk- 开头）' });
    req.session.tempApiKey = apiKey;
    res.json({ success: true });
  });

  app.delete('/api/auth/temp-apikey', requireAuth, (req, res) => {
    req.session.tempApiKey = null;
    res.json({ success: true });
  });

  // ── 管理员 API ────────────────────────────────────────────

  // 获取所有用户列表
  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const accounts = loadAccounts();
    const users = Object.values(accounts).map(u => {
      const usage = loadUserUsage(u.id);
      return {
        ...u,
        totalCalls:    usage.total.calls || 0,
        totalCost:     usage.total.cost  || 0,
        locked:        !!u.locked,
        disabled:      !!u.disabled,
        loginFailCount: u.loginFailCount || 0,
      };
    });
    res.json({ success: true, users });
  });

  // 解锁账号（管理员）
  app.post('/api/admin/users/:id/unlock', requireAdmin, (req, res) => {
    const accounts = loadAccounts();
    if (!accounts[req.params.id]) return res.json({ success: false, error: '用户不存在' });
    unlockAccount(req.params.id);
    res.json({ success: true });
  });

  // 停用账号（管理员）
  app.post('/api/admin/users/:id/disable', requireAdmin, (req, res) => {
    const accounts = loadAccounts();
    if (!accounts[req.params.id]) return res.json({ success: false, error: '用户不存在' });
    accounts[req.params.id].disabled   = true;
    accounts[req.params.id].disabledAt = new Date().toISOString();
    saveAccounts(accounts);
    res.json({ success: true });
  });

  // 复原账号（管理员）
  app.post('/api/admin/users/:id/enable', requireAdmin, (req, res) => {
    const accounts = loadAccounts();
    if (!accounts[req.params.id]) return res.json({ success: false, error: '用户不存在' });
    accounts[req.params.id].disabled   = false;
    accounts[req.params.id].disabledAt = null;
    saveAccounts(accounts);
    res.json({ success: true });
  });

  // 导出指定用户的全部对话内容为 JSON（管理员）
  app.get('/api/admin/users/:id/conversations', requireAdmin, (req, res) => {
    const userId = req.params.id;
    const accounts = loadAccounts();
    if (!accounts[userId]) return res.json({ success: false, error: '用户不存在' });
    const probsDir = getUserProblemsDir(userId);
    const rows = [];
    if (fs.existsSync(probsDir)) {
      for (const probId of fs.readdirSync(probsDir)) {
        const sessionsDir = getSessionsDir(userId, probId);
        if (!fs.existsSync(sessionsDir)) continue;
        for (const f of fs.readdirSync(sessionsDir).filter(x => x.endsWith('.json'))) {
          try {
            const sess = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
            const history = sess.history || [];
            for (let i = 0; i < history.length; i++) {
              const m = history[i];
              if (m.role === 'user') {
                const next = history[i + 1];
                rows.push({
                  userId,
                  username: accounts[userId].username || '',
                  problemId: probId,
                  sessionKey: sess.key || f.replace('.json', ''),
                  sessionName: sess.name || sess.key || '',
                  userMessage: m.content || '',
                  aiReply: (next && next.role === 'assistant') ? next.content : '',
                });
                if (next && next.role === 'assistant') i++;
              }
            }
          } catch {}
        }
      }
    }
    res.json({ success: true, rows });
  });

  // 修改用户信息（管理员）
  app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
    const { email, username, displayName, studentId } = req.body;
    const accounts = loadAccounts();
    if (!accounts[req.params.id]) return res.json({ success: false, error: '用户不存在' });

    const account = accounts[req.params.id];
    if (email        !== undefined) account.email        = email;
    if (username     !== undefined) account.username     = username;
    if (displayName  !== undefined) account.displayName  = displayName;
    if (studentId    !== undefined) account.studentId    = studentId;

    saveAccounts(accounts);
    res.json({ success: true });
  });

  // 重置用户密码（管理员）
  app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.json({ success: false, error: '新密码至少6位' });
    const accounts  = loadAccounts();
    const passwords = loadPasswords();
    if (!accounts[req.params.id]) return res.json({ success: false, error: '用户不存在' });
    passwords[req.params.id] = bcrypt.hashSync(newPassword, 12);
    savePasswords(passwords);
    res.json({ success: true });
  });

  // 修改用户角色（仅超级管理员）
  app.patch('/api/admin/users/:id/role', requireSuperAdmin, (req, res) => {
    const { role } = req.body;
    if (!['user', 'palacestudent', 'admin', 'superadmin'].includes(role)) {
      return res.json({ success: false, error: '无效的角色' });
    }
    const accounts = loadAccounts();
    if (!accounts[req.params.id]) return res.json({ success: false, error: '用户不存在' });

    // 超级管理员数量限制：最多3个
    if (role === 'superadmin') {
      const superAdminCount = Object.values(accounts).filter(a => a.role === 'superadmin').length;
      if (superAdminCount >= 3 && accounts[req.params.id].role !== 'superadmin') {
        return res.json({ success: false, error: '超级管理员最多3个' });
      }
    }
    // 不能低于1个超级管理员
    if (accounts[req.params.id].role === 'superadmin' && role !== 'superadmin') {
      const superAdminCount = Object.values(accounts).filter(a => a.role === 'superadmin').length;
      if (superAdminCount <= 1) {
        return res.json({ success: false, error: '至少保留1个超级管理员' });
      }
    }

    accounts[req.params.id].role = role;
    saveAccounts(accounts);
    res.json({ success: true });
  });

  // 管理员查看题库（全部 problems.json）
  app.get('/api/admin/problems', requireAdmin, (req, res) => {
    res.json({ success: true, problems: problemsData });
  });

  // 管理员添加题目到 problems.json
  app.post('/api/admin/problems', requireAdmin, (req, res) => {
    const { id, title, description, inputDesc, outputDesc, samples, timeLimit, memoryLimit } = req.body;
    if (!id || !title) return res.json({ success: false, error: '题目编号和标题必填' });
    if (problemsData[id]) return res.json({ success: false, error: `题目 ${id} 已存在` });

    problemsData[id] = {
      id, title,
      description:  description  || '',
      inputDesc:    inputDesc    || '',
      outputDesc:   outputDesc   || '',
      samples:      samples      || [],
      timeLimit:    timeLimit    || 1000,
      memoryLimit:  memoryLimit  || 256,
    };
    fs.writeFileSync(problemsFile, JSON.stringify(problemsData, null, 2));
    res.json({ success: true });
  });

  // 管理员查看 prompts
  app.get('/api/admin/prompts', requireAdmin, (req, res) => {
    loadPrompts();
    res.json({ success: true, prompts: PROMPTS });
  });

  // 管理员保存 prompts
  app.post('/api/admin/prompts', requireAdmin, (req, res) => {
    const { prompts } = req.body;
    if (!prompts || typeof prompts !== 'object') return res.json({ success: false, error: '无效的提示词数据' });
    try {
      fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2));
      loadPrompts();
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 管理员查看某用户用量
  app.get('/api/admin/users/:id/usage', requireAdmin, (req, res) => {
    const usage = loadUserUsage(req.params.id);
    res.json({ success: true, usage });
  });

  // ── 题目搜索 API ──────────────────────────────────────────
  app.get('/api/problems/search', requireAuth, (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ success: true, results: [] });

    const results = [];

    // 搜索全局题库（题号前缀匹配优先，然后题名包含）
    for (const [id, prob] of Object.entries(problemsData)) {
      const idMatch    = id.toLowerCase().startsWith(q);
      const titleMatch = (prob.title || '').toLowerCase().includes(q);
      if (idMatch || titleMatch) {
        results.push({ id, title: prob.title || id, source: 'global' });
      }
      if (results.length >= 20) break;
    }

    // 搜索用户自定义题目
    const userId  = req.session.userId;
    const customs = loadCustomProblems(userId);
    const userProbDir = path.join(getUserStudentDir(userId), 'custom_problem_data');
    const customIds = Object.values(customs).filter(id => id !== undefined);
    for (const cid of [...new Set(customIds)]) {
      if (results.length >= 30) break;
      const cidStr = String(cid).toLowerCase();
      const file   = path.join(userProbDir, `${cid}.json`);
      if (!fs.existsSync(file)) continue;
      try {
        const prob = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const idMatch    = cidStr.includes(q);
        const titleMatch = (prob.title || '').toLowerCase().includes(q);
        if (idMatch || titleMatch) {
          results.push({ id: cid, title: prob.title || cid, source: 'custom' });
        }
      } catch {}
    }

    res.json({ success: true, results });
  });

  // ── 题目 API ──────────────────────────────────────────────
  app.get('/api/problem/:id', requireAuth, (req, res) => {
    // 先查全局题库
    if (problemsData[req.params.id]) {
      return res.json({ success: true, problem: problemsData[req.params.id] });
    }
    // 再查用户自定义题目
    const customs = loadCustomProblems(req.session.userId);
    const userProbDir = path.join(getUserStudentDir(req.session.userId), 'custom_problem_data');
    const customFile  = path.join(userProbDir, `${req.params.id}.json`);
    if (Object.values(customs).includes(req.params.id) && fs.existsSync(customFile)) {
      try {
        const prob = JSON.parse(fs.readFileSync(customFile, 'utf-8'));
        return res.json({ success: true, problem: prob });
      } catch {}
    }
    res.json({ success: false, error: `题目 ${req.params.id} 不存在` });
  });

  // ── 普通用户添加自定义题目（存入用户文件夹）──────────────
  app.post('/api/user/problems', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const { title, description, inputDesc, outputDesc, samples, timeLimit, memoryLimit } = req.body;
    if (!title) return res.json({ success: false, error: '标题必填' });

    // 检查用户题目数量上限（管理员不受限）
    const customs = loadCustomProblems(userId);
    const count = Object.keys(customs).length;
    const isAdmin = ['admin', 'superadmin'].includes(req.session.role);
    const limit = isAdmin ? Infinity : (config.customProblemLimit ?? 100);
    if (count >= limit) return res.json({ success: false, error: `已达到自定义题目上限（${limit} 题）` });

    // 生成随机 6 位 ID
    const id = generateCustomId(Object.values(customs));
    const fullId = `${userId}-${id}`;

    // 保存到用户的 custom_problem_data 目录
    const userProbDir = path.join(getUserStudentDir(userId), 'custom_problem_data');
    fs.mkdirSync(userProbDir, { recursive: true });

    const prob = {
      id: fullId, title,
      description:  description  || '',
      inputDesc:    inputDesc    || '',
      outputDesc:   outputDesc   || '',
      samples:      samples      || [],
      timeLimit:    timeLimit    || 1000,
      memoryLimit:  memoryLimit  || 256,
    };
    fs.writeFileSync(path.join(userProbDir, `${fullId}.json`), JSON.stringify(prob, null, 2));

    // 注册映射：hash_key(fullId) → fullId（便于查询时复用 custom-problem-id 逻辑）
    const hashKey = `__manual_${fullId}`;
    customs[hashKey] = fullId;
    saveCustomProblems(userId, customs);

    res.json({ success: true, id: fullId });
  });

  // ── 自定义题目 ID（文本 hash → 6位字母数字编号）────────────
  app.post('/api/custom-problem-id', requireAuth, (req, res) => {
    const { hash } = req.body;
    if (!hash) return res.json({ success: false, error: '缺少 hash' });
    const userId  = req.session.userId;
    const customs = loadCustomProblems(userId);

    // 检查用户题目数量上限（管理员不受限）
    if (!customs[hash]) {
      const count = Object.keys(customs).length;
      const isAdmin = ['admin', 'superadmin'].includes(req.session.role);
      const limit = isAdmin ? Infinity : (config.customProblemLimit ?? 100);
      if (count >= limit) return res.json({ success: false, error: `已达到自定义题目上限（${limit} 题）` });
    }

    if (customs[hash]) return res.json({ success: true, id: customs[hash] });
    const id = generateCustomId(Object.values(customs));
    customs[hash] = id;
    saveCustomProblems(userId, customs);
    res.json({ success: true, id });
  });

  // ── 提示词（供前端读取或调试用）──────────────────────────
  app.get('/api/prompts', requireAuth, (_req, res) => {
    loadPrompts();
    res.json({ success: true, prompts: PROMPTS });
  });

  // ── 对话进程 CRUD ─────────────────────────────────────────
  app.get('/api/problem/:id/sessions', requireAuth, (req, res) => {
    res.json({ success: true, sessions: listSessions(req.session.userId, req.params.id) });
  });

  app.post('/api/problem/:id/sessions', requireAuth, (req, res) => {
    const { name } = req.body;
    const result = createSession(req.session.userId, req.params.id, name);
    res.json({ success: true, ...result });
  });

  app.get('/api/problem/:id/sessions/:key', requireAuth, (req, res) => {
    const data = loadSession(req.session.userId, req.params.id, req.params.key);
    if (!data) return res.json({ success: true, key: req.params.key, name: req.params.key, history: [] });
    res.json({ success: true, ...data });
  });

  app.put('/api/problem/:id/sessions/:key', requireAuth, (req, res) => {
    const { history, blocks } = req.body;
    if (!Array.isArray(history)) return res.json({ success: false, error: '无效的 history 格式' });
    saveSessionHistory(req.session.userId, req.params.id, req.params.key, history, blocks);
    res.json({ success: true });
  });

  app.patch('/api/problem/:id/sessions/:key', requireAuth, (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.json({ success: false, error: '名称不能为空' });
    const ok = renameSession(req.session.userId, req.params.id, req.params.key, name);
    res.json({ success: ok });
  });

  app.delete('/api/problem/:id/sessions/:key', requireAuth, (req, res) => {
    deleteSession(req.session.userId, req.params.id, req.params.key);
    res.json({ success: true });
  });

  // ── 代码提问 Threads（独立于主对话 sessions）─────────────
  app.get('/api/problem/:id/code-qa', requireAuth, (req, res) => {
    const p = codeQaFilePath(req.session.userId, req.params.id);
    if (!fs.existsSync(p)) return res.json({ success: true, threads: [] });
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      res.json({ success: true, threads: data.threads || [] });
    } catch { res.json({ success: true, threads: [] }); }
  });

  app.put('/api/problem/:id/code-qa', requireAuth, (req, res) => {
    const { threads } = req.body;
    if (!Array.isArray(threads)) return res.json({ success: false, error: '无效的 threads' });
    ensureProblemDirs(req.session.userId, req.params.id);
    const p = codeQaFilePath(req.session.userId, req.params.id);
    fs.writeFileSync(p, JSON.stringify({ threads, updatedAt: new Date().toISOString() }, null, 2));
    res.json({ success: true });
  });

  // ── 代码翻译 ──────────────────────────────────────────────
  function codeTranslateFilePath(userId, problemId) {
    return path.join(getProblemDir(userId, problemId), 'code-translate.json');
  }

  app.get('/api/problem/:id/code-translate', requireAuth, (req, res) => {
    const p = codeTranslateFilePath(req.session.userId, req.params.id);
    if (!fs.existsSync(p)) return res.json({ success: true, versions: [] });
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      res.json({ success: true, versions: data.versions || [] });
    } catch { res.json({ success: true, versions: [] }); }
  });

  app.put('/api/problem/:id/code-translate', requireAuth, (req, res) => {
    const { versions } = req.body;
    if (!Array.isArray(versions)) return res.json({ success: false, error: '无效数据' });
    ensureProblemDirs(req.session.userId, req.params.id);
    const p = codeTranslateFilePath(req.session.userId, req.params.id);
    fs.writeFileSync(p, JSON.stringify({ versions, updatedAt: new Date().toISOString() }, null, 2));
    res.json({ success: true });
  });

  app.post('/api/code-translate/brief', requireAuth, async (req, res) => {
    const limitErr = checkDailyLimit(req.session.userId, req.session.role, req.session.tempApiKey);
    if (limitErr) return res.json({ success: false, error: limitErr });

    const { code, problemContext } = req.body;
    if (!code?.trim()) return res.json({ success: false, error: '代码不能为空' });

    loadPrompts();
    const sysPrompt = PROMPTS.code_translate_brief || '';
    const userContent = (problemContext ? `题目信息：\n${problemContext}\n\n` : '') + `学生代码：\n\`\`\`cpp\n${code}\n\`\`\``;

    try {
      const { reply } = await callDeepSeek(
        [{ role: 'system', content: sysPrompt }, { role: 'user', content: userContent }],
        { temperature: 0.3, max_tokens: 4096 },
        req.session.userId, req.session.tempApiKey
      );
      const blocks = JSON.parse(reply.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      res.json({ success: true, blocks });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/code-translate/detail', requireAuth, async (req, res) => {
    const limitErr = checkDailyLimit(req.session.userId, req.session.role, req.session.tempApiKey);
    if (limitErr) return res.json({ success: false, error: limitErr });

    const { code, blockCode, blockTranslation, problemContext } = req.body;
    if (!blockCode?.trim()) return res.json({ success: false, error: '代码段不能为空' });

    loadPrompts();
    const sysPrompt = PROMPTS.code_translate_detail || '';
    const userContent = (problemContext ? `题目信息：\n${problemContext}\n\n` : '') +
      `完整代码：\n\`\`\`cpp\n${code}\n\`\`\`\n\n需要深入翻译的代码段：\n\`\`\`cpp\n${blockCode}\n\`\`\`\n\n初步翻译：${blockTranslation}`;

    try {
      const { reply } = await callDeepSeek(
        [{ role: 'system', content: sysPrompt }, { role: 'user', content: userContent }],
        { temperature: 0.3, max_tokens: 2048 },
        req.session.userId, req.session.tempApiKey
      );
      const detail = JSON.parse(reply.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      res.json({ success: true, detail });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 代码文件 CRUD ─────────────────────────────────────────
  app.get('/api/problem/:id/codes', requireAuth, (req, res) => {
    res.json({ success: true, codes: listCodes(req.session.userId, req.params.id) });
  });

  app.post('/api/problem/:id/codes', requireAuth, (req, res) => {
    const { code, description } = req.body;
    const filename = generateCodeFilename(req.params.id, req.session.userId);
    const data = saveCode(req.session.userId, req.params.id, filename, code || '', description || '');
    res.json({ success: true, ...data });
  });

  app.get('/api/problem/:id/codes/:filename', requireAuth, (req, res) => {
    const data = loadCode(req.session.userId, req.params.id, req.params.filename);
    if (!data) return res.json({ success: false, error: '文件不存在' });
    res.json({ success: true, ...data });
  });

  app.put('/api/problem/:id/codes/:filename', requireAuth, (req, res) => {
    const { code, description } = req.body;
    const data = saveCode(req.session.userId, req.params.id, req.params.filename, code, description);
    res.json({ success: true, ...data });
  });

  app.delete('/api/problem/:id/codes/:filename', requireAuth, (req, res) => {
    const p = codeFilePath(req.session.userId, req.params.id, req.params.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ success: true });
  });

  // ── 编译运行 ──────────────────────────────────────────────
  app.post('/api/compile', requireAuth, (req, res) => {
    const { code, stdin, timeLimit = 5 } = req.body;
    if (!code) return res.json({ success: false, stderr: '代码不能为空' });
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-'));
    const srcFile = path.join(tmpDir, 'main.cpp');
    const outFile = path.join(tmpDir, 'a.out');
    fs.writeFileSync(srcFile, code);
    execFile('g++', ['-std=c++17', '-O2', ...macosxSdkArgs, '-o', outFile, srcFile], { timeout: 15000 },
      (cErr, _, cStderr) => {
        if (cErr) {
          cleanup(tmpDir);
          return res.json({ success: false, stderr: cStderr || cErr.message, phase: 'compile' });
        }
        const t0    = Date.now();
        const child = execFile(outFile, [], { timeout: timeLimit * 1000, maxBuffer: 10 * 1024 * 1024 },
          (rErr, rStdout, rStderr) => {
            const timeUsed = Date.now() - t0;
            cleanup(tmpDir);
            if (rErr?.killed) return res.json({ success: false, stderr: `运行超时 (>${timeLimit}s)`, phase: 'runtime', timeUsed });
            res.json({
              success:   !rErr,
              stdout:    rStdout,
              stderr:    rStderr || (rErr ? rErr.message : ''),
              phase:     'runtime',
              timeUsed,
              exitCode:  rErr ? rErr.code : 0,
            });
          });
        if (stdin) child.stdin.write(stdin);
        child.stdin.end();
      });
  });

  // ── 对话（含提示层级）────────────────────────────────────
  app.post('/api/chat', requireAuth, async (req, res) => {
    const limitErr = checkDailyLimit(req.session.userId, req.session.role, req.session.tempApiKey);
    if (limitErr) return res.json({ success: false, error: limitErr, limitReached: true });

    const { mode, messages, problemContext, recentIssues, hintLevel } = req.body;

    loadPrompts();

    let sysPrompt = PROMPTS[mode] || PROMPTS.handwrite || '';

    if (hintLevel === 1)      sysPrompt += '\n\n' + (PROMPTS.hint_keyword    || '');
    else if (hintLevel === 2) sysPrompt += '\n\n' + (PROMPTS.hint_framework  || '');
    else                      sysPrompt += '\n\n' + (PROMPTS.hint_follow_up  || '');

    let ctx = problemContext || '';
    if (recentIssues?.length) {
      ctx += `\n\n【学生近期问题记录（最近${recentIssues.length}条）】\n` +
        recentIssues.map((r, i) => `${i + 1}. [${r.type}] ${r.summary}`).join('\n') +
        `\n\n若本次问题与上述某条高度相似，请在回复开头单独一行写"⚠️ 重复：#序号"，然后另起一行正常回复。`;
    }

    const fullMessages = [
      { role: 'system', content: sysPrompt + (ctx ? `\n\n当前题目：\n${ctx}` : '') },
      ...messages,
    ];
    try {
      const { reply } = await callDeepSeek(fullMessages, {}, req.session.userId, req.session.tempApiKey);
      res.json({ success: true, reply });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 话题检测 & 区块概述 ─────────────────────────────────
  app.post('/api/topic-detect', requireAuth, async (req, res) => {
    const { recentMessages, newMessage } = req.body;
    if (!newMessage || !recentMessages?.length) return res.json({ success: true, result: 'SAME' });

    loadPrompts();
    const context = recentMessages.slice(-6).map(m =>
      `${m.role === 'user' ? '学生' : 'AI'}：${m.content}`
    ).join('\n');

    try {
      const { reply } = await callDeepSeek([
        { role: 'system', content: PROMPTS.topic_detect || '判断是否新话题，只输出SAME或NEW' },
        { role: 'user', content: `最近的对话：\n${context}\n\n学生的新消息：${newMessage}` },
      ], { temperature: 0.1, max_tokens: 10 }, req.session.userId, req.session.tempApiKey);
      const result = reply.trim().toUpperCase().includes('NEW') ? 'NEW' : 'SAME';
      res.json({ success: true, result });
    } catch (err) {
      res.json({ success: true, result: 'SAME' });
    }
  });

  app.post('/api/block-summarize', requireAuth, async (req, res) => {
    const { messages } = req.body;
    if (!messages?.length) return res.json({ success: true, summary: '' });

    loadPrompts();
    const convText = messages.map(m =>
      `${m.role === 'user' ? '学生' : 'AI'}：${m.content}`
    ).join('\n');

    try {
      const { reply } = await callDeepSeek([
        { role: 'system', content: PROMPTS.block_summarize || '用一句话概述对话内容' },
        { role: 'user', content: convText },
      ], { temperature: 0.3, max_tokens: 50 }, req.session.userId, req.session.tempApiKey);
      res.json({ success: true, summary: reply.trim() });
    } catch (err) {
      res.json({ success: true, summary: '对话讨论' });
    }
  });

  // ── 代码出题 ──────────────────────────────────────────────
  app.post('/api/explain', requireAuth, async (req, res) => {
    const limitErr = checkDailyLimit(req.session.userId, req.session.role, req.session.tempApiKey);
    if (limitErr) return res.json({ success: false, error: limitErr, limitReached: true });

    const { code, problemContext } = req.body;
    const messages = [
      { role: 'system', content: PROMPTS.explain || '你是竞赛教练，为代码生成3-5道理解题。输出JSON数组，每项含question和hint。只输出JSON。' },
      { role: 'user',   content: `题目：${problemContext || '(未提供)'}\n\n代码：\n${code}` },
    ];
    try {
      const { reply } = await callDeepSeek(messages, { temperature: 0.5, max_tokens: 2048 }, req.session.userId, req.session.tempApiKey);
      const cleaned   = reply.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      let questions;
      try { questions = JSON.parse(cleaned); }
      catch { questions = [{ question: '请解释这段代码的整体逻辑', hint: reply }]; }
      res.json({ success: true, questions });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 对话总结（支持传入多个进程的合并 messages）────────────
  app.post('/api/summarize', requireAuth, async (req, res) => {
    const limitErr = checkDailyLimit(req.session.userId, req.session.role, req.session.tempApiKey);
    if (limitErr) return res.json({ success: false, error: limitErr, limitReached: true });

    const { messages, problemId } = req.body;
    if (!messages?.length) return res.json({ success: true, items: [] });
    const convText = messages.map(m => `${m.role === 'user' ? '学生' : 'AI'}：${m.content}`).join('\n');
    try {
      const { reply } = await callDeepSeek([
        { role: 'system', content: PROMPTS.summarize || '' },
        { role: 'user',   content: `题目：${problemId || '未知'}\n\n${convText}` },
      ], { temperature: 0.4, max_tokens: 1024 }, req.session.userId, req.session.tempApiKey);
      const cleaned = reply.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      let items;
      try { items = JSON.parse(cleaned); } catch { items = []; }
      items = items.map(i => ({ ...i, problemId: problemId || '未知' }));
      res.json({ success: true, items });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 代码 Diff 分析 ────────────────────────────────────────
  app.post('/api/diff-summary', requireAuth, async (req, res) => {
    const limitErr = checkDailyLimit(req.session.userId, req.session.role, req.session.tempApiKey);
    if (limitErr) return res.json({ success: false, error: limitErr, limitReached: true });

    const { codeA, codeB, problemContext, nameA, nameB } = req.body;
    if (!codeA || !codeB) return res.json({ success: false, error: '需要两段代码' });
    const sysPrompt = PROMPTS.code_diff || '你是竞赛教练，对比两段代码在解决同一题目上的思路区别。';
    const userMsg   = `题目背景：${problemContext || '（未提供）'}\n\n【${nameA || '代码A'}】\n\`\`\`cpp\n${codeA}\n\`\`\`\n\n【${nameB || '代码B'}】\n\`\`\`cpp\n${codeB}\n\`\`\``;
    try {
      const { reply } = await callDeepSeek([
        { role: 'system', content: sysPrompt },
        { role: 'user',   content: userMsg },
      ], { temperature: 0.5, max_tokens: 1024 }, req.session.userId, req.session.tempApiKey);
      res.json({ success: true, summary: reply });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 回顾 CRUD ─────────────────────────────────────────────
  app.get('/api/student/review', requireAuth, (req, res) => {
    res.json({ success: true, items: loadReview(req.session.userId) });
  });

  app.post('/api/student/review', requireAuth, (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.json({ success: false, error: '无数据' });
    const data  = loadReview(req.session.userId);
    const now   = Date.now();
    const added = items.map(item => ({
      id:        randomUUID(),
      type:      item.type      || '其他',
      summary:   item.summary   || '',
      example:   item.example   || '',
      problemId: item.problemId || '未知',
      notes:     '',
      timestamp: now,
    }));
    saveReview(req.session.userId, [...data, ...added]);
    res.json({ success: true, added });
  });

  app.patch('/api/student/review/:id', requireAuth, (req, res) => {
    const { notes } = req.body;
    const data = loadReview(req.session.userId);
    const idx  = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.json({ success: false, error: '记录不存在' });
    data[idx].notes = notes || '';
    saveReview(req.session.userId, data);
    res.json({ success: true });
  });

  app.delete('/api/student/review/:id', requireAuth, (req, res) => {
    saveReview(req.session.userId, loadReview(req.session.userId).filter(r => r.id !== req.params.id));
    res.json({ success: true });
  });

  app.delete('/api/student/review', requireAuth, (req, res) => {
    saveReview(req.session.userId, []);
    res.json({ success: true });
  });

  // ── 用量统计 ──────────────────────────────────────────────
  app.get('/api/usage', requireAuth, (req, res) => {
    const usage = loadUserUsage(req.session.userId);
    const today = new Date().toISOString().slice(0, 10);

    // 计算今日和本周
    const now       = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = weekStart.toISOString().slice(0, 10);

    const todayData = usage.dailyRecords[today] || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
    const weekData  = Object.entries(usage.dailyRecords)
      .filter(([date]) => date >= weekStartStr)
      .reduce((acc, [, d]) => ({
        calls:            acc.calls            + (d.calls            || 0),
        totalTokens:      acc.totalTokens      + (d.totalTokens      || 0),
        cost:             acc.cost             + (d.cost             || 0),
      }), { calls: 0, totalTokens: 0, cost: 0 });

    res.json({
      today: { tokens: todayData.totalTokens, cost: todayData.cost.toFixed(4), calls: todayData.calls },
      week:  { tokens: weekData.totalTokens,  cost: weekData.cost.toFixed(4),  calls: weekData.calls  },
      total: { tokens: usage.total.totalTokens, cost: usage.total.cost.toFixed(4), calls: usage.total.calls },
    });
  });

  // ── 配置管理 ──────────────────────────────────────────────
  app.get('/api/config/status', requireAuth, (req, res) => {
    // 优先使用会话内用户自己的 key
    const sessionKey = req.session.tempApiKey;
    if (sessionKey) {
      return res.json({ configured: true, preview: sessionKey.slice(0, 5) + '…' + sessionKey.slice(-4), isPersonal: true });
    }
    const key        = config.deepseekApiKey || '';
    const configured = key && key !== 'YOUR_API_KEY_HERE';
    const preview    = configured ? key.slice(0, 5) + '…' + key.slice(-4) : '';
    res.json({ configured, preview, isPersonal: false });
  });

  // 仅超级管理员可以修改全局 API Key
  app.post('/api/config/apikey', requireSuperAdmin, (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey?.startsWith('sk-')) return res.json({ success: false, error: 'API Key 格式不正确（应以 sk- 开头）' });
    config.deepseekApiKey = apiKey;
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 反馈与榜单 ──────────────────────────────────────────────
  const feedbackFile = path.join(dataDir, 'feedback.json');
  function loadFeedback() {
    try { return JSON.parse(fs.readFileSync(feedbackFile, 'utf-8')); }
    catch { return []; }
  }
  function saveFeedback(data) {
    fs.writeFileSync(feedbackFile, JSON.stringify(data, null, 2));
  }

  // 学生提交反馈
  app.post('/api/feedback', requireAuth, (req, res) => {
    const { content } = req.body;
    if (!content?.trim()) return res.json({ success: false, error: '反馈内容不能为空' });
    const feedbacks = loadFeedback();
    const accounts = loadAccounts();
    const account = accounts[req.session.userId];
    feedbacks.push({
      id: randomUUID(),
      userId: req.session.userId,
      username: account?.username || '未知',
      content: content.trim(),
      score: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    saveFeedback(feedbacks);
    res.json({ success: true });
  });

  // 获取当前用户的反馈列表
  app.get('/api/feedback/mine', requireAuth, (req, res) => {
    const feedbacks = loadFeedback();
    const mine = feedbacks.filter(f => f.userId === req.session.userId);
    res.json({ success: true, feedbacks: mine });
  });

  // 获取榜单（所有用户可见，只显示 score > 0 的聚合数据）
  app.get('/api/feedback/leaderboard', requireAuth, (_req, res) => {
    const feedbacks = loadFeedback();
    const scored = feedbacks.filter(f => f.score && f.score > 0);
    const userMap = {};
    for (const f of scored) {
      if (!userMap[f.userId]) userMap[f.userId] = { username: f.username, totalScore: 0, count: 0 };
      userMap[f.userId].totalScore += f.score;
      userMap[f.userId].count += 1;
    }
    const leaderboard = Object.values(userMap).sort((a, b) => b.totalScore - a.totalScore);
    res.json({ success: true, leaderboard });
  });

  // 管理员：获取全部反馈
  app.get('/api/admin/feedback', requireAdmin, (_req, res) => {
    const feedbacks = loadFeedback();
    res.json({ success: true, feedbacks });
  });

  // 管理员：审核反馈（设置分数）
  app.patch('/api/admin/feedback/:id', requireAdmin, (req, res) => {
    const { score } = req.body;
    if (score === undefined || score === null) return res.json({ success: false, error: '请提供分数' });
    const s = Number(score);
    if (isNaN(s) || s < 0 || s > 5) return res.json({ success: false, error: '分数应为 0-5' });
    const feedbacks = loadFeedback();
    const fb = feedbacks.find(f => f.id === req.params.id);
    if (!fb) return res.json({ success: false, error: '反馈不存在' });
    fb.score = s;
    fb.status = s > 0 ? 'accepted' : 'rejected';
    fb.reviewedAt = new Date().toISOString();
    saveFeedback(feedbacks);
    res.json({ success: true });
  });

  // ── 有效对话时长 ──────────────────────────────────────────────
  const activeTimeLocks = new Map();

  function getActiveTimeFile(userId) {
    return path.join(getUserStudentDir(userId), 'active-time.json');
  }

  function loadActiveTime(userId) {
    const file = getActiveTimeFile(userId);
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {}
    return { dailyMinutes: {} };
  }

  function saveActiveTimeSafe(userId, updater) {
    const key = userId;
    while (activeTimeLocks.get(key)) {
      // spin — single-threaded Node won't actually race, but guard future async
    }
    activeTimeLocks.set(key, true);
    try {
      ensureUserDirs(userId);
      const data = loadActiveTime(userId);
      updater(data);
      fs.writeFileSync(getActiveTimeFile(userId), JSON.stringify(data, null, 2));
    } finally {
      activeTimeLocks.delete(key);
    }
  }

  app.post('/api/active-time', requireAuth, (req, res) => {
    const { seconds } = req.body;
    if (typeof seconds !== 'number' || seconds <= 0 || seconds > 600) {
      return res.json({ success: false, error: '无效数据' });
    }
    const userId = req.session.userId;
    const today = new Date().toISOString().slice(0, 10);
    saveActiveTimeSafe(userId, (data) => {
      data.dailyMinutes[today] = Math.round((data.dailyMinutes[today] || 0) + seconds / 60);
    });
    res.json({ success: true });
  });

  app.get('/api/admin/active-time/summary', requireAdmin, (_req, res) => {
    const accounts = loadAccounts();
    const rows = [];
    for (const u of Object.values(accounts)) {
      const data = loadActiveTime(u.id);
      const daily = data.dailyMinutes || {};
      const dates = Object.keys(daily).sort();
      let totalMin = 0;
      let activeDays = 0;
      for (const d of dates) {
        const m = daily[d] || 0;
        if (m > 0) { totalMin += m; activeDays++; }
      }
      rows.push({
        userId: u.id,
        username: u.username,
        displayName: u.displayName || '',
        dailyMinutes: daily,
        totalMinutes: Math.round(totalMin),
        activeDays,
        avgMinutesPerActiveDay: activeDays > 0 ? Math.round(totalMin / activeDays) : 0,
      });
    }
    res.json({ success: true, rows });
  });

  // ── 问题图谱 & 推荐（内嵌） ─────────────────────────────
  const graphPath    = path.join(dataDir, 'problem_graph.json');
  const embPath      = path.join(dataDir, 'embeddings.json');
  const embIdxPath   = path.join(dataDir, 'embedding_index.json');
  const analyzedPath = path.join(dataDir, 'problems_analyzed.jsonl');
  const relationsPath = path.join(dataDir, 'relations.json');

  let graphNodes = {};   // { id: { title, difficulty, tags, ... } }
  let graphEdges = [];   // [{ from, to, relation, confidence, ... }]
  let outEdges   = {};   // { id: [edge, ...] }
  let inEdges    = {};   // { id: [edge, ...] }
  let embMatrix  = null; // Float64Array[][] or null
  let embNormed  = null; // normalised rows
  let embIndex   = null; // { id_to_row, row_to_id }
  let analyzedMap = {};  // { id: { ... } }

  function loadGraph() {
    try {
      if (fs.existsSync(graphPath)) {
        const g = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
        graphNodes = g.nodes || {};
        graphEdges = g.edges || [];
      }
    } catch (e) { console.warn('[图谱] 加载失败：', e.message); }

    // 构建邻接表
    outEdges = {}; inEdges = {};
    for (const e of graphEdges) {
      if (!outEdges[e.from]) outEdges[e.from] = [];
      outEdges[e.from].push(e);
      if (!inEdges[e.to]) inEdges[e.to] = [];
      inEdges[e.to].push(e);
    }

    console.log(`[图谱] ${Object.keys(graphNodes).length} 节点, ${graphEdges.length} 边`);
  }

  function loadEmbeddings() {
    try {
      if (fs.existsSync(embPath) && fs.existsSync(embIdxPath)) {
        embMatrix = JSON.parse(fs.readFileSync(embPath, 'utf-8'));
        embIndex  = JSON.parse(fs.readFileSync(embIdxPath, 'utf-8'));
        // 预计算归一化
        embNormed = embMatrix.map(row => {
          let norm = 0;
          for (const v of row) norm += v * v;
          norm = Math.sqrt(norm) || 1e-8;
          return row.map(v => v / norm);
        });
        console.log(`[Embedding] ${embMatrix.length} 行, ${embMatrix[0]?.length || 0} 维`);
      }
    } catch (e) { console.warn('[Embedding] 加载失败：', e.message); }
  }

  function loadAnalyzed() {
    analyzedMap = {};
    try {
      if (fs.existsSync(analyzedPath)) {
        for (const line of fs.readFileSync(analyzedPath, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const p = JSON.parse(line);
            analyzedMap[String(p.id)] = p;
          } catch {}
        }
        console.log(`[题目分析] ${Object.keys(analyzedMap).length} 题`);
      }
    } catch {}
  }

  loadGraph();
  loadEmbeddings();
  loadAnalyzed();

  function dotProduct(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function getEmbeddingSimilar(pid, exclude, topN = 20) {
    if (!embNormed || !embIndex) return [];
    const row = embIndex.id_to_row?.[pid];
    if (row === undefined) return [];
    const vec = embNormed[row];
    const scored = [];
    for (let i = 0; i < embNormed.length; i++) {
      if (i === row) continue;
      const rid = embIndex.row_to_id?.[String(i)];
      if (!rid || exclude.has(rid)) continue;
      scored.push({ id: rid, sim: dotProduct(vec, embNormed[i]) });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, topN);
  }

  function buildReason(rel, diffDelta) {
    if (rel === 'HARDER_VERSION') return '再来一题！（更难的）';
    if (rel === 'SAME_TECHNIQUE') return diffDelta <= 1 ? '再来一题！（同技巧，差不多难度）' : '再来一题！（同技巧，更难的）';
    if (rel === 'PREREQUISITE_OF') return '进阶练习';
    if (rel === 'SIMILAR_TO') return '再来一题！（差不多难度）';
    return '推荐练习';
  }

  function recommendNext(pid, count = 3) {
    const results = [];
    const seen = new Set([pid]);
    const currDiff = (graphNodes[pid] || analyzedMap[pid] || {}).difficulty || 5;

    const candidates = (outEdges[pid] || []).map(e => {
      const nid = e.to;
      if (seen.has(nid)) return null;
      const nDiff = (graphNodes[nid] || {}).difficulty || 5;
      const dd = nDiff - currDiff;
      let score = e.confidence || 0;
      if (e.relation === 'HARDER_VERSION') score += 2;
      else if (e.relation === 'SAME_TECHNIQUE') score += 1.5;
      else if (e.relation === 'PREREQUISITE_OF') score += 0.5;
      if (dd >= 1 && dd <= 2) score += 1;
      else if (dd === 0) score += 0.5;
      else if (dd > 3) score -= 0.5;
      if (e.source === 'teacher') score += 3;
      return { nid, score, rel: e.relation, dd };
    }).filter(Boolean);

    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates.slice(0, count)) {
      seen.add(c.nid);
      const p = analyzedMap[c.nid] || graphNodes[c.nid] || {};
      results.push({ id: c.nid, title: p.title || '', difficulty: p.difficulty || 0, tags: p.tags || [], reason: buildReason(c.rel, c.dd), source: 'graph' });
    }

    if (results.length < count) {
      const sims = getEmbeddingSimilar(pid, seen, count * 3);
      for (const s of sims) {
        if (results.length >= count) break;
        const p = analyzedMap[s.id] || {};
        const nDiff = p.difficulty || 5;
        if (nDiff >= currDiff) {
          results.push({ id: s.id, title: p.title || '', difficulty: nDiff, tags: p.tags || [], reason: nDiff - currDiff <= 1 ? '再来一题！（差不多难度）' : '再来一题！（更难的）', source: 'embedding' });
          seen.add(s.id);
        }
      }
    }
    return results.slice(0, count);
  }

  function recommendEasier(pid, count = 3) {
    const results = [];
    const seen = new Set([pid]);
    const currDiff = (graphNodes[pid] || analyzedMap[pid] || {}).difficulty || 5;

    const candidates = (inEdges[pid] || []).map(e => {
      const nid = e.from;
      if (seen.has(nid)) return null;
      const nDiff = (graphNodes[nid] || {}).difficulty || 5;
      if (nDiff > currDiff) return null;
      let score = e.confidence || 0;
      if (e.relation === 'PREREQUISITE_OF') score += 2;
      else if (e.relation === 'SAME_TECHNIQUE') score += 1;
      if (e.source === 'teacher') score += 3;
      return { nid, score };
    }).filter(Boolean);

    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates.slice(0, count)) {
      seen.add(c.nid);
      const p = analyzedMap[c.nid] || graphNodes[c.nid] || {};
      results.push({ id: c.nid, title: p.title || '', difficulty: p.difficulty || 0, tags: p.tags || [], reason: '卡住了？来题简单的', source: 'graph' });
    }

    if (results.length < count) {
      const sims = getEmbeddingSimilar(pid, seen, count * 5);
      for (const s of sims) {
        if (results.length >= count) break;
        const p = analyzedMap[s.id] || {};
        if ((p.difficulty || 5) < currDiff) {
          results.push({ id: s.id, title: p.title || '', difficulty: p.difficulty || 0, tags: p.tags || [], reason: '卡住了？来题简单的', source: 'embedding' });
          seen.add(s.id);
        }
      }
    }
    return results.slice(0, count);
  }

  function recommendTopic(topic, count = 10) {
    const tl = topic.toLowerCase();
    const results = [];
    for (const [pid, p] of Object.entries(analyzedMap)) {
      const tags = (p.tags || []).map(t => t.toLowerCase());
      const kps  = (p.knowledge_points || []).map(k => k.toLowerCase());
      if (tags.includes(tl) || kps.includes(tl) || tags.some(t => t.includes(tl)) || kps.some(k => k.includes(tl))) {
        results.push({ id: pid, title: p.title || '', difficulty: p.difficulty || 0, tags: p.tags || [], reason: '专项训练！', source: 'topic' });
      }
    }
    results.sort((a, b) => a.difficulty - b.difficulty);
    return results.slice(0, count);
  }

  function saveGraphJson() {
    fs.writeFileSync(graphPath, JSON.stringify({ nodes: graphNodes, edges: graphEdges }, null, 0));
  }

  function saveAnalyzedJsonl() {
    const ids = Object.keys(analyzedMap).sort((a, b) => {
      const na = parseInt(a), nb = parseInt(b);
      return isNaN(na) || isNaN(nb) ? a.localeCompare(b) : na - nb;
    });
    const lines = ids.map(id => JSON.stringify(analyzedMap[id]));
    fs.writeFileSync(analyzedPath, lines.join('\n') + '\n');
  }

  // ── 推荐 API ──
  app.post('/api/recommend', requireAuth, (req, res) => {
    const { problem_id, mode, topic, count = 3 } = req.body;
    const pid = String(problem_id || '');
    let recs;
    if (mode === 'next')        recs = recommendNext(pid, count);
    else if (mode === 'easier') recs = recommendEasier(pid, count);
    else if (mode === 'topic')  recs = recommendTopic(topic || '', count);
    else return res.json({ success: false, error: '未知模式' });
    res.json({ success: true, recommendations: recs });
  });

  // ── 图谱信息 API ──
  app.get('/api/graph/info', requireAuth, (_req, res) => {
    const edgeTypes = {};
    for (const e of graphEdges) edgeTypes[e.relation] = (edgeTypes[e.relation] || 0) + 1;
    res.json({ nodes: Object.keys(graphNodes).length, edges: graphEdges.length, edge_types: edgeTypes });
  });

  app.get('/api/graph/node/:id', requireAuth, (req, res) => {
    const pid = req.params.id;
    if (!graphNodes[pid]) return res.json({ success: false, error: '节点不存在' });
    res.json({
      success: true,
      node: graphNodes[pid],
      out_neighbors: (outEdges[pid] || []).map(e => ({ id: e.to, title: (graphNodes[e.to] || {}).title || '', ...e })),
      in_neighbors:  (inEdges[pid]  || []).map(e => ({ id: e.from, title: (graphNodes[e.from] || {}).title || '', ...e })),
    });
  });

  app.get('/api/graph/subgraph', requireAuth, (req, res) => {
    const tag = (req.query.tag || '').trim();
    if (!tag) return res.json({ success: false, error: '缺少 tag 参数' });

    const tl = tag.toLowerCase();
    const matchPids = new Set();
    for (const [pid, p] of Object.entries(analyzedMap)) {
      const tags = (p.tags || []).map(t => t.toLowerCase());
      const kps = (p.knowledge_points || []).map(k => k.toLowerCase());
      if (tags.includes(tl) || kps.includes(tl) || tags.some(t => t.includes(tl)) || kps.some(k => k.includes(tl))) {
        matchPids.add(pid);
      }
    }

    const progress = loadProgress(req.session.userId);
    const nodes = [];
    for (const pid of matchPids) {
      const p = analyzedMap[pid] || graphNodes[pid] || {};
      nodes.push({
        id: pid,
        title: p.title || pid,
        difficulty: p.difficulty || 0,
        tags: p.tags || [],
        status: progress[pid]?.status || null,
      });
    }

    const graphEdgesInTag = graphEdges
      .filter(e => matchPids.has(e.from) && matchPids.has(e.to))
      .map(e => ({ from: e.from, to: e.to, relation: e.relation, confidence: e.confidence || 0, inferred: false }));

    const connectedPids = new Set();
    graphEdgesInTag.forEach(e => { connectedPids.add(e.from); connectedPids.add(e.to); });
    const isolatedPids = [...matchPids].filter(p => !connectedPids.has(p));

    const embEdges = [];
    const EMB_SIM_THRESHOLD = 0.55;
    const EMB_TOP_K = 2;
    if (embNormed && embIndex && isolatedPids.length > 0) {
      const pidRows = new Map();
      for (const pid of matchPids) {
        const row = embIndex.id_to_row?.[pid];
        if (row !== undefined) pidRows.set(pid, row);
      }

      for (const pid of isolatedPids) {
        const row = pidRows.get(pid);
        if (row === undefined) continue;
        const vec = embNormed[row];
        const scored = [];
        for (const [other, otherRow] of pidRows) {
          if (other === pid) continue;
          const sim = dotProduct(vec, embNormed[otherRow]);
          if (sim >= EMB_SIM_THRESHOLD) scored.push({ id: other, sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        for (const s of scored.slice(0, EMB_TOP_K)) {
          const pairKey = [pid, s.id].sort().join('|');
          if (!embEdges.some(e => [e.from, e.to].sort().join('|') === pairKey)) {
            embEdges.push({ from: pid, to: s.id, relation: 'SIMILAR_TO', confidence: +(s.sim * 0.6).toFixed(2), inferred: true });
          }
        }
      }
    }

    const edges = [...graphEdgesInTag, ...embEdges];
    res.json({ success: true, tag, nodes, edges });
  });

  app.get('/api/problems/tags', requireAuth, (_req, res) => {
    const tc = {};
    for (const p of Object.values(analyzedMap)) {
      for (const t of (p.tags || [])) tc[t] = (tc[t] || 0) + 1;
    }
    const tags = Object.entries(tc).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    res.json({ success: true, tags });
  });

  // ── 管理员：编辑图谱 ──
  app.post('/api/admin/graph/edit', requireAdmin, (req, res) => {
    const { action, id_a, id_b, relation, reason, id, difficulty } = req.body;

    if (action === 'add_edge') {
      if (!id_a || !id_b) return res.json({ success: false, error: '缺少 id_a 或 id_b' });
      const attrs = { relation: relation || 'SIMILAR_TO', confidence: 1.0, reason: reason || '教师标注', source: 'teacher', similarity: 0 };
      if (['SIMILAR_TO', 'SAME_TECHNIQUE'].includes(attrs.relation)) {
        graphEdges.push({ from: id_a, to: id_b, ...attrs });
        graphEdges.push({ from: id_b, to: id_a, ...attrs });
      } else {
        graphEdges.push({ from: id_a, to: id_b, ...attrs });
      }
      // 重建邻接表
      loadGraphEdgesIndex();
      saveGraphJson();
      return res.json({ success: true });
    }

    if (action === 'remove_edge') {
      const before = graphEdges.length;
      graphEdges = graphEdges.filter(e => {
        if (e.from === id_a && e.to === id_b) return false;
        if (['SIMILAR_TO', 'SAME_TECHNIQUE'].includes(e.relation) && e.from === id_b && e.to === id_a) return false;
        return true;
      });
      loadGraphEdgesIndex();
      saveGraphJson();
      return res.json({ success: true, removed: before - graphEdges.length });
    }

    if (action === 'update_difficulty') {
      const pid = String(id || '');
      const diff = Number(difficulty);
      if (graphNodes[pid]) {
        graphNodes[pid].difficulty = diff;
        graphNodes[pid].difficulty_note = reason || '';
      }
      if (analyzedMap[pid]) analyzedMap[pid].difficulty = diff;
      saveGraphJson();
      saveAnalyzedJsonl();
      return res.json({ success: true });
    }

    res.json({ success: false, error: '未知操作' });
  });

  app.get('/api/admin/graph/edges', requireAdmin, (_req, res) => {
    const edges = graphEdges.map(e => ({ id_a: e.from, id_b: e.to, relation: e.relation, confidence: e.confidence, reason: e.reason, source: e.source, similarity: e.similarity }));
    res.json({ success: true, edges });
  });

  function loadGraphEdgesIndex() {
    outEdges = {}; inEdges = {};
    for (const e of graphEdges) {
      if (!outEdges[e.from]) outEdges[e.from] = [];
      outEdges[e.from].push(e);
      if (!inEdges[e.to]) inEdges[e.to] = [];
      inEdges[e.to].push(e);
    }
  }

  // ── 学生解题进度 ──────────────────────────────────────────
  function getProgressFile(userId) {
    return path.join(getUserStudentDir(userId), 'progress.json');
  }

  function loadProgress(userId) {
    const file = getProgressFile(userId);
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {}
    return {};
  }

  function saveProgress(userId, data) {
    ensureUserDirs(userId);
    fs.writeFileSync(getProgressFile(userId), JSON.stringify(data, null, 2));
  }

  app.get('/api/student/progress', requireAuth, (req, res) => {
    const progress = loadProgress(req.session.userId);
    res.json({ success: true, progress });
  });

  app.post('/api/student/progress', requireAuth, (req, res) => {
    const { problemId, status } = req.body;
    if (!problemId) return res.json({ success: false, error: '缺少 problemId' });
    const validStatuses = ['solving', 'solved', 'review', 'stuck'];
    if (status && !validStatuses.includes(status)) {
      return res.json({ success: false, error: `无效状态，可选：${validStatuses.join(', ')}` });
    }
    const progress = loadProgress(req.session.userId);
    if (!progress[problemId]) {
      progress[problemId] = { status: status || 'solving', firstSeen: new Date().toISOString() };
    } else {
      progress[problemId].status = status || progress[problemId].status;
    }
    progress[problemId].updatedAt = new Date().toISOString();
    saveProgress(req.session.userId, progress);
    res.json({ success: true });
  });

  // 自动检测：有对话或非空代码的题目
  app.get('/api/student/progress/auto-detect', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const progress = loadProgress(userId);
    const problemsDir = getUserProblemsDir(userId);

    if (!fs.existsSync(problemsDir)) {
      return res.json({ success: true, progress });
    }

    const dirs = fs.readdirSync(problemsDir).filter(d =>
      fs.statSync(path.join(problemsDir, d)).isDirectory()
    );

    for (const pid of dirs) {
      if (progress[pid]) continue;

      const sessionsDir = path.join(problemsDir, pid, 'sessions');
      const codesDir = path.join(problemsDir, pid, 'codes');
      let hasContent = false;

      if (fs.existsSync(sessionsDir)) {
        const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        for (const sf of sessionFiles) {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, sf), 'utf-8'));
            if (s.history?.length > 0) { hasContent = true; break; }
          } catch {}
        }
      }
      if (!hasContent && fs.existsSync(codesDir)) {
        const codeFiles = fs.readdirSync(codesDir).filter(f => f.endsWith('.json'));
        for (const cf of codeFiles) {
          try {
            const c = JSON.parse(fs.readFileSync(path.join(codesDir, cf), 'utf-8'));
            if (c.code?.trim()) { hasContent = true; break; }
          } catch {}
        }
      }

      if (hasContent) {
        progress[pid] = { status: 'solving', firstSeen: new Date().toISOString(), updatedAt: new Date().toISOString(), autoDetected: true };
      }
    }

    saveProgress(userId, progress);
    res.json({ success: true, progress });
  });

  // 专项训练进度统计
  app.get('/api/student/topic-stats', requireAuth, (req, res) => {
    const progress = loadProgress(req.session.userId);
    const analyzedPath = path.join(dataDir, 'problems_analyzed.jsonl');
    const tagStats = {};

    if (fs.existsSync(analyzedPath)) {
      const lines = fs.readFileSync(analyzedPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          const pid = String(p.id);
          const tags = p.tags || [];
          const userStatus = progress[pid]?.status;
          for (const tag of tags) {
            if (!tagStats[tag]) tagStats[tag] = { total: 0, solving: 0, solved: 0, review: 0, stuck: 0 };
            tagStats[tag].total++;
            if (userStatus && tagStats[tag][userStatus] !== undefined) {
              tagStats[tag][userStatus]++;
            }
          }
        } catch {}
      }
    }

    res.json({ success: true, tagStats });
  });

  // 排行榜
  app.get('/api/student/leaderboard', requireAuth, (_req, res) => {
    const accounts = loadAccounts();
    const rows = [];
    for (const u of Object.values(accounts)) {
      if (u.role === 'admin' || u.role === 'superadmin') continue;
      const progress = loadProgress(u.id);
      const solved = Object.values(progress).filter(p => p.status === 'solved').length;
      const total = Object.keys(progress).length;
      if (total > 0) {
        rows.push({
          username: u.username,
          displayName: u.displayName || u.username,
          solved,
          total,
        });
      }
    }
    rows.sort((a, b) => b.solved - a.solved || b.total - a.total);
    res.json({ success: true, leaderboard: rows });
  });

  // ── 兼容旧 chat-log ────────────────────────────────────────
  app.post('/api/student/chat-log', (_req, res) => res.json({ success: true }));
};

// ============================================================
// Helpers
// ============================================================
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
