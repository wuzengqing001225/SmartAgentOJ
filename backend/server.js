const { execFile, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { randomUUID } = require('crypto');

// ============================================================
// 目录与配置初始化
// ============================================================
const dataDir    = path.join(__dirname, '..', 'data');
const studentDir = path.join(dataDir, 'student');
const configPath = path.join(dataDir, 'config.json');
const reviewFile = path.join(studentDir, 'review.json');
const usageFile  = path.join(studentDir, 'usage.json');

// 确保目录存在
fs.mkdirSync(studentDir, { recursive: true });

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

// macOS SDK
let macosxSdkArgs = [];
if (process.platform === 'darwin') {
  try {
    const sdkPath = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf-8' }).trim();
    macosxSdkArgs = ['-isysroot', sdkPath, `-I${sdkPath}/usr/include/c++/v1`];
  } catch {}
}

// ============================================================
// 题库加载
// ============================================================
let problemsData = {};
const problemsFile = path.join(dataDir, 'problems.json');
if (fs.existsSync(problemsFile)) {
  try {
    problemsData = JSON.parse(fs.readFileSync(problemsFile, 'utf-8'));
    console.log(`[题库] 已加载 ${Object.keys(problemsData).length} 道题目`);
  } catch (e) { console.warn('[题库] 加载失败：', e.message); }
}

// ============================================================
// 用量统计持久化
// ============================================================
let usageRecords = [];
let totalTokens  = 0;
let totalCost    = 0;

function loadUsage() {
  try {
    if (fs.existsSync(usageFile)) {
      const d = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
      usageRecords = (d.records || []).map(r => ({ ...r, timestamp: new Date(r.timestamp) }));
      totalTokens  = d.totalTokens || 0;
      totalCost    = d.totalCost   || 0;
    }
  } catch {}
}

function saveUsage() {
  try {
    fs.writeFileSync(usageFile, JSON.stringify({
      totalTokens, totalCost,
      records: usageRecords.slice(-2000),  // 保留最近2000条
    }, null, 2));
  } catch {}
}

loadUsage();

const PRICING = { prompt: 0.14, completion: 0.28 };

// ============================================================
// 回顾数据持久化
// ============================================================
function loadReview() {
  try {
    if (fs.existsSync(reviewFile)) return JSON.parse(fs.readFileSync(reviewFile, 'utf-8'));
  } catch {}
  return [];
}

function saveReview(data) {
  fs.writeFileSync(reviewFile, JSON.stringify(data, null, 2));
}

// ============================================================
// System Prompts
// ============================================================
const SYSTEM_PROMPTS = {
  handwrite: `你是一个热情的信息学竞赛教练，正在辅助学生独立练习【手写模式】。

严格规则：
- 绝对不能给出任何代码实现、算法思路、解题方向
- 绝对不能回答"这道题怎么做"、"用什么算法"、"怎么实现XX"
- 若学生提问超出范围，友好拒绝并说明原因

你可以做的：
- 帮助理解题意（输入输出格式、样例解释）
- 学生写完代码后，通过苏格拉底式追问引导自己发现错误
- 时间复杂度分析——引导而非直接给答案

鼓励要求：
- 学生问了一个有深度的问题，要肯定："好问题！""你注意到这个细节说明你在认真思考。"
- 学生发现了自己的错误时，给予鼓励："找到了，很好！自己发现比直接告诉你记得更牢。"

每次只问一个问题，回答简洁。`,

  verify: `你是一个热情的信息学竞赛教练，正在辅助学生进行【思路验证模式】。

严格规则：
- 绝对不能给出任何代码实现、算法思路、解题方向
- 绝对不能回答"这道题怎么做"、"用什么算法"、"怎么实现XX"
- 若学生提问超出范围，友好拒绝并说明原因

你可以做的：
- 帮助理解题意（输入输出格式、样例解释）
- 学生写完代码后，通过苏格拉底式追问引导自己发现错误
- 时间复杂度分析——引导而非直接给答案

【阶段一：思路讨论】
- 通过追问帮学生理清：状态定义、转移方程、复杂度、边界条件
- 每次只问一个问题，不修改学生的思路方向，苏格拉底式方法
- 鼓励学生例子："你这个思路方向很有潜力！""这个状态定义很清晰，继续。" 不一定每次都要有。

【阶段二：代码实现】（学生明确要求"生成代码"时）
- 严格按照学生描述的思路生成C++代码，不替换算法
- 代码完整可编译，使用C++17标准

每次只问一个问题，追问阶段回答简洁。`,

  code_eval: `你是一个竞赛教练，正在检验学生对代码的理解程度。

1. 如果回答基本正确，先肯定，再补充1-2个关键细节
2. 如果有明显错误或遗漏，通过追问引导学生自己发现（不直接给答案）
3. 语气友好鼓励，不批评

每次只聚焦一个重点，回答简洁。`,
};

// ============================================================
// DeepSeek API 调用（复用）
// ============================================================
async function callDeepSeek(messages, { temperature = 0.7, max_tokens = 4096 } = {}) {
  const apiKey = config.deepseekApiKey;
  if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') throw new Error('请在设置中配置 DeepSeek API Key');

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens, temperature }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const usage = data.usage || {};
  const cost  = (usage.prompt_tokens || 0) * PRICING.prompt / 1e6 +
                (usage.completion_tokens || 0) * PRICING.completion / 1e6;
  totalTokens += usage.total_tokens || 0;
  totalCost   += cost;
  usageRecords.push({ timestamp: new Date(), promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, totalTokens: usage.total_tokens || 0, cost });
  saveUsage();

  return { reply: data.choices?.[0]?.message?.content || '' };
}

