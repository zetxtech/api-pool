// ctrl+f 搜索 自定义 ，修改你需要自定义的配置
// ==================== 常量定义 ====================
const API_BASE_URL = "https://api.siliconflow.cn"; // 可自定义修改为您的API地址 openai格式
const API_ENDPOINTS = {
  chat: "/v1/chat/completions",
  embeddings: "/v1/embeddings",
  images: "/v1/images/generations",
  models: "/v1/models",
  audio: "/v1/audio/transcriptions",
  userInfo: "/v1/user/info",
  rerank: "/v1/rerank",
};

const KV_KEYS = {
  TOKENS: "tokens",
  STATS: "stats",
  PASSWORD: "admin_password",
  SESSION_SECRET: "session_secret",
};

// API鉴权密钥 - 自定义修改为您的密钥，用于验证API请求
const API_KEY = "sk-yourCustomApiKey123456789";

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
// 记录最后处理的日期(用于按自然日重置每日统计)
let lastProcessedDate = null;
// 设置日志级别
let logLevel = "debug"; // debug, info, warn, error

// 全局统计变量
let lastKVSaveTime = Date.now();
let pendingUpdates = 0;
// const KV_SAVE_INTERVAL = 300000; // 每5分钟保存一次 - 已弃用，改为实时保存
// const MAX_PENDING_UPDATES = 20; // 积累20次更新后强制保存 - 已弃用，改为实时保存

// ==================== 缓存配置 ====================
const CACHE_TTL = {
  TOKENS: 5 * 60 * 1000, // 令牌缓存5分钟
  STATS: 2 * 60 * 1000, // 统计数据缓存2分钟
};

// 缓存对象
const cache = {
  tokens: {
    data: null,
    timestamp: 0,
  },
  stats: {
    data: null,
    timestamp: 0,
  },
};

// ==================== 日志类 ===================
class Logger {
  static debug(message, ...args) {
    if (logLevel === "debug") {
      console.debug("[DEBUG] " + message, ...args);
    }
  }

  static info(message, ...args) {
    if (logLevel === "debug" || logLevel === "info") {
      console.info("[INFO] " + message, ...args);
    }
  }

  static warn(message, ...args) {
    if (logLevel === "debug" || logLevel === "info" || logLevel === "warn") {
      console.warn("[WARN] " + message, ...args);
    }
  }

