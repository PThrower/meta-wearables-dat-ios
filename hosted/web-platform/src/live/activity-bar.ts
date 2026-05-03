/**
 * ActivityBar — vertical icon strip that controls sidebar section visibility.
 * One active section at a time; click active to close sidebar.
 */

type SidebarSection = "info" | "guidance" | "workflow" | "audio" | "bottom";

const SECTION_LABELS: Record<SidebarSection, string> = {
  info: "Info",
  guidance: "Guidance",
  workflow: "Workflow",
  audio: "Audio",
  bottom: "Transcription",
};

export class ActivityBar {
  private bar: HTMLElement;
  private sidebar: HTMLElement;
  private sidebarTitle: HTMLElement;
  private sidebarClose: HTMLElement;
  private activeSection: SidebarSection | null = null;
  private bottomPanel: HTMLElement;
  private onSectionChange?: (section: SidebarSection | null) => void;

  constructor(opts: {
    onSectionChange?: (section: SidebarSection | null) => void;
  }) {
    this.bar = document.getElementById("activityBar")!;
    this.sidebar = document.getElementById("splitSidebar")!;
    this.sidebarTitle = document.getElementById("sidebarTitle")!;
    this.sidebarClose = document.getElementById("sidebarClose")!;
    this.bottomPanel = document.getElementById("bottomPanel")!;
    this.onSectionChange = opts.onSectionChange;
    this.bindEvents();
  }

  private bindEvents(): void {
    // Activity bar button clicks
    this.bar.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".activity-bar-btn") as HTMLElement | null;
      if (!btn?.dataset.section) return;
      const section = btn.dataset.section as SidebarSection;

      if (section === "bottom") {
        // Toggle bottom panel independently
        this.toggleBottom();
        return;
      }

      if (this.activeSection === section) {
        // Click active section → close sidebar
        this.closeSidebar();
      } else {
        this.openSection(section);
      }
    });

    // Sidebar close button
    this.sidebarClose.addEventListener("click", () => {
      this.closeSidebar();
    });
  }

  private openSection(section: SidebarSection): void {
    this.activeSection = section;
    this.sidebarTitle.textContent = SECTION_LABELS[section];

    // Show/hide sidebar sections
    this.sidebar.querySelectorAll<HTMLElement>(".sidebar-section").forEach((el) => {
      el.classList.toggle("hidden", el.id !== `sidebar${capitalize(section)}`);
    });

    // Open sidebar
    this.sidebar.classList.add("open");

    // Update activity bar active state
    this.bar.querySelectorAll(".activity-bar-btn").forEach((btn) => {
      const btnEl = btn as HTMLElement;
      btnEl.classList.toggle("active", btnEl.dataset.section === section);
    });

    this.onSectionChange?.(section);
  }

  private closeSidebar(): void {
    this.activeSection = null;
    this.sidebar.classList.remove("open");
    this.bar.querySelectorAll(".activity-bar-btn").forEach((btn) => {
      (btn as HTMLElement).classList.remove("active");
    });
    this.onSectionChange?.(null);
  }

  private toggleBottom(): void {
    const isOpen = this.bottomPanel.classList.toggle("open");
    // Update the bottom toggle button active state
    const btn = this.bar.querySelector('[data-section="bottom"]');
    if (btn) btn.classList.toggle("active", isOpen);
  }

  /** Open a specific section programmatically */
  activate(section: SidebarSection): void {
    if (section === "bottom") {
      this.toggleBottom();
    } else {
      this.openSection(section);
    }
  }

  /** Close everything */
  close(): void {
    this.closeSidebar();
    this.bottomPanel.classList.remove("open");
    this.bar.querySelector('[data-section="bottom"]')?.classList.remove("active");
  }

  getActiveSection(): SidebarSection | null {
    return this.activeSection;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
