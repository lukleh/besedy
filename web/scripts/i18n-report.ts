import fs from "fs";
import path from "path";
import ts from "typescript";

type NamespaceBinding = string | null | "__dynamic__";

type UsedKey = {
  key: string;
  rawKey: string;
  namespace: NamespaceBinding;
  callee: string;
  file: string;
  line: number;
  column: number;
};

type DynamicKey = {
  rawKey: string;
  namespace: NamespaceBinding;
  callee: string;
  file: string;
  line: number;
  column: number;
};

type HardcodedString = {
  kind: "JSXText" | "JSXAttribute" | "ToastLiteral";
  text: string;
  file: string;
  line: number;
  column: number;
};

type Report = {
  locales: string[];
  messagesByLocale: Record<string, Record<string, string>>;
  usedKeys: UsedKey[];
  missingKeysByLocale: Record<string, string[]>;
  unusedKeysByLocale: Record<string, string[]>;
  dynamicKeys: DynamicKey[];
  hardcodedStrings: HardcodedString[];
};

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const [rawKey, inlineValue] = arg.slice(2).split("=");
  if (inlineValue !== undefined) {
    args.set(rawKey, inlineValue);
    continue;
  }
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(rawKey, next);
    i += 1;
  } else {
    args.set(rawKey, "true");
  }
}

const cwd = process.cwd();
const explicitSrc = args.has("src");
const explicitMessages = args.has("messages");
let srcDir = path.resolve(cwd, args.get("src") ?? "src");
let messagesDir = path.resolve(cwd, args.get("messages") ?? "messages");
const outPath = args.get("out") ? path.resolve(cwd, args.get("out") as string) : null;

if (!explicitSrc && !fs.existsSync(srcDir)) {
  const fallback = path.resolve(cwd, "web", "src");
  if (fs.existsSync(fallback)) {
    srcDir = fallback;
  }
}

if (!explicitMessages && !fs.existsSync(messagesDir)) {
  const fallback = path.resolve(cwd, "web", "messages");
  if (fs.existsSync(fallback)) {
    messagesDir = fallback;
  }
}
const printJson = args.get("json") === "true";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "out",
  "coverage",
  ".turbo",
  ".git",
]);

const ATTRIBUTE_NAMES = new Set([
  "title",
  "placeholder",
  "alt",
  "label",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-placeholder",
]);

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile()) {
        if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) {
          files.push(fullPath);
        }
      }
    }
  }

  return files;
}

function flattenMessages(
  value: unknown,
  prefix: string,
  out: Record<string, string>,
): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (prefix) {
      out[prefix] = String(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (prefix) {
      out[prefix] = JSON.stringify(value);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenMessages(child, nextPrefix, out);
    }
  }
}

function loadMessages(dir: string): { locales: string[]; messages: Record<string, Record<string, string>> } {
  if (!fs.existsSync(dir)) {
    throw new Error(`Messages directory not found: ${dir}`);
  }
  const entries = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  const locales: string[] = [];
  const messagesByLocale: Record<string, Record<string, string>> = {};

  for (const file of entries) {
    const locale = path.basename(file, ".json");
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const flattened: Record<string, string> = {};
    flattenMessages(parsed, "", flattened);
    locales.push(locale);
    messagesByLocale[locale] = flattened;
  }

  return { locales: locales.sort(), messages: messagesByLocale };
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.Unknown;
}

function getLineColumn(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function getStringLiteral(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function getPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

function extractNamespaceFromArgs(argsList: readonly ts.Expression[]): NamespaceBinding {
  if (argsList.length === 0) return null;
  const first = argsList[0];
  const literal = getStringLiteral(first);
  if (literal !== null) return literal;
  if (ts.isObjectLiteralExpression(first)) {
    for (const prop of first.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const propName = getPropertyName(prop.name);
      if (propName !== "namespace") continue;
      const valueLiteral = getStringLiteral(prop.initializer);
      if (valueLiteral !== null) return valueLiteral;
    }
    return "__dynamic__";
  }
  return "__dynamic__";
}

function isTranslationBindingCall(call: ts.CallExpression): boolean {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text === "useTranslations" || call.expression.text === "getTranslations";
  }
  return false;
}

function isToastCall(call: ts.CallExpression): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === "toast";
}

