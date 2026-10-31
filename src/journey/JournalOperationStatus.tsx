export function JournalOperationStatus({ label, onStop }: { label: string; onStop?: () => void }) {
  return <div className="daily-journal__progress">
    <span role="status" aria-live="polite">{label}</span>
    {onStop ? <button type="button" onClick={onStop}>停止</button> : null}
  </div>;
}
