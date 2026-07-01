const focusLabels = {
  full: "全流程分析",
  persona: "仅用户画像",
  emotion: "仅情绪洞察",
  opportunity: "仅产品机会"
};

const intelligenceLabels = {
  concise: "简洁版",
  strategic: "策略版",
  operator: "执行版",
  investor: "投资人版"
};

const historyStorageKey = "marketingWorkbenchHistory";
const usersStorageKey = "marketingWorkbenchUsers";
const sessionStorageKey = "marketingWorkbenchSession";
const imageConfigStorageKey = "marketingWorkbenchImageConfig";
const maxHistoryItems = 12;
const searchResultLimit = 8;

const sampleContext =
  "海蓝之谜是高端护肤品牌，核心产品包括精华面霜、修护精萃水、浓缩修护精华等，主打奢华修护、敏感肌屏障护理和高端礼赠场景。目标客户包括高净值女性、熟龄抗老用户、医美后修护人群和高端美妆消费者。当前希望强化品牌价值感、提升复购和内容种草转化。";

const state = {
  report: null,
  activeSection: "personas",
  apiConfigReady: false,
  aiMarkdown: "",
  generationStartedAt: 0,
  generationTimer: null,
  streamRenderTimer: null,
  pendingStreamContent: "",
  lastStreamRenderAt: 0,
  receivedChars: 0,
  lastDeltaAt: 0,
  streamStalled: false,
  streamController: null,
  streamEndedByStall: false,
  isGenerating: false,
  generationPhase: "idle",
  highlightEnabled: false,
  highlightPhrases: [],
  highlightLoading: false,
  currentToc: [],
  imageStudioOpen: false,
  imagePromptLoading: false,
  imageGenerating: false,
  imageBatchGenerating: false,
  imageResults: [],
  imageResultIndex: 0,
  imageLightboxOpen: false,
  imageLightboxIndex: 0,
  history: [],
  users: [],
  currentUser: null,
  currentView: "home",
  onlineSignals: {
    web: {
      status: "idle",
      items: [],
      error: "",
      warning: "",
      searchedAt: "",
      query: "",
      queryKey: "",
      queries: []
    },
    community: {
      status: "idle",
      items: [],
      error: "",
      warning: "",
      searchedAt: "",
      query: "",
      queryKey: "",
      queries: []
    }
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function clean(value) {
  return value.trim().replace(/\s+/g, " ");
}

function hasExternalSignals(signals = {}) {
  return Boolean(signals.webSearch || signals.community);
}

function externalSignalModes(signals = {}) {
  return [
    signals.webSearch ? "全网联索" : null,
    signals.community ? "社区舆论" : null
  ].filter(Boolean);
}

function externalSignalScope(report) {
  const signals = report.input.externalSignals || {};
  if (!hasExternalSignals(signals)) return "未启用外部信号";
  const parts = [];
  if (signals.keywords) parts.push(signals.keywords);
  if (signals.sources) parts.push(signals.sources);
  return parts.length ? parts.join(" / ") : `${report.input.product} / ${report.coreSignal}`;
}

function formatHistoryTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function loadUsers() {
  try {
    const saved = JSON.parse(localStorage.getItem(usersStorageKey) || "[]");
    state.users = Array.isArray(saved) ? saved : [];
  } catch {
    state.users = [];
    localStorage.removeItem(usersStorageKey);
  }
}

function persistUsers() {
  localStorage.setItem(usersStorageKey, JSON.stringify(state.users));
}

function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  return state.users.find((user) => user.email === normalized);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  };
}

function persistSession(user) {
  if (!user) {
    localStorage.removeItem(sessionStorageKey);
    state.currentUser = null;
    return;
  }
  const session = {
    userId: user.id,
    email: user.email,
    signedInAt: new Date().toISOString()
  };
  localStorage.setItem(sessionStorageKey, JSON.stringify(session));
  state.currentUser = publicUser(user);
}

function restoreSession() {
  try {
    const session = JSON.parse(localStorage.getItem(sessionStorageKey) || "null");
    if (!session) return null;
    const user = state.users.find((item) => item.id === session.userId || item.email === session.email);
    if (!user) {
      localStorage.removeItem(sessionStorageKey);
      return null;
    }
    state.currentUser = publicUser(user);
    return state.currentUser;
  } catch {
    localStorage.removeItem(sessionStorageKey);
    return null;
  }
}

function setAuthMode(mode) {
  const isLogin = mode === "login";
  $("#loginForm").hidden = !isLogin;
  $("#registerForm").hidden = isLogin;
  $("#loginForm").classList.toggle("active", isLogin);
  $("#registerForm").classList.toggle("active", !isLogin);
  $("#loginTabBtn").classList.toggle("active", isLogin);
  $("#registerTabBtn").classList.toggle("active", !isLogin);
}

function updateAuthUi() {
  document.body.classList.toggle("authenticated", Boolean(state.currentUser));
  const label = $("#currentUserLabel");
  if (label) {
    label.textContent = state.currentUser
      ? `${state.currentUser.name || state.currentUser.email} / ${state.currentUser.role === "admin" ? "管理员" : "成员"}`
      : "未登录";
  }
  const adminButton = $("#openAdminBtn");
  if (adminButton) {
    adminButton.hidden = state.currentUser?.role !== "admin";
  }
}

function ensureAuthenticated() {
  if (state.currentUser) return true;
  updateAuthUi();
  showToast("请先登录或注册");
  return false;
}

function handleRegister(event) {
  event.preventDefault();
  const name = clean($("#registerNameInput").value);
  const email = normalizeEmail($("#registerEmailInput").value);
  const password = $("#registerPasswordInput").value.trim();

  if (!name || !email || password.length < 6) {
    showToast("请填写姓名、邮箱和至少 6 位密码");
    return;
  }
  if (findUserByEmail(email)) {
    showToast("这个邮箱已经注册，请直接登录");
    setAuthMode("login");
    $("#loginEmailInput").value = email;
    return;
  }

  const now = new Date().toISOString();
  const user = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    email,
    password,
    role: state.users.length ? "member" : "admin",
    createdAt: now,
    lastLoginAt: now
  };
  state.users = [user, ...state.users];
  persistUsers();
  persistSession(user);
  updateAuthUi();
  showWorkbenchView("home");
  renderAdmin();
  showToast(user.role === "admin" ? "注册成功，已成为管理员" : "注册成功");
}

function handleLogin(event) {
  event.preventDefault();
  const email = normalizeEmail($("#loginEmailInput").value);
  const password = $("#loginPasswordInput").value.trim();
  const user = findUserByEmail(email);
  if (!user || user.password !== password) {
    showToast("邮箱或密码不正确");
    return;
  }
  user.lastLoginAt = new Date().toISOString();
  persistUsers();
  persistSession(user);
  updateAuthUi();
  showWorkbenchView("home");
  renderAdmin();
  showToast("登录成功");
}

function logout() {
  persistSession(null);
  updateAuthUi();
  showWorkbenchView("home");
  setAuthMode("login");
  showToast("已退出登录");
}

function getFormData() {
  const product = clean($("#productInput").value) || "未命名产品";
  const stage = document.querySelector("input[name='stage']:checked").value;
  const focus = document.querySelector("input[name='focus']:checked").value;
  const intelligence = document.querySelector("input[name='intelligence']:checked").value;
  const context = clean($("#contextInput").value);
  const externalSignals = {
    webSearch: $("#webSearchInput").checked,
    community: $("#communityInput").checked,
    keywords: clean($("#searchKeywordsInput").value),
    sources: clean($("#communitySourcesInput").value)
  };
  return { product, stage, focus, intelligence, context, externalSignals };
}

function applyInputState(input) {
  if (!input) return;
  $("#productInput").value = input.product || "";
  $("#contextInput").value = input.context || "";
  const stageInput = document.querySelector(`input[name='stage'][value='${input.stage}']`);
  const focusInput = document.querySelector(`input[name='focus'][value='${input.focus}']`);
  const intelligenceInput = document.querySelector(`input[name='intelligence'][value='${input.intelligence}']`);
  if (stageInput) stageInput.checked = true;
  if (focusInput) focusInput.checked = true;
  if (intelligenceInput) intelligenceInput.checked = true;
  $("#webSearchInput").checked = Boolean(input.externalSignals?.webSearch);
  $("#communityInput").checked = Boolean(input.externalSignals?.community);
  $("#searchKeywordsInput").value = input.externalSignals?.keywords || "";
  $("#communitySourcesInput").value = input.externalSignals?.sources || "";
  updateExternalSignalPanels();
}

function updateExternalSignalPanels() {
  const webEnabled = $("#webSearchInput").checked;
  const communityEnabled = $("#communityInput").checked;
  $("#webSearchPanel").classList.toggle("active", webEnabled);
  $("#communityPanel").classList.toggle("active", communityEnabled);
  $("#webSearchStatus").textContent = webEnabled ? "已开启" : "未开启";
  $("#communityStatus").textContent = communityEnabled ? "已开启" : "未开启";
  syncSignalPagesFromWorkbench();
}

function syncSignalPagesFromWorkbench() {
  const webEnabled = $("#webSearchInput").checked;
  const communityEnabled = $("#communityInput").checked;
  $("#webSearchPageInput").checked = webEnabled;
  $("#communityPageInput").checked = communityEnabled;
  $("#webSearchPageKeywordsInput").value = $("#searchKeywordsInput").value;
  $("#communityPageSourcesInput").value = $("#communitySourcesInput").value;
  $("#webPageStatus").textContent = webEnabled ? "已开启" : "未开启";
  $("#communityPageStatus").textContent = communityEnabled ? "已开启" : "未开启";
  $("#webIntelPage .signal-page-card").classList.toggle("active", webEnabled);
  $("#communityPage .signal-page-card").classList.toggle("active", communityEnabled);
  renderSignalRelatedInsights();
}

function updateSignalPageLocalState() {
  const webEnabled = $("#webSearchPageInput").checked;
  const communityEnabled = $("#communityPageInput").checked;
  $("#webPageStatus").textContent = webEnabled ? "已开启" : "未开启";
  $("#communityPageStatus").textContent = communityEnabled ? "已开启" : "未开启";
  $("#webIntelPage .signal-page-card").classList.toggle("active", webEnabled);
  $("#communityPage .signal-page-card").classList.toggle("active", communityEnabled);
  renderSignalRelatedInsights();
}

function saveWebSignalPage() {
  $("#webSearchInput").checked = $("#webSearchPageInput").checked;
  $("#searchKeywordsInput").value = clean($("#webSearchPageKeywordsInput").value);
  updateExternalSignalPanels();
  renderReport(buildReport(getFormData()));
  renderSignalRelatedInsights();
  searchOnlineSignals("web", { force: true });
  showToast("全网联索配置已保存");
}

function saveCommunitySignalPage() {
  $("#communityInput").checked = $("#communityPageInput").checked;
  $("#communitySourcesInput").value = clean($("#communityPageSourcesInput").value);
  updateExternalSignalPanels();
  renderReport(buildReport(getFormData()));
  renderSignalRelatedInsights();
  searchOnlineSignals("community", { force: true });
  showToast("社区舆论配置已保存");
}

function splitSignalTerms(value, fallback) {
  const terms = String(value || "")
    .split(/[,，、/|;\n\r\t]/)
    .map((item) => clean(item))
    .filter(Boolean);
  return terms.length ? terms.slice(0, 6) : fallback;
}

function compactContextTerms(value, limit = 5) {
  const stopWords = new Set(["提供", "包括", "当前", "希望", "提升", "用户", "产品", "平台", "系统", "服务", "功能", "以及", "可以", "进行"]);
  const matches = String(value || "").match(/[\u4e00-\u9fa5A-Za-z0-9]{2,18}/g) || [];
  const terms = [];
  matches.forEach((item) => {
    const term = clean(item);
    if (!term || stopWords.has(term) || terms.includes(term)) return;
    terms.push(term);
  });
  return terms.slice(0, limit);
}

function buildProductSearchPhrase(input, report, profile, kind) {
  const userKeywords = splitSignalTerms(input.externalSignals.keywords, []);
  const contextTerms = compactContextTerms(input.context, 5);
  const corePersona = report.personas.find((item) => item.core) || report.personas[0];
  const opportunityTerms = report.opportunities.slice(0, 2).map((item) => item.name);
  const productTerms = [
    input.product,
    profile.category,
    report.actionSignal,
    corePersona?.name,
    ...opportunityTerms,
    ...contextTerms,
    ...userKeywords
  ].filter(Boolean);

  const uniqueTerms = [...new Set(productTerms)].slice(0, kind === "community" ? 8 : 10);
  return uniqueTerms.join(" ");
}

function getSignalSearchConfig(kind, input = getFormData()) {
  const profile = signalDomainProfile(input.product, input.context);
  const report = buildReport(input);
  const keywords = clean(buildProductSearchPhrase(input, report, profile, kind));
  const sources = clean(input.externalSignals.sources || "知乎, 小红书, 微博, B站, Reddit");
  const enabled = kind === "web" ? input.externalSignals.webSearch : input.externalSignals.community;

  return {
    enabled,
    product: input.product,
    context: input.context,
    keywords,
    sources,
    stage: input.stage,
    focus: input.focus,
    coreUser: (report.personas.find((item) => item.core) || report.personas[0])?.name || "",
    actionSignal: report.actionSignal,
    category: profile.category,
    opportunities: report.opportunities.slice(0, 3).map((item) => item.name).join("、"),
    queryKey: [kind, input.product, input.context, keywords, sources, enabled ? "on" : "off"].join("|")
  };
}

function signalKindLabel(kind) {
  return kind === "community" ? "社区舆论" : "全网联索";
}

function signalSearchScope(kind) {
  return kind === "community" ? "社区平台" : "公开网页";
}

function signalBasisTerms(config) {
  return [
    config.category,
    config.coreUser,
    config.actionSignal,
    ...splitSignalTerms(config.opportunities, [])
  ].filter(Boolean).slice(0, 6);
}