function getCalleeName(expr: ts.Expression): { base: string; method?: string } | null {
  if (ts.isIdentifier(expr)) {
    return { base: expr.text };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { base: expr.expression.text, method: expr.name.text };
  }
  return null;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shouldRecordText(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /[\p{L}\p{N}]/u.test(normalized);
}

function scanFile(filePath: string): {
  usedKeys: UsedKey[];
  dynamicKeys: DynamicKey[];
  hardcodedStrings: HardcodedString[];
} {
  const content = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
  const usedKeys: UsedKey[] = [];
  const dynamicKeys: DynamicKey[] = [];
  const hardcodedStrings: HardcodedString[] = [];
  const scopeStack: Array<Map<string, NamespaceBinding>> = [new Map()];

  function addBinding(name: string, namespace: NamespaceBinding): void {
    const scope = scopeStack[scopeStack.length - 1];
    scope.set(name, namespace);
  }

  function lookupBinding(name: string): NamespaceBinding | undefined {
    for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
      const scope = scopeStack[i];
      if (scope.has(name)) return scope.get(name);
    }
    return undefined;
  }

  function enterScope(): void {
    scopeStack.push(new Map());
  }

  function exitScope(): void {
    scopeStack.pop();
  }

  function recordUsedKey(
    key: string,
    rawKey: string,
    namespace: NamespaceBinding,
    callee: string,
    node: ts.Node,
  ): void {
    const location = getLineColumn(sourceFile, node);
    usedKeys.push({
      key,
      rawKey,
      namespace,
      callee,
      file: path.relative(cwd, filePath),
      line: location.line,
      column: location.column,
    });
  }

  function recordDynamicKey(rawKey: string, namespace: NamespaceBinding, callee: string, node: ts.Node): void {
    const location = getLineColumn(sourceFile, node);
    dynamicKeys.push({
      rawKey,
      namespace,
      callee,
      file: path.relative(cwd, filePath),
      line: location.line,
      column: location.column,
    });
  }

  function recordHardcoded(kind: HardcodedString["kind"], text: string, node: ts.Node): void {
    const normalized = normalizeText(text);
    if (!shouldRecordText(normalized)) return;
    const location = getLineColumn(sourceFile, node);
    hardcodedStrings.push({
      kind,
      text: normalized,
      file: path.relative(cwd, filePath),
      line: location.line,
      column: location.column,
    });
  }

  function unwrapCallExpression(expr: ts.Expression): ts.CallExpression | null {
    if (ts.isCallExpression(expr)) return expr;
    if (ts.isAwaitExpression(expr)) return unwrapCallExpression(expr.expression);
    return null;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isFunctionLike(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      enterScope();
      ts.forEachChild(node, visit);
      exitScope();
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const call = unwrapCallExpression(node.initializer);
      if (call && isTranslationBindingCall(call)) {
        const namespace = extractNamespaceFromArgs(call.arguments);
        addBinding(node.name.text, namespace);
      }
    }

    if (ts.isCallExpression(node)) {
      const calleeInfo = getCalleeName(node.expression);
      if (calleeInfo) {
        const namespace = lookupBinding(calleeInfo.base);
        if (namespace !== undefined) {
          const arg = node.arguments[0];
          const argLiteral = arg ? getStringLiteral(arg) : null;
          const calleeName = calleeInfo.method ? `${calleeInfo.base}.${calleeInfo.method}` : calleeInfo.base;
          if (argLiteral !== null && namespace !== "__dynamic__") {
            const fullKey = namespace ? `${namespace}.${argLiteral}` : argLiteral;
            recordUsedKey(fullKey, argLiteral, namespace, calleeName, node);
          } else if (arg) {
            recordDynamicKey(arg.getText(sourceFile), namespace ?? "__dynamic__", calleeName, node);
          }
        }
      }

      if (isToastCall(node)) {
        const [firstArg] = node.arguments;
        if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
          for (const prop of firstArg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const propName = getPropertyName(prop.name);
            if (!propName) continue;
            if (propName !== "title" && propName !== "description" && propName !== "label") continue;
            const literal = getStringLiteral(prop.initializer as ts.Expression);
            if (literal) {
              recordHardcoded("ToastLiteral", literal, prop);
            }
          }
        }
      }
    }

    if (ts.isJsxText(node)) {
      recordHardcoded("JSXText", node.getText(sourceFile), node);
    }

    if (ts.isJsxAttribute(node) && node.initializer) {
      // node.name can be Identifier or JsxNamespacedName - only Identifier has .text
      if (!ts.isIdentifier(node.name)) return;
      const attrName = node.name.text;
      if (ATTRIBUTE_NAMES.has(attrName)) {
        if (ts.isStringLiteral(node.initializer)) {
          recordHardcoded("JSXAttribute", node.initializer.text, node);
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const literal = getStringLiteral(node.initializer.expression);
          if (literal) {
            recordHardcoded("JSXAttribute", literal, node);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { usedKeys, dynamicKeys, hardcodedStrings };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function main(): void {
  const { locales, messages } = loadMessages(messagesDir);
  const files = listSourceFiles(srcDir);
  const usedKeys: UsedKey[] = [];
  const dynamicKeys: DynamicKey[] = [];
  const hardcodedStrings: HardcodedString[] = [];

  for (const file of files) {
    const result = scanFile(file);
    usedKeys.push(...result.usedKeys);
    dynamicKeys.push(...result.dynamicKeys);
    hardcodedStrings.push(...result.hardcodedStrings);
  }

  const usedKeySet = new Set(usedKeys.map((entry) => entry.key));
  const missingKeysByLocale: Record<string, string[]> = {};
  const unusedKeysByLocale: Record<string, string[]> = {};

  for (const locale of locales) {
    const localeKeys = new Set(Object.keys(messages[locale] ?? {}));
    const missing = Array.from(usedKeySet).filter((key) => !localeKeys.has(key));
    const unused = Array.from(localeKeys).filter((key) => !usedKeySet.has(key));
    missingKeysByLocale[locale] = missing.sort();
    unusedKeysByLocale[locale] = unused.sort();
  }

  const report: Report = {
    locales,
    messagesByLocale: messages,
    usedKeys,
    missingKeysByLocale,
    unusedKeysByLocale,
    dynamicKeys,
    hardcodedStrings,
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  }

  if (printJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const usedKeysSorted = uniqueSorted(Array.from(usedKeySet));
  console.log("i18n report");
  console.log(`locales: ${locales.join(", ")}`);
  for (const locale of locales) {
    console.log(`messages (${locale}): ${Object.keys(messages[locale] ?? {}).length} keys`);
  }
  console.log(`used keys: ${usedKeysSorted.length}`);
  console.log(`dynamic keys: ${dynamicKeys.length}`);
  console.log(`hardcoded strings: ${hardcodedStrings.length}`);

  for (const locale of locales) {
    const missing = missingKeysByLocale[locale] ?? [];
    const unused = unusedKeysByLocale[locale] ?? [];
    console.log(`missing keys (${locale}): ${missing.length}`);
    if (missing.length > 0) {
      console.log(`  sample: ${missing.slice(0, 10).join(", ")}`);
    }
    console.log(`unused keys (${locale}): ${unused.length}`);
    if (unused.length > 0) {
      console.log(`  sample: ${unused.slice(0, 10).join(", ")}`);
    }
  }

  if (outPath) {
    console.log(`report written to ${path.relative(cwd, outPath)}`);
  } else {
    console.log("tip: pass --out i18n-report.json to write the full report");
  }
}

main();
