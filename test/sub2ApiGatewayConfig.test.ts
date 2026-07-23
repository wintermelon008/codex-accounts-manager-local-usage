import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUB2API_GATEWAY_CONFIG_SCHEMA,
  createSub2ApiGatewayConfigTemplate,
  ensureSub2ApiGatewayConfigFile,
  parseSub2ApiGatewayConfig,
  readSub2ApiGatewayConfig,
  resolveSub2ApiGatewayConfigPath
} from "../src/local/sub2apiGateway/config";

describe("Sub2API Gateway configuration", () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sub2api-gateway-config-"));
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it("uses a relative config file under extension global storage", () => {
    expect(resolveSub2ApiGatewayConfigPath(storagePath, "gateway/sub2api.json")).toBe(
      path.join(storagePath, "gateway", "sub2api.json")
    );
    expect(() => resolveSub2ApiGatewayConfigPath(storagePath, "/tmp/sub2api.json")).toThrow("relative");
    expect(() => resolveSub2ApiGatewayConfigPath(storagePath, "../sub2api.json")).toThrow("inside");
  });

  it("creates a safe template only when the opt-in caller asks for it", async () => {
    const configPath = resolveSub2ApiGatewayConfigPath(storagePath, "sub2api-gateway.json");

    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ensureSub2ApiGatewayConfigFile(configPath)).resolves.toBe(true);
    await expect(ensureSub2ApiGatewayConfigFile(configPath)).resolves.toBe(false);

    const content = await fs.readFile(configPath, "utf8");
    expect(content).toContain(SUB2API_GATEWAY_CONFIG_SCHEMA);
    expect(content).not.toMatch(/api[_-]?key/i);
    await expect(readSub2ApiGatewayConfig(configPath)).resolves.toMatchObject({
      configPath,
      sub2api: { baseUrl: "http://127.0.0.1:65432/v1", credentialRef: "primary" }
    });
  });

  it("normalizes a /v1 endpoint and rejects plaintext credentials", () => {
    const template = createSub2ApiGatewayConfigTemplate();
    expect(template.autoFallbackToChatGpt).toBe(false);
    expect(
      parseSub2ApiGatewayConfig({
        ...template,
        sub2api: { ...template.sub2api, baseUrl: "https://sub2api.example.test/v1/" }
      }).sub2api.baseUrl
    ).toBe("https://sub2api.example.test/v1");

    expect(() =>
      parseSub2ApiGatewayConfig({
        ...template,
        apiKey: "must-not-be-committed"
      })
    ).toThrow("SecretStorage");
    expect(() =>
      parseSub2ApiGatewayConfig({
        ...template,
        inventoryObserver: {
          adminBaseUrl: "http://127.0.0.1:65432",
          group: "test",
          credentialRef: "observer",
          adminApiKey: "must-not-be-committed"
        }
      })
    ).toThrow("SecretStorage");
    expect(() =>
      parseSub2ApiGatewayConfig({
        ...template,
        sub2api: { ...template.sub2api, baseUrl: "https://sub2api.example.test/not-v1" }
      })
    ).toThrow("end with /v1");
    expect(() =>
      parseSub2ApiGatewayConfig({
        ...template,
        autoFallbackToChatGpt: "yes"
      })
    ).toThrow("must be a boolean");
  });

  it("keeps automatic ChatGPT fallback explicitly opt-in", () => {
    const template = createSub2ApiGatewayConfigTemplate();

    expect(parseSub2ApiGatewayConfig({ ...template, autoFallbackToChatGpt: true })).toMatchObject({
      autoFallbackToChatGpt: true
    });
    expect(Boolean(parseSub2ApiGatewayConfig(template).autoFallbackToChatGpt)).toBe(false);
  });

  it("accepts a separately referenced optional upstream inventory observer", () => {
    const template = createSub2ApiGatewayConfigTemplate();

    expect(
      parseSub2ApiGatewayConfig({
        ...template,
        inventoryObserver: {
          adminBaseUrl: "https://sub2api.example.test/",
          group: "test",
          credentialRef: "observer",
          refreshSeconds: 120
        }
      })
    ).toMatchObject({
      inventoryObserver: {
        adminBaseUrl: "https://sub2api.example.test",
        group: "test",
        credentialRef: "observer",
        refreshSeconds: 120
      }
    });

    expect(() =>
      parseSub2ApiGatewayConfig({
        ...template,
        inventoryObserver: {
          adminBaseUrl: "https://sub2api.example.test/v1",
          group: "test",
          credentialRef: "primary"
        }
      })
    ).toThrow("service root");
    expect(() =>
      parseSub2ApiGatewayConfig({
        ...template,
        inventoryObserver: {
          adminBaseUrl: "https://sub2api.example.test",
          group: "test",
          credentialRef: "primary"
        }
      })
    ).toThrow("different");
  });
});
