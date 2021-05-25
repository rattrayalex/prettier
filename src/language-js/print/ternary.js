"use strict";

const { hasNewlineInRange } = require("../../common/util");
const {
  isJsxNode,
  isBlockComment,
  getComments,
  isCallExpression,
  isMemberExpression,
  isBinaryish,
  isSimpleAtomicExpression,
  isSimpleMemberExpression,
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
const pathNeedsParens = require("../needs-parens");

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
function printTernary(path, options, print, args) {
  const node = path.getValue();
  const isConditionalExpression = node.type === "ConditionalExpression";
  const isTSConditional = !isConditionalExpression;
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
  const isConsequentTernary = consequentNode.type === node.type;
  const isAlternateTernary = alternateNode.type === node.type;
  const isInChain = isAlternateTernary || isInAlternate;
  const isBigTabs = options.tabWidth > 2 || options.useTabs;

  // Find the outermost non-ConditionalExpression parent, and the outermost
  // ConditionalExpression parent.
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

  const isOnSameLineAsAssignment =
    args &&
    args.assignmentLayout &&
    args.assignmentLayout !== "break-after-operator" &&
    (parent.type === "AssignmentExpression" ||
      parent.type === "VariableDeclarator" ||
      parent.type === "ClassProperty" ||
      parent.type === "PropertyDefinition" ||
      parent.type === "ClassPrivateProperty" ||
      parent.type === "ObjectProperty" ||
      parent.type === "Property");

  const isOnSameLineAsReturn =
    (parent.type === "ReturnStatement" || parent.type === "ThrowStatement") &&
    !(isConsequentTernary || isAlternateTernary);

  const isInJsx =
    isConditionalExpression &&
    firstNonConditionalParent.type === "JSXExpressionContainer" &&
    path.getParentNode(1).type !== "JSXAttribute";

  const shouldExtraIndent = shouldExtraIndentForConditionalExpression(path);
  const breakClosingParen = shouldBreakClosingParen(node, parent);
  const breakTSClosingParen = isTSConditional && pathNeedsParens(path, options);

  const fillTab = !isBigTabs
    ? ""
    : options.useTabs
    ? "\t"
    : " ".repeat(options.tabWidth - 1);

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
    isConsequentTernary ||
    isAlternateTernary;

  // Keep ` : ` on the same line as the consequent for this format:
  //   foo ? foo : (
  //     something.else()
  //   );
  // Which we only do in some situations.
  const shouldHugAlt =
    !isParentTernary &&
    !isInChain &&
    !isTSConditional &&
    (isInJsx ||
      ((isOnSameLineAsAssignment || isOnSameLineAsReturn) &&
        (isSimpleAtomicExpression(consequentNode) ||
          isSimpleMemberExpression(consequentNode, { maxDepth: 2 })) &&
        !(
          isSimpleAtomicExpression(alternateNode) ||
          isSimpleMemberExpression(alternateNode, { maxDepth: 2 })
        )));

  const shouldGroupTestAndConsequent =
    shouldHugAlt || isInChain || isParentTernary || isTSConditional;

  const dedentIfRhs = (doc) =>
    shouldHugAlt && (isOnSameLineAsAssignment || isOnSameLineAsReturn)
      ? dedent(doc)
      : doc;

  const testId = Symbol("test");
  const consequentId = Symbol("consequent");
  const testAndConsequentId = Symbol("test-and-consequent");
  const printedTest = group(
    [
      isConditionalExpression
        ? [
            wrapInParens(print("test")),
            node.test.type === "ConditionalExpression" ? breakParent : "",
          ]
        : [print("checkType"), " ", "extends", " ", print("extendsType")],
      " ?",
    ],
    { id: testId }
  );

  const consequent = indent([
    isConsequentTernary ||
    (isInJsx && (isJsxNode(consequentNode) || isParentTernary || isInChain))
      ? hardline
      : line,
    print(consequentNodePropertyName),
  ]);

  const printedTestAndConsequent = shouldGroupTestAndConsequent
    ? group(
        [
          printedTest,

          // Avoid indenting consequent if it isn't a chain, even if the test breaks.
          isInChain
            ? consequent
            : isTSConditional
            ? group(consequent, { id: consequentId })
            : // If the test breaks, also break the consequent
              ifBreak(consequent, group(consequent, { id: consequentId }), {
                groupId: testId,
              }),
        ],
        { id: testAndConsequentId }
      )
    : [printedTest, consequent];

  const printedAlternate = print(alternateNodePropertyName);

  const parts = [
    printedTestAndConsequent,

    isAlternateTernary
      ? hardline
      : shouldHugAlt
      ? ifBreak(line, " ", { groupId: testAndConsequentId })
      : line,
    ":",
    isAlternateTernary
      ? " "
      : !isBigTabs
      ? " "
      : shouldGroupTestAndConsequent
      ? ifBreak(
          fillTab,
          ifBreak(isInChain || shouldHugAlt ? " " : fillTab, " "),
          { groupId: testAndConsequentId }
        )
      : shouldHugAlt
      ? ifBreak(" ", fillTab)
      : ifBreak(fillTab, " "),

    isAlternateTernary
      ? printedAlternate
      : shouldHugAlt
      ? ifBreak(
          group([indent(printedAlternate), isInJsx ? softline : ""]),
          isInJsx
            ? group(wrapInParens(printedAlternate))
            : group(dedent(wrapInParens(printedAlternate))),
          { groupId: testAndConsequentId }
        )
      : group([indent(printedAlternate), isInJsx ? softline : ""]),

    breakClosingParen && !shouldExtraIndent ? softline : "",
    shouldBreak ? breakParent : "",
  ];

  const result =
    isOnSameLineAsAssignment || isOnSameLineAsReturn
      ? group(indent(parts))
      : shouldExtraIndent || (isTSConditional && isInTest)
      ? group([indent([softline, parts]), breakTSClosingParen ? softline : ""])
      : parent === firstNonConditionalParent
      ? group(parts)
      : parts;

  return result;
}

module.exports = { printTernary };