function searchQueriesForDisplay(signal, config) {
  const queries = Array.isArray(signal.queries) && signal.queries.length
    ? signal.queries
    : [config.keywords || config.product];
  return queries.filter(Boolean).slice(0, 4);
}

function renderSearchBasisHtml(kind, signal, config) {
  const terms = signalBasisTerms(config);
  const queries = searchQueriesForDisplay(signal, config);
  const label = signalKindLabel(kind);
  const status = signal.status === "ready" ? "已执行" : signal.status === "loading" ? "检索中" : "待检索";

  return `
    <article class="signal-query-panel" aria-label="${escapeHtml(label)}检索锚点">
      <div class="signal-query-head">
        <span>${escapeHtml(signalSearchScope(kind))}检索锚点</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      <h3>${escapeHtml(config.product)}</h3>
      <p>本次${escapeHtml(label)}以完整产品名作为主锚点，并叠加品类、核心用户、首要抓手、机会点和补充关键词生成查询。</p>
      ${terms.length ? `<div class="signal-query-chips">${terms.map((term) => `<span>${escapeHtml(term)}</span>`).join("")}</div>` : ""}
      <div class="signal-query-list">
        ${queries.map((query) => `<code>${escapeHtml(query)}</code>`).join("")}
      </div>
    </article>
  `;
}

function formatSearchTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function renderSearchSkeleton(containerSelector, message, leadHtml = "") {
  const container = $(containerSelector);
  if (!container) return;
  container.innerHTML = leadHtml + Array.from({ length: 3 })
    .map(
      () => `
        <article class="signal-intel-card signal-intel-card--loading" aria-busy="true">
          <div>
            <span>${escapeHtml(message)}</span>
            <b>联网中</b>
          </div>
          <i></i>
          <i></i>
          <i></i>
        </article>
      `
    )
    .join("");
}

function searchResultStatus(result) {
  if (result.source?.includes("zhihu")) return "知乎";
  if (result.source?.includes("xiaohongshu")) return "小红书";
  if (result.source?.includes("weibo")) return "微博";
  if (result.source?.includes("bilibili")) return "B站";
  if (result.source?.includes("reddit")) return "Reddit";
  return result.engine || "搜索结果";
}

function renderOnlineSearchResults(kind) {
  const signal = state.onlineSignals[kind];
  const containerSelector = kind === "community" ? "#communityInsights" : "#webIntelInsights";
  const badgeSelector = kind === "community" ? "#communityProductBadge" : "#webIntelProductBadge";
  const container = $(containerSelector);
  const badge = $(badgeSelector);
  if (!container || !badge) return;
  const config = getSignalSearchConfig(kind);
  const basisHtml = renderSearchBasisHtml(kind, signal, config);

  if (signal.status === "loading") {
    badge.textContent = "联网检索中";
    renderSearchSkeleton(containerSelector, "正在联网检索", basisHtml);
    return;
  }

  if (signal.status === "ready" && signal.items.length) {
    const time = formatSearchTime(signal.searchedAt);
    badge.textContent = `已联网 ${signal.items.length} 条`;
    container.innerHTML = basisHtml + signal.items
      .map(
        (item, index) => `
          <article class="signal-intel-card signal-intel-card--result">
            <div>
              <span>${escapeHtml(item.source || "公开网页")}</span>
              <b>${escapeHtml(searchResultStatus(item))}</b>
            </div>
            <h3>
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
            </h3>
            <p>${escapeHtml(item.snippet || "来源页未提供可解析摘要，请打开链接核验原文。")}</p>
            <footer>
              <span>${time ? `检索于 ${time}` : "真实联网结果"}</span>
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">打开来源</a>
            </footer>
          </article>
        `
      )
      .join("");
    return;
  }

  if (signal.status === "error") {
    badge.textContent = "检索失败";
    renderInsightCards(containerSelector, [
      {
        type: "联网搜索失败",
        status: "可重试",
        title: `${signalKindLabel(kind)}没有拿到可验证来源`,
        summary: signal.error || signal.warning || "搜索源没有返回可解析结果，请稍后重试或调整关键词。",
        points:
          kind === "community"
            ? ["换成更具体的平台和痛点关键词", "减少平台数量后重新搜索", "打开浏览器确认网络可以访问目标搜索源"]
            : ["换成产品名 + 竞品 / 价格 / 评价", "缩短关键词后重新搜索", "打开浏览器确认网络可以访问搜索源"]
      }
    ], basisHtml);
    return;
  }

  renderSignalRelatedInsights(false);
}

async function searchOnlineSignals(kind, options = {}) {
  const config = getSignalSearchConfig(kind);
  const signal = state.onlineSignals[kind];
  if (!config.enabled && !options.force) {
    signal.status = "idle";
    signal.items = [];
    signal.error = "";
    renderOnlineSearchResults(kind);
    return [];
  }
  if (!options.force && signal.status === "ready" && signal.queryKey === config.queryKey && signal.items.length) {
    renderOnlineSearchResults(kind);
    return signal.items;
  }

  signal.status = "loading";
  signal.error = "";
  signal.warning = "";
  signal.queryKey = config.queryKey;
  signal.query = config.keywords || config.product;
  renderOnlineSearchResults(kind);

  const params = new URLSearchParams({
    type: kind === "community" ? "community" : "web",
    q: config.keywords || config.product,
    product: config.product,
    context: config.context,
    stage: config.stage,
    category: config.category,
    coreUser: config.coreUser,
    actionSignal: config.actionSignal,
    opportunities: config.opportunities,
    sources: config.sources,
    limit: String(searchResultLimit)
  });

  try {
    const response = await fetch(`/api/search?${params.toString()}`, {
      headers: { Accept: "application/json" }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    signal.status = payload.items?.length ? "ready" : "error";
    signal.items = Array.isArray(payload.items) ? payload.items : [];
    signal.warning = payload.warning || "";
    signal.error = payload.items?.length ? "" : payload.warning || "搜索源未返回可解析结果";
    signal.searchedAt = payload.searchedAt || new Date().toISOString();
    signal.queries = Array.isArray(payload.queries) ? payload.queries : [];
    renderOnlineSearchResults(kind);
    return signal.items;
  } catch (error) {
    signal.status = "error";
    signal.items = [];
    signal.error = error.message || "联网搜索失败";
    signal.searchedAt = new Date().toISOString();
    renderOnlineSearchResults(kind);
    return [];
  }
}

function refreshActiveOnlineSignals(options = {}) {
  const input = getFormData();
  const tasks = [];
  if (input.externalSignals.webSearch) tasks.push(searchOnlineSignals("web", options));
  if (input.externalSignals.community) tasks.push(searchOnlineSignals("community", options));
  return Promise.allSettled(tasks);
}

function signalDomainProfile(product, context) {
  const domain = inferDomain(product, context);
  const profiles = {
    ai: {
      category: "AI 基础设施",
      market: ["模型价格变化", "API 稳定性事件", "多模型路由方案", "企业 AI 应用落地案例"],
      competitors: ["OpenAI / Anthropic / Gemini / DeepSeek / Qwen 的能力更新", "聚合 API 平台的价格与额度策略", "开发者工具链的模型切换体验"],
      community: ["接口报错和限流抱怨", "账单不可控焦虑", "模型效果对比讨论", "替代供应商推荐"],
      content: ["成本实测", "稳定性压测", "模型路由教程", "迁移避坑清单"]
    },
    food: {
      category: "消费食品",
      market: ["新品口味趋势", "门店评价变化", "价格带对比", "节令营销案例"],
      competitors: ["同品类品牌上新", "包装与口味表达", "外卖平台促销策略"],
      community: ["口味复购评价", "分量与价格争议", "排队体验吐槽", "拍照分享动机"],
      content: ["口味测评", "真实试吃", "价格对比", "场景种草"]
    },
    saas: {
      category: "B2B 软件",
      market: ["同类工具融资/并购", "功能发布节奏", "企业采购案例", "安全合规要求"],
      competitors: ["头部 SaaS 的套餐变化", "竞品工作流对比", "客户迁移案例"],
      community: ["上手成本抱怨", "销售承诺与实际落差", "集成难度讨论", "替代工具推荐"],
      content: ["ROI 拆解", "迁移方案", "功能对比表", "客户成功案例"]
    },
    education: {
      category: "教育培训",
      market: ["课程价格带", "学习成果展示", "平台政策变化", "证书与就业反馈"],
      competitors: ["同类课程大纲", "讲师背书方式", "试听转化路径"],
      community: ["学习焦虑表达", "效果不确定担忧", "作业反馈体验", "退款争议"],
      content: ["学习路径", "成果案例", "试听课拆解", "避坑指南"]
    },
    general: {
      category: "通用产品",
      market: ["品类趋势", "竞品功能变化", "价格与套餐", "公开案例"],
      competitors: ["同类方案定位", "功能差异", "渠道表达", "客户评价"],
      community: ["购买顾虑", "使用阻力", "真实评价", "替代方案"],
      content: ["产品对比", "用户案例", "使用场景", "决策清单"]
    }
  };
  return profiles[domain] || profiles.general;
}

function renderInsightCardsHtml(items) {
  return items
    .map(
      (item) => `
        <article class="signal-intel-card">
          <div>
            <span>${escapeHtml(item.type)}</span>
            <b>${escapeHtml(item.status)}</b>
          </div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.summary)}</p>
          <ul>
            ${item.points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}
          </ul>
        </article>
      `
    )
    .join("");
}

function renderInsightCards(containerSelector, items, leadHtml = "") {
  const container = $(containerSelector);
  if (!container) return;
  container.innerHTML = leadHtml + renderInsightCardsHtml(items);
}

function buildSignalInsightModel(input = getFormData()) {
  const profile = signalDomainProfile(input.product, input.context);
  const report = buildReport(input);
  const webTerms = splitSignalTerms(
    $("#webSearchPageKeywordsInput")?.value || input.externalSignals.keywords,
    [input.product, profile.category, report.actionSignal].filter(Boolean)
  );
  const communityTerms = splitSignalTerms($("#communityPageSourcesInput")?.value || input.externalSignals.sources, ["小红书", "知乎", "微博", "抖音", "B站"]);
  const corePersona = report.personas.find((item) => item.core) || report.personas[0];
  const topOpportunity = report.opportunities[0];

  return { input, profile, report, webTerms, communityTerms, corePersona, topOpportunity };
}

function localSignalInsightItems(kind, model = buildSignalInsightModel()) {
  const { input, profile, report, webTerms, communityTerms, corePersona, topOpportunity } = model;
  if (kind === "web") {
    return [
      {
        type: "本地检索计划",
        status: "待联网验证",
        title: `${input.product}的品类与需求变化`,
        summary: `围绕 ${webTerms.slice(0, 3).join(" / ")} 检索公开新闻、产品页、行业材料和搜索结果，判断用户是否正在主动寻找更好的替代方案。`,
        points: profile.market.slice(0, 4)
      },
      {
        type: "竞品线索",
        status: "建议采样",
        title: `${profile.category} 竞品表达与价格动作`,
        summary: `优先观察竞品如何解释“${report.actionSignal}”，以及是否用价格、稳定性、效率或服务承诺做转化。`,
        points: profile.competitors.slice(0, 4)
      },
      {
        type: "验证清单",
        status: "可执行",
        title: `${topOpportunity.name} 的外部证据`,
        summary: `把机会点转成可检索证据，避免只停留在内部判断。建议先采样 20-40 条公开材料。`,
        points: [
          `搜索“${input.product} 替代方案 / 对比 / 价格 / 评价”`,
          `记录支持 ${corePersona.name} 购买决策的真实证据`,
          "把来源、日期、标题、URL 和可引用结论分开保存",
          "无法确认来源时标注为待验证，不写成事实"
        ]
      }
    ];
  }

  return [
    {
      type: "本地采样计划",
      status: "样本待采集",
      title: `${input.product}的高频用户表达`,
      summary: `优先在 ${communityTerms.slice(0, 5).join(" / ")} 搜索用户原话，关注抱怨、求推荐、对比和复购理由。`,
      points: profile.community.slice(0, 4)
    },
    {
      type: "情绪机会",
      status: "待验证假设",
      title: `${corePersona.name} 最可能被什么打动`,
      summary: `围绕“${report.actionSignal}”寻找真实语气：用户不是只要功能，而是要降低风险、减少麻烦或证明选择正确。`,
      points: [
        `赞美点：${topOpportunity.effect}`,
        `顾虑点：${report.emotions[0]?.insight || "价值不确定"}`,
        `转化点：把 ${topOpportunity.name} 解释成可看见的结果`,
        "内容表达要保留用户语言，不要全部改成营销口号"
      ]
    },
    {
      type: "内容选题",
      status: "可发布方向",
      title: `${input.product} 的社区内容切入`,
      summary: "把用户问题整理成可发布内容，优先做解释、对比、实测和避坑，而不是直接推销。",
      points: profile.content.slice(0, 4)
    }
  ];
}

function renderLocalSignalInsights(kind, model = buildSignalInsightModel()) {
  const { input } = model;
  const enabled = kind === "web" ? input.externalSignals.webSearch : input.externalSignals.community;
  const containerSelector = kind === "community" ? "#communityInsights" : "#webIntelInsights";
  const badgeSelector = kind === "community" ? "#communityProductBadge" : "#webIntelProductBadge";
  const badge = $(badgeSelector);
  const config = getSignalSearchConfig(kind, input);
  const signal = state.onlineSignals[kind];
  if (badge) badge.textContent = enabled ? "待联网检索" : "待开启";
  renderInsightCards(containerSelector, localSignalInsightItems(kind, model), renderSearchBasisHtml(kind, signal, config));
}

function renderSignalRelatedInsights(useOnline = true) {
  const model = buildSignalInsightModel();
  ["web", "community"].forEach((kind) => {
    const signal = state.onlineSignals[kind];
    const config = getSignalSearchConfig(kind, model.input);
    const hasCurrentOnlineState =
      useOnline &&
      signal.status !== "idle" &&
      (signal.status === "loading" || signal.queryKey === config.queryKey);
    if (hasCurrentOnlineState) {
      renderOnlineSearchResults(kind);
    } else {
      renderLocalSignalInsights(kind, model);
    }
  });
}

function getApiConfig() {
  return {
    url: clean($("#apiUrlInput").value),
    token: clean($("#apiTokenInput").value),
    model: clean($("#modelInput").value)
  };
}

function isApiConfigReady() {
  const config = getApiConfig();
  return Boolean(config.url && config.token && config.model);
}

function updateApiConfigState() {
  state.apiConfigReady = isApiConfigReady();
  $(".api-config")?.classList.toggle("ready", state.apiConfigReady);
  if ($("#configStatus")) $("#configStatus").textContent = state.apiConfigReady ? "已配置" : "未配置";
  $("#generateBtn").disabled = state.isGenerating || !state.apiConfigReady;
  renderAdmin();
}

function saveApiConfig() {
  const config = getApiConfig();
  localStorage.setItem("insightApiConfig", JSON.stringify(config));
  saveImageConfig({ silent: true });
  updateApiConfigState();
  showToast("API 配置已保存到本机");
}

function loadApiConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem("insightApiConfig") || "null");
    if (!saved) return;
    $("#apiUrlInput").value = saved.url || "";
    $("#apiTokenInput").value = saved.token || "";
    $("#modelInput").value = saved.model || "";
  } catch {
    localStorage.removeItem("insightApiConfig");
  }
}

