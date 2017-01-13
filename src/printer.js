"use strict";
var assert = require("assert");
var sourceMap = require("source-map");
var printComments = require("./comments").printComments;
var pp = require("./pp");
var fromString = pp.fromString;
var concat = pp.concat;
var isEmpty = pp.isEmpty;
var join = pp.join;
var line = pp.line;
var hardline = pp.hardline;
var softline = pp.softline;
var literalline = pp.literalline;
var group = pp.group;
var multilineGroup = pp.multilineGroup;
var indent = pp.indent;
var getFirstString = pp.getFirstString;
var hasHardLine = pp.hasHardLine;
var conditionalGroup = pp.conditionalGroup;
var ifBreak = pp.ifBreak;
var normalizeOptions = require("./options").normalize;
var types = require("ast-types");
var namedTypes = types.namedTypes;
var isString = types.builtInTypes.string;
var isObject = types.builtInTypes.object;
var FastPath = require("./fast-path");
var util = require("./util");
var isIdentifierName = require("esutils").keyword.isIdentifierNameES6;

function PrintResult(code, sourceMap) {
  assert.ok(this instanceof PrintResult);

  isString.assert(code);

  this.code = code;

  if (sourceMap) {
    isObject.assert(sourceMap);

    this.map = sourceMap;
  }
}

var PRp = PrintResult.prototype;
var warnedAboutToString = false;

PRp.toString = function() {
  if (!warnedAboutToString) {
    console.warn(
      "Deprecation warning: recast.print now returns an object with " +
        "a .code property. You appear to be treating the object as a " +
        "string, which might still work but is strongly discouraged."
    );

    warnedAboutToString = true;
  }

  return this.code;
};

var emptyPrintResult = new PrintResult("");

function Printer(originalOptions) {
  assert.ok(this instanceof Printer);

  var explicitTabWidth = originalOptions && originalOptions.tabWidth;
  var options = normalizeOptions(originalOptions);

  assert.notStrictEqual(options, originalOptions);

  // It's common for client code to pass the same options into both
  // recast.parse and recast.print, but the Printer doesn't need (and
  // can be confused by) options.sourceFileName, so we null it out.
  options.sourceFileName = null;

  // Print the entire AST generically.
  function printGenerically(path) {
    return printComments(path, p => genericPrint(p, options, printGenerically), options);
  }

  this.print = function(ast) {
    if (!ast) {
      return emptyPrintResult;
    }

    var lines = print(FastPath.from(ast), true);
    return new PrintResult(
      lines.toString(options),
      util.composeSourceMaps(
        options.inputSourceMap,
        lines.getSourceMap(options.sourceMapName, options.sourceRoot)
      )
    );
  };

  this.printGenerically = function(ast) {
    if (!ast) {
      return emptyPrintResult;
    }

    var path = FastPath.from(ast);
    var oldReuseWhitespace = options.reuseWhitespace;

    // Do not reuse whitespace (or anything else, for that matter)
    // when printing generically.
    options.reuseWhitespace = false;

    var res = printGenerically(path);
    var pr = new PrintResult(pp.print(options.printWidth, res));

    options.reuseWhitespace = oldReuseWhitespace;

    return pr;
  };
}

exports.Printer = Printer;

function maybeAddParens(path, lines) {
  return path.needsParens() ? concat([ "(", lines, ")" ]) : lines;
}

function genericPrint(path, options, printPath) {
  assert.ok(path instanceof FastPath);

  var node = path.getValue();
  var parts = [];
  var needsParens = false;
  var linesWithoutParens = genericPrintNoParens(path, options, printPath);

  if (!node || isEmpty(linesWithoutParens)) {
    return linesWithoutParens;
  }

  if (
    node.decorators && node.decorators.length > 0 &&
      // If the parent node is an export declaration, it will be
      // responsible for printing node.decorators.
      !util.getParentExportDeclaration(path)
  ) {
    path.each(
      function(decoratorPath) {
        parts.push(printPath(decoratorPath), line);
      },
      "decorators"
    );
  } else if (
    util.isExportDeclaration(node) && node.declaration &&
      node.declaration.decorators
  ) {
    // Export declarations are responsible for printing any decorators
    // that logically apply to node.declaration.
    path.each(
      function(decoratorPath) {
        parts.push(printPath(decoratorPath), line);
      },
      "declaration",
      "decorators"
    );
  } else {
    // Nodes with decorators can't have parentheses, so we can avoid
    // computing path.needsParens() except in this case.
    needsParens = path.needsParens();
  }

  if (needsParens) {
    parts.unshift("(");
  }

  parts.push(linesWithoutParens);

  if (needsParens) {
    parts.push(")");
  }

  return concat(parts);
}

