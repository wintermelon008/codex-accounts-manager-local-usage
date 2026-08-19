"use strict";

const crypto = require("node:crypto");

// OpenAI OAuth 配置
const OAUTH_ISSUER = "https://auth0.openai.com";
const OAUTH_CLIENT_ID = "DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD";
const OAUTH_REDIRECT_URI = "com.openai.chat://auth0.openai.com/ios/com.openai.chat/callback";
const OAUTH_SCOPE = "openid email profile offline_access model.request model.read organization.read organization.write";

// 接码重试配置
const MAX_PHONE_RETRIES = 25;
const SMS_TIMEOUT_MS = 90000;
const PHONE_RETRY_CODES = ["PHONE_UNAVAILABLE", "PHONE_IN_USE", "OTP_TIMEOUT", "NO_OFFER_AVAILABLE"];

// 生成 PKCE 参数
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// 生成浏览器指纹
function generateFingerprint() {
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  ];
  const platforms = ['"Windows"', '"macOS"', '"Linux"'];
  const screens = ["1920x1080", "2560x1440", "1366x768"];
  const langs = ["en-US", "en-GB", "zh-CN"];
  
  const idx = Math.floor(Math.random() * 3);
  return {
    userAgent: uas[idx],
    secChUaPlatform: platforms[idx],
    screenStr: screens[idx],
    language: langs[idx]
  };
}

// HTTP 请求封装
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": options.fingerprint?.userAgent || generateFingerprint().userAgent,
      "accept": "application/json",
      "content-type": "application/json",
      ...options.headers
    }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  
  return response.json();
}

module.exports = {
  OAUTH_ISSUER,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPE,
  MAX_PHONE_RETRIES,
  SMS_TIMEOUT_MS,
  PHONE_RETRY_CODES,
  generatePkce,
  generateFingerprint,
  request
};
