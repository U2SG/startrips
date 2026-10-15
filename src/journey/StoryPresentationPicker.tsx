import type { Ref } from "react";
import { IconArrowBackUp, IconPlayerPlay } from "@tabler/icons-react";
import { IconActionButton } from "../components/IconActionButton";
import { useMediaPresentationAccess } from "./MediaPresentationProvider";
import "../styles/story-presentation-picker.css";

/** Session navigation is independent of Account's saved media presentation. */
export function StoryPresentationPicker({ disabled = false, onOpenClassic, onReturnPresentation, buttonRef }: {
  disabled?: boolean;
  /** Shared readers use the same exit while their existing capabilities stay read-only. */
  onOpenClassic?: () => void;
  onReturnPresentation?: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const access = useMediaPresentationAccess();
  const navigate = onReturnPresentation ?? onOpenClassic;
  if (!navigate && !access?.error) return null;
  return <div className="story-presentation-picker">
    {navigate ? <IconActionButton type="button" className="story-presentation-picker__navigation"
      buttonRef={buttonRef}
      label={onReturnPresentation ? "进入媒体呈现" : "退出媒体呈现"}
      disabled={disabled || Boolean(access?.busy)} onClick={navigate}>
      {onReturnPresentation
        ? <IconPlayerPlay size={19} stroke={1.5} aria-hidden="true" />
        : <IconArrowBackUp size={19} stroke={1.5} aria-hidden="true" />}
    </IconActionButton> : null}
    {access?.error ? <span role="status" className="story-presentation-picker__error">
      {access.error}<button type="button" disabled={disabled || access.busy}
        onClick={() => access.retry()}>重试</button>
    </span> : null}
  </div>;
}
