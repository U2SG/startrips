import type { ButtonHTMLAttributes, ReactNode } from "react";

type IconActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  tooltip?: string;
  children: ReactNode;
};

export function IconActionButton({
  label,
  tooltip = label,
  className,
  children,
  ...props
}: IconActionButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      data-tooltip={tooltip}
      className={["icon-action-button", className].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}
