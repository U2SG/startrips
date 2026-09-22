export type StartripsRecoveryKind = "not-found" | "empty" | "error";
export type StartripsRecoveryActionKind = "home" | "back" | "create" | "retry";

export type StartripsRecoveryCopyKey =
  | "recovery.notFound.eyebrow"
  | "recovery.notFound.title"
  | "recovery.notFound.body"
  | "recovery.notFound.primary"
  | "recovery.notFound.secondary"
  | "recovery.empty.eyebrow"
  | "recovery.empty.title"
  | "recovery.empty.body"
  | "recovery.empty.primary"
  | "recovery.error.eyebrow"
  | "recovery.error.title"
  | "recovery.error.body"
  | "recovery.error.primary";

export type StartripsRecoveryDescriptor = {
  kind: StartripsRecoveryKind;
  code?: string;
  copyKeys: {
    eyebrow: StartripsRecoveryCopyKey;
    title: StartripsRecoveryCopyKey;
    body: StartripsRecoveryCopyKey;
    primaryAction: StartripsRecoveryCopyKey;
    secondaryAction?: StartripsRecoveryCopyKey;
  };
  primaryActionKind: StartripsRecoveryActionKind;
  secondaryActionKind?: StartripsRecoveryActionKind;
};

export const STARTRIPS_RECOVERY_COPY: Readonly<Record<StartripsRecoveryCopyKey, string>> = {
  "recovery.notFound.eyebrow": "RETURN TO THE ATLAS",
  "recovery.notFound.title": "这条路，暂时没有故事",
  "recovery.notFound.body": "页面可能已移动，或链接不完整。回到图谱，继续下一段旅程。",
  "recovery.notFound.primary": "返回 Startrips",
  "recovery.notFound.secondary": "返回上一页",
  "recovery.empty.eyebrow": "NO JOURNEYS YET",
  "recovery.empty.title": "第一颗星，从这里亮起",
  "recovery.empty.body": "一段远行，或只在一个地方停留。记下第一段旅程，让走过的路留在地球上。",
  "recovery.empty.primary": "记录第一段旅程",
  "recovery.error.eyebrow": "PRIVATE ATLAS",
  "recovery.error.title": "暂时无法读取旅程",
  "recovery.error.body": "连接没有完成。可以安全重试，已经记录的旅程不会因此改变。",
  "recovery.error.primary": "重试",
};

export const STARTRIPS_RECOVERY_SURFACES: Readonly<Record<StartripsRecoveryKind, StartripsRecoveryDescriptor>> = {
  "not-found": {
    kind: "not-found",
    code: "404",
    copyKeys: {
      eyebrow: "recovery.notFound.eyebrow",
      title: "recovery.notFound.title",
      body: "recovery.notFound.body",
      primaryAction: "recovery.notFound.primary",
      secondaryAction: "recovery.notFound.secondary",
    },
    primaryActionKind: "home",
    secondaryActionKind: "back",
  },
  empty: {
    kind: "empty",
    copyKeys: {
      eyebrow: "recovery.empty.eyebrow",
      title: "recovery.empty.title",
      body: "recovery.empty.body",
      primaryAction: "recovery.empty.primary",
    },
    primaryActionKind: "create",
  },
  error: {
    kind: "error",
    copyKeys: {
      eyebrow: "recovery.error.eyebrow",
      title: "recovery.error.title",
      body: "recovery.error.body",
      primaryAction: "recovery.error.primary",
    },
    primaryActionKind: "retry",
  },
};

export function getStartripsRecoveryDescriptor(kind: StartripsRecoveryKind) {
  return STARTRIPS_RECOVERY_SURFACES[kind];
}

export function getStartripsRecoveryCopy(key: StartripsRecoveryCopyKey) {
  return STARTRIPS_RECOVERY_COPY[key];
}

export function canUseStartripsRecoveryBack({
  historyLength,
  referrer,
  origin,
}: {
  historyLength: number;
  referrer: string;
  origin: string;
}) {
  if (historyLength <= 1 || !referrer) return false;
  try {
    return new URL(referrer).origin === origin;
  } catch {
    return false;
  }
}
