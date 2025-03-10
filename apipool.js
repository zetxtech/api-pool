// ctrl+f 搜索 自定义 ，修改你需要自定义的配置
// ==================== 常量定义 ====================
const API_BASE_URL = "https://api.siliconflow.cn"; // 可自定义修改为您的API地址 openai格式
const API_ENDPOINTS = {
  chat: "/v1/chat/completions",
  embeddings: "/v1/embeddings",
  images: "/v1/images/generations",
  models: "/v1/models",
  userInfo: "/v1/user/info",
};

const KV_KEYS = {
  TOKENS: "tokens",
  STATS: "stats",
  PASSWORD: "admin_password",
  SESSION_SECRET: "session_secret",
};

// 默认管理员密码 - 自定义修改为更安全的密码
const DEFAULT_ADMIN_PASSWORD = "xxx";

// ==================== 内存数据存储 ====================
// 存储API令牌列表
let tokens = [];
// 锁定状态，防止并发写入
let dataLock = false;
// 请求统计数据 - 分钟级
let requestTimestamps = [];
let tokenCounts = [];
// 请求统计数据 - 天级
let requestTimestampsDay = [];
let tokenCountsDay = [];
// 上次保存统计数据的时间
let lastStatsSave = Date.now();
// 设置日志级别
let logLevel = "debug"; // debug, info, warn, error

// 全局统计变量
let lastKVSaveTime = Date.now();
let pendingUpdates = 0;
const KV_SAVE_INTERVAL = 180000; // 每3分钟保存一次
const MAX_PENDING_UPDATES = 20; // 积累20次更新后强制保存