function genericPrintNoParens(path, options, print) {
  var n = path.getValue();

  if (!n) {
    return fromString("");
  }

  if (typeof n === "string") {
    return fromString(n, options);
  }

  // TODO: For some reason NumericLiteralTypeAnnotation is not
  // printable so this throws, but I think that's a bug in ast-types.
  // This assert isn't very useful though.
  // namedTypes.Printable.assert(n);
  var parts = [];
  switch (n.type) {
  case "File":
    return path.call(print, "program");
  case "Program":
    // Babel 6
    if (n.directives) {
      path.each(
        function(childPath) {
          parts.push(print(childPath), ";", hardline);
        },
        "directives"
      );
    }

    parts.push(
      path.call(
        function(bodyPath) {
          return printStatementSequence(bodyPath, options, print);
        },
        "body"
      )
    );

    parts.push(hardline);

    return concat(parts);
  // Babel extension.
  case "Noop":
  case "EmptyStatement":
    return fromString("");
  case "ExpressionStatement":
    return concat([ path.call(print, "expression"), ";" ]);
  case // Babel extension.
  "ParenthesizedExpression":
    return concat([ "(", path.call(print, "expression"), ")" ]);
  case "AssignmentExpression":
    return group(
      concat([
        path.call(print, "left"),
        " ",
        n.operator,
        " ",
        path.call(print, "right")
      ])
    );
  case "BinaryExpression":
  case "LogicalExpression":
    return group(
      concat([
        path.call(print, "left"),
        " ",
        n.operator,
        indent(options.tabWidth, concat([ line, path.call(print, "right") ]))
      ])
    );
  case "AssignmentPattern":
    return concat([
      path.call(print, "left"),
      " = ",
      path.call(print, "right")
    ]);
  case "MemberExpression": {
      return concat([
        path.call(print, "object"),
        printMemberLookup(path, print)
      ]);
    }
  case "MetaProperty":
    return concat([
      path.call(print, "meta"),
      ".",
      path.call(print, "property")
    ]);
  case "BindExpression":
    if (n.object) {
      parts.push(path.call(print, "object"));
    }

    parts.push("::", path.call(print, "callee"));

    return concat(parts);
  case "Path":
    return join(".", n.body);
  case "Identifier":
    return concat([
      n.name,
      n.optional ? "?" : "",
      path.call(print, "typeAnnotation")
    ]);
  case "SpreadElement":
  case "SpreadElementPattern":
  // Babel 6 for ObjectPattern
  case "RestProperty":
  case "SpreadProperty":
  case "SpreadPropertyPattern":
  case "RestElement":
    return concat([
      "...",
      path.call(print, "argument"),
      path.call(print, "typeAnnotation")
    ]);
  case "FunctionDeclaration":
  case "FunctionExpression":
    if (n.async)
      parts.push("async ");

    parts.push("function");

    if (n.generator)
      parts.push("*");

    if (n.id) {
      parts.push(" ", path.call(print, "id"));
    }

    parts.push(
      path.call(print, "typeParameters"),
      multilineGroup(concat([
        printFunctionParams(path, print, options),
        printReturnType(path, print)
      ])),
      " ",
      path.call(print, "body")
    );

    return concat(parts);
  case "ArrowFunctionExpression":
    if (n.async)
      parts.push("async ");

    if (n.typeParameters) {
      parts.push(path.call(print, "typeParameters"));
    }

    if (
      !options.arrowParensAlways && n.params.length === 1 && !n.rest &&
        n.params[0].type === "Identifier" &&
        !n.params[0].typeAnnotation &&
        !n.predicate &&
        !n.returnType
    ) {
      parts.push(path.call(print, "params", 0));
    } else {
      parts.push(multilineGroup(concat([
        printFunctionParams(path, print, options),
        printReturnType(path, print)
      ])));
    }

    parts.push(" =>");

    const body = path.call(print, "body");
    const collapsed = concat([ concat(parts), " ", body ]);

    if (n.body.type === "JSXElement") {
      return group(collapsed);
    }

    return conditionalGroup([
      collapsed,
      concat([
        concat(parts),
        indent(options.tabWidth, concat([ line, body ])),
      ]),
    ]);
  case "MethodDefinition":
    if (n.static) {
      parts.push("static ");
    }

    parts.push(printMethod(path, options, print));

    return concat(parts);
  case "YieldExpression":
    parts.push("yield");

    if (n.delegate)
      parts.push("*");

    if (n.argument)
      parts.push(" ", path.call(print, "argument"));

    return concat(parts);
  case "AwaitExpression":
    parts.push("await");

    if (n.all)
      parts.push("*");

    if (n.argument)
      parts.push(" ", path.call(print, "argument"));

    return concat(parts);
  case "ModuleDeclaration":
    parts.push("module", path.call(print, "id"));

    if (n.source) {
      assert.ok(!n.body);

      parts.push("from", path.call(print, "source"));
    } else {
      parts.push(path.call(print, "body"));
    }

    return join(" ", parts);
  case "ImportSpecifier":
    if (n.imported) {
      parts.push(path.call(print, "imported"));

      if (n.local && n.local.name !== n.imported.name) {
        parts.push(" as ", path.call(print, "local"));
      }
    } else if (n.id) {
      parts.push(path.call(print, "id"));

      if (n.name) {
        parts.push(" as ", path.call(print, "name"));
      }
    }

    return concat(parts);
  case "ExportSpecifier":
    if (n.local) {
      parts.push(path.call(print, "local"));

      if (n.exported && n.exported.name !== n.local.name) {
        parts.push(" as ", path.call(print, "exported"));
      }
    } else if (n.id) {
      parts.push(path.call(print, "id"));

      if (n.name) {
        parts.push(" as ", path.call(print, "name"));
      }
    }

    return concat(parts);
  case "ExportBatchSpecifier":
    return fromString("*");
  case "ImportNamespaceSpecifier":
    parts.push("* as ");

    if (n.local) {
      parts.push(path.call(print, "local"));
    } else if (n.id) {
      parts.push(path.call(print, "id"));
    }

    return concat(parts);
  case "ImportDefaultSpecifier":
    if (n.local) {
      return path.call(print, "local");
    }

    return path.call(print, "id");
  case "ExportDeclaration":
  case "ExportDefaultDeclaration":
  case "ExportNamedDeclaration":
    return printExportDeclaration(path, options, print);
  case "ExportAllDeclaration":
    parts.push("export *");

    if (n.exported) {
      parts.push(" as ", path.call(print, "exported"));
    }

    parts.push(" from ", path.call(print, "source"), ";");

    return concat(parts);
  case "ExportNamespaceSpecifier":
    return concat([ "* as ", path.call(print, "exported") ]);
  case "ExportDefaultSpecifier":
    return path.call(print, "exported");
  case "ImportDeclaration":
    parts.push("import ");

    if (n.importKind && n.importKind !== "value") {
      parts.push(n.importKind + " ");
    }

    if (n.specifiers && n.specifiers.length > 0) {
      var foundImportSpecifier = false;

      path.each(
        function(specifierPath) {
          var i = specifierPath.getName();

          if (i > 0) {
            parts.push(", ");
          }

          var value = specifierPath.getValue();

          if (
            namedTypes.ImportDefaultSpecifier.check(value) ||
              namedTypes.ImportNamespaceSpecifier.check(value)
          ) {
            assert.strictEqual(foundImportSpecifier, false);
          } else {
            namedTypes.ImportSpecifier.assert(value);

            if (!foundImportSpecifier) {
              foundImportSpecifier = true;

              parts.push(options.bracketSpacing ? "{ " : "{");
            }
          }

          parts.push(print(specifierPath));
        },
        "specifiers"
      );

      if (foundImportSpecifier) {
        parts.push(options.bracketSpacing ? " }" : "}");
      }

      parts.push(" from ");
    }

    parts.push(path.call(print, "source"), ";");

    return concat(parts);
  case "BlockStatement":
    var naked = path.call(
      function(bodyPath) {
        return printStatementSequence(bodyPath, options, print);
      },
      "body"
    );

    // If there are no contents, return a simple block
    if (!getFirstString(naked)) {
      return "{}";
    }

    parts.push("{");

    // Babel 6
    if (n.directives) {
      path.each(
        function(childPath) {
          parts.push(
            indent(
              options.tabWidth,
              concat([ hardline, print(childPath), ";", hardline ])
            )
          );
        },
        "directives"
      );
    }

    parts.push(indent(options.tabWidth, concat([ hardline, naked ])));

    parts.push(hardline, "}");

    return concat(parts);
  case "ReturnStatement":
    parts.push("return");

    if (n.argument) {
      parts.push(" ", path.call(print, "argument"));
    }

    parts.push(";");

    return concat(parts);
  case "CallExpression": {
      const parent = path.getParentNode();
      // We detect calls on member lookups and possibly print them in a
      // special chain format. See `printMemberChain` for more info.
      if (n.callee.type === "MemberExpression") {
        const printed = printMemberChain(n, options, print);
        if (printed) {
          return printed;
        }
      }

      return concat([
        path.call(print, "callee"),
        printArgumentsList(path, options, print)
      ]);
    }

  case "ObjectExpression":
  case "ObjectPattern":
  case "ObjectTypeAnnotation":
    var allowBreak = false;
    var isTypeAnnotation = n.type === "ObjectTypeAnnotation";
    // Leave this here because we *might* want to make this
    // configurable later -- flow accepts ";" for type separators
    var separator = isTypeAnnotation ? "," : ",";
    var fields = [];
    var leftBrace = n.exact ? "{|" : "{";
    var rightBrace = n.exact ? "|}" : "}";

    if (isTypeAnnotation) {
      fields.push("indexers", "callProperties");
    }

    fields.push("properties");

    var i = 0;
    var props = [];

    fields.forEach(function(field) {
      path.each(
        function(childPath) {
          props.push(group(print(childPath)));
        },
        field
      );
    });

    if (props.length === 0) {
      return "{}";
    } else {
      return multilineGroup(
        concat([
          leftBrace,
          indent(
            options.tabWidth,
            concat([
              options.bracketSpacing ? line : softline,
              join(concat([ separator, line ]), props)
            ])
          ),
          ifBreak(options.trailingComma ? "," : ""),
          options.bracketSpacing ? line : softline,
          rightBrace,
          path.call(print, "typeAnnotation")
        ])
      );
    }

  case "PropertyPattern":
    return concat([
      path.call(print, "key"),
      ": ",
      path.call(print, "pattern")
    ]);
  // Babel 6
  case "ObjectProperty":
  case // Non-standard AST node type.
  "Property":
    if (n.method || n.kind === "get" || n.kind === "set") {
      return printMethod(path, options, print);
    }

    if (n.shorthand) {
      parts.push(path.call(print, "value"));
    } else {
      if (n.computed) {
        parts.push("[", path.call(print, "key"), "]");
      } else {
        parts.push(printPropertyKey(path, print));
      }
      parts.push(": ", path.call(print, "value"));
    }

    return concat(parts);
  case // Babel 6
  "ClassMethod":
    if (n.static) {
      parts.push("static ");
    }

    parts = parts.concat(printObjectMethod(path, options, print));

    return concat(parts);
  case // Babel 6
  "ObjectMethod":
    return printObjectMethod(path, options, print);
  case "Decorator":
    return concat([ "@", path.call(print, "expression") ]);
  case "ArrayExpression":
  case "ArrayPattern":
    if (n.elements.length === 0) {
      parts.push("[]");
    } else {
      parts.push(
        multilineGroup(
          concat([
            "[",
            indent(
              options.tabWidth,
              concat([
                options.bracketSpacing ? line : softline,
                join(concat([ ",", line ]), path.map(print, "elements"))
              ])
            ),
            ifBreak(options.trailingComma ? "," : ""),
            options.bracketSpacing ? line : softline,
            "]"
          ])
        )
      );
    }

    if (n.typeAnnotation)
      parts.push(path.call(print, "typeAnnotation"));

    return concat(parts);
  case "SequenceExpression":
    return join(", ", path.map(print, "expressions"));
  case "ThisExpression":
    return fromString("this");
  case "Super":
    return fromString("super");
  case // Babel 6 Literal split
  "NullLiteral":
    return fromString("null");
  case // Babel 6 Literal split
  "RegExpLiteral":
    return fromString(n.extra.raw);
  // Babel 6 Literal split
  case "BooleanLiteral":
  // Babel 6 Literal split
  case "NumericLiteral":
  // Babel 6 Literal split
  case "StringLiteral":
  case "Literal":
    if (typeof n.value !== "string")
      return fromString(n.value, options);

    return nodeStr(n.value, options);
  case // Babel 6
  "Directive":
    return path.call(print, "value");
  case // Babel 6
  "DirectiveLiteral":
    return fromString(nodeStr(n.value, options));
  case "ModuleSpecifier":
    if (n.local) {
      throw new Error("The ESTree ModuleSpecifier type should be abstract");
    }

    // The Esprima ModuleSpecifier type is just a string-valued
    // Literal identifying the imported-from module.
    return fromString(nodeStr(n.value, options), options);
  case "UnaryExpression":
    parts.push(n.operator);

    if (/[a-z]$/.test(n.operator))
      parts.push(" ");

    parts.push(path.call(print, "argument"));

    return concat(parts);
  case "UpdateExpression":
    parts.push(path.call(print, "argument"), n.operator);

    if (n.prefix)
      parts.reverse();

    return concat(parts);
  case "ConditionalExpression":
    return group(
      concat([
        path.call(print, "test"),
        indent(
          options.tabWidth,
          concat([
            line,
            "? ",
            path.call(print, "consequent"),
            line,
            ": ",
            path.call(print, "alternate")
          ])
        )
      ])
    );
  case "NewExpression":
    parts.push("new ", path.call(print, "callee"));

    var args = n.arguments;

    if (args) {
      parts.push(printArgumentsList(path, options, print));
    }

    return concat(parts);
  case "VariableDeclaration":
    var printed = path.map(
      function(childPath) {
        return print(childPath);
      },
      "declarations"
    );

    parts = [
      n.kind,
      " ",
      printed[0],
      indent(
        options.tabWidth,
        concat(printed.slice(1).map(p => concat([ ",", line, p ])))
      )
    ];

    // We generally want to terminate all variable declarations with a
    // semicolon, except when they are children of for loops.
    var parentNode = path.getParentNode();

    if (
      !namedTypes.ForStatement.check(parentNode) &&
        !namedTypes.ForInStatement.check(parentNode) &&
        !(namedTypes.ForOfStatement &&
          namedTypes.ForOfStatement.check(parentNode)) &&
        !(namedTypes.ForAwaitStatement &&
          namedTypes.ForAwaitStatement.check(parentNode))
    ) {
      parts.push(";");
    }

    return multilineGroup(concat(parts));
  case "VariableDeclarator":
    return n.init
      ? concat([ path.call(print, "id"), " = ", path.call(print, "init") ])
      : path.call(print, "id");
  case "WithStatement":
    return concat([
      "with (",
      path.call(print, "object"),
      ") ",
      path.call(print, "body")
    ]);
  case "IfStatement":
    const con = adjustClause(path.call(print, "consequent"), options);

    parts = [
      "if (",
      group(
        concat([
          indent(
            options.tabWidth,
            concat([ softline, path.call(print, "test") ])
          ),
          softline
        ])
      ),
      ")",
      con
    ];

    if (n.alternate) {
      const hasBraces = isCurlyBracket(con);
      const isEmpty = isEmptyBlock(con);

      if (hasBraces && !isEmpty) {
        parts.push(" else");
      } else {
        parts.push(concat([ hardline, "else" ]));
      }

      parts.push(
        adjustClause(
          path.call(print, "alternate"),
          options,
          n.alternate.type === "IfStatement"
        )
      );
    }

    return group(concat(parts));
  case "ForStatement":
    // TODO Get the for (;;) case right.
    return concat([
      "for (",
      group(
        concat([
          indent(
            options.tabWidth,
            concat([
              softline,
              path.call(print, "init"),
              ";",
              line,
              path.call(print, "test"),
              ";",
              line,
              path.call(print, "update")
            ])
          ),
          softline
        ])
      ),
      ")",
      adjustClause(path.call(print, "body"), options)
    ]);
  case "WhileStatement":
    return concat([
      "while (",
      path.call(print, "test"),
      ")",
      adjustClause(path.call(print, "body"), options)
    ]);
  case "ForInStatement":
    // Note: esprima can't actually parse "for each (".
    return concat([
      n.each ? "for each (" : "for (",
      path.call(print, "left"),
      " in ",
      path.call(print, "right"),
      ")",
      adjustClause(path.call(print, "body"), options)
    ]);
  case "ForOfStatement":
    return concat([
      "for (",
      path.call(print, "left"),
      " of ",
      path.call(print, "right"),
      ")",
      adjustClause(path.call(print, "body"), options)
    ]);
  case "ForAwaitStatement":
    return concat([
      "for await (",
      path.call(print, "left"),
      " of ",
      path.call(print, "right"),
      ")",
      adjustClause(path.call(print, "body"), options)
    ]);
  case "DoWhileStatement":
    var clause = adjustClause(path.call(print, "body"), options);
    var doBody = concat([ "do", clause ]);
    var parts = [ doBody ];
    const hasBraces = isCurlyBracket(clause);

    if (hasBraces)
      parts.push(" while");
    else
      parts.push(concat([ line, "while" ]));

    parts.push(" (", path.call(print, "test"), ");");

    return concat(parts);
  case "DoExpression":
    var statements = path.call(
      function(bodyPath) {
        return printStatementSequence(bodyPath, options, print);
      },
      "body"
    );
    return concat([ "do {\n", statements.indent(options.tabWidth), "\n}" ]);
  case "BreakStatement":
    parts.push("break");

    if (n.label)
      parts.push(" ", path.call(print, "label"));

    parts.push(";");

    return concat(parts);
  case "ContinueStatement":
    parts.push("continue");

    if (n.label)
      parts.push(" ", path.call(print, "label"));

    parts.push(";");

    return concat(parts);
  case "LabeledStatement":
    return concat([
      path.call(print, "label"),
      ":",
      hardline,
      path.call(print, "body")
    ]);
  case "TryStatement":
    parts.push("try ", path.call(print, "block"));

    if (n.handler) {
      parts.push(" ", path.call(print, "handler"));
    } else if (n.handlers) {
      path.each(
        function(handlerPath) {
          parts.push(" ", print(handlerPath));
        },
        "handlers"
      );
    }

    if (n.finalizer) {
      parts.push(" finally ", path.call(print, "finalizer"));
    }

    return concat(parts);
  case "CatchClause":
    parts.push("catch (", path.call(print, "param"));

    if (n.guard)
      // Note: esprima does not recognize conditional catch clauses.
      parts.push(" if ", path.call(print, "guard"));

    parts.push(") ", path.call(print, "body"));

    return concat(parts);
  case "ThrowStatement":
    return concat([ "throw ", path.call(print, "argument"), ";" ]);
  // Note: ignoring n.lexical because it has no printing consequences.
  case "SwitchStatement":
    return concat([
      "switch (",
      path.call(print, "discriminant"),
      ") {",
      indent(
        options.tabWidth,
        concat([ hardline, join(hardline, path.map(print, "cases"))])
      ),
      hardline,
      "}"
    ]);
  case "SwitchCase":
    if (n.test)
      parts.push("case ", path.call(print, "test"), ":");
    else
      parts.push("default:");

    if (n.consequent.length > 0) {
      const cons = path.call(
        function(consequentPath) {
          return printStatementSequence(consequentPath, options, print);
        },
        "consequent"
      );

      parts.push(
        isCurlyBracket(cons)
          ? concat([ " ", cons ])
          : indent(options.tabWidth, concat([ hardline, cons ]))
      );
    }

    return concat(parts);
  // JSX extensions below.
  case "DebuggerStatement":
    return fromString("debugger;");
  case "JSXAttribute":
    parts.push(path.call(print, "name"));

    if (n.value) {
      let res;
      if (
        (n.value.type === 'StringLiteral' || n.value.type === 'Literal') &&
        typeof n.value.value === 'string'
      ) {
        res = '"' + util.htmlEscapeInsideDoubleQuote(n.value.value) + '"';
      } else {
        res = path.call(print, "value");
      }
      parts.push("=", res);
    }

    return concat(parts);
  case "JSXIdentifier":
    return fromString(n.name, options);
  case "JSXNamespacedName":
    return join(":", [ path.call(print, "namespace"), path.call(print, "name") ]);
  case "JSXMemberExpression":
    return join(".", [ path.call(print, "object"), path.call(print, "property") ]);
  case "JSXSpreadAttribute":
    return concat([ "{...", path.call(print, "argument"), "}" ]);
  case "JSXExpressionContainer":
    return group(concat([
      "{",
      indent(options.tabWidth,
             concat([softline, path.call(print, "expression")])),
      softline,
      "}"
    ]));
  case "JSXElement":
    return printJSXElement(path, options, print);
  case "JSXOpeningElement":
    return group(
      concat([
        "<",
        path.call(print, "name"),
        multilineGroup(concat([
          indent(options.tabWidth,
            concat(path.map(attr => concat([line, print(attr)]), "attributes"))
          ),
          n.selfClosing ? line : softline,
        ])),
        n.selfClosing ? "/>" : ">"
      ])
    );
  case "JSXClosingElement":
    return concat([ "</", path.call(print, "name"), ">" ]);
  case "JSXText":
    throw new Error("JSXTest should be handled by JSXElement");
  case "JSXEmptyExpression":
    return "";
  case "TypeAnnotatedIdentifier":
    return concat([
      path.call(print, "annotation"),
      " ",
      path.call(print, "identifier")
    ]);
  case "ClassBody":
    if (n.body.length === 0) {
      return fromString("{}");
    }

    return concat([
      "{",
      indent(
        options.tabWidth,
        concat([
          hardline,
          path.call(
            function(bodyPath) {
              return printStatementSequence(bodyPath, options, print);
            },
            "body"
          )
        ])
      ),
      hardline,
      "}"
    ]);
  case "ClassPropertyDefinition":
    parts.push("static ", path.call(print, "definition"));

    if (!namedTypes.MethodDefinition.check(n.definition))
      parts.push(";");

    return concat(parts);
  case "ClassProperty":
    if (n.static)
      parts.push("static ");

    var key;

    if (n.computed) {
      key = concat([ "[", path.call(print, "key"), "]" ]);
    } else {
      key = printPropertyKey(path, print);
      if (n.variance === "plus") {
        key = concat([ "+", key ]);
      } else if (n.variance === "minus") {
        key = concat([ "-", key ]);
      }
    }

    parts.push(key);

    if (n.typeAnnotation)
      parts.push(path.call(print, "typeAnnotation"));

    if (n.value)
      parts.push(" = ", path.call(print, "value"));

    parts.push(";");

    return concat(parts);
  case "ClassDeclaration":
  case "ClassExpression":
    return concat(printClass(path, print));
  case "TemplateElement":
    return join(literalline, n.value.raw.split("\n"));
  case "TemplateLiteral":
    var expressions = path.map(print, "expressions");

    parts.push("`");

    path.each(
      function(childPath) {
        var i = childPath.getName();

        parts.push(print(childPath));

        if (i < expressions.length) {
          parts.push("${", expressions[i], "}");
        }
      },
      "quasis"
    );

    parts.push("`");

    return concat(parts);
  // These types are unprintable because they serve as abstract
  // supertypes for other (printable) types.
  case "TaggedTemplateExpression":
    return concat([ path.call(print, "tag"), path.call(print, "quasi") ]);
  case "Node":
  case "Printable":
  case "SourceLocation":
  case "Position":
  case "Statement":
  case "Function":
  case "Pattern":
  case "Expression":
  case "Declaration":
  case "Specifier":
  case "NamedSpecifier":
  // Supertype of Block and Line.
  case "Comment":
  // Flow
  case "MemberTypeAnnotation":
  case // Flow
  "Type":
    throw new Error("unprintable type: " + JSON.stringify(n.type));
  // Babel block comment.
  case "CommentBlock":
  case // Esprima block comment.
  "Block":
    return concat([ "/*", n.value, "*/" ]);
  // Babel line comment.
  case "CommentLine":
  case // Esprima line comment.
  "Line":
    return concat([ "//", n.value ]);
  // Type Annotations for Facebook Flow, typically stripped out or
  // transformed away before printing.
  case "TypeAnnotation":
    if (n.typeAnnotation) {
      if (n.typeAnnotation.type !== "FunctionTypeAnnotation") {
        parts.push(": ");
      }

      parts.push(path.call(print, "typeAnnotation"));

      return concat(parts);
    }

    return "";
  case "TupleTypeAnnotation":
    return concat([ "[", join(", ", path.map(print, "types")), "]" ]);
  case "ExistentialTypeParam":
  case "ExistsTypeAnnotation":
    return fromString("*", options);
  case "EmptyTypeAnnotation":
    return fromString("empty", options);
  case "AnyTypeAnnotation":
    return fromString("any", options);
  case "MixedTypeAnnotation":
    return fromString("mixed", options);
  case "ArrayTypeAnnotation":
    return concat([ path.call(print, "elementType"), "[]" ]);
  case "BooleanTypeAnnotation":
    return fromString("boolean", options);
  case "NumericLiteralTypeAnnotation":
  case "BooleanLiteralTypeAnnotation":
    return "" + n.value;
  case "DeclareClass":
    return printFlowDeclaration(path, printClass(path, print));
  case "DeclareFunction":
    return printFlowDeclaration(path, [
      "function ",
      path.call(print, "id"),
      n.predicate ? " " : "",
      path.call(print, "predicate"),
      ";"
    ]);
  case "DeclareModule":
    return printFlowDeclaration(path, [
      "module ",
      path.call(print, "id"),
      " ",
      path.call(print, "body")
    ]);
  case "DeclareModuleExports":
    return printFlowDeclaration(path, [
      "module.exports",
      path.call(print, "typeAnnotation"),
      ";"
    ]);
  case "DeclareVariable":
    return printFlowDeclaration(path, [ "var ", path.call(print, "id"), ";" ]);
  case "DeclareExportAllDeclaration":
    return concat([ "declare export * from ", path.call(print, "source") ]);
  case "DeclareExportDeclaration":
    return concat([ "declare ", printExportDeclaration(path, options, print) ]);
  case "FunctionTypeAnnotation":
    // FunctionTypeAnnotation is ambiguous:
    // declare function foo(a: B): void; OR
    // var A: (a: B) => void;
    var parent = path.getParentNode(0);
    var isArrowFunctionTypeAnnotation = !(!parent.variance &&
      !parent.optional &&
      namedTypes.ObjectTypeProperty.check(parent) ||
      namedTypes.ObjectTypeCallProperty.check(parent) ||
      namedTypes.DeclareFunction.check(path.getParentNode(2)));
    var needsColon = isArrowFunctionTypeAnnotation &&
      namedTypes.TypeAnnotation.check(parent);

    if (needsColon) {
      parts.push(": ");
    }

    parts.push(path.call(print, "typeParameters"));

    parts.push(multilineGroup(printFunctionParams(path, print, options)));

    // The returnType is not wrapped in a TypeAnnotation, so the colon
    // needs to be added separately.
    if (n.returnType || n.predicate) {
      parts.push(
        isArrowFunctionTypeAnnotation ? " => " : ": ",
        path.call(print, "returnType"),
        path.call(print, "predicate")
      );
    }

    return concat(parts);
  case "FunctionTypeParam":
    return concat([
      path.call(print, "name"),
      n.optional ? "?" : "",
      n.name ? ": " : "",
      path.call(print, "typeAnnotation")
    ]);
  case "GenericTypeAnnotation":
    return concat([
      path.call(print, "id"),
      path.call(print, "typeParameters")
    ]);
  case "DeclareInterface":
    parts.push("declare ");

  case "InterfaceDeclaration":
    parts.push(
      fromString("interface ", options),
      path.call(print, "id"),
      path.call(print, "typeParameters"),
      " "
    );

    if (n["extends"].length > 0) {
      parts.push("extends ", join(", ", path.map(print, "extends")));
    }

    parts.push(" ", path.call(print, "body"));

    return concat(parts);
  case "ClassImplements":
  case "InterfaceExtends":
    return concat([
      path.call(print, "id"),
      path.call(print, "typeParameters")
    ]);
  case "IntersectionTypeAnnotation":
  case "UnionTypeAnnotation": {
      const types = path.map(print, "types");
      const op = n.type === "IntersectionTypeAnnotation" ? "&" : "|";

      return conditionalGroup(
        [
          // single-line variation
          // A | B | C
          concat([
            indent(
              options.tabWidth,
              concat([
                types[0],
                indent(
                  options.tabWidth,
                  concat(types.slice(1).map(t => concat([ " ", op, line, t ])))
                )
              ])
            )
          ]),
          // multi-line variation
          // | A
          // | B
          // | C
          concat([
            indent(
              options.tabWidth,
              concat(types.map(t => concat([ line, op, " ", t ])))
            )
          ])
        ]
      );
    }
  case "NullableTypeAnnotation":
    return concat([ "?", path.call(print, "typeAnnotation") ]);
  case "NullLiteralTypeAnnotation":
    return fromString("null", options);
  case "ThisTypeAnnotation":
    return fromString("this", options);
  case "NumberTypeAnnotation":
    return fromString("number", options);
  case "ObjectTypeCallProperty":
    if (n.static) {
      parts.push("static ");
    }

    parts.push(path.call(print, "value"));

    return concat(parts);
  case "ObjectTypeIndexer":
    var variance = n.variance === "plus"
      ? "+"
      : n.variance === "minus" ? "-" : "";
    return concat([
      variance,
      "[",
      path.call(print, "id"),
      n.id ? ": " : "",
      path.call(print, "key"),
      "]: ",
      path.call(print, "value")
    ]);
  case "ObjectTypeProperty":
    var variance = n.variance === "plus"
      ? "+"
      : n.variance === "minus" ? "-" : "";
    // TODO: This is a bad hack and we need a better way to know
    // when to emit an arrow function or not.
    var isFunction = !n.variance && !n.optional &&
      n.value.type === "FunctionTypeAnnotation";
    return concat([
      n.static ? "static " : "",
      variance,
      path.call(print, "key"),
      n.optional ? "?" : "",
      isFunction ? "" : ": ",
      path.call(print, "value")
    ]);
  case "QualifiedTypeIdentifier":
    return concat([
      path.call(print, "qualification"),
      ".",
      path.call(print, "id")
    ]);
  case "StringLiteralTypeAnnotation":
    return fromString(nodeStr(n.value, options), options);
  case "NumberLiteralTypeAnnotation":
    assert.strictEqual(typeof n.value, "number");

    return fromString("" + n.value, options);
  case "StringTypeAnnotation":
    return fromString("string", options);
  case "DeclareTypeAlias":
  case "TypeAlias": {
      const parent = path.getParentNode(1);

      if (
        n.type === "DeclareTypeAlias" ||
          parent && parent.type === "DeclareModule"
      ) {
        parts.push("declare ");
      }

      parts.push(
        "type ",
        path.call(print, "id"),
        path.call(print, "typeParameters"),
        " = ",
        path.call(print, "right"),
        ";"
      );

      return concat(parts);
    }
  case "TypeCastExpression":
    return concat([
      "(",
      path.call(print, "expression"),
      path.call(print, "typeAnnotation"),
      ")"
    ]);
  case "TypeParameterDeclaration":
  case "TypeParameterInstantiation":
    return concat([ "<", join(", ", path.map(print, "params")), ">" ]);
  case "TypeParameter":
    switch (n.variance) {
    case "plus":
      parts.push("+");

      break;
    case "minus":
      parts.push("-");

      break;
    default:
    }

    parts.push(path.call(print, "name"));

    if (n.bound) {
      parts.push(path.call(print, "bound"));
    }

    if (n["default"]) {
      parts.push("=", path.call(print, "default"));
    }

    return concat(parts);
  case "TypeofTypeAnnotation":
    return concat([
      fromString("typeof ", options),
      path.call(print, "argument")
    ]);
  case "VoidTypeAnnotation":
    return "void";
  case "NullTypeAnnotation":
    return "null";
  case "InferredPredicate":
    return "%checks";
  // Unhandled types below. If encountered, nodes of these types should
  // be either left alone or desugared into AST types that are fully
  // supported by the pretty-printer.
  case "DeclaredPredicate":
    return concat([ "%checks(", path.call(print, "value"), ")" ]);
  // TODO
  case "ClassHeritage":
  // TODO
  case "ComprehensionBlock":
  // TODO
  case "ComprehensionExpression":
  // TODO
  case "Glob":
  // TODO
  case "GeneratorExpression":
  // TODO
  case "LetStatement":
  // TODO
  case "LetExpression":
  // TODO
  case "GraphExpression":
  // TODO
  // XML types that nobody cares about or needs to print.
  case "GraphIndexExpression":
  case "XMLDefaultDeclaration":
  case "XMLAnyName":
  case "XMLQualifiedIdentifier":
  case "XMLFunctionQualifiedIdentifier":
  case "XMLAttributeSelector":
  case "XMLFilterExpression":
  case "XML":
  case "XMLElement":
  case "XMLList":
  case "XMLEscape":
  case "XMLText":
  case "XMLStartTag":
  case "XMLEndTag":
  case "XMLPointTag":
  case "XMLName":
  case "XMLAttribute":
  case "XMLCdata":
  case "XMLComment":
  case "XMLProcessingInstruction":
  default:
    debugger;
    throw new Error("unknown type: " + JSON.stringify(n.type));
  }
  return p;
}

