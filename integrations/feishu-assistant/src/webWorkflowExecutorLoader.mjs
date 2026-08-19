import * as path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadWebWorkflowExecutor(moduleSpecifier, options = {}) {
  if (typeof moduleSpecifier !== "string" || !moduleSpecifier.trim()) return undefined;
  const specifier = moduleSpecifier.trim();
  const moduleUrl = specifier.startsWith("file:") ? specifier : pathToFileURL(path.resolve(specifier)).href;
  let imported;
  try {
    imported = await import(moduleUrl);
  } catch {
    throw new Error("网页执行器模块无法加载。");
  }
  const factory = imported.createWebWorkflowExecutor ?? imported.default;
  if (typeof factory !== "function") {
    throw new Error("网页执行器模块必须导出 createWebWorkflowExecutor 函数。");
  }
  let executor;
  try {
    executor = await factory(options);
  } catch {
    throw new Error("网页执行器初始化失败。");
  }
  if (!executor || typeof executor.execute !== "function") {
    throw new Error("网页执行器必须实现 execute 函数。");
  }
  return executor;
}
