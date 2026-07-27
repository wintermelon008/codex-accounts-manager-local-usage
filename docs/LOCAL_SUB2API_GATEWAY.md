# Sub2API Gateway 已拆分为独立集成

本仓库早期版本把 Sub2API Gateway 作为 Manager 内置功能，并通过 `codexAccounts.sub2apiGatewayEnabled` 等设置启用。该入口已移除：核心 Manager 不再读取这些设置、Gateway 配置或相关 SecretStorage。

请改用 [独立 Sub2API Gateway 与 S+ 导入器](integrations/sub2api-gateway.md)。该文档说明独立 VSIX 的安装、启用、停用、卸载、S+ 私有队列消费者，以及不自动迁移旧配置或凭据的边界。

现有旧部署不会被本次更新复制、删除或修改。可在目标设备验证新集成后，再由用户明确停用旧服务。
