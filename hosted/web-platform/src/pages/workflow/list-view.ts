/**
 * Workflow list view — cards grid with polling.
 */

import {
  fetchWorkflows, deleteWorkflow, esc, formatDateTime,
} from "../../core/api-client.js";
import { getContainer, setPollTimer, getPollTimer } from "./state.js";

/** Render the full list page HTML and start polling. */
export async function renderList(): Promise<void> {
  const container = getContainer();
  if (!container) return;
  container.innerHTML = `
    <div class="page workflow-page">
      <div class="page-header">
        <div class="page-header-row">
          <div>
            <h1 class="page-title">Workflows</h1>
            <span class="page-subtitle">AI pipeline builder</span>
          </div>
          <button class="btn btn-primary" id="wf-new-btn">+ New</button>
        </div>
      </div>
      <div id="wf-list" class="wf-card-grid">
        <p class="empty-state">Loading workflows...</p>
      </div>
    </div>
  `;

  container.querySelector("#wf-new-btn")?.addEventListener("click", () => {
    location.hash = "/workflows/new";
  });

  await loadList();
  if (getPollTimer()) clearInterval(getPollTimer()!);
  setPollTimer(setInterval(() => loadList(), 15000));
}

/** Fetch and render workflow cards. */
export async function loadList(): Promise<void> {
  const listEl = getContainer()?.querySelector("#wf-list");
  if (!listEl) return;

  const workflows = await fetchWorkflows();
  if (workflows.length === 0) {
    listEl.innerHTML = '<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';
    return;
  }

  listEl.innerHTML = workflows.map(w => {
    const statusClass = w.status === "published" ? "wf-status-published" : w.status === "archived" ? "wf-status-archived" : "wf-status-draft";
    return `
      <div class="wf-card" data-id="${esc(w.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${esc(w.name)}</span>
          <span class="wf-card-status ${statusClass}">${esc(w.status)}</span>
        </div>
        <p class="wf-card-desc">${esc(w.description || "No description")}</p>
        <div class="wf-card-meta">
          <span>${w.nodeCount} nodes</span>
          <span>${formatDateTime(w.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${esc(w.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${esc(w.id)}">Delete</button>
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".wf-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      location.hash = `/workflows/${(btn as HTMLElement).dataset.id}`;
    });
  });

  listEl.querySelectorAll(".wf-delete-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this workflow?")) return;
      await deleteWorkflow((btn as HTMLElement).dataset.id!);
      await loadList();
    });
  });
}