function printStatementSequence(path, options, print) {
  let printed = [];

  path.map(function(stmtPath, i) {
    var stmt = stmtPath.getValue();

    // Just in case the AST has been modified to contain falsy
    // "statements," it's safer simply to skip them.
    if (!stmt) {
      return;
    }

    // Skip printing EmptyStatement nodes to avoid leaving stray
    // semicolons lying around.
    if (stmt.type === "EmptyStatement") {
      return;
    }

    const stmtPrinted = print(stmtPath);
    const text = options.originalText;
    const parts = [];

    parts.push(stmtPrinted);

    if (util.newlineExistsAfter(text, util.locEnd(stmt)) &&
        !isLastStatement(stmtPath)) {
      parts.push(hardline);
    }

    printed.push(concat(parts));
  });

  return join(hardline, printed);
}

function printPropertyKey(path, print) {
  var node = path.getNode().key;
  if (node.type === "StringLiteral" && isIdentifierName(node.value)) {
    // 'a' -> a
    return node.value;
  }
  return path.call(print, "key");
}

function printMethod(path, options, print) {
  var node = path.getNode();
  var kind = node.kind;
  var parts = [];

  if (node.type === "ObjectMethod" || node.type === "ClassMethod") {
    node.value = node;
  } else {
    namedTypes.FunctionExpression.assert(node.value);
  }

  if (node.value.async) {
    parts.push("async ");
  }

  if (!kind || kind === "init" || kind === "method" || kind === "constructor") {
    if (node.value.generator) {
      parts.push("*");
    }
  } else {
    assert.ok(kind === "get" || kind === "set");

    parts.push(kind, " ");
  }

  var key = printPropertyKey(path, print);

  if (node.computed) {
    key = concat([ "[", key, "]" ]);
  }

  parts.push(
    key,
    path.call(print, "value", "typeParameters"),
    multilineGroup(concat([
      path.call(
        function(valuePath) {
          return printFunctionParams(valuePath, print, options);
        },
        "value"
      ),
      path.call(p => printReturnType(p, print), "value")
    ])),
    " ",
    path.call(print, "value", "body")
  );

  return concat(parts);
}

