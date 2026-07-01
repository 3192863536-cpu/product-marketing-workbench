const fs = require("fs/promises");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { URL } = require("url");

const root = __dirname;
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "app-data.json");
const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || "127.0.0.1";
const searchTimeoutMs = 18000;
const sessionCookieName = "pmw_session";
const trendRadarApiUrl = process.env.TRENDRADAR_NEWSNOW_API_URL || "https://newsnow.busiyi.world/api/s";
const defaultImageApiUrl = process.env.DEFAULT_IMAGE_API_URL || "https://image-api.kaopuapi.xyz/v1/images/generations";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const communityDomainMap = {
  "知乎": "zhihu.com",
  "小红书": "xiaohongshu.com",
  "微博": "weibo.com",
  "抖音": "douyin.com",
  "B站": "bilibili.com",
  "哔哩哔哩": "bilibili.com",
  "Reddit": "reddit.com",
  "V2EX": "v2ex.com",
  "GitHub": "github.com",
  "Product Hunt": "producthunt.com"
};

const trendRadarSources = [
  { id: "toutiao", name: "今日头条", expectedDomain: "toutiao.com", groups: ["web"] },
  { id: "baidu", name: "百度热搜", expectedDomain: "baidu.com", groups: ["web"] },
  { id: "wallstreetcn-hot", name: "华尔街见闻", expectedDomain: "wallstreetcn.com", groups: ["web"] },
  { id: "thepaper", name: "澎湃新闻", expectedDomain: "thepaper.cn", groups: ["web"] },
  { id: "bilibili-hot-search", name: "B站热搜", expectedDomain: "bilibili.com", groups: ["web", "community"], aliases: ["B站", "哔哩哔哩", "bilibili"] },
  { id: "cls-hot", name: "财联社热门", expectedDomain: "cls.cn", groups: ["web"] },
  { id: "ifeng", name: "凤凰网", expectedDomain: "ifeng.com", groups: ["web"] },
  { id: "tieba", name: "贴吧", expectedDomain: "baidu.com", groups: ["community"], aliases: ["贴吧", "百度贴吧"] },
  { id: "weibo", name: "微博", expectedDomain: "weibo.com", groups: ["community"], aliases: ["微博"] },
  { id: "douyin", name: "抖音", expectedDomain: "douyin.com", groups: ["community"], aliases: ["抖音"] },
  { id: "zhihu", name: "知乎", expectedDomain: "zhihu.com", groups: ["web", "community"], aliases: ["知乎"] }
];

const trackingParamsToRemove = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "referrer", "source", "channel", "_t", "timestamp", "_", "random",
  "share_token", "share_id", "share_from"
]);

const platformParamsToRemove = {
  weibo: new Set(["band_rank", "Refer", "t"])
};

let appData = null;

function emptyData() {
  return {
    users: [],
    sessions: {},
    config: {
      url: "",
      token: "",
      model: "",
      imageUrl: defaultImageApiUrl,
      imageModel: "gpt-image-2",
      updatedAt: ""
    }
  };
}

async function loadData() {
  if (appData) return appData;
  try {
    const content = await fs.readFile(dataFile, "utf8");
    appData = { ...emptyData(), ...JSON.parse(content) };
    appData.config = { ...emptyData().config, ...(appData.config || {}) };
    appData.sessions = appData.sessions || {};
    appData.users = Array.isArray(appData.users) ? appData.users : [];
  } catch {
    appData = emptyData();
  }
  return appData;
}

async function saveData() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dataFile, JSON.stringify(appData || emptyData(), null, 2), "utf8");
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

function configForClient(config = {}) {
  return {
    url: config.url || "",
    model: config.model || "",
    imageUrl: config.imageUrl || defaultImageApiUrl,
    imageModel: config.imageModel || "gpt-image-2",
    tokenConfigured: Boolean(config.token),
    ready: Boolean(config.url && config.token && config.model)
  };
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        if (index === -1) return [item, ""];
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

async function readJsonBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function currentSession(request) {
  const data = await loadData();
  const sessionId = parseCookies(request)[sessionCookieName];
  if (!sessionId) return { data, sessionId: "", user: null };
  const session = data.sessions[sessionId];
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
    delete data.sessions[sessionId];
    await saveData();
    return { data, sessionId: "", user: null };
  }
  const user = data.users.find((item) => item.id === session.userId);
  return { data, sessionId, user: user || null };
}

