# Bug 修复与验证清单（复核版）

原文来源：`origin/docs/bug-review-todo-20261103:todo.md`，原基线 `78161f0`。  
初次复核日期：2026-11-14，基线 `8ae7b31`（Google Drive mock contract audit）。  
上次更新：2026-11-19（v2 下载验证器重构）。审查修正已提交 `eb1c95d`，与本次下载修改位于独立 `fix/drive-download-etag` 分支；`dev` 仍为 `73398c2`；本文已经纳入版本管理，不再本地忽略。TUS 基础修复位于已推送的 `fix/durable-tus-upload` `c45b349`，尚未合入 dev；旧对象 `fef204e` 丢失不等于恢复分支丢失。恢复后尚未重跑该分支全套测试，合入及复测属于 OC-06 前置步骤。下方历史记录中的“本地忽略/未提交”等只描述当时状态。

## 复核结论与证据边界

- 2026-11-16 已合并 PATH 冷实例路由修复（PR #7）：分支 `fix/cold-path-routing` 基于 `origin/dev` `540d017`，环境初始化移到入口路径判断之前，保留一次性初始化和静态路径例外。默认、自定义带/不带尾斜杠、根路径共 4 个隔离实例回归，覆盖重定向、路径边界和认证。旧代码 3 failed / 1 passed，修复后全套 278 passed（13 个文件/项目结果），两组 TypeScript 检查和构建通过。无真实 Google API 调用；按用户要求已提交并推送 `950e6e4`，远端 tree 与已验收工作区一致。移除此待办，已确认合并。

- 2026-11-16 已合并修复（PR #5，`d8afadb`）：移除虚假 Class 2 / exclusive write 锁声明，LOCK/UNLOCK 明确返回 501，PROPFIND supportedlock 为空。新增协议回归测试；全套 204 passed，两组 TypeScript 检查及构建通过。未调用真实 Google API；锁请求不触发 Drive 调用。已移除此待办。

- 2026-11-15 本地修复：普通 DELETE 已复用子树缓存清理，移除该待办。已覆盖带/不带尾斜杠、多层后代、删除后 HEAD 404、同名重建使用新 ID、KV-only 分页清理、上游与 KV 故障，以及普通文件/根目录/缺失路径语义。KV 清理失败后的持久缓存残留及跨实例最终一致性仍未解决；普通 DELETE 仍为永久删除。

- 初次合并的 mock audit 未修改生产源码；本次 PR #2 已修改 `src/worker.ts`。已移除三个已修复项：MOVE/COPY 覆盖先永久删除目标且忽略失败、路径别名自操作误删源、目录 COPY 拒绝前破坏目标。目录后代缓存项曾缩小为普通 DELETE 的剩余问题，现已提交修复（`9864750`）。
- PR #2 的 MOVE/COPY 改用可恢复覆盖，增加路径/ID/目录关系检查，目录 COPY 在变更前拒绝；目录移动和覆盖会清理后代路径缓存。KV 清理失败与跨实例最终一致性仍有边界，不代表跨请求原子事务。
- 已从待办中移除“MockDrive 允许目录复制 / 不存在对象 PATCH 伪造成功”：当前 mock 分别返回 403 / 404，已有正式测试；2026-11-13 的真实 API 审计也观察到同样结果。见 [`test/mock-drive.md`](test/mock-drive.md)。
- 已移除“补齐本地 OAuth 和 USERS”这一过时前提：当前本地配置四项均非空，且之前的真实审计成功使用了 OAuth。**这不等于验证了线上部署配置或令牌未来有效性。**不在本文记录凭据。
- 下文区分：**本次复现**（当前源码 + 修正后的 MockDrive）、**故障注入**（人为提供上游失败/边界响应）、**代码确认**、**既有真实审计**、**尚未验证**。没有把注入结果当成 Google 一定会如此响应。
- 本次未向真实账号发送变更请求，也未执行真实永久删除。复用了已合并的真实 API 审计证据，并核对下文官方文档。此前 115 次 HTTP 请求不是 115 个测试用例，也不是整个 WebDAV 服务的真实端到端验收。

## 已推送独立 TUS 分支，待审查合入 dev

