import { useEffect, useRef, useState } from "react";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import {
  COMMAND_BAR_NOTHING_HERE,
  COMMAND_BAR_STORY_NOTHING_HERE,
  COMMAND_BAR_TIMEOUT_MS,
  COMMAND_BAR_TIMEOUT_TEXT,
  commandBarFailure,
  commandBarLatencyStage,
  commandBarManualEntry,
  commandBarOfferedIntents,
  commandBarWaitCopy,
  commandCardFromAnswer,
  MAX_COMMAND_TEXT_LENGTH,
  type CommandSurfaceContext,
} from "./commandBarModel";
import { routeCommand, type CommandIntent } from "./journeyApi";
import { ProposalCard, type ProposalCardModel, type ProposalCardProps } from "./ProposalCard";
import { useNestedModalFocus } from "./useModalFocus";

const PLACEHOLDERS: Record<CommandSurfaceContext["surface"], string> = {
  atlas: "说一句话：记录、分享或打开一段旅程",
  composer: "调整途径点顺序，例如：把理塘放到最后",
  share: "例如：分享今年的三段旅程，7 天有效",
  story: "说说选中的照片属于哪里，例如：这些是在理塘拍的",
};

export type CommandBarProps = Omit<ProposalCardProps, "card" | "onRevise" | "onDismiss"> & {
  routed: readonly CommandIntent[];
  context: Omit<CommandSurfaceContext, "composerPointCount" | "storySelectionCount">;
  activeJourneyId: string | null;
  /** 503: the deployment stopped routing; the host refetches and hides the bar. */
  onCapabilitiesStale: () => void;
  onClose: () => void;
};

type Pending = { sequence: number; startedAt: number };

/**
 * The one-sentence entry. It is a nested focus layer (`data-focus-trap-exempt`)
 * so it works over the Atlas and, as an overlay, over the Composer or the
 * share dialog; closing it returns focus to whatever held it.
 *
 * One reply, one card: a new reply replaces the card, and a new sentence
 * supersedes (and aborts) the one still waiting.
 */
