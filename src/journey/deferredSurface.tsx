import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";

/**
 * A surface the Atlas opens on demand (Composer, Story, Playback, ...), kept
 * out of the production entry chunk and loaded on idle or on intent.
 *
 * Once the module has arrived, the surface renders synchronously, exactly as a
 * static import would: no Suspense round trip, so a shared-element morph or a
 * focus hand-off that runs on open still finds its DOM in the same commit. Only
 * a surface opened before its module arrived shows `fallback`, and a module
 * that cannot load says so instead of unmounting the Atlas.
 */

export type ModuleLoader<T> = {
  load: () => Promise<T>;
  current: () => T | null;
};

/** One in-flight import at a time; a failed import may be retried. */
export function createModuleLoader<T>(importer: () => Promise<T>): ModuleLoader<T> {
  let resolved: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    load() {
      if (resolved) return Promise.resolve(resolved);
      pending ??= importer().then(
        (module) => {
          resolved = module;
          return module;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    current: () => resolved,
  };
}

class DeferredSurfaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="journey-reader-loading" role="alert">
        <p>
          这一部分暂时无法加载，请检查网络后
          <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
        </p>
      </div>
    );
  }
}

export function deferredSurface<P extends object>(
  importer: () => Promise<ComponentType<P>>,
  fallback: ReactNode,
): { Surface: ComponentType<P>; preload: () => void } {
  const loader = createModuleLoader(importer);
  const LazySurface = lazy(() => loader.load().then((component) => ({ default: component })));
  function Surface(props: P) {
    // Fixed for the lifetime of this mount, so the module arriving later never
    // swaps the element type (and with it the surface's state) underneath it.
    const [Resolved] = useState(() => loader.current());
    if (Resolved) return <Resolved {...props} />;
    return (
      <DeferredSurfaceBoundary>
        <Suspense fallback={fallback}>
          <LazySurface {...props} />
        </Suspense>
      </DeferredSurfaceBoundary>
    );
  }
  return {
    Surface,
    preload: () => {
      loader.load().catch(() => {
        // Opening the surface retries and reports a failure truthfully.
      });
    },
  };
}

/** Run `task` once the browser is idle, or after `timeoutMs` at the latest. */
export function whenIdle(task: () => void, timeoutMs = 1500): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, Math.min(timeoutMs, 350));
  return () => window.clearTimeout(handle);
}
