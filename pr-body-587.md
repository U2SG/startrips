## 背景

对 `origin/main@f789649c` 做了 8 个生产 surface 的全量交互审计，结论与完整证据见 **#586**。

一句话结论：**工程严谨度是专业级水准，但「用户契约层」系统性偏弱。** 底层（prefetch 分级、revision 守卫、inert 所有权、reduced-motion 兜底、265 个 button 零未命名）做得越扎实，越显得上层契约没跟上。

本 PR 只做**第一批中经 CI 证实安全的那 5 项**。第 6 项被 CI 证伪并已回退，理由见下。

---

## 修的 5 件事

### 1. 播放层空格键退出播放，而不是暂停

`JourneyPlaybackOverlay` 注释写着「方向键分段、空格暂停、Esc 退出」，但：

- 焦点陷阱初始焦点是 `focusable()[0]`，即 **「退出播放」按钮**
- 全局快捷键 handler 对任何 `HTMLButtonElement` target 提前 `return`

所以按空格 → 原生按钮激活 → `requestClose()` → 整个播放被拆掉。方向键分段同样在陷阱内所有焦点位都不可达。

改法：根节点加 `tabIndex={-1}`，初始焦点改为 `overlayRef`。根节点不在 Tab 环内，但能承载程序化焦点，Space 与方向键随即按注释工作。原先「焦点逃逸进地图后主动聚焦关闭按钮」的逻辑（`mapInteractive` effect）保持不变。Tab 陷阱在根节点持有焦点时会正确地重定向进环内首尾。

### 2. Composer 关闭即销毁整个创作会话

Escape、header ✕ 三条路径都会把标题、故事、手工路线、每个点的备注和**所有已选 File 句柄**一起丢掉，无确认、无撤销、无 `beforeunload`。

**同一个产品里的 Story 已经实现了这个守卫**（`JourneyStory.tsx:824`「还有未保存的感想，请先保存或放弃更改。」），Composer —— 唯一真正持有创作会话的 surface —— 却没有。

改法：

- 脏基线在 mount 时捕获一次。**不能用 props 比较**：`routePoints` 在编辑已有 Journey 时初始就是该 Journey 的点，「非空」不等于「被改过」，否则每次编辑一打开就是脏的。
- 确认层是真正的嵌套 `alertdialog`，复用代码库既有的 `useNestedModalFocus`（接管 Tab 环、初始焦点、关闭后焦点归还）。
- 确认层初始焦点落在**「继续编辑」**上，与 JourneyStory 两处删除确认的既有约定一致 —— 不让破坏性操作拿走初始焦点。
- `savedResult` 存在时跳过守卫，「完成」保持普通关闭。
- 补 `beforeunload`，覆盖刷新/关标签页。

注意：`useModalFocus` 的 Escape 分支**不**检查 `isInsideNestedTrap`，守卫打开时它仍会调 `onRequestClose`。因此 Escape 的归属写在 `requestClose` 里：守卫开着就先关守卫，不会穿透成一次成员没要求的丢弃。

CSS 上没有给 `.journey-composer` 加 `position: relative`：该元素当前没有定位上下文，`.journey-composer__more-menu`（absolute + `left/right: 0`）是相对 `position: fixed; inset: 0` 的 backdrop 解析的，加了会把那个下拉从全视口收窄到 880px。backdrop 本身已经是视口级定位祖先，守卫直接用它。

### 3. 删除撤销按钮的文字颜色根本没生效

```css
.living-atlas__notice button.living-atlas__notice-undo {
  border: 1px solid rgba(200, 255, 61, 0.45);
  color: var(--atlas-accent);   /* 全代码库无定义 */
}
```

`--atlas-accent` 在 17 个样式表和全部 TSX 中零定义。声明在 computed-value 阶段失效，标签回落到继承色，而上一行的 border 仍是 acid —— 两者视觉分叉。这正是删除 Journey 后成员最需要一眼看到的控件。

