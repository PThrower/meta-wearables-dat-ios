/**
 * StatusBar — syncs key metrics to the status bar at the bottom of the player.
 * Mirrors values from the info panel spans into the status bar spans.
 */

const MIRROR_MAP: Record<string, string> = {
  "p-fps": "sb-fps",
  "p-size": "sb-size",
  "p-latency": "sb-latency",
  "p-audio": "sb-audio",
  "t-link-state": "sb-link",
  "t-battery": "sb-battery",
};

/** Mirror all tracked metric values from info panel to status bar and telemetry grid. */
export function syncStatusBar(): void {
  for (const [sourceId, targetId] of Object.entries(MIRROR_MAP)) {
    const source = document.getElementById(sourceId);
    const target = document.getElementById(targetId);
    if (source && target) {
      target.textContent = source.textContent;
    }
    // Also mirror to telemetry grid card in bottom panel
    const tm = document.getElementById("tm-" + sourceId);
    if (source && tm) {
      tm.textContent = source.textContent;
    }
  }
}

/** Observe changes to source elements and mirror to status bar. */
export function initStatusBarSync(): void {
  // Use MutationObserver on the parent containers to catch text changes
  const observer = new MutationObserver(() => {
    syncStatusBar();
  });

  const observed = new Set<HTMLElement>();
  for (const sourceId of Object.keys(MIRROR_MAP)) {
    const el = document.getElementById(sourceId);
    if (el && !observed.has(el.parentElement!)) {
      observed.add(el.parentElement!);
      observer.observe(el.parentElement!, { childList: true, subtree: true, characterData: true });
    }
  }
}
