/** Small Coco face: cream helmet, plum visor, lavender ears, yellow star. Decorative, so hidden from assistive tech. */
export function CocoMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="coco-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="4.5" cy="17" r="3.5" fill="#C9B3F2" />
      <circle cx="27.5" cy="17" r="3.5" fill="#C9B3F2" />
      <circle cx="16" cy="17" r="12" fill="#FBF1E4" />
      <rect x="8" y="12.5" width="16" height="9" rx="4.5" fill="#2A1D3A" />
      <circle cx="12.5" cy="17" r="1.4" fill="#FBF1E4" />
      <circle cx="19.5" cy="17" r="1.4" fill="#FBF1E4" />
      <path d="M16 1.5l1.3 2.9 3.1.3-2.4 2 .8 3.1-2.8-1.7-2.8 1.7.8-3.1-2.4-2 3.1-.3z" fill="#FFE680" />
    </svg>
  );
}