export function CommandBar({
  routed,
  context,
  activeJourneyId,
  onCapabilitiesStale,
  onClose,
  ...cardProps
}: CommandBarProps) {
  const rootRef = useNestedModalFocus<HTMLDivElement>(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [card, setCard] = useState<ProposalCardModel | null>(null);
  const [cardKey, setCardKey] = useState(0);
  const sequenceRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timedOutRef = useRef(0);
  const cardRef = useRef(card);
  cardRef.current = card;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(performance.now() - pending.startedAt), 200);
    return () => window.clearInterval(timer);
  }, [pending]);

  function stop(message: string | null) {
    sequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(null);
    setFailure(message);
  }

  // A confirm in flight (e.g. a share link being created) cannot be dismissed:
  // its result must be seen, so Escape waits like 取消 does.
  const cardWorkingRef = useRef(false);
  function dismissCard() {
    if (cardWorkingRef.current) return;
    setCard(null);
    inputRef.current?.focus({ preventScroll: true });
  }

  // Esc belongs to this layer while focus is in it: the modal underneath
  // listens on `document` in the capture phase, so this runs on `window`.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !rootRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      if (cardRef.current) dismissCard();
      else if (pendingRef.current) stop(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  // A press outside closes it, except on its own header trigger (which toggles).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || rootRef.current?.contains(target) || target.closest("[data-command-bar-trigger]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose, rootRef]);

  async function submit() {
    const sentence = text.trim();
    if (!sentence) return;
    const bridge = cardProps.composerBridge.current;
    const composerPoints = context.surface === "composer" ? bridge?.points() ?? [] : [];
    const storyBridge = context.surface === "story" ? cardProps.storyBridge.current : null;
    const story = storyBridge
      ? { journeyId: storyBridge.journeyId, selectionCount: storyBridge.selectionCount() }
      : null;
    const offered = commandBarOfferedIntents(routed, {
      ...context,
      composerPointCount: composerPoints.length,
      storySelectionCount: story?.selectionCount ?? 0,
    });
    stop(null);
    setCard(null);
    if (offered.length === 0) {
      showCard(context.surface === "story"
        ? { kind: "note", text: COMMAND_BAR_STORY_NOTHING_HERE, manual: commandBarManualEntry("assign-photos") }
        : { kind: "note", text: COMMAND_BAR_NOTHING_HERE, manual: commandBarManualEntry(null) });
      return;
    }
    const sequence = sequenceRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPending({ sequence, startedAt: performance.now() });
    const timer = window.setTimeout(() => {
      timedOutRef.current = sequence;
      controller.abort();
    }, COMMAND_BAR_TIMEOUT_MS);
    try {
      const answer = await routeCommand(sentence, {
        surface: context.surface,
        intents: offered,
        // Over the Story, the Journey is the one whose media are selected.
        activeJourneyId: story?.journeyId ?? activeJourneyId,
        ...(offered.includes("route-order") ? { composerPoints } : {}),
        ...(offered.includes("assign-photos") && story ? { selectionCount: story.selectionCount } : {}),
      }, controller.signal);
      if (sequence !== sequenceRef.current) return;
      showCard(commandCardFromAnswer(answer, {
        journeys: cardProps.journeys,
        composerPoints,
        story,
        preview: (order) => cardProps.composerBridge.current?.preview(composerPoints, order) ?? null,
      }));
    } catch (error) {
      if (sequence !== sequenceRef.current) return;
      if (controller.signal.aborted) {
        setFailure(timedOutRef.current === sequence ? COMMAND_BAR_TIMEOUT_TEXT : null);
        return;
      }
      const result = commandBarFailure(error);
      setFailure(result.text);
      if (result.refetchCapabilities) onCapabilitiesStale();
    } finally {
      window.clearTimeout(timer);
      if (sequence === sequenceRef.current) {
        setPending(null);
        abortRef.current = null;
      }
    }
  }

  function showCard(next: ProposalCardModel) {
    setCard(next);
    setCardKey((key) => key + 1);
  }

  const stage = pending ? commandBarLatencyStage(elapsed) : "quiet";
  const waitCopy = pending ? commandBarWaitCopy(elapsed) : null;

  return (
    <div
      ref={rootRef}
      className="command-bar motion-fade-through"
      data-focus-trap-exempt="true"
      data-command-bar-surface={context.surface}
      role="dialog"
      aria-modal="true"
      aria-label="一句话操作"
      tabIndex={-1}
    >
      <form
        className="command-bar__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          ref={inputRef}
          className="command-bar__input"
          type="text"
          aria-label="用一句话说想做什么"
          placeholder={PLACEHOLDERS[context.surface]}
          maxLength={MAX_COMMAND_TEXT_LENGTH}
          enterKeyHint="send"
          autoComplete="off"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="command-bar__submit" disabled={!text.trim()}>理解</button>
      </form>

      {pending && stage !== "quiet" ? (
        <div className="command-bar__wait" role="status" data-command-bar-wait={stage}>
          <StartripsJourneyCue state="waiting" size={28} />
          <span>{waitCopy}</span>
          {stage === "staged" ? (
            <button type="button" onClick={() => stop(`已停止。${commandBarManualEntry(null)}`)}>停止</button>
          ) : null}
        </div>
      ) : null}

      {failure ? <p className="command-bar__failure" role="alert">{failure}</p> : null}

      {card ? (
        <ProposalCard
          key={cardKey}
          card={card}
          {...cardProps}
          onRevise={() => {
            setCard(null);
            inputRef.current?.focus({ preventScroll: true });
            inputRef.current?.select();
          }}
          onDismiss={dismissCard}
          onWorkingChange={(working) => { cardWorkingRef.current = working; }}
        />
      ) : null}
    </div>
  );
}