function clearApiConfig() {
  localStorage.removeItem("insightApiConfig");
  localStorage.removeItem(imageConfigStorageKey);
  $("#apiUrlInput").value = "";
  $("#apiTokenInput").value = "";
  $("#modelInput").value = "";
  $("#imageApiUrlInput").value = "";
  $("#imageModelInput").value = "gpt-image-2";
  updateApiConfigState();
  syncImageConfigFromApi();
  showToast("API 配置已清除");
}

function inferDomain(product, context) {
  const text = `${product} ${context}`.toLowerCase();
  if (text.includes("ai") || text.includes("模型") || text.includes("api") || text.includes("大模型")) return "ai";
  if (text.includes("餐") || text.includes("咖啡") || text.includes("茶") || text.includes("食品")) return "food";
  if (text.includes("saas") || text.includes("crm") || text.includes("b2b")) return "saas";
  if (text.includes("课") || text.includes("教育") || text.includes("培训")) return "education";
  return "general";
}

function domainLabel(domain) {
  return {
    ai: "AI / 模型基础设施",
    food: "餐饮食品",
    saas: "SaaS / B2B",
    education: "教育培训",
    general: "通用产品"
  }[domain];
}

function buildReport(input) {
  const domain = inferDomain(input.product, input.context);
  const packs = {
    ai: buildAiReport,
    food: buildFoodReport,
    saas: buildSaasReport,
    education: buildEducationReport,
    general: buildGeneralReport
  };
  return packs[domain](input);
}

function buildAiReport(input) {
  return {
    input,
    coreSignal: "API 消耗大户",
    actionSignal: "成本与稳定",
    personas: [
      persona("A", "模型焦虑型技术负责人", "每天关注模型更新、价格和接口稳定性，害怕团队把技术路线押在一个会涨价、限流或能力掉队的供应商身上。", "新项目选型、AI中台建设、供应商替换。", "客单价高、决策慢，但一旦进入生产系统，粘性很强。"),
      persona("B", "成本敏感型 API 消耗大户", "每天盯 token 消耗、失败率和账单，同一个任务会反复测试哪个模型够用又便宜。", "内容生成、客服机器人、批量摘要、应用后端调用。", "高频复购、付费稳定、对省钱和稳定最敏感。", true),
      persona("C", "业务提效型运营团队", "不关心参数，只想知道哪个模型更会写文案、做表格、整理客户资料。", "销售话术、短视频脚本、客服回复、日报周报。", "人数多、传播快，但容易被免费工具分流。"),
      persona("D", "AI工具囤积型个人玩家", "同时试用多个模型和镜像站，喜欢尝鲜，常常寻找低价渠道和最新能力。", "写作、翻译、学习、代码、图片生成。", "拉新强，忠诚度低，价格弹性大。")
    ],
    emotions: emotionSet(
      "成本敏感型 API 消耗大户",
      "业务跑着跑着突然贵了、慢了、挂了，账单和失败率在无人值守时悄悄失控。",
      "每一次 429、超时和账单暴涨，都像是在吞掉利润。",
      "他们希望自己不是追热点的人，而是懂模型、会控成本、能把 AI 真正跑进生产的人。",
      "真正会用 AI 的团队，不迷信模型，只管理结果。",
      "同样任务成本下降，失败自动切备用模型，后台曲线从焦虑变成可控。",
      "模型可以换，业务不能停。"
    ),
    opportunities: [
      opportunity("P0", "智能路由成本引擎", "按任务类型、价格、速度、成功率自动选择模型，提供省钱、质量、速度、稳定四种策略。", "降低成本失控恐惧", "中", "中", "把平台从模型超市升级成调度系统。"),
      opportunity("P0", "统一账单与异常预警", "按项目、成员、模型拆账，支持预算上限、余额不足、异常消耗提醒。", "避免账单突然爆炸", "低到中", "中", "让用户每天都需要打开后台管理。"),
      opportunity("P0", "故障兜底与自动降级", "主模型限流、超时、余额不足时自动切换备用模型，并记录切换原因。", "业务不能停", "中", "中", "成为生产环境可信赖的基础设施。"),
      opportunity("P1", "模型效果对比实验室", "同一 prompt 一键跑多个模型，对比质量、价格、速度，沉淀测试集。", "专业选型与掌控感", "中", "中", "增强技术负责人和开发者的专业认同。"),
      opportunity("P2", "模型更新雷达", "持续追踪新模型、价格、上下文长度和能力变化，生成迁移建议。", "比别人更懂趋势", "低", "易", "提升回访和内容传播。")
    ]
  };
}

function buildFoodReport(input) {
  return genericByTheme(input, "高频复购人群", "口味记忆", "餐饮食品");
}

function buildSaasReport(input) {
  return genericByTheme(input, "效率负责人与一线执行者", "风险可控", "SaaS/B2B");
}

function buildEducationReport(input) {
  return genericByTheme(input, "目标明确的学习焦虑者", "可见进步", "教育培训");
}

function buildGeneralReport(input) {
  return genericByTheme(input, "高频刚需用户", "确定性收益", "通用产品");
}

function genericByTheme(input, coreUser, trigger, category) {
  return {
    input,
    coreSignal: coreUser,
    actionSignal: trigger,
    personas: [
      persona("A", "刚需问题解决者", `遇到明确问题时主动寻找${input.product}，不想听概念，只关心能否马上解决。`, "问题爆发、时间紧、需要快速见效。", "转化效率高，但会用结果检验承诺。", true),
      persona("B", "谨慎比较型决策者", "会收集多个方案，对价格、口碑、风险和售后反复比较。", "采购前、换方案前、预算审批前。", "决策慢，但一旦信任会长期留存。"),
      persona("C", "身份表达型尝鲜者", "愿意尝试新产品，也会把选择当作自己的品味、效率或专业度信号。", "社交分享、团队展示、个人升级。", "传播力强，适合制造话题和案例。"),
      persona("D", "低成本替代寻找者", "现有方案太贵、太慢或太麻烦，希望找到更轻、更便宜的替代品。", "预算收紧、原工具不好用、团队扩张。", "价格敏感，但规模化潜力好。")
    ],
    emotions: emotionSet(
      coreUser,
      `最怕${input.product}说得漂亮，真正用起来却增加麻烦，甚至把原本可控的事情变复杂。`,
      "用户不是害怕花钱，而是害怕花了钱还要继续忍。",
      `选择${input.product}是在表达一种判断力：我知道更聪明、更高效、更可控的做法。`,
      `别再用老办法硬扛，把${trigger}变成每天都能看见的结果。`,
      "第一次发现原本费劲的任务被顺畅完成，用户会立刻产生继续使用的冲动。",
      "好产品不是让人惊呼，而是让人不想回到过去。"
    ),
    opportunities: [
      opportunity("P0", `${trigger}看板`, `把${category}用户最在意的收益做成可量化看板，让价值每天可见。`, "害怕效果不可证", "低到中", "中", "提升付费转化和续费理由。"),
      opportunity("P0", "新手首单成功路径", "把第一次使用拆成三步完成，并用默认模板降低决策成本。", "害怕不会用", "低", "易", "提高激活率。"),
      opportunity("P1", "场景化方案包", "按典型行业或任务提供预设流程、模板、报价和案例。", "希望少走弯路", "中", "中", "降低销售解释成本。"),
      opportunity("P1", "对比迁移工具", "帮助用户从旧方案迁移，并展示时间、成本或效果差异。", "替代旧方案的确定性", "中", "中", "强化差异化定位。"),
      opportunity("P2", "用户案例生成器", "把客户使用过程沉淀成可分享的案例卡片。", "身份表达与传播", "低", "易", "带来自传播和销售素材。")
    ]
  };
}

function persona(code, name, behavior, scene, value, core = false) {
  return { code, name, behavior, scene, value, core };
}

function emotionSet(user, pain, painCopy, itch, itchCopy, delight, delightCopy) {
  return [
    { type: "痛点", color: "rose", title: `怕失控的 ${user}`, insight: pain, copy: painCopy },
    { type: "痒点", color: "blue", title: "专业感与掌控感", insight: itch, copy: itchCopy },
    { type: "爽点", color: "amber", title: "结果被看见的一刻", insight: delight, copy: delightCopy }
  ];
}

function opportunity(priority, name, implementation, emotion, cost, difficulty, effect) {
  return { priority, name, implementation, emotion, cost, difficulty, effect };
}

function renderReport(report) {
  state.report = report;
  const { product, stage, focus, intelligence } = report.input;
  const signals = report.input.externalSignals || {};
  const signalModes = externalSignalModes(signals);
  $("#reportKicker").textContent = `${stage} / ${focusLabels[focus]} / ${intelligenceLabels[intelligence]}`;
  $("#reportTitle").textContent = product;
  $("#coreSignal").textContent = report.coreSignal;
  $("#actionSignal").textContent = report.actionSignal;
  $("#signalMode").textContent = signalModes.length ? signalModes.join(" + ") : "本地洞察";
  $("#signalScope").textContent = externalSignalScope(report);

  renderReportSignature(report);
  renderPersonas(report);
  renderEmotions(report);
  renderOpportunities(report);
  renderExternalSignals(report);
  applyFocus(report.input.focus);
}

function renderReportSignature(report) {
  const signals = report.input.externalSignals || {};
  const items = [
    "Strategic intelligence",
    "Boardroom-ready",
    signals.webSearch ? "Web-linked" : null,
    signals.community ? "Community pulse" : null,
    hasExternalSignals(signals) ? null : "Local draft"
  ].filter(Boolean);

  $("#reportSignature").innerHTML = items.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
}