// ==================== 日志类 ===================
class Logger {
  static debug(message, ...args) {
    if (logLevel === "debug") {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }

  static info(message, ...args) {
    if (logLevel === "debug" || logLevel === "info") {
      console.info(`[INFO] ${message}`, ...args);
    }
  }

  static warn(message, ...args) {
    if (logLevel === "debug" || logLevel === "info" || logLevel === "warn") {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  static error(message, ...args) {
    console.error(`[ERROR] ${message}`, ...args);
  }
}

// ==================== 数据锁定管理 ====================
function acquireDataLock() {
  if (dataLock) {
    return false;
  }
  dataLock = true;
  return true;
}

function releaseDataLock() {
  dataLock = false;
}

// ==================== 令牌管理函数 ====================
async function loadTokensFromKV(env) {
  try {
    const data = await env.API_TOKENS.get(KV_KEYS.TOKENS, { type: "json" });
    if (data) {
      tokens = data;
      Logger.info(`已从KV加载${tokens.length}个令牌`);
    } else {
      tokens = [];
      Logger.info("KV中没有令牌数据，初始化为空数组");
    }
    return true;
  } catch (error) {
    Logger.error("从KV加载令牌失败:", error);
    return false;
  }
}

async function saveTokensToKV(env) {
  if (!env) return false;

  try {
    // 获取数据锁，防止并发写入
    await acquireDataLock();

    await env.API_TOKENS.put(KV_KEYS.TOKENS, JSON.stringify(tokens));
    Logger.info(`已保存${tokens.length}个令牌到KV`);

    releaseDataLock();
    return true;
  } catch (error) {
    releaseDataLock();
    Logger.error("保存令牌到KV失败:", error);
    return false;
  }
}

// 获取北京时间字符串
function getBJTimeString() {
  const date = new Date();
  const bjTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return bjTime.toISOString().replace("T", " ").substring(0, 19);
}

// 添加令牌到KV
async function addTokenToKV(env, tokenInput) {
  if (!acquireDataLock()) {
    return { success: false, message: "系统正忙，请稍后再试" };
  }

  try {
    // 加载现有令牌
    await loadTokensFromKV(env);

    // 处理输入，支持多行和逗号分隔
    const tokenLines = tokenInput.split(/[\n,]+/).map((line) => line.trim());
    const validTokens = tokenLines.filter((token) => token.length > 0);

    if (validTokens.length === 0) {
      releaseDataLock();
      return { success: false, message: "未提供有效的令牌" };
    }

    let addedCount = 0;
    let duplicateCount = 0;

    for (const token of validTokens) {
      // 检查令牌是否已存在
      const tokenExists = tokens.some((t) => t.key === token);

      if (!tokenExists) {
        // 添加新令牌
        tokens.push({
          key: token,
          enabled: true,
          addedAt: getBJTimeString(),
          lastUsed: null,
          usageCount: 0,
          errorCount: 0,
          consecutiveErrors: 0,
          balance: null,
          lastChecked: null,
        });
        addedCount++;
      } else {
        duplicateCount++;
      }
    }

    // 保存更新后的令牌列表
    await saveTokensToKV(env);

    releaseDataLock();

    let message = `成功添加了${addedCount}个令牌`;
    if (duplicateCount > 0) {
      message += `，${duplicateCount}个令牌已存在`;
    }

    return {
      success: true,
      message: message,
      addedCount,
      duplicateCount,
    };
  } catch (error) {
    Logger.error("添加令牌失败:", error);
    releaseDataLock();
    return { success: false, message: "添加令牌失败: " + error.message };
  }
}

// 从KV删除令牌
async function removeTokenFromKV(env, tokenToRemove, skipLock = false) {
  if (!skipLock && !acquireDataLock()) {
    return { success: false, message: "系统正忙，请稍后再试" };
  }

  try {
    // 加载现有令牌
    if (!skipLock) {
      await loadTokensFromKV(env);
    }

    // 处理输入，支持多行和逗号分隔
    const tokenLines = tokenToRemove.split(/[\n,]+/).map((line) => line.trim());
    const validTokens = tokenLines.filter((token) => token.length > 0);

    if (validTokens.length === 0) {
      if (!skipLock) releaseDataLock();
      return { success: false, message: "未提供有效的令牌" };
    }

    const initialCount = tokens.length;
    tokens = tokens.filter((token) => !validTokens.includes(token.key));
    const removedCount = initialCount - tokens.length;

    // 保存更新后的令牌列表
    await saveTokensToKV(env);

    if (!skipLock) releaseDataLock();

    return {
      success: true,
      message: `成功删除了${removedCount}个令牌`,
      removedCount,
    };
  } catch (error) {
    Logger.error("删除令牌失败:", error);
    if (!skipLock) releaseDataLock();
    return { success: false, message: "删除令牌失败: " + error.message };
  }
}

// 切换令牌状态
async function toggleTokenStatus(env, tokenKey) {
  if (!acquireDataLock()) {
    return { success: false, message: "系统正忙，请稍后再试" };
  }

  try {
    // 加载现有令牌
    await loadTokensFromKV(env);

    // 查找令牌
    const tokenIndex = tokens.findIndex((t) => t.key === tokenKey);

    if (tokenIndex === -1) {
      releaseDataLock();
      return { success: false, message: "未找到指定的令牌" };
    }

    // 切换状态
    tokens[tokenIndex].enabled = !tokens[tokenIndex].enabled;
    const newStatus = tokens[tokenIndex].enabled ? "启用" : "禁用";

    // 保存更新后的令牌列表
    await saveTokensToKV(env);

    releaseDataLock();

    return {
      success: true,
      message: `已将令牌状态切换为${newStatus}`,
      enabled: tokens[tokenIndex].enabled,
    };
  } catch (error) {
    Logger.error("切换令牌状态失败:", error);
    releaseDataLock();
    return { success: false, message: "切换令牌状态失败: " + error.message };
  }
}

// ==================== 令牌选择策略 ====================
// 初始化令牌统计
function initializeTokenStats() {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalTokens: 0,
    lastUsed: null,
  };
}

// 获取下一个令牌（简单轮询）
function getNextToken() {
  // 过滤出启用状态的令牌
  const enabledTokens = tokens.filter((token) => token.enabled);

  if (enabledTokens.length === 0) {
    return null;
  }

  // 找出最近最少使用的令牌
  enabledTokens.sort((a, b) => {
    if (!a.lastUsed) return -1;
    if (!b.lastUsed) return 1;
    return new Date(a.lastUsed) - new Date(b.lastUsed);
  });

  return enabledTokens[0];
}

// 智能选择令牌（考虑成功率和使用量）
function getSmartToken() {
  // 过滤出启用状态的令牌
  const enabledTokens = tokens.filter((token) => token.enabled);

  if (enabledTokens.length === 0) {
    return null;
  }

  // 计算每个令牌的分数
  // 分数 = (成功请求率 * 0.7) + (1 - 相对使用量 * 0.3)
  enabledTokens.forEach((token) => {
    const totalReq = token.usageCount || 0;
    const errorRate = totalReq > 0 ? (token.errorCount || 0) / totalReq : 0;
    const successRate = 1 - errorRate;

    // 找出使用量最大的令牌作为基准
    const maxUsage = Math.max(...enabledTokens.map((t) => t.usageCount || 0));
    const relativeUsage = maxUsage > 0 ? (token.usageCount || 0) / maxUsage : 0;

    // 计算总分
    token.score = successRate * 0.7 + (1 - relativeUsage) * 0.3;

    // 连续错误降低分数
    if (token.consecutiveErrors > 0) {
      token.score = token.score * Math.pow(0.8, token.consecutiveErrors);
    }
  });

  // 按分数降序排序
  enabledTokens.sort((a, b) => b.score - a.score);

  return enabledTokens[0];
}

// 根据请求路径选择令牌
function selectTokenForRequest(requestPath) {
  // 这里可以根据不同的请求路径选择不同的令牌选择策略
  // 例如，对于图像生成使用不同的策略

  if (requestPath.includes(API_ENDPOINTS.images)) {
    return getNextToken(); // 对于图像请求使用简单轮询
  } else {
    return getSmartToken(); // 对于其他请求使用智能选择
  }
}

// ==================== 统计数据管理 ====================
// 清理旧的请求数据
function cleanupOldRequestData() {
  const now = Date.now();
  const ONE_MINUTE = 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  try {
    // 清理分钟级数据
    let minuteCleanupCount = 0;

    // 确保数组长度一致
    if (requestTimestamps.length !== tokenCounts.length) {
      const minLength = Math.min(requestTimestamps.length, tokenCounts.length);
      requestTimestamps.length = minLength;
      tokenCounts.length = minLength;
      Logger.warn(`分钟级统计数据长度不一致，已调整为${minLength}`);
    }

    // 清理过期数据
    for (let i = requestTimestamps.length - 1; i >= 0; i--) {
      if (now - requestTimestamps[i] > ONE_MINUTE) {
        requestTimestamps.splice(0, i + 1);
        tokenCounts.splice(0, i + 1);
        minuteCleanupCount = i + 1;
        break;
      }
    }

    if (minuteCleanupCount > 0) {
      Logger.debug(`清理了${minuteCleanupCount}条分钟级统计数据`);
    }

    // 清理天级数据
    let dayCleanupCount = 0;

    // 确保数组长度一致
    if (requestTimestampsDay.length !== tokenCountsDay.length) {
      const minDayLength = Math.min(requestTimestampsDay.length, tokenCountsDay.length);
      requestTimestampsDay.length = minDayLength;
      tokenCountsDay.length = minDayLength;
      Logger.warn(`天级统计数据长度不一致，已调整为${minDayLength}`);
    }

    // 清理过期数据
    for (let i = requestTimestampsDay.length - 1; i >= 0; i--) {
      if (now - requestTimestampsDay[i] > ONE_DAY) {
        requestTimestampsDay.splice(0, i + 1);
        tokenCountsDay.splice(0, i + 1);
        dayCleanupCount = i + 1;
        break;
      }
    }

    if (dayCleanupCount > 0) {
      Logger.debug(`清理了${dayCleanupCount}条天级统计数据`);
    }
  } catch (error) {
    Logger.error("清理统计数据时出错:", error);
    // 出错时重置数组，防止数据不一致
    if (requestTimestamps.length !== tokenCounts.length) {
      requestTimestamps = [];
      tokenCounts = [];
    }
    if (requestTimestampsDay.length !== tokenCountsDay.length) {
      requestTimestampsDay = [];
      tokenCountsDay = [];
    }
  }
}

// 从KV加载统计数据
async function loadStatsFromKV(env) {
  try {
    const data = await env.API_TOKENS.get(KV_KEYS.STATS, { type: "json" });
    if (data) {
      requestTimestamps = data.requestTimestamps || [];
      tokenCounts = data.tokenCounts || [];
      requestTimestampsDay = data.requestTimestampsDay || [];
      tokenCountsDay = data.tokenCountsDay || [];

      // 清理旧数据
      cleanupOldRequestData();

      Logger.info("已从KV加载请求统计数据");
    } else {
      requestTimestamps = [];
      tokenCounts = [];
      requestTimestampsDay = [];
      tokenCountsDay = [];
      Logger.info("KV中没有请求统计数据，初始化为空");
    }
    return true;
  } catch (error) {
    Logger.error("加载统计数据失败:", error);
    requestTimestamps = [];
    tokenCounts = [];
    requestTimestampsDay = [];
    tokenCountsDay = [];
    return false;
  }
}

// 保存统计数据到KV
async function saveStatsToKV(env, forceSave = false) {
  if (!env) return false;

  // 只在强制保存或每隔10分钟保存一次，以减少KV写入
  const now = Date.now();
  const SAVE_INTERVAL = 10 * 60 * 1000; // 10分钟

  if (!forceSave && now - lastStatsSave < SAVE_INTERVAL) {
    return false;
  }

  try {
    // 获取数据锁，防止并发写入
    await acquireDataLock();

    await env.API_TOKENS.put(
      KV_KEYS.STATS,
      JSON.stringify({
        requestTimestamps,
        tokenCounts,
        requestTimestampsDay,
        tokenCountsDay,
        lastUpdated: new Date().toISOString(),
      })
    );

    lastStatsSave = now;
    Logger.info("已保存请求统计数据到KV");
    releaseDataLock();
    return true;
  } catch (error) {
    releaseDataLock();
    Logger.error("保存请求统计数据失败:", error);
    return false;
  }
}

// 更新令牌统计
async function updateTokenStats(token, success, tokenCount = 0, env = null) {
  if (!token) return;

  // 确保tokenCount是有效数字
  tokenCount = typeof tokenCount === "number" && !isNaN(tokenCount) ? tokenCount : 0;

  // 更新令牌使用记录
  const tokenIndex = tokens.findIndex((t) => t.key === token.key);
  if (tokenIndex !== -1) {
    tokens[tokenIndex].lastUsed = getBJTimeString();
    tokens[tokenIndex].usageCount = (tokens[tokenIndex].usageCount || 0) + 1;

    // 更新令牌的token使用量统计
    tokens[tokenIndex].totalTokens = (tokens[tokenIndex].totalTokens || 0) + tokenCount;

    if (success) {
      tokens[tokenIndex].consecutiveErrors = 0;
      tokens[tokenIndex].successCount = (tokens[tokenIndex].successCount || 0) + 1;
    } else {
      tokens[tokenIndex].errorCount = (tokens[tokenIndex].errorCount || 0) + 1;
      tokens[tokenIndex].consecutiveErrors = (tokens[tokenIndex].consecutiveErrors || 0) + 1;
      tokens[tokenIndex].lastErrorTime = new Date().toISOString(); // 记录最后错误时间

      // 如果连续错误超过阈值，禁用令牌
      const MAX_CONSECUTIVE_ERRORS = 5; // 自定义修改为您的连续错误次数
      if (tokens[tokenIndex].consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        Logger.warn(`令牌 ${obfuscateKey(token.key)} 连续错误${MAX_CONSECUTIVE_ERRORS}次，自动禁用`);
        tokens[tokenIndex].enabled = false;
      }
    }
  }

  // 更新全局请求统计
  const now = Date.now();
  pendingUpdates++;

  // 添加分钟级别的统计
  requestTimestamps.push(now);
  tokenCounts.push(tokenCount);

  // 添加天级别的统计
  requestTimestampsDay.push(now);
  tokenCountsDay.push(tokenCount);

  // 清理旧数据
  cleanupOldRequestData();

  // 判断是否需要保存到KV
  const shouldSave =
    env &&
    (pendingUpdates >= MAX_PENDING_UPDATES || // 积累足够多的更新
      now - lastKVSaveTime >= KV_SAVE_INTERVAL || // 超过时间间隔
      !success || // 发生错误时立即保存
      (tokenIndex !== -1 && !tokens[tokenIndex].enabled)); // 令牌被禁用时立即保存

  if (shouldSave) {
    try {
      await saveTokensToKV(env);
      await saveStatsToKV(env, true); // 强制保存统计数据
      lastKVSaveTime = now;
      pendingUpdates = 0;
      Logger.debug(`批量保存统计数据到KV存储，共${pendingUpdates}条更新`);
    } catch (error) {
      Logger.error("保存统计数据失败:", error);
    }
  }
}

// 获取请求统计信息
function getRequestStats() {
  // 先清理旧数据
  cleanupOldRequestData();

  const now = Date.now();

  // 分钟级统计计算，
  const rpm = requestTimestamps.length; // 分钟请求数
  let tpm = 0;
  for (const count of tokenCounts) {
    tpm += count || 0;
  }

  // 天级统计计算，
  const rpd = requestTimestampsDay.length; // 天请求数
  let tpd = 0;
  for (const count of tokenCountsDay) {
    tpd += count || 0;
  }

  // 计算活跃令牌数和禁用令牌数
  const activeTokens = tokens.filter((token) => token.enabled).length;
  const disabledTokens = tokens.length - activeTokens;

  // 添加更多有用的统计信息
  const tokenDetails = tokens.map((token) => ({
    key: obfuscateKey(token.key),
    enabled: token.enabled,
    usageCount: token.usageCount || 0,
    errorCount: token.errorCount || 0,
    successCount: token.successCount || 0,
    totalTokens: token.totalTokens || 0,
    consecutiveErrors: token.consecutiveErrors || 0,
    lastUsed: token.lastUsed || null,
  }));

  return {
    current: {
      rpm: rpm,
      tpm: tpm,
      rpd: rpd,
      tpd: tpd,
    },
    tokens: {
      total: tokens.length,
      active: activeTokens,
      disabled: disabledTokens,
      details: tokenDetails.slice(0, 5), // 只返回前5个令牌的详细信息，避免响应过大
    },
    updated: new Date().toISOString(),
  };
}

// 处理请求统计API
async function handleRequestStats(req, env) {
  try {
    const stats = getRequestStats();

    // 如果强制刷新，重新加载统计数据和令牌数据
    const forceSave = req.url.includes("force=true");
    if (forceSave) {
      // 尝试重新加载数据
      await Promise.all([loadTokensFromKV(env), loadStatsFromKV(env)]);

      // 重新计算统计
      const refreshedStats = getRequestStats();

      // 强制保存
      try {
        await saveStatsToKV(env, true);
      } catch (error) {
        Logger.error("保存统计数据失败:", error);
      }

      return jsonResponse(
        {
          success: true,
          stats: refreshedStats,
          refreshed: true,
        },
        200
      );
    }

    return jsonResponse(
      {
        success: true,
        stats: stats,
      },
      200
    );
  } catch (error) {
    Logger.error("获取请求统计数据错误:", error);
    return jsonResponse({ success: false, message: "无法获取请求统计数据" }, 500);
  }
}

// ==================== 密码和会话管理 ====================
// 哈希密码
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 验证密码
async function verifyPassword(inputPassword, env) {
  // 直接与定义的默认密码比较
  console.log("正在验证密码...");
  return inputPassword === DEFAULT_ADMIN_PASSWORD;
}

// 生成JWT
async function generateJWT(env) {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "admin",
    iat: now,
    exp: now + 24 * 60 * 60, // 24小时有效期
    jti: crypto.randomUUID(),
  };

  // 获取或生成密钥
  let secretKey = await env.API_TOKENS.get(KV_KEYS.SESSION_SECRET);
  if (!secretKey) {
    secretKey = crypto.randomUUID() + crypto.randomUUID();
    await env.API_TOKENS.put(KV_KEYS.SESSION_SECRET, secretKey);
  }

  // 编码header和payload
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=+$/, "");
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=+$/, "");

  // 生成签名
  const encoder = new TextEncoder();
  const data = encoder.encode(`${encodedHeader}.${encodedPayload}`);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, data);

  // 将签名转换为Base64Url
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  // 组合JWT
  return `${encodedHeader}.${encodedPayload}.${signatureBase64}`;
}

