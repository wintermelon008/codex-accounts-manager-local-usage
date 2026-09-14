# Workbench fast read-only query

这是一个简单的、只读的 Workbench 数据查询任务。

- 不要读取仓库根目录、`macos/` 或其它目录中的完整 `AGENTS.md`、源码、README、Git 状态或历史。
- 不要执行宽范围的 `find`、`rg`、`sed`，也不要创建、修改或删除文件。
- 直接使用环境变量 `WORKBENCH_DATA_URL` 的 HTTP API 查询数据服务。
- 日程、待办和记录统一从 `GET /api/workbench/records?includeArchived=false&limit=500` 读取；根据返回的 `types`、`planDate`、`dueDate`、`done` 等字段筛选。
- 这是只读任务，不要调用写入接口；查询失败时简洁报告数据服务不可达或请求错误。
- 直接给出简洁中文结果，不汇报内部命令、仓库扫描过程或完整原始 JSON。