function renderPersonas(report) {
  $("#personasSection").innerHTML = `
    <div class="local-table-wrap">
      <table class="local-report-table">
        <thead>
          <tr>
            <th>类型</th>
            <th>用户名称</th>
            <th>行为特征</th>
            <th>使用场景</th>
            <th>价值判断</th>
          </tr>
        </thead>
        <tbody>
          ${report.personas
            .map(
              (item) => `
                <tr class="${item.core ? "core-row" : ""}">
                  <td>${item.code} / ${item.core ? "核心" : "潜在"}</td>
                  <td><strong>${item.name}</strong></td>
                  <td>${item.behavior}</td>
                  <td>${item.scene}</td>
                  <td>${item.value}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderEmotions(report) {
  $("#emotionsSection").innerHTML = `
    <div class="section-grid compact-grid">
      ${report.emotions
        .map(
          (item) => `
            <article class="insight-card">
              <div class="card-meta">
                <span>${item.type}</span>
                <span>${report.coreSignal}</span>
              </div>
              <h3>${item.title}</h3>
              <p>${item.insight}</p>
              <p><strong>可用表达：</strong>${item.copy}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderOpportunities(report) {
  $("#opportunitiesSection").innerHTML = `
    <div class="local-table-wrap">
      <table class="local-report-table">
        <thead>
          <tr>
            <th>优先级</th>
            <th>产品方向</th>
            <th>具体实施</th>
            <th>情绪需求</th>
            <th>成本/难度</th>
            <th>预期效果</th>
          </tr>
        </thead>
        <tbody>
          ${report.opportunities
            .map(
              (item) => `
                <tr class="${item.priority === "P0" ? "core-row" : ""}">
                  <td>${item.priority}</td>
                  <td><strong>${item.name}</strong></td>
                  <td>${item.implementation}</td>
                  <td>${item.emotion}</td>
                  <td>${item.cost} / ${item.difficulty}</td>
                  <td>${item.effect}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderExternalSignals(report) {
  const signals = report.input.externalSignals || {};
  const modes = externalSignalModes(signals);
  const keywords = signals.keywords || `${report.input.product}, ${report.coreSignal}, ${report.actionSignal}`;
  const sources = signals.sources || "知乎、小红书、微博、B站、Reddit、产品评论区、开发者社区";
  const webCount = state.onlineSignals.web.items.length;
  const communityCount = state.onlineSignals.community.items.length;
  const rows = [
    {
      source: "公开网页",
      enabled: signals.webSearch,
      scope: keywords,
      output: webCount ? `已通过本机代理采集 ${webCount} 条真实网页来源` : "新闻、产品页、竞品定位、价格、案例、评论中的重复信号",
      rule: webCount ? "AI 报告会收到标题、URL、摘要和来源域名" : "只有真实检索到标题或 URL 才能列为证据"
    },
    {
      source: "社区舆论",
      enabled: signals.community,
      scope: sources,
      output: communityCount ? `已通过本机代理采集 ${communityCount} 条社区搜索结果` : "抱怨、赞美、黑话、购买阻力、替代方案、情绪强度",
      rule: communityCount ? "AI 报告会优先基于真实来源判断舆论信号" : "没有真实样本时必须标注为社区舆情假设"
    },
    {
      source: "证据清单",
      enabled: hasExternalSignals(signals),
      scope: "模型可访问的外部资料与用户输入上下文",
      output: "来源、信号、可信度、对产品决策的含义",
      rule: "禁止编造链接、日期、数据和引用"
    }
  ];

  $("#signalsSection").innerHTML = `
    <div class="signal-overview">
      <article class="signal-brief">
        <div class="card-meta">
          <span>外部信号</span>
          <span>${modes.length ? modes.join(" / ") : "未启用"}</span>
        </div>
        <h3>${modes.length ? "生成报告前会先通过本机代理采集真实搜索结果" : "当前报告仅使用本地结构化洞察"}</h3>
        <p>${modes.length ? "工作台会把可解析的来源标题、URL、摘要和来源域名写入 AI 提示词；如果搜索失败，报告必须明确标注联网数据待验证。" : "未启用外部信号时，报告不会使用联网搜索结果。"}</p>
      </article>

      <div class="signal-plan-grid">
        <article class="signal-mini-card ${signals.webSearch ? "active" : ""}">
          <span>全网联索</span>
          <strong>${signals.webSearch ? "已启用" : "未启用"}</strong>
          <p>${signals.webSearch ? "要求模型综合公开网页、新闻、产品页、竞品信息、价格、案例和评论。" : "不会要求模型额外检索公开网页。"}</p>
        </article>
        <article class="signal-mini-card ${signals.community ? "active" : ""}">
          <span>社区舆论</span>
          <strong>${signals.community ? "已启用" : "未启用"}</strong>
          <p>${signals.community ? "要求模型分析社区抱怨、赞美、黑话、替代方案和购买阻力。" : "不会要求模型额外判断社区情绪。"}</p>
        </article>
        <article class="signal-mini-card">
          <span>采样范围</span>
          <strong>${escapeHtml(externalSignalScope(report))}</strong>
          <p>建议关键词和平台越具体，AI 越容易区分真实证据、弱信号和待验证假设。</p>
        </article>
      </div>

      <div class="local-table-wrap signal-table-wrap">
        <table class="local-report-table signal-table">
          <thead>
            <tr>
              <th>信号源</th>
              <th>状态</th>
              <th>采样范围</th>
              <th>AI 应返回</th>
              <th>验证边界</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr class="${row.enabled ? "core-row" : ""}">
                    <td><strong>${row.source}</strong></td>
                    <td>${row.enabled ? "启用" : "未启用"}</td>
                    <td>${escapeHtml(row.scope)}</td>
                    <td>${row.output}</td>
                    <td>${row.rule}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function applyFocus(focus) {
  const firstSection = focus === "emotion" ? "emotions" : focus === "opportunity" ? "opportunities" : "personas";
  setActiveSection(firstSection);
}

function setActiveSection(section, options = {}) {
  state.activeSection = section;
  $$(".report-tabs button").forEach((button) => {
    const active = button.dataset.section === section;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$(".report-section").forEach((panel) => {
    const active = panel.dataset.reportSection === section;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });

  if (options.scroll) {
    const body = $(".report-body");
    if (body) body.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  }
}

function normalizeChatUrl(url) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function normalizeImageUrl(url) {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/images/generations")) return trimmed;
  if (trimmed.endsWith("/chat/completions")) return trimmed.replace(/\/chat\/completions$/, "/images/generations");
  return `${trimmed}/images/generations`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function slugifyHeading(value, index) {
  return `section-${index}-${value.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)}`;
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function buildExternalEvidenceBlock() {
  const groups = [
    ["web", "全网联索"],
    ["community", "社区舆论"]
  ];
  const lines = ["## 本机联网搜索证据"];
  let hasEvidence = false;

  groups.forEach(([kind, label]) => {
    const signal = state.onlineSignals[kind];
    const config = getSignalSearchConfig(kind);
    const enabled = kind === "web" ? config.enabled : config.enabled;
    if (!enabled) {
      lines.push(`### ${label}`, "未启用。", "");
      return;
    }
    lines.push(`### ${label}`);
    if (signal.items.length) {
      hasEvidence = true;
      lines.push(`检索时间：${signal.searchedAt || "未知"}；检索词：${signal.query || config.keywords || config.product}`);
      signal.items.slice(0, searchResultLimit).forEach((item, index) => {
        lines.push(
          `${index + 1}. 标题：${item.title}`,
          `   来源：${item.source || "未知来源"} / ${item.engine || "搜索引擎"}`,
          `   URL：${item.url}`,
          `   摘要：${item.snippet || "来源页未提供可解析摘要"}`
        );
      });
    } else if (signal.error || signal.warning) {
      lines.push(`联网搜索失败或无可解析结果：${signal.error || signal.warning}`);
      lines.push("报告中不得把该部分写成事实，只能列为待验证假设。");
    } else {
      lines.push("尚未采集到真实搜索结果。报告中不得把该部分写成事实，只能列为待验证假设。");
    }
    lines.push("");
  });

  if (!hasEvidence) {
    lines.push("当前没有可引用的真实外部来源。请在报告中明确标注外部信号待验证。");
  }
  return lines.join("\n");
}

async function prepareExternalSignalsForReport(report) {
  const signals = report.input.externalSignals || {};
  if (!hasExternalSignals(signals)) return;
  updateStreamIndicator("正在联网采集外部信号，完成后会继续调用模型");

  const tasks = [];
  if (signals.webSearch) tasks.push(searchOnlineSignals("web"));
  if (signals.community) tasks.push(searchOnlineSignals("community"));
  await Promise.allSettled(tasks);
  state.generationPhase = "model";
  state.lastDeltaAt = Date.now();

  const webCount = state.onlineSignals.web.items.length;
  const communityCount = state.onlineSignals.community.items.length;
  const parts = [];
  if (signals.webSearch) parts.push(`全网 ${webCount} 条`);
  if (signals.community) parts.push(`社区 ${communityCount} 条`);
  updateStreamIndicator(`外部信号采集完成：${parts.join("，")}；正在连接模型`);
  renderExternalSignals(report);
}

function buildReportToc(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line, index) => {
      const level = line.match(/^#+/)[0].length;
      const title = line.replace(/^#{1,3}\s+/, "");
      return { level, title, id: slugifyHeading(title, index) };
    });
}

function buildTocTree(toc) {
  const tree = [];
  let current = null;
  toc.forEach((item) => {
    if (item.level <= 1 || !current) {
      current = { ...item, children: [] };
      tree.push(current);
    } else {
      current.children.push(item);
    }
  });
  return tree;
}

function renderFloatingToc(toc) {
  state.currentToc = toc;
  const existing = $("#floatingToc");
  if (existing) existing.remove();
  $("#aiSection").classList.remove("with-report-toc");
  if (!toc.length) return;
  const tree = buildTocTree(toc);

  const nav = document.createElement("nav");
  nav.id = "floatingToc";
  nav.className = "floating-toc";
  nav.setAttribute("aria-label", "报告快速定位");
  nav.innerHTML = `
    <div class="toc-shell">
      <div class="toc-header">
        <span>报告目录</span>
        <button class="toc-collapse-btn" type="button" aria-label="折叠目录" aria-expanded="true">收起</button>
      </div>
      <div class="floating-toc-groups">
        ${tree
        .map(
          (item, index) => `
            <details class="toc-group" ${index === 0 ? "open" : ""}>
              <summary>
                <a href="#${item.id}">${escapeHtml(item.title)}</a>
              </summary>
              ${
                item.children.length
                  ? `<div class="toc-children">
                      ${item.children
                        .map(
                          (child) => `
                            <a class="toc-level-${child.level}" href="#${child.id}">
                              ${escapeHtml(child.title)}
                            </a>
                          `
                        )
                        .join("")}
                    </div>`
                  : ""
              }
            </details>
          `
        )
        .join("")}
      </div>
    </div>
  `;
  $("#aiSection").appendChild(nav);
  $("#aiSection").classList.add("with-report-toc");
  nav.querySelectorAll(".toc-group > summary a").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });
  setupFloatingTocCollapse(nav);
}

function setupFloatingTocCollapse(nav) {
  const button = nav.querySelector(".toc-collapse-btn");
  const syncButton = () => {
    const collapsed = nav.classList.contains("collapsed");
    button.textContent = collapsed ? "目录" : "收起";
    button.setAttribute("aria-label", collapsed ? "展开目录" : "折叠目录");
    button.setAttribute("aria-expanded", String(!collapsed));
  };
  syncButton();
  button.addEventListener("click", () => {
    nav.classList.toggle("collapsed");
    syncButton();
  });
}

function highlightReportText(html) {
  if (!state.highlightEnabled) return html;
  const phrases = state.highlightPhrases.filter((phrase) => phrase && phrase.length >= 2).slice(0, 24);
  return phrases.reduce((current, phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return current.replace(new RegExp(`(${escaped})`, "g"), '<mark class="insight-highlight">$1</mark>');
  }, html);
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let headingIndex = 0;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    if (line.includes("|") && lines[i + 1] && isTableDivider(lines[i + 1])) {
      closeList();
      const headers = parseTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim()) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      html.push('<div class="table-scroll"><table><thead><tr>');
      html.push(headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join(""));
      html.push("</tr></thead><tbody>");
      rows.forEach((row) => {
        html.push("<tr>");
        html.push(row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join(""));
        html.push("</tr>");
      });
      html.push("</tbody></table></div>");
      continue;
    }

    if (line.startsWith("### ")) {
      closeList();
      const title = line.slice(4);
      html.push(`<h4 id="${slugifyHeading(title, headingIndex)}">${inlineMarkdown(title)}</h4>`);
      headingIndex += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      closeList();
      const title = line.slice(3);
      html.push(`<h3 id="${slugifyHeading(title, headingIndex)}">${inlineMarkdown(title)}</h3>`);
      headingIndex += 1;
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      const title = line.slice(2);
      html.push(`<h2 id="${slugifyHeading(title, headingIndex)}">${inlineMarkdown(title)}</h2>`);
      headingIndex += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  return highlightReportText(html.join(""));
}

function buildDynamicReportShape(report, domain, mode) {
  const stage = report.input.stage;
  const corePersona = report.personas.find((item) => item.core) || report.personas[0];
  const product = report.input.product;
  const signal = report.actionSignal;
  const mature = stage.includes("成熟") || stage.includes("已经");
  const modeLens = {
    concise: "只保留判断、证据、动作三个层级。",
    strategic: "强化定位选择、竞争解释和增长优先级。",
    operator: "强化负责人视角、执行顺序、指标和低成本实验。",
    investor: "强化市场结构、增长杠杆、护城河、风险和关键假设。"
  }[mode];
  const shapes = {
    ai: mature
      ? [
          `# ${product}：从模型入口转向生产级基础设施`,
          `## ${corePersona.name}为什么会为“${signal}”持续付费`,
          "## 真实增长瓶颈：成本焦虑、稳定性和迁移风险",
          "## 能拉开差距的能力组合：路由、账单、兜底和对比实验",
          "## 开发者转化路径：从试用调用到团队级用量",
          "## 外部信号与竞品叙事如何反向校准定位",
          "## 下一轮验证：用哪些数据证明平台值得续费"
        ]
      : [
          `# ${product}：先验证哪类开发者真的愿意接入`,
          "## 最小可信入口：解决单模型依赖还是账单不可控",
          "## 首批用户应来自哪些高频调用场景",
          "## MVP 不该做成模型超市，而要做成可控调用链",
          "## 定价假设：按调用、省钱效果还是团队管理收费",
          "## 7-14 天验证实验：样例应用、迁移脚本和成本对比"
        ],
    food: mature
      ? [
          `# ${product}：复购来自哪一个场景记忆`,
          "## 核心人群的购买触发：口味、价格还是社交表达",
          "## 门店/渠道体验里最影响复购的细节",
          "## 内容种草应该讲测评、场景还是身份感",
          "## 价格带与竞品表达：哪些承诺不能乱说",
          "## 下一轮增长实验：上新、套餐、评价和私域复购"
        ]
      : [
          `# ${product}：先证明用户愿意为哪种体验买单`,
          "## 首批场景：早餐、下午茶、聚会还是礼赠",
          "## 口味与包装的最低成本验证",
          "## 定价和试吃反馈如何决定首发 SKU",
          "## 内容表达先抓哪类真实评价",
          "## 小规模验证后的扩张条件"
        ],
    saas: mature
      ? [
          `# ${product}：从功能售卖转向组织级效率承诺`,
          "## 谁真正拥有预算，谁每天承受使用成本",
          "## 留存阻力：上手、集成、协作还是效果不可证",
          "## 差异化不在功能数量，而在工作流闭环",
          "## 价格、权限和服务如何支撑续费",
          "## 销售与客户成功接下来要验证的信号"
        ]
      : [
          `# ${product}：先找到最痛的单一工作流`,
          "## 早期用户不是所有团队，而是一个高压岗位",
          "## MVP 要减少哪一步重复劳动",
          "## 试用转付费的最短证据链",
          "## 定价前必须验证的组织价值",
          "## 两周内能跑完的获客与留存实验"
        ],
    education: mature
      ? [
          `# ${product}：增长来自可见进步而不是课程堆叠`,
          "## 学员真正购买的是结果确定性",
          "## 信任建立：师资、反馈、案例还是陪跑",
          "## 续费与转介绍的关键体验节点",
          "## 内容获客应呈现学习路径还是成果证据",
          "## 下一轮验证：完课、作业反馈和口碑样本"
        ]
      : [
          `# ${product}：先证明学习结果可以被看见`,
          "## 首批学员的焦虑和目标边界",
          "## 最小课程包与反馈机制",
          "## 试听转化要验证哪一个承诺",
          "## 价格与服务深度如何匹配",
          "## 第一批案例应该怎样沉淀"
        ],
    general: mature
      ? [
          `# ${product}：成熟阶段的增长不该再靠泛泛卖点`,
          "## 核心用户为什么现在还会换方案",
          "## 复购或留存的真实阻力",
          "## 能形成差异的产品抓手",
          "## 渠道与内容如何证明价值",
          "## 下一轮验证：优先级、指标和风险边界"
        ]
      : [
          `# ${product}：先找到最愿意行动的一类用户`,
          "## 需求是否足够急迫",
          "## 最小可交付方案是什么",
          "## 价格与信任如何被验证",
          "## 首批转化渠道和内容表达",
          "## 下一步实验和放弃条件"
        ]
  };
  return [...(shapes[domain] || shapes.general), `## 模式要求：${modeLens}`].join("\n");
}

