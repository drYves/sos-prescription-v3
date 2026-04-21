import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MedicationSearchResult } from '../formTunnel/types';
import { searchMedicationsApi } from './searchApi';
import { cx, formatAmountValue, Spinner, TextInput } from './shared';

export function MedicationSearch({
  onSelect,
}: {
  onSelect: (item: MedicationSearchResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MedicationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const blurTimeoutRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const resultsId = 'sp-medication-search-results';

  const canSearch = useMemo(() => query.trim().length >= 2, [query]);
  const hasDisabledResults = useMemo(
    () => results.some((result) => result?.is_selectable === false),
    [results],
  );

  const getSelectableIndex = useCallback((startIndex: number, direction: 1 | -1): number => {
    if (results.length < 1) {
      return -1;
    }

    let index = startIndex;
    for (let steps = 0; steps < results.length; steps += 1) {
      index = (index + direction + results.length) % results.length;
      if (results[index]?.is_selectable !== false) {
        return index;
      }
    }

    return -1;
  }, [results]);

  const selectResult = useCallback((result: MedicationSearchResult) => {
    if (result?.is_selectable === false) {
      return;
    }

    onSelect(result);
    setQuery('');
    setResults([]);
    setError(null);
    setOpen(false);
    setActiveIndex(-1);
  }, [onSelect]);

  const resultsAnnouncement = useMemo(() => {
    if (!canSearch) {
      return 'Saisissez au moins deux caractères pour rechercher un médicament.';
    }

    if (loading) {
      return 'Recherche de médicaments en cours.';
    }

    if (error) {
      return error;
    }

    if (!open) {
      return '';
    }

    if (results.length < 1) {
      return 'Aucun résultat.';
    }

    return `${results.length} résultat${results.length > 1 ? 's' : ''} disponible${results.length > 1 ? 's' : ''}.`;
  }, [canSearch, error, loading, open, results.length]);

  useEffect(() => {
    if (!canSearch) {
      setResults([]);
      setOpen(false);
      setError(null);
      setLoading(false);
      setActiveIndex(-1);
      return;
    }

    const keyword = query.trim();
    setLoading(true);
    setOpen(true);
    setActiveIndex(-1);
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    const timeout = window.setTimeout(() => {
      searchMedicationsApi(keyword, 20)
        .then((data) => {
          if (controller.signal.aborted) {
            return;
          }

          let nextResults = Array.isArray(data)
            ? data
            : (
              data && typeof data === 'object'
                ? ((data as Record<string, unknown>).data
                  || (data as Record<string, unknown>).items
                  || (data as Record<string, unknown>).results
                  || (data as Record<string, unknown>).medications
                  || Object.values(data as Record<string, unknown>))
                : []
            );

          nextResults = Array.isArray(nextResults) ? nextResults : [];
          setError(null);
          setResults(nextResults as MedicationSearchResult[]);
        })
        .catch(() => {
          if (controller.signal.aborted) {
            return;
          }
          setResults([]);
          setError('La recherche du médicament n’a pu aboutir. Merci de réessayer.');
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 200);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [canSearch, query]);

  useEffect(() => {
    if (!open || results.length < 1) {
      setActiveIndex(-1);
      return;
    }

    if (activeIndex >= 0 && activeIndex < results.length && results[activeIndex]?.is_selectable !== false) {
      return;
    }

    const firstSelectable = results.findIndex((result) => result?.is_selectable !== false);
    setActiveIndex(firstSelectable);
  }, [activeIndex, open, results]);

  useEffect(() => {
    if (!open || activeIndex < 0) {
      return;
    }

    const option = listRef.current?.querySelector<HTMLElement>(`#${resultsId}-option-${activeIndex}`);
    option?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current != null) {
        window.clearTimeout(blurTimeoutRef.current);
      }
      abortRef.current?.abort();
    };
  }, []);

  const activeOptionId = open && activeIndex >= 0 ? `${resultsId}-option-${activeIndex}` : undefined;
  const resultsStatusId = `${resultsId}-status`;
  const resultsHintId = `${resultsId}-hint`;
  const inputDescriptionIds = [resultsStatusId, open ? resultsHintId : null].filter(Boolean).join(' ');

  return (
    <div className="sp-app-search" data-open={open ? 'true' : 'false'} data-loading={loading ? 'true' : 'false'}>
      <div className="sp-visually-hidden" id={resultsStatusId} aria-live="polite">{resultsAnnouncement}</div>
      <TextInput
        id="sp-medication-search-input"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? resultsId : undefined}
        aria-activedescendant={activeOptionId}
        aria-describedby={inputDescriptionIds || undefined}
        aria-busy={loading}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(event.target.value.trim().length >= 2);
        }}
        placeholder="Rechercher un médicament..."
        onFocus={() => {
          if (blurTimeoutRef.current != null) {
            window.clearTimeout(blurTimeoutRef.current);
            blurTimeoutRef.current = null;
          }
          if (query.trim().length >= 2) {
            setOpen(true);
          }
        }}
        onBlur={() => {
          if (blurTimeoutRef.current != null) {
            window.clearTimeout(blurTimeoutRef.current);
          }
          blurTimeoutRef.current = window.setTimeout(() => {
            setOpen(false);
            setActiveIndex(-1);
          }, 120);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length > 0) {
            event.preventDefault();
            setOpen(true);
            setActiveIndex(getSelectableIndex(-1, 1));
            return;
          }

          if (!open) {
            return;
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((current) => getSelectableIndex(current < 0 ? -1 : current, 1));
            return;
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((current) => getSelectableIndex(current < 0 ? 0 : current, -1));
            return;
          }

          if (event.key === 'Enter') {
            if (activeIndex >= 0 && results[activeIndex]?.is_selectable !== false) {
              event.preventDefault();
              selectResult(results[activeIndex]);
            }
            return;
          }

          if (event.key === 'Home') {
            event.preventDefault();
            setActiveIndex(getSelectableIndex(-1, 1));
            return;
          }

          if (event.key === 'End') {
            event.preventDefault();
            setActiveIndex(getSelectableIndex(results.length, -1));
            return;
          }

          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setActiveIndex(-1);
          }
        }}
      />

      {open ? (
        <div className="sp-app-search__results" id={resultsId} role="listbox" aria-label="Résultats de recherche médicament" aria-busy={loading} ref={listRef}>
          <div className="sp-app-search__head">
            <span>Résultats</span>
            {loading ? <Spinner /> : null}
          </div>

          <div className="sp-app-search__body">
            {!loading && error ? (
              <div className="sp-app-search__feedback sp-app-search__feedback--error">{error}</div>
            ) : null}

            {!loading && !error && results.length === 0 ? (
              <div className="sp-app-search__feedback">
                <div className="sp-app-note-card">
                  <div className="sp-app-note-card__title">Aucun résultat</div>
                  <div className="sp-app-note-card__text">
                    Essayez d’affiner la recherche avec le nom exact, le dosage ou le code CIP si vous l’avez.
                    <ul className="sp-app-list">
                      <li>vérifiez l’orthographe du médicament</li>
                      <li>ajoutez le dosage ou la forme si nécessaire</li>
                      <li>essayez le code CIP indiqué sur la boîte</li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            {results.map((result, index) => {
              const selectable = result?.is_selectable !== false;
              const key = `${result.cip13 || result.cis || result.label}`;
              const sublabel = typeof result.sublabel === 'string' ? result.sublabel.trim() : '';
              const metaParts = [
                result.cis ? `CIS ${result.cis}` : null,
                result.cip13 ? `CIP13 ${result.cip13}` : null,
                result.tauxRemb ? `Remb. ${result.tauxRemb}` : null,
                typeof result.prixTTC === 'number' ? formatAmountValue(result.prixTTC, 'EUR') : null,
              ].filter((value): value is string => Boolean(value));
              const optionId = `${resultsId}-option-${index}`;
              const selected = activeIndex === index;

              return (
                <button
                  key={key}
                  id={optionId}
                  type="button"
                  disabled={!selectable}
                  role="option"
                  aria-disabled={!selectable}
                  aria-selected={selected}
                  aria-posinset={index + 1}
                  aria-setsize={results.length}
                  tabIndex={-1}
                  className={cx(
                    'sp-app-search__item',
                    selectable ? 'is-selectable' : 'is-disabled',
                    selected && 'is-active',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    if (selectable) {
                      setActiveIndex(index);
                    }
                  }}
                  onClick={() => selectResult(result)}
                >
                  <div className="sp-app-search__item-row">
                    <div className="sp-app-search__item-title">
                      <strong>{result.label}</strong>
                      {sublabel ? (
                        <div>
                          <small>{sublabel}</small>
                        </div>
                      ) : null}
                    </div>
                    {!selectable ? (
                      <span className="sp-app-search__badge">Non disponible en ligne</span>
                    ) : null}
                  </div>
                  {metaParts.length > 0 ? (
                    <div className="sp-app-search__item-meta">{metaParts.join(' • ')}</div>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="sp-app-search__foot" id={resultsHintId}>
            {hasDisabledResults
              ? 'Les résultats grisés ne peuvent pas être ajoutés dans ce parcours.'
              : 'Sélectionnez un résultat pour l’ajouter à votre demande.'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
