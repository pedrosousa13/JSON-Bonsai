// Hand-written types for the vendored jmespath.cjs. The published package
// shipped no types of its own; this replaces the `@types/jmespath` stub that
// was dropped along with the dependency, and keeps `search`'s signature
// identical to it so the swap is invisible at every call site.
//
// The module also exports `tokenize` and `compile`. Nothing in this repo
// imports them, so they are deliberately left undeclared.

/**
 * Take a JSON document and transform it into another JSON document
 * through a JMESPath expression. See: http://jmespath.org/
 * @param jsonDoc the document to transform
 * @param query a JMESPath expression
 * @return the transformed document
 */
export function search(jsonDoc: any, query: string): any;

/**
 * Structural equality, as `==` and `!=` in a JMESPath expression use it.
 * Bounded to MAX_COMPARISON_DEPTH levels of nesting — see the vendor patch
 * for json-bonsai#101. Deeper operands compare as not equal.
 */
export function strictDeepEqual(first: unknown, second: unknown): boolean;
