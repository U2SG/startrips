import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { searchLocations } from "./journeyApi";
import { journeyLocationSearchErrorMessage } from "./journeyLocationSearchError";
import type { LocationSearchResponse, LocationSearchResult } from "./types";

export const everydayFragmentPlaceSearchErrorMessage = journeyLocationSearchErrorMessage;

export type EverydayFragmentConfirmedPlace = {
  latitude: number;
  longitude: number;
  placeLabel: string | null;
};

export function resolveEverydayFragmentPlaceSelection(
  result: LocationSearchResult,
): EverydayFragmentConfirmedPlace {
  const placeLabel = result.labelLocal && /\p{Script=Han}/u.test(result.labelLocal)
    ? result.labelLocal
    : result.label;
  return {
    latitude: result.latitude,
    longitude: result.longitude,
    placeLabel: placeLabel.trim() || null,
  };
}

export type EverydayFragmentPlaceSearchCoordinator = {
  activate: () => void;
  begin: () => number;
  invalidate: () => void;
  dispose: () => void;
  isCurrent: (revision: number) => boolean;
};

export function createEverydayFragmentPlaceSearchCoordinator(): EverydayFragmentPlaceSearchCoordinator {
  let revision = 0;
  let disposed = false;
  return {
    activate() {
      disposed = false;
      revision += 1;
    },
    begin() {
      revision += 1;
      return revision;
    },
    invalidate() {
      revision += 1;
    },
    dispose() {
      disposed = true;
      revision += 1;
    },
    isCurrent(candidate) {
      return !disposed && candidate === revision;
    },
  };
}

export async function runEverydayFragmentPlaceSearch(
  query: string,
  coordinator: EverydayFragmentPlaceSearchCoordinator,
  searcher: (query: string) => Promise<LocationSearchResponse> = (value) => searchLocations(value),
): Promise<LocationSearchResponse | null> {
  const revision = coordinator.begin();
  try {
    const response = await searcher(query);
    return coordinator.isCurrent(revision) ? response : null;
  } catch (error) {
    if (!coordinator.isCurrent(revision)) return null;
    throw error;
  }
}

export function EverydayFragmentPlaceInput({
  confirmed,
  coordinator,
  disabled = false,
  resetEpoch = 0,
  onQueryChange,
  onSelect,
}: {
  confirmed: EverydayFragmentConfirmedPlace | null;
  coordinator?: EverydayFragmentPlaceSearchCoordinator;
  disabled?: boolean;
  resetEpoch?: number;
  onQueryChange?: (query: string) => void;
  onSelect: (selection: EverydayFragmentConfirmedPlace) => void;
}) {
  const [query, setQuery] = useState(confirmed?.placeLabel ?? "");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [attribution, setAttribution] = useState<LocationSearchResponse["attribution"] | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const localCoordinator = useRef(createEverydayFragmentPlaceSearchCoordinator());
  const activeCoordinator = coordinator ?? localCoordinator.current;
  const listId = useId();

  useEffect(() => {
    activeCoordinator.activate();
    return () => activeCoordinator.dispose();
  }, [activeCoordinator]);
  useEffect(() => {
    activeCoordinator.invalidate();
    setResults([]);
    setAttribution(null);
    setMessage("");
    setPending(false);
    setActiveIndex(-1);
  }, [activeCoordinator, resetEpoch]);

  function changeQuery(value: string) {
    activeCoordinator.invalidate();
    onQueryChange?.(value);
    setQuery(value);
    setResults([]);
    setAttribution(null);
    setMessage("");
    setPending(false);
    setActiveIndex(-1);
  }

  async function submitSearch() {
    const nextQuery = query.trim();
    if (nextQuery.length < 2) {
      activeCoordinator.invalidate();
      setResults([]);
      setAttribution(null);
      setPending(false);
      setActiveIndex(-1);
      setMessage("至少输入两个字符再搜索。");
      return;
    }
    setPending(true);
    setMessage("");
    setResults([]);
    setAttribution(null);
    setActiveIndex(-1);
    try {
      const response = await runEverydayFragmentPlaceSearch(nextQuery, activeCoordinator);
      if (!response) return;
      setResults(response.results);
      setAttribution(response.attribution);
      setActiveIndex(response.results.length > 0 ? 0 : -1);
      setMessage(response.results.length === 0 ? "没有找到地点；可以换个名称，或展开手动坐标。" : "");
      setPending(false);
    } catch (error) {
      setResults([]);
      setAttribution(null);
      setActiveIndex(-1);
      setMessage(everydayFragmentPlaceSearchErrorMessage(error));
      setPending(false);
    }
  }

  function choose(result: LocationSearchResult) {
    activeCoordinator.invalidate();
    const selection = resolveEverydayFragmentPlaceSelection(result);
    onSelect(selection);
    setQuery(selection.placeLabel ?? result.label);
    setResults([]);
    setAttribution(null);
    setMessage("");
    setPending(false);
    setActiveIndex(-1);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && results.length === 0) {
      event.preventDefault();
      void submitSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        const start = current < 0 ? (delta > 0 ? -1 : 0) : current;
        return (start + delta + results.length) % results.length;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) choose(results[activeIndex]);
      else void submitSearch();
      return;
    }
    if (event.key === "Escape") {
      activeCoordinator.invalidate();
      setResults([]);
      setAttribution(null);
      setPending(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div className="everyday-fragment-place-input" data-everyday-fragment-place-input>
      <div className="everyday-fragment-place-input__search">
        <label>
          <span>搜索地点</span>
          <input
            type="search"
            value={query}
            maxLength={120}
            disabled={disabled}
            placeholder="中文或英文名称"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={results.length > 0 ? listId : undefined}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={keyDown}
          />
        </label>
        <button type="button" disabled={disabled || pending} onClick={() => void submitSearch()}>{pending ? "搜索中…" : "搜索"}</button>
      </div>
      {confirmed ? (
        <p className="everyday-fragment-place-input__confirmed" data-confirmed-place>
          <span>已确认地点</span>
          <strong>{confirmed.placeLabel || `${confirmed.latitude.toFixed(5)}, ${confirmed.longitude.toFixed(5)}`}</strong>
        </p>
      ) : (
        <p className="everyday-fragment-place-input__hint">请选择一个搜索结果，或使用下方手动坐标。</p>
      )}
      {results.length > 0 ? (
        <ul id={listId} className="everyday-fragment-place-input__results" role="listbox" aria-label="地点搜索结果">
          {results.map((result, index) => (
            <li key={result.id}>
              <button
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                data-everyday-fragment-place-result={result.id}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(result)}
              >
                <strong>{result.label}</strong>
                {[result.labelLocal, result.labelEnglish]
                  .filter((label, itemIndex, labels) => Boolean(label) && label !== result.label && labels.indexOf(label) === itemIndex)
                  .map((label) => <small key={label}>{label}</small>)}
                <small>{result.context} · {result.countryCode}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {results.length > 0 && attribution ? (
        <a className="everyday-fragment-place-input__attribution" href={attribution.url} target="_blank" rel="noreferrer">
          地点数据 {attribution.label}
        </a>
      ) : null}
      {message ? <p className="everyday-fragment-place-input__message" role="status">{message}</p> : null}
    </div>
  );
}
