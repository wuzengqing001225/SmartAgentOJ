// ============================================================
// SNG SmartOJ — Frontend Logic
// ============================================================
// @rev WmVuZ3FpbmcgV3UgfCB3dXplbmdxaW5nQG91dGxvb2suY29t

(function () {
  'use strict';

  const _$ = Object.freeze({ s: 'WmVuZ3FpbmcgV3UgfCB3dXplbmdxaW5nQG91dGxvb2suY29t', v: 2 });
  void _$;

  // ── 全局状态 ──────────────────────────────────────────────
  let currentMode      = 'handwrite';
  let activeTab        = 'qa';
  let problemContext   = '';
  let currentProblemId = '';
  let isLoading        = false;
  let reviewMode       = false;

  // 会话进程状态
  let sessions          = [];     // [{key, name, messageCount, updatedAt}]
  let activeSessionKey  = 'main';
  let sessionHistories  = {};     // {key: [{role, content}]}
  let sessionBlocks     = {};     // {key: [{summary, startIdx, endIdx}]}
  let sessionSaveTimer  = null;

  // 代码文件状态
  let codeFiles        = [];      // [{filename, description, createdAt}]
  let activeCodeFile   = null;    // filename string or null
  let codeFileSaved    = true;    // 是否已保存
  let codeSaveTimer    = null;

  // 提示层级：0=仅追问, 1=给提示词, 2=给框架
  let hintLevel = 0;

  // 代码提问 Tab
  let codeQuestions = [];         // [{question, hint}]
  let codeQaThreads = [];         // [{question, hint, history: [{role, content}]}]
  let activeQaIndex = 0;
  let answeredCount  = 0;
  let codeQaLoading = false;

  // 回顾本地缓存
  let reviewCache = [];

  // ── DOM 引用 ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const codeEditor      = $('#codeEditor');
  const codeDescInput   = $('#codeDescInput');
  const stdinInput      = $('#stdinInput');
  const compileBtn      = $('#compileBtn');
  const outputContent   = $('#outputContentInline');
  const outputMeta      = $('#outputMetaInline');
  const outputBar       = null;
  const problemBanner   = $('#problemBanner');
  const problemTitle    = $('#problemTitle');
  const problemDesc     = $('#problemDesc');
  const problemSamples  = $('#problemSamples');
  const bannerMeta      = $('#bannerMeta');
  const problemIdInput  = $('#problemId');
  const problemSuggest  = $('#problemSuggest');
  const settingsModal   = $('#settingsModal');
  const diffModal       = $('#diffModal');
  const generateCodeBtn = $('#generateCodeBtn');
  const qqList          = $('#qqList');
  const chatInput       = $('#chatInput');
  const sendBtn         = $('#sendBtn');
  const panelChat       = $('#panelChat');
  const reviewHeaderBtn = $('#reviewHeaderBtn');
  const reviewTableBody = $('#reviewTableBody');
  const reviewTable     = $('#reviewTable');
  const reviewEmpty     = $('#reviewEmpty');
  const reviewCount     = $('#reviewCount');
  const toast           = $('#toast');

  // 会话栏
  const sessionPills   = $('#sessionPills');
  const sessionAddBtn  = $('#sessionAddBtn');

  // 代码文件栏
  const codeFileBar      = $('#codeFileBar');
  const codeFileSelector = $('#codeFileSelector');
  const codeFileName     = $('#codeFileName');
  const fileDot          = $('#fileDot');
  const codeFileDropdown = $('#codeFileDropdown');
  const forkBtn          = $('#forkBtn');
  const diffBtn          = $('#diffBtn');

  // 代码提问 Tab
  const codeQaEmpty     = $('#codeQaEmpty');
  const codeQaWrap      = $('#codeQaWrap');
  const codeQaCarousel  = $('#codeQaCarousel');
  const qaProgress      = $('#qaProgress');
  const genQaBtn        = $('#genQaBtn');
  const regenQaBtn      = $('#regenQaBtn');
  const qaPrevBtn       = $('#qaPrevBtn');
  const qaNextBtn       = $('#qaNextBtn');
  const qaDots          = $('#qaDots');
  const codeQaInputWrap = $('#codeQaInputWrap');
  const codeChatInput   = $('#codeChatInput');
  const codeChatSendBtn = $('#codeChatSendBtn');

  // ── 快捷问题 ──────────────────────────────────────────────
  const QUICK_QUESTIONS = {
    handwrite: ['这道题的题意是什么？', '我的程序为什么错了？', '有没有更好的实现方式？', '我的时间复杂度是多少？', '帮我分析一下边界情况'],
    verify:    ['帮我理清一下思路', '我的状态定义对吗？', '转移方程有没有问题？', '复杂度够不够？', '边界条件怎么处理？'],
  };

  // ============================================================
  // 当前会话的消息列表（从 sessionHistories 读取）
  // ============================================================
  function getActiveHistory() {
    if (!sessionHistories[activeSessionKey]) sessionHistories[activeSessionKey] = [];
    return sessionHistories[activeSessionKey];
  }

  function setActiveHistory(history) {
    sessionHistories[activeSessionKey] = history;
  }

  // ============================================================
  // 会话进程 — 加载 & 保存
  // ============================================================
  async function loadSessions() {
    if (!currentProblemId) { renderSessionBar(); return; }
    try {
      const res  = await fetch(`/api/problem/${currentProblemId}/sessions`);
      const data = await res.json();
      sessions = data.sessions || [];

      // 第一次：后端可能还没有 main session，前端负责创建
      if (sessions.length === 0) {
        await createSession('main');
        sessions = [{ key: 'main', name: 'main', messageCount: 0, updatedAt: null }];
      }

      // 加载所有会话历史到缓存
      sessionHistories = {};
      sessionBlocks = {};
      for (const s of sessions) {
        const r = await fetch(`/api/problem/${currentProblemId}/sessions/${s.key}`);
        const d = await r.json();
        sessionHistories[s.key] = d.history || [];
        sessionBlocks[s.key] = d.blocks || [];
      }

      // 切换到 main（或第一个）
      activeSessionKey = sessions[0].key;
      renderSessionBar();
      renderChatFromHistory();
    } catch (e) {
      showToast('加载对话记录失败：' + e.message);
    }
  }

  async function createSession(name) {
    if (!currentProblemId) return null;
    const res  = await fetch(`/api/problem/${currentProblemId}/sessions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name }),
    });
    return await res.json();
  }

  function getActiveBlocks() {
    if (!sessionBlocks[activeSessionKey]) sessionBlocks[activeSessionKey] = [];
    return sessionBlocks[activeSessionKey];
  }

  async function saveCurrentSession() {
    if (!currentProblemId || !activeSessionKey) return;
    clearTimeout(sessionSaveTimer);
    try {
      await fetch(`/api/problem/${currentProblemId}/sessions/${activeSessionKey}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ history: getActiveHistory(), blocks: getActiveBlocks() }),
      });
      const s = sessions.find(s => s.key === activeSessionKey);
      if (s) s.messageCount = getActiveHistory().length;
    } catch {}
  }

  function scheduleSaveSession() {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(saveCurrentSession, 1000);
  }

  async function switchSession(key) {
    if (key === activeSessionKey) return;
    await saveCurrentSession();
    activeSessionKey = key;
    renderSessionBar();
    renderChatFromHistory();
  }

  async function deleteSessionByKey(key) {
    if (!currentProblemId) return;
    if (sessions.length <= 1) { showToast('至少保留一个对话进程'); return; }
    if (!confirm(`确定删除进程「${sessions.find(s => s.key === key)?.name || key}」？此操作不可撤销。`)) return;
    try {
      await fetch(`/api/problem/${currentProblemId}/sessions/${key}`, { method: 'DELETE' });
      delete sessionHistories[key];
      delete sessionBlocks[key];
      sessions = sessions.filter(s => s.key !== key);
      if (activeSessionKey === key) {
        activeSessionKey = sessions[0].key;
        renderChatFromHistory();
      }
      renderSessionBar();
    } catch { showToast('删除失败，请重试'); }
  }

  async function renameSession(key, newName) {
    if (!currentProblemId || !newName.trim()) return;
    try {
      await fetch(`/api/problem/${currentProblemId}/sessions/${key}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName.trim() }),
      });
      const s = sessions.find(s => s.key === key);
      if (s) s.name = newName.trim();
      renderSessionBar();
    } catch {}
  }

  // ============================================================
  // 会话进程栏渲染
  // ============================================================
  function renderSessionBar() {
    sessionPills.innerHTML = '';

    if (!currentProblemId) {
      const hint = document.createElement('span');
      hint.className = 'session-no-problem';
      hint.textContent = '加载题目后自动保存对话';
      sessionPills.appendChild(hint);
      return;
    }

    sessions.forEach(s => {
      const pill = document.createElement('div');
      pill.className = 'session-pill' + (s.key === activeSessionKey ? ' active' : '');
      pill.dataset.key = s.key;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'session-pill-name';
      nameSpan.textContent = s.name;

      const delBtn = document.createElement('button');
      delBtn.className = 'session-pill-del';
      delBtn.innerHTML = '×';
      delBtn.title = '删除此进程';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSessionByKey(s.key);
      });

      pill.appendChild(nameSpan);
      pill.appendChild(delBtn);

      // 单击切换
      pill.addEventListener('click', () => switchSession(s.key));

      // 双击重命名
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(pill, nameSpan, s);
      });

      sessionPills.appendChild(pill);
    });
  }

  function startRename(pill, nameSpan, session) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-pill-input';
    input.value = session.name;

    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = async () => {
      const newName = input.value.trim() || session.name;
      await renameSession(session.key, newName);
      // renderSessionBar() called inside renameSession
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = session.name; input.blur(); }
    });
  }

  // ============================================================
  // 新建会话进程
  // ============================================================
  sessionAddBtn.addEventListener('click', async () => {
    if (!currentProblemId) { showToast('请先加载一道题目'); return; }
    await saveCurrentSession();

    // 默认名称 sub1/2/3...
    const subCount = sessions.filter(s => s.key !== 'main').length;
    const defaultName = `sub${subCount + 1}`;

    const result = await createSession(defaultName);
    if (result?.success) {
      sessionHistories[result.key] = [];
      sessionBlocks[result.key] = [];
      sessions.push({ key: result.key, name: result.name, messageCount: 0, updatedAt: null });
      activeSessionKey = result.key;
      renderSessionBar();
      renderChatFromHistory();
    }
  });

  // ============================================================
  // 渲染聊天记录（从 sessionHistories 还原 UI）
  // ============================================================
  function renderChatFromHistory() {
    const history = getActiveHistory();
    const qaChatMessages = $('#qaChatMessages');
    qaChatMessages.innerHTML = '';

    if (history.length === 0) {
      const s = sessions.find(s => s.key === activeSessionKey);
      qaChatMessages.innerHTML = `
        <div class="chat-welcome">
          <p>${currentMode === 'handwrite' ? '手写模式：独立完成代码，我可以帮你分析问题。' : '思路验证模式：描述你的解题思路，我来帮你理清。'}</p>
          <p class="chat-welcome-sub">进程：${s ? s.name : activeSessionKey}</p>
        </div>`;
      renderOutline();
      return;
    }

    const blocks = getActiveBlocks();

    // 分割线逻辑：每个 block 的 startIdx 处插入该 block 的标题分割线
    // 最后一个 block 的 endIdx 处插入"当前讨论"分割线
    // 这样第一个话题的标题在最顶部，最新分割线是"当前讨论"
    const dividerAtIdx = {};  // msgIdx → { label, blockIdx }

    blocks.forEach((block, bIdx) => {
      dividerAtIdx[block.startIdx] = { label: block.summary, blockIdx: bIdx };
    });
    // "当前讨论"分割线放在最后一个 block 的 endIdx 位置
    if (blocks.length > 0) {
      const lastEnd = blocks[blocks.length - 1].endIdx;
      dividerAtIdx[lastEnd] = { label: '当前讨论', blockIdx: -1, isCurrent: true };
    }

    history.forEach((msg, i) => {
      if (dividerAtIdx[i] !== undefined) {
        const info = dividerAtIdx[i];
        const divider = document.createElement('div');
        divider.className = 'block-divider' + (info.isCurrent ? ' current' : '');
        divider.dataset.blockIdx = info.blockIdx;
        divider.dataset.targetIdx = i;
        divider.innerHTML = `<span class="block-divider-line"></span><span class="block-divider-label">${escapeHtml(info.label)}</span><span class="block-divider-line"></span>`;
        qaChatMessages.appendChild(divider);
      }

      if (msg.role === 'user' || msg.role === 'assistant') {
        const isRepeat = msg.role === 'assistant' && msg.content.includes('⚠️');
        const bubble = appendMessage(qaChatMessages, msg.role, msg.content, isRepeat);
        if (bubble) {
          const row = bubble.closest ? bubble.closest('.chat-msg-row') || bubble.parentElement : bubble.parentElement;
          if (row) row.dataset.msgIdx = i;
        }
      }
    });

    renderOutline();
  }

  // ============================================================
  // Outline 渲染
  // ============================================================
  function renderOutline() {
    const outlineEl = $('#chatOutline');
    const outlineList = $('#outlineList');
    const blocks = getActiveBlocks();

    if (!blocks || blocks.length === 0) {
      outlineEl.style.display = 'none';
      return;
    }

    outlineEl.style.display = '';
    outlineList.innerHTML = '';

    blocks.forEach((block, i) => {
      const item = document.createElement('div');
      item.className = 'outline-item';
      item.textContent = `${i + 1}. ${block.summary}`;
      item.addEventListener('click', () => scrollToBlockStart(block.startIdx));
      outlineList.appendChild(item);
    });

    // "当前讨论" — 跳到最后一个 block 的 endIdx（即"当前讨论"分割线处）
    const lastBlock = blocks[blocks.length - 1];
    const currentItem = document.createElement('div');
    currentItem.className = 'outline-item outline-current';
    currentItem.textContent = `${blocks.length + 1}. 当前讨论`;
    currentItem.addEventListener('click', () => scrollToBlockStart(lastBlock.endIdx));
    outlineList.appendChild(currentItem);
  }

  function scrollToBlockStart(msgIdx) {
    const qaChatMessages = $('#qaChatMessages');
    // 找到对应 msgIdx 的消息行
    const target = qaChatMessages.querySelector(`[data-msg-idx="${msgIdx}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // 如果找不到精确匹配，尝试找分割线
    const dividers = qaChatMessages.querySelectorAll('.block-divider');
    for (const d of dividers) {
      if (parseInt(d.dataset.targetIdx) === msgIdx) {
        d.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  }

  // Outline 收起/展开
  const outlineToggle = $('#outlineToggle');
  if (outlineToggle) {
    outlineToggle.addEventListener('click', () => {
      const list = $('#outlineList');
      list.classList.toggle('collapsed');
      outlineToggle.classList.toggle('collapsed');
    });
  }

  // ============================================================
  // 代码文件 — 加载 & 保存
  // ============================================================
  async function loadCodeFiles() {
    if (!currentProblemId) { codeFiles = []; activeCodeFile = null; renderCodeFileBar(); return; }
    try {
      const res  = await fetch(`/api/problem/${currentProblemId}/codes`);
      const data = await res.json();
      codeFiles = data.codes || [];

      if (codeFiles.length > 0) {
        // 加载最新的代码文件
        const latest = codeFiles[codeFiles.length - 1];
        await switchCodeFile(latest.filename, false);
      } else {
        activeCodeFile = null;
        renderCodeFileBar();
        markCodeSaved(false);
      }
    } catch (e) {
      showToast('加载代码文件失败：' + e.message);
    }
  }

  async function switchCodeFile(filename, saveFirst = true) {
    if (saveFirst && activeCodeFile && !codeFileSaved) {
      await saveCurrentCodeFile();
    }
    try {
      const res  = await fetch(`/api/problem/${currentProblemId}/codes/${filename}`);
      const data = await res.json();
      if (data.success) {
        activeCodeFile = filename;
        codeEditor.value     = data.code || '';
        codeDescInput.value  = data.description || '';
        markCodeSaved(true);
        renderCodeFileBar();
        closeCodeFileDropdown();
        syncHighlight();
      }
    } catch {}
  }

  async function saveCurrentCodeFile() {
    if (!currentProblemId) return;

    const code = codeEditor.value;
    const desc = codeDescInput.value.trim();

    if (!activeCodeFile) {
      // 还没有文件，新建
      const res  = await fetch(`/api/problem/${currentProblemId}/codes`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code, description: desc }),
      });
      const data = await res.json();
      if (data.success) {
        activeCodeFile = data.filename;
        if (!codeFiles.find(f => f.filename === data.filename)) {
          codeFiles.push({ filename: data.filename, description: desc, createdAt: data.createdAt });
        }
        markCodeSaved(true);
        renderCodeFileBar();
      }
    } else {
      await fetch(`/api/problem/${currentProblemId}/codes/${activeCodeFile}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code, description: desc }),
      });
      const f = codeFiles.find(f => f.filename === activeCodeFile);
      if (f) f.description = desc;
      markCodeSaved(true);
    }
  }

  function scheduleSaveCode() {
    markCodeSaved(false);
    clearTimeout(codeSaveTimer);
    codeSaveTimer = setTimeout(() => {
      if (currentProblemId) saveCurrentCodeFile();
    }, 2000);
  }

  function markCodeSaved(saved) {
    codeFileSaved = saved;
    fileDot.className = 'file-dot ' + (saved ? 'saved' : 'unsaved');
  }

  async function forkCodeFile() {
    if (!currentProblemId) { showToast('请先加载一道题目'); return; }
    await saveCurrentCodeFile();

    const code = codeEditor.value;
    const desc = codeDescInput.value.trim();
    const res  = await fetch(`/api/problem/${currentProblemId}/codes`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, description: desc ? `[Fork] ${desc}` : '[Fork]' }),
    });
    const data = await res.json();
    if (data.success) {
      activeCodeFile = data.filename;
      codeFiles.push({ filename: data.filename, description: data.description, createdAt: data.createdAt });
      markCodeSaved(true);
      renderCodeFileBar();
      showToast(`已 Fork → ${data.filename}`);
    }
  }

  // ============================================================
  // 代码文件栏渲染
  // ============================================================
  function renderCodeFileBar() {
    if (activeCodeFile) {
      codeFileName.textContent = activeCodeFile + '.cpp';
    } else {
      codeFileName.textContent = '未保存';
      fileDot.className = 'file-dot';
    }
  }

  function renderCodeFileDropdown() {
    codeFileDropdown.innerHTML = '';

    if (codeFiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'code-file-dropdown-empty';
      empty.textContent = '暂无保存的代码';
      codeFileDropdown.appendChild(empty);
      return;
    }

    [...codeFiles].reverse().forEach(f => {
      const item = document.createElement('div');
      item.className = 'code-file-item' + (f.filename === activeCodeFile ? ' active' : '');

      const nameEl = document.createElement('div');
      nameEl.className = 'code-file-item-name';
      nameEl.textContent = f.filename + '.cpp';

      const descEl = document.createElement('div');
      descEl.className = 'code-file-item-desc';
      descEl.textContent = f.description || '';

      const delBtn = document.createElement('button');
      delBtn.className = 'code-file-item-del';
      delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      delBtn.title = '删除此文件';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除 ${f.filename}.cpp？`)) return;
        await fetch(`/api/problem/${currentProblemId}/codes/${f.filename}`, { method: 'DELETE' });
        codeFiles = codeFiles.filter(x => x.filename !== f.filename);
        if (activeCodeFile === f.filename) {
          activeCodeFile = null;
          codeEditor.value = '';
          codeDescInput.value = '';
          markCodeSaved(false);
          renderCodeFileBar();
          syncHighlight();
        }
        renderCodeFileDropdown();
        showToast('已删除');
      });

      item.appendChild(nameEl);
      item.appendChild(descEl);
      item.appendChild(delBtn);
      item.addEventListener('click', () => switchCodeFile(f.filename));
      codeFileDropdown.appendChild(item);
    });
  }

  function openCodeFileDropdown() {
    renderCodeFileDropdown();
    codeFileDropdown.classList.add('open');
  }

  function closeCodeFileDropdown() {
    codeFileDropdown.classList.remove('open');
  }

  codeFileSelector.addEventListener('click', (e) => {
    e.stopPropagation();
    if (codeFileDropdown.classList.contains('open')) {
      closeCodeFileDropdown();
    } else {
      openCodeFileDropdown();
    }
  });

  document.addEventListener('click', (e) => {
    if (!codeFileSelector.contains(e.target)) closeCodeFileDropdown();
  });

  forkBtn.addEventListener('click', forkCodeFile);

  // 代码变化 → 标记未保存 + debounce 保存
  codeEditor.addEventListener('input', scheduleSaveCode);
  codeDescInput.addEventListener('input', scheduleSaveCode);

  // ============================================================
  // 回顾入口
  // ============================================================
  reviewHeaderBtn.addEventListener('click', () => {
    if (progressMode) {
      progressMode = false;
      if (progressHeaderBtn) progressHeaderBtn.classList.remove('active');
      panelChat.classList.remove('in-progress');
    }
    reviewMode = !reviewMode;
    reviewHeaderBtn.classList.toggle('active', reviewMode);
    panelChat.classList.toggle('in-review', reviewMode);
    if (reviewMode) loadAndRenderReviewTable();
  });

  // ============================================================
  // Tab 切换
  // ============================================================
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === activeTab && !reviewMode && !progressMode) return;

      if (reviewMode) {
        reviewMode = false;
        reviewHeaderBtn.classList.remove('active');
        panelChat.classList.remove('in-review');
      }
      if (progressMode) {
        progressMode = false;
        if (progressHeaderBtn) progressHeaderBtn.classList.remove('active');
        panelChat.classList.remove('in-progress');
      }

      activeTab = tab;
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-pane').forEach((p) => p.classList.remove('active'));
      $(`#tab-${tab}`).classList.add('active');

      $('#qaActions').style.display        = tab === 'qa'        ? '' : 'none';
      $('#codeActions').style.display      = tab === 'code'      ? '' : 'none';

      if (tab === 'recommend' && !recLoaded) loadRecommendations();
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
    });
  });

  function updateModeUI() {
    generateCodeBtn.style.display = currentMode === 'verify' ? '' : 'none';
    renderQuickQuestions();
    chatInput.placeholder = currentMode === 'handwrite' ? '关于题意、代码问题的提问…' : '描述你的解题思路…';
  }

  function renderQuickQuestions() {
    const questions = QUICK_QUESTIONS[currentMode] || [];
    const qqSection = $('.quick-questions');
    // 当前会话有 3 条以上用户消息时自动隐藏
    const history = getActiveHistory();
    const userMsgCount = history.filter(m => m.role === 'user').length;
    if (qqSection) qqSection.style.display = userMsgCount >= 3 ? 'none' : '';
    qqList.innerHTML = questions.map((q) => `<button class="qq-btn">${q}</button>`).join('');
    qqList.querySelectorAll('.qq-btn').forEach((btn) => {
      btn.addEventListener('click', () => { chatInput.value = btn.textContent; chatInput.focus(); });
    });
  }

  // ============================================================
  // 提示层级切换
  // ============================================================
  $$('.hint-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      hintLevel = parseInt(btn.dataset.level, 10);
      $$('.hint-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  function renderMarkdown(content) {
    if (typeof marked === 'undefined') return null;
    try {
      return marked.parse(content, { breaks: true, gfm: true });
    } catch { return null; }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  // ============================================================
  // 通用消息渲染
  // ============================================================
  function appendMessage(chatEl, role, content, isRepeat = false) {
    const welcome = chatEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const row    = document.createElement('div');
    row.className = `chat-msg-row ${role}${isRepeat ? ' repeat' : ''}`;

    const bubble = document.createElement('div');
    bubble.className = `chat-msg ${role}`;

    if (isRepeat && role === 'assistant') {
      const lines      = content.split('\n');
      const repeatLine = lines.find(l => l.startsWith('⚠️'));
      const rest        = lines.filter(l => !l.startsWith('⚠️')).join('\n').trim();
      const badge       = document.createElement('div');
      badge.className   = 'repeat-badge';
      badge.textContent = repeatLine || '⚠️ 你之前也问过类似的问题';
      bubble.appendChild(badge);
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'msg-md-body';
      const html = renderMarkdown(rest);
      if (html) { bodyDiv.innerHTML = html; } else { bodyDiv.textContent = rest; }
      bubble.appendChild(bodyDiv);
    } else if (role === 'assistant') {
      bubble.className += ' md-rendered';
      const html = renderMarkdown(content);
      if (html) { bubble.innerHTML = html; } else { bubble.textContent = content; }
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
        copyToClipboard(content).catch(() => {});
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

    const qaChatMessages = $('#qaChatMessages');
    const history = getActiveHistory();
    const blocks = getActiveBlocks();

    const userBubble = appendMessage(qaChatMessages, 'user', text);
    const userMsgIdx = history.length;
    history.push({ role: 'user', content: text });
    if (userBubble?.parentElement) userBubble.parentElement.dataset.msgIdx = userMsgIdx;
    chatInput.value = '';
    setLoading(true);

    // 话题检测：如果有足够的历史消息，检测是否开始新话题
    if (history.length >= 4) {
      try {
        const lastBlockEnd = blocks.length > 0 ? blocks[blocks.length - 1].endIdx : 0;
        const recentMsgs = history.slice(lastBlockEnd, -1);
        if (recentMsgs.length >= 2) {
          const detectRes = await fetch('/api/topic-detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recentMessages: recentMsgs, newMessage: text }),
          });
          const detectData = await detectRes.json();
          if (detectData.result === 'NEW') {
            const blockMsgs = history.slice(lastBlockEnd, -1);
            let summary = '对话讨论';
            try {
              const sumRes = await fetch('/api/block-summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: blockMsgs }),
              });
              const sumData = await sumRes.json();
              if (sumData.summary) summary = sumData.summary;
            } catch {}
            const newBlockIdx = blocks.length;
            blocks.push({ summary, startIdx: lastBlockEnd, endIdx: history.length - 1 });

            // 实时插入/更新分割线
            // a) 旧的"当前讨论"分割线 → 改名为新 block 的标题
            const oldCurrent = qaChatMessages.querySelector('.block-divider.current');
            if (oldCurrent) {
              oldCurrent.classList.remove('current');
              oldCurrent.dataset.blockIdx = newBlockIdx;
              oldCurrent.querySelector('.block-divider-label').textContent = summary;
            } else if (newBlockIdx === 0) {
              // 第一次分块：在消息流最前面插入第一个 block 的标题
              const firstChild = qaChatMessages.firstChild;
              if (firstChild) {
                const topDivider = document.createElement('div');
                topDivider.className = 'block-divider';
                topDivider.dataset.blockIdx = 0;
                topDivider.dataset.targetIdx = 0;
                topDivider.innerHTML = `<span class="block-divider-line"></span><span class="block-divider-label">${escapeHtml(summary)}</span><span class="block-divider-line"></span>`;
                qaChatMessages.insertBefore(topDivider, firstChild);
              }
            }

            // b) 在刚发送的 user 消息之前插入新的"当前讨论"分割线
            const userRows = qaChatMessages.querySelectorAll('.chat-msg-row.user');
            const lastUserRow = userRows[userRows.length - 1];
            if (lastUserRow) {
              const currentDivider = document.createElement('div');
              currentDivider.className = 'block-divider current';
              currentDivider.dataset.blockIdx = -1;
              currentDivider.dataset.targetIdx = history.length - 1;
              currentDivider.innerHTML = `<span class="block-divider-line"></span><span class="block-divider-label">当前讨论</span><span class="block-divider-line"></span>`;
              lastUserRow.parentElement.insertBefore(currentDivider, lastUserRow);
            }

            renderOutline();
          }
        }
      } catch {}
    }

    // 构建发送给 LLM 的消息：旧 blocks 用概述替代，当前 block 保留完整消息
    const lastBlockEnd = blocks.length > 0 ? blocks[blocks.length - 1].endIdx : 0;
    const blockSummaries = blocks.map(b => `[之前讨论: ${b.summary}]`).join('\n');
    const currentBlockMsgs = history.slice(lastBlockEnd);

    let messagesForLLM;
    if (blocks.length > 0) {
      messagesForLLM = [
        { role: 'user', content: `（以下是之前已讨论的话题概述）\n${blockSummaries}` },
        { role: 'assistant', content: '好的，我了解之前的讨论内容。请继续。' },
        ...currentBlockMsgs,
      ];
    } else {
      messagesForLLM = history;
    }

    let extraContext = problemContext;
    if (codeEditor.value.trim()) {
      extraContext += `\n\n学生当前的代码：\n\`\`\`cpp\n${codeEditor.value}\n\`\`\``;
    }

    const recentIssues = getRecentIssues(10);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: currentMode,
          messages: messagesForLLM,
          problemContext: extraContext,
          recentIssues,
          hintLevel,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const isRepeat = data.reply.includes('⚠️');
        const aiBubble = appendMessage(qaChatMessages, 'assistant', data.reply, isRepeat);
        const aiMsgIdx = history.length;
        history.push({ role: 'assistant', content: data.reply });
        if (aiBubble?.parentElement) aiBubble.parentElement.dataset.msgIdx = aiMsgIdx;
      } else {
        appendMessage(qaChatMessages, 'system', '错误：' + (data.error || '请求失败'));
      }
    } catch (err) {
      appendMessage(qaChatMessages, 'system', '网络错误：' + err.message);
    }

    setLoading(false);
    renderQuickQuestions();
    scheduleSaveSession();
  }

  function setLoading(v) {
    isLoading = v;
    sendBtn.disabled = v;
    const qaChatMessages = $('#qaChatMessages');
    if (v) appendLoadingIndicator(qaChatMessages);
    else { const el = $('#loadingIndicator'); if (el) el.remove(); }
  }

  // ============================================================
  // 按思路生成代码
  // ============================================================
  generateCodeBtn.addEventListener('click', async () => {
    const history = getActiveHistory();
    if (isLoading || history.length === 0) {
      if (!isLoading) appendMessage($('#qaChatMessages'), 'system', '请先描述你的解题思路。');
      return;
    }

    const qaChatMessages = $('#qaChatMessages');
    appendMessage(qaChatMessages, 'user', '请根据我的思路生成 C++ 代码');
    history.push({ role: 'user', content: '请根据我描述的思路，严格按照我的方法生成完整的C++代码。使用C++17标准，包含完整的输入输出。不要修改我的思路或用其他方法替代。' });
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode: 'verify', messages: history, problemContext }),
      });
      const data = await res.json();
      if (data.success) {
        appendMessage(qaChatMessages, 'assistant', data.reply);
        history.push({ role: 'assistant', content: data.reply });
        const codeMatch = data.reply.match(/```(?:cpp|c\+\+)?\n([\s\S]*?)```/);
        if (codeMatch) {
          const generatedCode = codeMatch[1].trim();
          if (currentProblemId) {
            // 先保存学生当前的文件
            if (codeEditor.value.trim()) {
              await saveCurrentCodeFile();
            }
            // 新建一个文件存放 AI 生成的代码
            const desc = codeDescInput.value.trim();
            const newDesc = desc ? `[AI生成] ${desc}` : '[AI生成]';
            const r = await fetch(`/api/problem/${currentProblemId}/codes`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ code: generatedCode, description: newDesc }),
            });
            const nd = await r.json();
            if (nd.success) {
              activeCodeFile = nd.filename;
              codeFiles.push({ filename: nd.filename, description: newDesc, createdAt: nd.createdAt });
              markCodeSaved(true);
              renderCodeFileBar();
            }
          }
          codeEditor.value = generatedCode;
          syncHighlight();
          codeDescInput.value = activeCodeFile ? (codeFiles.find(f => f.filename === activeCodeFile)?.description || '') : '[AI生成]';
        }
      } else {
        appendMessage(qaChatMessages, 'system', '错误：' + (data.error || '请求失败'));
      }
    } catch (err) {
      appendMessage(qaChatMessages, 'system', '网络错误：' + err.message);
    }

    setLoading(false);
    scheduleSaveSession();
  });

  // ============================================================
  // 代码提问 Tab — 生成理解问题 + Carousel + Thread
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
      const res  = await fetch('/api/explain', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code, problemContext }),
      });
      const data = await res.json();
      if (data.success && data.questions?.length > 0) {
        codeQuestions = data.questions;
        codeQaThreads = data.questions.map(q => ({ question: q.question, hint: q.hint || '', history: [] }));
        activeQaIndex = 0;
        answeredCount = 0;
        codeQaEmpty.style.display = 'none';
        codeQaWrap.style.display  = '';
        codeQaInputWrap.style.display = '';
        renderQaCarousel();
        loadCodeQaThreads();
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

  // 加载已有的代码提问 threads（题目切换时调用）
  async function loadCodeQaThreads() {
    if (!currentProblemId) return;
    try {
      const res = await fetch(`/api/problem/${currentProblemId}/code-qa`);
      const data = await res.json();
      if (data.success && data.threads?.length > 0) {
        codeQaThreads = data.threads;
        codeQuestions = data.threads.map(t => ({ question: t.question, hint: t.hint || '' }));
        activeQaIndex = 0;
        answeredCount = codeQaThreads.filter(t => t.history.length > 0).length;
        codeQaEmpty.style.display = 'none';
        codeQaWrap.style.display  = '';
        codeQaInputWrap.style.display = '';
        renderQaCarousel();
      }
    } catch {}
  }

  async function saveCodeQaThreads() {
    if (!currentProblemId || codeQaThreads.length === 0) return;
    try {
      await fetch(`/api/problem/${currentProblemId}/code-qa`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threads: codeQaThreads }),
      });
    } catch {}
  }

  function renderQaCarousel() {
    const total = codeQaThreads.length;
    updateQaProgress();
    renderQaDots();
    renderActiveThread();
    updateQaNavButtons();
  }

  function renderQaDots() {
    const total = codeQaThreads.length;
    qaDots.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('button');
      const hasHistory = codeQaThreads[i].history.length > 0;
      const isCorrect = hasHistory && codeQaThreads[i].history.some(
        m => m.role === 'assistant' && m.content.startsWith('【正确】')
      );
      dot.className = 'qa-dot' +
        (i === activeQaIndex ? ' active' : '') +
        (isCorrect ? ' done' : hasHistory ? ' partial' : '');
      dot.textContent = i + 1;
      dot.addEventListener('click', () => switchQaIndex(i));
      qaDots.appendChild(dot);
    }
  }

  function updateQaNavButtons() {
    qaPrevBtn.disabled = activeQaIndex <= 0;
    qaNextBtn.disabled = activeQaIndex >= codeQaThreads.length - 1;
  }

  qaPrevBtn.addEventListener('click', () => switchQaIndex(activeQaIndex - 1));
  qaNextBtn.addEventListener('click', () => switchQaIndex(activeQaIndex + 1));

  function switchQaIndex(idx) {
    if (idx < 0 || idx >= codeQaThreads.length || idx === activeQaIndex) return;
    activeQaIndex = idx;
    renderQaDots();
    renderActiveThread();
    updateQaNavButtons();
    codeChatInput.value = '';
    codeChatInput.focus();
  }

  function renderActiveThread() {
    const thread = codeQaThreads[activeQaIndex];
    if (!thread) return;

    codeQaCarousel.innerHTML = '';

    // 题目头部
    const header = document.createElement('div');
    header.className = 'qa-thread-header';
    header.innerHTML = `
      <div class="qa-num">${activeQaIndex + 1}</div>
      <div class="qa-question">${escapeHtml(thread.question)}</div>`;
    codeQaCarousel.appendChild(header);

    // 对话消息列表
    const msgList = document.createElement('div');
    msgList.className = 'qa-thread-messages';
    msgList.id = 'qaThreadMessages';

    if (thread.history.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'qa-thread-hint';
      hint.textContent = '写下你对这个问题的理解，按 Enter 提交';
      msgList.appendChild(hint);
    } else {
      thread.history.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          const isCorrect = msg.role === 'assistant' && msg.content.startsWith('【正确】');
          const isPartial = msg.role === 'assistant' && msg.content.startsWith('【部分正确】');
          const isWrong   = msg.role === 'assistant' && msg.content.startsWith('【不正确】');
          appendMessage(msgList, msg.role, msg.content, false);
          const lastBubble = msgList.lastElementChild?.querySelector('.chat-msg.assistant');
          if (lastBubble) {
            if (isCorrect) lastBubble.classList.add('qa-correct');
            else if (isPartial) lastBubble.classList.add('qa-partial');
            else if (isWrong) lastBubble.classList.add('qa-wrong');
          }
        }
      });
    }

    codeQaCarousel.appendChild(msgList);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function updateQaProgress() {
    answeredCount = codeQaThreads.filter(t => t.history.length > 0).length;
    const total = codeQaThreads.length;
    qaProgress.textContent = `${answeredCount} / ${total} 已回答`;
    qaProgress.className   = answeredCount === total && total > 0 ? 'qa-progress done' : 'qa-progress';
  }

  // 代码提问 thread 发送消息
  codeChatSendBtn.addEventListener('click', sendCodeQaMessage);
  codeChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCodeQaMessage(); }
  });

  async function sendCodeQaMessage() {
    const text = codeChatInput.value.trim();
    if (!text || codeQaLoading) return;

    const thread = codeQaThreads[activeQaIndex];
    if (!thread) return;

    const msgList = $('#qaThreadMessages');
    const hintEl = msgList?.querySelector('.qa-thread-hint');
    if (hintEl) hintEl.remove();

    // 第一条消息自动加上问题前缀
    let userContent = text;
    if (thread.history.length === 0) {
      userContent = `问题：${thread.question}\n\n我的回答：${text}`;
    }

    appendMessage(msgList, 'user', text);
    thread.history.push({ role: 'user', content: userContent });
    codeChatInput.value = '';

    codeQaLoading = true;
    codeChatSendBtn.disabled = true;
    appendLoadingIndicator(msgList, 'qaLoadingIndicator');

    let codeContext = problemContext;
    if (codeEditor.value.trim()) codeContext += `\n\n代码：\n\`\`\`cpp\n${codeEditor.value}\n\`\`\``;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'code_eval',
          messages: thread.history,
          problemContext: codeContext,
        }),
      });
      const data = await res.json();
      const indicator = $('#qaLoadingIndicator');
      if (indicator) indicator.remove();

      if (data.success) {
        const reply = data.reply || '';
        thread.history.push({ role: 'assistant', content: reply });
        const isCorrect = reply.startsWith('【正确】');
        const isPartial = reply.startsWith('【部分正确】');
        const isWrong   = reply.startsWith('【不正确】');
        appendMessage(msgList, 'assistant', reply);
        const lastBubble = msgList.lastElementChild?.querySelector('.chat-msg.assistant');
        if (lastBubble) {
          if (isCorrect) lastBubble.classList.add('qa-correct');
          else if (isPartial) lastBubble.classList.add('qa-partial');
          else if (isWrong) lastBubble.classList.add('qa-wrong');
        }
      } else {
        appendMessage(msgList, 'system', '错误：' + (data.error || '请求失败'));
      }
    } catch (err) {
      const indicator = $('#qaLoadingIndicator');
      if (indicator) indicator.remove();
      appendMessage(msgList, 'system', '网络错误：' + err.message);
    }

    codeQaLoading = false;
    codeChatSendBtn.disabled = false;
    renderQaDots();
    updateQaProgress();
    saveCodeQaThreads();
    msgList.scrollTop = msgList.scrollHeight;
  }

  // ============================================================
  // 代码翻译 Tab
  // ============================================================
  const tlEmpty   = $('#tlEmpty');
  const tlWrap    = $('#tlWrap');
  const tlResult  = $('#tlResult');
  let translateVersions = [];
  let activeTranslateIdx = 0;
  let translateLoading = false;

  async function loadTranslateVersions() {
    if (!currentProblemId) return;
    try {
      const res = await fetch(`/api/problem/${currentProblemId}/code-translate`);
      const data = await res.json();
      translateVersions = data.versions || [];
      activeTranslateIdx = Math.max(0, translateVersions.length - 1);
      renderTranslateUI();
    } catch { translateVersions = []; renderTranslateUI(); }
  }

  async function saveTranslateVersions() {
    if (!currentProblemId) return;
    try {
      await fetch(`/api/problem/${currentProblemId}/code-translate`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versions: translateVersions }),
      });
    } catch {}
  }

  function renderTranslateUI() {
    if (!translateVersions.length) {
      tlEmpty.style.display = '';
      tlWrap.style.display = 'none';
      return;
    }
    tlEmpty.style.display = 'none';
    tlWrap.style.display = '';
    renderTranslateToolbar();
    renderTranslateResult();
  }

  function renderTranslateToolbar() {
    const v = translateVersions[activeTranslateIdx];
    $('#tlVersionLabel').textContent = v ? `${v.name} (${activeTranslateIdx + 1}/${translateVersions.length})` : '—';
    $('#tlPrevBtn').disabled = activeTranslateIdx <= 0;
    $('#tlNextBtn').disabled = activeTranslateIdx >= translateVersions.length - 1;
  }

  function renderTranslateResult() {
    const v = translateVersions[activeTranslateIdx];
    if (!v || !v.blocks?.length) {
      tlResult.innerHTML = '<div style="padding:20px;color:var(--text-muted);font-size:13px;text-align:center">暂无翻译结果</div>';
      return;
    }
    tlResult.innerHTML = v.blocks.map((b, i) => {
      const statusClass = b.status === 'error' ? 'tl-error' : b.status === 'warn' ? 'tl-warn' : 'tl-ok';
      const detail = b.detail;
      const translation = detail ? detail.translation : b.translation;
      const currentStatus = detail ? detail.status : b.status;
      const barClass = currentStatus === 'error' ? 'tl-error' : currentStatus === 'warn' ? 'tl-warn' : 'tl-ok';

      let extraHtml = '';
      if (detail) {
        if (detail.question) {
          extraHtml += `<div class="tl-question">${escapeHtml(detail.question)}</div>`;
        }
        if (detail.debugHint) {
          extraHtml += `<div class="tl-debug-hint">${escapeHtml(detail.debugHint)}</div>`;
        }
      }

      const deepenBtn = detail
        ? '<span class="tl-deepened-badge">已深入</span>'
        : `<button class="tl-deepen-btn" data-idx="${i}">深入</button>`;

      return `<div class="tl-block" data-idx="${i}">
        <div class="tl-bar ${barClass}"></div>
        <div class="tl-content">
          <pre class="tl-code">${escapeHtml(b.code)}</pre>
          <div class="tl-text">${escapeHtml(translation)}</div>
          ${extraHtml}
          <div class="tl-actions">${deepenBtn}</div>
        </div>
      </div>`;
    }).join('');

    tlResult.querySelectorAll('.tl-deepen-btn').forEach(btn => {
      btn.addEventListener('click', () => deepenBlock(parseInt(btn.dataset.idx)));
    });
  }

  async function generateTranslation() {
    const code = codeEditor.value.trim();
    if (!code) { showToast('请先在编辑器中输入代码'); return; }
    if (translateLoading) return;
    translateLoading = true;
    showToast('正在翻译代码…', true);

    try {
      const res = await fetch('/api/code-translate/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, problemContext }),
      });
      if (!res.ok) throw new Error(`服务器错误 (${res.status})，请重启服务后重试`);
      const data = await res.json();
      if (data.success && data.blocks) {
        const now = new Date();
        const name = `翻译 ${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        translateVersions.push({
          name,
          codeFile: activeCodeFile || 'main',
          createdAt: now.toISOString(),
          blocks: data.blocks,
        });
        activeTranslateIdx = translateVersions.length - 1;
        renderTranslateUI();
        await saveTranslateVersions();
        showToast('翻译完成');
      } else {
        showToast(data.error || '翻译失败');
      }
    } catch (err) {
      showToast('翻译失败：' + err.message);
    }
    translateLoading = false;
  }

  async function deepenBlock(blockIdx) {
    const v = translateVersions[activeTranslateIdx];
    if (!v || !v.blocks[blockIdx] || translateLoading) return;
    const block = v.blocks[blockIdx];
    if (block.detail) return;

    translateLoading = true;
    const btn = tlResult.querySelector(`.tl-deepen-btn[data-idx="${blockIdx}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }

    try {
      const res = await fetch('/api/code-translate/detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: codeEditor.value,
          blockCode: block.code,
          blockTranslation: block.translation,
          problemContext,
        }),
      });
      if (!res.ok) throw new Error(`服务器错误 (${res.status})`);
      const data = await res.json();
      if (data.success && data.detail) {
        block.detail = data.detail;
        renderTranslateResult();
        await saveTranslateVersions();
      } else {
        showToast(data.error || '深入分析失败');
        if (btn) { btn.disabled = false; btn.textContent = '深入'; }
      }
    } catch (err) {
      showToast('深入分析失败：' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = '深入'; }
    }
    translateLoading = false;
  }

  $('#genTranslateBtn').addEventListener('click', generateTranslation);
  $('#regenTranslateBtn').addEventListener('click', generateTranslation);

  $('#tlPrevBtn').addEventListener('click', () => {
    if (activeTranslateIdx > 0) { activeTranslateIdx--; renderTranslateUI(); }
  });
  $('#tlNextBtn').addEventListener('click', () => {
    if (activeTranslateIdx < translateVersions.length - 1) { activeTranslateIdx++; renderTranslateUI(); }
  });

  // ============================================================
  // 总结按钮（汇总所有会话进程）
  // ============================================================
  $('#summarizeQaBtn').addEventListener('click', summarizeAllSessions);
  $('#summarizeCodeBtn').addEventListener('click', () => {
    const msgs = [];
    codeQaThreads.forEach(thread => {
      if (thread.history.length > 0) {
        msgs.push(...thread.history);
      }
    });
    summarizeConversation(msgs, 'code');
  });

  async function summarizeAllSessions() {
    if (!currentProblemId) {
      // 无题目时只总结当前活跃会话
      return summarizeConversation(getActiveHistory(), 'qa');
    }

    await saveCurrentSession();
    showToast('正在汇总所有进程…', true);

    const allMessages = [];
    try {
      const res  = await fetch(`/api/problem/${currentProblemId}/sessions`);
      const data = await res.json();
      for (const s of (data.sessions || [])) {
        const sr   = await fetch(`/api/problem/${currentProblemId}/sessions/${s.key}`);
        const sd   = await sr.json();
        if (sd.history?.length) allMessages.push(...sd.history);
      }
    } catch {}

    summarizeConversation(allMessages.length ? allMessages : getActiveHistory(), 'qa');
  }

  async function summarizeConversation(messages, source) {
    if (!messages || messages.length === 0) {
      showToast('没有可总结的对话内容');
      return;
    }
    showToast('正在总结…', true);
    try {
      const res  = await fetch('/api/summarize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messages, problemId: currentProblemId || '未知', source }),
      });
      const data = await res.json();
      if (data.success && data.items?.length > 0) {
        await addReviewItems(data.items);
        showToast(`已添加 ${data.items.length} 条回顾记录 ✓`);
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
  // 回顾 — API 读写
  // ============================================================
  function getRecentIssues(n = 10) {
    return reviewCache.slice(-n).map(({ type, summary }) => ({ type, summary }));
  }

  async function addReviewItems(items) {
    try {
      const res  = await fetch('/api/student/review', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items }),
      });
      const data = await res.json();
      if (data.success) reviewCache = [...reviewCache, ...data.added];
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
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ notes: notesEl.value }),
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

  $('#clearReviewBtn').addEventListener('click', async () => {
    if (!confirm('确定要清空所有回顾记录吗？')) return;
    try {
      await fetch('/api/student/review', { method: 'DELETE' });
      reviewCache = [];
      renderReviewTable([]);
    } catch { showToast('清空失败，请重试'); }
  });

  // ============================================================
  // 题目加载（含自定义题目 ID 分配）
  // ============================================================
  $('#loadProblem').addEventListener('click', loadProblem);
  problemIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { hideSuggest(); loadProblem(); }
    else if (e.key === 'Escape') hideSuggest();
    else if (e.key === 'ArrowDown') moveSuggestFocus(1);
    else if (e.key === 'ArrowUp')   moveSuggestFocus(-1);
  });

  // ── Autocomplete ──────────────────────────────────────────
  let suggestItems     = [];
  let suggestFocusIdx  = -1;
  let suggestTimer     = null;

  problemIdInput.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = problemIdInput.value.trim();
    if (!q) { hideSuggest(); return; }
    suggestTimer = setTimeout(() => fetchSuggest(q), 200);
  });

  async function fetchSuggest(q) {
    try {
      const res  = await fetch(`/api/problems/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.success) return;
      suggestItems    = data.results || [];
      suggestFocusIdx = -1;
      renderSuggest();
    } catch {}
  }

  function renderSuggest() {
    if (!suggestItems.length) { hideSuggest(); return; }
    problemSuggest.innerHTML = suggestItems.map((item, i) => {
      const tag = item.source === 'custom'
        ? `<span class="suggest-tag suggest-custom">自定义</span>`
        : '';
      return `<div class="suggest-item" data-idx="${i}" tabindex="-1">
        <span class="suggest-id">#${item.id}</span>
        <span class="suggest-title">${escapeHtml(item.title)}</span>
        ${tag}
      </div>`;
    }).join('');
    problemSuggest.querySelectorAll('.suggest-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = parseInt(el.dataset.idx);
        selectSuggest(idx);
      });
    });
    problemSuggest.style.display = 'block';
  }

  function moveSuggestFocus(dir) {
    if (!suggestItems.length) return;
    suggestFocusIdx = Math.max(-1, Math.min(suggestItems.length - 1, suggestFocusIdx + dir));
    problemSuggest.querySelectorAll('.suggest-item').forEach((el, i) => {
      el.classList.toggle('focused', i === suggestFocusIdx);
    });
    if (suggestFocusIdx >= 0) {
      problemIdInput.value = suggestItems[suggestFocusIdx].id;
    }
  }

  function selectSuggest(idx) {
    const item = suggestItems[idx];
    if (!item) return;
    problemIdInput.value = item.id;
    hideSuggest();
    loadProblem();
  }

  function hideSuggest() {
    problemSuggest.style.display = 'none';
    suggestItems    = [];
    suggestFocusIdx = -1;
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.problem-search-wrap')) hideSuggest();
  });

  function showModePicker() {
    return new Promise((resolve) => {
      const modal = $('#modePickerModal');
      modal.classList.add('open');
      const btns = modal.querySelectorAll('.mode-picker-btn');
      const remember = $('#modePickerRemember');
      remember.checked = false;

      function pick(mode) {
        if (remember.checked) {
          localStorage.setItem('soj_default_mode', mode);
        }
        modal.classList.remove('open');
        btns.forEach(b => b.removeEventListener('click', handler));
        resolve(mode);
      }
      function handler(e) {
        const btn = e.currentTarget;
        pick(btn.dataset.pick);
      }
      btns.forEach(b => b.addEventListener('click', handler));
    });
  }

  async function loadProblem() {
    const input = problemIdInput.value.trim();
    if (!input) return;

    // 切换题目前保存当前状态
    if (currentProblemId) {
      await saveCurrentSession();
      if (!codeFileSaved) await saveCurrentCodeFile();
    }

    if (input.length > 20) {
      showToast('请输入题号（最多20位），自定义题目请点击 + 添加');
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
        showToast(`题目 #${input} 不存在`);
        return;
      }

      problemBanner.classList.remove('collapsed');

      // 弹出模式选择（如果用户未设置"记住"）
      const savedDefault = localStorage.getItem('soj_default_mode');
      if (savedDefault) {
        currentMode = savedDefault;
        $$('.mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === currentMode);
        });
      } else {
        const picked = await showModePicker();
        currentMode = picked;
        $$('.mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === currentMode);
        });
      }

      updateModeUI();
      await loadProblemData();
    } catch (err) {
      showToast('加载题目失败：' + err.message);
    }
  }

  // 加载题目对应的会话和代码文件
  async function loadProblemData() {
    // 重置编辑器
    codeEditor.value     = '';
    codeDescInput.value  = '';
    syncHighlight();
    sessionHistories     = {};
    sessionBlocks        = {};
    sessions             = [];
    activeSessionKey     = 'main';
    codeFiles            = [];
    activeCodeFile       = null;
    markCodeSaved(false);
    renderCodeFileBar();

    // 重置代码提问状态
    codeQaThreads = [];
    codeQuestions = [];
    activeQaIndex = 0;
    answeredCount = 0;
    codeQaEmpty.style.display = '';
    codeQaWrap.style.display  = 'none';
    codeQaInputWrap.style.display = 'none';

    // 重置代码翻译状态
    translateVersions = [];
    activeTranslateIdx = 0;
    tlEmpty.style.display = '';
    tlWrap.style.display  = 'none';

    // 重置推荐状态
    recLoaded = false;
    if (recEmpty) recEmpty.style.display = '';
    if (recWrap) recWrap.style.display = 'none';

    await Promise.all([
      loadSessions(),
      loadCodeFiles(),
      loadCodeQaThreads(),
      loadTranslateVersions(),
    ]);

    // 自动记录进度
    try {
      await fetch('/api/student/progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemId: currentProblemId }),
      });
    } catch {}

    if (activeTab === 'recommend') loadRecommendations();
  }

  // ============================================================
  // 折叠切换
  // ============================================================
  $('#toggleProblem').addEventListener('click', () => problemBanner.classList.toggle('collapsed'));

  // ============================================================
  // 编译运行（成功后自动保存代码）
  // ============================================================
  compileBtn.addEventListener('click', runCompile);
  codeEditor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCompile(); }
  });

  // 下载 .cpp 文件
  document.getElementById('downloadCppBtn').addEventListener('click', () => {
    const code = codeEditor.value;
    if (!code.trim()) { showToast('编辑器为空，无法下载'); return; }
    const filename = (activeCodeFile ? activeCodeFile : (currentProblemId ? currentProblemId + '-code' : 'code')) + '.cpp';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });

  async function runCompile() {
    const code = codeEditor.value;
    if (!code.trim()) { showOutput('代码不能为空', true); return; }

    compileBtn.disabled = true;
    compileBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    outputContent.textContent = '编译中…';
    outputContent.className   = 'output-content-inline';
    outputMeta.textContent    = '';

    try {
      const res  = await fetch('/api/compile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code, stdin: stdinInput.value, timeLimit: 5 }),
      });
      const data = await res.json();
      if (data.success) {
        showOutput(data.stdout || '(无输出)', false);
        outputMeta.textContent = `运行时间：${data.timeUsed}ms`;
        // 编译成功后自动保存
        if (currentProblemId) {
          clearTimeout(codeSaveTimer);
          await saveCurrentCodeFile();
        }
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
    outputContent.className   = 'output-content-inline ' + (isError ? 'error' : 'success');
  }

  // ============================================================
  // Diff 弹窗
  // ============================================================
  diffBtn.addEventListener('click', openDiffModal);
  $('#closeDiff').addEventListener('click', () => diffModal.classList.remove('open'));
  diffModal.addEventListener('click', (e) => { if (e.target === diffModal) diffModal.classList.remove('open'); });

  function openDiffModal() {
    if (!currentProblemId || codeFiles.length < 1) {
      showToast('需要至少一个保存的代码文件');
      return;
    }

    const selectA = $('#diffSelectA');
    const selectB = $('#diffSelectB');
    selectA.innerHTML = selectB.innerHTML = '';

    codeFiles.forEach(f => {
      const opt  = document.createElement('option');
      opt.value  = f.filename;
      opt.textContent = f.filename + '.cpp' + (f.description ? ` — ${f.description}` : '');
      selectA.appendChild(opt.cloneNode(true));
      selectB.appendChild(opt);
    });

    // 默认 A 最旧，B 最新
    if (codeFiles.length >= 2) {
      selectA.value = codeFiles[0].filename;
      selectB.value = codeFiles[codeFiles.length - 1].filename;
    }

    $('#diffPanes').style.display      = 'none';
    $('#diffSummaryBox').style.display = 'none';
    $('#diffSummaryBtn').style.display = 'none';

    diffModal.classList.add('open');
  }

  $('#diffLoadBtn').addEventListener('click', async () => {
    const filenameA = $('#diffSelectA').value;
    const filenameB = $('#diffSelectB').value;
    if (!filenameA || !filenameB) return;

    const [resA, resB] = await Promise.all([
      fetch(`/api/problem/${currentProblemId}/codes/${filenameA}`).then(r => r.json()),
      fetch(`/api/problem/${currentProblemId}/codes/${filenameB}`).then(r => r.json()),
    ]);

    if (!resA.success || !resB.success) { showToast('加载代码失败'); return; }

    $('#diffHeaderA').textContent = filenameA + '.cpp';
    $('#diffHeaderB').textContent = filenameB + '.cpp';
    $('#diffCodeA').textContent   = resA.code || '';
    $('#diffCodeB').textContent   = resB.code || '';

    $('#diffPanes').style.display      = 'flex';
    $('#diffSummaryBox').style.display = 'none';
    $('#diffSummaryBtn').style.display = filenameA !== filenameB ? '' : 'none';
  });

  $('#diffSummaryBtn').addEventListener('click', async () => {
    const btn      = $('#diffSummaryBtn');
    const filenameA = $('#diffSelectA').value;
    const filenameB = $('#diffSelectB').value;
    const codeA    = $('#diffCodeA').textContent;
    const codeB    = $('#diffCodeB').textContent;

    btn.disabled = true;
    btn.textContent = '分析中…';

    try {
      const res  = await fetch('/api/diff-summary', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          codeA, codeB,
          nameA: filenameA + '.cpp',
          nameB: filenameB + '.cpp',
          problemContext,
        }),
      });
      const data = await res.json();
      if (data.success) {
        $('#diffSummaryContent').textContent = data.summary;
        $('#diffSummaryBox').style.display   = 'block';
      } else {
        showToast('分析失败：' + (data.error || '请重试'));
      }
    } catch (err) { showToast('网络错误：' + err.message); }

    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> AI 分析差异`;
  });

  // ============================================================
  // 用户信息 & 设置弹窗
  // ============================================================
  let currentUser = null;

  async function loadUserInfo() {
    try {
      const res  = await fetch('/api/auth/me');
      const data = await res.json();
      if (!data.loggedIn) { window.location.href = '/login'; return; }
      currentUser = data.user;
      // 顶部徽标
      const av = data.user.username.slice(0, 1).toUpperCase();
      $('#userAvatar').textContent      = av;
      $('#userNameDisplay').textContent = data.user.username;
      // 设置弹窗账号信息
      $('#settingsAccountId').textContent   = '#' + data.user.id;
      const dot = $('#accountIdDot');
      if (dot) {
        const roleColors = { superadmin: 'hsl(25,76%,52%)', admin: '#2563eb' };
        dot.style.background = roleColors[data.user.role] || ('#' + data.user.id);
      }
      $('#settingsAccountName').textContent = data.user.username;
      const roleMap = { superadmin: '超级管理员', admin: '管理员', palacestudent: '少年宫用户', user: '普通用户' };
      const roleBadge = $('#settingsRoleBadge');
      roleBadge.textContent = roleMap[data.user.role] || data.user.role;
      roleBadge.className   = 'account-role-badge role-' + data.user.role;
      // 管理员入口
      if (data.user.role === 'admin' || data.user.role === 'superadmin') {
        $('#adminEntryBtn').style.display = 'inline-flex';
      }
    } catch {
      window.location.href = '/login';
    }
  }

  // 默认模式设置
  const defaultModeSelect = $('#defaultModeSelect');
  defaultModeSelect.value = localStorage.getItem('soj_default_mode') || '';
  defaultModeSelect.addEventListener('change', () => {
    const v = defaultModeSelect.value;
    if (v) localStorage.setItem('soj_default_mode', v);
    else localStorage.removeItem('soj_default_mode');
  });

  $('#settingsBtn').addEventListener('click', async () => {
    settingsModal.classList.add('open');
    defaultModeSelect.value = localStorage.getItem('soj_default_mode') || '';
    try {
      const res  = await fetch('/api/usage');
      const data = await res.json();
      if (data.needLogin) { window.location.href = '/login'; return; }
      $('#usageToday').textContent     = formatTokens(data.today.tokens);
      $('#usageTodayCost').textContent = `¥${data.today.cost} · ${data.today.calls} 次`;
      $('#usageWeek').textContent      = formatTokens(data.week.tokens);
      $('#usageWeekCost').textContent  = `¥${data.week.cost} · ${data.week.calls} 次`;
      $('#usageTotal').textContent     = formatTokens(data.total.tokens);
      $('#usageTotalCost').textContent = `¥${data.total.cost} · ${data.total.calls} 次`;
    } catch {}
    try {
      const res  = await fetch('/api/config/status');
      const data = await res.json();
      const hint = $('#apiKeyStatus');
      const clearBtn = $('#clearApiKeyBtn');
      if (data.configured && data.isPersonal) {
        hint.textContent = `个人 Key 生效中（${data.preview}）`;
        hint.style.color = 'var(--success)';
        if (clearBtn) clearBtn.style.display = 'inline-block';
      } else if (data.configured) {
        hint.textContent = `全局 Key 已配置（${data.preview}）`;
        hint.style.color = 'var(--success)';
        if (clearBtn) clearBtn.style.display = 'none';
      } else {
        hint.textContent = '未配置 — 上传个人 Key 或联系管理员';
        hint.style.color = 'var(--warning)';
        if (clearBtn) clearBtn.style.display = 'none';
      }
    } catch {}
  });

  $('#closeSettings').addEventListener('click', () => settingsModal.classList.remove('open'));
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

  // 上传个人临时 API Key
  $('#saveApiKeyBtn').addEventListener('click', async () => {
    const apiKeyInput = $('#apiKeyInput');
    const key = apiKeyInput.value.trim();
    if (!key) { showToast('请先粘贴 API Key'); return; }
    try {
      const res  = await fetch('/api/auth/temp-apikey', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('个人 Key 已上传 ✓（退出登录后自动清除）');
        apiKeyInput.value = '';
        const hint = $('#apiKeyStatus');
        hint.textContent = '个人 Key 生效中 ✓';
        hint.style.color = 'var(--success)';
        const clearBtn = $('#clearApiKeyBtn');
        if (clearBtn) clearBtn.style.display = 'inline-block';
      } else {
        showToast('上传失败：' + (data.error || '请检查 Key 格式'));
      }
    } catch (err) { showToast('网络错误：' + err.message); }
  });

  // 清除个人 Key
  const clearApiKeyBtn = $('#clearApiKeyBtn');
  if (clearApiKeyBtn) {
    clearApiKeyBtn.addEventListener('click', async () => {
      await fetch('/api/auth/temp-apikey', { method: 'DELETE' });
      showToast('个人 Key 已清除');
      clearApiKeyBtn.style.display = 'none';
      const hint = $('#apiKeyStatus');
      hint.textContent = '正在检查…';
    });
  }

  // 退出登录
  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  }

  // API Key 防复制/剪切
  const apiKeyInputEl = $('#apiKeyInput');
  if (apiKeyInputEl) {
    apiKeyInputEl.addEventListener('copy', (e) => e.preventDefault());
    apiKeyInputEl.addEventListener('cut',  (e) => e.preventDefault());
  }

  // ============================================================
  // Tab 键插入空格（代码编辑器）
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
  // Toast
  // ============================================================
  let toastTimer = null;
  function showToast(msg, persist = false) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    if (!persist) toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
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

  // 简单 djb2 hash（用于自定义题目唯一 ID）
  function simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
    return Math.abs(h).toString(36).padStart(8, '0');
  }

  // ============================================================
  // 功能1：C++ 语法高亮（Overlay 方案）
  // ============================================================
  const codeHighlight = $('#codeHighlight');

  const CPP_KEYWORDS = new Set([
    'auto','break','case','catch','class','const','constexpr','continue',
    'default','delete','do','else','enum','explicit','extern','false','final',
    'for','friend','goto','if','inline','mutable','namespace','new','noexcept',
    'nullptr','operator','override','private','protected','public','register',
    'return','sizeof','static','static_assert','static_cast','struct','switch',
    'template','this','throw','true','try','typedef','typeid','typename',
    'union','using','virtual','volatile','while',
  ]);
  const CPP_TYPES = new Set([
    'bool','char','char16_t','char32_t','double','float','int','long',
    'short','signed','unsigned','void','wchar_t','string','vector','map',
    'set','unordered_map','unordered_set','pair','tuple','queue','stack',
    'deque','list','array','bitset','priority_queue','multiset','multimap',
    'size_t','ptrdiff_t','nullptr_t','int8_t','int16_t','int32_t','int64_t',
    'uint8_t','uint16_t','uint32_t','uint64_t',
  ]);

  function highlightCpp(code) {
    let result = '';
    let i = 0;
    const len = code.length;

    while (i < len) {
      const ch = code[i];

      // 换行直接输出
      if (ch === '\n') { result += '\n'; i++; continue; }

      // 预处理指令（# 开头行）
      if (ch === '#' && (i === 0 || code[i - 1] === '\n')) {
        let end = i;
        while (end < len && code[end] !== '\n') end++;
        result += `<span class="hl-preproc">${escHtml(code.slice(i, end))}</span>`;
        i = end;
        continue;
      }

      // 单行注释
      if (ch === '/' && code[i + 1] === '/') {
        let end = i;
        while (end < len && code[end] !== '\n') end++;
        result += `<span class="hl-comment">${escHtml(code.slice(i, end))}</span>`;
        i = end;
        continue;
      }

      // 多行注释
      if (ch === '/' && code[i + 1] === '*') {
        let end = i + 2;
        while (end < len - 1 && !(code[end] === '*' && code[end + 1] === '/')) end++;
        end += 2;
        result += `<span class="hl-comment">${escHtml(code.slice(i, end))}</span>`;
        i = end;
        continue;
      }

      // 字符串 " "
      if (ch === '"') {
        let end = i + 1;
        while (end < len && !(code[end] === '"' && code[end - 1] !== '\\') && code[end] !== '\n') end++;
        end++;
        result += `<span class="hl-string">${escHtml(code.slice(i, end))}</span>`;
        i = end;
        continue;
      }

      // 字符 ' '
      if (ch === "'") {
        let end = i + 1;
        while (end < len && !(code[end] === "'" && code[end - 1] !== '\\') && code[end] !== '\n') end++;
        end++;
        result += `<span class="hl-string">${escHtml(code.slice(i, end))}</span>`;
        i = end;
        continue;
      }

      // 数字
      if (ch >= '0' && ch <= '9') {
        let end = i;
        while (end < len && (
          (code[end] >= '0' && code[end] <= '9') ||
          code[end] === '.' || code[end] === 'x' || code[end] === 'X' ||
          (code[end] >= 'a' && code[end] <= 'f') || (code[end] >= 'A' && code[end] <= 'F') ||
          code[end] === 'u' || code[end] === 'U' || code[end] === 'l' || code[end] === 'L'
        )) end++;
        result += `<span class="hl-number">${escHtml(code.slice(i, end))}</span>`;
        i = end;
        continue;
      }

      // 标识符（关键字/类型/普通）
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
        let end = i;
        while (end < len && (
          (code[end] >= 'a' && code[end] <= 'z') ||
          (code[end] >= 'A' && code[end] <= 'Z') ||
          (code[end] >= '0' && code[end] <= '9') || code[end] === '_'
        )) end++;
        const word = code.slice(i, end);
        if (CPP_KEYWORDS.has(word)) {
          result += `<span class="hl-keyword">${escHtml(word)}</span>`;
        } else if (CPP_TYPES.has(word)) {
          result += `<span class="hl-type">${escHtml(word)}</span>`;
        } else if (end < len && code[end] === '(') {
          result += `<span class="hl-func">${escHtml(word)}</span>`;
        } else {
          result += `<span class="hl-plain">${escHtml(word)}</span>`;
        }
        i = end;
        continue;
      }

      result += escHtml(ch);
      i++;
    }
    return result;
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function syncHighlight() {
    if (!codeHighlight) return;
    const code = codeEditor.value;
    codeHighlight.innerHTML = highlightCpp(code) + '\n';
    // 同步滚动
    codeHighlight.scrollTop  = codeEditor.scrollTop;
    codeHighlight.scrollLeft = codeEditor.scrollLeft;
  }

  codeEditor.addEventListener('input',  syncHighlight);
  codeEditor.addEventListener('scroll', () => {
    if (codeHighlight) {
      codeHighlight.scrollTop  = codeEditor.scrollTop;
      codeHighlight.scrollLeft = codeEditor.scrollLeft;
    }
  });
  codeEditor.addEventListener('keyup',   syncHighlight);
  codeEditor.addEventListener('paste',   () => setTimeout(syncHighlight, 0));

  // ============================================================
  // 功能2：添加题目模态框
  // ============================================================
  const addProblemModal   = $('#addProblemModal');
  const modalProbIdGroup  = $('#addProblemIdGroup');
  const modalProbIdGrpInl = $('#addProblemIdGroupInline');
  const modalProbId       = $('#modalProbId');
  const modalProbIdInline = $('#modalProbIdInline');
  const modalProbIdHint   = $('#modalProbIdHint');
  const modalProbIdInlHint = $('#modalProbIdInlineHint');

  // 打开/关闭模态框
  function openAddProblemModal() {
    if (!currentUser) return;
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'superadmin';
    // 管理员/超管显示题号输入，其他隐藏（随机生成）
    if (isAdmin) {
      modalProbIdGrpInl.style.display = '';
      modalProbIdGroup.style.display = 'none';
    } else {
      modalProbIdGrpInl.style.display = 'none';
      modalProbIdGroup.style.display = 'none';
    }
    // 重置表单
    ['modalProbTitle','modalProbDesc','modalProbInput','modalProbOutput'].forEach(id => {
      const el = $('#' + id);
      if (el) el.value = '';
    });
    if (modalProbId) modalProbId.value = '';
    if (modalProbIdInline) modalProbIdInline.value = '';
    if (modalProbIdHint) { modalProbIdHint.textContent = ''; modalProbIdHint.className = 'modal-form-hint'; }
    if (modalProbIdInlHint) { modalProbIdInlHint.textContent = ''; modalProbIdInlHint.className = 'modal-form-hint'; }
    const msgEl = $('#addProblemMsg');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'modal-form-msg'; }
    $('#modalProbTime').value = 1000;
    $('#modalProbMem').value  = 256;
    addProblemModal.classList.add('open');
    setTimeout(() => {
      const firstInput = isAdmin ? modalProbIdInline : $('#modalProbTitle');
      if (firstInput) firstInput.focus();
    }, 50);
  }

  $('#addProblemBtn').addEventListener('click', openAddProblemModal);
  $('#closeAddProblem').addEventListener('click', () => addProblemModal.classList.remove('open'));
  $('#cancelAddProblem').addEventListener('click', () => addProblemModal.classList.remove('open'));
  addProblemModal.addEventListener('click', (e) => { if (e.target === addProblemModal) addProblemModal.classList.remove('open'); });

  // 功能3：题号实时检查（管理员/超管）
  let allProblemIds = null;
  async function fetchAllProblemIds() {
    if (allProblemIds !== null) return allProblemIds;
    try {
      const res  = await fetch('/api/admin/problems');
      const data = await res.json();
      if (data.success) allProblemIds = Object.keys(data.problems);
    } catch {}
    return allProblemIds || [];
  }

  async function checkProblemId(idVal, hintEl) {
    if (!idVal) { hintEl.textContent = ''; hintEl.className = 'modal-form-hint'; return false; }
    const ids = await fetchAllProblemIds();
    if (ids.includes(idVal)) {
      hintEl.textContent = `题号 ${idVal} 已存在`;
      hintEl.className = 'modal-form-hint error';
      return false;
    } else {
      hintEl.textContent = '✓ 可用';
      hintEl.className = 'modal-form-hint ok';
      return true;
    }
  }

  if (modalProbIdInline) {
    modalProbIdInline.addEventListener('input', () => {
      if (!currentUser) return;
      const isAdmin = currentUser.role === 'admin' || currentUser.role === 'superadmin';
      if (!isAdmin) return;
      checkProblemId(modalProbIdInline.value.trim(), modalProbIdInlHint);
    });
  }

  // 提交添加题目
  $('#submitAddProblem').addEventListener('click', async () => {
    if (!currentUser) return;
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'superadmin';
    const title   = $('#modalProbTitle').value.trim();
    const msgEl   = $('#addProblemMsg');

    msgEl.className = 'modal-form-msg';

    if (!title) {
      msgEl.textContent = '标题必填';
      msgEl.className = 'modal-form-msg error';
      return;
    }

    let probId = '';
    if (isAdmin) {
      probId = (modalProbIdInline ? modalProbIdInline.value.trim() : '');
      if (!probId) {
        msgEl.textContent = '管理员必须填写题目编号';
        msgEl.className = 'modal-form-msg error';
        return;
      }
      // 题号重复检查
      const ids = await fetchAllProblemIds();
      if (ids.includes(probId)) {
        msgEl.textContent = `题号 ${probId} 已存在，请换一个`;
        msgEl.className = 'modal-form-msg error';
        return;
      }
    }

    const body = {
      title,
      description: $('#modalProbDesc').value,
      inputDesc:   $('#modalProbInput').value,
      outputDesc:  $('#modalProbOutput').value,
      timeLimit:   parseInt($('#modalProbTime').value) || 1000,
      memoryLimit: parseInt($('#modalProbMem').value)  || 256,
      samples: [],
    };
    if (probId) body.id = probId;

    try {
      const endpoint = isAdmin ? '/api/admin/problems' : '/api/user/problems';
      const res  = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        const assignedId = data.id || body.id;
        allProblemIds = null; // 清缓存，下次重新拉取
        msgEl.textContent = `题目添加成功！题号：${assignedId}`;
        msgEl.className = 'modal-form-msg success';
        showToast(`题目已添加，题号：${assignedId}`);
        setTimeout(() => addProblemModal.classList.remove('open'), 1500);
      } else {
        msgEl.textContent = data.error || '添加失败';
        msgEl.className = 'modal-form-msg error';
      }
    } catch (err) {
      msgEl.textContent = '网络错误：' + err.message;
      msgEl.className = 'modal-form-msg error';
    }
  });

  // 题目编号输入框只允许输入编号，不允许长文本粘贴
  problemIdInput.addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    if (pasted.length > 20) {
      e.preventDefault();
      showToast('题号最多20位，请在"添加题目"中输入题面');
    }
  });

  // ============================================================
  // 功能4：面板拖拽调整 + 隐藏
  // ============================================================
  const panelEditor  = $('.panel-editor');
  const panelChatEl  = $('#panelChat');
  const panelResizer = $('#panelResizer');
  const toggleLeft   = $('#toggleLeftPanel');
  const toggleRight  = $('#toggleRightPanel');

  const RESIZER_W = 5; // px，与 CSS .panel-resizer width 一致
  const MIN_W = 320;   // 每个面板最小宽度（与 CSS min-width 保持一致）

  let leftHidden  = false;
  let rightHidden = false;

  // 计算 workspace 可用宽度（减去 resizer）
  function getAvailableWidth() {
    const workspace = $('.workspace');
    return workspace.offsetWidth - RESIZER_W;
  }

  // 用 flex-basis（px）精确控制两个面板宽度，确保加起来 = 可用宽度
  function applyPanelWidths(leftPx) {
    const avail = getAvailableWidth();
    const clampedLeft = Math.max(MIN_W, Math.min(avail - MIN_W, leftPx));
    const rightPx = avail - clampedLeft;
    panelEditor.style.flexBasis = clampedLeft + 'px';
    panelEditor.style.flexGrow  = '0';
    panelEditor.style.flexShrink = '0';
    panelChatEl.style.flexBasis = rightPx + 'px';
    panelChatEl.style.flexGrow  = '0';
    panelChatEl.style.flexShrink = '0';
  }

  // 从 localStorage 恢复比例
  const savedRatio = parseFloat(localStorage.getItem('oj_editor_ratio') || '0.5');
  applyPanelWidths(getAvailableWidth() * savedRatio);

  // 窗口 resize 时保持比例
  window.addEventListener('resize', () => {
    const ratio = parseFloat(localStorage.getItem('oj_editor_ratio') || '0.5');
    applyPanelWidths(getAvailableWidth() * ratio);
  });

  // 拖拽调整宽度
  let dragging = false;
  let dragStartX = 0;
  let dragStartW = 0;

  panelResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    dragStartX = e.clientX;
    dragStartW = panelEditor.offsetWidth;
    panelResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newW = dragStartW + (e.clientX - dragStartX);
    applyPanelWidths(newW);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panelResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // 保存比例而非绝对宽度，窗口缩放后能自适应
    const ratio = panelEditor.offsetWidth / getAvailableWidth();
    localStorage.setItem('oj_editor_ratio', ratio.toFixed(4));
  });

  // 隐藏面板后，重置显示的那个面板撑满
  function resetPanelWidthsAfterToggle() {
    const resizerVisible = !leftHidden && !rightHidden;
    panelResizer.style.display = resizerVisible ? '' : 'none';

    if (!leftHidden && !rightHidden) {
      // 两个都可见 → 恢复保存的比例
      const ratio = parseFloat(localStorage.getItem('oj_editor_ratio') || '0.5');
      applyPanelWidths(getAvailableWidth() * ratio);
    } else if (!leftHidden && rightHidden) {
      // 只有左侧可见 → 撑满
      panelEditor.style.flexBasis = '';
      panelEditor.style.flexGrow  = '1';
      panelEditor.style.flexShrink = '1';
    } else if (leftHidden && !rightHidden) {
      // 只有右侧可见 → 撑满
      panelChatEl.style.flexBasis = '';
      panelChatEl.style.flexGrow  = '1';
      panelChatEl.style.flexShrink = '1';
    }
  }

  // 隐藏/显示左侧（编辑器）面板
  toggleLeft.addEventListener('click', () => {
    leftHidden = !leftHidden;
    panelEditor.classList.toggle('panel-hidden', leftHidden);
    toggleLeft.classList.toggle('active', leftHidden);
    const leftRect = toggleLeft.querySelector('.ptb-left');
    if (leftRect) {
      leftRect.className = leftHidden ? 'ptb-rect ptb-left ptb-empty' : 'ptb-rect ptb-left ptb-filled';
    }
    resetPanelWidthsAfterToggle();
  });

  // 隐藏/显示右侧（问答）面板
  toggleRight.addEventListener('click', () => {
    rightHidden = !rightHidden;
    panelChatEl.classList.toggle('panel-hidden', rightHidden);
    toggleRight.classList.toggle('active', rightHidden);
    const rightRect = toggleRight.querySelector('.ptb-right');
    if (rightRect) {
      rightRect.className = rightHidden ? 'ptb-rect ptb-right ptb-empty' : 'ptb-rect ptb-right ptb-filled';
    }
    resetPanelWidthsAfterToggle();
  });

  // ============================================================
  // 反馈与榜单
  // ============================================================
  const feedbackModal = $('#feedbackModal');
  const feedbackHeaderBtn = $('#feedbackHeaderBtn');

  feedbackHeaderBtn.addEventListener('click', () => {
    feedbackModal.classList.add('open');
    loadMyFeedback();
    loadLeaderboard();
  });
  $('#closeFeedback').addEventListener('click', () => feedbackModal.classList.remove('open'));
  feedbackModal.addEventListener('click', (e) => { if (e.target === feedbackModal) feedbackModal.classList.remove('open'); });

  $('#submitFeedbackBtn').addEventListener('click', async () => {
    const input = $('#feedbackInput');
    const text = input.value.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json();
      if (data.success) {
        input.value = '';
        showToast('反馈已提交');
        loadMyFeedback();
      } else {
        showToast(data.error || '提交失败');
      }
    } catch { showToast('网络错误'); }
  });

  async function loadMyFeedback() {
    try {
      const res = await fetch('/api/feedback/mine');
      const data = await res.json();
      const list = $('#myFeedbackList');
      if (!data.success || !data.feedbacks.length) {
        list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">暂无反馈记录</div>';
        return;
      }
      list.innerHTML = data.feedbacks.map(f => {
        const statusText = f.status === 'accepted' ? `<span style="color:#22c55e">已采纳 (+${f.score}分)</span>`
          : f.status === 'rejected' ? '<span style="color:var(--text-muted)">未采纳</span>'
          : '<span style="color:var(--text-muted)">待审核</span>';
        return `<div class="feedback-item">
          <div class="feedback-item-content">${escapeHtml(f.content)}</div>
          <div class="feedback-item-meta">
            <span>${f.createdAt?.slice(0, 10) || ''}</span>
            ${statusText}
          </div>
        </div>`;
      }).join('');
    } catch {}
  }

  async function loadLeaderboard() {
    try {
      const res = await fetch('/api/feedback/leaderboard');
      const data = await res.json();
      const list = $('#leaderboardList');
      if (!data.success || !data.leaderboard.length) {
        list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:12px 0">暂无榜单数据</div>';
        return;
      }
      const rankClass = (i) => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      const rankLabel = (i) => i === 0 ? '&#x1F947;' : i === 1 ? '&#x1F948;' : i === 2 ? '&#x1F949;' : (i + 1);
      list.innerHTML = data.leaderboard.map((u, i) => {
        const isMe = currentUser && u.username === currentUser.username;
        return `<div class="lb-row${isMe ? ' lb-me' : ''}">
          <div class="lb-rank ${rankClass(i)}">${rankLabel(i)}</div>
          <div class="lb-info">
            <div class="lb-name">${escapeHtml(u.username)}</div>
            <div class="lb-stats">采纳 ${u.count} 次</div>
          </div>
          <div class="lb-score">${u.totalScore}</div>
        </div>`;
      }).join('');
    } catch {}
  }

  // ============================================================
  // 初始化
  // ============================================================
  updateModeUI();
  renderSessionBar();
  renderCodeFileBar();

  // 加载用户信息（未登录则跳转到登录页）
  loadUserInfo().then(() => {
    // 管理员预加载题号缓存，方便题号检查
    if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin')) {
      fetchAllProblemIds().catch(() => {});
    }
  });

  // 初始高亮
  syncHighlight();

  // ============================================================
  // 题目区域 / 工作区 垂直拖拽调整高度
  // ============================================================
  (function initBannerResizer() {
    const resizer      = document.getElementById('bannerResizer');
    const banner       = document.getElementById('problemBanner');
    if (!resizer || !banner) return;

    let dragging   = false;
    let startY     = 0;
    let startH     = 0;
    const MIN_H    = 36;

    function getMaxH() { return Math.floor(window.innerHeight * 0.6); }

    function applyHeight(h) {
      banner.style.maxHeight = h + 'px';
      banner.style.setProperty('--banner-max-h', h + 'px');
    }

    resizer.addEventListener('mousedown', (e) => {
      if (banner.classList.contains('collapsed')) return;
      dragging = true;
      startY   = e.clientY;
      startH   = banner.getBoundingClientRect().height;
      document.body.style.cursor     = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = e.clientY - startY;
      const newH  = Math.min(Math.max(startH + delta, MIN_H), getMaxH());
      banner.style.transition = 'none';
      applyHeight(newH);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      banner.style.transition        = '';
    });
  })();

  // 预加载回顾缓存
  fetch('/api/student/review')
    .then(r => r.json())
    .then(d => {
      if (d.needLogin) { window.location.href = '/login'; return; }
      reviewCache = d.items || [];
    })
    .catch(() => {});

  // ============================================================
  // 推荐 Tab
  // ============================================================
  const recEmpty  = $('#recEmpty');
  const recWrap   = $('#recWrap');
  const recNext   = $('#recNext');
  const recEasier = $('#recEasier');
  const recTopic  = $('#recTopic');
  const recTopicSelect = $('#recTopicSelect');
  const recTopicBtn    = $('#recTopicBtn');
  let recLoaded = false;

  async function loadRecommendations() {
    if (!currentProblemId) {
      recEmpty.style.display = '';
      recWrap.style.display  = 'none';
      return;
    }
    recEmpty.style.display = 'none';
    recWrap.style.display  = '';
    recNext.innerHTML   = '<div class="rec-loading">加载中…</div>';
    recEasier.innerHTML = '<div class="rec-loading">加载中…</div>';
    recLoaded = true;

    try {
      const [nextRes, easierRes, tagsRes] = await Promise.all([
        fetch('/api/recommend', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ problem_id: currentProblemId, mode: 'next', count: 3 }),
        }).then(r => r.json()),
        fetch('/api/recommend', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ problem_id: currentProblemId, mode: 'easier', count: 3 }),
        }).then(r => r.json()),
        fetch('/api/problems/tags').then(r => r.json()),
      ]);
      renderRecCards(recNext, nextRes.recommendations || [], 'next');
      renderRecCards(recEasier, easierRes.recommendations || [], 'easier');
      if (tagsRes.success && tagsRes.tags) {
        recTopicSelect.innerHTML = '<option value="">选择标签…</option>' +
          tagsRes.tags.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} (${t.count})</option>`).join('');
      }
    } catch {
      recNext.innerHTML   = '<div class="rec-no-data">推荐服务不可用</div>';
      recEasier.innerHTML = '<div class="rec-no-data">推荐服务不可用</div>';
    }
  }

  function renderRecCards(container, recs, accentType) {
    if (!recs.length) {
      container.innerHTML = '<div class="rec-no-data">暂无推荐</div>';
      return;
    }
    const accent = accentType || 'topic';
    container.innerHTML = recs.map(r => `
      <div class="rec-card" data-pid="${escapeHtml(r.id)}">
        <div class="rec-card-accent ${accent}"></div>
        <div class="rec-card-body">
          <div class="rec-card-main">
            <div class="rec-card-title">
              <span class="rec-card-id">#${escapeHtml(r.id)}</span>
              <span class="rec-card-title-text">${escapeHtml(r.title)}</span>
            </div>
            <div class="rec-card-tags">${(r.tags || []).slice(0, 4).map(t => `<span class="rec-card-tag">${escapeHtml(t)}</span>`).join('')}</div>
            ${r.reason ? `<div class="rec-card-reason">${escapeHtml(r.reason)}</div>` : ''}
          </div>
          <div class="rec-card-diff">${r.difficulty || '?'}</div>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('.rec-card').forEach(card => {
      card.addEventListener('click', () => {
        const pid = card.dataset.pid;
        problemIdInput.value = pid;
        loadProblem();
      });
    });
  }

  if (recTopicBtn) {
    recTopicBtn.addEventListener('click', async () => {
      const topic = recTopicSelect.value;
      if (!topic) return;
      recTopic.innerHTML = '<div class="rec-loading">搜索中…</div>';
      try {
        const res = await fetch('/api/recommend', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'topic', topic, count: 10 }),
        });
        const data = await res.json();
        renderRecCards(recTopic, data.recommendations || [], 'topic');
      } catch {
        recTopic.innerHTML = '<div class="rec-no-data">推荐服务不可用</div>';
      }
    });
  }

  // ============================================================
  // 进度 View
  // ============================================================
  let progressMode = false;
  let progressData = {};
  let progressFilter = 'all';
  const progressHeaderBtn = $('#progressHeaderBtn');
  const progressList      = $('#progressList');
  const progressCount     = $('#progressCount');
  const progressSearch    = $('#progressSearch');
  const topicStatsCards   = $('#topicStatsCards');
  const leaderboardList   = $('#leaderboardList');

  if (progressHeaderBtn) {
    progressHeaderBtn.addEventListener('click', () => {
      progressMode = !progressMode;
      progressHeaderBtn.classList.toggle('active', progressMode);
      panelChat.classList.toggle('in-progress', progressMode);

      if (reviewMode) {
        reviewMode = false;
        reviewHeaderBtn.classList.remove('active');
        panelChat.classList.remove('in-review');
      }

      if (progressMode) loadProgressView();
    });
  }

  $$('#progressFilters .progress-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      progressFilter = btn.dataset.filter;
      $$('#progressFilters .progress-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderProgressList();
    });
  });

  if (progressSearch) {
    progressSearch.addEventListener('input', () => renderProgressList());
  }

  async function loadProgressView() {
    progressList.innerHTML = '<div class="rec-loading">加载中…</div>';
    try {
      const [progRes, statsRes, lbRes] = await Promise.all([
        fetch('/api/student/progress/auto-detect').then(r => r.json()),
        fetch('/api/student/topic-stats').then(r => r.json()),
        fetch('/api/student/leaderboard').then(r => r.json()),
      ]);
      progressData = progRes.progress || {};
      renderProgressList();
      renderTopicStats(statsRes.tagStats || {});
      renderProgressLeaderboard(lbRes.leaderboard || []);
    } catch {
      progressList.innerHTML = '<div class="progress-empty">加载失败</div>';
    }
  }

  function renderProgressSummary() {
    const all = Object.values(progressData);
    const counts = { solved: 0, solving: 0, review: 0, stuck: 0 };
    all.forEach(p => { if (counts[p.status] !== undefined) counts[p.status]++; });
    const summaryEl = document.getElementById('progressSummary');
    if (!summaryEl) return;
    summaryEl.innerHTML = `
      <div class="progress-summary-card s-solved"><span class="progress-summary-num">${counts.solved}</span><span class="progress-summary-label">已解决</span></div>
      <div class="progress-summary-card s-solving"><span class="progress-summary-num">${counts.solving}</span><span class="progress-summary-label">解题中</span></div>
      <div class="progress-summary-card s-review"><span class="progress-summary-num">${counts.review}</span><span class="progress-summary-label">待复习</span></div>
      <div class="progress-summary-card s-stuck"><span class="progress-summary-num">${counts.stuck}</span><span class="progress-summary-label">有疑问</span></div>
    `;
  }

  function renderProgressList() {
    const search = (progressSearch?.value || '').trim().toLowerCase();
    const entries = Object.entries(progressData)
      .filter(([pid, p]) => {
        if (progressFilter !== 'all' && p.status !== progressFilter) return false;
        if (search && !pid.includes(search)) return false;
        return true;
      })
      .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''));

    const statusLabels = { solved: '已解决', solving: '解题中', review: '待复习', stuck: '有疑问' };

    progressCount.textContent = `解题进度（${entries.length} 题）`;
    renderProgressSummary();

    if (!entries.length) {
      progressList.innerHTML = '<div class="progress-empty">暂无记录</div>';
      return;
    }

    progressList.innerHTML = entries.map(([pid, p]) => `
      <div class="progress-item" data-pid="${escapeHtml(pid)}">
        <span class="progress-item-dot ${escapeHtml(p.status)}"></span>
        <span class="progress-item-id">${escapeHtml(pid)}</span>
        <span class="progress-item-title">${escapeHtml(pid)}</span>
        <select class="progress-status-select" data-pid="${escapeHtml(pid)}">
          <option value="solving"${p.status === 'solving' ? ' selected' : ''}>解题中</option>
          <option value="solved"${p.status === 'solved' ? ' selected' : ''}>已解决</option>
          <option value="review"${p.status === 'review' ? ' selected' : ''}>待复习</option>
          <option value="stuck"${p.status === 'stuck' ? ' selected' : ''}>有疑问</option>
        </select>
        <span class="progress-status-badge ${escapeHtml(p.status)}">${statusLabels[p.status] || p.status}</span>
      </div>
    `).join('');

    progressList.querySelectorAll('.progress-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'SELECT') return;
        problemIdInput.value = item.dataset.pid;
        loadProblem();
      });
    });

    progressList.querySelectorAll('.progress-status-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        e.stopPropagation();
        const pid = sel.dataset.pid;
        const status = sel.value;
        try {
          await fetch('/api/student/progress', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ problemId: pid, status }),
          });
          if (progressData[pid]) progressData[pid].status = status;
          renderProgressList();
        } catch {}
      });
    });
  }

  function renderTopicStats(tagStats) {
    const entries = Object.entries(tagStats)
      .filter(([, s]) => s.total > 0)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15);

    if (!entries.length) {
      topicStatsCards.innerHTML = '<div class="progress-empty">暂无数据</div>';
      return;
    }

    topicStatsCards.innerHTML = entries.map(([tag, s]) => {
      const done = s.solved + s.review;
      const pct = s.total > 0 ? Math.round(done / s.total * 100) : 0;
      return `
        <div class="topic-stat-card" data-tag="${escapeHtml(tag)}" title="点击查看「${escapeHtml(tag)}」知识图谱">
          <span class="topic-stat-name" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>
          <div class="topic-stat-bar"><div class="topic-stat-fill" style="width:${pct}%"></div></div>
          <span class="topic-stat-text">${done}/${s.total} <span style="opacity:0.6;font-size:10px">${pct}%</span></span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" style="flex-shrink:0;opacity:0.4"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><line x1="8" y1="7" x2="16" y2="17" stroke-dasharray="2"/><line x1="8" y1="6" x2="15.5" y2="6"/></svg>
        </div>`;
    }).join('');

    topicStatsCards.querySelectorAll('.topic-stat-card').forEach(card => {
      card.addEventListener('click', () => {
        const tag = card.dataset.tag;
        if (tag) openGraphModal(tag);
      });
    });
  }

  function renderProgressLeaderboard(rows) {
    if (!rows.length) {
      leaderboardList.innerHTML = '<div class="progress-empty">暂无数据</div>';
      return;
    }
    leaderboardList.innerHTML = rows.map((r, i) => {
      const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
      return `
        <div class="progress-lb-row">
          <span class="progress-lb-rank ${rankClass}">${medal || (i + 1)}</span>
          <span class="progress-lb-name">${escapeHtml(r.displayName || r.username)}</span>
          <span class="progress-lb-score">${r.solved} 题</span>
        </div>`;
    }).join('');
  }

  // ============================================================
  // 知识图谱可视化
  // ============================================================
  const graphModal     = document.getElementById('graphModal');
  const graphModalTag  = document.getElementById('graphModalTag');
  const graphModalClose = document.getElementById('graphModalClose');
  const graphSvg       = document.getElementById('graphSvg');
  const graphTooltip   = document.getElementById('graphTooltip');
  const graphLoading   = document.getElementById('graphLoading');
  const graphStats     = document.getElementById('graphStats');
  let currentSimulation = null;

  function openGraphModal(tag) {
    if (!graphModal) return;
    graphModal.classList.add('open');
    if (graphModalTag) graphModalTag.textContent = tag + ' · 知识图谱';
    if (graphLoading) {
      graphLoading.style.display = '';
      graphLoading.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>加载图谱数据…';
    }
    if (graphSvg) graphSvg.innerHTML = '';
    if (graphStats) graphStats.textContent = '';
    loadSubgraph(tag);
  }

  function closeGraphModal() {
    if (!graphModal) return;
    graphModal.classList.remove('open');
    if (currentSimulation) { currentSimulation.stop(); currentSimulation = null; }
    graphSvg.innerHTML = '';
  }

  if (graphModalClose) graphModalClose.addEventListener('click', closeGraphModal);
  if (graphModal) graphModal.addEventListener('click', (e) => { if (e.target === graphModal) closeGraphModal(); });

  async function loadSubgraph(tag) {
    try {
      const res = await fetch(`/api/graph/subgraph?tag=${encodeURIComponent(tag)}`);
      const data = await res.json();
      if (!data.success || !data.nodes?.length) {
        graphLoading.innerHTML = '<div style="color:var(--text-muted)">该标签下暂无图谱数据</div>';
        return;
      }
      graphLoading.style.display = 'none';
      const graphE = (data.edges || []).filter(e => !e.inferred).length;
      const inferE = (data.edges || []).filter(e => e.inferred).length;
      graphStats.textContent = `${data.nodes.length} 节点 · ${graphE} 条确认边` + (inferE ? ` · ${inferE} 条推测边` : '');
      renderForceGraph(data.nodes, data.edges);
    } catch {
      graphLoading.innerHTML = '<div style="color:var(--warning)">加载失败</div>';
    }
  }

  function statusColor(status) {
    const map = { solved: 'var(--success)', solving: 'var(--secondary)', review: 'var(--info)', stuck: 'var(--warning)' };
    return map[status] || 'var(--border)';
  }

  function difficultyRadius(diff) {
    const d = Number(diff) || 5;
    return Math.max(8, Math.min(22, 6 + d * 1.6));
  }

  function renderForceGraph(nodes, edges) {
    if (currentSimulation) currentSimulation.stop();

    const container = graphSvg.parentElement;
    const width = container.clientWidth;
    const height = container.clientHeight;

    const svg = d3.select(graphSvg)
      .attr('viewBox', [0, 0, width, height])
      .attr('width', width)
      .attr('height', height);

    svg.selectAll('*').remove();

    const defs = svg.append('defs');

    const relationColors = {
      PREREQUISITE_OF: 'hsl(25, 76%, 52%)',
      HARDER_VERSION: 'hsl(355, 63%, 52%)',
      SAME_TECHNIQUE: 'hsl(212, 66%, 50%)',
      SIMILAR_TO: 'hsl(145, 50%, 42%)',
    };

    Object.entries(relationColors).forEach(([key, color]) => {
      defs.append('marker')
        .attr('id', `arrow-${key}`)
        .attr('viewBox', '0 -4 8 8')
        .attr('refX', 20)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-3L7,0L0,3')
        .attr('fill', color)
        .attr('opacity', 0.6);
    });

    defs.append('marker')
      .attr('id', 'arrow-default')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-3L7,0L0,3')
      .attr('fill', '#999')
      .attr('opacity', 0.5);

    const g = svg.append('g');

    const zoom = d3.zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const links = edges
      .filter(e => nodeMap.has(e.from) && nodeMap.has(e.to))
      .map(e => ({ source: e.from, target: e.to, relation: e.relation, confidence: e.confidence, inferred: !!e.inferred }));

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(d => d.inferred ? 120 : 80).strength(d => d.inferred ? 0.15 : 0.4))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(d => difficultyRadius(d.difficulty) + 4))
      .force('x', d3.forceX(width / 2).strength(0.05))
      .force('y', d3.forceY(height / 2).strength(0.05));

    currentSimulation = simulation;

    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', d => d.inferred ? '#aaa' : (relationColors[d.relation] || '#ccc'))
      .attr('stroke-width', d => d.inferred ? 1 : 1 + (d.confidence || 0) * 1.5)
      .attr('stroke-opacity', d => d.inferred ? 0.2 : 0.35)
      .attr('stroke-dasharray', d => d.inferred ? '4 3' : 'none')
      .attr('marker-end', d => {
        if (d.inferred) return '';
        if (d.relation === 'SAME_TECHNIQUE' || d.relation === 'SIMILAR_TO') return '';
        return `url(#arrow-${relationColors[d.relation] ? d.relation : 'default'})`;
      });

    const node = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
      );

    node.append('circle')
      .attr('r', d => difficultyRadius(d.difficulty))
      .attr('fill', d => statusColor(d.status))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .attr('opacity', 0.85)
      .transition().duration(600)
      .attr('opacity', 1);

    node.append('text')
      .text(d => d.id)
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('font-size', d => Math.max(8, difficultyRadius(d.difficulty) * 0.65))
      .attr('font-family', "'JetBrains Mono', monospace")
      .attr('font-weight', 600)
      .attr('fill', d => d.status === 'solved' || d.status === 'stuck' ? '#fff' : d.status ? '#fff' : 'var(--text-muted)')
      .attr('pointer-events', 'none');

    const statusLabels = { solved: '已解决', solving: '解题中', review: '待复习', stuck: '有疑问' };

    node.on('mouseover', (event, d) => {
      const tt = graphTooltip;
      tt.style.display = 'block';
      tt.innerHTML = `
        <div class="graph-tooltip-title">${escapeHtml(d.title)}</div>
        <div class="graph-tooltip-id">#${escapeHtml(d.id)} · 难度 ${d.difficulty || '?'}</div>
        <div class="graph-tooltip-tags">${(d.tags || []).slice(0, 5).map(t => `<span class="graph-tooltip-tag">${escapeHtml(t)}</span>`).join('')}</div>
        ${d.status ? `<div class="graph-tooltip-status" style="color:${statusColor(d.status)}">${statusLabels[d.status]}</div>` : '<div class="graph-tooltip-diff" style="opacity:0.5">未开始</div>'}
      `;
      const rect = container.getBoundingClientRect();
      tt.style.left = (event.clientX - rect.left + 12) + 'px';
      tt.style.top  = (event.clientY - rect.top - 10) + 'px';
    })
    .on('mousemove', (event) => {
      const rect = container.getBoundingClientRect();
      const tt = graphTooltip;
      let x = event.clientX - rect.left + 12;
      let y = event.clientY - rect.top - 10;
      if (x + 270 > rect.width) x = event.clientX - rect.left - 270;
      if (y + 100 > rect.height) y = event.clientY - rect.top - 100;
      tt.style.left = x + 'px';
      tt.style.top  = y + 'px';
    })
    .on('mouseout', () => { graphTooltip.style.display = 'none'; })
    .on('click', (_event, d) => {
      closeGraphModal();
      if (progressMode) {
        progressMode = false;
        progressHeaderBtn.classList.remove('active');
        panelChat.classList.remove('in-progress');
      }
      problemIdInput.value = d.id;
      loadProblem();
    });

    node.on('mouseover.highlight', (_event, d) => {
      const connected = new Set([d.id]);
      links.forEach(l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        if (sid === d.id) connected.add(tid);
        if (tid === d.id) connected.add(sid);
      });
      node.attr('opacity', n => connected.has(n.id) ? 1 : 0.15);
      link.attr('stroke-opacity', l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        return (sid === d.id || tid === d.id) ? 0.7 : 0.05;
      });
    })
    .on('mouseout.highlight', () => {
      node.attr('opacity', 1);
      link.attr('stroke-opacity', 0.35);
    });

    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    svg.call(zoom.transform, d3.zoomIdentity.translate(0, 0).scale(1));
  }

  // ── 有效对话时长追踪 ──────────────────────────────────────
  (function initActiveTimeTracker() {
    const IDLE_TIMEOUT  = 5 * 60 * 1000;  // 5 min
    const REPORT_INTERVAL = 120 * 1000;  // every 2 min

    let lastActivity  = Date.now();
    let activeSeconds = 0;
    let focused       = document.hasFocus();
    const TICK = 30; // seconds per tick

    function onActivity() { lastActivity = Date.now(); }

    document.addEventListener('mousemove', onActivity, { passive: true });
    document.addEventListener('mousedown', onActivity, { passive: true });
    document.addEventListener('keydown',   onActivity, { passive: true });
    document.addEventListener('scroll',    onActivity, { passive: true });
    document.addEventListener('touchstart', onActivity, { passive: true });

    window.addEventListener('focus', () => { focused = true; onActivity(); });
    window.addEventListener('blur',  () => { focused = false; });

    setInterval(() => {
      if (focused && (Date.now() - lastActivity < IDLE_TIMEOUT)) {
        activeSeconds += TICK;
      }
    }, TICK * 1000);

    setInterval(() => {
      if (activeSeconds <= 0) return;
      const toReport = activeSeconds;
      activeSeconds = 0;
      fetch('/api/active-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: toReport }),
      }).catch(() => {});
    }, REPORT_INTERVAL);

    window.addEventListener('beforeunload', () => {
      if (activeSeconds > 0) {
        navigator.sendBeacon('/api/active-time',
          new Blob([JSON.stringify({ seconds: activeSeconds })], { type: 'application/json' })
        );
      }
    });
  })();

})();
