"use strict";

const MAX_ACCOUNTS = 50;

function normalizeSub2Bundle(bundle) {
  if (!isRecord(bundle) || !Array.isArray(bundle.accounts) || bundle.accounts.length === 0) {
    throw new Error("BugTeam Sub2 下载结果缺少 accounts 数组");
  }
  if (bundle.accounts.length > MAX_ACCOUNTS) {
    throw new Error(`BugTeam Sub2 下载结果超过 ${MAX_ACCOUNTS} 个账号限制`);
  }
  return bundle.accounts.map(normalizeSub2Account);
}

function normalizeSub2Account(account) {
  if (!isRecord(account)) {
    throw new Error("BugTeam Sub2 账号条目格式无效");
  }
  const tokenSource = isRecord(account.tokens) ? account.tokens : account;
  const idToken = firstString(tokenSource.id_token, tokenSource.idToken, account.id_token, account.idToken);
  const accessToken = firstString(tokenSource.access_token, tokenSource.accessToken, account.access_token, account.accessToken);
  const refreshToken = firstString(
    tokenSource.refresh_token,
    tokenSource.refreshToken,
    account.refresh_token,
    account.refreshToken
  );
  if (!idToken || !accessToken) {
    throw new Error("BugTeam Sub2 账号缺少必要的 OAuth Token");
  }

  const accountId = firstString(tokenSource.account_id, tokenSource.accountId, account.account_id, account.accountId);
  return {
    id: firstString(account.id, account.account_id, account.accountId),
    email: firstString(account.email, account.account_email),
    auth_mode: "oauth",
    user_id: firstString(account.user_id, account.userId),
    plan_type: firstString(account.plan_type, account.planType),
    account_id: accountId,
    organization_id: firstString(account.organization_id, account.organizationId),
    account_name: firstString(account.account_name, account.accountName),
    account_structure: firstString(account.account_structure, account.accountStructure),
    added_via: "bugteam",
    subscription_active_until: account.subscription_active_until ?? account.subscriptionActiveUntil ?? null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(accountId ? { account_id: accountId } : {})
    }
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

module.exports = { MAX_ACCOUNTS, normalizeSub2Account, normalizeSub2Bundle };
