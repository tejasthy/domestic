'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { searchAddresses, type AddressSuggestion } from '@/lib/places';
import { Field, Input, cx } from '@/components/ui';

/**
 * Address input with Google Places suggestions. Typing freely always works —
 * suggestions are a shortcut, and the field stays usable if the lookup is
 * unconfigured, slow, or down.
 */
export function AddressField({
  value,
  onChange,
  label = 'Address',
  placeholder = '526 Detroit St., Ann Arbor, MI',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [, startLookup] = useTransition();

  // What we last asked about, so picking a suggestion doesn't re-query it.
  const queried = useRef<string>('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < 3 || trimmed === queried.current) return;

    let cancelled = false;
    const id = setTimeout(() => {
      queried.current = trimmed;
      startLookup(async () => {
        const results = await searchAddresses(trimmed);
        if (cancelled) return;
        setSuggestions(results);
        setActive(-1);
        setOpen(results.length > 0);
      });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [value]);

  // Clicking away closes the list without choosing anything.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function choose(s: AddressSuggestion) {
    queried.current = s.text.trim();
    onChange(s.text);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter' && active >= 0) {
      // Only swallow Enter when something is highlighted, so the form can
      // still be submitted from this field.
      e.preventDefault();
      choose(suggestions[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <Field label={label} hint="Optional.">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="address-suggestions"
          aria-activedescendant={active >= 0 ? `address-option-${active}` : undefined}
        />
      </Field>

      {open && suggestions.length > 0 && (
        <ul
          id="address-suggestions"
          role="listbox"
          className={cx(
            'absolute z-20 left-0 right-0 mt-1 overflow-hidden',
            'bg-card border border-line rounded-md shadow-md',
          )}
        >
          {suggestions.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active} id={`address-option-${i}`}>
              <button
                type="button"
                // mousedown fires before the input's blur, so the click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s);
                }}
                onMouseEnter={() => setActive(i)}
                className={cx(
                  'w-full text-left px-3 py-2.5 transition-colors duration-[120ms]',
                  i === active ? 'bg-hover' : 'bg-transparent',
                )}
              >
                <span className="t-body-md text-ink block truncate">{s.main}</span>
                {s.secondary && (
                  <span className="t-body-sm text-ink-muted block truncate">{s.secondary}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
