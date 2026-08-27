'use client';

import { useState, useCallback } from 'react';

interface CopyButtonProps {
  value: string;
  label?: string;
  size?: 'sm' | 'md';
}

function truncateValue(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export function CopyButton({ value, label, size = 'md' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback for non-HTTPS or old browsers
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
        } catch {
          // silent no-op if fallback also fails
        } finally {
          document.body.removeChild(textarea);
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silent no-op
    }
  }, [value]);

  const isSmall = size === 'sm';
  const truncated = truncateValue(value);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span title={value} className={`font-mono ${isSmall ? 'text-xs' : 'text-sm'} text-muted`}>
        {truncated}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        disabled={copied}
        aria-label={`Copy ${label ?? 'value'} to clipboard`}
        className={`inline-flex items-center justify-center rounded border border-border bg-card hover:bg-background transition-colors ${
          isSmall ? 'h-6 w-6' : 'h-7 w-7'
        } disabled:opacity-50`}
      >
        {copied ? (
          <svg
            width={isSmall ? 12 : 14}
            height={isSmall ? 12 : 14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--success)"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width={isSmall ? 12 : 14}
            height={isSmall ? 12 : 14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--muted)"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3" />
          </svg>
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied!' : ''}
      </span>
    </span>
  );
}

export default CopyButton;