  static error(message, ...args) {
    console.error("[ERROR] " + message, ...args);
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
async function loadTokensFromKV(env, forceRefresh = false) {
  try {
    // 检查缓存是否有效，除非强制刷新
    const now = Date.now();
    if (!forceRefresh && cache.tokens.data && now - cache.tokens.timestamp < CACHE_TTL.TOKENS) {
      tokens = cache.tokens.data;
      Logger.debug(`使用缓存中的令牌数据，共${tokens.length}个令牌`);
      return true;
    }

    // 缓存无效或强制刷新，从KV加载数据
    const data = await env.API_TOKENS.get(KV_KEYS.TOKENS, { type: "json" });
    if (data) {
      tokens = data;
      // 更新缓存
      cache.tokens.data = data;
      cache.tokens.timestamp = now;
      Logger.info(`已从KV加载${tokens.length}个令牌${forceRefresh ? " (强制刷新)" : ""}`);
    } else {
      tokens = [];
      cache.tokens.data = [];
      cache.tokens.timestamp = now;
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

    // 更新缓存
    cache.tokens.data = [...tokens];
    cache.tokens.timestamp = Date.now();

    Logger.info(`已保存${tokens.length}个令牌到KV并更新缓存`);

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

/**
 * 估算文本的token数量
 * @param {string} text - 要估算的文本
 * @param {boolean} isChatMessage - 是否为聊天消息
 * @param {string} textType - 文本类型: "normal", "image_prompt", "completion", "code"
 * @returns {number} - 估算的token数量
 */
function estimateTokenCount(text, isChatMessage = false, textType = "normal") {
  if (!text) return 0;

  // 计算中文字符数和总字符数
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;

  // 计算代码块
  const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
  let codeChars = 0;
  for (const block of codeBlocks) {
    codeChars += block.length;
  }

  // 计算ASCII符号字符（标点、数字等）
  const symbolChars = (text.match(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?\d]/g) || []).length;

  // 计算空格、换行等空白字符
  const whitespaceChars = (text.match(/\s/g) || []).length;

  const totalChars = text.length;
  const nonChineseChars = totalChars - chineseChars;

  let estimatedTokens = 0;

  // 根据文本类型使用不同的估算逻辑
  switch (textType) {
    case "image_prompt":
      // 图片提示词通常需要更详细的描述，token使用效率更高
      // 中文字符约0.6个token/字，非中文字符约0.2个token/字（5字/token）
      estimatedTokens = Math.ceil(chineseChars * 0.6) + Math.ceil(nonChineseChars / 5);
      break;

    case "code":
      // 代码文本估算
      // 代码通常token效率高
      estimatedTokens = Math.ceil(chineseChars * 0.7) + Math.ceil((nonChineseChars - codeChars) / 4) + Math.ceil(codeChars / 6);
      break;

    case "completion":
      // 模型输出的完成内容
      // 通常模型生成的文本token效率较高，倾向于符合tokenizer的常用词
      // 中文约0.65 token/字，非中文约0.3 token/字
      estimatedTokens = Math.ceil(chineseChars * 0.65) + Math.ceil(nonChineseChars / 3.5);
      // 调整：根据特殊字符比例进一步优化
      if (symbolChars > totalChars * 0.3) {
        // 大量标点的文本token率更高
        estimatedTokens = Math.ceil(estimatedTokens * 1.1);
      }
      break;

    case "normal":
    default:
      // 普通文本
      // 基础估算：中文字符约0.7个token/字，非中文字符约0.25个token/字（4字/token）
      let baseEstimate = Math.ceil(chineseChars * 0.7) + Math.ceil((nonChineseChars - codeChars) / 4);

      // 代码部分单独计算
      if (codeChars > 0) {
        baseEstimate += Math.ceil(codeChars / 5.5);
      }

      // 调整空白字符的影响
      if (whitespaceChars > totalChars * 0.2) {
        // 大量空白字符的文本，token效率更高
        baseEstimate = Math.ceil(baseEstimate * 0.95);
      }

      estimatedTokens = baseEstimate;
      break;
  }

  // 添加消息格式开销
  if (isChatMessage) {
    // 基础消息格式开销
    let messageOverhead = 4;

    // 根据文本长度调整，长消息格式开销相对较小
    if (totalChars > 1000) {
      messageOverhead = 3;
    } else if (totalChars < 20) {
      // 极短消息可能有更高的格式开销比例
      messageOverhead = 5;
    }

    estimatedTokens += messageOverhead;
  }

  return Math.max(1, Math.round(estimatedTokens)); // 确保至少返回1个token
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

    // 获取当前日期（按北京时间）
    const bjTimeString = getBJTimeString(); // 使用现有函数获取北京时间
    const beijingDateStr = bjTimeString.substring(0, 10); // 截取YYYY-MM-DD部分

    // 重置逻辑：如果有上一次的日期记录且与当前日期不同，则重置天级数据
    if (lastProcessedDate && lastProcessedDate !== beijingDateStr) {
      Logger.info(`日期已变更：${lastProcessedDate} -> ${beijingDateStr}，重置每日统计数据`);
      requestTimestampsDay = [];
      tokenCountsDay = [];
      dayCleanupCount = "全部重置";
    }

    // 记录当前处理的日期
    lastProcessedDate = beijingDateStr;

    // 原有的清理逻辑（清理超过24小时的数据）
    for (let i = requestTimestampsDay.length - 1; i >= 0; i--) {
      if (now - requestTimestampsDay[i] > ONE_DAY) {
        requestTimestampsDay.splice(0, i + 1);
        tokenCountsDay.splice(0, i + 1);
        if (dayCleanupCount !== "全部重置") {
          dayCleanupCount = i + 1;
        }
        break;
      }
    }

    if (dayCleanupCount) {
      Logger.debug(`清理了${dayCleanupCount}条天级统计数据`);
    }
  } catch (error) {
    Logger.error("清理统计数据时出错:", error);
  }
}

// 从KV加载统计数据
async function loadStatsFromKV(env, forceRefresh = false) {
  try {
    // 检查缓存是否有效，除非强制刷新
    const now = Date.now();
    if (!forceRefresh && cache.stats.data && now - cache.stats.timestamp < CACHE_TTL.STATS) {
      const cachedStats = cache.stats.data;
      requestTimestamps = cachedStats.requestTimestamps || [];
      tokenCounts = cachedStats.tokenCounts || [];
      requestTimestampsDay = cachedStats.requestTimestampsDay || [];
      tokenCountsDay = cachedStats.tokenCountsDay || [];
      lastProcessedDate = cachedStats.lastProcessedDate || null;

      // 清理缓存中的旧数据
      cleanupOldRequestData();
      Logger.debug("使用缓存中的统计数据");
      return true;
    }

    // 缓存无效或强制刷新，从KV加载数据
    const data = await env.API_TOKENS.get(KV_KEYS.STATS, { type: "json" });
    if (data) {
      requestTimestamps = data.requestTimestamps || [];
      tokenCounts = data.tokenCounts || [];
      requestTimestampsDay = data.requestTimestampsDay || [];
      tokenCountsDay = data.tokenCountsDay || [];
      lastProcessedDate = data.lastProcessedDate || null;

      // 更新缓存
      cache.stats.data = {
        requestTimestamps: [...requestTimestamps],
        tokenCounts: [...tokenCounts],
        requestTimestampsDay: [...requestTimestampsDay],
        tokenCountsDay: [...tokenCountsDay],
        lastProcessedDate: lastProcessedDate,
      };
      cache.stats.timestamp = now;

      // 清理旧数据
      cleanupOldRequestData();

      Logger.info(`已从KV加载请求统计数据${forceRefresh ? " (强制刷新)" : ""}`);
    } else {
      requestTimestamps = [];
      tokenCounts = [];
      requestTimestampsDay = [];
      tokenCountsDay = [];

      // 初始化最后处理日期
      lastProcessedDate = getBJTimeString().substring(0, 10); // 使用现有函数，截取YYYY-MM-DD部分

      // 更新缓存为空数据
      cache.stats.data = {
        requestTimestamps: [],
        tokenCounts: [],
        requestTimestampsDay: [],
        tokenCountsDay: [],
        lastProcessedDate: lastProcessedDate,
      };
      cache.stats.timestamp = now;

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

    const statsData = {
      requestTimestamps,
      tokenCounts,
      requestTimestampsDay,
      tokenCountsDay,
      lastProcessedDate,
      lastUpdated: new Date().toISOString(),
    };

    await env.API_TOKENS.put(KV_KEYS.STATS, JSON.stringify(statsData));

    // 更新缓存
    cache.stats.data = {
      requestTimestamps: [...requestTimestamps],
      tokenCounts: [...tokenCounts],
      requestTimestampsDay: [...requestTimestampsDay],
      tokenCountsDay: [...tokenCountsDay],
      lastProcessedDate: lastProcessedDate,
    };
    cache.stats.timestamp = now;

    lastStatsSave = now;
    Logger.info("已保存请求统计数据到KV并更新缓存");
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
      const MAX_CONSECUTIVE_ERRORS = 3; // 自定义修改为您的连续错误次数
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
  const shouldSave = env ? true : false; // 只要有环境变量，就立即保存到KV

  // 旧逻辑：
  // const shouldSave =
  //   env &&
  //   (pendingUpdates >= MAX_PENDING_UPDATES || // 积累足够多的更新
  //     now - lastKVSaveTime >= KV_SAVE_INTERVAL || // 超过时间间隔
  //     !success || // 发生错误时立即保存
  //     (tokenIndex !== -1 && !tokens[tokenIndex].enabled)); // 令牌被禁用时立即保存

  if (shouldSave) {
    try {
      await saveTokensToKV(env);
      await saveStatsToKV(env, true); // 强制保存统计数据
      lastKVSaveTime = now;
      pendingUpdates = 0;
      Logger.debug(`实时保存统计数据到KV存储`);
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
      // 尝试重新加载数据，强制从KV读取
      await Promise.all([loadTokensFromKV(env, true), loadStatsFromKV(env, true)]);

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
          message: "数据已从KV重新加载，缓存已更新",
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
      // 如果获取余额失败，检查token是否有效
      const isValid = await checkTokenValidity(token);

      if (tokenIndex !== -1) {
        tokens[tokenIndex].balance = null;
        tokens[tokenIndex].isValid = isValid;
        tokens[tokenIndex].lastChecked = new Date().toISOString();

        try {
          await saveTokensToKV(env);
          Logger.info(`已保存令牌 ${obfuscateKey(token)} 的状态更新到 KV`);
        } catch (error) {
          Logger.error(`保存令牌状态到 KV 失败: ${error}`);
        }
      }

      return null;
    }

    const data = await response.json();

    // 更新令牌余额信息 - 从data.data.totalBalance中获取余额
    if (tokenIndex !== -1) {
      tokens[tokenIndex].balance = (data.data && data.data.totalBalance) || null;
      tokens[tokenIndex].isValid = true; // 成功获取余额，标记为有效
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

    // 如果出错，尝试检查token有效性
    if (tokenIndex !== -1) {
      const isValid = await checkTokenValidity(token);
      tokens[tokenIndex].isValid = isValid;
      tokens[tokenIndex].lastChecked = new Date().toISOString();

      try {
        await saveTokensToKV(env);
      } catch (saveError) {
        Logger.error(`保存令牌状态到 KV 失败: ${saveError}`);
      }
    }

    return null;
  }
}

// 检查令牌有效性
async function checkTokenValidity(token) {
  if (!token) return false;

  try {
    // 请求免费模型验证token是否有效
    const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "Qwen/Qwen2.5-7B-Instruct",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream: false,
      }),
    });

    // 如果响应成功，token有效
    return response.ok;
  } catch (error) {
    Logger.error(`检查令牌有效性失败: ${error}`);
    return false;
  }
}

// ==================== API请求处理 ====================
// 处理API请求
async function handleApiRequest(req, path, headers, env) {
  // 验证API密钥
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse(
      {
        error: {
          message: "缺少有效的API密钥",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      },
      401
    );
  }

  const providedApiKey = authHeader.substring(7).trim();
  if (providedApiKey !== API_KEY) {
    Logger.warn(`无效的API密钥尝试: ${obfuscateKey(providedApiKey)}`);
    return jsonResponse(
      {
        error: {
          message: "无效的API密钥",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      },
      401
    );
  }

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

  // 获取请求数据
  let requestBody;
  let isMultipart = false;
  const contentType = req.headers.get("Content-Type") || "";

  // 检查是否为多部分表单数据请求（适用于音频转录API）
  if (contentType.includes("multipart/form-data")) {
    isMultipart = true;
    // 对于multipart/form-data请求，我们直接使用原始请求体
    requestBody = req.body;
  } else {
    // 对于其他请求，按原来方式处理
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
  }

  // 检查是否为流式请求
  const isStreamRequest = (() => {
    try {
      if (requestBody && typeof requestBody === "string") {
        const requestJson = JSON.parse(requestBody);
        return requestJson.stream === true;
      }
    } catch (e) {
      // 解析失败，假设不是流式请求
    }
    return false;
  })();

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

      // 准备请求选项
      const requestOptions = {
        method: req.method,
        headers: requestHeaders,
        redirect: "follow",
      };

      // 根据请求类型添加请求体
      if (req.method !== "GET") {
        if (isMultipart) {
          // 对于multipart/form-data，直接传递原始请求体
          requestOptions.body = requestBody;
        } else {
          // 对于其他请求类型，使用文本请求体
          requestOptions.body = requestBody;
        }
      }

      // 发送请求
      const response = await fetch(url, requestOptions);

      // 如果是流式请求，处理流式响应
      if (isStreamRequest && response.ok) {
        Logger.info(`开始处理流式响应: 路径=${path}, 状态=${response.status}, 令牌=${obfuscateKey(token.key)}`);

        // 自定义延迟算法的配置
        const streamConfig = {
          minDelay: 3, // 最小延迟(毫秒)，降低以提高响应速度
          maxDelay: 30, // 最大延迟(毫秒)，减小以提高整体流畅性
          adaptiveDelayFactor: 0.5, // 自适应延迟因子
          chunkBufferSize: 15, // 增大计算平均响应大小的缓冲区
          minContentLengthForFastOutput: 500, // 降低启用快速输出的阈值
          fastOutputDelay: 2, // 快速输出时的固定延迟，降低以加快输出
          finalLowDelay: 1, // 模型完成响应后的低延迟
          interMessageDelay: 5, // 消息之间的延迟时间
          fastModeThreshold: 3000, // 大内容自动启用快速模式的阈值
          intelligentBatching: true, // 启用智能批处理
          maxBatchSize: 5, // 最大批处理大小
          collectCompletionText: true, // 启用响应内容收集以准确计算token
          // 添加更新统计信息的回调函数
          updateStatsCallback: async (completionTokens) => {
            try {
              // 初始token估算（提示部分）
              const promptTokens = await estimateTokenUsageFromRequest(requestBody, path);

              // 计算总token使用量
              const totalTokens = promptTokens + completionTokens;

              Logger.info(`流式响应完成: 路径=${path}, 令牌=${obfuscateKey(token.key)}, ` + `总Token=${totalTokens} (提示: ${promptTokens}, 完成: ${completionTokens})`);

              // 更新token统计信息
              await updateTokenStats(token, true, totalTokens, env);
            } catch (e) {
              Logger.warn(`更新流式响应token统计失败: ${e.message}`);
            }
          },
        };

        // 创建转换流
        const { readable, writable } = new TransformStream();

        // 初始token估算（仅用于临时记录）
        const initialTokenUsage = await estimateTokenUsageFromRequest(requestBody, path);
        Logger.debug(`流式请求初始token估算: ${initialTokenUsage}`);

        // 处理流式响应 - 不在此处立即更新统计信息，而是在流结束后由回调更新
        processStreamingResponse(response.body, writable, streamConfig);

        // 返回流式响应
        return new Response(readable, {
          status: response.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // 非流式响应处理 - 保持现有代码
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
          // 图像生成请求的token估算 - 根据请求参数动态计算
          try {
            const requestJson = JSON.parse(requestBody);

            // 基础token消耗
            let baseTokens = 1000;

            // 根据提示词长度添加token
            if (requestJson.prompt) {
              baseTokens += estimateTokenCount(requestJson.prompt, false, "image_prompt");
            }

            // 根据图片数量调整
            const n = requestJson.n || 1;

            // 根据尺寸调整
            let sizeMultiplier = 1.0;
            if (requestJson.size) {
              // 常见尺寸的倍数
              const sizeMappings = {
                "256x256": 0.6,
                "512x512": 1.0,
                "1024x1024": 2.0,
                "1792x1024": 2.5,
                "1024x1792": 2.5,
              };
              sizeMultiplier = sizeMappings[requestJson.size] || 1.0;
            }

            // 根据质量调整
            let qualityMultiplier = 1.0;
            if (requestJson.quality === "hd") {
              qualityMultiplier = 1.5;
            }

            // 计算最终的token使用量
            tokenUsage = Math.round(baseTokens * n * sizeMultiplier * qualityMultiplier);

            Logger.debug(`图像生成请求，动态估算使用了${tokenUsage}个token（图片数量：${n}，尺寸倍数：${sizeMultiplier}，质量倍数：${qualityMultiplier}）`);
          } catch (e) {
            // 如果解析失败，回退到默认值
            tokenUsage = 4500;
            Logger.debug(`图像生成请求，无法解析参数，使用默认估算${tokenUsage}个token`);
          }
        } else if (path.includes(API_ENDPOINTS.audio)) {
          // 音频转录请求的token估算 - 基于实际响应内容
          if (responseData && responseData.text) {
            // 使用转录文本长度计算token数
            const transcriptionText = responseData.text;
            // 使用辅助函数估算token
            const estimatedTokens = estimateTokenCount(transcriptionText);

            // 加上基础处理开销
            tokenUsage = Math.max(500, estimatedTokens + 500);
            Logger.debug(`音频转录请求，基于转录内容估算使用了${tokenUsage}个token（文本长度：${transcriptionText.length}）`);
          } else {
            // 无法获取转录文本时，使用一个较为保守的估算
            tokenUsage = 1500;
            Logger.debug(`音频转录请求，无法获取转录文本，使用保守估算${tokenUsage}个token`);
          }
        } else if (path.includes(API_ENDPOINTS.rerank)) {
          // 重排序请求的token估算
          try {
            const requestJson = JSON.parse(requestBody);
            let totalTokens = 0;

            // 计算查询的token
            if (requestJson.query) {
              const queryTokens = estimateTokenCount(requestJson.query);
              totalTokens += queryTokens;
              Logger.debug(`重排序查询token：${queryTokens}`);
            }

            // 计算文档的token
            if (requestJson.documents && Array.isArray(requestJson.documents)) {
              let docsTokens = 0;
              requestJson.documents.forEach((doc) => {
                docsTokens += estimateTokenCount(String(doc));
              });
              totalTokens += docsTokens;
              Logger.debug(`重排序文档token：${docsTokens}（文档数量：${requestJson.documents.length}）`);
            }

            // 加上基础处理开销
            tokenUsage = Math.max(100, totalTokens);
            Logger.debug(`重排序请求估算token：${tokenUsage}`);
          } catch (e) {
            // 解析失败时的默认估算
            tokenUsage = 500;
            Logger.debug(`重排序请求解析失败，使用默认估算${tokenUsage}个token`);
          }
        } else {
          // 优化的通用token估算方法
          try {
            // 尝试解析请求体为JSON
            let requestJson;
            try {
              requestJson = JSON.parse(requestBody);
            } catch (e) {
              // 非JSON请求体，使用字符长度估算
              const requestBodyLength = requestBody ? requestBody.length : 0;
              tokenUsage = Math.max(10, Math.ceil(requestBodyLength / 3));
              Logger.debug(`请求使用了非JSON格式，基于长度估算token：${tokenUsage}`);
              throw new Error("Not JSON"); // 跳到catch块
            }

            // 处理不同类型的JSON请求
            if (requestJson.messages && Array.isArray(requestJson.messages)) {
              // 聊天请求的估算
              tokenUsage = 0;

              // 计算所有消息的token
              requestJson.messages.forEach((msg) => {
                if (msg.content) {
                  tokenUsage += estimateTokenCount(String(msg.content), true);
                }
              });

              Logger.debug(`聊天请求估算token：${tokenUsage}`);
            } else if (requestJson.input || requestJson.prompt) {
              // 处理单一输入请求（如completions或embeddings）
              const input = String(requestJson.input || requestJson.prompt || "");
              tokenUsage = estimateTokenCount(input);
              Logger.debug(`单一输入请求估算token：${tokenUsage}（总字符：${input.length}）`);
            } else {
              // 其他JSON请求
              const jsonLength = JSON.stringify(requestJson).length;
              tokenUsage = Math.max(10, Math.ceil(jsonLength / 4));
              Logger.debug(`其他JSON请求估算token：${tokenUsage}（JSON长度：${jsonLength}）`);
            }
          } catch (e) {
            // 如果上面的处理出错，回退到简单估算
            if (e.message !== "Not JSON") {
              Logger.warn(`Token估算出错: ${e.message}，使用简单估算`);
              const requestBodyLength = requestBody ? requestBody.length : 0;
              tokenUsage = Math.max(10, Math.ceil(requestBodyLength / 3));
            }
          }

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

// 根据请求估算Token使用量，用于流式请求的初始统计
async function estimateTokenUsageFromRequest(requestBody, path) {
  try {
    if (!requestBody) return 10;

    let requestJson;
    try {
      requestJson = JSON.parse(requestBody);
    } catch (e) {
      // 非JSON请求体，使用字符长度估算
      return Math.max(10, Math.ceil(requestBody.length / 3));
    }

    // 处理不同类型的JSON请求
    if (requestJson.messages && Array.isArray(requestJson.messages)) {
      // 聊天请求的估算
      let tokenCount = 0;

      // 计算所有消息的token
      requestJson.messages.forEach((msg) => {
        if (msg.content) {
          // 检测消息内容是否包含代码块
          const hasCodeBlock = String(msg.content).includes("```");
          const textType = hasCodeBlock ? "code" : "normal";
          tokenCount += estimateTokenCount(String(msg.content), true, textType);
        }

        // 计算消息角色开销 (约2-3个token)
        tokenCount += 3;
      });

      // 添加聊天格式开销 (约8-10个token)
      tokenCount += 10;

      return tokenCount;
    } else if (requestJson.input || requestJson.prompt) {
      // 处理单一输入请求
      const input = String(requestJson.input || requestJson.prompt || "");

      // 检测请求路径或内容特性，选择合适的文本类型
      let textType = "normal";

      if (path && path.includes("/images/")) {
        textType = "image_prompt";
      } else if (input.includes("```")) {
        textType = "code";
      }

      return estimateTokenCount(input, false, textType);
    } else if (path && path.includes("/embeddings")) {
      // 嵌入请求的特殊处理
      let input = "";
      if (requestJson.input) {
        if (Array.isArray(requestJson.input)) {
          // 多个输入文本
          input = requestJson.input.join(" ");
        } else {
          input = String(requestJson.input);
        }
      }
      return estimateTokenCount(input, false, "normal");
    } else {
      // 其他JSON请求
      const jsonLength = JSON.stringify(requestJson).length;
      return Math.max(10, Math.ceil(jsonLength / 4));
    }
  } catch (e) {
    Logger.warn(`流式请求Token估算出错: ${e.message}`);
    return 100; // 默认值
  }
}

// 处理流式响应，添加自适应延迟
async function processStreamingResponse(inputStream, outputStream, config) {
  const reader = inputStream.getReader();
  const writer = outputStream.getWriter();

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // 优化缓冲区管理
  let buffer = "";
  let lastChunkTime = Date.now();
  let recentChunkSizes = [];
  let currentDelay = config.minDelay;
  let contentReceived = false;
  let isStreamEnding = false;
  let totalContentReceived = 0;
  let isFirstChunk = true;

  // Token计算增强: 跟踪累积的响应内容
  let allResponseContent = "";
  let completionTokens = 0;
  let lastDeltaContent = "";

  // 添加对话历史收集
  let collectCompletionText = config.collectCompletionText === true;
  let lastChoice = null;

  try {
    Logger.debug("开始处理流式响应");

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        Logger.debug("流读取完成");
        isStreamEnding = true;
        if (buffer.length > 0) {
          await processBuffer(buffer, writer, encoder, isStreamEnding, {
            ...config,
            currentDelay: config.finalLowDelay || 1,
          });
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));

        // 流结束后，基于累积的内容更新token计数
        if (collectCompletionText && allResponseContent.length > 0) {
          completionTokens = estimateTokenCount(allResponseContent);
          Logger.debug(`流响应结束，估算完成部分token数: ${completionTokens}`);

          // 更新token使用统计
          if (config.updateStatsCallback && typeof config.updateStatsCallback === "function") {
            config.updateStatsCallback(completionTokens);
          }
        }
        break;
      }

      if (value && value.length) {
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // 计算延迟和性能指标
        const currentTime = Date.now();
        const timeSinceLastChunk = currentTime - lastChunkTime;
        lastChunkTime = currentTime;

        // 跟踪接收的数据
        contentReceived = true;
        totalContentReceived += chunk.length;

        // 管理最近块大小的历史记录
        recentChunkSizes.push(chunk.length);
        if (recentChunkSizes.length > config.chunkBufferSize) {
          recentChunkSizes.shift();
        }

        // 优化的SSE消息处理 - 使用双换行符作为消息分隔符
        const messages = buffer.split("\n\n");
        buffer = messages.pop() || ""; // 保留最后一部分可能不完整的消息

        // 处理完整的消息
        for (const message of messages) {
          if (!message.trim()) continue;

          // 提取并跟踪内容以改进token计算
          if (collectCompletionText) {
            try {
              if (message.startsWith("data:")) {
                const jsonContent = message.substring(5).trim();
                if (jsonContent !== "[DONE]") {
                  const jsonData = JSON.parse(jsonContent);
                  if (jsonData.choices && jsonData.choices.length > 0) {
                    lastChoice = jsonData.choices[0];
                    if (lastChoice.delta && lastChoice.delta.content) {
                      // 收集所有内容以用于最终token计算
                      lastDeltaContent = lastChoice.delta.content;
                      allResponseContent += lastDeltaContent;
                    }
                  }
                }
              }
            } catch (e) {
              // 解析错误，忽略此消息的token计算
              Logger.debug(`无法解析消息进行token累积: ${e.message}`);
            }
          }

          const lines = message.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              // 为第一个内容快使用更快的延迟以提高感知响应速度
              const useDelay = isFirstChunk ? Math.min(config.minDelay, 2) : currentDelay;
              isFirstChunk = false;

              await processLine(line, writer, encoder, useDelay, config, false);
            }
          }

          // 消息之间添加小延迟使输出更自然
          if (config.interMessageDelay) {
            await new Promise((r) => setTimeout(r, config.interMessageDelay));
          }
        }

        // 动态调整延迟
        const avgChunkSize = recentChunkSizes.reduce((sum, size) => sum + size, 0) / recentChunkSizes.length;
        currentDelay = adaptDelay(avgChunkSize, timeSinceLastChunk, config, false);

        // 大内容启用快速处理模式
        if (totalContentReceived > (config.fastModeThreshold || 5000)) {
          currentDelay = Math.min(currentDelay, config.fastOutputDelay || 3);
        }
      }
    }
  } catch (error) {
    Logger.error("处理流式响应时出错:", error);
    try {
      // 发送格式化的错误响应
      const errorResponse = {
        error: {
          message: error.message,
          type: "stream_processing_error",
        },
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errorResponse)}\n\n`));
    } catch (e) {
      Logger.error("写入错误响应失败:", e);
    }
  } finally {
    try {
      await writer.close();
    } catch (e) {
      Logger.error("关闭写入器失败:", e);
    }
  }

  // 返回token使用情况
  return {
    completionTokens,
    totalContent: allResponseContent,
  };
}

// 处理单行SSE数据
async function processLine(line, writer, encoder, delay, config, isStreamEnding) {
  if (!line.trim() || !line.startsWith("data:")) return;

  try {
    // 去除前缀，解析JSON
    const content = line.substring(5).trim();
    if (content === "[DONE]") {
      await writer.write(encoder.encode(`${line}\n\n`));
      return;
    }

    try {
      const jsonData = JSON.parse(content);

      // OpenAI流式格式处理
      if (jsonData.choices && Array.isArray(jsonData.choices)) {
        const choice = jsonData.choices[0];

        if (choice.delta && choice.delta.content) {
          const deltaContent = choice.delta.content;
          const contentLength = deltaContent.length;

          // 针对不同长度的内容使用不同策略
          if (contentLength > 20 && !isStreamEnding && config.intelligentBatching) {
            // 长内容分批处理
            await sendContentInBatches(deltaContent, jsonData, writer, encoder, delay, config);
          } else {
            // 短内容或结束时的内容直接处理
            await sendContentCharByChar(deltaContent, jsonData, writer, encoder, delay, config, isStreamEnding);
          }
          return;
        } else if (choice.delta && Object.keys(choice.delta).length === 0) {
          // 这可能是最后一个消息或控制消息
          await writer.write(encoder.encode(`${line}\n\n`));
          return;
        }
      }
    } catch (e) {
      // JSON解析失败，按原始内容处理
      Logger.debug(`非标准JSON内容: ${e.message}`);
    }

    // 按原样发送未能识别的内容
    await writer.write(encoder.encode(`${line}\n\n`));
  } catch (error) {
    Logger.error(`处理SSE行时出错: ${error.message}`);
    try {
      // 出错时尝试按原样发送
      await writer.write(encoder.encode(`${line}\n\n`));
    } catch (e) {
      // 忽略二次错误
    }
  }
}

// 处理缓冲数据
async function processBuffer(buffer, writer, encoder, isStreamEnding, config) {
  if (!buffer.trim()) return;

  // 拆分成行并处理每一行
  const lines = buffer.split("\n");

  // 为流结束和中间内容使用不同的延迟
  const delay = isStreamEnding ? config.finalLowDelay || 1 : config.currentDelay || config.minDelay;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // 对最后一行使用流结束标志
    const isLastLine = i === lines.length - 1;
    await processLine(line, writer, encoder, delay, config, isLastLine && isStreamEnding);
  }
}

// 自适应延迟算法
function adaptDelay(chunkSize, timeSinceLastChunk, config, isStreamEnding) {
  if (chunkSize <= 0) return config.minDelay;

  // 流结束时使用finalLowDelay
  if (isStreamEnding && config.finalLowDelay !== undefined) {
    return Math.max(1, config.finalLowDelay);
  }

  // 确保配置值有效
  const minDelay = Math.max(1, config.minDelay || 5);
  const maxDelay = Math.max(minDelay, config.maxDelay || 40);
  const adaptiveDelayFactor = Math.max(0, Math.min(2, config.adaptiveDelayFactor || 0.5));

  // 改进的延迟计算

  // 1. 基于块大小的因子（块越大，延迟越小）
  // 使用对数缩放提供更平滑的过渡
  const logChunkSize = Math.log2(Math.max(1, chunkSize));
  const sizeScaleFactor = Math.max(0.2, Math.min(1.5, 4 / logChunkSize));

  // 2. 基于时间间隔的因子（时间间隔越长，延迟越大）
  // 如果LLM响应慢，我们也应该放慢输出速度使其更自然
  const timeScaleFactor = Math.sqrt(Math.min(2000, Math.max(50, timeSinceLastChunk)) / 200);

  // 3. 计算最终延迟
  let delay = minDelay + (maxDelay - minDelay) * sizeScaleFactor * timeScaleFactor * adaptiveDelayFactor;

  // 添加轻微随机变化（±10%）以使输出更自然
  const randomFactor = 0.9 + Math.random() * 0.2;
  delay *= randomFactor;

  // 确保在允许范围内
  return Math.min(maxDelay, Math.max(minDelay, delay));
}

// 逐字符发送内容
async function sendContentCharByChar(content, originalJson, writer, encoder, delay, config, isStreamEnding) {
  if (!content) return;

  // 检查是否需要快速输出模式
  const useQuickMode = content.length > (config.minContentLengthForFastOutput || 1000);
  const actualDelay = useQuickMode ? config.fastOutputDelay || 2 : delay;

  try {
    // 对于长内容优化批处理大小
    const sendBatchSize = useQuickMode
      ? isStreamEnding
        ? 5
        : 3 // 流结束时可以发送更大的批次
      : 1;

    for (let i = 0; i < content.length; i += sendBatchSize) {
      const endIndex = Math.min(i + sendBatchSize, content.length);
      const currentBatch = content.substring(i, endIndex);

      // 将原始JSON中的内容替换为当前字符
      const modifiedJson = JSON.parse(JSON.stringify(originalJson));
      modifiedJson.choices[0].delta.content = currentBatch;

      // 写入当前字符的SSE行
      const modifiedLine = `data: ${JSON.stringify(modifiedJson)}\n\n`;
      await writer.write(encoder.encode(modifiedLine));

      // 添加延迟，除了最后一批和极小内容（如单个标点符号）
      if (i + sendBatchSize < content.length && currentBatch.length > 1) {
        // 为流结束的最后部分使用更短的延迟
        const finalDelay = isStreamEnding && content.length - i < 10 ? Math.min(actualDelay, config.finalLowDelay || 1) : actualDelay;
        await new Promise((resolve) => setTimeout(resolve, finalDelay));
      }
    }
  } catch (error) {
    Logger.error(`逐字符发送内容时出错: ${error.message}`);
    // 出错时，尝试发送完整内容
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(originalJson)}\n\n`));
    } catch (e) {
      Logger.error(`无法发送完整内容: ${e.message}`);
    }
  }
}

