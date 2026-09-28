'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Exposure = Awaited<ReturnType<typeof api.coSuretyExposure>>;

export function CoSuretyExposureWidget() {
  const [data, setData] = useState<Exposure | null>(null);
  useEffect(() => {
    void api
      .coSuretyExposure()
      .then(setData)
      .catch(() => setData({ participants: [] }));
  }, []);

  return (
    <section
      className="mt-8 border-y border-border py-5"
      aria-labelledby="co-surety-exposure-title"
    >
      <h2 id="co-surety-exposure-title" className="text-sm font-semibold">
        Co-surety exposure
      </h2>
      {!data ? (
        <p className="mt-2 text-xs text-muted">Loading participation totals…</p>
      ) : data.participants.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No co-surety participation recorded.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-2 pr-4">Participant</th>
                <th className="py-2 pr-4">Reference</th>
                <th className="py-2 pr-4">Bonds</th>
                <th className="py-2 text-right">Exposure</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.participants.map((row) => (
                <tr key={row.reference}>
                  <td className="py-2 pr-4">{row.name}</td>
                  <td className="py-2 pr-4 font-mono">{row.reference}</td>
                  <td className="py-2 pr-4">{row.bond_count}</td>
                  <td className="py-2 text-right font-mono">{row.exposure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