改用 `var(--atlas-acid)`，即那条 border 已经编码的同一个颜色。**不新增别名**：单点使用不值得扩出第二个 token。

### 4. Composer 输入框没有焦点环

```css
.living-atlas input:focus-visible { outline: … }            /* (0,2,1) */
.journey-composer input:not([type="checkbox"]):not([type="file"]) { outline: none }  /* (0,3,1) */
```

每个 `:not([type=…])` 都按其参数计特异性，所以 `(0,3,1)` 压过 `(0,2,1)`。**Composer 里每一个文本输入框都没有焦点环，而同一个规则里的 textarea 却保留着。**

移除该 opt-out 让两者共享全局焦点环；同时把下划线从 1px 纯色相变化改为 2px acid 线 —— 纯色相变化不符合 WCAG 2.2 SC 2.4.11 / SC 1.4.1。

### 5. WebGL2 不可用时地球是一片无声的空白

**对初评的一处修正**：初评把它列为 P0「整页白屏」，这是错的。`ParticleEarthScene.tsx:2032` 的 `throw` 发生在 `useThreeScene` 的 `factoryRef.current(host)` 内部，被该 hook 自己的 `try/catch` 捕获并交给 `onCreateError`，React 树不会卸载。

真实缺陷是降级**无声**：`unavailable` 状态被组件完全知道（驱动 `data-particle-earth-backend`），却从不渲染给任何人。用户只看到一片空的深色区域。

改法：给出可见且可播报的提示，说明原因，并指向手动输入坐标 —— 按 `AGENTS.md` 的硬约束，手动坐标是与地球点击并列的路线录入路径，**是产品契约而不是降级方案**，所以要写出来而不是让人自己发现。

提示放在 `.persistent-earth-host` **之外**：该 host 是 `aria-hidden="true"`，`role="status"` 放里面永远不会被播报。

---

## 试过但已回退：桌面端浏览器 Back

初评的 6 号是「桌面端 Back 直接卸载整个应用」，并建议去掉四个 `useMobileSurfaceHistory` 注册上的 `isMobileV2` 门控。

**这个建议是错的，CI 证伪后已回退。**

`qa-post-login-controls` 断言的是相反的契约：

```js
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForFunction(() => {
  const stack = window.history.state?.__startripsMobileSurfaceStack;
  return !Array.isArray(stack) || stack.length === 0;
});
```

跨越响应式边界时，所有 Startrips 所有的 sentinel 必须在**一次**有界 history 移动内塌缩，且不得导航或重载文档。这些 mobile 层在桌面断点会卸载，一个比它们活得久的注册会留下孤儿 token，让 Back 去消费它而不是做有意义的事。所以 `isMobileV2` 门控是**承重的**。

初评把门控读成疏忽，是因为它注意到了 `crossPointReading`（`LivingAtlasApp.tsx:1488`）未门控、桌面端已经可 Back 关闭，于是推断整体模型不自洽。实际上那是另一个未门控的层，与 mobile 断点模型无冲突。

结论：**桌面端 Back 会带着打开的 Story 离开 Atlas，这是当前契约。** 要改需要一个同样按断点作用域的 desktop 侧 history owner，而不是拿掉一个门控。已记入 #586，本 PR 只留下解释该门控为何存在的注释，避免下一个审计再犯同样的错。

---

## 验证

- `pnpm typecheck` 通过，0 error
- 未改任何测试断言依赖的字符串
- 首次推送的 CI 证实：`core` 绿；`browser-qa / shell-composer` 因上述已回退的 6 号变红，回退后应恢复

## 不在本 PR 范围（#586 已列）

- 桌面端 Back 与 Story 的历史所有权（需要新设计，非改门控）
- Composer 的浏览器 Back 仍不经过脏守卫 —— 需要把 dirty 状态提升到 shell
- Story scope 切换清 Undo、Stop 降级剥归属、删除撤销单槽
- auth 7 个 async handler 的 `try/catch`、错误文案拆分
- CSS token 治理（z-index → 颜色 → 断点）

Implements #586
