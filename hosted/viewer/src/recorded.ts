/**
 * Recorded video player overlay
 */

import { authUrl } from "./auth.js";

export function playVideo(url: string): void {
  const v = document.getElementById("recVideo") as HTMLVideoElement;
  v.src = authUrl(url);
  document.getElementById("videoPlayer")!.classList.add("active");
}

export function closeVideo(): void {
  const v = document.getElementById("recVideo") as HTMLVideoElement;
  v.pause();
  v.src = "";
  document.getElementById("videoPlayer")!.classList.remove("active");
}

export function initVideoPlayerEvents(): void {
  document.getElementById("videoPlayer")!.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "videoPlayer") closeVideo();
  });
}
