import { useId, useState } from 'react';
import { api, reportApiError } from '../api';
import type { Mode } from '../types';

export const MODE_LABEL: Record<Mode, string> = { auto: 'Run freely', confirm: 'Ask first', off: 'Off' };

/** Segmented radio group. Optimistic: reverts and shows an inline error when the PUT fails. */
export function PermissionControl({ qualified, name, mode, labels = MODE_LABEL, onChanged }: {
  qualified: string; name: string; mode: Mode; labels?: Record<Mode, string>; onChanged: () => void;
}) {
  const group = useId();
  const [value, setValue] = useState<Mode>(mode);
  const [error, setError] = useState<string>();

  const change = async (next: Mode) => {
    const previous = value;
    setValue(next);
    setError(undefined);
    try {
      await api('PUT', `/api/tools/${encodeURIComponent(qualified)}/mode`, { mode: next });
      onChanged();
    } catch (e) {
      setValue(previous);
      reportApiError((m) => setError(m))(e);
    }
  };

  return (
    <div className="perm">
      <div className="segmented" role="radiogroup" aria-label={`Permission for ${name}`}>
        {(Object.keys(labels) as Mode[]).map((m) => (
          <label key={m} className={value === m ? 'seg seg-on' : 'seg'}>
            <input type="radio" name={group} value={m} checked={value === m} onChange={() => void change(m)} className="seg-input" />
            {labels[m]}
          </label>
        ))}
      </div>
      {error && <p role="alert" className="error small">{`Couldn't change permission: ${error}`}</p>}
    </div>
  );
}