// 验证JWT
async function verifyJWT(token, env) {
  try {
    // 分割JWT
    const [encodedHeader, encodedPayload, signature] = token.split(".");

    // 解码payload
    const payload = JSON.parse(atob(encodedPayload));

    // 检查过期时间
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, reason: "token_expired" };
    }

    // 获取密钥
    const secretKey = await env.API_TOKENS.get(KV_KEYS.SESSION_SECRET);
    if (!secretKey) {
      return { valid: false, reason: "secret_not_found" };
    }

    // 验证签名
    const encoder = new TextEncoder();
    const data = encoder.encode(`${encodedHeader}.${encodedPayload}`);
    const key = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);

    // 将Base64Url签名转换回二进制
    const signatureFixed = signature.replace(/-/g, "+").replace(/_/g, "/");
    const pad = signatureFixed.length % 4;
    const paddedSignature = pad ? signatureFixed + "=".repeat(4 - pad) : signatureFixed;
    const signatureBuffer = Uint8Array.from(atob(paddedSignature), (c) => c.charCodeAt(0));

    // 验证签名
    const isValid = await crypto.subtle.verify("HMAC", key, signatureBuffer, data);

    return { valid: isValid, payload: isValid ? payload : null };
  } catch (error) {
    Logger.error("JWT验证错误:", error);
    return { valid: false, reason: "invalid_token" };
  }
}

// 检查会话
async function checkSession(request, env) {
  // 从Cookie中获取会话token
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((cookie) => {
      const [name, value] = cookie.trim().split("=");
      return [name, value];
    })
  );

  const sessionToken = cookies.session;
  if (!sessionToken) {
    return { authenticated: false, reason: "no_session" };
  }

  // 验证JWT
  const verification = await verifyJWT(sessionToken, env);
  if (!verification.valid) {
    return { authenticated: false, reason: verification.reason };
  }

  return { authenticated: true, user: verification.payload.sub };
}

// 混淆API密钥显示
function obfuscateKey(key) {
  if (!key || key.length <= 8) return "***";
  return key.substring(0, 4) + "..." + key.substring(key.length - 4);
}

// ==================== 余额查询 ====================
// 检查令牌余额
async function checkTokenBalance(token, forceRefresh = false) {
  if (!token) return null;

  // 查找令牌
  const tokenIndex = tokens.findIndex((t) => t.key === token);
  if (tokenIndex === -1) return null;

  // 如果有缓存的余额信息且不强制刷新，直接返回
  if (!forceRefresh && tokens[tokenIndex].balance !== null && tokens[tokenIndex].lastChecked) {
    const lastChecked = new Date(tokens[tokenIndex].lastChecked);
    const now = new Date();
    // 如果缓存时间小于1小时，直接返回缓存
    if (now - lastChecked < 60 * 60 * 1000) {
      return tokens[tokenIndex].balance;
    }
  }

  try {
    // 使用 API_BASE_URL 和 API_ENDPOINTS 中定义的端点
    const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.userInfo}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // 更新令牌余额信息 - 从data.data.totalBalance中获取余额
    if (tokenIndex !== -1) {
      tokens[tokenIndex].balance = (data.data && data.data.totalBalance) || null;
      tokens[tokenIndex].lastChecked = new Date().toISOString();

      // 保存更新后的令牌数据到 KV
      try {
        await saveTokensToKV(env);
        Logger.info(`已保存令牌 ${obfuscateKey(token)} 的余额更新到 KV`);
      } catch (error) {
        Logger.error(`保存令牌余额到 KV 失败: ${error}`);
      }
    }

    return (data.data && data.data.totalBalance) || null;
  } catch (error) {
    Logger.error(`检查令牌余额失败: ${error}`);
    return null;
  }
}

// ==================== API请求处理 ====================
// 处理API请求
async function handleApiRequest(req, path, headers, env) {
  // 选择合适的令牌
  const token = selectTokenForRequest(path);

  if (!token) {
    return jsonResponse(
      {
        error: {
          message: "无可用的API令牌，请联系管理员",
          type: "api_error",
          code: "no_token_available",
        },
      },
      503
    );
  }

  // 记录开始时间
  const startTime = Date.now();

  // 获取请求体
  let requestBody;
  try {
    requestBody = await req.text();
  } catch (error) {
    Logger.error("无法读取请求体:", error);
    return jsonResponse(
      {
        error: {
          message: "无法处理请求数据",
          type: "api_error",
          code: "invalid_request",
        },
      },
      400
    );
  }

  // 重试逻辑
  const MAX_RETRIES = 3; // 自定义修改为您的重试次数
  const RETRY_DELAY_MS = 500;
  let retryCount = 0;
  let tokenUsage = 0;

  while (retryCount <= MAX_RETRIES) {
    try {
      // 构造请求URL
      const url = `${API_BASE_URL}${path}`;

      // 创建请求头，添加授权信息
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Authorization", `Bearer ${token.key}`);

      // 发送请求
      const response = await fetch(url, {
        method: req.method,
        headers: requestHeaders,
        body: req.method !== "GET" ? requestBody : undefined,
        redirect: "follow",
      });

      // 读取响应数据
      const responseText = await response.text();
      let responseData;

      try {
        responseData = JSON.parse(responseText);

        // 提取token使用量
        if (responseData.usage) {
          // 处理不同API返回的token使用量格式
          if (responseData.usage.total_tokens) {
            // 某些API直接返回total_tokens
            tokenUsage = responseData.usage.total_tokens;
          } else if (responseData.usage.prompt_tokens !== undefined && responseData.usage.completion_tokens !== undefined) {
            // 大多数API返回prompt_tokens和completion_tokens
            const promptTokens = responseData.usage.prompt_tokens || 0;
            const completionTokens = responseData.usage.completion_tokens || 0;
            tokenUsage = promptTokens + completionTokens;
            Logger.debug(`请求使用了${tokenUsage}个token (prompt: ${promptTokens}, completion: ${completionTokens})`);
          } else if (responseData.usage.prompt_tokens !== undefined) {
            // 仅返回prompt_tokens的API (如embeddings)
            tokenUsage = responseData.usage.prompt_tokens || 0;
            Logger.debug(`请求使用了${tokenUsage}个prompt token`);
          }
        } else if (path.includes(API_ENDPOINTS.images)) {
          // 图像生成请求的token估算 - 根据DALL-E 3的估算值
          tokenUsage = 4500;
          Logger.debug(`图像生成请求，估算使用了${tokenUsage}个token`);
        } else {
          // 其他请求的默认token估算
          const requestBodyLength = requestBody ? requestBody.length : 0;
          // 粗略估算：每3个字符约为1个token
          tokenUsage = Math.max(10, Math.ceil(requestBodyLength / 3));
          Logger.debug(`无法从响应中获取token使用量，估算使用了${tokenUsage}个token`);
        }

        // 记录详细日志，
        const endTime = Date.now();
        const totalTime = (endTime - startTime) / 1000; // 转换为秒
        Logger.info(`请求完成: 路径=${path}, ` + `状态=${response.status}, ` + `令牌=${obfuscateKey(token.key)}, ` + `用时=${totalTime.toFixed(2)}秒, ` + `Token=${tokenUsage}`);
      } catch (e) {
        Logger.warn(`解析响应数据失败: ${e.message}`);
        responseData = responseText;
        // 默认token估算
        tokenUsage = 10; // 设置一个默认值
      }

      // 更新统计
      const success = response.status >= 200 && response.status < 300;
      await updateTokenStats(token, success, tokenUsage, env);

      // 创建响应
      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", response.headers.get("Content-Type") || "application/json");

      return new Response(responseText, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (error) {
      Logger.error(`API请求失败 (${retryCount + 1}/${MAX_RETRIES + 1}): ${error}`);

      retryCount++;

      // 最后一次重试也失败了
      if (retryCount > MAX_RETRIES) {
        // 更新统计信息
        await updateTokenStats(token, false, 0, env);

        return jsonResponse(
          {
            error: {
              message: "API请求失败，已尝试重试",
              type: "api_error",
              code: "upstream_error",
              details: error.message,
            },
          },
          502
        );
      }

      // 等待一段时间后重试
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * retryCount));
    }
  }
}