function printArgumentsList(path, options, print) {
  var printed = path.map(print, "arguments");
  var args;

  if (printed.length === 0) {
    return "()";
  }

  const lastArg = util.getLast(path.getValue().arguments);
  // This is just an optimization; I think we could return the
  // conditional group for all function calls, but it's more expensive
  // so only do it for specific forms.
  const groupLastArg = lastArg.type === "ObjectExpression" ||
    lastArg.type === "ArrayExpression" ||
    lastArg.type === "FunctionExpression" ||
    (lastArg.type === "ArrowFunctionExpression" &&
     (lastArg.body.type === "BlockStatement" ||
      lastArg.body.type === "ArrowFunctionExpression")) ||
    lastArg.type === "NewExpression";

  if (groupLastArg) {
    const shouldBreak = printed.slice(0, -1).some(hasHardLine);
    return conditionalGroup(
      [
        concat([ "(", join(concat([ ", " ]), printed), ")" ]),
        concat([
          "(",
          join(concat([ ",", line ]), printed.slice(0, -1)),
          printed.length > 1 ? ", " : "",
          group(util.getLast(printed), {shouldBreak: true}),
          ")"
        ]),
        group(
          concat([
            "(",
            indent(
              options.tabWidth,
              concat([ line, join(concat([ ",", line ]), printed) ])
            ),
            options.trailingComma ? "," : "",
            line,
            ")"
          ]),
          {shouldBreak: true}
        )
      ],
      {shouldBreak}
    );
  }

  return multilineGroup(
    concat([
      "(",
      indent(
        options.tabWidth,
        concat([ softline, join(concat([ ",", line ]), printed) ])
      ),
      ifBreak(options.trailingComma ? "," : ""),
      softline,
      ")"
    ])
  );
}

