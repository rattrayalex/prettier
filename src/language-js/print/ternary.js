"use strict";

const { hasNewlineInRange } = require("../../common/util");
const {
  isJsxNode,
  isBlockComment,
  getComments,
  isCallExpression,
  isMemberExpression,
} = require("../utils");
const { locStart, locEnd } = require("../loc");
const {
  builders: {
    line,
    softline,
    hardline,
    group,
    indent,
    ifBreak,
    dedent,
    align,
    breakParent,
  },
} = require("../../document");

/**
 * @typedef {import("../../document").Doc} Doc
 * @typedef {import("../../common/ast-path")} AstPath
 *
 * @typedef {any} Options - Prettier options (TBD ...)
 */

// If we have nested conditional expressions, we want to print them in JSX mode
// if there's at least one JSXElement somewhere in the tree.
//
// A conditional expression chain like this should be printed in normal mode,
// because there aren't JSXElements anywhere in it:
//
// isA ? "A" : isB ? "B" : isC ? "C" : "Unknown";
//
// But a conditional expression chain like this should be printed in JSX mode,
// because there is a JSXElement in the last ConditionalExpression:
//
// isA ? "A" : isB ? "B" : isC ? "C" : <span className="warning">Unknown</span>;
//
// This type of ConditionalExpression chain is structured like this in the AST:
//
// ConditionalExpression {
//   test: ...,
//   consequent: ...,
//   alternate: ConditionalExpression {
//     test: ...,
//     consequent: ...,
//     alternate: ConditionalExpression {
//       test: ...,
//       consequent: ...,
//       alternate: ...,
//     }
//   }
// }
function conditionalExpressionChainContainsJsx(node) {
  // We don't care about whether each node was the test, consequent, or alternate
  // We are only checking if there's any JSXElements inside.
  const conditionalExpressions = [node];
  for (let index = 0; index < conditionalExpressions.length; index++) {
    const conditionalExpression = conditionalExpressions[index];
    for (const property of ["test", "consequent", "alternate"]) {
      const node = conditionalExpression[property];

      if (isJsxNode(node)) {
        return true;
      }

      if (node.type === "ConditionalExpression") {
        conditionalExpressions.push(node);
      }
    }
  }

  return false;
}

// Break the closing paren to keep the chain right after it:
// (a
//   ? b
//   : c
// ).call()
function shouldBreakClosingParen(node, parent) {
  return (
    (isMemberExpression(parent) ||
      (parent.type === "NGPipeExpression" && parent.left === node)) &&
    !parent.computed
  );
}

function hasMultilineBlockComments(
  testNodes,
  consequentNode,
  alternateNode,
  options
) {
  const comments = [
    ...testNodes.map((node) => getComments(node)),
    getComments(consequentNode),
    getComments(alternateNode),
  ].flat();
  return comments.some(
    (comment) =>
      isBlockComment(comment) &&
      hasNewlineInRange(
        options.originalText,
        locStart(comment),
        locEnd(comment)
      )
  );
}

const ancestorNameMap = new Map([
  ["AssignmentExpression", "right"],
  ["VariableDeclarator", "init"],
  ["ReturnStatement", "argument"],
  ["ThrowStatement", "argument"],
  ["UnaryExpression", "argument"],
  ["YieldExpression", "argument"],
]);
/**
 * Do we want to wrap the entire ternary in its own indent?
 * Eg; for when instead of this:
 *    foo = cond ?
 *      cons
 *    : alt
 * We want this:
 *    foo =
 *      cond ?
 *        cons
 *      : alt
 */
function shouldExtraIndentForConditionalExpression(path) {
  const node = path.getValue();
  if (node.type !== "ConditionalExpression") {
    return false;
  }

  let parent;
  let child = node;
  for (let ancestorCount = 0; !parent; ancestorCount++) {
    const node = path.getParentNode(ancestorCount);

    if (
      (isCallExpression(node) && node.callee === child) ||
      (isMemberExpression(node) && node.object === child) ||
      (node.type === "TSNonNullExpression" && node.expression === child)
    ) {
      child = node;
      continue;
    }

    // Reached chain root
    if (
      (node.type === "NewExpression" && node.callee === child) ||
      (node.type === "TSAsExpression" && node.expression === child)
    ) {
      parent = path.getParentNode(ancestorCount + 1);
      child = node;
    } else {
      parent = node;
    }
  }

  // Do not add indent to direct `ConditionalExpression`
  if (child === node) {
    return false;
  }

  return parent[ancestorNameMap.get(parent.type)] === child;
}

// The only things we don't wrap are:
// * Nested conditional expressions in alternates
// * null
// * undefined
const isNil = (node) =>
  node.type === "NullLiteral" ||
  (node.type === "Literal" && node.value === null) ||
  (node.type === "Identifier" && node.name === "undefined");

// Even though they don't need parens, we wrap (almost) everything in
// parens when using ?: within JSX, because the parens are analogous to
// curly braces in an if statement.
const wrapInParens = (doc) => [
  ifBreak("("),
  indent([softline, doc]),
  softline,
  ifBreak(")"),
];

