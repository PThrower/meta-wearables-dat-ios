/**
 * Text wrapping for monochrome smart glasses displays.
 *
 * Wraps a string into lines that fit within the display's character width.
 * Breaks at word boundaries when possible, falls back to character breaks.
 */

/**
 * Wrap text into lines that fit a given character capacity.
 * Respects existing newlines, breaks at word boundaries, hard-breaks long words.
 */
export function wrapText(text: string, maxCharsPerLine: number): string[] {
  const allLines: string[] = [];

  // First split on existing newlines
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (para.length === 0) {
      allLines.push("");
      continue;
    }

    const words = para.split(/\s+/);
    let currentLine = "";

    for (const word of words) {
      if (currentLine.length === 0) {
        // First word on line
        if (word.length > maxCharsPerLine) {
          // Word exceeds line capacity — hard-break it
          for (let i = 0; i < word.length; i += maxCharsPerLine) {
            allLines.push(word.slice(i, i + maxCharsPerLine));
          }
        } else {
          currentLine = word;
        }
      } else if (currentLine.length + 1 + word.length <= maxCharsPerLine) {
        // Word fits on current line
        currentLine += " " + word;
      } else {
        // Word doesn't fit — emit current line, start new
        allLines.push(currentLine);
        if (word.length > maxCharsPerLine) {
          for (let i = 0; i < word.length; i += maxCharsPerLine) {
            allLines.push(word.slice(i, i + maxCharsPerLine));
          }
          currentLine = "";
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine.length > 0) {
      allLines.push(currentLine);
    }
  }

  return allLines;
}