function printFunctionParams(path, print, options) {
  var fun = path.getValue();
  // namedTypes.Function.assert(fun);
  var printed = path.map(print, "params");

  if (fun.defaults) {
    path.each(
      function(defExprPath) {
        var i = defExprPath.getName();
        var p = printed[i];

        if (p && defExprPath.getValue()) {
          printed[i] = concat([ p, " = ", print(defExprPath) ]);
        }
      },
      "defaults"
    );
  }

  if (fun.rest) {
    printed.push(concat([ "...", path.call(print, "rest") ]));
  }

  return concat([
    "(",
    indent(
      options.tabWidth,
      concat([ softline, join(concat([ ",", line ]), printed) ])
    ),
    ifBreak(options.trailingComma ? "," : ""),
    softline,
    ")"
  ]);
}

function printObjectMethod(path, options, print) {
  var objMethod = path.getValue();
  var parts = [];

  if (objMethod.async)
    parts.push("async ");

  if (objMethod.generator)
    parts.push("*");

  if (
    objMethod.method || objMethod.kind === "get" || objMethod.kind === "set"
  ) {
    return printMethod(path, options, print);
  }

  var key = printPropertyKey(path, print);

  if (objMethod.computed) {
    parts.push("[", key, "]");
  } else {
    parts.push(key);
  }

  if (objMethod.typeParameters) {
    parts.push(path.call(print, "typeParameters"));
  }

  parts.push(
    multilineGroup(concat([
      printFunctionParams(path, print, options),
      printReturnType(path, print)
    ])),
    " ",
    path.call(print, "body")
  );

  return concat(parts);
}

