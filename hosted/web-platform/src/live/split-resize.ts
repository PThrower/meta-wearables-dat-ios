/**
 * SplitResize — drag handles for sidebar width and bottom panel height.
 */

export class SplitResize {
  private sidebar: HTMLElement;
  private bottomPanel: HTMLElement;
  private sidebarHandle: HTMLElement;
  private bottomHandle: HTMLElement;

  constructor() {
    this.sidebar = document.getElementById("splitSidebar")!;
    this.bottomPanel = document.getElementById("bottomPanel")!;
    this.sidebarHandle = document.getElementById("sidebarResizeHandle")!;
    this.bottomHandle = document.getElementById("bottomResizeHandle")!;

    this.wireDrag(
      this.sidebarHandle,
      (delta) => {
        const current = this.sidebar.offsetWidth;
        const next = Math.max(200, Math.min(600, current - delta));
        this.sidebar.style.width = next + "px";
        this.sidebar.style.transition = "none";
      },
      () => {
        this.sidebar.style.transition = "";
      },
    );

    this.wireDrag(
      this.bottomHandle,
      (_delta) => {}, // handled via movement
      () => {},
      (startY: number, onMove: (e: MouseEvent) => void) => {
        const onBottomMove = (e: MouseEvent) => {
          const delta = startY - e.clientY;
          const next = Math.max(80, Math.min(400, this.bottomPanel.offsetHeight + delta));
          this.bottomPanel.style.height = next + "px";
          this.bottomPanel.style.transition = "none";
          startY = e.clientY;
          onMove(e);
        };
        return onBottomMove;
      },
    );
  }

  /**
   * Wire a drag handle with mousedown/mousemove/mouseup.
   * For the sidebar: delta is horizontal movement, resize by subtracting from width.
   * For the bottom: custom initFn overrides the movement calculation.
   */
  private wireDrag(
    handle: HTMLElement,
    onDrag: (delta: number) => void,
    onEnd: () => void,
    initFn?: (startY: number, onMove: (e: MouseEvent) => void) => (e: MouseEvent) => void,
  ): void {
    handle.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      handle.classList.add("active");

      let startX = e.clientX;
      let startY = e.clientY;

      const baseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        startX = ev.clientX;
        startY = ev.clientY;
        onDrag(delta);
      };

      const moveFn = initFn ? initFn(startY, baseMove) : baseMove;

      const up = () => {
        handle.classList.remove("active");
        document.removeEventListener("mousemove", moveFn);
        document.removeEventListener("mouseup", up);
        onEnd();
      };

      document.addEventListener("mousemove", moveFn);
      document.addEventListener("mouseup", up);
    });
  }
}