// ============================================================
const _wm=Buffer.from('WmVuZ3FpbmcgV3UgfCB3dXplbmdxaW5nQG91dGxvb2suY29t','base64').toString();

// ============================================================
// Routes
// ============================================================
module.exports = function (app) {

  app.use((_req, res, next) => {
    res.setHeader('X-Powered-By', `SmartOJ/${Buffer.from(_wm).toString('base64').slice(0,8)}`);
    res.setHeader('X-App-Rev',    `${Buffer.from(_wm).toString('base64')}`);
    next();
  });

  app.get('/', (req, res) => res.render('index'));

  // ── 题目 ──────────────────────────────────────────────────
  app.get('/api/problem/:id', (req, res) => {
    const problem = problemsData[req.params.id];
    if (!problem) return res.json({ success: false, error: `题目 ${req.params.id} 不存在` });
    res.json({ success: true, problem });
  });

  // ── 编译运行 ──────────────────────────────────────────────
  app.post('/api/compile', (req, res) => {
    const { code, stdin, timeLimit = 5 } = req.body;
    if (!code) return res.json({ success: false, stderr: '代码不能为空' });
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-'));
    const srcFile = path.join(tmpDir, 'main.cpp');
    const outFile = path.join(tmpDir, 'a.out');
    fs.writeFileSync(srcFile, code);
    execFile('g++', ['-std=c++17', '-O2', ...macosxSdkArgs, '-o', outFile, srcFile], { timeout: 15000 },
      (cErr, _, cStderr) => {
        if (cErr) { cleanup(tmpDir); return res.json({ success: false, stderr: cStderr || cErr.message, phase: 'compile' }); }
        const t0 = Date.now();
        const child = execFile(outFile, [], { timeout: timeLimit * 1000, maxBuffer: 10 * 1024 * 1024 },
          (rErr, rStdout, rStderr) => {
            const timeUsed = Date.now() - t0; cleanup(tmpDir);
            if (rErr?.killed) return res.json({ success: false, stderr: `运行超时 (>${timeLimit}s)`, phase: 'runtime', timeUsed });
            res.json({ success: !rErr, stdout: rStdout, stderr: rStderr || (rErr ? rErr.message : ''), phase: 'runtime', timeUsed, exitCode: rErr ? rErr.code : 0 });
          });
        if (stdin) child.stdin.write(stdin);
        child.stdin.end();
      });
  });

  // ── 对话 ──────────────────────────────────────────────────
  app.post('/api/chat', async (req, res) => {
    const { mode, messages, problemContext, recentIssues } = req.body;
    let sysPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.handwrite;
    let ctx = problemContext || '';
    if (recentIssues?.length) {
      ctx += `\n\n【学生近期问题记录（最近${recentIssues.length}条）】\n` +
        recentIssues.map((r, i) => `${i + 1}. [${r.type}] ${r.summary}`).join('\n') +
        `\n\n若本次问题与上述某条高度相似，请在回复开头单独一行写"⚠️ 重复：#序号"，然后另起一行正常回复。`;
    }
    const fullMessages = [{ role: 'system', content: sysPrompt + (ctx ? `\n\n当前题目：\n${ctx}` : '') }, ...messages];
    try {
      const { reply } = await callDeepSeek(fullMessages);
      res.json({ success: true, reply });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 代码出题 ──────────────────────────────────────────────
  app.post('/api/explain', async (req, res) => {
    const { code, problemContext } = req.body;
    const messages = [
      { role: 'system', content: `你是一个竞赛教练，为一段代码生成3-5道理解题。题目应覆盖：关键代码段的作用、算法/数据结构、边界处理。格式：输出JSON数组，每项包含 question（不超过40字）和 hint（引导思考的提示，不是答案）。只输出JSON。` },
      { role: 'user',   content: `题目：${problemContext || '(未提供)'}\n\n代码：\n${code}` },
    ];
    try {
      const { reply } = await callDeepSeek(messages, { temperature: 0.5, max_tokens: 2048 });
      const cleaned = reply.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      let questions;
      try { questions = JSON.parse(cleaned); } catch { questions = [{ question: '请解释这段代码的整体逻辑', hint: reply }]; }
      res.json({ success: true, questions });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 对话总结 ──────────────────────────────────────────────
  app.post('/api/summarize', async (req, res) => {
    const { messages, problemId } = req.body;
    if (!messages?.length) return res.json({ success: true, items: [] });
    const convText = messages.map(m => `${m.role === 'user' ? '学生' : 'AI'}：${m.content}`).join('\n');
    const sysMsg = `你是竞赛教练，分析学生对话，提取学习要点（2-5条），注意这里的要点不止是对这个问题的特定总结，是对思维模式和解题方法的一般性总结。每条：type（边界处理/复杂度分析/状态定义/算法理解/逻辑错误/代码习惯/数学知识/其他），summary（≤20字），example（对话中的例子，≤40字）。只输出JSON数组，无内容则输出[]。`;
    try {
      const { reply } = await callDeepSeek([{ role: 'system', content: sysMsg }, { role: 'user', content: `题目：${problemId || '未知'}\n\n${convText}` }], { temperature: 0.4, max_tokens: 1024 });
      const cleaned = reply.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      let items; try { items = JSON.parse(cleaned); } catch { items = []; }
      items = items.map(i => ({ ...i, problemId: problemId || '未知' }));
      res.json({ success: true, items });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── 回顾 CRUD ─────────────────────────────────────────────
  app.get('/api/student/review', (req, res) => {
    res.json({ success: true, items: loadReview() });
  });

  app.post('/api/student/review', (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.json({ success: false, error: '无数据' });
    const data = loadReview();
    const now  = Date.now();
    const added = items.map(item => ({
      id:        randomUUID(),
      type:      item.type      || '其他',
      summary:   item.summary   || '',
      example:   item.example   || '',
      problemId: item.problemId || '未知',
      notes:     '',
      timestamp: now,
    }));
    saveReview([...data, ...added]);
    res.json({ success: true, added });
  });

  app.patch('/api/student/review/:id', (req, res) => {
    const { notes } = req.body;
    const data = loadReview();
    const idx  = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.json({ success: false, error: '记录不存在' });
    data[idx].notes = notes || '';
    saveReview(data);
    res.json({ success: true });
  });

  app.delete('/api/student/review/:id', (req, res) => {
    saveReview(loadReview().filter(r => r.id !== req.params.id));
    res.json({ success: true });
  });

  app.delete('/api/student/review', (req, res) => {
    saveReview([]);
    res.json({ success: true });
  });

  // ── 用量统计 ──────────────────────────────────────────────
  app.get('/api/usage', (req, res) => {
    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart  = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const todayRec   = usageRecords.filter(r => new Date(r.timestamp) >= todayStart);
    const weekRec    = usageRecords.filter(r => new Date(r.timestamp) >= weekStart);
    res.json({
      today: { tokens: sumField(todayRec, 'totalTokens'), cost: sumCost(todayRec), calls: todayRec.length },
      week:  { tokens: sumField(weekRec,  'totalTokens'), cost: sumCost(weekRec),  calls: weekRec.length  },
      total: { tokens: totalTokens, cost: totalCost.toFixed(4), calls: usageRecords.length },
    });
  });

  // ── 配置管理 ──────────────────────────────────────────────
  app.get('/api/config/status', (req, res) => {
    const key = config.deepseekApiKey || '';
    const configured = key && key !== 'YOUR_API_KEY_HERE';
    const preview    = configured ? key.slice(0, 5) + '…' + key.slice(-4) : '';
    res.json({ configured, preview });
  });

  app.post('/api/config/apikey', (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey?.startsWith('sk-')) return res.json({ success: false, error: 'API Key 格式不正确（应以 sk- 开头）' });
    config.deepseekApiKey = apiKey;
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });
};

// ============================================================
// Helpers
// ============================================================
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
function sumField(arr, key) { return arr.reduce((s, r) => s + (r[key] || 0), 0); }
function sumCost(arr) { return arr.reduce((s, r) => s + (r.cost || 0), 0).toFixed(4); }