function printReturnType(path, print) {
  const n = path.getValue();
  const parts = [ path.call(print, "returnType") ];

  if (n.predicate) {
    // The return type will already add the colon, but otherwise we
    // need to do it ourselves
    parts.push(n.returnType ? " " : ": ", path.call(print, "predicate"));
  }

  return concat(parts);
}

function printExportDeclaration(path, options, print) {
  var decl = path.getValue();
  var parts = [ "export " ];
  var shouldPrintSpaces = options.bracketSpacing;

  namedTypes.Declaration.assert(decl);

  if (decl["default"] || decl.type === "ExportDefaultDeclaration") {
    parts.push("default ");
  }

  if (decl.declaration) {
    parts.push(path.call(print, "declaration"));

    if (decl.type === "ExportDefaultDeclaration" && decl.declaration.type == "Identifier") {
      parts.push(";");
    }
  } else if (decl.specifiers && decl.specifiers.length > 0) {
    if (
      decl.specifiers.length === 1 &&
        decl.specifiers[0].type === "ExportBatchSpecifier"
    ) {
      parts.push("*");
    } else {
      parts.push(
        decl.exportKind === "type" ? "type " : "",
        group(concat([
          "{",
          indent(
            options.tabWidth,
            concat([
              options.bracketSpacing ? line : softline,
              join(concat([",", options.bracketSpacing ? line : softline]),
                   path.map(print, "specifiers"))
            ])
          ),
          options.bracketSpacing ? line : softline,
          "}"
        ]))
      );
    }

    if (decl.source) {
      parts.push(" from ", path.call(print, "source"));
    }

    parts.push(';');
  }

  return concat(parts);
}