function buildAiInputContext(report) {
  return JSON.stringify(
    {
      product: report.input.product,
      stage: report.input.stage,
      focus: focusLabels[report.input.focus],
      intelligence: intelligenceLabels[report.input.intelligence],
      coreUserSignal: report.coreSignal,
      primaryConversionSignal: report.actionSignal,
      userSegments: report.personas.map((item) => ({
        code: item.code,
        name: item.name,
        isCore: item.core,
        behavior: item.behavior,
        scene: item.scene,
        value: item.value
      })),
      emotionalDrivers: report.emotions.map((item) => ({
        type: item.type,
        title: item.title,
        insight: item.insight,
        usableCopy: item.copy
      })),
      opportunityCandidates: report.opportunities.map((item) => ({
        priority: item.priority,
        name: item.name,
        implementation: item.implementation,
        emotionalNeed: item.emotion,
        cost: item.cost,
        difficulty: item.difficulty,
        expectedEffect: item.effect
      }))
    },
    null,
    2
  );
}

function buildAiPrompt(report) {
  const domain = inferDomain(report.input.product, report.input.context);
  const mode = report.input.intelligence;
  const signals = report.input.externalSignals || {};
  const evidenceBlock = buildExternalEvidenceBlock();
  const reportShape = buildDynamicReportShape(report, domain, mode);
  const modeBrief = {
    concise: "输出要短而锋利，适合 3 分钟读完。只保留最重要判断、最大风险和 3 个动作。",
    strategic: "输出要像高级产品策略顾问的正式报告，重视定位、用户动机、机会优先级和验证路径。",
    operator: "输出要偏执行，给出具体动作、负责人视角、两周计划、指标和低成本实验。",
    investor: "输出要偏投资人/董事会视角，强调市场结构、增长杠杆、护城河、风险与关键假设。"
  }[mode];

  return [
    "你是资深产品策略顾问、用户研究负责人和增长负责人三者合一。",
    "请基于以下结构化洞察，输出一份中文 Markdown 深度报告。",
    "这不是模板填空任务。请先判断产品所处行业、成熟阶段、增长瓶颈、购买链路和证据密度，再设计报告目录。",
    "",
    `产品：${report.input.product}`,
    `阶段：${report.input.stage}`,
    `行业判断：${domainLabel(domain)}`,
    `分析侧重：${focusLabels[report.input.focus]}`,
    `智能模式：${intelligenceLabels[mode]}。${modeBrief}`,
    report.input.context ? `补充上下文：${report.input.context}` : "补充上下文：无",
    `是否启用全网联索：${signals.webSearch ? "是" : "否"}`,
    `是否启用社区舆论：${signals.community ? "是" : "否"}`,
    signals.keywords ? `检索关键词：${signals.keywords}` : "检索关键词：未提供",
    signals.sources ? `社区平台：${signals.sources}` : "社区平台：未指定",
    "",
    "目录生成规则：",
    "1. 每份报告必须拥有贴合该产品的专属目录，一级标题不得照搬固定模板。",
    "2. 一级标题控制在 5-7 个；标题必须具体到产品对象、业务问题或增长场景，例如“模型路由为什么是付费抓手”，而不是“用户画像”“产品机会”“行动计划”这类泛标题。",
    "3. 不要每次都使用相同章节顺序；可以根据产品真实问题重排为：定位切口、需求证据、转化阻力、功能抓手、定价/渠道、验证实验、风险边界等不同组合。",
    "4. 如果是成熟产品，目录要更偏复购、增长、留存、差异化和运营效率；如果是早期产品，目录要更偏需求验证、MVP、首批用户和定价假设。",
    "5. 如果产品是 AI/API/开发者工具，目录要体现技术信任、成本控制、集成门槛、稳定性、开发者转化；不要写成通用消费品报告。",
    "6. 如果产品是餐饮/消费品，目录要体现场景、口味/体验、价格带、复购、渠道和内容种草；不要写成 B2B 软件报告。",
    "7. 如果产品是教育/服务，目录要体现信任建立、结果可见、交付体验、续费和口碑证据。",
    "8. 允许使用 2-4 个表格，但表格名称和字段也必须随产品变化；不要把所有产品都写成同一张优先级表。",
    "9. 目录里的每个标题都要能回答“为什么这个产品需要这一章”，不需要为了凑完整而写无关章节。",
    "",
    "本次建议的报告骨架参考，不要机械照抄；请按产品实际情况改写标题：",
    reportShape,
    "",
    "输出要求：",
    "1. 开头先给出一句最重要的战略判断，不超过 45 字，但标题不要固定叫“执行摘要”。",
    "2. 必须明确谁是核心用户、为什么现在值得做、最大风险是什么，但可以融入更贴合产品的章节中。",
    "3. 不要只重复输入内容，要提出新的推理、反证和优先级。",
    "4. 至少提出 2 条反直觉判断，但章节名必须结合产品语境，不要固定叫“反直觉洞察”。",
    "5. 至少提出 5 条验证假设，每条配一个最低成本验证动作；章节名和表格字段需要贴合产品。",
    "6. 必须给出下一步动作，但不要固定写成“未来 14 天行动计划”；可以按冲刺、实验、发布、销售跟进或内容节奏组织。",
    "7. 必须写清楚哪些事情不该做，但标题要贴合该产品的浪费风险，不要固定叫“不要做什么”。",
    "8. 使用专业、克制、可交付的语气，避免泛泛的营销口号。",
    "9. 控制阅读密度：不要输出大段竖向长文，每个段落最多 3 行。",
    "10. 只在比较、优先级、计划、假设、风险这些场景使用 Markdown 表格；不要把所有内容都表格化。",
    "11. 建议包含 2-4 个表格，其余用短段落和短列表保持节奏。",
    "12. 如果下方提供了“本机联网搜索证据”，必须优先基于这些真实来源做外部信号分析，并在证据清单中保留来源标题和 URL。",
    "13. 如果某个外部信号没有真实搜索结果，必须明确标注“联网数据待验证”，只能给出待验证假设和检索计划；不要伪造标题、URL、日期、数据或引用。",
    "14. 如果启用了社区舆论，分析真实社区搜索结果中的抱怨、赞美、黑话、反复出现的购买阻力、替代方案和情绪强度。",
    "15. 如果没有真实社区样本，必须标注为“社区舆情假设”，并给出需要采样的平台、关键词、样本量建议和判断标准。",
    "16. 外部信号部分请单独输出：全网信号摘要、社区舆论摘要、可验证证据清单、待进一步检索的问题。证据清单可以用表格，但只列真实可验证的来源。",
    "",
    evidenceBlock,
    "",
    "结构化输入数据如下。注意：这只是分析素材，不是输出目录，不要照搬字段名作为报告标题。",
    buildAiInputContext(report)
  ].join("\n");
}

function renderAiReport(status, content) {
  const statusText = {
    empty: "等待生成",
    loading: "生成中",
    streaming: "流式接收",
    partial: "部分完成",
    ready: "已生成",
    error: "生成失败"
  }[status];
  const title =
    status === "ready"
      ? "AI 深度报告"
      : status === "loading"
        ? "正在连接模型"
        : status === "streaming"
          ? "正在流式生成报告"
          : status === "partial"
            ? "已生成部分报告"
            : status === "error"
              ? "AI 报告生成失败"
              : "配置 API 后生成深度报告";
  const toc = buildReportToc(content);
  const contentHtml =
    status === "ready" || status === "streaming" || status === "partial"
      ? markdownToHtml(content)
      : `<p>${escapeHtml(content)}</p>`;
  $("#aiSection").innerHTML = `
    <article class="ai-report ${status}">
      <div class="card-meta">
        <span>AI 报告</span>
        <span data-ai-status>${statusText}</span>
      </div>
      ${status === "loading" || status === "streaming" ? `
        <div class="stream-indicator" id="streamIndicator">
          <i aria-hidden="true"></i>
          <span>${status === "streaming" ? `正在接收内容，已收到 ${state.receivedChars} 字` : "已发送请求，等待模型开始输出"}</span>
        </div>
      ` : ""}
      <h3 data-ai-title>${title}</h3>
      <div class="ai-report-content">${contentHtml}</div>
    </article>
  `;
  if (status === "ready" || status === "partial") {
    renderFloatingToc(toc);
  } else {
    renderFloatingToc([]);
  }
}

function renderStableStreamingReport(content) {
  const article = $("#aiSection .ai-report");
  if (!article || (!article.classList.contains("loading") && !article.classList.contains("streaming"))) {
    renderAiReport("streaming", content);
    return;
  }

  article.className = "ai-report streaming";
  const status = article.querySelector("[data-ai-status]");
  const title = article.querySelector("[data-ai-title]");
  const reportContent = article.querySelector(".ai-report-content");
  if (status) status.textContent = "流式接收";
  if (title) title.textContent = "正在流式生成报告";
  if (reportContent) reportContent.innerHTML = markdownToHtml(content);
  updateStreamIndicator(`正在接收内容，已收到 ${state.receivedChars} 字`);
}

function scheduleStreamingRender(content) {
  state.pendingStreamContent = content;
  const now = Date.now();
  const renderNow = () => {
    state.lastStreamRenderAt = Date.now();
    renderStableStreamingReport(state.pendingStreamContent);
    state.streamRenderTimer = null;
  };

  if (!state.streamRenderTimer && now - state.lastStreamRenderAt > 700) {
    renderNow();
    return;
  }

  if (!state.streamRenderTimer) {
    state.streamRenderTimer = setTimeout(renderNow, 700);
  }
}

function flushStreamingRender(status = "streaming", content = state.pendingStreamContent) {
  clearTimeout(state.streamRenderTimer);
  state.streamRenderTimer = null;
  state.pendingStreamContent = "";
  state.lastStreamRenderAt = Date.now();
  renderAiReport(status, content);
}

function updateStreamIndicator(message) {
  const indicator = $("#streamIndicator span");
  if (indicator) indicator.textContent = message;
}

function startGenerationStatus() {
  state.generationStartedAt = Date.now();
  state.lastDeltaAt = Date.now();
  state.receivedChars = 0;
  state.streamStalled = false;
  state.streamEndedByStall = false;
  state.generationPhase = "search";
  clearInterval(state.generationTimer);
  state.generationTimer = setInterval(() => {
    if (!state.generationStartedAt) return;
    const seconds = Math.max(1, Math.round((Date.now() - state.generationStartedAt) / 1000));
    const idleSeconds = Math.max(0, Math.round((Date.now() - state.lastDeltaAt) / 1000));
    if (state.generationPhase === "search") {
      updateStreamIndicator(`正在联网采集外部信号，用时 ${seconds}s`);
    } else if (state.receivedChars > 0) {
      if (idleSeconds >= 8) {
        state.streamStalled = true;
        updateStreamIndicator(`已收到 ${state.receivedChars} 字，${idleSeconds}s 没有新内容，仍在等待模型继续输出`);
      } else {
        updateStreamIndicator(`正在接收流式内容，已收到 ${state.receivedChars} 字，用时 ${seconds}s`);
      }
    } else {
      updateStreamIndicator(`已连接后台，等待模型首段输出，用时 ${seconds}s`);
    }
  }, 1000);
}

function stopGenerationStatus() {
  clearInterval(state.generationTimer);
  state.generationTimer = null;
  state.generationStartedAt = 0;
  state.generationPhase = "idle";
}

function setGeneratingState(isGenerating) {
  state.isGenerating = isGenerating;
  $("#generateBtn").disabled = isGenerating || !state.apiConfigReady;
  $("#generateBtn").classList.toggle("loading", isGenerating);
  $("#generateBtn span").textContent = isGenerating ? "生成中" : "生成洞察";
}

function markDeltaReceived() {
  state.lastDeltaAt = Date.now();
  state.streamStalled = false;
}

function readDeltaFromChunk(payload) {
  return (
    payload.choices?.[0]?.delta?.content ||
    payload.choices?.[0]?.message?.content ||
    payload.delta ||
    payload.output_text ||
    ""
  );
}

function parseHighlightPhrases(value) {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (Array.isArray(parsed.highlights)) return parsed.highlights.map(String);
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        return [];
      }
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
}

async function generateHighlightPhrases() {
  if (!state.aiMarkdown) {
    showToast("请先生成 AI 报告");
    return;
  }
  if (!state.apiConfigReady) {
    showToast("请先到后台的系统配置中完成 API 配置");
    return;
  }

  state.highlightLoading = true;
  $("#highlightBtn").classList.add("active");
  $("#highlightBtn span").textContent = "分析重点中";
  const config = getApiConfig();

  try {
    const response = await fetch(normalizeChatUrl(config.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content:
              "你是商业报告编辑。你的任务是从报告中挑选最值得客户注意、最能体现洞察价值的短句。只返回 JSON。"
          },
          {
            role: "user",
            content: [
              "从下面报告中提取 8-16 个值得高亮的短句或关键词。",
              "标准：能体现战略判断、核心用户、增长机会、关键风险、验证动作、可落地价值。",
              "不要选择泛泛词语，不要选择完整长段落。每项 2-18 个汉字或一个短英文短语。",
              "只返回 JSON 数组，例如：[\"核心用户\", \"最低成本验证\"]。",
              "",
              state.aiMarkdown
            ].join("\n")
          }
        ],
        temperature: 0.2
      })
    });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || data.output_text || "";
    const phrases = parseHighlightPhrases(content);
    if (!phrases.length) throw new Error("模型没有返回可用高亮项");

    state.highlightPhrases = [...new Set(phrases)].slice(0, 24);
    state.highlightEnabled = true;
    renderAiReport("ready", state.aiMarkdown);
    showToast(`已高亮 ${state.highlightPhrases.length} 个重点`);
  } catch (error) {
    $("#highlightBtn").classList.remove("active");
    showToast(`AI 高亮失败：${error.message.slice(0, 48)}`);
  } finally {
    state.highlightLoading = false;
    $("#highlightBtn span").textContent = "AI 高亮";
  }
}

