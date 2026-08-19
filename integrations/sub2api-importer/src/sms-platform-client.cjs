"use strict";

// 接码平台客户端（smscode.gg API）
// 仅封装 API 调用，不包含自动重试逻辑

const DEFAULT_BASE = "https://api.smscode.gg/v1";

class SmsPlatformClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    this.apiKey = config.apiKey || "";
    this.countryId = config.countryId || null;
    this.serviceId = config.serviceId || null;
    this.productId = config.productId || null;
  }

  async request(method, path, options = {}) {
    if (!this.apiKey) {
      throw new Error("未配置接码平台 API Key");
    }

    const url = `${this.baseUrl}${path}`;
    const headers = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };

    if (options.body) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || 5;
      const error = new Error(`接码平台限流，请 ${retryAfter}s 后重试`);
      error.code = "RATE_LIMIT_EXCEEDED";
      error.retryAfter = retryAfter;
      throw error;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
      const err = data.error || {};
      const error = new Error(
        `接码平台错误：${err.code || response.status}${err.message ? " · " + err.message : ""}`
      );
      error.code = err.code || `HTTP_${response.status}`;
      error.status = response.status;
      throw error;
    }

    return data.data;
  }

  async getBalance() {
    return this.request("GET", "/balance");
  }

  async listProducts(filters = {}) {
    const params = new URLSearchParams();
    if (filters.countryId) params.set("country_id", filters.countryId);
    if (filters.platformId) params.set("platform_id", filters.platformId);
    if (filters.operatorId) params.set("operator_id", filters.operatorId);
    params.set("limit", filters.limit || 10000);
    params.set("page", filters.page || 1);
    return this.request("GET", `/catalog/products?${params.toString()}`);
  }

  async createOrder(params = {}) {
    const body = { quantity: params.quantity || 1 };
    
    if (params.productId) {
      body.product_id = Number(params.productId);
    } else if (params.catalogProductId) {
      body.catalog_product_id = Number(params.catalogProductId);
      if (params.operatorId) body.operator_id = Number(params.operatorId);
      if (params.maxPrice) body.max_price = params.maxPrice;
    } else {
      throw new Error("下单需提供 productId 或 catalogProductId");
    }

    const idempotencyKey = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const data = await this.request("POST", "/orders/create", {
      body,
      headers: { "idempotency-key": idempotencyKey },
    });

    const order = (data.orders && data.orders[0]) || data;
    if (!order || !order.id) {
      throw new Error("下单未返回有效订单");
    }

    return order;
  }

  async getOrder(orderId) {
    return this.request("GET", `/orders/${encodeURIComponent(orderId)}`);
  }

  async finishOrder(orderId) {
    return this.request("POST", "/orders/finish", {
      body: { id: Number(orderId) },
    });
  }

  async cancelOrder(orderId) {
    return this.request("POST", "/orders/cancel", {
      body: { id: Number(orderId) },
    });
  }

  // 单次轮询检查，不包含循环逻辑
  async pollOnce(orderId) {
    const order = await this.getOrder(orderId);
    const status = String(order.status || "").toUpperCase();

    if (order.otp_code) {
      return {
        status: "OTP_RECEIVED",
        code: order.otp_code,
        message: order.otp_message || "",
        order,
      };
    }

    if (status === "CANCELED" || status === "EXPIRED") {
      const error = new Error(`订单已${status === "CANCELED" ? "取消" : "过期"}`);
      error.code = status;
      throw error;
    }

    return {
      status: status || "WAITING",
      order,
    };
  }
}

module.exports = { SmsPlatformClient };