function printFlowDeclaration(path, parts) {
  var parentExportDecl = util.getParentExportDeclaration(path);

  if (parentExportDecl) {
    assert.strictEqual(parentExportDecl.type, "DeclareExportDeclaration");
  } else {
    // If the parent node has type DeclareExportDeclaration, then it
    // will be responsible for printing the "declare" token. Otherwise
    // it needs to be printed with this non-exported declaration node.
    parts.unshift("declare ");
  }

  return concat(parts);
}

function printClass(path, print) {
  const n = path.getValue();
  const parts = [ "class" ];

  if (n.id) {
    parts.push(" ", path.call(print, "id"), path.call(print, "typeParameters"));
  }

  if (n.superClass) {
    parts.push(
      " extends ",
      path.call(print, "superClass"),
      path.call(print, "superTypeParameters")
    );
  } else if (n.extends && n.extends.length > 0) {
    parts.push(" extends ", join(", ", path.map(print, "extends")));
  }

  if (n["implements"] && n["implements"].length > 0) {
    parts.push(
      " implements ",
      join(", ", path.map(print, "implements"))
    );
  }

  parts.push(" ", path.call(print, "body"));

  return parts;
}

function printMemberLookup(path, print) {
  const property = path.call(print, "property");
  const n = path.getValue();
  return concat(n.computed ? [ "[", property, "]" ] : [ ".", property ]);
}

