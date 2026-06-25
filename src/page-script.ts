// Runs in the page's MAIN world, injected by content.ts only when the user has
// opted in (Settings → "Expose payload as window.data"). Reads the JSON the
// content script stashed in a holder <script> tag, mirrors it onto window.data
// for console use, then removes both the holder and this <script> element so the
// payload doesn't linger in the page's DOM after it has been handed off.
export function exposeWindowData(): void {
  const el = document.getElementById("jv-json-data");
  if (!el) return;
  try {
    (window as any).data = JSON.parse(el.textContent || "");
    console.log(
      "%c[JSON Bonsai]%c Data available as %cwindow.data",
      "color: #f0c674; font-weight: bold",
      "color: inherit",
      "color: #81a2be; font-weight: bold"
    );
  } catch {
    // Malformed payload — leave window.data unset.
  } finally {
    el.remove();
    document.currentScript?.remove();
  }
}

exposeWindowData();
