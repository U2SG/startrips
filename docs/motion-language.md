# Startrips Motion Language

本文是 Startrips 的统一动效规范，适用于地球、故事、媒体、编辑和控件。
下面六条原则约束实现与验收；已有 token 和 primitive 复用同一语言。
旧实现中的固定时长或 easing 不代表已经满足这些原则。

关键词：**克制、空间连续、柔光、纵深、内容承载变化。** 弹簧可以有与输入相称的
轻微过冲，不能为了装饰让每个元素都弹跳。

## 六条整体原则

1. **随时可打断，位置与速度连续。** 新输入接管正在显示的状态及速度，直接改变目标；
   不排队等旧动画结束，不先跳回起点，也不重新从零速度播放一条曲线。取消时释放旧动画、
   监听和指针所有权；卸载、失焦与新请求不能留下控制页面的旧回调。
2. **稳定命中，内容跟手。** 普通控件使用稳定的命中区域，图标反馈不带着按钮区域漂移。
   直接拖动的照片或地球则按输入即时跟随，松手后才进入弹簧；命中必须对应此刻可见内容，
   不能让透明副本、旧位置或正在离场的页挡住操作。原生视频控件保有自己的手势和键盘输入。
3. **以真实布局做 FLIP。** 先记录当前可见几何，再提交真实排序或归属，测量新布局，
   用反向 transform 消除瞬跳并收敛到新位置。撤销同样基于恢复后的真实布局；
   换行、滚动、尺寸变化与目标移动都要重新测量，不能用预设坐标模拟成功。
4. **最少 DOM，每帧批量更新。** 优先复用固定数量的展示节点；临时移动副本只服务当前交接，
   完成或中断即释放。每帧先批量读布局，再批量写样式；同一交互共用调度，不为每张照片
   建循环，不通过逐帧 React 更新驱动位移。页面和视频节点数不能随切换次数增长。
5. **减少动态效果，保留完整语义。** `prefers-reduced-motion` 跳过非必要空间位移，
   直接提交结果或使用短淡变；选中、焦点、加载、失败、排序、移动和撤销仍可理解、可操作。
   运行中切换偏好也要结束当前位移并释放所有权，不能靠等动画结束才更新语义。
   视频播放和路线回放的时间含义仍然成立，不能以关闭动效为由停用功能。
6. **空间交互用真实弹簧，时间语义用时间轴。** 拖动释放、照片切换、归位及可接管的空间过渡，
   使用共享弹簧参数与实际位置、速度求解；中途反向继承速度，不用固定时长 easing 冒充弹簧。
   视频、音频、路线回放与明确的进度按各自时间轴推进，暂停、跳转和倍速保留时间契约。
   时间轴可以驱动目标变化，但不能被弹簧改写播放时钟。

## Motion tiers

Tier 表达反馈层级和节奏。下表时长供时间轴、淡变和现有实现复用；真实弹簧以状态收敛结束，
不能强制在该毫秒数归零。弹簧参数统一维护，功能按语义选用，不各自调一套数值。

| Tier | Purpose | Duration | Notes |
| --- | --- | --- | --- |
| **Tier 0** | Instant feedback (hover / press / focus) | 80–160ms (`--motion-instant: 120ms`) | Movement ≤ 2–4px; stable hit geometry |
| **Tier 1** | UI re-layout (sidebar, reorder, controls) | 200–320ms (`--motion-ui: 260ms`) | `transform + opacity`; FLIP layout changes |
| **Tier 2** | Content transitions (card→story, tile→fullscreen) | 450–700ms (`--motion-content: 560ms`) | The content is the transition object; background recedes |
| **Tier 3** | Journey / globe narrative (camera fly-to, route draw) | 700–1600ms (`--motion-journey: 980ms`) | Slow start, steady cruise, soft settle; no modal easing |

## Tokens

Shared TS tokens: `src/motion/tokens.ts` → `motionTokens.tiers.*`,
`motionTokens.easings.*`.

CSS mirrors in global `:root` of `src/styles/tokens.css`:

```css
--motion-instant: 120ms;
--motion-ui: 260ms;
--motion-content: 560ms;
--motion-journey: 980ms;

--motion-ease-out: cubic-bezier(0.16, 1, 0.3, 1);            /* spatial ease-out */
--motion-ease-soft: cubic-bezier(0.2, 0.75, 0.15, 1);        /* soft settle */
--motion-ease-out-soft: cubic-bezier(0.22, 0.72, 0.24, 1);   /* lift / micro */
--motion-ease-in-out-spatial: cubic-bezier(0.65, 0, 0.35, 1);/* camera / draw */
```

Three.js 时间轴沿用 `src/motion/tokens.ts` 的 JS token，不复制数值。
上面的 easing 继续用于合适的时间过程；它们不是空间弹簧的实现。

## Five motion primitives

Everything else is a combination of these five:

1. **fade-through** — small state replacement (`motion-fade-through`).
2. **lift** — card/interactive surface spatial feedback (`motion-lift`;
   hover −3px, press −1px; keep the hit region stable).
3. **shared-expand** — thumbnail/card expands into story/fullscreen
   (`motion-shared-expand`; View Transitions API via
   `src/motion/primitives/sharedElement.ts`).
4. **draw** — route/light trail grows 0 → 1 (`motion-draw`).
5. **focus-flight** — globe camera flies from global view to a place
   (`motion-focus-flight`; driving JS in `ParticleEarthScene`).

## Glow discipline

- Glow is a **state**, not a decorative border.
- Active state: core + halo (`motionTokens.glow.coreOpacity` /
  `haloOpacity`); idle stays at very low opacity (`idleOpacity`).
- Never more than one strong glow focal point per screen.
- Soundtrack light strip, route halo, and active point share one luminance
  rhythm.

## Motion priority

同一时刻只有一个 Tier 2/3 主视觉焦点；同一动作中的照片移动、原位补齐和目的地反馈可以
协同发生，不应切成互相等待的装饰阶段。打开旅程时：

1. The card cover becomes the transition object.
2. Sidebar / background noise drops.
3. Story text enters last.

Never animate card, route, globe, sidebar, and title simultaneously.

## Reduced motion

One unified strategy: `useReducedMotion()` (React) /
`prefersReducedMotion()` (one-shot) from `src/motion/preferences.ts`.

- Tier 2/3 degrade to a short crossfade or an instant state; semantic completion does not wait for an animation event.
- Continuous particle drift / route pulse / soundtrack strip flow stops
  (CSS `@media (prefers-reduced-motion: reduce)` block in
  `living-atlas.css`).
- Spatial relationships and affordances stay clear.
- Preference changes cancel active spatial motion and settle to the latest valid state; native playback remains usable.

## 可观察验收

行为检查在 GitHub CI 执行，画面审阅使用对应提交的真实浏览器录屏与截图。两者分别判断：
CI 验证契约，逐帧和连续播放验证手感；CI 绿色不能替代画面审阅。未审阅时明确记录待完成。

| 场景 | 需要观察到的结果 |
| --- | --- |
| 连续前后切换 | 每次输入立即生效；中途反向没有位置跳变或突然停顿，最终媒体身份正确，页面和视频节点数量不增长。 |
| 动画中途按住拖动，再反向松手 | 内容从当前可见位置接到指针，释放继承实际速度；没有第二个运动实例争抢，也不误触全屏或翻页。 |
| 移动两张照片并撤销 | 照片有可辨认的出发点与目的地，原位按真实布局补齐；撤销返回恢复后的网格位置，数量、顺序和归属与画面一致。 |
| 动画中 resize、换行或滚动 | 重新测量有效目标，旧副本及时释放；没有飞向旧坐标、闪回或命中偏移。地球地理锚点仍服从 canonical projection。 |
| 静态及运行中开启 reduced motion | 状态及时完成、焦点可达、错误可恢复；没有残留位移、锁住的输入或缺失的移动/撤销结果。 |
| 视频原生控件及故事/全屏交接 | 原生播放、暂停、拖进度和音量能正常使用，不被翻页手势截获；当前资产、播放节点、时间和焦点所有权保持一致。 |

## Rules

- No new `transition: all 0.3s ease` anywhere.
- No new per-feature duration/easing/spring parameter literals.
- New motion composes from the five primitives and shared tokens; spatial and timeline drivers follow the six principles above.
- `motionPrimitiveClass` in `src/motion/tokens.ts` is the canonical name list.