- TUS 已改为每上传 SQLite Durable Object：持久尾块与待发块日志、串行偏移检查、按真实 Google Range 恢复、完成回执及24小时清理；不再使用 KV 会话。
- rclone v1.76.0 已实际验证 TUS：25 MiB+123字节文件在模拟12 MiB单请求入口下经3个PATCH成功，字节/hash/mtime一致，单次大PUT为413。仅本地Worker+DO+已对齐mock，不是Cloudflare线上验收。
- 真实 Google 追加审计覆盖重放/重叠、非最终块部分确认、完成状态查询、空上传及mtime，新差异已同步mock；故障注入/DO重启仍为本地测试。所有本次真实测试资源仅移入垃圾箱。
- 历史记录：独立分支 `fix/durable-tus-upload` 基于 `873aff9`，曾提交 `fef204e`，当时未推送/部署/合入dev。提交前全套305 tests / 14 files、两组TypeScript、构建与diff check通过。旧对象已丢失；恢复提交 c45b349 已验证在远端，原验收记录不当作恢复后重跑结果。

## 设计选择、功能缺口和部署核验（不列为已证实的运行故障）

- [ ] **确定普通 DELETE 的永久删除 / 回收站语义**
  - 普通 `DELETE`（最新 794–804）仍调用永久删除接口；PR #2 的覆盖流程已改用回收站，不再调用覆盖辅助永久删除。这是普通删除的高风险设计选择，但 WebDAV 本身不强制回收站，不能仅据此定性为协议 bug。
  - 普通删除是否改为 `trashed: true` 应明确决策和说明；覆盖流程现已有可恢复保护，但不具备跨请求原子性。回收站实现后需验证目录、权限与恢复；真实永久删除测试需单独确认。

- [ ] **为 Google Docs/Sheets 等原生文档明确下载策略**
  - 当前 `getRawContent` 仅使用 `alt=media`，没有 `files.export`。这是功能缺口，不应宣称所有原生文档都必然返回同一个 403。
  - 选择支持哪些导出 MIME/扩展名，或明确提示不支持；本次没有真实原生文档下载验收。参见前述 Google 下载/导出说明。

