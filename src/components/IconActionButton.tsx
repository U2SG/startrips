import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

type IconActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  tooltip?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
};

export function IconActionButton({
  label,
  tooltip = label,
  className,
  buttonRef,
  children,
  ...props
}: IconActionButtonProps) {
  return (
    <button
      ref={buttonRef}
      {...props}
      aria-label={label}
      data-tooltip={tooltip}
      className={["icon-action-button", className].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}
