// Cuts `text` to at most `limit` UTF-16 code units, like `slice`, but never
// leaves half a surrogate pair behind: an astral character straddling the
// limit is dropped whole instead of rendering as U+FFFD (and, in the search
// index, matching nothing).
//
// Code points are the guarantee, not grapheme clusters. A combining mark or a
// ZWJ emoji sequence can still lose its tail at the cut, which leaves a
// legible base character. Holding clusters together would need
// Intl.Segmenter — Firefox 125+, past this build's firefox115 target — and
// would let a single long sequence swallow an arbitrary share of the budget.
export function truncateCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? limit - 1 : limit);
}

// The tail-keeping counterpart of truncateCodePoints: cuts the front instead
// of the back, so `text` keeps at most `limit` UTF-16 code units from its end,
// with the same surrogate-pair guarantee. Used where the end of the text is
// the part worth indexing — a node's search path, whose own key and nearest
// ancestors are what a search is about.
export function keepLastCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = text.length - limit;
  const first = text.charCodeAt(start);
  const splitsPair = first >= 0xdc00 && first <= 0xdfff;
  return text.slice(splitsPair ? start + 1 : start);
}
