/**
 * Workflow page module — hash routing, composes list and editor views.
 */

import type { PageModule } from "../../router/router.js";
import {
  setContainer, getPollTimer, setPollTimer, getView, resetState,
} from "./state.js";
import { resetInteractions, onKeyDown } from "./interactions.js";
import { renderList } from "./list-view.js";
import { renderEditor } from "./editor-view.js";

export const page: PageModule = {
  init(container) {
    setContainer(container);
    renderView();
  },
  destroy() {
    const poll = getPollTimer();
    if (poll) { clearInterval(poll); setPollTimer(null); }
    document.removeEventListener("keydown", onKeyDown);
    resetState();
    resetInteractions();
  },
};

function renderView(): void {
  const view = getView();
  if (view === "list") renderList();
  else renderEditor(view === "new");
}

export default page;
