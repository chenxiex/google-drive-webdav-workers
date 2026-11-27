# Todo & 待决事项

基线：`dev`（已合入 PR #2–#10，包含路径路由、锁禁用、PROPPATCH、流式未知长度 PUT、SQLite Durable Object TUS 与 KV 移除、Drive v2 下载 ETag 校验）。

## 现有 WebDAV 待决项与已知缺口

- [x] **将普通 DELETE 改为移入回收站（`6A`）**
  - 当前 `MOVE`/`COPY` 覆盖流程已改用回收站（`trashed: true`）并支持失败恢复，但普通 `DELETE` 仍直接调用 Drive 永久删除接口（`DELETE /drive/v3/files/{id}`）。
  - 将普通 `DELETE` 改为 `PATCH { trashed: true }`（不保留永久删除开关），统一覆盖与删除的回收站语义，并验证目录删除、权限要求与恢复语义。

- [x] **过滤隐藏 Google Workspace 原生文档与 Shortcut（`7A`）**
  - 在目录列举（`getObjects`）与路径解析（`getMetadata`）中过滤除文件夹外的所有 `application/vnd.google-apps.*` 项（含 Docs/Sheets/Slides 与 Shortcut），避免客户端下载报错或双向同步死循环。

- [x] **基于 Drive v3 Batch API 实现 RFC 4918 文件夹 COPY（`8B`）**
  - 支持 `Depth: 0`（浅复制空目录壳及属性）与 `Depth: infinity`/缺省（按层 BFS 打包 `files.list` / `files.create` / `files.copy` 至 `POST /batch/drive/v3`，每批最多 100 个子请求，受安全规模/子请求预算保护，遇偶发 `429`/`5xx` 子项轻量重试 1–2 次）；先建暂存目录再覆盖发布。实现前需审计 `/batch/drive/v3` 并在 `MockDrive` 建模。
  - 统一单文件与文件夹 `COPY` 的暂存失败清理策略：在暂存复制阶段失败、旧目标移入回收站失败、或末步发布重命名遇确定性 `4xx`（非 `408`）拒绝并还原旧目标后，顺手将未发布的 `.webdav-copy-<UUID>` 移入回收站清理并返回单一明确错误码（仅末步重命名遇 `5xx`/`408`/断连等不确定失败时不自动清理或还原）。

- [x] **移除全站非 TUS `PATCH` 转发 `COPY` 的遗留路由（`9.1A`）**
  - 删除 [src/router.ts](src/router.ts) 中非 `tus_uploads/` 路径将 `PATCH` 改写为 `COPY` 的遗留代码，全站对非 TUS `PATCH` 统一返回 `405 Method Not Allowed`。

- [x] **全站移除 `ensureDir` 自动建父目录，统一按 RFC 4918 返回 `409`（`9.2B`）**
  - 移除 [src/webdav/handler.ts](src/webdav/handler.ts)、[src/webdav/upload.ts](src/webdav/upload.ts) 与 [src/tus/handler.ts](src/tus/handler.ts) 中 `MKCOL`、`PUT` 与 TUS `POST` 的 `ensureDir` 调用，父目录缺失或非文件夹时全站统一返回 `409 Conflict`（与 `MOVE`/`COPY` 一致，防止同步场景复活已删/改名父目录）；同步更新 [test/worker/dav-write.test.ts](test/worker/dav-write.test.ts) 中依赖自动建父目录的用例。

- [x] **统一路由并调整通用 WebDAV 默认路径为 `/webdav/`（`9.3`）**
  - 移除 `OCIS_ENABLED` 开关与新旧双轨语义：oCIS WebDAV 与发现路由（`/dav/spaces/<spaceId>/`、`/remote.php/webdav/`、`/remote.php/dav/files/<username>/`、`/status.php`、`/ocs/*`、`/graph/*`、`/.well-known/*`）常驻同一 Drive/WebDAV 处理器；OIDC `/oauth/*` 按是否配置 Cloudflare Access 自动启用（未配置时仅运行 HTTP Basic `USERS`）。
  - 将通用 WebDAV 默认 `WEBDAV_PATH` 从 `/dav/` 调整为 `/webdav/`（保留 `WEBDAV_PATH` 可配置），并对 `/` 或与 oCIS 保留前缀（`/dav/spaces/`、`/remote.php/`、`/ocs/`、`/graph/`、`/oauth/`、`/status.php`、`/.well-known/`）冲突的配置返回 `500` 配置错误；实现时同步更新 [README.md](README.md)、[.env.example](.env.example) 与 [docs/webdav-behavior.md](docs/webdav-behavior.md)。

