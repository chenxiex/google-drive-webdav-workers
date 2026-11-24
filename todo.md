# Todo & 待决事项

基线：`dev`（已合入 PR #2–#10，包含路径路由、锁禁用、PROPPATCH、流式未知长度 PUT、SQLite Durable Object TUS 与 KV 移除、Drive v2 下载 ETag 校验）。

## 现有 WebDAV 待决项与已知缺口

- [ ] **确定普通 DELETE 的永久删除 / 回收站语义**
  - 当前 `MOVE`/`COPY` 覆盖流程已改用回收站（`trashed: true`）并支持失败恢复，但普通 `DELETE` 仍直接调用 Drive 永久删除接口（`DELETE /drive/v3/files/{id}`）。
  - 需决策普通 `DELETE` 是否统一改为 `trashed: true`，并验证目录删除、权限要求与恢复语义。

- [ ] **明确 Google Docs/Sheets 等原生文档与 Shortcut 的表示/导出策略**
  - 当前 `getRawContent` 仅调用 `alt=media`，没有 `files.export` 或 Shortcut 解析逻辑。
  - 需选择支持哪些导出 MIME/扩展名，或定义明确的排除/错误提示策略。

- [ ] **对齐已知长度大文件 PUT 的校验逻辑**
  - 目前仅未知长度流式 `PUT`（`putUnknownLength`）严格校验分块响应状态、308 `Range` 及最终完成状态；已知长度大文件 `PUT`（`> 5 MiB` 分块路径）尚未检查初始化响应状态码、308 `Range` 偏移或末块是否真实完成，且非法/负 `Content-Length` 会误走空上传或跳过循环返回假成功。

- [ ] **核验线上 Cloudflare 部署限制与凭据边界**
  - 在真实 Cloudflare 环境中核验单请求入口体上限与内存上限（区分 TUS 分块多请求与单次大 `PUT`）。
  - 部署前配置加密 secrets（`CLIENT_ID`、`CLIENT_SECRET`、`REFRESH_TOKEN`、`USERS`）；Workers KV 绑定已全面移除，元数据缓存仅存 isolate 内存，上传状态存 `TUS_UPLOADS` Durable Object。
  - 核实 OAuth 应用发布状态及 Refresh Token 长期有效性；留意所有 `USERS` 账号共用同一 Google OAuth 身份，`ROOT_ID` 仅作应用路径映射，不会缩窄令牌本身的权限范围。

## oCIS 兼容层实施计划

设计文档：[协议边界](docs/ocis-compatibility.md)。参考探测证据：[探测报告](docs/ocis-probe-report.md)。

目标客户端：ownCloud Desktop 7.1.1（Linux/Windows）、OpenCloud Android 1.3.1、rclone 1.76.0（兼容参照 Cyberduck CLI 9.6.0、ownCloud CLI 6.0.3）。

- [ ] **OC-02：补齐目标客户端实机流量与精确 fixtures**
  - 在可运行原版客户端的环境中完成请求捕获（Desktop 7.1.1 GUI 先前因环境禁用 `AF_UNIX` 导致 `QLocalServer` 失败，Android 与 Windows 尚未实测）。
  - 保留脱敏 query 与完整 DAV XML / OCS / Graph 请求响应体，固化 `status.php`、精简 `capabilities` 与 checksum 需求。

- [ ] **OC-03：实现最小有效 OAuth 2.0 / OIDC 登录与会话管理**
  - 实现 WebFinger、OIDC discovery、登录页（CSRF 防护与限流，复用 `USERS` 校验，不得把客户端 `client_id`/`client_secret` 当作用户密码）、PKCE S256、短效一次性授权码及客户端/回调白名单绑定、DO 令牌持久化与撤销、并发刷新原子策略。
  - 签名密钥（如 RS256）须持久化并支持稳定 `kid` 与轮换期 JWKS 公钥保留，签发规范 `id_token`（含 `nonce`）；明确多 `USERS` 共享 `ROOT_ID` 的视图语义。

