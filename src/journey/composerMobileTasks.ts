/**
 * #375: the mobile-primary progressive-disclosure information architecture of
 * the Journey Composer, as one piece of data.
 *
 * The owner's decision (issue #375, 2026-09-19) is that mobile is the primary
 * Startrips device and its value is simplicity, so the primary Composer surface
 * carries only the few controls the current editing step needs. Every other
 * capability moves to a contextual expansion, a secondary task or a deliberate
 * More path - and none of them may simply disappear.
 *
 * "Nothing is merely hidden" is therefore not prose in a PR body: every
 * capability the Composer has is listed here exactly once with the task that
 * owns it, the control that reveals it and where closing it returns to, and
 * `composerMobileTasks.test.ts` fails if any capability lacks one of those.
 *
 * Desktop renders the same information architecture with more of it inline; it
 * does not need visual parity and keeps its existing two-column markup.
 */

export const COMPOSER_TASK_ATTRIBUTE = "data-composer-task";
export const COMPOSER_TASK_ENTRY_ATTRIBUTE = "data-composer-task-entry";
export const COMPOSER_SCROLL_OWNER_ATTRIBUTE = "data-composer-scroll-owner";
export const COMPOSER_POSTURE_ATTRIBUTE = "data-composer-posture";

/**
 * Below this height the Composer's own chrome - a 98px editorial header and a
 * 78px action bar - leaves too little room for the field a person is typing in.
 * A phone in landscape with the keyboard open lands here, so the header's
 * decorative lines collapse and the field stays on screen.
 */
export const COMPOSER_CONSTRAINED_HEIGHT = 420;

export type ComposerMobileTaskId =
  | "primary"
  | "journey-info"
  | "media"
  | "appearance"
  | "location";

/** A capability's place in the mobile hierarchy. */
export type ComposerCapabilityTier =
  /** On the primary surface, visible while that surface is active. */
  | "primary"
  /** Revealed in place by the record or panel it belongs to. */
  | "contextual"
  /** Its own task, entered from the primary surface. */
  | "secondary"
  /** Behind the deliberate More path. */
  | "more";

export type ComposerCapabilityPlacement = {
  /** What the person is trying to do, in product language. */
  label: string;
  tier: ComposerCapabilityTier;
  /** The task whose panel renders this capability on compact mobile. */
  task: ComposerMobileTaskId;
  /** The control that reveals it. Never empty: a capability with no entry is hidden. */
  entry: string;
  /** Where dismissing it returns to. Never empty, for the same reason. */
  returnTo: string;
};

export type ComposerMobileTask = {
  id: ComposerMobileTaskId;
  /** Heading of the task panel; also the focus target when the task opens. */
  heading: string;
  /** Label of the control that enters the task from the primary surface. */
  entryLabel: string;
  /** Tasks reached through the deliberate More path rather than a direct control. */
  behindMore: boolean;
};

export const COMPOSER_MOBILE_TASKS: readonly ComposerMobileTask[] = [
  { id: "primary", heading: "这段旅程", entryLabel: "返回这段旅程", behindMore: false },
  { id: "journey-info", heading: "旅程信息", entryLabel: "旅程信息", behindMore: false },
  { id: "media", heading: "照片与影像", entryLabel: "整理媒体", behindMore: false },
  { id: "appearance", heading: "旅程的光", entryLabel: "外观", behindMore: true },
  { id: "location", heading: "位置细节", entryLabel: "位置细节", behindMore: true },
];

export const COMPOSER_SECONDARY_TASKS = COMPOSER_MOBILE_TASKS
  .filter((task) => task.id !== "primary")
  .map((task) => task.id);

const PRIMARY_SURFACE = "Composer 主界面";
const MEDIA_TASK = "媒体任务";
const LOCATION_TASK = "位置细节任务";
const ROUTE_POINT_ROW = "Route Point 记录行";

