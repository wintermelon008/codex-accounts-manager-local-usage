import * as vscode from "vscode";

const SECRET_PREFIX = "codex.sub2api.gateway.";

export class Sub2ApiGatewaySecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(credentialRef: string): Promise<string | undefined> {
    return this.secrets.get(`${SECRET_PREFIX}${credentialRef}`);
  }

  async set(credentialRef: string, apiKey: string): Promise<void> {
    await this.secrets.store(`${SECRET_PREFIX}${credentialRef}`, apiKey);
  }

  async delete(credentialRef: string): Promise<void> {
    await this.secrets.delete(`${SECRET_PREFIX}${credentialRef}`);
  }
}
