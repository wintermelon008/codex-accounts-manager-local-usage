import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { assertPaymentProvider, PaymentProviderError } from "./paymentProvider.mjs";

export async function loadPaymentProvider(moduleSpecifier, options = {}) {
  if (typeof moduleSpecifier !== "string" || !moduleSpecifier.trim()) {
    return undefined;
  }
  const specifier = moduleSpecifier.trim();
  const moduleUrl = specifier.startsWith("file:") ? specifier : pathToFileURL(path.resolve(specifier)).href;
  let imported;
  try {
    imported = await import(moduleUrl);
  } catch {
    throw new PaymentProviderError("支付适配器模块无法加载。", "payment_provider_load");
  }
  const factory = imported.createPaymentProvider ?? imported.default;
  if (typeof factory !== "function") {
    throw new PaymentProviderError("支付适配器模块必须导出 createPaymentProvider 函数。", "payment_provider_export");
  }
  let provider;
  try {
    provider = await factory(options);
    assertPaymentProvider(provider);
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw error;
    }
    throw new PaymentProviderError("支付适配器初始化失败。", "payment_provider_init");
  }
  return provider;
}