// We detect calls on member expressions specially to format a
// comman pattern better. The pattern we are looking for is this:
//
// arr
//   .map(x => x + 1)
//   .filter(x => x > 10)
//   .some(x => x % 2)
//
// where there is a "chain" of function calls on the result of
// previous expressions. We want to format them like above so they
// are consistently aligned.
//
// The way we do is by eagerly traversing the AST tree and
// re-shape it into a list of calls on member expressions. This
// lets us implement a heuristic easily for when we want to format
// it: if there are more than 1 calls on a member expression that
// pass in a function, we treat it like the above.
function printMemberChain(node, options, print) {
  const nodes = [];
  let curr = node;
  // Traverse down and gather up all of the calls on member
  // expressions. This flattens it out into a list that we can
  // easily analyze.
  while (curr.type === "CallExpression" &&
    curr.callee.type === "MemberExpression") {
    nodes.push({member: curr.callee, call: curr});
    curr = curr.callee.object;
  }
  nodes.reverse();

  // There are two kinds of formats we want to specialize: first,
  // if there are multiple calls on lookups we want to group them
  // together so they will all break at the same time. Second,
  // it's a chain if there 2 or more calls pass in functions and
  // we want to forcibly break all of the lookups onto new lines
  // and indent them.
  function argIsFunction(call) {
    if (call.arguments.length > 0) {
      const type = call.arguments[0].type;
      return type === "FunctionExpression" ||
        type === "ArrowFunctionExpression" ||
        type === "NewExpression";
    }
    return false;
  }
  const hasMultipleLookups = nodes.length > 1;
  const isChain = hasMultipleLookups &&
    nodes.filter(n => argIsFunction(n.call)).length > 1;

  if (hasMultipleLookups) {
    const currPrinted = print(FastPath.from(curr));
    const nodesPrinted = nodes.map(node => ({
      property: printMemberLookup(FastPath.from(node.member), print),
      args: printArgumentsList(FastPath.from(node.call), options, print)
    }));
    const fullyExpanded = concat([
      currPrinted,
      concat(
        nodesPrinted.map(node => {
          return indent(
            options.tabWidth,
            concat([ hardline, node.property, node.args ])
          );
        })
      )
    ]);

    // If it's a chain, force it to be fully expanded and print a
    // newline before each lookup. If we're not sure if it's a
    // chain (it *might* be printed on one line, but if gets too
    // long it will be printed as a chain), we need to use
    // `conditionalGroup` to describe both of these
    // representations. We cannot describe both at the same time
    // because the fully expanded form adds indentation, which
    // messes up anything with hard lines.
    if (isChain) {
      return fullyExpanded;
    } else {
      return conditionalGroup([
        concat([
          currPrinted,
          concat(
            nodesPrinted.map(node => {
              return concat([ node.property, node.args ]);
            })
          )
        ]),
        fullyExpanded
      ]);
    }
  }
}

function printJSXElement(path, options, print) {
  const n = path.getValue();
  var openingLines = path.call(print, "openingElement");

  let elem;
  if (n.openingElement.selfClosing) {
    assert.ok(!n.closingElement);

    elem = openingLines;
  } else {
    var children = [];

    path.map(
      function(childPath) {
        var child = childPath.getValue();

        if (
          namedTypes.Literal.check(child) && typeof child.value === "string"
        ) {
          if (/\S/.test(child.value)) {
            const beginBreak = child.value.match(/^\s*\n/);
            const endBreak = child.value.match(/\n\s*$/);
            const beginSpace = child.value.match(/^\s+/);
            const endSpace = child.value.match(/\s+$/);

            children.push(
              beginBreak ? hardline : "",
              beginSpace && !beginBreak ? "{' '}" : "",
              child.value.replace(/^\s+|\s+$/g, ""),
              endSpace && !endBreak ? "{' '}" : "",
              endBreak ? hardline : "",
            );
          } else if (/\n/.test(child.value)) {
            children.push(hardline);
          } else if (/\s/.test(child.value)) {
            children.push(ifBreak("{' '}"));
          }
        } else {
          children.push(print(childPath));
        }
      },
      "children"
    );

    var mostChildren = children.slice(0, -1);
    var closingLines = path.call(print, "closingElement");

    const firstChild = children[0];
    const lastChild = util.getLast(children);
    const beginBreak = firstChild && firstChild.type === "line";
    const endBreak = lastChild && lastChild.type === "line";

    elem = multilineGroup(concat([
      openingLines,
      indent(options.tabWidth, concat([ beginBreak ? "" : softline ].concat(mostChildren))),
      lastChild || "",
      endBreak ? "" : softline,
      closingLines,
    ]));
  }

  const parent = path.getParentNode();
  if (!parent || parent.type === "JSXElement" || parent.type === "ExpressionStatement") {
    return elem;
  }

  return multilineGroup(concat([
    ifBreak("("),
    indent(options.tabWidth, concat([ softline, elem ])),
    softline,
    ifBreak(")"),
  ]));
}

function adjustClause(clause, options, forceSpace) {
  if (isCurlyBracket(clause) || forceSpace) {
    return concat([ " ", clause ]);
  }

  return indent(options.tabWidth, concat([ hardline, clause ]));
}

function isCurlyBracket(doc) {
  const str = getFirstString(doc);
  return str === "{" || str === "{}";
}

function isEmptyBlock(doc) {
  const str = getFirstString(doc);
  return str === "{}";
}

function lastNonSpaceCharacter(lines) {
  var pos = lines.lastPos();
  do {
    var ch = lines.charAt(pos);

    if (/\S/.test(ch))
      return ch;
  } while (lines.prevPos(pos));
}

function swapQuotes(str) {
  return str.replace(/['"]/g, function(m) {
    return m === "\"" ? "'" : "\"";
  });
}

function nodeStr(str, options) {
  isString.assert(str);

  const containsSingleQuote = str.indexOf("'") !== -1;
  const containsDoubleQuote = str.indexOf('"') !== -1;

  let shouldUseSingleQuote = options.singleQuote;
  if (options.singleQuote && containsSingleQuote && !containsDoubleQuote) {
    shouldUseSingleQuote = false;
  }
  if (!options.singleQuote && !containsSingleQuote && containsDoubleQuote) {
    shouldUseSingleQuote = true;
  }

  if (shouldUseSingleQuote) {
    return swapQuotes(JSON.stringify(swapQuotes(str)));
  } else {
    return JSON.stringify(str);
  }
}

function isFirstStatement(path) {
  const parent = path.getParentNode();
  const node = path.getValue();
  const body = parent.body;
  return body && body[0] === node;
}

function isLastStatement(path) {
  const parent = path.getParentNode();
  const node = path.getValue();
  const body = parent.body;
  return body && body[body.length - 1] === node;
}