/**
 * Every capability the Composer has, including the ones the owner's decision
 * did not name explicitly (upload progress, failed-media retry, playback
 * preview, the manual add form's own fields, the #372 record lookup and the
 * #371 record row actions). Their placement is derived from the approved
 * architecture rather than invented: record work stays with the record, journey
 * metadata is contextual, media organisation is a secondary task, and rarely
 * used precision controls sit behind More.
 */
export const COMPOSER_CAPABILITIES = {
  "journey-title": {
    label: "旅程标题",
    tier: "primary",
    task: "primary",
    entry: PRIMARY_SURFACE,
    returnTo: PRIMARY_SURFACE,
  },
  "place-search": {
    label: "搜索并添加地点",
    tier: "primary",
    task: "primary",
    entry: PRIMARY_SURFACE,
    returnTo: PRIMARY_SURFACE,
  },
  "record-lookup": {
    label: "查找本旅程已有的 Route Point",
    tier: "primary",
    task: "primary",
    entry: "主界面搜索框，输入后出现「本旅程已有地点」分组",
    returnTo: PRIMARY_SURFACE,
  },
  "route-point-list": {
    label: "Route Point 列表",
    tier: "primary",
    task: "primary",
    entry: PRIMARY_SURFACE,
    returnTo: PRIMARY_SURFACE,
  },
  "route-point-reorder": {
    label: "调整 Route Point 顺序",
    tier: "primary",
    task: "primary",
    entry: "记录行上的上移与下移",
    returnTo: PRIMARY_SURFACE,
  },
  "route-point-remove": {
    label: "删除 Route Point",
    tier: "primary",
    task: "primary",
    entry: "记录行的更多操作菜单",
    returnTo: ROUTE_POINT_ROW,
  },
  save: {
    label: "保存",
    tier: "primary",
    task: "primary",
    entry: "常驻底部的保存按钮",
    returnTo: PRIMARY_SURFACE,
  },
  "save-progress": {
    label: "上传进度与保存状态",
    tier: "primary",
    task: "primary",
    entry: "保存后常驻在底部操作上方",
    returnTo: PRIMARY_SURFACE,
  },
  "save-media-retry": {
    label: "重试失败的媒体",
    tier: "primary",
    task: "primary",
    entry: "保存状态里的重试失败媒体",
    returnTo: PRIMARY_SURFACE,
  },
  "playback-preview": {
    label: "预览播放",
    tier: "primary",
    task: "primary",
    entry: "底部操作里的预览播放",
    returnTo: PRIMARY_SURFACE,
  },
  "close-composer": {
    label: "关闭编辑器",
    tier: "primary",
    task: "primary",
    entry: "标题栏的关闭按钮",
    returnTo: "Atlas",
  },
  "route-point-rename": {
    label: "修改 Route Point 名称",
    tier: "contextual",
    task: "primary",
    entry: "展开记录行",
    returnTo: ROUTE_POINT_ROW,
  },
  "route-point-note": {
    label: "这一站的记录",
    tier: "contextual",
    task: "primary",
    entry: "展开记录行",
    returnTo: ROUTE_POINT_ROW,
  },
  "route-point-stop": {
    label: "标记停靠",
    tier: "contextual",
    task: "primary",
    entry: "展开记录行",
    returnTo: ROUTE_POINT_ROW,
  },
  "route-point-media-upload": {
    label: "为这一站添加照片或视频",
    tier: "contextual",
    task: "primary",
    entry: "展开记录行里的上传入口",
    returnTo: ROUTE_POINT_ROW,
  },
  "journey-dates": {
    label: "开始与结束日期",
    tier: "contextual",
    task: "journey-info",
    entry: "主界面的旅程信息",
    returnTo: PRIMARY_SURFACE,
  },
  "journey-note": {
    label: "旅程故事",
    tier: "contextual",
    task: "journey-info",
    entry: "主界面的旅程信息",
    returnTo: PRIMARY_SURFACE,
  },
  "media-upload": {
    label: "添加照片或视频",
    tier: "secondary",
    task: "media",
    entry: "主界面的整理媒体",
    returnTo: PRIMARY_SURFACE,
  },
  "media-assignment": {
    label: "媒体归属",
    tier: "secondary",
    task: "media",
    entry: "主界面的整理媒体",
    returnTo: PRIMARY_SURFACE,
  },
  "media-order": {
    label: "媒体顺序",
    tier: "secondary",
    task: "media",
    entry: "主界面的整理媒体",
    returnTo: PRIMARY_SURFACE,
  },
  "media-remove": {
    label: "移除待上传媒体",
    tier: "secondary",
    task: "media",
    entry: "媒体任务里每个文件的管理入口",
    returnTo: MEDIA_TASK,
  },
  "light-color": {
    label: "单色基调",
    tier: "more",
    task: "appearance",
    entry: "主界面更多里的外观",
    returnTo: PRIMARY_SURFACE,
  },
  "light-effect": {
    label: "多色特效",
    tier: "more",
    task: "appearance",
    entry: "主界面更多里的外观",
    returnTo: PRIMARY_SURFACE,
  },
  "manual-coordinates": {
    label: "手动输入经纬度并添加地点",
    tier: "more",
    task: "location",
    entry: "主界面更多里的位置细节",
    returnTo: PRIMARY_SURFACE,
  },
  "globe-pick": {
    label: "直接在地球上取点",
    tier: "more",
    task: "location",
    entry: "位置细节里的取点入口",
    // The pick yields interaction to the Atlas and comes back to the task it
    // was started from, which is what ST-043's inert/focus handoff already does.
    returnTo: LOCATION_TASK,
  },
} as const satisfies Record<string, ComposerCapabilityPlacement>;