- [x] **保留 WebDAV 自定义属性并精简 `src/webdav/property-xml.ts`（`10.1A`）**
  - 保留基于 Drive `appProperties`（`wdp00`–`wdp29`）的通用 XML dead properties 与 `DAV:displayname` tombstone，以满足 RFC 4918 `SHOULD` 兼容度；精简 [src/webdav/property-xml.ts](src/webdav/property-xml.ts) 中的过度正则/标签配对校验与读取已存 `wdp*` 时的重复 `parseXml`，去除 [src/webdav/properties.ts](src/webdav/properties.ts) 二次 `DOMParser` 解析并合并冗余属性测试。

- [x] **`oc:checksums` 只读动态计算且 `PROPPATCH` 静默忽略（`10.2A`）**
  - `PROPFIND` 中的 `{http://owncloud.org/ns}checksums` 始终基于 Google Drive 真实返回的 `md5Checksum` / `sha1Checksum` / `sha256Checksum` 动态拼装；对 `PROPPATCH` 写入 `oc:checksums`（如 `rclone` 与 `DAV:lastmodified` 同批发送）不落盘至 `appProperties`，直接作为空操作返回 `200`，避免污染摘要或因 `403`/`424` 阻断 `mtime` 更新。

- [x] **对齐已知长度大文件 PUT 的校验逻辑**
  - 目前仅未知长度流式 `PUT`（`putUnknownLength`）严格校验分块响应状态、308 `Range` 及最终完成状态；已知长度 `PUT` 路径存在四处缺陷：
    - 使用 `parseInt` 解析 `Content-Length`，非法或负值会绕过循环返回假成功 `201`/`204`（应严格校验非负安全整数并在非法时返回 `400`）；
    - 无尾斜杠路径覆盖已有目录（`metadata?.mimeType === FOLDER_MIME`）未提前返回 `405`/`409`；
    - `> 5 MiB` 分块路径未先检查初始化 `!initRes.ok` 透传上游状态码，把失败全折叠成 `500`；
    - 分块循环未校验 `308` `Range`、末块收 `308` 报假成功，且输入流提前 `done` 时会静默提交截断体。

- [x] **修复顶层异常捕获复用 `errorStatus()`**
  - [src/router.ts](src/router.ts) 顶层 `catch` 直接读取 `e.status || e.code || 500`，若异常带非 HTTP 数字或字符串的 `e.code` 会导致 `new Response` 再抛出 `RangeError`；应统一改用已定义的 `errorStatus(e)`。

- [x] **将下载与 ETag 从 Drive v2 迁移至统一的 Drive v3（`4A-1`）**
  - 已于 2026-11-24 实测验证 Drive v3：`headRevisionId` 在 `multipart`/`media`/`resumable` 终块 `200`/空创建/`files.get`/`files.list` 均立即可用（仅改 `appProperties` 时保持不变、覆写内容时变化）；`revisions/{headRevisionId}?alt=media` 支持 `200`/`Range 206`/越界 `416`/空文件 `200`，且在文件被覆写为 `rev2` 后仍可从旧 `rev1` 不可变读取 `206`。
  - 统一将 `GET`/`HEAD`/`PROPFIND` 文件 ETag 迁至 `"<id>-<headRevisionId>"`（无 `headRevisionId` 时回退 `version`），`GET` 优先走 `revisions/{headRevisionId}?alt=media`（只读共享 `403` 或版本淘汰 `404` 时回退 `files/{id}?alt=media`），`If-Range` 绕过内存缓存实时校验 `headRevisionId`；移除 Drive v2 依赖并同步更新 `MockDrive`。

- [x] **核验线上 Cloudflare 部署限制与凭据边界**
  - 在真实 Cloudflare 环境中核验单请求入口体上限与内存上限（区分 TUS 分块多请求与单次大 `PUT`）。
  - 部署前配置加密 secrets（`CLIENT_ID`、`CLIENT_SECRET`、`REFRESH_TOKEN`、`USERS`）；Workers KV 绑定已全面移除，元数据缓存仅存 isolate 内存，上传状态存 `TUS_UPLOADS` Durable Object。
  - 核实 OAuth 应用发布状态及 Refresh Token 长期有效性；留意所有 `USERS` 账号共用同一 Google OAuth 身份，`ROOT_ID` 仅作应用路径映射，不会缩窄令牌本身的权限范围。

## oCIS 兼容层实施计划

设计文档：[协议边界](docs/ocis-compatibility.md)。参考探测证据：[探测报告](docs/ocis-probe-report.md)。

