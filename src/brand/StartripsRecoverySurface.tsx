import { IconArrowLeft, IconPlus, IconRefresh } from "@tabler/icons-react";
import { StartripsSignatureMotion } from "./StartripsSignatureMotion";
import {
  getStartripsRecoveryCopy,
  getStartripsRecoveryDescriptor,
  type StartripsRecoveryActionKind,
  type StartripsRecoveryKind,
} from "./recoverySurfaces";

const ACTION_ICON = {
  home: IconArrowLeft,
  back: IconArrowLeft,
  create: IconPlus,
  retry: IconRefresh,
} satisfies Record<StartripsRecoveryActionKind, typeof IconArrowLeft>;

function Action({
  kind,
  label,
  onAction,
  secondary = false,
}: {
  kind: StartripsRecoveryActionKind;
  label: string;
  onAction?: () => void;
  secondary?: boolean;
}) {
  const Icon = ACTION_ICON[kind];
  const className = secondary ? "startrips-recovery-surface__action is-secondary" : "startrips-recovery-surface__action";
  if (kind === "home") {
    return (
      <a
        className={className}
        href="/"
        onClick={onAction ? (event) => { event.preventDefault(); onAction(); } : undefined}
      >
        <Icon size={17} stroke={1.4} aria-hidden="true" />{label}
      </a>
    );
  }
  if (!onAction) return null;
  return (
    <button type="button" className={className} onClick={onAction}>
      <Icon size={17} stroke={1.4} aria-hidden="true" />{label}
    </button>
  );
}

export function StartripsRecoverySurface({
  kind,
  onPrimaryAction,
  onSecondaryAction,
  detail,
  className = "",
  headingLevel = 1,
}: {
  kind: StartripsRecoveryKind;
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
  detail?: string | null;
  className?: string;
  headingLevel?: 1 | 2;
}) {
  const descriptor = getStartripsRecoveryDescriptor(kind);
  const primaryLabel = getStartripsRecoveryCopy(descriptor.copyKeys.primaryAction);
  const Heading = headingLevel === 2 ? "h2" : "h1";
  const secondaryLabel = descriptor.copyKeys.secondaryAction
    ? getStartripsRecoveryCopy(descriptor.copyKeys.secondaryAction)
    : null;

  return (
    <section
      className={`startrips-recovery-surface startrips-recovery-surface--${kind}${className ? ` ${className}` : ""}`}
      data-recovery-kind={kind}
    >
      <div className="startrips-recovery-surface__motion" aria-hidden="true">
        <StartripsSignatureMotion clip="recovery" size={64} title="" />
      </div>
      <p className="startrips-recovery-surface__eyebrow">{getStartripsRecoveryCopy(descriptor.copyKeys.eyebrow)}</p>
      {descriptor.code ? <p className="startrips-recovery-surface__code">{descriptor.code}</p> : null}
      <Heading>{getStartripsRecoveryCopy(descriptor.copyKeys.title)}</Heading>
      <p className="startrips-recovery-surface__body">{getStartripsRecoveryCopy(descriptor.copyKeys.body)}</p>
      {detail ? <p className="startrips-recovery-surface__detail" role={kind === "error" ? "alert" : undefined}>{detail}</p> : null}
      <div className="startrips-recovery-surface__actions">
        <Action kind={descriptor.primaryActionKind} label={primaryLabel} onAction={onPrimaryAction} />
        {descriptor.secondaryActionKind && secondaryLabel && onSecondaryAction ? (
          <Action kind={descriptor.secondaryActionKind} label={secondaryLabel} onAction={onSecondaryAction} secondary />
        ) : null}
      </div>
    </section>
  );
}
