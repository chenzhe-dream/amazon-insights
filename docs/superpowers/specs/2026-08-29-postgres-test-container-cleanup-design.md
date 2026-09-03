# PostgreSQL 测试容器防泄漏设计

## 背景

本项目的 PostgreSQL 集成测试通过 `startPostgresTestContainer()` 启动临时容器。现有实现没有为 `docker run` 设置 `--rm`，并且正常与异常清理只执行 `docker rm --force`，没有携带 `--volumes`。PostgreSQL 镜像声明了数据目录卷，因此测试会创建匿名卷；测试异常中断时还会留下容器。现场已确认 6 个 `agent_pg_test_*` 孤立容器和对应匿名卷。

## 方案比较

1. 项目内生命周期加固：测试容器使用 `--rm` 和项目专属标签，显式清理统一使用 `--force --volumes`。改动小、边界明确，采用此方案。
2. 全局 Docker prune：回收更多空间，但会影响其他项目镜像、容器和构建缓存，不采用。
3. 定时清理或 VHDX 自动压缩：涉及系统级任务和 Docker 停机，超出本次范围，不采用。

## 设计

- 将 Docker 参数构造提取为纯函数，使测试能够直接验证安全参数。
- 创建临时 PostgreSQL 容器时加入 `--rm`，让 Docker 在容器停止后自动删除容器及其匿名卷。
- 创建容器时加入固定标签 `com.amazon-insights.test-postgres=true`，便于后续只识别本项目测试资源，不依赖模糊名称。
- 正常关闭和启动失败回滚都执行 `docker rm --force --volumes <container-id>`；清理目标继续受 64 位容器 ID 正则约束。
- 不扫描或删除其他容器，不运行 `docker system prune`、`docker image prune` 或 `docker volume prune`。
- 不修改正式容器 `amazon-insights-postgres-cutover`，不修改或删除正式数据卷 `amazon-insights-postgres-cutover-data`。

## 验收与测试

- 参数单元测试证明创建命令包含 `--rm` 和固定项目标签。
- 参数单元测试证明清理命令包含 `--force` 和 `--volumes`，且目标为经过校验的容器 ID。
- PostgreSQL 容器辅助器的现有接口保持不变。
- 定向测试和项目构建通过。
- Docker 正式容器、正式数据卷、全局镜像与 BuildKit 缓存不发生变化。

