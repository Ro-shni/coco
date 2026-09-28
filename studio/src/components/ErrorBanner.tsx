/** Shared visible-error surface: a dismissible banner with `role="alert"`. Used by every tab for failures
 * that aren't already shown inline elsewhere (e.g. `ImportDialog`'s own error slot for its confirm flow). */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="banner-error" role="alert">
      <span>{message}</span>
      {onDismiss && <button type="button" onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}