function getImageConfig() {
  const apiConfig = getApiConfig();
  return {
    url: clean($("#imageApiUrlInput").value) || normalizeImageUrl(apiConfig.url),
    token: apiConfig.token,
    model: clean($("#imageModelInput").value) || "gpt-image-2",
    logo: clean($("#imageLogoInput").value),
    size: $("#imageSizeInput").value,
    quality: $("#imageQualityInput").value,
    count: Number($("#imageCountInput").value || 1)
  };
}

function saveImageConfig(options = {}) {
  const config = getImageConfig();
  localStorage.setItem(
    imageConfigStorageKey,
    JSON.stringify({
      url: config.url,
      model: config.model,
      logo: config.logo,
      size: config.size,
      quality: config.quality,
      count: config.count
    })
  );
  if (!options.silent) renderAdmin();
}

function loadImageConfig() {
  const apiConfig = getApiConfig();
  try {
    const saved = JSON.parse(localStorage.getItem(imageConfigStorageKey) || "null");
    if (saved) {
      $("#imageApiUrlInput").value = saved.url || normalizeImageUrl(apiConfig.url);
      $("#imageModelInput").value = saved.model || "gpt-image-2";
      $("#imageLogoInput").value = saved.logo || "";
      $("#imageSizeInput").value = saved.size || "16:9";
      $("#imageQualityInput").value = saved.quality || "medium";
      $("#imageCountInput").value = String(saved.count || 1);
      return;
    }
  } catch {
    localStorage.removeItem(imageConfigStorageKey);
  }
  $("#imageApiUrlInput").value = normalizeImageUrl(apiConfig.url);
  $("#imageModelInput").value = "gpt-image-2";
  $("#imageLogoInput").value = "";
}

function syncImageConfigFromApi() {
  const current = clean($("#imageApiUrlInput").value);
  if (!current) {
    $("#imageApiUrlInput").value = normalizeImageUrl(getApiConfig().url);
  }
  const logoInput = $("#imageLogoInput");
  if (logoInput && !clean(logoInput.value)) {
    logoInput.value = clean($("#productInput").value) || "产品品牌";
  }
  saveImageConfig({ silent: true });
}

function buildFallbackImagePrompt() {
  const report = buildReport(getFormData());
  const corePersona = report.personas.find((item) => item.core) || report.personas[0];
  const topOpportunities = report.opportunities.slice(0, 3).map((item) => item.name).join("、");
  const signalModes = externalSignalModes(report.input.externalSignals).join("、") || "本地结构化洞察";
  const context = report.input.context.replace(/[。.!！?？\s]+$/, "");
  const contextLine = context ? `产品补充信息：${context}。` : "";
  const logoText = clean($("#imageLogoInput")?.value || "") || report.input.product;
  return [
    `为产品“${report.input.product}”生成一张高端、克制、专业的商业视觉主图。`,
    contextLine,
    `产品阶段：${report.input.stage}；核心受众：${corePersona.name}；核心卖点/抓手：${report.actionSignal}；可表达的产品机会：${topOpportunities}。`,
    `画面主题：让用户一眼理解“${report.input.product}”能帮助${corePersona.name}更快获得${report.actionSignal}，并把复杂决策整理成清晰、可执行的结果。`,
    `品牌标识：画面必须清晰出现自有品牌 Logo/字标“${logoText}”，可以放在产品界面左上角、包装正面、提案封面标题区或品牌铭牌上；Logo 要高级、简洁、可辨认。`,
    `构图：16:9 横版，中心必须出现能代表该产品的主体界面或产品使用场景，周围用精密的信息层、工作流节点、客户证据和结果看板表达价值；不要只画抽象背景。`,
    `视觉风格：瑞士式极简、高级咨询公司提案质感、纯净浅色背景、精密排版、柔和自然光、低饱和红色作为唯一强调色。`,
    `商业用途：官网主视觉、客户提案封面、产品发布页配图。`,
    `信息边界：外部信号模式为${signalModes}，允许出现上述自有品牌标识；不要冒用 Apple、OpenAI、Google、Microsoft 等第三方真实公司 logo，不要出现虚假背书、夸张收益数字或密集文字。`
  ].filter(Boolean).join("\n");
}

function buildImagePromptRequest() {
  const report = buildReport(getFormData());
  const logoText = clean($("#imageLogoInput")?.value || "") || report.input.product;
  return [
    "你是资深创意总监和商业视觉设计师。",
    `请严格根据当前产品“${report.input.product}”生成一段可直接用于 GPT Image 2 / DALL-E / 其他生图模型的中文提示词。`,
    "目标：生成一张能表达该产品价值的高端、极简、可信商业图片，可用于产品官网、客户提案封面或报告开篇主视觉。",
    "",
    "必须优先遵守以下联网检索依据：",
    productEvidenceForImagePrompt(),
    "",
    "当前产品信息：",
    `产品/服务：${report.input.product}`,
    `产品阶段：${report.input.stage}`,
    `分析侧重：${focusLabels[report.input.focus]}`,
    `产品上下文：${report.input.context || "未提供"}`,
    `核心目标用户：${(report.personas.find((item) => item.core) || report.personas[0]).name}`,
    `核心卖点/首要抓手：${report.actionSignal}`,
    `产品机会：${report.opportunities.slice(0, 4).map((item) => item.name).join("、")}`,
    `需要出现在画面中的自有品牌 Logo/字标：${logoText}`,
    "",
    "提示词要求：",
    "1. 只输出最终提示词，不要解释。",
    "2. 必须围绕产品本身，不要只描述泛泛的报告、仪表盘或抽象商业场景。",
    `3. 必须包含产品主体或使用场景、目标用户、核心卖点、构图、材质、光线、色彩、品牌气质、用途，并明确要求画面里出现自有品牌 Logo/字标“${logoText}”。`,
    "4. 风格要克制、高端、清洁，像专业咨询公司或瑞士高端服务品牌，不要廉价赛博风、不要 emoji、不要密集文字。",
    "5. 允许且必须出现上面指定的自有品牌标识；禁止冒用第三方真实品牌 logo、真实人物肖像、虚假数据、虚假引用。",
    "6. 提示词控制在 240-420 个中文字符，可以包含少量英文摄影/设计术语。",
    "",
    "产品营销洞察作为辅助参考：",
    toMarkdown(report),
    state.aiMarkdown ? ["", "AI 深度报告：", state.aiMarkdown.slice(0, 8000)].join("\n") : ""
  ].join("\n");
}

function parseImagePromptResponse(value) {
  return value
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
}

function setImagePromptLoading(isLoading) {
  state.imagePromptLoading = isLoading;
  $("#imagePromptBtn").disabled = isLoading || state.imageBatchGenerating;
  $("#imagePromptBtn").classList.toggle("active", isLoading);
  $("#imagePromptBtn span").textContent = isLoading ? "提炼产品中" : "生成产品提示词";
}

function setImageGenerating(isGenerating) {
  state.imageGenerating = isGenerating;
  $("#imageGenerateBtn").disabled = isGenerating || state.imageBatchGenerating;
  $("#imageGenerateBtn").classList.toggle("loading", isGenerating);
  $("#imageGenerateBtn span").textContent = isGenerating ? "生成中" : "生成当前提示词";
}

function setImageBatchGenerating(isGenerating) {
  state.imageBatchGenerating = isGenerating;
  const batchButton = $("#imageBatchBtn");
  if (!batchButton) return;
  batchButton.disabled = isGenerating;
  batchButton.classList.toggle("loading", isGenerating);
  batchButton.querySelector("span").textContent = isGenerating ? "多图生成中" : "一键生成多图";
  $("#imageGenerateBtn").disabled = isGenerating || state.imageGenerating;
  $("#imagePromptBtn").disabled = isGenerating || state.imagePromptLoading;
}

function setImageStatus(message, type = "idle") {
  const status = $("#imageStatus");
  status.textContent = message;
  status.dataset.status = type;
}