async function requireUser(request, response) {
  const session = await currentSession(request);
  if (!session.user) {
    sendJson(response, 401, { ok: false, error: "请先登录" });
    return null;
  }
  return session;
}

async function requireAdmin(request, response) {
  const session = await requireUser(request, response);
  if (!session) return null;
  if (session.user.role !== "admin") {
    sendJson(response, 403, { ok: false, error: "需要管理员权限" });
    return null;
  }
  return session;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload));
}

function sendJsonWithHeaders(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

async function handleAuth(request, response, requestUrl) {
  const pathname = requestUrl.pathname;
  if (pathname === "/api/auth/me" && request.method === "GET") {
    const { data, user } = await currentSession(request);
    sendJson(response, 200, {
      ok: true,
      user: publicUser(user),
      users: user?.role === "admin" ? data.users.map(publicUser) : [],
      config: user ? configForClient(data.config) : null
    });
    return true;
  }

  if (pathname === "/api/auth/register" && request.method === "POST") {
    const data = await loadData();
    const body = await readJsonBody(request);
    const name = clean(body.name || "");
    const email = clean(body.email || "").toLowerCase();
    const password = String(body.password || "");
    if (!name || !email || password.length < 6) {
      sendJson(response, 400, { ok: false, error: "请填写姓名、邮箱和至少 6 位密码" });
      return true;
    }
    if (data.users.some((user) => user.email === email)) {
      sendJson(response, 409, { ok: false, error: "这个邮箱已经注册，请直接登录" });
      return true;
    }
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: hashPassword(password),
      role: data.users.length ? "member" : "admin",
      createdAt: now,
      lastLoginAt: now
    };
    data.users.unshift(user);
    const sessionId = crypto.randomBytes(32).toString("hex");
    data.sessions[sessionId] = {
      userId: user.id,
      createdAt: now,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
    };
    await saveData();
    sendJsonWithHeaders(response, 200, {
      ok: true,
      user: publicUser(user),
      users: data.users.map(publicUser),
      config: configForClient(data.config)
    }, {
      "Set-Cookie": cookieHeader(sessionCookieName, sessionId, { maxAge: 60 * 60 * 24 * 14 })
    });
    return true;
  }

  if (pathname === "/api/auth/login" && request.method === "POST") {
    const data = await loadData();
    const body = await readJsonBody(request);
    const email = clean(body.email || "").toLowerCase();
    const password = String(body.password || "");
    const user = data.users.find((item) => item.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      sendJson(response, 401, { ok: false, error: "邮箱或密码不正确" });
      return true;
    }
    user.lastLoginAt = new Date().toISOString();
    const sessionId = crypto.randomBytes(32).toString("hex");
    data.sessions[sessionId] = {
      userId: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
    };
    await saveData();
    sendJsonWithHeaders(response, 200, {
      ok: true,
      user: publicUser(user),
      users: user.role === "admin" ? data.users.map(publicUser) : [],
      config: configForClient(data.config)
    }, {
      "Set-Cookie": cookieHeader(sessionCookieName, sessionId, { maxAge: 60 * 60 * 24 * 14 })
    });
    return true;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const { data, sessionId } = await currentSession(request);
    if (sessionId) delete data.sessions[sessionId];
    await saveData();
    sendJsonWithHeaders(response, 200, { ok: true }, {
      "Set-Cookie": cookieHeader(sessionCookieName, "", { maxAge: 0 })
    });
    return true;
  }

  return false;
}

async function handleConfig(request, response) {
  if (request.method === "GET") {
    const session = await requireAdmin(request, response);
    if (!session) return true;
    sendJson(response, 200, { ok: true, config: configForClient(session.data.config) });
    return true;
  }
  if (request.method === "POST") {
    const session = await requireAdmin(request, response);
    if (!session) return true;
    const body = await readJsonBody(request);
    const current = session.data.config || {};
    const shouldClear = Boolean(body.clear);
    session.data.config = {
      ...current,
      url: clean(body.url || ""),
      model: clean(body.model || ""),
      token: shouldClear ? "" : clean(body.token || "") || current.token || "",
      imageUrl: clean(body.imageUrl || "") || defaultImageApiUrl,
      imageModel: clean(body.imageModel || "") || "gpt-image-2",
      updatedAt: new Date().toISOString()
    };
    await saveData();
    sendJson(response, 200, { ok: true, config: configForClient(session.data.config) });
    return true;
  }
  sendJson(response, 405, { ok: false, error: "Method not allowed" });
  return true;
}