// ==================== 令牌管理API ====================
// 处理令牌管理请求
async function handleTokenManagement(req, env) {
  try {
    const data = await req.json();

    // 辅助函数：根据索引或键值获取令牌
    function getTokenByIndexOrKey(indexOrKey) {
      // 尝试将token解析为数字索引
      const tokenIndex = parseInt(indexOrKey);

      if (!isNaN(tokenIndex) && tokenIndex >= 0 && tokenIndex < tokens.length) {
        // 如果是有效的索引，直接返回对应的令牌键值
        return tokens[tokenIndex].key;
      }

      // 否则假设它已经是令牌键值
      return indexOrKey;
    }

    if (data.action === "add") {
      return jsonResponse(await addTokenToKV(env, data.tokens), 200);
    } else if (data.action === "remove") {
      const tokenKey = getTokenByIndexOrKey(data.token);
      return jsonResponse(await removeTokenFromKV(env, tokenKey), 200);
    } else if (data.action === "toggle") {
      const tokenKey = getTokenByIndexOrKey(data.token);
      return jsonResponse(await toggleTokenStatus(env, tokenKey), 200);
    } else if (data.action === "refresh_balance") {
      // 查找令牌 - 支持通过索引或密钥查找
      let tokenData;
      let tokenKey;

      // 尝试将token解析为数字索引
      const tokenIndex = parseInt(data.token);

      if (!isNaN(tokenIndex) && tokenIndex >= 0 && tokenIndex < tokens.length) {
        // 如果是有效的索引，直接获取对应的令牌
        tokenData = tokens[tokenIndex];
        tokenKey = tokenData.key;
      } else {
        // 否则尝试直接通过密钥查找
        tokenData = tokens.find((t) => t.key === data.token);
        tokenKey = data.token;
      }

      Logger.info(`刷新余额请求: 令牌索引/key=${data.token}, 查找结果=${tokenData ? "找到" : "未找到"}`);
      Logger.info(`当前加载的令牌数量: ${tokens.length}`);

      if (!tokenData) {
        return jsonResponse({ success: false, message: "未找到指定的令牌", token: obfuscateKey(data.token) }, 404);
      }

      // 强制刷新余额
      const balance = await checkTokenBalance(tokenKey, true);
      Logger.info(`令牌余额查询结果: ${balance !== null ? balance : "查询失败"}`);

      // 更新令牌数据并保存到 KV
      if (balance !== null) {
        const idx = tokens.findIndex((t) => t.key === tokenKey);
        if (idx !== -1) {
          tokens[idx].balance = balance;
          tokens[idx].lastChecked = new Date().toISOString();
          try {
            await saveTokensToKV(env);
            Logger.info(`已保存令牌 ${obfuscateKey(tokenKey)} 的余额更新到 KV`);
          } catch (error) {
            Logger.error(`保存令牌余额到 KV 失败: ${error}`);
          }
        }
      }

      return jsonResponse(
        {
          success: true,
          balance: balance,
          token: obfuscateKey(tokenKey),
        },
        200
      );
    } else {
      return jsonResponse(
        {
          success: false,
          message: "不支持的操作",
        },
        400
      );
    }
  } catch (error) {
    Logger.error("处理令牌管理请求错误:", error);
    return jsonResponse(
      {
        success: false,
        message: "处理令牌管理请求失败",
      },
      500
    );
  }
}

// 处理令牌列表请求
async function handleTokenList(req, env) {
  try {
    // 加载令牌
    await loadTokensFromKV(env);

    // 混淆API密钥，添加id字段用于前端引用
    const safeTokens = tokens.map((token, index) => ({
      ...token,
      id: index, // 添加唯一ID用于前端引用
      originalKey: token.key, // 保存原始密钥用于复制功能
      key: obfuscateKey(token.key),
    }));

    return jsonResponse(
      {
        success: true,
        tokens: safeTokens,
        count: tokens.length,
      },
      200
    );
  } catch (error) {
    Logger.error("获取令牌列表错误:", error);
    return jsonResponse(
      {
        success: false,
        message: "无法获取令牌列表",
      },
      500
    );
  }
}

// 处理日志设置
async function handleLogSettings(req) {
  try {
    const data = await req.json();

    if (data.logLevel && ["debug", "info", "warn", "error"].includes(data.logLevel)) {
      logLevel = data.logLevel;
      return jsonResponse(
        {
          success: true,
          message: `日志级别已设置为 ${logLevel}`,
          logLevel: logLevel,
        },
        200
      );
    } else {
      return jsonResponse(
        {
          success: false,
          message: "无效的日志级别",
          validLevels: ["debug", "info", "warn", "error"],
          currentLevel: logLevel,
        },
        400
      );
    }
  } catch (error) {
    Logger.error("处理日志设置请求错误:", error);
    return jsonResponse(
      {
        success: false,
        message: "处理日志设置请求失败",
      },
      500
    );
  }
}

// 处理登录请求
async function handleLogin(req, env) {
  try {
    const data = await req.json();

    if (!data.password) {
      return jsonResponse(
        {
          success: false,
          message: "密码不能为空",
        },
        400
      );
    }

    console.log("正在验证密码...");

    // 验证密码
    const isValid = await verifyPassword(data.password, env);

    if (!isValid) {
      console.log("密码验证失败");
      return jsonResponse(
        {
          success: false,
          message: "密码错误",
        },
        401
      );
    }

    // 生成JWT
    const token = await generateJWT(env);

    // 创建带Cookie的响应
    const response = jsonResponse(
      {
        success: true,
        message: "登录成功",
      },
      200
    );

    // 设置会话Cookie
    response.headers.set("Set-Cookie", `session=${token}; HttpOnly; Path=/; Max-Age=${24 * 60 * 60}; SameSite=Strict`);

    console.log("登录处理完成，返回响应");
    return response;
  } catch (error) {
    console.error("处理登录请求错误:", error);
    return jsonResponse(
      {
        success: false,
        message: "登录处理失败: " + error.message,
      },
      500
    );
  }
}

