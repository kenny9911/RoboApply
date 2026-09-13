/** RoboApply's shared R / next-step mark. The surrounding surface owns color. */
export function BrandSymbol({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 18V6h7a4 4 0 0 1 0 8H8m4 0 6 5" />
      <path d="m16 4 3-1-1 3" strokeWidth="1.5" />
    </svg>
  );
}