/**
 * The following is the shared logic for
 * ternary operators, namely ConditionalExpression
 * and TSConditionalType
 * @param {AstPath} path - The path to the ConditionalExpression/TSConditionalType node.
 * @param {Options} options - Prettier options
 * @param {Function} print - Print function to call recursively
 * @returns {Doc}
 */
function printTernary(path, options, print) {
  const node = path.getValue();
  const isConditionalExpression = node.type === "ConditionalExpression";
  const consequentNodePropertyName = isConditionalExpression
    ? "consequent"
    : "trueType";
  const alternateNodePropertyName = isConditionalExpression
    ? "alternate"
    : "falseType";
  const testNodePropertyNames = isConditionalExpression
    ? ["test"]
    : ["checkType", "extendsType"];
  const consequentNode = node[consequentNodePropertyName];
  const alternateNode = node[alternateNodePropertyName];
  const testNodes = testNodePropertyNames.map((prop) => node[prop]);

  const parent = path.getParentNode();
  const isParentTernary = parent.type === node.type;
  const isInTest =
    isParentTernary &&
    testNodePropertyNames.some((prop) => parent[prop] === node);
  const isInConsequent =
    isParentTernary && parent[consequentNodePropertyName] === node;
  const isInAlternate =
    isParentTernary && parent[alternateNodePropertyName] === node;
  const consequentIsTernary = consequentNode.type === node.type;
  const alternateIsTernary = alternateNode.type === node.type;
  const isInChain = alternateIsTernary || isInAlternate;

  // Find the outermost non-ConditionalExpression parent, and the outermost
  // ConditionalExpression parent. We'll use these to determine if we should
  // print in JSX mode.
  let currentParent;
  let previousParent;
  let i = 0;
  do {
    previousParent = currentParent || node;
    currentParent = path.getParentNode(i);
    i++;
  } while (
    currentParent &&
    currentParent.type === node.type &&
    testNodePropertyNames.every(
      (prop) => currentParent[prop] !== previousParent
    )
  );
  const firstNonConditionalParent = currentParent || parent;
  const lastConditionalParent = previousParent;

  // When a ternary's parent is a JSXExpressionContainer which is not in a JSXAttribute,
  // and the consequent is not \`null\`,
  // force the consequent to break,
  // and force the terminal alternate to break if it is a JSXElement;
  // when the consequent is \`null\`,
  // do not add a line before or after it.

  const inJSX =
    isConditionalExpression &&
    firstNonConditionalParent.type === "JSXExpressionContainer" &&
    path.getParentNode(i).type !== "JSXAttribute";

  const shouldExtraIndent = shouldExtraIndentForConditionalExpression(path);
  const breakClosingParen = shouldBreakClosingParen(node, parent);
  // We want a whole chain of ConditionalExpressions to all
  // break if any of them break. That means we should only group around the
  // outer-most ConditionalExpression.
  const shouldBreak =
    hasMultilineBlockComments(
      testNodes,
      consequentNode,
      alternateNode,
      options
    ) ||
    consequentIsTernary ||
    alternateIsTernary;

  const printedTest = isConditionalExpression
    ? wrapInParens(print("test"))
    : [print("checkType"), " ", "extends", " ", print("extendsType")];

  /**
   * Have a null consequent and the colon hug the test in JSX, eg:
   * <div>
   *  {!foo ? null : (
   *    <Bar />
   *  )}
   * </div>
   */
  if (inJSX && isNil(consequentNode)) {
    return [
      group([
        wrapInParens(printedTest),
        " ? ",
        print(consequentNodePropertyName),
        " : ",
      ]),

      group(wrapInParens(print(alternateNodePropertyName)), {
        shouldBreak: inJSX && isJsxNode(alternateNode),
      }),
    ];
  }

  const consequent = indent([
    consequentIsTernary || inJSX ? hardline : line,
    print(consequentNodePropertyName),
  ]);

  const parts = [
    group([
      group([printedTest, " ?"]),

      // Avoid indenting consequent if it isn't a chain, even if the test breaks.
      !isInChain ? group(consequent) : consequent,
    ]),

    alternateIsTernary ? hardline : line,
    ": ",
    alternateIsTernary
      ? print(alternateNodePropertyName)
      : group(wrapInParens(print(alternateNodePropertyName)), {
          shouldBreak: inJSX && isJsxNode(alternateNode),
        }),

    isConditionalExpression && breakClosingParen && !shouldExtraIndent
      ? softline
      : "",
  ];

  const result =
    parent.type === "ReturnStatement"
      ? group(wrapInParens(parts), { shouldBreak })
      : isInTest || shouldExtraIndent
      ? group([indent([softline, parts])], { shouldBreak })
      : parent === firstNonConditionalParent
      ? group(parts, { shouldBreak })
      : shouldBreak
      ? [parts, breakParent]
      : parts;

  return result;
}

module.exports = { printTernary };
