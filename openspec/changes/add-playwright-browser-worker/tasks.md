## 1. Contracts and Security

- [ ] 1.1 定义 Browser Worker 任务、租约、闭合状态与错误代码契约
- [ ] 1.2 定义会话引用、加密存储、权限、轮换、过期和脱敏策略
- [ ] 1.3 完成目标数据源条款、公司账号和数据保留合规审查

## 2. Isolated Worker

- [ ] 2.1 实现独立 Playwright Worker 进程、并发上限、超时和优雅停止
- [ ] 2.2 实现管理员重新认证与 `waiting-input` 恢复流程
- [ ] 2.3 实现浏览器采集记录到标准化 DataSnapshot 的可信转换

## 3. Fallback and Verification

- [ ] 3.1 让人工粘贴/文件导入复用相同的快照校验并明确来源
- [ ] 3.2 验证会话秘密不会进入前端、日志、任务、快照或模型输入
- [ ] 3.3 验证重启恢复、租约竞争、登录失效、MFA、限流和人工 fallback
- [ ] 3.4 在独立发布 change 批准前保持生产开关关闭
