'use client';

import { useState } from 'react';
import { CopyButton } from './CopyButton';

interface TwoFactorSetupProps {
  secret?: string;
  backupCodes?: string[];
}

export function TwoFactorSetup({ secret, backupCodes }: TwoFactorSetupProps) {
  const [showCodes, setShowCodes] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
      {secret ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">TOTP Secret</span>
          <CopyButton value={secret} label="TOTP secret" size="md" />
        </div>
      ) : null}
      {backupCodes && backupCodes.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Backup Codes</span>
            <button
              type="button"
              onClick={() => setShowCodes(!showCodes)}
              className="text-xs text-accent hover:underline"
            >
              {showCodes ? 'Hide' : 'Show'}
            </button>
          </div>
          {showCodes ? (
            <ul className="grid gap-2">
              {backupCodes.map((code) => (
                <li key={code} className="flex items-center justify-between gap-2 rounded border border-border bg-background px-3 py-2">
                  <span className="font-mono text-sm">{code}</span>
                  <CopyButton value={code} label="backup code" size="sm" />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default TwoFactorSetup;
