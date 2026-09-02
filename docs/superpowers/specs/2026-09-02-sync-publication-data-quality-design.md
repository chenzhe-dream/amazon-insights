# 同步发布与数据有效性修复设计

## 目标

修复两类直接业务问题：Windows 对同步任务诊断镜像执行原子替换时，持续 `EPERM` 不得让已由 PostgreSQL 管理的任务在图片 AI 阶段异常终止；金额零值和与商品底库冲突的 `0/0` 评分评论不得继续被当成有效数据展示。

## 权威边界

- PostgreSQL 是作用域同步任务的状态与阶段输出权威源；`data/sync-jobs/*.json` 只是子进程进度交换和诊断镜像。
- GET 路由已经通过 `SyncJobService.read()` 读取 PostgreSQL，不修改其权威顺序。
- 非作用域旧任务仍保持严格原子替换、失败关闭；只有带 `scope.organizationId` 的诊断镜像在 Windows 临时替换错误重试耗尽后允许在进程锁内就地覆盖。
- PostgreSQL 已成功持久化进度后，publication 镜像附加写失败不得反向把任务标为失败；真实 PG、心跳、Provider、构建错误仍按原逻辑失败。

## 数据有效性

- 当前价必须是大于零的有限数值，`$0` 不生成有效价格策略，也不显示成降价结论。
- FBA 费用必须大于零；`0` 作为缺口显示，不能标记 `ready`。
- `rating=0 && reviewCount=0` 只有在商品底库没有正评分/正评论证据时才可能视为真实零；底库已有正值时标记冲突并回退展示底库值。
- 真实的上游空数据（类目为空、SellerSprite 变体为空等）保持缺口，不填造数据。

## 恢复

修复代码冻结并集成后，当前失败任务只允许通过受鉴权的恢复入口选择 `image_remarks` 和 `build`。此前成功的 Provider 阶段不重跑；恢复实施前先做 dry-run/测试证明阶段选择正确。

## 验收

1. 持续 Windows `EPERM` 的作用域镜像写入不再杀死子进程，非作用域原子写测试保持原行为。
2. PG 已记录进度后，publication 镜像失败不触发 `syncJobs.fail()`。
3. `$0` 价格、`$0` FBA、与底库冲突的 `0/0` 不再是 ready；正常正值与真实零评论合同不回归。
4. 定向测试、changed lint、production build、diff-check 全部通过；不调用真实 Provider、不重启或部署。