// ==================== 主请求处理 ====================
// 处理请求
async function handleRequest(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  // 允许本地开发跨域
  let headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });

  // 处理预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  // 加载令牌
  await loadTokensFromKV(env);

  // 加载统计数据
  await loadStatsFromKV(env);

  // 静态页面路由
  if ((path === "/" || path === "/login") && req.method === "GET") {
    return new Response(loginHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  if (path === "/dashboard") {
    // 检查会话
    const session = await checkSession(req, env);
    if (!session.authenticated) {
      // 重定向到登录页面
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/login",
        },
      });
    }

    return new Response(dashboardHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // API路由
  if (path === "/login" && req.method === "POST") {
    return handleLogin(req, env);
  }

  if (path === "/api/tokens" && req.method === "GET") {
    // 检查会话
    const session = await checkSession(req, env);
    if (!session.authenticated) {
      return jsonResponse({ success: false, message: "未授权访问" }, 401);
    }

    return handleTokenList(req, env);
  }

  if (path === "/api/tokens" && req.method === "POST") {
    // 检查会话
    const session = await checkSession(req, env);
    if (!session.authenticated) {
      return jsonResponse({ success: false, message: "未授权访问" }, 401);
    }

    return handleTokenManagement(req, env);
  }

  if (path === "/api/stats") {
    // 检查会话
    const session = await checkSession(req, env);
    if (!session.authenticated) {
      return jsonResponse({ success: false, message: "未授权访问" }, 401);
    }

    return handleRequestStats(req, env);
  }

  if (path === "/api/logs/settings" && req.method === "POST") {
    // 检查会话
    const session = await checkSession(req, env);
    if (!session.authenticated) {
      return jsonResponse({ success: false, message: "未授权访问" }, 401);
    }

    return handleLogSettings(req);
  }

  // API转发路由
  // 匹配各种API端点
  for (const [key, endpoint] of Object.entries(API_ENDPOINTS)) {
    if (path.startsWith(`/${key}`) || path === endpoint) {
      let apiPath = path;

      // 如果路径是形如 /chat 的简短路径，转换为完整的API路径
      if (path.startsWith(`/${key}`)) {
        apiPath = endpoint + path.substring(key.length + 1);
      }

      return handleApiRequest(req, apiPath, req.headers, env);
    }
  }

  // 未找到路由
  return jsonResponse(
    {
      error: "Not Found",
      message: "The requested resource does not exist",
    },
    404
  );
}

// 辅助函数：创建JSON响应
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
    },
  });
}

// 导出Worker处理程序
export default {
  async fetch(request, env, ctx) {
    try {
      // 检查 KV 是否正确绑定
      if (!env.API_TOKENS) {
        console.error("API_TOKENS KV 命名空间未绑定");
        return jsonResponse(
          {
            error: "配置错误",
            message: "KV存储未正确配置",
          },
          500
        );
      }
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Worker处理请求错误:", error);
      return jsonResponse(
        {
          error: "Internal Server Error",
          message: "服务器内部错误: " + error.message,
        },
        500
      );
    }
  },

  // 定期任务
  async scheduled(event, env, ctx) {
    Logger.info("执行定期任务");

    try {
      // 加载令牌
      await loadTokensFromKV(env);

      // 加载统计数据
      await loadStatsFromKV(env);

      // 清理旧数据
      cleanupOldRequestData();

      // 检查禁用的令牌，尝试恢复长时间未使用的令牌
      const now = Date.now();
      const ONE_DAY = 24 * 60 * 60 * 1000;
      let tokensChanged = false;

      tokens.forEach((token, index) => {
        // 如果令牌已禁用且最后错误时间超过一天，尝试恢复
        if (!token.enabled && token.lastErrorTime && now - new Date(token.lastErrorTime).getTime() > ONE_DAY) {
          Logger.info(`尝试恢复禁用令牌: ${obfuscateKey(token.key)}`);
          tokens[index].enabled = true;
          tokens[index].consecutiveErrors = 0;
          tokensChanged = true;
        }
      });

      // 如果令牌状态有变化，保存更新
      if (tokensChanged) {
        await saveTokensToKV(env);
      }

      // 强制保存所有统计数据
      await saveStatsToKV(env, true);

      // 重置批量保存计数器
      pendingUpdates = 0;
      lastKVSaveTime = Date.now();

      Logger.info("定期任务完成");
    } catch (error) {
      Logger.error("定期任务执行错误:", error);
    }
  },
};

// ==================== HTML页面模板 ====================
// 登录页面HTML
const loginHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API管理系统 - 登录</title>
  <style>
    :root {
      --primary-color: #4CAF50;
      --primary-dark: #3e8e41;
      --error-color: #f44336;
      --text-color: #333;
      --bg-color: #f5f5f5;
      --card-bg: white;
      --box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.08);
    }
    
    body {
      font-family: 'Arial', sans-serif;
      background-color: var(--bg-color);
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      transition: background-color 0.3s;
    }
    
    .login-container {
      background-color: var(--card-bg);
      padding: 40px;
      border-radius: 12px;
      box-shadow: var(--box-shadow);
      width: 100%;
      max-width: 400px;
      transition: all 0.3s;
    }
    
    .system-icon {
      text-align: center;
      margin-bottom: 20px;
      font-size: 3rem;
      color: var(--primary-color);
    }
    
    h1 {
      color: var(--text-color);
      text-align: center;
      margin-bottom: 24px;
      font-size: 1.8rem;
    }
    
    form {
      display: flex;
      flex-direction: column;
    }
    
    label {
      margin-bottom: 8px;
      font-weight: bold;
      color: var(--text-color);
    }
    
    input {
      padding: 15px;
      margin-bottom: 20px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 16px;
      transition: border 0.3s, box-shadow 0.3s;
    }
    
    input:focus {
      outline: none;
      border-color: var(--primary-color);
      box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
    }
    
    button {
      background-color: var(--primary-color);
      color: white;
      border: none;
      padding: 15px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      font-weight: bold;
      letter-spacing: 0.5px;
      transition: background-color 0.3s, transform 0.2s;
    }
    
    button:hover {
      background-color: var(--primary-dark);
    }
    
    button:active {
      transform: translateY(1px);
    }
    
    .error-message {
      color: var(--error-color);
      margin-bottom: 16px;
      text-align: center;
      font-size: 14px;
      height: 20px;
      transition: all 0.3s;
    }
    
    .login-info {
      margin-top: 30px;
      text-align: center;
      font-size: 13px;
      color: #888;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="system-icon">🔐</div>
    <h1>API管理系统</h1>
    <div id="errorMessage" class="error-message"></div>
    <form id="loginForm" method="post" action="/login">
      <label for="password">请输入管理密码</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">登录</button>
    </form>
    <div class="login-info">
      此系统用于API号池管理，仅限授权人员访问
    </div>
  </div>
  
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const password = document.getElementById('password').value;
      const submitButton = document.querySelector('button');
      const errorMessage = document.getElementById('errorMessage');
      
      // 禁用按钮，显示加载状态
      submitButton.textContent = '登录中...';
      submitButton.disabled = true;
      errorMessage.textContent = '';
      
      try {
        console.log('正在发送登录请求...');
        const response = await fetch('/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ password }),
          credentials: 'same-origin' // 确保包含cookie
        });
        
        console.log('收到登录响应:', response.status);
        
        let data;
        try {
          data = await response.json();
        } catch (error) {
          console.error('解析响应JSON失败:', error);
          throw new Error('无法解析服务器响应');
        }
        
        if (response.ok) {
          errorMessage.textContent = '登录成功，正在跳转...';
          errorMessage.style.color = '#4CAF50';
          
          // 延迟跳转以显示成功消息
          setTimeout(() => {
            window.location.href = '/dashboard';
          }, 1000);
        } else {
          errorMessage.textContent = data?.message || '密码错误';
          submitButton.textContent = '登录';
          submitButton.disabled = false;
        }
      } catch (error) {
        console.error('Login error:', error);
        errorMessage.textContent = '登录请求失败，请重试';
        submitButton.textContent = '登录';
        submitButton.disabled = false;
      }
    });
  </script>