// 分批次发送内容，优化长内容的处理
async function sendContentInBatches(content, originalJson, writer, encoder, delay, config) {
  if (!content || content.length === 0) return;

  // 根据内容长度和配置选择批处理大小
  const batchSize = content.length > 100 ? config.maxBatchSize || 5 : content.length > 50 ? 3 : 2;

  // 根据内容长度动态调整延迟
  const adjustedDelay = content.length > 100 ? Math.min(delay, config.fastOutputDelay || 3) : delay;

  try {
    for (let i = 0; i < content.length; i += batchSize) {
      const endIndex = Math.min(i + batchSize, content.length);
      const batch = content.substring(i, endIndex);

      // 创建新的JSON对象，只包含当前批次
      const batchJson = JSON.parse(JSON.stringify(originalJson));
      batchJson.choices[0].delta.content = batch;

      // 发送当前批次
      const batchLine = `data: ${JSON.stringify(batchJson)}\n\n`;
      await writer.write(encoder.encode(batchLine));

      // 只在批次之间添加延迟，最后一批不添加
      if (i + batchSize < content.length) {
        await new Promise((r) => setTimeout(r, adjustedDelay));
      }
    }
  } catch (error) {
    Logger.error(`分批处理内容时出错: ${error.message}`);
    // 出错时发送完整内容
    const fallbackJson = JSON.parse(JSON.stringify(originalJson));
    fallbackJson.choices[0].delta.content = content;
    await writer.write(encoder.encode(`data: ${JSON.stringify(fallbackJson)}\n\n`));
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
      if (Array.isArray(data.tokens)) {
        // 批量删除多个令牌
        const tokenKeys = data.tokens.map((token) => getTokenByIndexOrKey(token));
        const results = { success: true, removed: 0, failed: 0, messages: [] };

        if (!acquireDataLock()) {
          return jsonResponse({ success: false, message: "系统正忙，请稍后再试" }, 429);
        }

        try {
          await loadTokensFromKV(env);

          for (const tokenKey of tokenKeys) {
            try {
              const result = await removeTokenFromKV(env, tokenKey, true); // 传递skipLock=true，因为我们已经获取了锁
              if (result.success) {
                results.removed++;
              } else {
                results.failed++;
                results.messages.push("令牌 [" + obfuscateKey(tokenKey) + "] 删除失败: " + result.message);
              }
            } catch (error) {
              results.failed++;
              results.messages.push("令牌 [" + obfuscateKey(tokenKey) + "] 删除出错: " + error.message);
            }
          }

          await saveTokensToKV(env);
          results.message = "成功删除 " + results.removed + "/" + tokenKeys.length + " 个令牌";
          return jsonResponse(results, 200);
        } finally {
          releaseDataLock();
        }
      } else {
        // 单个令牌删除
        const tokenKey = getTokenByIndexOrKey(data.token);
        return jsonResponse(await removeTokenFromKV(env, tokenKey), 200);
      }
    } else if (data.action === "toggle") {
      if (Array.isArray(data.tokens) && typeof data.enable === "boolean") {
        // 批量切换令牌状态
        const tokenKeys = data.tokens.map((token) => getTokenByIndexOrKey(token));
        const results = { success: true, updated: 0, skipped: 0, failed: 0, messages: [] };
        const targetStatus = data.enable;

        if (!acquireDataLock()) {
          return jsonResponse({ success: false, message: "系统正忙，请稍后再试" }, 429);
        }

        try {
          await loadTokensFromKV(env);

          for (const tokenKey of tokenKeys) {
            try {
              // 查找令牌在数组中的位置
              const tokenIndex = tokens.findIndex((t) => t.key === tokenKey);

              if (tokenIndex === -1) {
                results.failed++;
                results.messages.push("找不到令牌 [" + obfuscateKey(tokenKey) + "]");
                continue;
              }

              // 检查令牌是否已经处于目标状态
              if (tokens[tokenIndex].enabled === targetStatus) {
                results.skipped++;
                continue;
              }

              // 切换令牌状态
              tokens[tokenIndex].enabled = targetStatus;
              tokens[tokenIndex].lastModified = Date.now();
              results.updated++;
            } catch (error) {
              results.failed++;
              results.messages.push("令牌 [" + obfuscateKey(tokenKey) + "] 状态更新出错: " + error.message);
            }
          }

          await saveTokensToKV(env);
          const action = targetStatus ? "启用" : "禁用";
          results.message = "成功" + action + " " + results.updated + "/" + tokenKeys.length + " 个令牌，跳过 " + results.skipped + " 个已" + action + "的令牌";
          return jsonResponse(results, 200);
        } finally {
          releaseDataLock();
        }
      } else {
        // 单个令牌切换
        const tokenKey = getTokenByIndexOrKey(data.token);
        return jsonResponse(await toggleTokenStatus(env, tokenKey), 200);
      }
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

      // 检查token是否有效
      let isValid = true;
      if (balance === null) {
        // 如果无法获取余额，检查token有效性
        isValid = await checkTokenValidity(tokenKey);
        Logger.info(`令牌有效性检查结果: ${isValid ? "有效" : "无效"}`);
      }

      // 更新令牌数据并保存到 KV
      const idx = tokens.findIndex((t) => t.key === tokenKey);
      if (idx !== -1) {
        tokens[idx].balance = balance;
        tokens[idx].isValid = isValid;
        tokens[idx].lastChecked = new Date().toISOString();
        try {
          await saveTokensToKV(env);
          Logger.info(`已保存令牌 ${obfuscateKey(tokenKey)} 的余额和有效性更新到 KV`);
        } catch (error) {
          Logger.error(`保存令牌数据到 KV 失败: ${error}`);
        }
      }

      return jsonResponse(
        {
          success: true,
          balance: balance,
          isValid: isValid,
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
    // 检查是否强制刷新
    const forceRefresh = req.url.includes("force=true");

    // 加载令牌，传递forceRefresh参数
    await loadTokensFromKV(env, forceRefresh);

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
        refreshed: forceRefresh,
        message: forceRefresh ? "令牌数据已从KV强制刷新" : undefined,
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
    document.getElementById('loginForm').addEventListener('submit', async function(e) {
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
          setTimeout(function() {
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
    
    /* 余额显示状态样式 */
    .balance-ok {
      color: var(--success-color);
      font-weight: bold;
    }
    
    .balance-low {
      color: var(--warning-color);
      font-weight: bold;
    }
    
    .balance-invalid {
      color: var(--error-color);
      font-weight: bold;
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
    
    /* 强制刷新按钮样式 */
    #refreshStats, #refreshTokens {
      position: relative;
      color: #2196F3;
      font-size: 1.1em;
    }
    
    #refreshStats:hover, #refreshTokens:hover {
      color: #0D47A1;
      transform: scale(1.1);
    }
    
    #refreshStats:hover::before {
      content: "从KV强制刷新统计";
      position: absolute;
      top: -30px;
      right: 0;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      white-space: nowrap;
    }
    
    #refreshTokens:hover::before {
      content: "从KV强制刷新令牌";
      position: absolute;
      top: -30px;
      right: 0;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      white-space: nowrap;
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
    
    /* GitHub图标样式 */
    .navbar-text .bi-github {
      font-size: 1.2rem;
      opacity: 0.7;
      transition: all 0.3s ease;
      color: rgba(255, 255, 255, 0.8);
    }
    
    .navbar-text:hover .bi-github {
      opacity: 1;
      transform: rotate(360deg) scale(1.15);
      color: white;
    }
    
    .navbar-text {
      text-decoration: none;
      transition: all 0.3s ease;
      margin-left: 8px !important;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    
    .navbar-text:hover {
      color: white !important;
      background-color: rgba(255, 255, 255, 0.1);
    }
  </style>
</head>
<body>
  <nav class="navbar navbar-expand-lg navbar-dark mb-4">
    <div class="container">
      <a class="navbar-brand" href="/dashboard">
        <i class="bi bi-speedometer2 me-2"></i>API管理系统
      </a>
      <a href="https://github.com/ling-drag0n/api-pool" target="_blank" class="navbar-text text-white-50 ms-2 d-none d-md-flex align-items-center" title="在GitHub上查看项目">
        <i class="bi bi-github"></i>
      </a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav ms-auto">
          <li class="nav-item d-md-none">
            <a class="nav-link text-white" href="https://github.com/ling-drag0n/api-pool" target="_blank">
              <i class="bi bi-github me-1"></i>GitHub
            </a>
          </li>
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
        <span class="refresh-btn kv-refresh" id="refreshStats" title="从KV刷新数据（忽略缓存）">
          <i class="bi bi-arrow-clockwise"></i>
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
        <div class="d-flex align-items-center">
          <span class="refresh-btn kv-refresh" id="refreshTokens" title="从KV刷新令牌数据（忽略缓存）">
            <i class="bi bi-arrow-clockwise"></i>
          </span>
          <span class="badge bg-primary ms-2" id="tokenCount">0 个令牌</span>
        </div>
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
          <button type="button" id="enableSelectedBtn" class="btn btn-light btn-sm" disabled>
            <i class="bi bi-check-circle me-1"></i>启用所选
          </button>
          <button type="button" id="disableSelectedBtn" class="btn btn-light btn-sm" disabled>
            <i class="bi bi-slash-circle me-1"></i>禁用所选
          </button>
          <button type="button" id="deleteSelectedBtn" class="btn btn-light btn-sm" disabled>
            <i class="bi bi-trash me-1"></i>删除所选
          </button>
          <button type="button" id="refreshBalanceBtn" class="btn btn-light btn-sm" disabled>
            <i class="bi bi-currency-exchange me-1"></i>刷新余额
          </button>
          <button type="button" id="selectNoBalanceBtn" class="btn btn-light btn-sm">
            <i class="bi bi-question-circle me-1"></i>选择无余额数据
          </button>
          <button type="button" id="selectLowBalanceBtn" class="btn btn-light btn-sm">
            <i class="bi bi-currency-dollar me-1"></i>余额≤0
          </button>
          <button type="button" id="selectLowBalanceLimitBtn" class="btn btn-light btn-sm">
            <i class="bi bi-currency-dollar me-1"></i>余额≤5
          </button>
          <div class="ms-auto">
            <div class="input-group">
              <input type="text" class="form-control form-control-sm" id="tokenSearch" placeholder="搜索令牌...">
              <button type="button" id="clearSearchBtn" class="btn btn-light btn-sm">
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
      
      // 每60秒刷新一次统计数据
      statsRefreshInterval = setInterval(refreshStats, 60000);
      
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
            // 强制从KV刷新令牌列表
            refreshTokenList(true);
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
      
      // 刷新令牌列表按钮点击
      document.getElementById('refreshTokens').addEventListener('click', function() {
        const refreshBtn = this;
        refreshBtn.classList.add('spinning');
        
        refreshTokenList(true).finally(() => {
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
      async function refreshTokenList(force = false, suppressMessage = false) {
        try {
          const url = force ? '/api/tokens?force=true' : '/api/tokens';
          const response = await fetch(url, {
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
          
          // 如果是强制刷新且返回了消息，且不需要抑制消息显示，则显示通知
          if (force && data.message && !suppressMessage) {
            showAlert(data.message, 'success');
          }
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
        
        tokens.forEach(function(token, index) {
          const row = document.createElement('tr');
          
          // 设置余额状态的CSS类
          let balanceStatusClass = '';
          if (token.isValid === false) {
            // 红色：token无效
            balanceStatusClass = 'balance-invalid';
          } else if (token.balance !== null && token.balance <= 0) {
            // 黄色：余额不足
            balanceStatusClass = 'balance-low';
          } else if (token.balance !== null && token.balance > 0) {
            // 绿色：余额正常
            balanceStatusClass = 'balance-ok';
          }
          
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
              '<span class="balance-display ' + balanceStatusClass + '" id="balance-' + index + '">' +
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
            
            // 如果是强制刷新且有消息，显示通知
            if (force && data.message) {
              showAlert(data.message, 'success');
            }
            
            return data.stats;
          }
        } catch (error) {
          console.error('Error refreshing stats:', error);
          if (force) {
            showAlert('从KV刷新数据失败，请重试', 'danger');
          }
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
            // 强制从KV刷新令牌列表，抑制默认刷新消息
            refreshTokenList(true, true);
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
            // 强制从KV刷新令牌列表，抑制默认刷新消息
            refreshTokenList(true, true);
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
        
        showAlert("正在" + actionText + "选中的 " + totalTokens + " 个令牌...", 'info');
        
        try {
          // 发送批量请求
          const response = await fetch('/api/tokens', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'toggle',
              tokens: tokenKeys,
              enable: enable
            }),
            credentials: 'same-origin'
          });
          
          if (!response.ok) {
            throw new Error("HTTP error! status: " + response.status);
          }
          
          const result = await response.json();
          
          if (result.success) {
            let resultMessage = result.message || "已" + actionText + " " + result.updated + "/" + totalTokens + " 个令牌";
            if (result.skipped > 0) {
              resultMessage += " (跳过 " + result.skipped + " 个已" + actionText + "的令牌)";
            }
            showAlert(resultMessage, 'success');
          } else {
            showAlert(result.message || actionText + "令牌失败", 'danger');
          }
        } catch (error) {
          console.error("批量" + actionText + "令牌出错:", error);
          showAlert("批量" + actionText + "令牌出错: " + error.message, 'danger');
        } finally {
          // 强制从KV刷新令牌列表，抑制默认刷新消息
          refreshTokenList(true, true);
        }
      }
      
      // 批量删除令牌
      async function batchDeleteTokens(tokenKeys) {
        if (tokenKeys.length === 0) return;

        const totalTokens = tokenKeys.length;
        
        showAlert("正在删除选中的 " + totalTokens + " 个令牌...", "info");

        try {
          // 获取原始令牌值
          const tokensToDelete = tokenKeys.map(index => {
            const token = tokens[parseInt(index)];
            return token?.originalKey || token?.key;
          }).filter(key => key); // 过滤掉无效的令牌
          
          // 发送批量删除请求
          const response = await fetch("/api/tokens", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              action: "remove",
              tokens: tokensToDelete
            }),
            credentials: "same-origin"
          });
          
          if (!response.ok) {
            throw new Error("HTTP error! status: " + response.status);
          }
          
          const result = await response.json();
          
          if (result.success) {
            showAlert(result.message || "成功删除 " + result.removed + "/" + totalTokens + " 个令牌", "success");
            
            // 显示详细信息（如果有错误的话）
            if (result.failed > 0 && result.messages && result.messages.length > 0) {
              console.warn("删除失败的令牌信息：", result.messages);
            }
          } else {
            showAlert(result.message || "批量删除令牌失败", "danger");
          }
        } catch (error) {
          console.error("批量删除令牌出错:", error);
          showAlert("批量删除令牌出错: " + error.message, "danger");
        } finally {
          // 强制从KV刷新令牌列表，抑制默认刷新消息
          refreshTokenList(true, true);
          // 清除选中的令牌
          clearSelection();
        }
      }
      
      // 批量刷新余额
      async function batchRefreshBalance(tokenKeys) {
        if (tokenKeys.length === 0) return;
        
        const totalTokens = tokenKeys.length;
        showAlert("正在并发刷新选中令牌的余额 (0/" + totalTokens + ")...", 'info');
        
        // 自定义设置最大并发数
        const MAX_CONCURRENT = 20; // 最多同时发起20个请求
        let processed = 0;
        let successCount = 0;
        
        // 使用分批处理方式
        for (let i = 0; i < totalTokens; i += MAX_CONCURRENT) {
          // 获取当前批次的令牌
          const batch = tokenKeys.slice(i, i + MAX_CONCURRENT);
          const batchPromises = batch.map(function(tokenIndex) {
            // 将字符串索引转换为数字
            const index = parseInt(tokenIndex);
            if (index >= 0 && index < tokens.length) {
              return refreshTokenBalance(index, index)
                .then(function(result) {
                  if (result && result.success) successCount++;
                  return result;
                })
                .catch(function(error) {
                  console.error("刷新令牌 " + index + " 余额失败:", error);
                  return { success: false, error: error };
                });
            }
            return Promise.resolve({ success: false, error: '无效索引' });
          });
          
          // 并发执行当前批次
          await Promise.all(batchPromises);
          
          processed += batch.length;
          showAlert("正在并发刷新选中令牌的余额 (" + processed + "/" + totalTokens + ")...", 'info');
        }
        
        showAlert("已刷新 " + successCount + "/" + totalTokens + " 个令牌的余额", 'success');
        
        // 强制从KV刷新令牌列表，确保所有余额数据都是最新的，抑制默认刷新消息
        refreshTokenList(true, true);
      }
      
      // 刷新令牌余额 - 修改为返回Promise以支持批量并发
      async function refreshTokenBalance(tokenKey, index) {
        const balanceElement = document.getElementById("balance-" + index);
        const refreshBtn = balanceElement.nextElementSibling;
        
        // 显示加载状态
        balanceElement.textContent = '加载中...';
        refreshBtn.classList.add('spinning');
        
        try {
          const requestData = {
            action: 'refresh_balance',
            token: tokenKey
          };
          
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
            
            // 更新余额显示的样式类
            balanceElement.classList.remove('balance-ok', 'balance-low', 'balance-invalid');
            
            if (data.isValid === false) {
              // 红色：无效token
              balanceElement.classList.add('balance-invalid');
            } else if (data.balance !== null && data.balance <= 0) {
              // 黄色：余额不足
              balanceElement.classList.add('balance-low');
            } else if (data.balance !== null && data.balance > 0) {
              // 绿色：余额正常
              balanceElement.classList.add('balance-ok');
            }
            
            // 更新本地令牌数据
            const tokenIndex = tokens.findIndex(t => t.id === index);
            if (tokenIndex !== -1) {
              tokens[tokenIndex].balance = data.balance;
              tokens[tokenIndex].isValid = data.isValid;
              tokens[tokenIndex].lastChecked = new Date().toISOString();
            }
            
            return { success: true, balance: data.balance, isValid: data.isValid };
          } else {
            console.error('刷新余额失败:', data.message || '未知错误');
            balanceElement.textContent = '查询失败';
            balanceElement.classList.remove('balance-ok', 'balance-low');
            balanceElement.classList.add('balance-invalid');
            
            setTimeout(function() {
              balanceElement.textContent = '-';
            }, 2000);
            return { success: false, error: data.message || '未知错误' };
          }
        } catch (error) {
          console.error('刷新余额失败:', error);
          balanceElement.textContent = '查询失败';
          balanceElement.classList.remove('balance-ok', 'balance-low');
          balanceElement.classList.add('balance-invalid');
          
          setTimeout(function() {
            balanceElement.textContent = '-';
          }, 2000);
          return { success: false, error: error.message || '未知错误' };
        } finally {
          refreshBtn.classList.remove('spinning');
        }
      }
      
      // 筛选令牌表格
      function filterTokenTable(searchText) {
        const rows = tokenTableBody.querySelectorAll('tr');
        const searchLower = searchText.toLowerCase();
        
        rows.forEach(function(row) {
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
        setTimeout(function() {
          alertElement.classList.remove('show');
        }, 3000);
      }

      // 选择余额不足按钮点击事件
      document.getElementById('selectLowBalanceBtn').addEventListener('click', function() {
        // 清除现有选择
        clearSelection();
        
        // 选择所有余额为0或负数的令牌
        tokens.forEach((token, index) => {
          if (token.balance !== null && token.balance <= 0) {
            selectToken(index);
          }
        });
        
        const selectedCount = selectedTokens.size;
        if (selectedCount > 0) {
          showAlert('已选择 ' + selectedCount + ' 个余额不足的令牌', 'info');
        } else {
          showAlert('未找到余额不足的令牌', 'info');
        }
      });

      // 选择无余额数据按钮点击事件
      document.getElementById('selectNoBalanceBtn').addEventListener('click', function() {
        // 清除现有选择
        clearSelection();
        
        // 选择所有没有余额数据的令牌
        tokens.forEach((token, index) => {
          if (token.balance === null) {
            selectToken(index);
          }
        });
        
        const selectedCount = selectedTokens.size;
        if (selectedCount > 0) {
          showAlert('已选择 ' + selectedCount + ' 个无余额数据的令牌', 'info');
        } else {
          showAlert('未找到无余额数据的令牌', 'info');
        }
      });

      // 添加辅助函数
      function clearSelection() {
        selectedTokens.clear();
        document.querySelectorAll('.token-checkbox').forEach(checkbox => {
          checkbox.checked = false;
          checkbox.closest('tr').classList.remove('row-selected');
        });
        document.getElementById('selectAllTokens').checked = false;
        document.getElementById('selectAllTokens').indeterminate = false;
        updateBatchActionButtons();
      }

      function selectToken(index) {
        const checkbox = document.querySelector('.token-checkbox[data-token="' + index + '"]');
        if (checkbox) {
          checkbox.checked = true;
          checkbox.closest('tr').classList.add('row-selected');
          selectedTokens.add(index.toString());
        }
        updateBatchActionButtons();
      }

      // 添加新的选择余额小于等于5的按钮点击事件
      document.getElementById('selectLowBalanceLimitBtn').addEventListener('click', function() {
        // 清除现有选择
        clearSelection();
        
        // 选择所有余额小于等于5的令牌
        tokens.forEach((token, index) => {
          if (token.balance !== null && token.balance <= 5) {
            selectToken(index);
          }
        });
        
        const selectedCount = selectedTokens.size;
        if (selectedCount > 0) {
          showAlert('已选择 ' + selectedCount + ' 个余额小于等于5的令牌', 'info');
        } else {
          showAlert('未找到余额小于等于5的令牌', 'info');
        }
      });
    });
  </script>
</body>
</html>
`;
