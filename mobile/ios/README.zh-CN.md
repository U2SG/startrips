# Startrips iPhone 开发指南

打开 `mobile/ios/Startrips.xcodeproj`，选择共享的 **Startrips** scheme。App 的导航、媒体查看、照片选择、后台传输和影片导出都跑在 iOS 上。地球、时间轴、字体和品牌资源来自仓库里的手机版网页，随 App 一起打包。这让同一个地球保持两端的视觉一致，也让翻页、缩放、系统相册和分享使用 iPhone 的手势和控件。

## 构建并打开一个真实图谱

1. 在 Mac 上安装 Xcode 16 或更高版本、iOS 模拟器和仓库指定的 pnpm 10.17.1。在仓库根目录运行 `pnpm install --frozen-lockfile`。
2. 在 Xcode 选择 iOS 17 或更高版本的 iPhone，运行 Startrips。构建阶段调用 `mobile/ios/bundle-scene.sh`，生成地球资源和 MapLibre worker。改地球样式、时间轴或共享字体后重新构建 App。
3. App 自动连接正式 Startrips HTTPS 服务 `https://106.53.130.142`，普通用户无需填写服务器地址，更无需自己部署后端。首次打开是深色欢迎页，只有「登录」和「粘贴分享链接」两个操作；在登录窗口完成身份和图谱选择后返回图谱。之后启动时，只要持久化的主人会话仍有效就直接打开图谱，会话缺失或过期则回到欢迎页而不是弹出错误。启用 Google 的站点会从原有 Google 按钮启动系统登录窗口，授权成功后回到同一站点选择图谱；该路径依赖 #769 的一次性登录码兑换接口。访客复制含片段令牌的完整 `/share#…` 链接后点「粘贴分享链接」。图谱顶部的账户按钮打开原生菜单：切换图谱、粘贴分享链接、退出登录（同时清除该资料的 Cookie）。只有开发者以 DEBUG 参数 `-allow-server-override` 启动时才会显示调试服务器输入框。
4. 真机运行时在 App target 的 Signing & Capabilities 中选择有权签名的 Team，再选择该 iPhone。使用测试图谱和可撤销的测试分享，不把用户素材放入仓库。

## Mobile V2 主界面设计基准

iPhone 图谱主界面复用 Web Mobile V2 的顶部品牌栏、当前旅程紧凑卡片、时间轴、旅程详情抽屉和全部旅程选择器，同样从 `src/journey/LivingAtlasApp.tsx` 和 `src/styles/living-atlas.css` 取得视觉语义。原生 Story 仍采用 SwiftUI/UIKit 实现视频播放、照片缩放与相册操作。由于本地图谱不能持有私有素材签名 URL，详情抽屉暂用品牌图形占位，封面图的真实权限化呈现仍需补全并以同数据截图验收。更改视觉布局后须保留模拟器 XCUITest 的原生导航和地球焦点断言。

## 代码从哪里改

| 要改的体验 | 入口 | 保持的约定 |
| --- | --- | --- |
| 导航、返回、前后台恢复 | `Sources/App/AppRouter.swift`、`AtlasRootView.swift` | 由原生导航保存当前旅程、地点和素材。按照当前身份和旅程修订重新解析它们。 |
| 地球、时间轴、地点控件 | `Scene/main.tsx`、`Scene/scene.css`、`Sources/Atlas/` | 复用生产地球、时间轴和字体。拖动摄像机后释放居中，下一次明确选点才重新聚焦。 |
| 场景与 App 之间的消息 | `Scene/bridge.ts`、`Sources/Bridge/SceneContract.swift`、`Fixtures/bridge.json` | Swift 和 TypeScript 读取同一个 fixture。请求、身份与修订不匹配时丢弃过时消息。 |
| 登录、分享和私有媒体读取 | `Sources/App/AtlasSession.swift`、`StoryDestination.swift` | 登录窗口与本地地球分开。主人用当前会话，访客只用分享令牌。私有签名和凭据留在原生侧。 |
| Story 和旅程连播 | `NativeMedia/Sources/Story/`、`Playback/` | 区分拖动中的候选页与已翻到的页。只有当前素材使用前台播放器，返回时按已提交的位置恢复。 |
| 导入、移动和恢复 | `NativeMedia/Sources/Import/`、`Sources/App/TransferAppDelegate.swift` | 系统相册选择后记录目标地点。按账户保存待传文件和分片回执，完成时使用服务端返回的素材 ID。 |
| 影片编排、生成和分享 | `NativeMedia/Sources/Export/` | 用同一旅程快照生成 v2 影片清单，AVFoundation 在设备上编码 MP4。导出和分享时重新核验权限。 |

