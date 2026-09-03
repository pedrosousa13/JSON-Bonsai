// How long a flashed label stays up, so every copy affordance in the UI reads
// back at the same rhythm.
export const FLASH_LABEL_MS = 1000;

// Swaps a control's label for a moment, then restores it.
export function flashLabel(element: HTMLElement, text: string): void {
  const original = element.textContent;
  element.textContent = text;
  setTimeout(() => {
    element.textContent = original;
  }, FLASH_LABEL_MS);
}
