// ============================================================
// SmartOJ — Frontend Logic
// ============================================================
// @rev WmVuZ3FpbmcgV3UgfCB3dXplbmdxaW5nQG91dGxvb2suY29t

(function () {
  'use strict';

  const _$ = Object.freeze({ s: 'WmVuZ3FpbmcgV3UgfCB3dXplbmdxaW5nQG91dGxvb2suY29t', v: 1 });
  void _$;

  // ── 状态 ──
  let currentMode      = 'handwrite';
  let activeTab        = 'qa';
  let qaChatHistory    = [];
  let problemContext   = '';
  let currentProblemId = '';
  let isLoading        = false;
  let reviewMode       = false;

  // 代码提问 Tab
  let codeQuestions = [];
  let answeredCount = 0;

  // 回顾本地缓存（从 API 加载后更新）
  let reviewCache = [];

  // ── DOM refs ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const codeEditor       = $('#codeEditor');
  const stdinInput       = $('#stdinInput');
  const compileBtn       = $('#compileBtn');
  const outputContent    = $('#outputContent');
  const outputMeta       = $('#outputMeta');
  const outputBar        = $('#outputBar');
  const problemBanner    = $('#problemBanner');
  const problemTitle     = $('#problemTitle');
  const problemDesc      = $('#problemDesc');
  const problemSamples   = $('#problemSamples');
  const bannerMeta       = $('#bannerMeta');
  const problemIdInput   = $('#problemId');
  const settingsModal    = $('#settingsModal');
  const generateCodeBtn  = $('#generateCodeBtn');
  const qqList           = $('#qqList');
  const qaChatMessages   = $('#qaChatMessages');
  const chatInput        = $('#chatInput');
  const sendBtn          = $('#sendBtn');
  const panelChat        = $('#panelChat');
  const reviewHeaderBtn  = $('#reviewHeaderBtn');
  const reviewTableBody  = $('#reviewTableBody');
  const reviewTable      = $('#reviewTable');
  const reviewEmpty      = $('#reviewEmpty');
  const reviewCount      = $('#reviewCount');
  const toast            = $('#toast');
  // 代码提问 Tab
  const codeQaEmpty  = $('#codeQaEmpty');
  const codeQaWrap   = $('#codeQaWrap');
  const codeQaList   = $('#codeQaList');
  const qaProgress   = $('#qaProgress');
  const genQaBtn     = $('#genQaBtn');
  const regenQaBtn   = $('#regenQaBtn');

  // ── 快捷问题 ──
  const QUICK_QUESTIONS = {
    handwrite: ['这道题的题意是什么？', '我的程序为什么错了？', '有没有更好的实现方式？', '我的时间复杂度是多少？', '帮我分析一下边界情况'],
    verify:    ['帮我理清一下思路', '我的状态定义对吗？', '转移方程有没有问题？', '复杂度够不够？', '边界条件怎么处理？'],
  };

  // ============================================================
  // 回顾入口（header 按钮，与 Tab Pane 互斥）
  // ============================================================
  reviewHeaderBtn.addEventListener('click', () => {
    reviewMode = !reviewMode;
    reviewHeaderBtn.classList.toggle('active', reviewMode);
    panelChat.classList.toggle('in-review', reviewMode);
    if (reviewMode) loadAndRenderReviewTable();
  });

  // ============================================================
  // Tab 切换（仅 qa / code）
  // ============================================================
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === activeTab && !reviewMode) return;

      // 如果当前在回顾模式，先退出
      if (reviewMode) {
        reviewMode = false;
        reviewHeaderBtn.classList.remove('active');
        panelChat.classList.remove('in-review');
      }

      activeTab = tab;
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-pane').forEach((p) => p.classList.remove('active'));
      $(`#tab-${tab}`).classList.add('active');

      $('#qaActions').style.display   = tab === 'qa'   ? '' : 'none';
      $('#codeActions').style.display = tab === 'code' ? '' : 'none';
    });
  });

  // ============================================================
  // 模式切换
  // ============================================================
  $$('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      updateModeUI();
      clearQaChat();
    });
  });

  function updateModeUI() {
    generateCodeBtn.style.display = currentMode === 'verify' ? '' : 'none';
    renderQuickQuestions();
    chatInput.placeholder = currentMode === 'handwrite' ? '关于题意、代码问题的提问…' : '描述你的解题思路…';
  }

  function renderQuickQuestions() {
    const questions = QUICK_QUESTIONS[currentMode] || [];
    qqList.innerHTML = questions.map((q) => `<button class="qq-btn">${q}</button>`).join('');
    qqList.querySelectorAll('.qq-btn').forEach((btn) => {
      btn.addEventListener('click', () => { chatInput.value = btn.textContent; chatInput.focus(); });
    });
  }

  // ============================================================
  // 通用消息渲染
  // ============================================================
  function appendMessage(chatEl, role, content, isRepeat = false) {
    const welcome = chatEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const row = document.createElement('div');
    row.className = `chat-msg-row ${role}${isRepeat ? ' repeat' : ''}`;

    const bubble = document.createElement('div');
    bubble.className = `chat-msg ${role}`;

    if (isRepeat && role === 'assistant') {
      const lines     = content.split('\n');
      const repeatLine = lines.find(l => l.startsWith('⚠️'));
      const rest       = lines.filter(l => !l.startsWith('⚠️')).join('\n').trim();
      const badge      = document.createElement('div');
      badge.className  = 'repeat-badge';
      badge.textContent = repeatLine || '⚠️ 你之前也问过类似的问题';
      bubble.appendChild(badge);
      bubble.appendChild(document.createTextNode('\n' + rest));
    } else {
      bubble.textContent = content;
    }

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (role !== 'system') {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-action-btn';
      copyBtn.title = '复制';
      copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(content).catch(() => {});
        copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
        }, 1500);
      });
      actions.appendChild(copyBtn);
    }

    row.appendChild(bubble);
    row.appendChild(actions);
    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;
    return bubble;
  }

  function appendLoadingIndicator(chatEl, id = 'loadingIndicator') {
    const row    = document.createElement('div');
    row.className = 'chat-msg-row assistant';
    row.id = id;
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg assistant';
    bubble.innerHTML = '思考中<span class="loading-dots"></span>';
    row.appendChild(bubble);
    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  // ============================================================
  // 问答 Tab — 发送消息
  // ============================================================
  sendBtn.addEventListener('click', sendQaMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQaMessage(); }
  });

  async function sendQaMessage() {
    const text = chatInput.value.trim();
    if (!text || isLoading) return;

    appendMessage(qaChatMessages, 'user', text);
    qaChatHistory.push({ role: 'user', content: text });
    logChat('user', text);
    chatInput.value = '';
    setLoading(true);

    let extraContext = problemContext;
    if (currentMode === 'handwrite' && codeEditor.value.trim()) {
      extraContext += `\n\n学生当前的代码：\n\`\`\`cpp\n${codeEditor.value}\n\`\`\``;
    }

    const recentIssues = getRecentIssues(10);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: currentMode, messages: qaChatHistory, problemContext: extraContext, recentIssues }),
      });
      const data = await res.json();
      if (data.success) {
        const isRepeat = data.reply.includes('⚠️');
        appendMessage(qaChatMessages, 'assistant', data.reply, isRepeat);
        qaChatHistory.push({ role: 'assistant', content: data.reply });
        logChat('LLM', data.reply);
      } else {
        appendMessage(qaChatMessages, 'system', '错误：' + (data.error || '请求失败'));
      }
    } catch (err) {
      appendMessage(qaChatMessages, 'system', '网络错误：' + err.message);
    }
    setLoading(false);
  }

  function setLoading(v) {
    isLoading = v;
    sendBtn.disabled = v;
    if (v) appendLoadingIndicator(qaChatMessages);
    else { const el = $('#loadingIndicator'); if (el) el.remove(); }
  }

  function clearQaChat() {
    qaChatHistory = [];
    qaChatMessages.innerHTML = `
      <div class="chat-welcome">
        <p>${currentMode === 'handwrite' ? '手写模式：独立完成代码，我可以帮你分析问题。' : '思路验证模式：描述你的解题思路，我来帮你理清。'}</p>
        <p class="chat-welcome-sub">通过提问引导思考，不直接给答案。</p>
      </div>`;
  }

  // ============================================================
  // 按思路生成代码
  // ============================================================
  generateCodeBtn.addEventListener('click', async () => {
    if (isLoading || qaChatHistory.length === 0) {
      if (!isLoading) appendMessage(qaChatMessages, 'system', '请先描述你的解题思路。');
      return;
    }
    appendMessage(qaChatMessages, 'user', '请根据我的思路生成 C++ 代码');
    qaChatHistory.push({ role: 'user', content: '请根据我描述的思路，严格按照我的方法生成完整的C++代码。使用C++17标准，包含完整的输入输出。不要修改我的思路或用其他方法替代。' });
    setLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'verify', messages: qaChatHistory, problemContext }),
      });
      const data = await res.json();
      if (data.success) {
        appendMessage(qaChatMessages, 'assistant', data.reply);
        qaChatHistory.push({ role: 'assistant', content: data.reply });
        const codeMatch = data.reply.match(/```(?:cpp|c\+\+)?\n([\s\S]*?)```/);
        if (codeMatch) codeEditor.value = codeMatch[1].trim();
      } else {
        appendMessage(qaChatMessages, 'system', '错误：' + (data.error || '请求失败'));
      }
    } catch (err) {
      appendMessage(qaChatMessages, 'system', '网络错误：' + err.message);
    }
    setLoading(false);
  });

  // ============================================================
  // 代码提问 Tab — 生成理解问题
  // ============================================================
  genQaBtn.addEventListener('click', generateCodeQA);
  regenQaBtn.addEventListener('click', generateCodeQA);

  async function generateCodeQA() {
    const code = codeEditor.value.trim();
    if (!code) {
      codeQaEmpty.querySelector('p').textContent = '请先在左侧编辑器写入或生成代码，再来出题。';
      return;
    }
    genQaBtn.disabled = true;
    genQaBtn.innerHTML = `<span class="loading-dots">生成中</span>`;
    if (regenQaBtn) regenQaBtn.disabled = true;

    try {
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, problemContext }),
      });
      const data = await res.json();
      if (data.success && data.questions?.length > 0) {
        codeQuestions = data.questions;
        renderCodeQA(codeQuestions);
        codeQaEmpty.style.display = 'none';
        codeQaWrap.style.display  = '';
      } else {
        codeQaEmpty.querySelector('p').textContent = '生成失败：' + (data.error || '请重试');
      }
    } catch (err) {
      codeQaEmpty.querySelector('p').textContent = '网络错误：' + err.message;
    }

    genQaBtn.disabled = false;
    genQaBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> 生成理解问题`;
    if (regenQaBtn) regenQaBtn.disabled = false;
  }

  function renderCodeQA(questions) {
    answeredCount = 0;
    updateQaProgress(0, questions.length);
    codeQaList.innerHTML = '';
    questions.forEach((q, i) => {
      const card = document.createElement('div');
      card.className = 'qa-card';
      card.innerHTML = `
        <div class="qa-header">
          <div class="qa-num">${i + 1}</div>
          <div class="qa-question">${escapeHtml(q.question)}</div>
        </div>
        <div class="qa-input-wrap">
          <textarea class="qa-input" placeholder="写下你的理解… (Ctrl+Enter 提交)" rows="3"></textarea>
          <div class="qa-submit-row">
            <button class="qa-submit">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              提交回答
            </button>
          </div>
        </div>
        <div class="qa-feedback"></div>`;

      const submitBtn  = card.querySelector('.qa-submit');
      const inputEl    = card.querySelector('.qa-input');
      const feedbackEl = card.querySelector('.qa-feedback');

      submitBtn.addEventListener('click', () => submitQaAnswer(card, q, inputEl, submitBtn, feedbackEl));
      inputEl.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submitBtn.click(); }
      });
      codeQaList.appendChild(card);
    });
  }

  async function submitQaAnswer(card, q, inputEl, submitBtn, feedbackEl) {
    const answer = inputEl.value.trim();
    if (!answer) return;
    inputEl.disabled = submitBtn.disabled = true;
    feedbackEl.className = 'qa-feedback visible loading';
    feedbackEl.innerHTML = '评价中<span class="loading-dots"></span>';
    logChat('user', `[代码提问] 问题：${q.question} | 回答：${answer}`);

    let codeContext = problemContext;
    if (codeEditor.value.trim()) codeContext += `\n\n代码：\n\`\`\`cpp\n${codeEditor.value}\n\`\`\``;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'code_eval',
          messages: [{ role: 'user', content: `问题：${q.question}\n\n我的回答：${answer}` }],
          problemContext: codeContext,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const reply  = data.reply || '';
        const isHint = /不|错|漏|缺|再想|想想|考虑|试着|检查/u.test(reply.slice(0, 60));
        feedbackEl.className  = `qa-feedback visible ${isHint ? 'hint' : 'good'}`;
        feedbackEl.textContent = reply;
        logChat('LLM', `[代码提问反馈] ${reply}`);
        if (!card.classList.contains('answered')) {
          card.classList.add('answered');
          answeredCount++;
          updateQaProgress(answeredCount, codeQuestions.length);
        }
      } else {
        feedbackEl.className  = 'qa-feedback visible';
        feedbackEl.textContent = '评价失败：' + (data.error || '请重试');
        inputEl.disabled = submitBtn.disabled = false;
      }
    } catch (err) {
      feedbackEl.className  = 'qa-feedback visible';
      feedbackEl.textContent = '网络错误：' + err.message;
      inputEl.disabled = submitBtn.disabled = false;
    }
  }

  function updateQaProgress(done, total) {
    qaProgress.textContent = `${done} / ${total} 已回答`;
    qaProgress.className   = done === total && total > 0 ? 'qa-progress done' : 'qa-progress';
  }

  // ============================================================
  // 总结按钮
  // ============================================================
  $('#summarizeQaBtn').addEventListener('click', () => summarizeConversation(qaChatHistory, 'qa'));
  $('#summarizeCodeBtn').addEventListener('click', () => {
    const msgs = [];
    codeQaList.querySelectorAll('.qa-card').forEach((card) => {
      const q        = card.querySelector('.qa-question')?.textContent || '';
      const answer   = card.querySelector('.qa-input')?.value || '';
      const feedback = card.querySelector('.qa-feedback')?.textContent || '';
      if (answer) {
        msgs.push({ role: 'user',      content: `问题：${q}\n回答：${answer}` });
        if (feedback) msgs.push({ role: 'assistant', content: feedback });
      }
    });
    summarizeConversation(msgs, 'code');
  });

  async function summarizeConversation(messages, source) {
    if (!messages || messages.length === 0) {
      showToast('没有可总结的对话内容');
      return;
    }
    showToast('正在总结…', true);
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, problemId: currentProblemId || '未知', source }),
      });
      const data = await res.json();
      if (data.success && data.items?.length > 0) {
        await addReviewItems(data.items);
        showToast(`已添加 ${data.items.length} 条回顾记录 ✓`);
        // 切换到回顾视图
        if (!reviewMode) reviewHeaderBtn.click();
      } else if (data.success) {
        showToast('本次对话暂无明显问题，继续加油！');
      } else {
        showToast('总结失败：' + (data.error || '请重试'));
      }
    } catch (err) {
      showToast('网络错误：' + err.message);
    }
  }

  // ============================================================
  // 回顾 — API 读写（替代 localStorage）
  // ============================================================
  function getRecentIssues(n = 10) {
    return reviewCache.slice(-n).map(({ type, summary }) => ({ type, summary }));
  }

  async function addReviewItems(items) {
    try {
      const res = await fetch('/api/student/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (data.success) {
        reviewCache = [...reviewCache, ...data.added];
      }
    } catch {}
  }

  async function loadAndRenderReviewTable() {
    reviewCount.textContent = '加载中…';
    try {
      const res  = await fetch('/api/student/review');
      const data = await res.json();
      reviewCache = data.items || [];
      renderReviewTable(reviewCache);
    } catch {
      reviewCount.textContent = '加载失败';
    }
  }

  function renderReviewTable(data) {
    reviewCount.textContent = `共 ${data.length} 条记录`;

    if (data.length === 0) {
      reviewEmpty.style.display = '';
      reviewTable.style.display = 'none';
      return;
    }
    reviewEmpty.style.display = 'none';
    reviewTable.style.display = '';
    reviewTableBody.innerHTML = '';

    data.forEach((item) => {
      const tr = document.createElement('tr');
      const typeClass = (item.type || '其他').replace(/\s/g, '');
      tr.innerHTML = `
        <td class="col-type"><span class="type-badge type-${typeClass}">${escapeHtml(item.type)}</span></td>
        <td class="col-summary">${escapeHtml(item.summary)}</td>
        <td class="col-example" style="color:var(--text-secondary);font-size:12px">${escapeHtml(item.example)}</td>
        <td class="col-problem"><span class="problem-badge">${escapeHtml(String(item.problemId))}</span></td>
        <td class="col-notes"><textarea class="notes-input" placeholder="写下你的笔记…">${escapeHtml(item.notes || '')}</textarea></td>
        <td class="col-del"><button class="delete-review-btn" title="删除这条记录">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button></td>`;

      const notesEl = tr.querySelector('.notes-input');
      notesEl.addEventListener('blur', async () => {
        try {
          await fetch(`/api/student/review/${item.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: notesEl.value }),
          });
          const c = reviewCache.find(r => r.id === item.id);
          if (c) c.notes = notesEl.value;
        } catch {}
      });

      tr.querySelector('.delete-review-btn').addEventListener('click', async () => {
        try {
          await fetch(`/api/student/review/${item.id}`, { method: 'DELETE' });
          reviewCache = reviewCache.filter(r => r.id !== item.id);
          renderReviewTable(reviewCache);
        } catch { showToast('删除失败，请重试'); }
      });

      reviewTableBody.appendChild(tr);
    });
  }

  // 清空所有回顾
  $('#clearReviewBtn').addEventListener('click', async () => {
    if (!confirm('确定要清空所有回顾记录吗？')) return;
    try {
      await fetch('/api/student/review', { method: 'DELETE' });
      reviewCache = [];
      renderReviewTable([]);
    } catch { showToast('清空失败，请重试'); }
  });

  // ============================================================
  // 题目加载（从 API 或粘贴）
  // ============================================================
  $('#loadProblem').addEventListener('click', loadProblem);
  problemIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadProblem(); });

  async function loadProblem() {
    const input = problemIdInput.value.trim();
    if (!input) return;

    if (input.length > 50) {
      currentProblemId = input.substring(0, 10);
      problemTitle.textContent = '自定义题目';
      bannerMeta.innerHTML = '';
      problemDesc.textContent = input;
      problemSamples.innerHTML = '';
      problemContext = input;
      problemBanner.classList.remove('collapsed');
      updateModeUI();
      return;
    }

    try {
      const res  = await fetch(`/api/problem/${input}`);
      const data = await res.json();

      if (data.success) {
        const p = data.problem;
        currentProblemId = p.id;
        problemTitle.textContent = p.title;

        bannerMeta.innerHTML = `
          <span class="banner-badge">⏱ ${p.timeLimit}s</span>
          <span class="banner-badge">💾 ${p.memoryLimit}MB</span>`;

        let descHtml = '';
        if (p.description) descHtml += `<div class="problem-desc">${escapeHtml(p.description)}</div>`;
        if (p.inputDesc)   descHtml += `<div class="problem-section-title">输入格式</div><div class="problem-desc">${escapeHtml(p.inputDesc)}</div>`;
        if (p.outputDesc)  descHtml += `<div class="problem-section-title">输出格式</div><div class="problem-desc">${escapeHtml(p.outputDesc)}</div>`;
        problemDesc.innerHTML = descHtml || '（无题面描述）';

        problemSamples.innerHTML = '';
        (p.samples || []).forEach((s, i) => {
          const pair = document.createElement('div');
          pair.className = 'sample-pair';
          pair.innerHTML = `
            <div class="sample-box">
              <span class="sample-label">样例输入 ${i + 1}</span>${escapeHtml(s.input)}
            </div>
            <div class="sample-box">
              <span class="sample-label">样例输出 ${i + 1}</span>${escapeHtml(s.output)}
            </div>`;
          problemSamples.appendChild(pair);
        });

        problemContext = `题目：${p.title}（#${p.id}）\n\n${p.description || ''}`;
        if (p.inputDesc)  problemContext += `\n\n输入格式：${p.inputDesc}`;
        if (p.outputDesc) problemContext += `\n\n输出格式：${p.outputDesc}`;
        if (p.samples?.length) {
          problemContext += '\n\n样例：\n' + p.samples.map((s, i) =>
            `样例${i + 1}输入：\n${s.input}\n样例${i + 1}输出：\n${s.output}`
          ).join('\n\n');
        }
      } else {
        currentProblemId = input;
        problemTitle.textContent = `题目 #${input}`;
        bannerMeta.innerHTML = '';
        problemDesc.textContent = `题目 ${input} 在本地题库中暂无（可在输入框直接粘贴题面文本）`;
        problemSamples.innerHTML = '';
        problemContext = `题目编号：${input}`;
      }

      problemBanner.classList.remove('collapsed');
      updateModeUI();
    } catch (err) {
      showToast('加载题目失败：' + err.message);
    }
  }

  // ============================================================
  // 折叠切换
  // ============================================================
  $('#toggleProblem').addEventListener('click', () => problemBanner.classList.toggle('collapsed'));
  $('#toggleOutput').addEventListener('click',  () => outputBar.classList.toggle('collapsed'));

  // ============================================================
  // 编译运行
  // ============================================================
  compileBtn.addEventListener('click', runCompile);
  codeEditor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCompile(); }
  });

  async function runCompile() {
    const code = codeEditor.value;
    if (!code.trim()) { showOutput('代码不能为空', true); outputBar.classList.remove('collapsed'); return; }

    compileBtn.disabled = true;
    compileBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    outputContent.textContent = '编译中…';
    outputContent.className = 'output-content';
    outputMeta.textContent = '';
    outputBar.classList.remove('collapsed');

    try {
      const res  = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, stdin: stdinInput.value, timeLimit: 5 }) });
      const data = await res.json();
      if (data.success) {
        showOutput(data.stdout || '(无输出)', false);
        outputMeta.textContent = `运行时间：${data.timeUsed}ms`;
      } else {
        showOutput(data.stderr || '编译/运行失败', true);
        if (data.phase) outputMeta.textContent = `阶段：${data.phase}`;
      }
    } catch (err) { showOutput('请求失败：' + err.message, true); }

    compileBtn.disabled = false;
    compileBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }

  function showOutput(text, isError) {
    outputContent.textContent = text;
    outputContent.className   = 'output-content ' + (isError ? 'error' : 'success');
  }

  // ============================================================
  // 设置弹窗
  // ============================================================
  $('#settingsBtn').addEventListener('click', async () => {
    settingsModal.classList.add('open');
    // 用量统计
    try {
      const res  = await fetch('/api/usage');
      const data = await res.json();
      $('#usageToday').textContent     = formatTokens(data.today.tokens);
      $('#usageTodayCost').textContent = `¥${data.today.cost} · ${data.today.calls} 次`;
      $('#usageWeek').textContent      = formatTokens(data.week.tokens);
      $('#usageWeekCost').textContent  = `¥${data.week.cost} · ${data.week.calls} 次`;
      $('#usageTotal').textContent     = formatTokens(data.total.tokens);
      $('#usageTotalCost').textContent = `¥${data.total.cost} · ${data.total.calls} 次`;
    } catch {}
    // API Key 状态
    try {
      const res  = await fetch('/api/config/status');
      const data = await res.json();
      const hint = $('#apiKeyStatus');
      if (data.configured) {
        hint.textContent = `已配置 ✓（${data.preview}）`;
        hint.style.color = 'var(--success)';
      } else {
        hint.textContent = '未配置 — 请粘贴 API Key 后保存';
        hint.style.color = 'var(--warning)';
      }
    } catch {}
  });

  $('#closeSettings').addEventListener('click', () => settingsModal.classList.remove('open'));
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

  // API Key — 保存
  $('#saveApiKeyBtn').addEventListener('click', async () => {
    const apiKeyInput = $('#apiKeyInput');
    const key = apiKeyInput.value.trim();
    if (!key) { showToast('请先粘贴 API Key'); return; }
    try {
      const res  = await fetch('/api/config/apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('API Key 已保存 ✓');
        apiKeyInput.value = '';
        const hint = $('#apiKeyStatus');
        hint.textContent = '已更新 ✓ — 重新打开设置查看状态';
        hint.style.color = 'var(--success)';
      } else {
        showToast('保存失败：' + (data.error || '请检查 Key 格式'));
      }
    } catch (err) { showToast('网络错误：' + err.message); }
  });

  // API Key — 禁止复制/剪切
  document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = $('#apiKeyInput');
    if (apiKeyInput) {
      apiKeyInput.addEventListener('copy', (e) => e.preventDefault());
      apiKeyInput.addEventListener('cut',  (e) => e.preventDefault());
    }
  });

  // ============================================================
  // Tab（代码编辑器）
  // ============================================================
  codeEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = codeEditor.selectionStart, en = codeEditor.selectionEnd;
      codeEditor.value = codeEditor.value.substring(0, s) + '    ' + codeEditor.value.substring(en);
      codeEditor.selectionStart = codeEditor.selectionEnd = s + 4;
    }
  });

  // ============================================================
  // Toast 提示（使用 HTML 中的 #toast 元素）
  // ============================================================
  let toastTimer = null;
  function showToast(msg, persist = false) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    if (!persist) toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  }

  // ============================================================
  // 对话日志
  // ============================================================
  function logChat(role, content) {
    const row = {
      problemId: currentProblemId || '',
      timestamp: new Date().toISOString(),
      role,
      content,
    };
    fetch('/api/student/chat-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [row] }),
    }).catch(() => {});
  }

  // ============================================================
  // 工具函数
  // ============================================================
  function formatTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ============================================================
  // 初始化
  // ============================================================
  updateModeUI();

  // 预加载回顾缓存（供 getRecentIssues 使用）
  fetch('/api/student/review')
    .then(r => r.json())
    .then(d => { reviewCache = d.items || []; })
    .catch(() => {});

  // API Key 防复制（初始化时直接绑定，兼容不同 DOM ready 时机）
  const apiKeyInputEl = $('#apiKeyInput');
  if (apiKeyInputEl) {
    apiKeyInputEl.addEventListener('copy', (e) => e.preventDefault());
    apiKeyInputEl.addEventListener('cut',  (e) => e.preventDefault());
  }
})();
