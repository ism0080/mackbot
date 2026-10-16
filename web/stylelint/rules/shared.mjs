// Helpers shared by the good-css stylelint rules.
//
// Core stylelint rules run on one declaration or one rule at a time and cannot
// see where a node sits in the tree. Every rule in this folder needs that
// context (which @media wraps a rule, what @keyframes an animation names), so
// these helpers walk the PostCSS ancestor chain and read raw values. They are
// deliberately dependency-free: postcss-value-parser is a stylelint internal
// and is not resolvable from web/, so the few value shapes we need are parsed
// here.

/**
 * Every @at-rule between a node and the root, nearest first.
 *
 * @param {import('postcss').Node} node
 * @returns {import('postcss').AtRule[]}
 */
export function ancestorAtRules(node) {
  /** @type {import('postcss').AtRule[]} */
  const found = [];

  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "atrule") found.push(current);
  }

  return found;
}

/**
 * Collapse a media query so order, spacing and line breaks do not matter.
 *
 * @param {string} text
 */
function normalizeQuery(text) {
  return text.replace(/\s+/gu, "").toLowerCase();
}

/**
 * True when the node sits inside an `@media` whose query contains every one of
 * the given features, in any order.
 *
 * @param {import('postcss').Node} node
 * @param {...string} features
 */
export function isInsideMedia(node, ...features) {
  return ancestorAtRules(node).some((atRule) => {
    if (atRule.name.toLowerCase() !== "media") return false;
    const query = normalizeQuery(atRule.params);
    return features.every((feature) => query.includes(normalizeQuery(feature)));
  });
}

/**
 * The argument text of every `name(...)` call in a value, nesting respected.
 *
 * @param {string} value
 * @param {string} name
 * @returns {string[]}
 */
export function functionArguments(value, name) {
  /** @type {string[]} */
  const found = [];
  const haystack = value.toLowerCase();
  const needle = `${name.toLowerCase()}(`;
  let from = 0;

  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) break;

    const before = start === 0 ? "" : value[start - 1];
    if (before && /[\w-]/u.test(before)) {
      from = start + needle.length;
      continue;
    }

    const open = start + needle.length;
    let depth = 0;
    let end = -1;

    for (let i = open; i < value.length; i += 1) {
      const char = value[i];
      if (char === "(") depth += 1;
      else if (char === ")") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth -= 1;
      }
    }

    if (end === -1) break;
    found.push(value.slice(open, end));
    from = end + 1;
  }

  return found;
}

/**
 * Split a value on a separator that is not nested inside parentheses.
 *
 * @param {string} value
 * @param {string} [separator]
 * @returns {string[]}
 */
export function splitTopLevel(value, separator = ",") {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = "";

  for (const char of value) {
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;

    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current);

  return parts.map((part) => part.trim());
}