目标客户端：ownCloud Desktop 7.1.1（Linux/Windows）、OpenCloud Android 1.3.1、rclone 1.76.0（兼容参照 Cyberduck CLI 9.6.0、ownCloud CLI 6.0.3）。

- [ ] **OC-02：补齐目标客户端实机流量与精确 fixtures**
  - 在可运行原版客户端的环境中完成请求捕获（Desktop 7.1.1 GUI 先前因环境禁用 `AF_UNIX` 导致 `QLocalServer` 失败，Android 与 Windows 尚未实测）。
  - 保留脱敏 query 与完整 DAV XML / OCS / Graph 请求响应体，固化 `status.php`、精简 `capabilities` 与 checksum 需求。

- [ ] **OC-03：实现 Cloudflare Access + 薄 OAuth/OIDC 适配器**
  - 实现 WebFinger、OIDC discovery、`/oauth/authorize`（仅该路径受 Cloudflare Access 保护，Worker 校验 `Cf-Access-Jwt-Assertion` 与 `CF_ACCESS_AUD`/Access JWKS）、`/oauth/token`、`/oauth/userinfo`、`/oauth/jwks`。
  - 支持 PKCE `S256`、短效一次性授权码及客户端/回调白名单绑定（Desktop `127.0.0.1`/`localhost` 变端口、Android `oc://android.opencloud.eu`）；Auth DO 保存 opaque `access_token` 与可撤销、可重复使用的 `refresh_token`。
  - 使用 Worker Secret 中的静态非对称密钥（`ES256`/`RS256` 固定 `kid`）签发 `id_token`；在其余路径保留 `USERS` Basic Auth，并明确共享 `ROOT_ID` 的视图语义；`/oauth/*` 路由随 Cloudflare Access 配置（如 `CF_ACCESS_AUD`）存在而自动启用，未配置时仅运行 HTTP Basic `USERS` 模式。

- [ ] **OC-04：实现引导发现、OCS 与单 personal Space**
  - 实现 `GET /status.php`（返回兼容版本档案而非 `package.json` 版本）、`GET /ocs/{v1,v2}.php/cloud/{user,capabilities}`（同时支持 XML/JSON 与 v1 `meta.statuscode=100` / v2 `200` 及 `Ocs-Api-Version: 1`）、未认证 `/remote.php/webdav/` 返回 401 Bearer 质询、认证后 `OPTIONS /remote.php/webdav`、`HEAD /remote.php/dav/files/<user>/Personal/`（保留 404 回退到发现接口）、`GET /graph/v1.0/me/drives`。
  - 在 `files.tus_support` 中公告用户选定默认值 `max_chunk_size: 10485760`（10 MiB），在 `core.pollinterval` 中公告 `30000`（毫秒，30 秒，`#12`，并于实机验证实际轮询间隔），显式关闭分享（`files_sharing.api_enabled=false`）、团队 Space、通知与锁等未实现能力。
  - Space 视图按 `15A` 如实表达共享 `ROOT_ID`（鉴权主体、OAuth token 与 TUS 会话按用户隔离，底层共享同一 `ROOT_ID`）：Graph `/me/drives` 中 `owner` 省略或如实填当前登录主体，`quota` 使用 `BigInt` 精确透传 Drive `storageQuota` 整数（无有限上限或字段不全时省略，不伪造 `0`）。

- [ ] **OC-05：实现轻量目录/文件索引 DO 与 Drive `changes.list` 局部冒泡**
  - 先审计 Drive `changes.list` / `getStartPageToken` 并扩展 `MockDrive`（Google changes token 官方不失效，需覆盖游标丢失/无效重初始化、分页与权限失效恢复）。
  - 在 SQLite DO 维护轻量 `items(id, parent_id, is_folder, etag_gen)` 与游标 `pageToken`（DO 内存保留热 `root.eTag` 与节流时间戳）；本地变更与节流轮询仅沿受影响项及旧父目录向上冒泡递增 `etag_gen` 至 `ROOT_ID`，忽略 `ROOT_ID` 外部改动（支持外部编辑、移动与永久删除）。
  - 将 isolate 内存元数据/列表缓存键绑定至对应目录 `etag_gen`（并固定在途请求的起始 generation），避免新 ETag 搭配旧列表。