function productEvidenceForImagePrompt() {
  const report = buildReport(getFormData());
  const web = state.onlineSignals.web;
  const items = web.items.slice(0, 5);
  const lines = [
    "联网约束：图片必须先围绕当前产品和全网联索结果生成，不得脱离产品本身自由发挥。",
    `当前产品：${report.input.product}`,
    `检索词：${web.query || getSignalSearchConfig("web", report.input).keywords || report.input.product}`
  ];

  if (items.length) {
    lines.push("已检索到的产品/市场信号：");
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title} / ${item.source || item.engine || "公开来源"}：${item.snippet || "无摘要"}`);
    });
  } else {
    lines.push("本次全网联索没有返回可解析结果，图片仍必须严格使用当前产品名、产品上下文、核心人群和卖点，不得生成无关产品或泛化场景。");
  }

  return lines.join("\n");
}

function constrainImagePromptToProduct(prompt) {
  const report = buildReport(getFormData());
  const logoText = clean($("#imageLogoInput")?.value || "") || report.input.product;
  return [
    productEvidenceForImagePrompt(),
    "",
    "最终生图硬性要求：",
    `1. 画面主体必须明确服务于“${report.input.product}”，不能换成其他产品、行业或抽象 AI 场景。`,
    `2. 画面必须出现自有品牌 Logo/字标“${logoText}”；不得出现第三方真实品牌 Logo。`,
    "3. 如果联网结果不足，只能依据当前产品输入和本地报告，不得编造真实新闻、真实数据或虚假背书。",
    "",
    "原始/AI 生成提示词：",
    prompt
  ].join("\n");
}

async function ensureWebEvidenceForImage(options = {}) {
  const force = options.force !== false;
  const latestReport = buildReport(getFormData());
  state.report = latestReport;
  renderReport(latestReport);

  setImageStatus("正在先进行全网联索，确认当前产品信息后再生成图片", "loading");
  const items = await searchOnlineSignals("web", { force });
  const count = Array.isArray(items) ? items.length : 0;
  setImageStatus(count ? `全网联索完成，已获得 ${count} 条产品相关信号，正在生成图片提示词` : "全网联索未返回可解析结果，将严格依据当前产品信息生成图片", count ? "success" : "error");
  return items;
}

function toggleImageStudio(force) {
  const shouldOpen = typeof force === "boolean" ? force : !state.imageStudioOpen;
  state.imageStudioOpen = shouldOpen;
  $("#imageStudio").hidden = !shouldOpen;
  $("#imageToolBtn").classList.toggle("active", shouldOpen);
  $("#imageToolBtn span").textContent = shouldOpen ? "图片面板" : "生成图片";
  if (shouldOpen) {
    syncImageConfigFromApi();
    $("#imageStudio").scrollIntoView({ block: "nearest" });
  }
}

async function generateImagePrompt(options = {}) {
  const silent = Boolean(options.silent);
  const skipSearch = Boolean(options.skipSearch);
  const latestReport = buildReport(getFormData());
  state.report = latestReport;
  renderReport(latestReport);

  if (!skipSearch) {
    await ensureWebEvidenceForImage({ force: true });
  }

  if (!state.apiConfigReady) {
    const fallback = buildFallbackImagePrompt();
    $("#imagePromptInput").value = fallback;
    setImageStatus("已完成全网联索，并根据当前产品生成基础提示词；配置 API 后可让 AI 进一步提炼。", "success");
    if (!silent) showToast("已生成产品生图提示词");
    return fallback;
  }

  setImagePromptLoading(true);
  setImageStatus("正在结合当前产品和全网联索结果提炼视觉提示词", "loading");
  const config = getApiConfig();
  try {
    const response = await fetch(normalizeChatUrl(config.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "你是商业视觉创意总监，擅长把产品策略报告转成专业生图提示词。" },
          { role: "user", content: buildImagePromptRequest() }
        ],
        temperature: 0.55
      })
    });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || data.output_text || "";
    const prompt = parseImagePromptResponse(content);
    if (!prompt) throw new Error("模型没有返回可用提示词");
    $("#imagePromptInput").value = prompt;
    setImageStatus("产品生图提示词已根据全网联索生成，可直接出图或继续手动修改。", "success");
    if (!silent) showToast("产品生图提示词已生成");
    return prompt;
  } catch (error) {
    const fallback = buildFallbackImagePrompt();
    $("#imagePromptInput").value = fallback;
    setImageStatus(`AI 提示词生成失败，已回退到当前产品基础提示词：${error.message.slice(0, 72)}`, "error");
    return fallback;
  } finally {
    setImagePromptLoading(false);
  }
}

function imageSizeToPixels(value) {
  return {
    "1:1": "1024x1024",
    "16:9": "1792x1024",
    "9:16": "1024x1792",
    "4:3": "1536x1024",
    "3:4": "1024x1536"
  }[value] || "1024x1024";
}

function extractImageUrls(data) {
  const items = Array.isArray(data.data) ? data.data : [];
  return items
    .map((item) => item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url)
    .filter(Boolean);
}

function renderImageGallery(images, activeIndex = 0) {
  state.imageResults = images;
  state.imageResultIndex = activeIndex;
  const active = images[activeIndex];
  $("#imageEmptyState").hidden = Boolean(active);
  $("#imageGallery").hidden = true;
  $("#imageDownloadLink").hidden = !active;
  const previewSlot = $("#imagePreviewSlot");
  previewSlot.classList.toggle("multi", images.length > 1);
  if (!active) {
    previewSlot.replaceChildren();
    return;
  }

  $("#imageDownloadLink").href = active;

  const fragment = document.createDocumentFragment();
  images.forEach((src, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.imageIndex = String(index);
    button.classList.toggle("active", index === activeIndex);
    button.className = images.length > 1 ? "image-result-card" : "image-result-card single";
    if (index === activeIndex) button.classList.add("active");
    button.setAttribute("aria-label", `放大查看第 ${index + 1} 张图片`);
    button.title = "点击放大查看";
    const image = document.createElement("img");
    image.src = src;
    image.alt = `根据产品营销洞察生成的第 ${index + 1} 张图片`;
    image.loading = index === 0 ? "eager" : "lazy";
    button.appendChild(image);
    const zoomCue = document.createElement("div");
    zoomCue.className = "image-result-zoom";
    zoomCue.setAttribute("aria-hidden", "true");
    zoomCue.innerHTML = `
      <svg viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" />
        <path d="M16.5 16.5L21 21M11 8v6M8 11h6" />
      </svg>
      <span>查看大图</span>
    `;
    button.appendChild(zoomCue);
    if (images.length > 1) {
      const badge = document.createElement("span");
      badge.className = "image-result-index";
      badge.textContent = `图 ${index + 1}`;
      button.appendChild(badge);
    }
    fragment.appendChild(button);
  });
  previewSlot.replaceChildren(fragment);
  $("#imageGallery").replaceChildren();
}

function switchGeneratedImage(index) {
  if (!state.imageResults[index]) return;
  renderImageGallery(state.imageResults, index);
}

function ensureImageLightbox() {
  let lightbox = $("#imageLightbox");
  if (lightbox) return lightbox;

  lightbox = document.createElement("div");
  lightbox.id = "imageLightbox";
  lightbox.className = "image-lightbox";
  lightbox.hidden = true;
  lightbox.innerHTML = `
    <div class="image-lightbox-backdrop" data-lightbox-close></div>
    <div class="image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="图片放大预览">
      <button class="image-lightbox-close" type="button" data-lightbox-close aria-label="关闭预览">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <button class="image-lightbox-nav image-lightbox-prev" type="button" data-lightbox-prev aria-label="上一张">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <img id="imageLightboxImg" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="放大的生成图片" />
      <button class="image-lightbox-nav image-lightbox-next" type="button" data-lightbox-next aria-label="下一张">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      <div class="image-lightbox-caption" id="imageLightboxCaption"></div>
    </div>
  `;
  document.body.appendChild(lightbox);

  lightbox.addEventListener("click", (event) => {
    if (event.target.closest("[data-lightbox-close]")) closeImageLightbox();
    if (event.target.closest("[data-lightbox-prev]")) showImageLightboxImage(state.imageLightboxIndex - 1);
    if (event.target.closest("[data-lightbox-next]")) showImageLightboxImage(state.imageLightboxIndex + 1);
  });

  return lightbox;
}

function showImageLightboxImage(index) {
  if (!state.imageResults.length) return;
  const total = state.imageResults.length;
  const nextIndex = (index + total) % total;
  const src = state.imageResults[nextIndex];
  if (!src) return;

  state.imageLightboxIndex = nextIndex;
  state.imageResultIndex = nextIndex;
  const image = $("#imageLightboxImg");
  const caption = $("#imageLightboxCaption");
  image.src = src;
  image.alt = `放大的第 ${nextIndex + 1} 张生成图片`;
  caption.textContent = total > 1 ? `图 ${nextIndex + 1} / ${total}` : "生成图片预览";
  $(".image-lightbox-prev").hidden = total < 2;
  $(".image-lightbox-next").hidden = total < 2;
  renderImageGallery(state.imageResults, nextIndex);
}

function openImageLightbox(index = state.imageResultIndex) {
  if (!state.imageResults[index]) return;
  const lightbox = ensureImageLightbox();
  state.imageLightboxOpen = true;
  lightbox.hidden = false;
  document.body.classList.add("image-lightbox-lock");
  showImageLightboxImage(index);
  $(".image-lightbox-close").focus({ preventScroll: true });
}

function closeImageLightbox() {
  const lightbox = $("#imageLightbox");
  if (!lightbox) return;
  state.imageLightboxOpen = false;
  lightbox.hidden = true;
  document.body.classList.remove("image-lightbox-lock");
  $("#imagePreviewSlot [data-image-index].active")?.focus({ preventScroll: true });
}

async function requestImageGeneration(prompt, config, signal) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      prompt,
      size: imageSizeToPixels(config.size),
      quality: config.quality,
      n: config.count
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || data.error?.code || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return extractImageUrls(data);
}

async function generateImageFromPrompt(options = {}) {
  const skipSearch = Boolean(options.skipSearch);
  if (!skipSearch) {
    await ensureWebEvidenceForImage({ force: true });
  }
  const prompt = clean(options.prompt || $("#imagePromptInput").value);
  const config = { ...getImageConfig(), ...(options.config || {}) };
  const count = Math.min(Math.max(Number(config.count || 1), 1), 4);
  config.count = count;
  const silent = Boolean(options.silent);
  const manageLoading = options.manageLoading !== false;
  if (!prompt) {
    showToast("请先生成或填写生图提示词");
    return [];
  }
  if (!config.url) {
    setImageStatus("请先到后台系统配置中填写图片 API 网址", "error");
    return [];
  }
  if (!config.token) {
    setImageStatus("请先到后台系统配置中填写 API 令牌", "error");
    return [];
  }

  saveImageConfig();
  if (manageLoading) setImageGenerating(true);
  const finalPrompt = constrainImagePromptToProduct(prompt);
  setImageStatus(`${count > 1 ? `正在基于当前产品生成 ${count} 张图片` : "图片接口已开始处理当前产品视觉"}，请稍候`, "loading");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000);
  try {
    const images = [];
    const addImages = (items) => {
      items.forEach((src) => {
        if (src && !images.includes(src) && images.length < count) images.push(src);
      });
    };

    addImages(await requestImageGeneration(finalPrompt, config, controller.signal));

    if (images.length < count) {
      setImageStatus(`接口本次只返回 ${images.length} 张，正在自动补齐到 ${count} 张...`, "loading");
    }

    let attempt = 1;
    while (images.length < count && attempt <= count + 1) {
      attempt += 1;
      const remaining = count - images.length;
      const variationPrompt = [
        finalPrompt,
        "",
        `补充生成第 ${images.length + 1} 张候选图：保持同一产品、品牌色和商业用途，但改变构图、镜头距离、道具层次或版式节奏，避免与前一张完全重复。`
      ].join("\n");
      addImages(await requestImageGeneration(variationPrompt, { ...config, count: Math.min(remaining, 1) }, controller.signal));
    }

    if (!images.length) throw new Error("图片接口没有返回图片");
    renderImageGallery(images, 0);
    $("#imageMeta").textContent = `${config.model} / ${config.size} / ${config.quality} / ${images.length} 张`;
    setImageStatus(images.length < count ? `图片已生成 ${images.length} 张；接口没有继续返回更多候选图。` : "图片已生成，可直接查看多张候选图。", "success");
    if (!silent) showToast(images.length > 1 ? `已生成 ${images.length} 张图片` : "图片已生成");
    return images;
  } catch (error) {
    const message = error.name === "AbortError" ? "图片生成超时，请检查接口状态" : error.message;
    setImageStatus(`图片生成失败：${message.slice(0, 120)}`, "error");
    return [];
  } finally {
    clearTimeout(timeoutId);
    if (manageLoading) setImageGenerating(false);
  }
}

async function generateMultiImagesOneClick() {
  if (state.imageBatchGenerating) return;
  const config = getImageConfig();
  const currentCount = Math.min(Math.max(Number(config.count || 1), 1), 4);
  const targetCount = Math.max(currentCount, 3);
  $("#imageCountInput").value = String(targetCount);
  saveImageConfig();

  setImageBatchGenerating(true);
  setImageStatus("正在先进行全网联索，确认当前产品信息后再生成多图", "loading");
  try {
    await ensureWebEvidenceForImage({ force: true });
    const prompt = await generateImagePrompt({ silent: true, skipSearch: true });
    if (!prompt) throw new Error("没有生成可用提示词");
    setImageStatus(`提示词已就绪，正在生成 ${targetCount} 张候选图`, "loading");
    const images = await generateImageFromPrompt({
      prompt,
      config: { ...getImageConfig(), count: targetCount },
      silent: true,
      manageLoading: false,
      skipSearch: true
    });
    if (images.length) {
      setImageStatus(`已完成 ${images.length} 张候选图，可点击缩略图切换预览。`, "success");
      showToast(`已生成 ${images.length} 张候选图`);
    }
  } catch (error) {
    setImageStatus(`一键多图失败：${error.message.slice(0, 120)}`, "error");
  } finally {
    setImageBatchGenerating(false);
  }
}

async function readStreamingResponse(response, onDelta, options = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let stallTimer = null;
  let streamEndedByStall = false;

  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    const maxIdleMs = options.maxIdleMs || 45000;
    stallTimer = setTimeout(() => {
      streamEndedByStall = true;
      state.streamEndedByStall = true;
      reader.cancel("stream idle timeout").catch(() => {});
    }, maxIdleMs);
  };

  resetStallTimer();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    resetStallTimer();

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      const dataLines = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        const delta = readDeltaFromChunk(payload);
        if (delta) {
          markDeltaReceived();
          onDelta(delta);
        }
      }
    }
  }

  clearTimeout(stallTimer);
  const rest = decoder.decode();
  if (rest) buffer += rest;
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const payload = JSON.parse(data);
      const delta = readDeltaFromChunk(payload);
      if (delta) {
        markDeltaReceived();
        onDelta(delta);
      }
    }
  }
  return { endedByStall: streamEndedByStall };
}

async function generateAiReport(report) {
  const config = getApiConfig();
  setGeneratingState(true);
  renderAiReport("loading", "后台已经开始处理。即使模型暂时没有返回内容，这里也会持续显示运行状态。");
  setActiveSection("ai");
  startGenerationStatus();
  state.streamController = new AbortController();
  await prepareExternalSignalsForReport(report);

  const response = await fetch(normalizeChatUrl(config.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`
    },
    signal: state.streamController.signal,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: "你是一名严谨、克制、商业敏感度高的产品策略顾问。" },
        { role: "user", content: buildAiPrompt(report) }
      ],
      temperature: 0.7,
      stream: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  let content = "";

  if (response.body && contentType.includes("text/event-stream")) {
    const streamResult = await readStreamingResponse(response, (delta) => {
      content += delta;
      state.aiMarkdown = content;
      state.receivedChars = content.length;
      scheduleStreamingRender(content);
    }, { maxIdleMs: 45000 });
    if (streamResult.endedByStall && content) {
      stopGenerationStatus();
      state.aiMarkdown = content;
      flushStreamingRender(
        "partial",
        `${content}\n\n---\n\n流式连接在 45 秒内没有继续返回内容，已保留当前部分报告。你可以重新生成，或调整模型/接口超时设置。`
      );
      saveHistoryItem("partial");
      setGeneratingState(false);
      return;
    }
  } else {
    updateStreamIndicator("接口未返回流式内容，正在等待完整 JSON 响应");
    const data = await response.json();
    content = data.choices?.[0]?.message?.content || data.output_text || "";
  }

  stopGenerationStatus();
  if (!content) throw new Error("模型没有返回可读取的内容");
  state.aiMarkdown = content;
  flushStreamingRender("ready", content);
  saveHistoryItem("ready");
  setGeneratingState(false);
}

function toMarkdown(report) {
  const lines = [
    `# ${report.input.product} - 产品营销洞察报告`,
    "",
    `- 阶段：${report.input.stage}`,
    `- 侧重：${focusLabels[report.input.focus]}`,
    `- 智能模式：${intelligenceLabels[report.input.intelligence]}`,
    `- 核心用户：${report.coreSignal}`,
    `- 首要抓手：${report.actionSignal}`,
    `- 全网联索：${report.input.externalSignals?.webSearch ? "启用" : "未启用"}`,
    `- 社区舆论：${report.input.externalSignals?.community ? "启用" : "未启用"}`,
    report.input.externalSignals?.keywords ? `- 检索关键词：${report.input.externalSignals.keywords}` : null,
    report.input.externalSignals?.sources ? `- 社区平台：${report.input.externalSignals.sources}` : null,
    hasExternalSignals(report.input.externalSignals)
      ? "- 证据边界：真实联网能力取决于 API/模型；无法联网时必须标注待验证假设，不得伪造来源"
      : null,
    ""
  ].filter((line) => line !== null);

  lines.push("## 用户画像", "");
  report.personas.forEach((item) => {
    lines.push(`### ${item.code}类：${item.name}${item.core ? " 核心用户" : ""}`);
    lines.push(`- 行为特征：${item.behavior}`);
    lines.push(`- 使用场景：${item.scene}`);
    lines.push(`- 价值判断：${item.value}`, "");
  });

  lines.push("## 情绪动因", "");
  report.emotions.forEach((item) => {
    lines.push(`### ${item.type}：${item.title}`);
    lines.push(`- 洞察：${item.insight}`);
    lines.push(`- 文案表达：${item.copy}`, "");
  });

  lines.push("## 产品机会", "");
  report.opportunities.forEach((item) => {
    lines.push(`### ${item.priority}：${item.name}`);
    lines.push(`- 具体实施：${item.implementation}`);
    lines.push(`- 对应情绪：${item.emotion}`);
    lines.push(`- 成本：${item.cost}`);
    lines.push(`- 难度：${item.difficulty}`);
    lines.push(`- 预期效果：${item.effect}`, "");
  });

  if (state.aiMarkdown) {
    lines.push("## AI 深度报告", "", state.aiMarkdown, "");
  }

  return lines.join("\n");
}

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(historyStorageKey) || "[]");
    state.history = Array.isArray(saved) ? saved : [];
  } catch {
    state.history = [];
    localStorage.removeItem(historyStorageKey);
  }
}

function persistHistory() {
  localStorage.setItem(historyStorageKey, JSON.stringify(state.history.slice(0, maxHistoryItems)));
}

function saveHistoryItem(status = "ready") {
  if (!state.report) return;
  const markdown = toMarkdown(state.report);
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    status,
    product: state.report.input.product,
    stage: state.report.input.stage,
    focus: state.report.input.focus,
    intelligence: state.report.input.intelligence,
    signalMode: externalSignalModes(state.report.input.externalSignals).join(" + ") || "本地洞察",
    input: state.report.input,
    report: state.report,
    aiMarkdown: state.aiMarkdown,
    markdown
  };

  state.history = [item, ...state.history.filter((entry) => entry.product !== item.product || entry.markdown !== item.markdown)]
    .slice(0, maxHistoryItems);
  persistHistory();
  renderHistory();
}