function normalizeChatUrl(url) {
  const trimmed = clean(url).replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function normalizeImageUrl(url) {
  const trimmed = clean(url).replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/images/generations")) return trimmed;
  if (trimmed.endsWith("/chat/completions")) return trimmed.replace(/\/chat\/completions$/, "/images/generations");
  return `${trimmed}/images/generations`;
}

function normalizeImageModelName(model = "") {
  return String(model || "").trim().toLowerCase();
}

function adaptImageRequestBody(body, model) {
  const modelName = normalizeImageModelName(model);
  const next = { ...body, model };
  const size = String(next.size || "");

  if (modelName.includes("dall-e-3")) {
    next.n = 1;
    if (!["1024x1024", "1792x1024", "1024x1792"].includes(size)) {
      next.size = size.includes("1792") || size.startsWith("1536") ? "1792x1024" : size.endsWith("1536") ? "1024x1792" : "1024x1024";
    }
    next.quality = next.quality === "high" || next.quality === "hd" ? "hd" : "standard";
    return next;
  }

  if (modelName.includes("dall-e-2")) {
    next.n = Math.min(Math.max(Number(next.n || 1), 1), 4);
    if (!["256x256", "512x512", "1024x1024"].includes(size)) next.size = "1024x1024";
    delete next.quality;
    return next;
  }

  if (!modelName.includes("gpt-image-2")) {
    if (size === "1792x1024" || size === "2048x1152") next.size = "1536x1024";
    if (size === "1024x1792" || size === "1152x2048") next.size = "1024x1536";
  }
  next.n = Math.min(Math.max(Number(next.n || 1), 1), 4);
  return next;
}

async function proxyAiChat(request, response) {
  const session = await requireUser(request, response);
  if (!session) return true;
  const config = session.data.config || {};
  if (!config.url || !config.token || !config.model) {
    sendJson(response, 400, { ok: false, error: "后台 API 配置未完成" });
    return true;
  }
  const body = await readJsonBody(request, 4_000_000);
  const upstream = await fetch(normalizeChatUrl(config.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify({
      ...body,
      model: config.model
    })
  });
  response.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) response.write(chunk);
  }
  response.end();
  return true;
}