- [ ] **OC-06：在现有 DO TUS 基础上补齐 oCIS 上传需求**
  - 将 `TusUpload` DO 从当前 `1 MiB` 整块 `pending` 落盘重构为 `5A`（单次发往 Google 上限 `10 MiB` 的 256 KiB 整倍数，SQLite 仅存 `< 256 KiB` `tail` 与 `inflight` 恢复标记，崩溃时通过 `bytes */<total>` 对齐 Drive 真实偏移）。
  - 补齐 `creation-with-upload`（POST 带首块）、两类 `filename` 路径解析（Desktop 相对全路径 vs Android basename）、浮点 `mtime` / `X-OC-Mtime` 协调、按 `14A` 宽松解析 `Upload-Metadata`（核心字段严格校验；容忍尾逗号与 Cyberduck 9.6.0 明文 `filetype`，非法 `filetype` 回退 `application/octet-stream`，忽略未使用未知 key）、独立于公告块大小的请求上限。
  - 利用 Google Drive 最终提交返回的原生摘要字段校验客户端声明的 whole-file `checksum`（已于 2026-11-24 实测：`resumable` 终块 `200` 与 `multipart`/`media`/0 字节截断均立刻返回匹配的 `md5Checksum`/`sha1Checksum`/`sha256Checksum`；仅元数据创建空文件 `POST /drive/v3/files` 只返回 `md5Checksum`，故 0 字节上传直接在 Worker 侧比对空字节摘要常量；不匹配时新建文件移入回收站并报错、覆盖文件报错并由 Drive Revisions 兜底）；处理条件覆盖（`If-Match` 失配按标准返回 `412 Precondition Failed`，`#11`，不照搬 oCIS 8.2.3 的 `409`），并在完成响应返回实际 `ETag`/`OC-FileID`/`OC-Perm`；上传完成后立即清理 DO 状态与闹钟（`deleteAll()` + `deleteAlarm()`，`13B`），后续 `HEAD`/`PATCH` 返回 `404`（与 TUS 规范及 oCIS 8.2.3 一致），0 字节 `POST` 免建 DO，24h 闹钟仅清理未完成孤儿会话。
  - 通过实际 Worker 兼容层验证 `10,000,000` 字节 POST（余 `38,528` mod 256 KiB）及 10 MiB / 不规则 / 变块续传的跨块对齐与尾块持久恢复。

- [ ] **OC-07：按矩阵验收统一路由与 DAV 语义**
  - 实现并验收统一路由（`9.3`，无 `OCIS_ENABLED` 开关）：通用 WebDAV 默认 `/webdav/`（校验 `WEBDAV_PATH` 不与 `/` 或 oCIS 保留前缀冲突）、常驻 `/dav/spaces/<spaceId>/...`、`/remote.php/webdav/...`、`/remote.php/dav/files/<username>/...`，单次段解码、`$`/`%24` 等价、全站缺父统一返回 409（`9.2B`）、全站非 TUS `PATCH` 统一返回 405（`9.1A`）。
  - 验收 `4A-1` 统一 v3 ETag（`GET`/`HEAD`/`PROPFIND` 共用 `headRevisionId`、`revisions/{headRevisionId}?alt=media` 不可变读取与实时 `If-Range`）、`Prefer: return=minimal`、`oc:*` 属性（含 `10.2A` `oc:checksums` 真实摘要动态计算与 `PROPPATCH` 静默忽略）、`7A` 原生文档过滤与真实权限字段；验收 `PUT`/`TUS` `If-Match` 失配返回 `412`（`#11`）及 `8B` 文件夹 COPY（`Depth: 0` / `infinity` 与预算上限）。

- [ ] **OC-08：实现 Android 预览代理**
  - 支持 DAV GET `?preview=1` 及 `x/y/c` 参数与 `oc:has-preview` 属性；由 Worker 代理请求 Drive `thumbnailLink` 并缓存（按身份与版本隔离，不泄露 Google URL；依据真实缩略图可用性返回预览或 404）。

- [ ] **OC-09：全生命周期故障恢复测试（mock 对齐后）**
  - 使用已对齐的 Drive mock 注入故障：tail/inflight 标记落盘后中断、Google 已接收但丢响应、客户端确认丢失、最后提交丢响应、offset 冲突、部分确认与限流；验证 Worker/DO 重启后通过 `HEAD` + Drive `Range` 恢复无重复或丢字节且最终 SHA256 一致。

- [ ] **OC-10：多端实机同步与真实部署验收**
  - 完成 Linux/Windows 双向同步与 Android 上传/下载/预览实机验收，保留 rclone 回归。
  - 在真实部署的 Cloudflare 环境中实测超过单次入口上限的大文件上传及 DO 请求/存储成本。

- [ ] **OC-11：固化兼容矩阵与上线文档**
  - 记录支持客户端版本矩阵、资源/费用边界与迁移说明，全部门槛通过后再将设计文档状态更新为已支持。