</body>
</html>
`;

// 正确定义 dashboardHtml 模板字符串
const dashboardHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API管理系统 - 控制面板</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.2/font/bootstrap-icons.css">
  <style>
    :root {
      --primary-color: #4CAF50;
      --primary-dark: #3e8e41;
      --error-color: #f44336;
      --warning-color: #ff9800;
      --success-color: #4CAF50;
      --text-color: #333;
      --bg-color: #f5f5f5;
      --card-bg: white;
      --box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.08);
    }
    
    body {
      font-family: 'Arial', sans-serif;
      background-color: var(--bg-color);
      color: var(--text-color);
      min-height: 100vh;
      padding-bottom: 40px;
    }
    
    .navbar {
      background-color: var(--primary-color);
      box-shadow: var(--box-shadow);
    }
    
    .navbar-brand {
      color: white;
      font-weight: bold;
    }
    
    .navbar-brand:hover {
      color: white;
    }
    
    .dashboard-card {
      background-color: var(--card-bg);
      border-radius: 8px;
      box-shadow: var(--box-shadow);
      padding: 20px;
      margin-bottom: 20px;
      transition: all 0.3s;
    }
    
    .dashboard-card:hover {
      box-shadow: 0 7px 14px rgba(0, 0, 0, 0.1), 0 3px 6px rgba(0, 0, 0, 0.08);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 10px;
      border-bottom: 1px solid #eee;
      margin-bottom: 15px;
    }
    
    .card-title {
      font-size: 1.4rem;
      font-weight: bold;
      margin: 0;
      color: var(--primary-color);
    }
    
    .stats-container {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
    }
    
    .stat-card {
      padding: 15px;
      background-color: #f8f9fa;
      border-radius: 8px;
      text-align: center;
    }
    
    .stat-title {
      font-size: 1rem;
      color: #666;
      margin-bottom: 5px;
    }
    
    .stat-value {
      font-size: 2rem;
      font-weight: bold;
      color: var(--primary-color);
    }
    
    .stats-info {
      font-size: 0.8rem;
      color: #999;
      margin-top: 5px;
      text-align: right;
    }
    
    .token-management textarea {
      resize: vertical;
      min-height: 100px;
    }
    
    .token-table {
      width: 100%;
      overflow-x: auto;
    }
    
    .token-table th {
      position: sticky;
      top: 0;
      background-color: #f8f9fa;
      z-index: 10;
    }
    
    .token-status {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 5px;
    }
    
    .status-enabled {
      background-color: var(--success-color);
    }
    
    .status-disabled {
      background-color: var(--error-color);
    }
    
    .copy-btn {
      cursor: pointer;
      padding: 0 5px;
      color: #666;
      transition: color 0.2s;
    }
    
    .copy-btn:hover {
      color: var(--primary-color);
    }
    
    .table-actions {
      display: flex;
      gap: 10px;
    }
    
    .balance-display {
      font-weight: bold;
    }
    
    #addTokenForm button, #batchActionsForm button {
      background-color: var(--primary-color);
      border-color: var(--primary-color);
    }
    
    #addTokenForm button:hover, #batchActionsForm button:hover {
      background-color: var(--primary-dark);
      border-color: var(--primary-dark);
    }
    
    .badge-enabled {
      background-color: var(--success-color);
    }
    
    .badge-disabled {
      background-color: var(--error-color);
    }
    
    .row-selected {
      background-color: rgba(76, 175, 80, 0.1);
    }
    
    .refresh-btn {
      cursor: pointer;
      color: #666;
      transition: transform 0.3s;
    }
    
    .refresh-btn:hover {
      color: var(--primary-color);
    }
    
    .refresh-btn.spinning {
      animation: spin 1s infinite linear;
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .text-truncate-custom {
      max-width: 120px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: inline-block;
    }
    
    .alert-message {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 9999;
      max-width: 300px;
      transition: opacity 0.5s, transform 0.3s;
      transform: translateY(-20px);
      opacity: 0;
    }
    
    .alert-message.show {
      transform: translateY(0);
      opacity: 1;
    }
    
    @media (max-width: 768px) {
      .stats-container {
        grid-template-columns: 1fr;
      }
      
      .token-table {
        font-size: 0.8rem;
      }
      
      .text-truncate-custom {
        max-width: 80px;
      }
    }
  </style>
</head>
<body>
  <nav class="navbar navbar-expand-lg navbar-dark mb-4">
    <div class="container">
      <a class="navbar-brand" href="/dashboard">
        <i class="bi bi-speedometer2 me-2"></i>API管理系统
      </a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav ms-auto">
          <li class="nav-item">
            <a class="nav-link text-white" href="#" id="logoutBtn">
              <i class="bi bi-box-arrow-right me-1"></i>退出登录
            </a>
          </li>
        </ul>
      </div>
    </div>
  </nav>
  
  <div class="container">
    <!-- 统计卡片 -->
    <div class="dashboard-card">
      <div class="card-header">
        <h2 class="card-title">
          <i class="bi bi-graph-up me-2"></i>实时统计
        </h2>
        <span class="refresh-btn" id="refreshStats" title="刷新统计数据">
          <i class="bi bi-arrow-repeat"></i>
        </span>
      </div>
      <div class="stats-container">
        <div class="stat-card">
          <div class="stat-title">请求速率 (每分钟)</div>
          <div class="stat-value" id="rpm">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Token 使用量 (每分钟)</div>
          <div class="stat-value" id="tpm">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">请求速率 (每天)</div>
          <div class="stat-value" id="rpd">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">Token 使用量 (每天)</div>
          <div class="stat-value" id="tpd">-</div>
        </div>
      </div>
      <div class="stats-info mt-3" id="statsUpdated">更新时间: -</div>
    </div>
    
    <!-- 令牌管理卡片 -->
    <div class="dashboard-card">
      <div class="card-header">
        <h2 class="card-title">
          <i class="bi bi-key me-2"></i>令牌管理
        </h2>
        <span class="badge bg-primary" id="tokenCount">0 个令牌</span>
      </div>
      
      <!-- 添加令牌表单 -->
      <form id="addTokenForm" class="mb-4">
        <div class="mb-3">
          <label for="tokenInput" class="form-label">添加令牌(支持多个令牌，用换行或逗号分隔)</label>
          <textarea class="form-control" id="tokenInput" rows="3" placeholder="在此输入一个或多个API令牌..."></textarea>
        </div>
        <button type="submit" class="btn btn-primary">
          <i class="bi bi-plus-circle me-1"></i>添加令牌
        </button>
      </form>
      
      <!-- 批量操作表单 -->
      <form id="batchActionsForm" class="mb-4">
        <div class="d-flex flex-wrap gap-2">
          <button type="button" id="enableSelectedBtn" class="btn btn-success btn-sm" disabled>
            <i class="bi bi-check-circle me-1"></i>启用所选
          </button>
          <button type="button" id="disableSelectedBtn" class="btn btn-warning btn-sm" disabled>
            <i class="bi bi-slash-circle me-1"></i>禁用所选
          </button>
          <button type="button" id="deleteSelectedBtn" class="btn btn-danger btn-sm" disabled>
            <i class="bi bi-trash me-1"></i>删除所选
          </button>
          <button type="button" id="refreshBalanceBtn" class="btn btn-info btn-sm text-white" disabled>
            <i class="bi bi-currency-exchange me-1"></i>刷新余额
          </button>
          <div class="ms-auto">
            <div class="input-group">
              <input type="text" class="form-control form-control-sm" id="tokenSearch" placeholder="搜索令牌...">
              <button type="button" id="clearSearchBtn" class="btn btn-outline-secondary btn-sm">
                <i class="bi bi-x"></i>
              </button>
            </div>
          </div>
        </div>
      </form>
      
      <!-- 令牌表格 -->
      <div class="token-table table-responsive">
        <table class="table table-hover">
          <thead>
            <tr>
              <th width="40px">
                <input class="form-check-input" type="checkbox" id="selectAllTokens">
              </th>
              <th width="50px">#</th>
              <th>令牌</th>
              <th>状态</th>
              <th>余额</th>
              <th>使用/错误</th>
              <th>添加时间</th>
              <th>最后使用</th>
              <th width="120px">操作</th>
            </tr>
          </thead>
          <tbody id="tokenTableBody">
            <!-- 令牌列表将在此动态加载 -->
          </tbody>
        </table>
      </div>
      <div id="emptyTokenMessage" class="alert alert-info text-center d-none">
        暂无令牌，请添加新令牌
      </div>
    </div>
  </div>
  
  <!-- 弹出消息 -->
  <div class="alert-message alert" id="alertMessage"></div>
  
  <!-- 引入Bootstrap脚本 -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // 初始化变量
      let tokens = [];
      let selectedTokens = new Set();
      let statsRefreshInterval;
      
      // DOM元素
      const tokenTableBody = document.getElementById('tokenTableBody');
      const tokenCount = document.getElementById('tokenCount');
      const emptyTokenMessage = document.getElementById('emptyTokenMessage');
      
      // 批量操作按钮
      const enableSelectedBtn = document.getElementById('enableSelectedBtn');
      const disableSelectedBtn = document.getElementById('disableSelectedBtn');
      const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
      const refreshBalanceBtn = document.getElementById('refreshBalanceBtn');
      
      // 统计数据元素
      const rpmElement = document.getElementById('rpm');
      const tpmElement = document.getElementById('tpm');
      const rpdElement = document.getElementById('rpd');
      const tpdElement = document.getElementById('tpd');
      const statsUpdated = document.getElementById('statsUpdated');
      
      // 初始化页面
      refreshTokenList();
      refreshStats();
      
      // 设置定时刷新统计数据
      statsRefreshInterval = setInterval(refreshStats, 30000);
      
      // 添加令牌表单提交
      document.getElementById('addTokenForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const tokenInput = document.getElementById('tokenInput').value.trim();
        
        if (!tokenInput) {
          showAlert('请输入至少一个令牌', 'warning');
          return;
        }
        
        try {
          const response = await fetch('/api/tokens', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'add',
              tokens: tokenInput
            }),
            credentials: 'same-origin'
          });
          
          const data = await response.json();
          
          if (response.ok) {
            document.getElementById('tokenInput').value = '';
            showAlert(data.message, 'success');
            refreshTokenList();
          } else {
            showAlert(data.message || '添加令牌失败', 'danger');
          }
        } catch (error) {
          console.error('Add token error:', error);
          showAlert('请求失败，请重试', 'danger');
        }
      });
      
      // 刷新统计按钮点击
      document.getElementById('refreshStats').addEventListener('click', function() {
        const refreshBtn = this;
        refreshBtn.classList.add('spinning');
        
        refreshStats(true).finally(() => {
          setTimeout(() => {
            refreshBtn.classList.remove('spinning');
          }, 500);
        });
      });
      
      // 选择全部复选框
      document.getElementById('selectAllTokens').addEventListener('change', function() {
        const isChecked = this.checked;
        
        document.querySelectorAll('.token-checkbox').forEach(checkbox => {
          checkbox.checked = isChecked;
          
          const tokenKey = checkbox.getAttribute('data-token');
          if (isChecked) {
            selectedTokens.add(tokenKey);
          } else {
            selectedTokens.delete(tokenKey);
          }
          
          const row = checkbox.closest('tr');
          if (isChecked) {
            row.classList.add('row-selected');
          } else {
            row.classList.remove('row-selected');
          }
        });
        
        updateBatchActionButtons();
      });
      
      // 批量启用按钮点击
      enableSelectedBtn.addEventListener('click', function() {
        batchToggleStatus(Array.from(selectedTokens), true);
      });
      
      // 批量禁用按钮点击
      disableSelectedBtn.addEventListener('click', function() {
        batchToggleStatus(Array.from(selectedTokens), false);
      });
      
      // 批量删除按钮点击
      deleteSelectedBtn.addEventListener('click', function() {
        if (confirm("确定要删除选中的 " + selectedTokens.size + " 个令牌吗？")) {
          batchDeleteTokens(Array.from(selectedTokens));
        }
      });
      
      // 批量刷新余额按钮点击
      refreshBalanceBtn.addEventListener('click', function() {
        batchRefreshBalance(Array.from(selectedTokens));
      });
      
      // 搜索令牌
      document.getElementById('tokenSearch').addEventListener('input', function() {
        filterTokenTable(this.value);
      });
      
      // 清除搜索
      document.getElementById('clearSearchBtn').addEventListener('click', function() {
        document.getElementById('tokenSearch').value = '';
        filterTokenTable('');
      });
      
      // 登出按钮点击
      document.getElementById('logoutBtn').addEventListener('click', function(e) {
        e.preventDefault();
        
        // 清除Cookie并跳转到登录页面
        document.cookie = 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
        window.location.href = '/login';
      });
      
      // 刷新令牌列表
      async function refreshTokenList() {
        try {
          const response = await fetch('/api/tokens', {
            credentials: 'same-origin'
          });
          
          if (!response.ok) {
            // 如果是401未授权，可能是会话已过期，重定向到登录页面
            if (response.status === 401) {
              window.location.href = '/login';
              return;
            }
            throw new Error('Token list request failed');
          }
          
          const data = await response.json();
          
          tokens = data.tokens || [];
          tokenCount.textContent = tokens.length + " 个令牌";
          
          // 清空选择
          selectedTokens.clear();
          updateBatchActionButtons();
          
          // 刷新表格
          renderTokenTable();
        } catch (error) {
          console.error('Error fetching token list:', error);
          showAlert('获取令牌列表失败，请刷新页面', 'danger');
        }
      }
      
      // 渲染令牌表格
      function renderTokenTable() {
        tokenTableBody.innerHTML = '';
        
        if (tokens.length === 0) {
          emptyTokenMessage.classList.remove('d-none');
          return;
        }
        
        emptyTokenMessage.classList.add('d-none');
        
        tokens.forEach((token, index) => {
          const row = document.createElement('tr');
          row.innerHTML = 
            '<td>' +
              '<input class="form-check-input token-checkbox" type="checkbox" data-token="' + index + '">' +
            '</td>' +
            '<td>' + (index + 1) + '</td>' +
            '<td>' +
              '<span class="text-truncate-custom" title="' + token.key + '">' + token.key + '</span>' +
              '<span class="copy-btn" data-token="' + index + '" title="复制令牌">' +
                '<i class="bi bi-clipboard"></i>' +
              '</span>' +
            '</td>' +
            '<td>' +
              '<span class="badge ' + (token.enabled ? 'badge-enabled' : 'badge-disabled') + '">' +
                (token.enabled ? '启用' : '禁用') +
              '</span>' +
            '</td>' +
            '<td>' +
              '<span class="balance-display" id="balance-' + index + '">' +
                (token.balance !== null ? token.balance : '-') +
              '</span>' +
              '<span class="refresh-btn refresh-balance" data-token="' + index + '" data-index="' + index + '" title="刷新余额">' +
                '<i class="bi bi-arrow-repeat"></i>' +
              '</span>' +
            '</td>' +
            '<td>' + (token.usageCount || 0) + ' / ' + (token.errorCount || 0) + '</td>' +
            '<td>' + (token.addedAt || '-') + '</td>' +
            '<td>' + (token.lastUsed || '-') + '</td>' +
            '<td class="table-actions">' +
              '<button type="button" class="btn btn-sm ' + (token.enabled ? 'btn-warning' : 'btn-success') + ' toggle-status" data-token="' + index + '">' +
                '<i class="bi ' + (token.enabled ? 'bi-slash-circle' : 'bi-check-circle') + '"></i>' +
              '</button>' +
              '<button type="button" class="btn btn-sm btn-danger delete-token" data-token="' + index + '">' +
                '<i class="bi bi-trash"></i>' +
              '</button>' +
            '</td>';
          
          tokenTableBody.appendChild(row);
        });
        
        // 复制令牌点击事件
        document.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            const tokenIndex = parseInt(this.getAttribute('data-token'));
            // 获取原始令牌数据
            const originalToken = tokens[tokenIndex]?.originalKey || tokens[tokenIndex]?.key;
            
            if (originalToken) {
              navigator.clipboard.writeText(originalToken).then(() => {
                showAlert('已复制令牌', 'success');
              }).catch(err => {
                console.error('复制失败: ', err);
                showAlert('复制失败', 'danger');
              });
            } else {
              showAlert('无法获取令牌信息', 'danger');
            }
          });
        });
        
        // 切换状态按钮点击事件
        document.querySelectorAll('.toggle-status').forEach(btn => {
          btn.addEventListener('click', function() {
            const tokenIndex = parseInt(this.getAttribute('data-token'));
            const tokenKey = tokens[tokenIndex]?.originalKey;
            if (tokenKey) {
              toggleTokenStatus(tokenKey);
            } else {
              showAlert('无法获取令牌信息', 'danger');
            }
          });
        });
        
        // 删除令牌按钮点击事件
        document.querySelectorAll('.delete-token').forEach(btn => {
          btn.addEventListener('click', function() {
            const tokenIndex = parseInt(this.getAttribute('data-token'));
            const tokenKey = tokens[tokenIndex]?.originalKey;
            if (tokenKey && confirm('确定要删除此令牌吗？')) {
              deleteToken(tokenKey);
            } else if (!tokenKey) {
              showAlert('无法获取令牌信息', 'danger');
            }
          });
        });
        
        // 刷新余额按钮点击事件
        document.querySelectorAll('.refresh-balance').forEach(btn => {
          btn.addEventListener('click', function() {
            const tokenIndex = parseInt(this.getAttribute('data-token'));
            const index = parseInt(this.getAttribute('data-index'));
            refreshTokenBalance(tokenIndex, index);
          });
        });
        
        // 令牌复选框点击事件
        document.querySelectorAll('.token-checkbox').forEach(checkbox => {
          checkbox.addEventListener('change', function() {
            const tokenKey = this.getAttribute('data-token');
            
            if (this.checked) {
              selectedTokens.add(tokenKey);
              this.closest('tr').classList.add('row-selected');
            } else {
              selectedTokens.delete(tokenKey);
              this.closest('tr').classList.remove('row-selected');
            }
            
            updateBatchActionButtons();
          });
        });
      }
      
      // 刷新统计数据
      async function refreshStats(force = false) {
        try {
          const url = force ? '/api/stats?force=true' : '/api/stats';
          const response = await fetch(url, {
            credentials: 'same-origin'
          });
          
          if (!response.ok) {
            throw new Error('Stats request failed');
          }
          
          const data = await response.json();
          
          if (data.success && data.stats) {
            rpmElement.textContent = data.stats.current.rpm;
            tpmElement.textContent = data.stats.current.tpm;
            rpdElement.textContent = data.stats.current.rpd;
            tpdElement.textContent = data.stats.current.tpd;
            
            const updatedDate = new Date(data.stats.updated);
            statsUpdated.textContent = "更新时间: " + updatedDate.toLocaleString();
          }
        } catch (error) {
          console.error('Error fetching stats:', error);
        }
      }
      
      // 切换令牌状态
      async function toggleTokenStatus(tokenKey) {
        try {
          const response = await fetch('/api/tokens', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'toggle',
              token: tokenKey
            }),
            credentials: 'same-origin'
          });
          
          const data = await response.json();
          
          if (response.ok) {
            showAlert(data.message, 'success');
            refreshTokenList();
          } else {
            showAlert(data.message || '操作失败', 'danger');
          }
        } catch (error) {
          console.error('Toggle token status error:', error);
          showAlert('请求失败，请重试', 'danger');
        }
      }
      
      // 删除令牌
      async function deleteToken(tokenKey) {
        try {
          const response = await fetch('/api/tokens', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'remove',
              token: tokenKey
            }),
            credentials: 'same-origin'
          });
          
          const data = await response.json();
          
          if (response.ok) {
            showAlert(data.message, 'success');
            refreshTokenList();
          } else {
            showAlert(data.message || '删除失败', 'danger');
          }
        } catch (error) {
          console.error('Delete token error:', error);
          showAlert('请求失败，请重试', 'danger');
        }
      }
      
      // 批量切换状态
      async function batchToggleStatus(tokenKeys, enable) {
        if (tokenKeys.length === 0) return;
        
        const actionText = enable ? '启用' : '禁用';
        const totalTokens = tokenKeys.length;
        let processed = 0;
        let successful = 0;
        let skipped = 0;
        
        showAlert("正在" + actionText + "选中的令牌 (0/" + totalTokens + ")...", 'info');
        
        // 逐个处理以避免请求过多
        for (const tokenKey of tokenKeys) {
          try {
            // 找到令牌在数组中的索引
            const tokenIndex = parseInt(tokenKey);
            const token = tokens[tokenIndex];
            
            // 如果令牌已经处于目标状态，则跳过
            if ((enable && token.enabled) || (!enable && !token.enabled)) {
              processed++;
              skipped++;
              continue;
            }
            
            const response = await fetch('/api/tokens', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                action: 'toggle',
                token: tokenKey
              }),
              credentials: 'same-origin'
            });
            
            processed++;
            
            if (response.ok) {
              successful++;
            }
            
            // 更新提示
            if (processed % 5 === 0 || processed === totalTokens) {
              showAlert("正在" + actionText + "选中的令牌 (" + processed + "/" + totalTokens + ")...", 'info');
            }
          } catch (error) {
            console.error("Error toggling token " + tokenKey + ":", error);
          }
        }
        
        // 完成后刷新
        let resultMessage = "已" + actionText + " " + successful + "/" + totalTokens + " 个令牌";
        if (skipped > 0) {
          resultMessage += " (跳过 " + skipped + " 个已" + actionText + "的令牌)";
        }
        showAlert(resultMessage, 'success');
        refreshTokenList();
      }
      
      // 批量删除令牌
      async function batchDeleteTokens(tokenKeys) {
        if (tokenKeys.length === 0) return;

        const totalTokens = tokenKeys.length;
        let processed = 0;
        let successful = 0;
        let failed = [];

        showAlert("正在删除选中的令牌 (0/" + totalTokens + ")...", "info");

        // 获取原始令牌值
        const tokensToDelete = tokenKeys.map(index => {
          const token = tokens[parseInt(index)];
          return token?.originalKey || token?.key;
        }).filter(key => key); // 过滤掉无效的令牌

        // 分批处理，每批5个
        const batchSize = 5;
        for (let i = 0; i < tokensToDelete.length; i += batchSize) {
          const batch = tokensToDelete.slice(i, i + batchSize);
          
          // 对每个批次进行处理
          for (const tokenKey of batch) {
            try {
              const response = await fetch("/api/tokens", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  action: "remove",
                  token: tokenKey
                }),
                credentials: "same-origin"
              });

              const result = await response.json();
              processed++;

              if (response.ok && result.success) {
                successful++;
              } else {
                failed.push(tokenKey);
                console.error("删除令牌失败: " + tokenKey + ", 原因: " + (result.message || "未知错误"));
              }

              // 更新提示
              showAlert("正在删除选中的令牌 (" + processed + "/" + totalTokens + ")...", "info");
            } catch (error) {
              processed++;
              failed.push(tokenKey);
              console.error("删除令牌出错: " + tokenKey + ", 错误: " + error);
            }
          }

          // 每批处理完后稍作等待
          if (i + batchSize < tokensToDelete.length) {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }

        // 完成后显示结果
        let message = "已删除 " + successful + "/" + totalTokens + " 个令牌";
        if (failed.length > 0) {
          message += "，" + failed.length + " 个令牌删除失败";
          console.error("删除失败的令牌:", failed);
        }
        showAlert(message, successful === totalTokens ? "success" : "warning");

        // 刷新令牌列表
        refreshTokenList();
      }
      
      // 刷新令牌余额
      async function refreshTokenBalance(tokenKey, index) {
        const balanceElement = document.getElementById("balance-" + index);
        const refreshBtn = balanceElement.nextElementSibling;
        
        // 显示加载状态
        balanceElement.textContent = '加载中...';
        refreshBtn.classList.add('spinning');
        
        console.log('准备刷新令牌余额: key=' + tokenKey + ', index=' + index);
        
        try {
          const requestData = {
            action: 'refresh_balance',
            token: tokenKey
          };
          console.log('发送请求数据:', requestData);
          
          const response = await fetch('/api/tokens', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestData),
            credentials: 'same-origin'
          });
          
          console.log('响应状态:', response.status);
          const data = await response.json();
          console.log('响应数据:', data);
          
          if (response.ok && data.success) {
            balanceElement.textContent = data.balance !== null ? data.balance : '-';
            
            // 更新本地令牌数据
            const tokenIndex = tokens.findIndex(t => t.id === index);
            if (tokenIndex !== -1) {
              tokens[tokenIndex].balance = data.balance;
              tokens[tokenIndex].lastChecked = new Date().toISOString();
            }
          } else {
            console.error('刷新余额失败:', data.message || '未知错误');
            balanceElement.textContent = '查询失败';
            setTimeout(() => {
              balanceElement.textContent = '-';
            }, 2000);
          }
        } catch (error) {
          console.error('刷新余额失败:', error);
          balanceElement.textContent = '查询失败';
          setTimeout(() => {
            balanceElement.textContent = '-';
          }, 2000);
        } finally {
          refreshBtn.classList.remove('spinning');
        }
      }
      
      // 批量刷新余额
      async function batchRefreshBalance(tokenKeys) {
        if (tokenKeys.length === 0) return;
        
        const totalTokens = tokenKeys.length;
        showAlert("正在刷新选中令牌的余额 (0/" + totalTokens + ")...", 'info');
        
        let processed = 0;
        
        // 找到所有选中的令牌
        for (const tokenIndex of tokenKeys) {
          // 将字符串索引转换为数字
          const index = parseInt(tokenIndex);
          if (index >= 0 && index < tokens.length) {
            await refreshTokenBalance(index, index);
            processed++;
            
            // 更新提示
            if (processed % 3 === 0 || processed === totalTokens) {
              showAlert("正在刷新选中令牌的余额 (" + processed + "/" + totalTokens + ")...", 'info');
            }
          }
        }
        
        showAlert("已刷新 " + processed + "/" + totalTokens + " 个令牌的余额", 'success');
      }
      
      // 筛选令牌表格
      function filterTokenTable(searchText) {
        const rows = tokenTableBody.querySelectorAll('tr');
        const searchLower = searchText.toLowerCase();
        
        rows.forEach(row => {
          const tokenCell = row.querySelector('td:nth-child(3)');
          if (!tokenCell) return;
          
          const tokenText = tokenCell.textContent.toLowerCase();
          
          if (searchText === '' || tokenText.includes(searchLower)) {
            row.style.display = '';
          } else {
            row.style.display = 'none';
          }
        });
      }
      
      // 更新批量操作按钮状态
      function updateBatchActionButtons() {
        const hasSelected = selectedTokens.size > 0;
        
        enableSelectedBtn.disabled = !hasSelected;
        disableSelectedBtn.disabled = !hasSelected;
        deleteSelectedBtn.disabled = !hasSelected;
        refreshBalanceBtn.disabled = !hasSelected;
        
        // 更新全选框状态
        const selectAllCheckbox = document.getElementById('selectAllTokens');
        const checkboxes = document.querySelectorAll('.token-checkbox');
        
        if (checkboxes.length > 0 && selectedTokens.size === checkboxes.length) {
          selectAllCheckbox.checked = true;
          selectAllCheckbox.indeterminate = false;
        } else if (selectedTokens.size > 0) {
          selectAllCheckbox.checked = false;
          selectAllCheckbox.indeterminate = true;
        } else {
          selectAllCheckbox.checked = false;
          selectAllCheckbox.indeterminate = false;
        }
      }
      
      // 显示提醒消息
      function showAlert(message, type = 'info') {
        const alertElement = document.getElementById('alertMessage');
        alertElement.className = "alert-message alert alert-" + type;
        alertElement.textContent = message;
        alertElement.classList.add('show');
        
        // 自动消失
        setTimeout(() => {
          alertElement.classList.remove('show');
        }, 3000);
      }
    });
  </script>
</body>
</html>
`;
