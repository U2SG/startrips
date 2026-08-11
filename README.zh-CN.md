# Startrips

[English](README.md)

Startrips 是一个私人的“活地图”：把真实旅程保存为有顺序的地理路线、故事和媒体集合。一段 Journey 可以跨越多个城市，覆盖飞行或航海过程，始终处于路上，也可以只发生在一个地点。

## 当前 P0

- 邮箱密码账户、邮箱验证、密码重置、可撤销会话和数据库限流。
- 每个 Organization 拥有一个私有 Atlas，最多两名成员，租户范围完全由服务端推导。
- 路线优先的 Journey 创建流程：1–64 个有序坐标、可选命名 Stop、日期、故事、颜色，以及最多十二个图片或视频。
- 支持点击地球或手动坐标录入路线；地点搜索通过部署适配器启用。
- 私有分片媒体上传，具备受控并发、进度、取消，以及只重试失败文件的能力。
- 时间轴、按需签名媒体读取，以及单 Canvas、低内存的 Three.js 球面路线渲染。
- 开发环境保留确定性的 `qaState` 视觉回归入口，但它不是正常的登录产品路径。

## 架构

项目有意保持云厂商中立：

- PostgreSQL 与 Drizzle 保存账户、Atlas、Journey、路线、上传及媒体元数据。
- Better Auth 管理认证和 Organization 成员关系。
- 对象存储位于通用分片存储接口之后。
- 地点搜索位于通用搜索接口之后。
- 网页和 API 应使用同一公网域名，让安全会话 Cookie 保持第一方。

部署时可以选择 Cloudflare、腾讯云、阿里云、AWS 或自建服务，而不需要修改 Journey 领域模型。详见[可移植认证与存储架构](docs/architecture/portable-auth-storage.md)。

## 本地开发

需要 Node.js 22、pnpm 10.17.1 和 PostgreSQL 17。

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm db:migrate
pnpm dev:api
pnpm dev
```

启动前需要配置数据库、认证密钥、邮件发送和公网来源。`STORAGE_DRIVER=disabled` 与 `LOCATION_SEARCH_DRIVER=disabled` 是真实降级状态：仍可通过点击地球或手动坐标创建路线，但媒体持久化和地点搜索要等相应适配器接入后才可用。

## 验证

GitHub Actions 会启动隔离的 PostgreSQL，并依次执行：

```text
认证 Schema 校验 -> 数据库迁移 -> TypeScript -> 测试 -> 生产构建
```

低内存机器可以只运行 `pnpm typecheck`，不启动 Three.js 预览。运行时视觉对照应使用确定性的 QA 状态和受控浏览器会话。

## 许可证

[MIT](LICENSE)