export type ComposerCapabilityId = keyof typeof COMPOSER_CAPABILITIES;

export const COMPOSER_CAPABILITY_IDS = Object.keys(COMPOSER_CAPABILITIES) as ComposerCapabilityId[];

export function composerTask(id: ComposerMobileTaskId) {
  const task = COMPOSER_MOBILE_TASKS.find((entry) => entry.id === id);
  if (!task) throw new Error(`unknown composer task ${id}`);
  return task;
}

export function composerCapabilitiesForTask(id: ComposerMobileTaskId) {
  return COMPOSER_CAPABILITY_IDS.filter((capability) => COMPOSER_CAPABILITIES[capability].task === id);
}

/**
 * The height the Composer may use while a soft keyboard is open. The browser
 * keeps the layout viewport at its full height and shrinks only the visual
 * viewport, so a dialog sized to the layout viewport puts its sticky actions
 * behind the keyboard. Sizing to the visual viewport instead keeps the final
 * row and the save action reachable.
 *
 * `offsetTop` is the visual viewport's own offset: while the page is scrolled
 * under the keyboard, the space actually available below the dialog's top edge
 * is the visual height minus that offset.
 *
 * `null` means "no keyboard is taking space", i.e. the dialog keeps its own
 * sizing rather than being pinned to a measured pixel height.
 */
export function composerAvailableHeight(
  layoutHeight: number,
  visualHeight: number | null,
  offsetTop = 0,
) {
  if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
  if (visualHeight === null || !Number.isFinite(visualHeight) || visualHeight <= 0) return null;
  const available = Math.round(visualHeight - Math.max(0, offsetTop));
  if (available <= 0) return null;
  if (available >= Math.round(layoutHeight)) return null;
  return available;
}

/**
 * How the Composer should carry its own chrome at a given available height.
 * `null` means the normal posture; the decorative header lines are only worth
 * their space when there is space.
 */
export function composerHeightPosture(availableHeight: number | null) {
  if (availableHeight === null || !Number.isFinite(availableHeight)) return null;
  return availableHeight <= COMPOSER_CONSTRAINED_HEIGHT ? "constrained" : null;
}
