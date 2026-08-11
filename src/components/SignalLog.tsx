interface SignalLogProps {
  label: string;
  message: string;
}

export function SignalLog({ label, message }: SignalLogProps) {
  return (
    <footer className="signal-strip" aria-live="polite">
      <strong>{label}</strong>
      <span>{message}</span>
    </footer>
  );
}