- [ ] **按真实部署确认上传入口和内存限制**
  - 后端 10 MiB 分块不绕过客户端 → Worker 的单请求体限制；TUS 多请求与单次大 PUT 应分开验收。
  - 实际方案、入口和账号限制尚未核实；本地 Wrangler 成功不代表线上大文件可用。[Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

- [ ] **核验线上配置和权限边界**
  - 本地凭据不再是缺失项；不要把本地配置成功等同于远端 secrets 配置成功。
  - `wrangler.jsonc` 的 KV ID 仍为 `google-drive-webdav-kv`；部署前应确认/替换为实际 Namespace ID，或明确不用 KV。未查询云端 Namespace。
  - OAuth 应用发布状态及未来 Refresh Token 过期策略未核实，不推断当前应用一定处于 External + Testing。
  - 所有 USERS 账号使用同一 Google OAuth 身份；ROOT_ID 是应用路径映射，不会缩小令牌本身的授权范围。这是权限边界说明，而非已验证的越权漏洞。

## 本次验证与后续验收

2026-11-16 PR #8 合并后核对：

- `origin/dev` 为 `873aff9`，与本地 HEAD 跟踪文件一致，未知长度 PUT 待办已移除。下一项仍是独立 TUS 适配层；PUT 修复不会自动修复跨请求 TUS 会话。
- 定向 TUS 复现 2 passed / 126 skipped；未修复生产代码、未提交，临时诊断已恢复。本次未重新跑全套或访问真实 Google API。协议参考：[TUS 1.0 核心协议](https://tus.io/protocols/resumable-upload#core-protocol)。

2026-11-16 PR #7 合并后核对：

- `origin/dev` 为 `94f7929`，与本地 HEAD 跟踪文件一致。PATH 已不在待办，合并后重跑隔离路由测试 4 passed。
- 下一项未知长度 PUT 无界缓冲已用 6 MiB 离线流确认（1 passed / 115 skipped），没有压力/OOM 测试，未访问真实 Google。未修改生产代码、未提交，临时诊断已恢复。

2026-11-16 PR #6 合并后核对：

- `origin/dev` 为 `540d017`，与本地 `7919ef9` 无跟踪文件差异。已移除 PROPPATCH 假成功待办；当前属性持久化实现可解析 XML、查资源、保存/读回属性并报告实际失败。合并后属性集成测试 38 passed。
- 下一项 PATH 初始化顺序问题经隔离冷实例测试确认（1 passed）。本次没有真实 API 调用、没有重新跑全套，未改生产代码、未提交或推送。

### 已移除的 PROPPATCH 项历史（已合并，不再待办）

- **PROPPATCH 对未处理的属性构造虚假成功响应**（PR #6 已合并；下述为修复前诊断及合并前记录）
  - 位置（2026-11-16 最新 dev）：`src/worker.ts:867–879`；现有 `test/dav.test.ts:217–228` 只断言空 propertyupdate 返回 207 / 内层 200，没有验证属性保存。
  - 2026-11-16 定向复现：对已有文件设置自定义属性、对不存在路径设置属性、发送非 XML 文本，均返回 207、空 `prop` 和内层 200 OK，响应不含请求属性名。三次 PROPPATCH 没有任何上游 fetch，mock 文件完全未变，后续 PROPFIND 不返回设置的值。代码没有读请求体、查询资源或保存属性。不是正确的逐属性成功响应。定向离线测试 1 passed / 137 skipped，临时测试已还原；没有真实 Google API 调用。
  - 影响：客户端可能误以为标签、时间戳等元数据已保存，也可能因响应缺少属性项而报错；不会因本方法改写文件内容。具体客户端反应尚未验证。
  - 2026-11-16 按用户要求实现完整属性流程而非拒绝：namespace-aware XML set/remove、dead properties 存入 Drive appProperties、PROPFIND allprop/propname/指定属性/include、protected property + 424 原子失败；native 修改时间/description/starred/folderColorRgb 映射。创建时间经真实 API 确认不可更新。单个 files.update 提交最终原生+dead数据；分片配额约3570字节含JSON/XML，超限507，不假称无限；不加分布式锁。
  - 真实合同审计发现 files.copy 不自动继承 appProperties，COPY 已显式携带。新增 mock 合同测试；隔离测试资源全移Trash，无永久删除。根目录只验证读取，不声称根写入/Shared Drive验证。
  - 本地 feat/webdav-properties 基于 origin/dev b8e7255，未提交/推送/部署。全套298 tests通过（12文件；已按独立审查合并重复协议测试，新增确定性KV旧写入顺序/上游配额/损坏存储回归），两组tsc、build dry-run、diff check通过。普通测试仍全mock不访问真实Google。已同步dist，详情 docs/webdav-behavior.md / test/mock-drive.md。


2026-11-16 PR #5 合并后核对：

- `origin/dev` 为 `b8e7255`，包含锁修复 `d8afadb`，与本地 HEAD 无跟踪文件差异；锁问题已不在待办。
- 下一项 PROPPATCH 假成功经当前代码及定向离线测试再次确认（1 passed / 137 skipped）。未修复代码，临时诊断测试已恢复，没有提交或推送。没有重新运行全套或调用真实 Google API。

2026-11-16 PR #4 合并后核对：

- `origin/dev` 为 `1218a8e`，包含图片原图下载修复 `31d6ee8`，与本地 HEAD 跟踪文件一致。已移除图片 GET 待办；当前普通文件 GET 统一走原媒体接口并传递 Range。
- 图片修复记录：合并前已补齐 mock 媒体 GET 契约，并只读核对真实审计文件下载和闭合 Range；验收为离线测试。本次未重复运行全套测试或访问真实 Google API。
- 重新确认下一项锁能力声明问题，定向离线复现通过；尚未修复。本文为唯一保留修改，仍本地忽略，不提交。

2026-11-16 合并后核对：

- `origin/dev` 为 `7793ea5`，包含远端 `8edf824` 与 `1b9a441`；与本地 HEAD 的跟踪文件 diff 为空。没有切换分支、重写历史、提交或推送。
- DELETE 子树缓存与 KV 命中寿命问题均已修复并合并，不再列为待办。列表内存 30 秒/KV 最少 60 秒是用户已接受的策略，不再作为待解决问题；元数据为 300 秒，KV 命中不回填内存，TUS 保持原行为。跨实例/跨地域一致性不在本次修复目标内。
- 下一项图片 GET 问题经当前代码与定向注入重新确认，尚未修复；本次未调用真实 Google API，也未重新运行全套测试。

2026-11-15 用户授权推送：

- 已发布远端分支 `origin/fix/delete-subtree-kv-expiry`，相对 dev 提前 2 个提交，未创建 PR。
- 本地 HTTPS Git 缺少凭据，改用已连接 GitHub 插件发布相同的 Git 树。远端提交分别为 `8edf824`（DELETE）和 `1b9a441`（KV），与原本地 `9864750`、`945318c` 的 tree SHA 逐一一致。API 使用新的提交元数据，故提交 SHA 不同。
- 已重新 fetch 并分别 diff 两个远端提交与本地对应提交，均无差异；远端分支指向 `1b9a44158f8544076105bb421ec3bcfbacbfbf02`。原本地提交保留，未重写本地历史；后续开发前需留意本地/远端提交元数据不同。
- 跟踪文件干净，本文与本地凭据未上传；未部署。远端 combined status 暂未返回状态检查，不代表 CI 已通过。以下“未推送”描述是此前验证时的历史状态。

2026-11-15 KV 命中不回填修复验证（`945318c`）：

- 基于 `origin/dev` 的 `d566724` 创建分支 `fix/delete-subtree-kv-expiry`，先独立提交普通 DELETE 修复 `9864750`，再提交 KV 修复 `945318c`。两个提交均包含各自更新后的 `dist/worker.js`。
- 新增 5 项回归测试：元数据/列表临近 KV 到期和到期后的行为、本地写入 TTL 与到期后每次读取访问 KV，以及 TUS 会话原有 5 分钟回填行为。
- 用修复前源码运行新增测试：4 项元数据/列表回归按预期失败，TUS 保持行为测试通过；恢复修复后源码再进行最终验证。
- `pnpm test --run`：10 个测试文件、187 项通过（dav 127 项）。`pnpm exec tsc --noEmit`、`pnpm exec tsc --noEmit -p test/tsconfig.json`、`pnpm run build` dry-run 和 `git diff --check` 均通过。
- 跟踪文件工作区干净；本文继续本地忽略。未推送、未部署、未向真实 Drive 发送变更请求。测试退出仍有非阻塞 workerd WebSocket 断开提示。首次定向测试的 Wrangler 日志路径提示不影响通过，最终运行将日志写至 `/tmp`。
- 此修复不消除列表 30/60 秒 TTL 差异、跨实例已有内存缓存或 KV 最终一致性，详见上方剩余待办及 `docs/webdav-behavior.md`。

2026-11-15 普通 DELETE 修复验证：

- `pnpm test --run`：10 个测试文件、182 项通过，新增 10 项 DELETE 回归测试（dav 共 122 项）。
- `pnpm exec tsc --noEmit` 与 `pnpm exec tsc --noEmit -p test/tsconfig.json` 通过；`pnpm run build` dry-run 通过，已同步跟踪的 `dist/worker.js`。
- `git diff --check` 通过。上述源码、正式测试和构建产物已在本次后续操作中提交为 `9864750`；本文仍由本地 exclude 忽略。未推送、未部署、未向真实 Drive 发送变更请求。测试退出时仍有非阻塞 workerd WebSocket 断开提示。

2026-11-15 本次更新验证：

- `git fetch origin dev` 确认 PR #2 合并提交为 `d566724`；`git diff HEAD origin/dev` 为空。
- `pnpm exec vitest run --project dav`：现有 112 项 + 1 项临时 DELETE 后代缓存复现共 113 项通过。临时检查断言的是当前错误行为，运行后已移除，不是修复回归测试。
- 首轮临时检查误以为实际 GET 会返回 404，但观察到 500；改为仅验证下载不成功后重跑通过。HEAD 错误返回 200 的复现两轮均成立。
- 本次未重跑其他项目、类型检查或构建。未更改源码和正式测试，未提交、未推送、未部署；`todo.md` 仍由 `.git/info/exclude` 本地忽略。

2026-11-14 初次复核已完成（以下不是本次重新执行的结果）：

- 当前源码的 12 组临时定向检查全部通过，断言的是上述**现有错误行为**，不是修复后正确行为。使用 TypeScript 转译后的源码、独立 VM、当前 MockDrive 及定向 fetch/KV 注入；不等同于 workerd 或真实 Google 端到端测试。
- `pnpm exec tsc --noEmit` 与 `pnpm exec tsc --noEmit -p test/tsconfig.json` 通过。
- `pnpm test --run`：3 个文件、78 项测试通过（其中 44 项 mock contract、34 项现有 WebDAV/auth）。退出时仍有非阻塞 workerd WebSocket 断开提示。
- `pnpm run build`：Wrangler dry-run 通过，未部署；生成的 `dist/worker.js` 与现有跟踪版本无差异。没有为修文档改动源码、正式测试或构建产物。

后续待办：

- 已合并 PR #2–#8 的修复均已有正式回归；余下各项继续要求断言**正确行为**，不重复列作一个未完成的全局修复。
- 后续端到端验收统一归 OC-09/OC-10；已对齐 mock 的行为不重复做真实 Drive 验收，缺失合同才做隔离审计。
- 后续生产配置和平台大文件边界归 OC-10/OC-11；不重开泛化的跨地域强一致目标。OC-05 单独验证同步 generation 不与旧数据混用。破坏性操作只用隔离资源，永久删除另行确认。

2026-11-16 PROPPATCH 发布验证：

- 分支 `feat/webdav-properties` 已推送，提交依次为 `901a6d1`（真实Drive属性mock合同）、`3ae3d7a`（属性实现及文档）、`7919ef9`（全套测试精简和断言加强）。
- 最终274项测试、9文件通过；两组TypeScript检查、构建dry-run、diff check通过。未创建PR或部署。
- 已重新fetch验证本地与远端HEAD及tree完全一致，tree为 `1ceedb2efb0b22381614173ff9e0a051f2189a01`。跟踪工作区干净，本文与真实凭据仍忽略且未发布。

## oCIS 兼容层实施计划

设计：[协议边界](docs/ocis-compatibility.md)。证据：[探测报告](docs/ocis-probe-report.md)。
当前是完整操作范围调查与设计，不是全客户端动态验收完成；未决门槛不能标为已支持。
目标：ownCloud Desktop 7.1.1（Linux/Windows）、OpenCloud Android 1.3.1、rclone 1.76.0。
以下已勾选项描述2026-11-16记录的完成状态，不表示2026-11-17恢复时重新测试。

- [x] OC-00：曾独立提交既有 TUS DO 修复 `fef204e`，dev文档提交未混入代码；恢复后的独立分支为已推送 `c45b349`，文档dev不包含它。
- [x] OC-01：固定客户端源码版本，调查认证、Spaces、全文件操作、预览、同步与恢复；记录证据边界。
- [ ] OC-02：在可运行原版客户端的环境完成请求捕获。当前7.1 GUI被QLocalServer限制阻断，Android/Windows未实测。固化status/OCS/Graph精确fixtures、路径与checksum能力，不仅登录/目录。
- [ ] OC-03：实现最小有效OAuth/OIDC登录、PKCE、code/refresh、真实签名ID token、DO会话和撤销，复用USERS校验；测试回调白名单/过期/重放/刷新/账号隔离。不得把客户端ID/secret当用户密码。
- [ ] OC-04：实现discovery/status/user/capabilities/单personal Space、真实身份/权限/URL；关闭分享/团队/通知等未实现能力，验证客户端不会被默认值误导。
- [ ] OC-05：验证并选最简同步变化方案。比较Drive changes+DO generation与保守周期全树发现，测外部变更、移动/删除、游标丢失/无效状态恢复、失败/缓存、延迟与调用成本；目录/root ETag不可固定，未验证前不承诺无漏同步。
- [ ] OC-06：合入审查后TUS基础，补creation-with-upload、空文件、两类filename路径、mtime/checksum/条件覆盖、完成ETag/ID/权限、POST/PATCH块上限协商。Google mock缺失功能先对齐再验收。
- [ ] OC-07：按矩阵验收DAV CRUD、原图/Range、元数据/权限/冲突；解决目录COPY初版承诺、普通DELETE trash/永久策略与Google Docs表示，不用假成功掩盖缺口。
- [ ] OC-08：Android DAV预览和has-preview，Worker代理缩略图、不泄露Google URL；明确尺寸/缓存/无预览行为。
- [ ] OC-09：全生命周期恢复：客户端/Worker重启、丢响应、offset冲突、Google部分接收/超时/限流、过期/配额/checksum/最后提交丢响应；使用已对齐mock，不无谓重复真实Drive验收。
- [ ] OC-10：Linux/Windows双向同步与Android前后台上传/下载/预览实机验收，保留rclone回归；真实部署再验收超过单次入口上限的文件，本地模拟不等于线上通过。
- [ ] OC-11：固定版本兼容矩阵、资源/费用界限、部署迁移说明；通过门槛后才将设计改为已支持协议。

### 2026-11-18 审查后补充验收点

以下是上述阶段的细化，不是第二套待办，也不将尚未实施 oCIS 当作已实现 bug：

- OC-02：捕获保留脱敏 query 和 PROPFIND/PROPPATCH XML 请求/响应、小 OCS/Graph 内容；请求大小不能证明属性名。rclone 337B PROPPATCH 已用原版1.76.0对本地synthetic recorder补采，确认 DAV:lastmodified Unix秒 + oc:checksums；不是oCIS/Worker验收，既有旧 wire 不补造丢失内容。保留凭据、token、会话 URL 脱敏。
- OC-03：签名密钥持久化及轮换/JWKS 保留、固定官方 client_id/回调白名单、并发刷新策略和 USERS 共享 ROOT_ID 的真实权限边界。status 兼容版本不是本项目 package 版本，也不宣称运行原版 oCIS。
- OC-04：OCS v1/v2、XML/JSON、v1 meta=100/v2 meta=200、OPTIONS /remote.php/webdav、Cyberduck fallback 404、Space ID 的 $/%24 单次解码。精确字段和值由 fixtures 驱动。
- OC-05：先审计 Drive changes 并建 mock；generation 与 metadata/listing 缓存键绑定，覆盖旧内存/KV、进行中旧写入、分页/重启/外部删除移动；不能新 ETag 搭配旧列表。Google changes token 官方不失效，不编造 TTL。测子目录挂载下账户外变更导致的遍历成本。
- OC-06：先合入/复测 c45b349；data-bearing POST、两种 filename、浮点 mtime/X-OC-Mtime、Cyberduck 可选提示语法、独立请求上限；checksum 在 Google 最终提交前校验，hash 状态可恢复且重放不重复计入；完成元数据按真实响应。HEAD 完成回执 200 与旧 offset 重放 409 保留，验证客户端恢复，不机械仿照参考 HEAD 404。
- OC-07：GET/HEAD/PROPFIND validators 一致且同 mtime 写入不可碰撞；If-Range 本地判断。legacy 自动父目录行为与兼容路由缺父 409 分开测试；oCIS opt-in 路由不能静默遮蔽 legacy spaces 目录；非 TUS PATCH 不走 COPY。Google Docs/Shortcuts 表示、普通 DELETE 策略在本阶段决策，保留文首理由，不另重复勾选。
- OC-10/OC-11：入口限制、DO 请求/存储开销、实际 KV ID/secrets/OAuth 部署核验统一在此验收，文首项目为解释索引。

测试按独立行为组织，避免按客户端复制同样mock断言；客户端运行记录与协议合同分层。暂不引入R2、完整oCIS服务栈或客户端修改。

### OC-02 动态探测补充

- [x] 官方oCIS8.2.3本地运行，原版CLI6.0.3完成大文件分块上传、下载hash、改名/覆盖/删除；rclone1.76完成独立CRUD/空文件/Unicode/TUS。
- [x] HTTP首块POST/HEAD/错误offset/最终完成、Range、预览、路径metadata、后代变更root ETag实测，差异在报告；旧原始observations已丢失；2026-11-17已重新执行54请求/66断言，当前JSON是新完整脱敏响应记录，不是补造旧值。
- [ ] rclone默认块10MiB不遵循10,000,000-byte capability。区分推荐块大小与实际接收上限，回归两类客户端。
- [ ] CLI6是旧版Basic路径，不替代7.1 GUI OAuth、Android/Windows或精简capabilities验收；OC-02不因部分突破全部勾选。
- [ ] OC-06补Cyberduck9.6可选filetype明文与尾逗号兼容，容忍/忽略可选hint但不放宽filename/path/checksum。
- [x] 官方OIDC真实HTTP链路login/consent/code+PKCE/token、Bearer Graph、refresh；重放code400、错误Bearer401，不是未来自建认证层/GUI验收。
- [x] 错误PKCE verifier400 invalid_grant；随后正确verifier不能复用被消耗code。其余安全边界仍需实现层测试。

### OC-06 / OC-09：兼容层到 Drive 的跨块验收门槛

- [ ] 通过实际Worker兼容层（不是直连官方oCIS）运行客户端：文件超过两块，10,000,000-byte首POST+至少两个PATCH，以及10MiB默认/不规则/续传改变块大小；下载逐字节或SHA256比对。
- [ ] 10,000,000除256KiB余38,528，不能把公告对齐当实现保障。断言Google侧非最终块对齐、最终余块不丢失、tail/journal有界持久化。
- [ ] 跨边界注入tail/待发块落盘后中断、Google已接收但丢响应、客户端确认丢失；重启Worker/DO后HEAD/Range恢复重试，验收无重复/丢字节、最终长度/hash一致和真实Upload-Offset。缺失mock行为先审计，不无谓重复真实Drive验收。

### 服务器公告块大小实测

- [x] 公告10,000,000 / 8MiB / 12MiB，三个原版客户端共9组实际上传+下载逐字节相同：CLI6首POST/PATCH跟随；rclone1.76/Cyberduck9.6保持10MiB PATCH、空POST。见报告及JSON。
- [x] rclone本地`--webdav-nextcloud-chunk-size 8Mi/12Mi`不改变infinitescale实际10MiB，不作为可用TUS调块方案。
- [x] 用户选定默认公告 **10MiB（10,485,760 bytes，40×256KiB）**，统一已测客户端默认完整块大小。
- [ ] OC-04实现该公告；不是请求硬上限，也不保证其它客户端、末块/续传块遵循。独立接收上限，保留有界tail/journal及不规则块/恢复验收。
- [x] Cyberduck CLI独立`env tus.chunk.size=...`8MiB/12MiB/256KiB实测生效，下载hash相同；这是本地配置非服务器协商，不泛化为GUI设置验收。

### 2026-11-17 丢失证据重新探测

- [x] 官方oCIS8.2.3重新下载校验；HTTP54请求/66断言通过，补齐完整响应头、小XML/JSON、二进制hash和可复现脚本，替代partial observations。
- [x] 真实OIDC HTTP两实例重跑完成，token/refresh/Bearer与重放/错误verifier等19条响应记录通过断言，脱敏结果与脚本已保存；非GUI验收。
- [x] 修正预览说法：文本可生成JPEG200，opaque binary404；PNG预览32×32与原图字节均验证。不把所有非图片视为无预览。
- [ ] 原有Worker→Drive、GUI/Android/Windows、精简capabilities与部署验收仍按OC-02/OC-06/OC-09/OC-10推进；参考服务端重跑不替代这些门槛。

- [x] 客户端证据重新运行：四种公告（10,000,000/8MiB/12MiB/最终10MiB）×三原版客户端共12组，完整文件下载hash一致；独立validator校验capability/退出码/首POST和每PATCH/末块。
- [x] 5个本地配置覆盖重跑：Cyberduck8MiB/12MiB/256KiB生效，rclone Nextcloud8Mi/12Mi仍10MiB；下载hash均相同。
- [x] 三客户端21次CRUD命令全部成功，CLI/rclone实际下载hash一致，Cyberduck110,000,000B实际下载hash一致。保留脱敏wire与复现脚本；不把命令退出码当全语义/并发验收。
- [x] 参考证据分层保存：HTTP54请求/66断言、OIDC19响应、客户端12矩阵+21CRUD+5覆盖、固定官方来源hash，均无私有凭据。未增加默认生产测试的外部依赖或真实Drive访问。

### 2026-11-19 下载验证器与分支边界

- 二进制下载使用 Drive v2 `alt=media` 的真实 HTTP ETag；v3 元数据/写入接口不变。If-Range 对返回的部分内容强 ETag 比较后才流式透传，否则完整重取；416 也完整重取，其他错误不掩盖。
- HEAD 不增加媒体请求，也不输出由缓存元数据伪造的强 ETag；PROPFIND version 仍是同步变化标记，不等同下载表示验证器。oCIS 客户端对这一区别的完整验收仍属于 OC-07。
- KV 移除单独放在 `fix/durable-tus-upload`，不合并到本下载分支或 dev；该分支先已有 DO 上传会话，因此可移除整个 KV 依赖。此分支仍保留 KV，部署说明按各分支实际配置理解。
- 本下载分支验证：13 files / 311 tests、源码与测试两组 TypeScript、build dry-run、diff check 全部通过；构建产物已同步，默认测试仍只访问 mock。
