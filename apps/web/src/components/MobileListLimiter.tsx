import { ReactNode, useState } from "react";

type MobileListLimiterProps = {
  children: ReactNode;
  itemCount: number;
  itemLabel?: string;
  previewLimit?: number;
  forceExpanded?: boolean;
};

// Keeps potentially long cards compact on phones without hiding the fact that
// more records exist. Desktop always shows the full content.
export function MobileListLimiter({
  children,
  itemCount,
  previewLimit = 5,
  forceExpanded = false
}: MobileListLimiterProps) {
  const [expanded, setExpanded] = useState(false);
  const shouldLimit = itemCount > previewLimit;
  const showFullList = expanded || forceExpanded;

  if (!shouldLimit) {
    return <>{children}</>;
  }

  return (
    <div className={`mobile-list-limiter${showFullList ? " expanded" : " collapsed"}`}>
      <div className="mobile-list-limiter-content">
        {children}
      </div>
      <div className="mobile-list-limiter-notice">
        <strong>{itemCount} total items</strong>
        {!forceExpanded && (
          <button
            type="button"
            className={showFullList ? "secondary-button compact-button" : "primary-button compact-button"}
            aria-expanded={showFullList}
            onClick={() => setExpanded((current) => !current)}
          >
            {showFullList ? "Show shorter list" : "Show full list"}
          </button>
        )}
      </div>
    </div>
  );
}