function renderHistory() {
  const list = $("#historyList");
  if (!list) return;
  if (!state.history.length) {
    list.innerHTML = `
      <article class="history-empty">
        <span>暂无记录</span>
        <p>生成报告后会保存在本机浏览器中。</p>
      </article>
    `;
    $("#clearHistoryBtn").disabled = true;
    return;
  }

  $("#clearHistoryBtn").disabled = false;
  list.innerHTML = state.history
    .map(
      (item) => `
        <article class="history-item" data-history-id="${item.id}">
          <button class="history-load" type="button" data-history-action="load" title="恢复这份报告">
            <span>${escapeHtml(item.product)}</span>
            <small>${formatHistoryTime(item.createdAt)} / ${escapeHtml(focusLabels[item.focus] || "全流程分析")} / ${escapeHtml(item.signalMode)}</small>
          </button>
          <button class="history-delete" type="button" data-history-action="delete" aria-label="删除历史记录">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h14M10 11v6M14 11v6M9 7l1-3h4l1 3M7 7l1 13h8l1-13" />
            </svg>
          </button>
        </article>
      `
    )
    .join("");
}

function restoreHistoryItem(id) {
  const item = state.history.find((entry) => entry.id === id);
  if (!item) return;
  applyInputState(item.input);
  state.report = item.report;
  state.aiMarkdown = item.aiMarkdown || "";
  state.highlightEnabled = false;
  state.highlightPhrases = [];
  renderReport(item.report);
  if (state.aiMarkdown) {
    renderAiReport(item.status === "partial" ? "partial" : "ready", state.aiMarkdown);
  } else {
    renderAiReport("empty", "这条历史记录只有本地结构化洞察，没有保存 AI 深度报告。");
  }
  setActiveSection(state.aiMarkdown ? "ai" : "personas");
  showToast("已恢复历史报告");
}

function deleteHistoryItem(id) {
  state.history = state.history.filter((entry) => entry.id !== id);
  persistHistory();
  renderHistory();
  renderAdmin();
  showToast("历史记录已删除");
}

function clearHistory() {
  state.history = [];
  persistHistory();
  renderHistory();
  renderAdmin();
  showToast("历史记录已清空");
}

function showWorkbenchView(view = "home") {
  state.currentView = view;
  const showingAdmin = view === "admin";
  const showingWebIntel = view === "web-intel";
  const showingCommunity = view === "community";
  const showingSignalPage = showingWebIntel || showingCommunity;
  const adminPanel = $("#adminPanel");
  if (adminPanel) adminPanel.hidden = !showingAdmin;
  $("#webIntelPage").hidden = !showingWebIntel;
  $("#communityPage").hidden = !showingCommunity;
  $(".platform-hero").hidden = showingAdmin || showingSignalPage;
  $("#workbench").hidden = showingAdmin || showingSignalPage;
  $$("[data-nav-view]").forEach((link) => {
    const navView = link.dataset.navView;
    const active = showingAdmin ? false : navView === view || (view === "home" && navView === "home");
    link.classList.toggle("active", active);
  });
  if (showingAdmin) {
    renderAdmin();
    adminPanel?.scrollIntoView({ block: "start" });
  } else if (showingWebIntel) {
    syncSignalPagesFromWorkbench();
    searchOnlineSignals("web");
    $("#webIntelPage").scrollIntoView({ block: "start" });
  } else if (showingCommunity) {
    syncSignalPagesFromWorkbench();
    searchOnlineSignals("community");
    $("#communityPage").scrollIntoView({ block: "start" });
  } else if (view === "history") {
    $("#workbench").scrollIntoView({ block: "start" });
    $(".history-panel")?.scrollIntoView({ block: "center" });
  } else if (view === "workbench") {
    $("#workbench").scrollIntoView({ block: "start" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function showAdminView() {
  if (!ensureAuthenticated()) return;
  if (state.currentUser.role !== "admin") {
    showToast("仅管理员可以进入后台");
    return;
  }
  showWorkbenchView("admin");
}

function roleLabel(role) {
  return role === "admin" ? "管理员" : "成员";
}

function maskToken(value) {
  if (!value) return "未保存";
  if (value.length <= 8) return "已保存";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function renderAdminUsers() {
  const table = $("#adminUsersTable");
  if (!table) return;
  if (!state.users.length) {
    table.innerHTML = `<tr><td colspan="4">暂无用户</td></tr>`;
    return;
  }
  table.innerHTML = state.users
    .map(
      (user) => `
        <tr>
          <td>
            <div class="admin-user-cell">
              <strong>${escapeHtml(user.name || "未命名用户")}</strong>
              <span>${escapeHtml(user.email)}</span>
            </div>
          </td>
          <td>${roleLabel(user.role)}</td>
          <td>${formatHistoryTime(user.createdAt)}</td>
          <td>${user.lastLoginAt ? formatHistoryTime(user.lastLoginAt) : "-"}</td>
        </tr>
      `
    )
    .join("");
}

function renderAdminReports() {
  const list = $("#adminReportList");
  if (!list) return;
  $("#adminClearHistoryBtn").disabled = !state.history.length;
  if (!state.history.length) {
    list.innerHTML = `
      <article class="admin-report-item">
        <strong>暂无历史报告</strong>
        <p>生成分析报告后，这里会显示报告资产。</p>
      </article>
    `;
    return;
  }
  list.innerHTML = state.history
    .map(
      (item) => `
        <article class="admin-report-item">
          <strong>${escapeHtml(item.product)}</strong>
          <p>${formatHistoryTime(item.createdAt)} / ${escapeHtml(focusLabels[item.focus] || "全流程分析")} / ${escapeHtml(item.signalMode || "本地洞察")}</p>
        </article>
      `
    )
    .join("");
}

function renderAdmin() {
  if (!state.currentUser) return;
  const config = getApiConfig();
  const imageConfig = getImageConfig();
  $("#adminUserCount").textContent = String(state.users.length);
  $("#adminReportCount").textContent = String(state.history.length);
  $("#adminApiStatus").textContent = isApiConfigReady() ? "已配置" : "未配置";
  $("#adminApiModel").textContent = config.model || "等待模型名";
  $("#adminCurrentRole").textContent = roleLabel(state.currentUser.role);
  $("#adminCurrentEmail").textContent = state.currentUser.email || "-";
  $("#adminApiUrl").textContent = config.url || "未配置";
  $("#adminModelName").textContent = config.model || "未配置";
  $("#adminTokenStatus").textContent = maskToken(config.token);
  $("#adminImageApiUrl").textContent = imageConfig.url || "未配置";
  $("#adminImageModelName").textContent = imageConfig.model || "未配置";
  renderAdminUsers();
  renderAdminReports();
}

async function copyReport() {
  if (!state.report) return;
  await navigator.clipboard.writeText(toMarkdown(state.report));
  showToast("已复制 Markdown 报告");
}

async function toggleHighlight() {
  if (state.highlightLoading) return;
  if (state.highlightEnabled) {
    state.highlightEnabled = false;
    $("#highlightBtn").classList.remove("active");
    renderAiReport("ready", state.aiMarkdown);
    showToast("已关闭高亮");
    return;
  }
  if (state.highlightPhrases.length) {
    state.highlightEnabled = true;
    $("#highlightBtn").classList.add("active");
    renderAiReport("ready", state.aiMarkdown);
    showToast("已开启高亮");
    return;
  }
  await generateHighlightPhrases();
}

function downloadReport() {
  if (!state.report) return;
  const blob = new Blob([toMarkdown(state.report)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.report.input.product}-产品营销报告.md`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("已导出 Markdown");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function init() {
  loadUsers();
  restoreSession();
  updateAuthUi();
  loadApiConfig();
  loadImageConfig();
  loadHistory();
  renderHistory();

  $$("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });
  $("#registerForm").addEventListener("submit", handleRegister);
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#logoutBtn").addEventListener("click", logout);
  $("#openAdminBtn").addEventListener("click", showAdminView);
  $("#returnWorkbenchBtn").addEventListener("click", () => showWorkbenchView("workbench"));
  $("#adminClearHistoryBtn").addEventListener("click", clearHistory);
  $$("[data-nav-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      if (!ensureAuthenticated()) return;
      showWorkbenchView(link.dataset.navView);
    });
  });

  ["#apiUrlInput", "#apiTokenInput", "#modelInput"].forEach((selector) => {
    $(selector).addEventListener("input", updateApiConfigState);
  });
  $("#apiUrlInput").addEventListener("input", syncImageConfigFromApi);
  ["#imageApiUrlInput", "#imageModelInput"].forEach((selector) => {
    $(selector).addEventListener("input", () => saveImageConfig());
  });
  ["#webSearchInput", "#communityInput"].forEach((selector) => {
    $(selector).addEventListener("change", updateExternalSignalPanels);
  });
  ["#imageLogoInput", "#imageSizeInput", "#imageQualityInput", "#imageCountInput"].forEach((selector) => {
    $(selector).addEventListener("change", saveImageConfig);
  });
  ["#webSearchPageInput", "#communityPageInput"].forEach((selector) => {
    $(selector).addEventListener("change", updateSignalPageLocalState);
  });

  $("#saveConfigBtn").addEventListener("click", saveApiConfig);
  $("#clearConfigBtn").addEventListener("click", clearApiConfig);
  $("#saveWebSignalBtn").addEventListener("click", saveWebSignalPage);
  $("#saveCommunitySignalBtn").addEventListener("click", saveCommunitySignalPage);
  $("#refreshWebIntelBtn").addEventListener("click", () => searchOnlineSignals("web", { force: true }));
  $("#refreshCommunityBtn").addEventListener("click", () => searchOnlineSignals("community", { force: true }));
  $$(".signal-return").forEach((button) => {
    button.addEventListener("click", () => showWorkbenchView(button.dataset.returnView || "workbench"));
  });
  $$("[data-signal-page]").forEach((button) => {
    button.addEventListener("click", () => showWorkbenchView(button.dataset.signalPage));
  });

  $("#insightForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.apiConfigReady) {
      showToast("请先到后台的系统配置中完成 API 配置");
      return;
    }
    const report = buildReport(getFormData());
    state.aiMarkdown = "";
    renderReport(report);
    try {
      await generateAiReport(report);
      showToast("AI 报告已生成");
    } catch (error) {
      stopGenerationStatus();
      clearTimeout(state.streamRenderTimer);
      state.streamRenderTimer = null;
      setGeneratingState(false);
      renderAiReport("error", `本地结构化报告已生成，但 API 调用失败：${error.message}`);
      saveHistoryItem("error");
      showToast("API 调用失败");
    }
  });

  $("#sampleBtn").addEventListener("click", () => {
    $("#productInput").value = "海蓝之谜";
    $("#contextInput").value = sampleContext;
    document.querySelector("input[name='stage'][value='已经成熟']").checked = true;
    document.querySelector("input[name='focus'][value='full']").checked = true;
    $("#webSearchInput").checked = true;
    $("#communityInput").checked = true;
    $("#searchKeywordsInput").value = "海蓝之谜, 高端护肤, 精华面霜, 修护抗老, 奢侈美妆";
    $("#communitySourcesInput").value = "知乎, 小红书, 微博, B站, Reddit";
    updateExternalSignalPanels();
    updateApiConfigState();
    document.querySelector("input[name='intelligence'][value='strategic']").checked = true;
    renderReport(buildReport(getFormData()));
  });

  $$(".report-tabs button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      setActiveSection(button.dataset.section, { scroll: true });
    });
  });

  $("#copyBtn").addEventListener("click", copyReport);
  $("#downloadBtn").addEventListener("click", downloadReport);
  $("#highlightBtn").addEventListener("click", toggleHighlight);
  $("#imageToolBtn").addEventListener("click", () => toggleImageStudio());
  $("#closeImageStudioBtn").addEventListener("click", () => toggleImageStudio(false));
  $("#imagePromptBtn").addEventListener("click", generateImagePrompt);
  $("#copyImagePromptBtn").addEventListener("click", async () => {
    const prompt = $("#imagePromptInput").value.trim();
    if (!prompt) {
      showToast("暂无可复制的提示词");
      return;
    }
    await navigator.clipboard.writeText(prompt);
    showToast("已复制生图提示词");
  });
  $("#imageBatchBtn").addEventListener("click", generateMultiImagesOneClick);
  $("#imageGenerateBtn").addEventListener("click", generateImageFromPrompt);
  $("#imageGallery").addEventListener("click", (event) => {
    const button = event.target.closest("[data-image-index]");
    if (!button) return;
    switchGeneratedImage(Number(button.dataset.imageIndex));
  });
  $("#imagePreviewSlot").addEventListener("click", (event) => {
    const button = event.target.closest("[data-image-index]");
    if (!button) return;
    openImageLightbox(Number(button.dataset.imageIndex));
  });
  document.addEventListener("keydown", (event) => {
    if (!state.imageLightboxOpen) return;
    if (event.key === "Escape") closeImageLightbox();
    if (event.key === "ArrowLeft") showImageLightboxImage(state.imageLightboxIndex - 1);
    if (event.key === "ArrowRight") showImageLightboxImage(state.imageLightboxIndex + 1);
  });
  $("#clearHistoryBtn").addEventListener("click", clearHistory);
  $("#historyList").addEventListener("click", (event) => {
    const item = event.target.closest(".history-item");
    const action = event.target.closest("[data-history-action]");
    if (!item || !action) return;
    const id = item.dataset.historyId;
    if (action.dataset.historyAction === "load") restoreHistoryItem(id);
    if (action.dataset.historyAction === "delete") deleteHistoryItem(id);
  });

  renderReport(buildReport(getFormData()));
  renderAiReport("empty", "工作台会使用当前产品信息、分析侧重和本地结构化洞察，调用你配置的模型生成一份可直接复制给团队或客户的 Markdown 报告。");
  updateExternalSignalPanels();
  updateApiConfigState();
  renderAdmin();
  showWorkbenchView("home");
}

init();