- [ ] **OC-04：实现引导发现、OCS 与单 personal Space**
  - 实现 `GET /status.php`（返回兼容版本档案而非 `package.json` 版本）、`GET /ocs/{v1,v2}.php/cloud/{user,capabilities}`（同时支持 XML/JSON 与 v1 `meta.statuscode=100` / v2 `200` 及 `Ocs-Api-Version: 1`）、未认证 `/remote.php/webdav/` 返回 401 Bearer 质询、认证后 `OPTIONS /remote.php/webdav`、`HEAD /remote.php/dav/files/<user>/Personal/`（保留 404 回退到发现接口）、`GET /graph/v1.0/me/drives`。
  - 在 `files.tus_support` 中公告用户选定默认值 `max_chunk_size: 10485760`（10 MiB），显式关闭分享（`files_sharing.api_enabled=false`）、团队 Space、通知与锁等未实现能力。

- [ ] **OC-05：选型并验证目录同步变更发现方案**
  - 审计 Drive `changes.list` / `getStartPageToken` 并扩展 mock（Google changes token 官方不失效，需测试丢失/无效游标、分页与权限失效恢复）。
  - 对比“Drive changes + DO generation”与“周期全树发现”在外部增删改移动、子目录挂载下账户外变更遍历成本方面的表现；若采用 generation 方案，需将 generation 绑定至内存元数据/列表缓存键并约束进行中请求的快照，防止新 ETag 搭配旧列表。

- [ ] **OC-06：在现有 DO TUS 基础上补齐 oCIS 上传需求**
  - 补齐 `creation-with-upload`（POST 带首块）、两类 `filename` 路径解析（Desktop 相对全路径 vs Android basename）、浮点 `mtime` / `X-OC-Mtime` 协调、容忍 Cyberduck 9.6.0 明文 `filetype` 与尾逗号、独立于公告块大小的请求上限。
  - 在 Google 最终提交前校验 whole-file checksum（需支持可恢复的增量状态，且重放不重复计入）、处理条件覆盖（如 `If-Match`），并在完成响应返回实际 `ETag`/`OC-FileID`/`OC-Perm`（保留已完成会话的 `HEAD 200` 回执与旧 offset 重放 `409`）。
  - 通过实际 Worker 兼容层验证 `10,000,000` 字节 POST（余 `38,528` mod 256 KiB）及 10 MiB / 不规则 / 变块续传的跨块对齐与尾块持久恢复。

- [ ] **OC-07：按矩阵验收 DAV 语义与 opt-in 兼容路由**
  - 实现并验收 `/dav/spaces/<spaceId>/...` opt-in 路由：单次段解码、`$`/`%24` 等价、兼容路径缺父返回 409（不复用 legacy `ensureDir`）、非 TUS `PATCH` 不转发 `COPY`、避免与 legacy `/dav/spaces` 冲突。
  - 验收 `GET`/`HEAD`/`PROPFIND` 验证器、本地 `If-Range`、`Prefer: return=minimal`、`oc:*` 属性与真实权限字段；收敛上文 `DELETE`、Google Docs/Shortcuts 与文件夹 `COPY` 策略。

- [ ] **OC-08：实现 Android 预览代理**
  - 支持 DAV GET `?preview=1` 及 `x/y/c` 参数与 `oc:has-preview` 属性；由 Worker 代理请求 Drive `thumbnailLink` 并缓存（按身份与版本隔离，不泄露 Google URL；依据真实缩略图可用性返回预览或 404）。

- [ ] **OC-09：全生命周期故障恢复测试（mock 对齐后）**
  - 使用已对齐的 Drive mock 注入故障：tail/待发块落盘后中断、Google 已接收但丢响应、客户端确认丢失、最后提交丢响应、offset 冲突、部分确认与限流；验证 Worker/DO 重启后通过 `HEAD` + Drive `Range` 恢复无重复或丢字节且最终 SHA256 一致。

- [ ] **OC-10：多端实机同步与真实部署验收**
  - 完成 Linux/Windows 双向同步与 Android 上传/下载/预览实机验收，保留 rclone 回归。
  - 在真实部署的 Cloudflare 环境中实测超过单次入口上限的大文件上传及 DO 请求/存储成本。

- [ ] **OC-11：固化兼容矩阵与上线文档**
  - 记录支持客户端版本矩阵、资源/费用边界与迁移说明，全部门槛通过后再将设计文档状态更新为已支持。