表中的相对路径都以 `mobile/ios/` 为起点。手机网页是视觉基准。改卡片密度、字体、时间控件时先看现有生产组件。改大图、滑动、缩放、触控范围或系统分享入口时，直接在 iPhone 产品路径上检验。

## 三个工作包怎样接起来

- **#767 · App 和地球** 管理 Xcode 工程、AppRouter、地球资源和 CI 选择规则。向 Story 传递 `journeyId`、`routePointId`、`assetId`、`requestId` 和旅程修订。
- **#768 · 原生媒体** 从正常的 Story 入口打开素材。主人可导入、移动、撤销、导出和分享影片。访客按授权查看和播放。手动退出旅程播放先回到当前 Story，退出 Story 再回地球。
- **#769 · 服务端契约** 提供私有 `GET /api/uploads/{id}/status`。先在目标服务部署这个接口，再分发依赖断点恢复的 App。恢复时检查服务端是否已经完成、取消或仍在处理，避免重复上传和重复创建素材。

## 开发时选择哪些测试

在仓库根目录运行 `node --test scripts/ci-ios-scope.node-test.mjs` 可以快速验证分流。纯 iOS 改动由一台 iPhone 模拟器依次跑媒体包和 App 的测试。浏览器 QA、Web core 和 keepsake runner 会跳过。修改共享的网页组件时按受影响的范围选测试；修改测试分流规则本身需要跑对应保护检查。

需要在 Apple runner 复现时，从仓库根目录运行 `bash mobile/ios/ci-test.sh`。在 Xcode 中可分别运行 StartripsMedia 包的 XCTest，或 Startrips scheme 的 App 单测和界面测试。CI 的 `.xcresult` 放在 `artifacts/ios/`，包含断言、截图和失败时的控件层级。重复手动运行脚本前将上一轮同名结果移出该目录，以保留两次证据。

| 需要验证的改动 | 验证入口 |
| --- | --- |
| 地球加载、连续选点、拖动打断、时间轴和前后台恢复 | `AtlasUITests` 从 App 启动，操作实际打包的地球。 |
| Story 往返、取消翻页、切换照片和退出播放 | 同一个 `AtlasUITests` 流程调用 `verifyNativeMediaRoundTrip`，从已打开的图谱进入真实 Story，使用两张合成照片。 |
| 导入重试、移动撤销、签名隔离、影片时长、首尾帧和音轨 | `NativeMedia/Tests/` 的 XCTest。上传、数据库权限和事务并发另由 #769 的服务端集成测试覆盖。 |

## 真机与交付验收

1. 用主人账户打开测试旅程，连续点选两个地点，转动地球并等待约 20 秒，再选另一个地点。核对当前地点、镜头朝向、字体和时间轴可触达区域。
2. 从地点进入 Story，在同一张照片上分别尝试短拖取消、完整横滑、双击缩放和下拉退出。进入连播、中途退出再返回图谱，核对恢复的地点和素材。
3. 从 iCloud 照片导入多张图片和视频，切到后台后回来，检查同一批次的地点归属、恢复与取消。跨地点移动并撤销，核对源列表和目标列表。
4. 使用测试分享重复查看和播放，随后撤销分享。确认 App 失去访问权限，访客看不到导入、移动和导出操作。
5. 选择横屏与竖屏分别生成影片，检查首尾画面、字幕、有配乐和无配乐的音轨。有艺术封面的旅程要分别检查启用封面、关闭封面和系统「减弱动态效果」下的原图回退。把成片通过系统分享保存，并记录机型、iOS 版本、源码提交和结果。用 Instruments 在真机上记录选点和连续划页的停顿，人工检查滚动、缩放和播放流畅度。
6. 进入 TestFlight 分发前，核对服务端版本、签名、精确提交的 CI、独立代码复核及真机记录。模拟器通过与真机验收各自保留证据。