async function proxyImageGeneration(request, response) {
  const session = await requireUser(request, response);
  if (!session) return true;
  const config = session.data.config || {};
  const imageUrl = config.imageUrl || defaultImageApiUrl || normalizeImageUrl(config.url || "");
  if (!imageUrl || !config.token) {
    sendJson(response, 400, { ok: false, error: "后台图片 API 配置未完成" });
    return true;
  }
  const body = await readJsonBody(request, 4_000_000);
  const upstream = await fetch(imageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify(adaptImageRequestBody(body, config.imageModel || "gpt-image-2"))
  });
  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "";
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {}
  if (!parsed && !contentType.includes("application/json")) {
    const looksLikeHtml = /^\s*<!doctype html|^\s*<html[\s>]/i.test(text);
    sendJson(response, upstream.ok ? 502 : upstream.status, {
      ok: false,
      error: {
        code: "IMAGE_UPSTREAM_NOT_JSON",
        message: looksLikeHtml
          ? "图片接口返回了网页内容，不是 JSON。请检查后台的图片 API 网址是否填成了网站首页、控制台地址或错误路径。"
          : `图片接口返回了非 JSON 内容：${contentType || "未知类型"}`,
        status: upstream.status,
        preview: text.replace(/\s+/g, " ").slice(0, 220)
      }
    });
    return true;
  }
  response.writeHead(upstream.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(parsed ? JSON.stringify(parsed) : text);
  return true;
}

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&thinsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(value = "") {
  return decodeHtml(String(value).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value = "") {
  return String(value).trim().replace(/\s+/g, " ");
}

function safeHttpUrl(value = "") {
  try {
    const parsed = new URL(decodeHtml(value));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function sourceFromUrl(value = "") {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "未知来源";
  }
}

function normalizeUrl(value = "", platformId = "") {
  const safeUrl = safeHttpUrl(value);
  if (!safeUrl) return "";
  try {
    const parsed = new URL(safeUrl);
    const platformSpecific = platformParamsToRemove[platformId] || new Set();
    for (const key of [...parsed.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      const shouldRemove =
        [...trackingParamsToRemove].some((item) => item.toLowerCase() === normalizedKey) ||
        [...platformSpecific].some((item) => item.toLowerCase() === normalizedKey);
      if (shouldRemove) parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.href;
  } catch {
    return safeUrl;
  }
}

function domainMatches(value = "", expectedDomain = "") {
  if (!expectedDomain) return true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const expected = expectedDomain.toLowerCase();
    return hostname === expected || hostname.endsWith(`.${expected}`);
  } catch {
    return false;
  }
}

function fixMaybeMojibake(value = "") {
  const text = String(value || "");
  if (!/[ÃÂåæäçéè]/.test(text)) return text;
  try {
    return new TextDecoder("utf-8").decode(Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff)));
  } catch {
    return text;
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), searchTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function parseBingResults(html, query, type) {
  const items = [];
  const chunks = html.split(/<li class="b_algo"/i).slice(1);
  for (const rawChunk of chunks) {
    const chunk = rawChunk.split(/<\/li>/i)[0];
    const linkMatch = chunk.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = safeHttpUrl(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    if (!url || !title) continue;
    const snippetMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    items.push({
      title,
      url,
      snippet,
      source: sourceFromUrl(url),
      date: "",
      type,
      engine: "Bing",
      query
    });
  }
  return items;
}

function parseDuckDuckGoResults(html, query, type) {
  const items = [];
  const chunks = html.split(/class="result /i).slice(1);
  for (const rawChunk of chunks) {
    const chunk = rawChunk.split(/<\/div>\s*<\/div>/i)[0];
    const linkMatch = chunk.match(/class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    let url = decodeHtml(linkMatch[1]);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    url = safeHttpUrl(url);
    const title = stripTags(linkMatch[2]);
    if (!url || !title) continue;
    const snippetMatch = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1] || snippetMatch[2]) : "";
    items.push({
      title,
      url,
      snippet,
      source: sourceFromUrl(url),
      date: "",
      type,
      engine: "DuckDuckGo",
      query
    });
  }
  return items;
}

async function searchBing(query, type) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&cc=CN`;
  const html = await fetchText(url);
  return parseBingResults(html, query, type);
}

async function searchDuckDuckGo(query, type) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  return parseDuckDuckGoResults(html, query, type);
}

function splitTerms(value, fallback = []) {
  const terms = String(value || "")
    .split(/[,，、/|;\n\r\t]/)
    .map(clean)
    .filter(Boolean);
  return terms.length ? terms : fallback;
}

function splitSearchTerms(value, fallback = []) {
  const terms = String(value || "")
    .split(/[,，、/|;\n\r\t ]/)
    .map(clean)
    .filter(Boolean);
  return terms.length ? terms : fallback;
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function uniqueProductTerms(values, product) {
  const productText = clean(product);
  const terms = [];
  for (const value of values.map(clean).filter(Boolean)) {
    if (value.length <= 1) continue;
    if (terms.includes(value)) continue;
    if (productText && value !== productText && productText.includes(value) && value.length <= 4) continue;
    terms.push(value);
  }
  return terms;
}

function compactQuery(value, limit = 96) {
  const text = clean(value);
  return text.length <= limit ? text : text.slice(0, limit);
}

function buildProductBase(params) {
  const product = clean(params.product || params.query || "产品营销");
  const category = clean(params.category || "");
  const actionSignal = clean(params.actionSignal || "");
  const coreUser = clean(params.coreUser || "");
  const opportunities = splitTerms(params.opportunities || "", []);
  const queryTerms = splitSearchTerms(params.query || "", []);
  const contextTerms = splitSearchTerms(params.context || "", []).slice(0, 3);
  return {
    product,
    category,
    actionSignal,
    coreUser,
    opportunities,
    queryTerms,
    contextTerms,
    baseTerms: uniqueProductTerms([product, category, actionSignal, coreUser, ...opportunities, ...queryTerms, ...contextTerms], product).slice(0, 8)
  };
}

function buildQueries(type, params) {
  const data = buildProductBase(params);
  const base = compactQuery(data.baseTerms.join(" "), 110);
  if (type === "community") {
    const platforms = splitTerms(params.sources, ["知乎", "小红书", "微博", "B站", "Reddit"]).slice(0, 5);
    return platforms.flatMap((platform) => {
      const domain = communityDomainMap[platform] || "";
      const prefix = domain ? `site:${domain}` : platform;
      return [
        {
          query: compactQuery(`${prefix} ${data.product} ${data.actionSignal} 用户 评价 讨论 吐槽`, 118),
          platform,
          domain
        },
        {
          query: compactQuery(`${prefix} ${base} 替代方案 推荐 避坑 体验`, 118),
          platform,
          domain
        }
      ];
    });
  }
  return [
    {
      query: compactQuery(`${data.product} ${data.category} ${data.actionSignal} 市场 竞品 价格 评价`, 118),
      platform: "全网",
      domain: ""
    },
    {
      query: compactQuery(`${data.product} ${data.coreUser} ${data.opportunities[0] || data.actionSignal} 替代方案 对比 案例`, 118),
      platform: "全网",
      domain: ""
    },
    {
      query: compactQuery(`${base} 购买决策 痛点 复购 转化`, 118),
      platform: "全网",
      domain: ""
    }
  ];
}

function tokensFromSearchParams(params) {
  const data = buildProductBase(params);
  return uniqueProductTerms([
    data.product,
    data.category,
    data.actionSignal,
    data.coreUser,
    ...data.opportunities,
    ...data.queryTerms,
    ...data.contextTerms
  ], data.product)
    .flatMap((term) => splitSearchTerms(term, [term]))
    .filter((term) => term.length >= 2 && !["ai", "api"].includes(term.toLowerCase()))
    .slice(0, 18);
}

function sourceEnabledForType(source, type, sourcesText) {
  if (!source.groups.includes(type)) return false;
  if (type !== "community") return true;
  const requested = splitTerms(sourcesText, []);
  if (!requested.length) return true;
  const names = [source.name, source.id, ...(source.aliases || [])].map((item) => item.toLowerCase());
  return requested.some((item) => names.some((name) => name.includes(item.toLowerCase()) || item.toLowerCase().includes(name)));
}

function trendRadarRelevance(item, tokens) {
  const haystack = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();
  let score = 0;
  let strongMatches = 0;
  tokens.forEach((token) => {
    const text = token.toLowerCase();
    if (!text) return;
    if (haystack.includes(text)) {
      const isStrong = text.length >= 4 || /deepseek|openai|claude|gemini|qwen|saas|b2b/i.test(text);
      score += isStrong ? 2 : 1;
      if (isStrong) strongMatches += 1;
    }
  });
  return strongMatches ? score : 0;
}

function normalizeTrendRadarItem(raw, source, index, type, tokens) {
  const url = normalizeUrl(raw.url || raw.mobileUrl || raw.id || "", source.id);
  if (!url || !domainMatches(url, source.expectedDomain)) return null;
  const title = clean(fixMaybeMojibake(raw.title || ""));
  if (!title) return null;
  const extra = raw.extra || {};
  const snippet = clean(fixMaybeMojibake(extra.hover || extra.info || ""));
  const score = trendRadarRelevance({ title, snippet }, tokens);
  if (tokens.length && score <= 0) return null;
  return {
    title,
    url,
    snippet,
    source: sourceFromUrl(url),
    date: "",
    type,
    engine: "TrendRadar/NewsNow",
    platform: source.name,
    rank: index + 1,
    hotness: fixMaybeMojibake(extra.info || ""),
    query: source.id,
    trendScore: score
  };
}

async function searchTrendRadarSources(type, params, limit) {
  const tokens = tokensFromSearchParams(params);
  const sources = trendRadarSources
    .filter((source) => sourceEnabledForType(source, type, params.sources || ""))
    .slice(0, type === "community" ? 5 : 8);

  const searches = await Promise.allSettled(
    sources.map(async (source) => {
      const url = `${trendRadarApiUrl}?id=${encodeURIComponent(source.id)}&latest`;
      const payload = await fetchJson(url);
      const status = payload.status || "";
      if (status && !["success", "cache"].includes(status)) return [];
      const items = Array.isArray(payload.items) ? payload.items : [];
      return items
        .map((item, index) => normalizeTrendRadarItem(item, source, index, type, tokens))
        .filter(Boolean);
    })
  );

  return searches
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((a, b) => (b.trendScore - a.trendScore) || (a.rank - b.rank))
    .slice(0, limit);
}

function filterByDomain(results, domain) {
  if (!domain) return results;
  return results.filter((item) => item.source === domain || item.source.endsWith(`.${domain}`));
}

function dedupeResults(results, limit) {
  const seen = new Set();
  const deduped = [];
  for (const item of results) {
    const key = `${item.url.replace(/[?#].*$/, "")}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

async function runSearch(requestUrl) {
  const type = requestUrl.searchParams.get("type") === "community" ? "community" : "web";
  const query = clean(requestUrl.searchParams.get("q") || "");
  const product = clean(requestUrl.searchParams.get("product") || "");
  const sources = clean(requestUrl.searchParams.get("sources") || "");
  const context = clean(requestUrl.searchParams.get("context") || "");
  const stage = clean(requestUrl.searchParams.get("stage") || "");
  const category = clean(requestUrl.searchParams.get("category") || "");
  const coreUser = clean(requestUrl.searchParams.get("coreUser") || "");
  const actionSignal = clean(requestUrl.searchParams.get("actionSignal") || "");
  const opportunities = clean(requestUrl.searchParams.get("opportunities") || "");
  const limit = Math.min(Math.max(Number(requestUrl.searchParams.get("limit") || 8), 1), 12);
  const queries = buildQueries(type, {
    query,
    product,
    sources,
    context,
    stage,
    category,
    coreUser,
    actionSignal,
    opportunities
  });
  const searchParams = {
    query,
    product,
    sources,
    context,
    stage,
    category,
    coreUser,
    actionSignal,
    opportunities
  };
  const searches = await Promise.allSettled(
    queries.map(async (item) => {
      try {
        const results = filterByDomain(await searchBing(item.query, type), item.domain);
        if (results.length) return results.map((result) => ({ ...result, platform: item.platform }));
        if (type === "community") return [];
      } catch {
        if (type === "community") return [];
        // Fall through to the alternate source for this query.
      }
      const fallback = filterByDomain(await searchDuckDuckGo(item.query, type), item.domain);
      return fallback.map((result) => ({ ...result, platform: item.platform }));
    })
  );
  const trendRadarSearch = await Promise.allSettled([
    searchTrendRadarSources(type, searchParams, limit)
  ]);

  const errors = searches
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));
  const trendRadarErrors = trendRadarSearch
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));
  const results = [
    ...trendRadarSearch.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    ...searches.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
  ];
  const items = dedupeResults(results, limit);
  return {
    ok: true,
    type,
    query: query || product,
    queries: [
      ...queries.map((item) => item.query),
      ...trendRadarSources
        .filter((source) => sourceEnabledForType(source, type, sources))
        .map((source) => `TrendRadar:${source.name}`)
    ],
    sources,
    searchedAt: new Date().toISOString(),
    items,
    warning: items.length ? "" : errors[0] || trendRadarErrors[0] || "搜索源未返回可解析结果"
  };
}

async function serveStatic(requestUrl, response) {
  let requestedPath = decodeURIComponent(requestUrl.pathname);
  if (requestedPath === "/") requestedPath = "/index.html";
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  try {
    if (requestUrl.pathname.startsWith("/api/auth/")) {
      if (await handleAuth(request, response, requestUrl)) return;
    }
    if (requestUrl.pathname === "/api/config") {
      await handleConfig(request, response);
      return;
    }
    if (requestUrl.pathname === "/api/ai/chat") {
      await proxyAiChat(request, response);
      return;
    }
    if (requestUrl.pathname === "/api/images/generations") {
      await proxyImageGeneration(request, response);
      return;
    }
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message || "服务器内部错误" });
    return;
  }
  if (requestUrl.pathname === "/api/search") {
    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, error: "Only GET is supported" });
      return;
    }
    try {
      const session = await requireUser(request, response);
      if (!session) return;
      sendJson(response, 200, await runSearch(requestUrl));
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        error: error.name === "AbortError" ? "联网搜索超时" : error.message || "联网搜索失败"
      });
    }
    return;
  }
  await serveStatic(requestUrl, response);
});

server.listen(port, host, () => {
  console.log(`产品营销工作台真实联网版：http://127.0.0.1:${port}/index.html`);
});
