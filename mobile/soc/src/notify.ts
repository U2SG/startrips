// 每日复习提醒：本地通知（无需服务端推送）。每天固定时间提醒今天有多少张闪卡待复习。
// 通知文案在「调度那一刻」固定，所以每次 app 进前台 / 下课后用当前 due 数重新调度，让数字保持新鲜。
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import * as data from './data';
import { dueCount, loadAllFlashcards } from './stats';

const REMIND_HOUR = 20; // 每天 20:00 提醒
const REMIND_MIN = 0;
const CHANNEL = 'daily-review';

// 通知到达时即使 app 在前台也展示横幅
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  }),
});

let permReady: boolean | null = null;

/** 请求权限 + 建 Android 渠道，返回是否可用。结果缓存，重复调用便宜。 */
export async function ensureNotifyReady(): Promise<boolean> {
  if (permReady !== null) return permReady;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: '每日复习提醒',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const cur = await Notifications.getPermissionsAsync();
    const granted = cur.granted || (await Notifications.requestPermissionsAsync()).granted;
    permReady = !!granted;
  } catch {
    permReady = false;
  }
  return permReady;
}

/** 用当前到期张数重排每日提醒；count 省略则现算 active 世界的 due 数。无世界则跳过。 */
export async function scheduleDailyReminder(worldId: string | null, count?: number): Promise<void> {
  if (!(await ensureNotifyReady())) return;
  try {
    let due = count;
    if (due === undefined) {
      if (!worldId) return;
      due = dueCount(await loadAllFlashcards(worldId));
    }
    await Notifications.cancelAllScheduledNotificationsAsync();
    const body = due > 0
      ? `今天有 ${due} 张闪卡到期复习，花几分钟巩固一下吧。`
      : '来复习巩固一下学过的知识吧，保持连续学习记录。';
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Socratopia · 该复习啦', body },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: REMIND_HOUR, minute: REMIND_MIN,
        channelId: Platform.OS === 'android' ? CHANNEL : undefined,
      },
    });
  } catch { /* 通知失败不影响主流程 */ }
}

/** 发一条 5 秒后的测试通知：装机后快速验证「权限→渠道→弹出」整条管线通不通。
 *  返回错误文案（null 表示已排程）。 */
export async function sendTestNotification(): Promise<string | null> {
  if (!(await ensureNotifyReady())) return '通知权限未开启，去系统设置里允许通知';
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Socratopia · 测试提醒', body: '通知能正常弹出，每日复习提醒已就绪。' },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 5,
        channelId: Platform.OS === 'android' ? CHANNEL : undefined,
      },
    });
    return null;
  } catch (e: any) {
    return `发送失败：${e.message}`;
  }
}

/** 关闭并清空提醒（设置里关掉时用） */
export async function cancelReminders(): Promise<void> {
  try { await Notifications.cancelAllScheduledNotificationsAsync(); } catch { /* ignore */ }
}

// 让 worldId 取 active 世界更方便：给 App 用的便捷封装
export async function rescheduleForActiveWorld(): Promise<void> {
  try {
    const act = await data.getActive();
    await scheduleDailyReminder(act?.worldId || null);
  } catch { /* 没连上就先不排 */ }
}
