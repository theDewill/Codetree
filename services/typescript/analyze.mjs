import ts from 'typescript';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const fileID = filename => hash(`file:${filename}`);
const normalize = filename => path.posix.normalize(filename.replaceAll('\\', '/'));

/** Only reads the supplied virtual files. No tsconfig, plugins, installs or repo code execute. */
export function analyze(files) {
  const virtual = new Map(files.filter(f => /\.[cm]?[jt]sx?$/.test(f.path)).map(f => [`/source/${f.path}`, f.content]));
  const options = { allowJs: true, checkJs: true, noLib: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve };
  const host = {
    getSourceFile: (filename, languageVersion) => {
      const text = virtual.get(normalize(filename));
      return text === undefined ? undefined : ts.createSourceFile(filename, text, languageVersion, true);
    },
    getDefaultLibFileName: () => '/no-default-lib.d.ts',
    writeFile: () => {}, getCurrentDirectory: () => '/source',
    getDirectories: () => [], directoryExists: dir => [...virtual.keys()].some(f => f.startsWith(normalize(dir) + '/')),
    fileExists: filename => virtual.has(normalize(filename)),
    readFile: filename => virtual.get(normalize(filename)),
    getCanonicalFileName: filename => normalize(filename),
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  const checker = program.getTypeChecker();
  const nodes = [], edges = [], declarationNodes = new Map(), edgeKeys = new Set();
  let unresolvedCalls = 0;
  function edge(source, target, kind, file, line) {
    if (!source || !target || source === target && kind !== 'calls') return;
    const key = `${source}:${target}:${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: hash(key), source, target, kind, resolution: 'resolved', path: file, line });
  }
  function kindOf(node) {
    if (ts.isFunctionDeclaration(node) && node.name) return 'function';
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !ts.isVariableDeclaration(node.parent)) return 'function';
    if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) return 'method';
    if (ts.isClassDeclaration(node) && node.name) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isTypeAliasDeclaration(node)) return 'type';
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return 'function';
      if (ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) return 'constant';
    }
    return null;
  }
  for (const sourceFile of program.getSourceFiles()) {
    if (!virtual.has(sourceFile.fileName)) continue;
    const filename = sourceFile.fileName.slice('/source/'.length);
    function visit(node) {
      const kind = kindOf(node);
      if (kind) {
        const start = node.getStart(sourceFile), end = node.getEnd();
        const name = node.name?.getText(sourceFile) || `callback L${sourceFile.getLineAndCharacterOfPosition(start).line + 1}`;
        let parent = node.parent;
        while (parent && !declarationNodes.has(parent)) parent = parent.parent;
        const parentID = declarationNodes.get(parent)?.id || fileID(filename);
        const exported = Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) || Boolean(node.parent && ts.getCombinedModifierFlags(node.parent) & ts.ModifierFlags.Export);
        const full = node.getText(sourceFile);
        const bodyStart = node.body?.getStart(sourceFile);
        const signature = (bodyStart === undefined ? full.split('\n')[0] : sourceFile.text.slice(start, bodyStart)).trim().slice(0, 300);
        const jsdoc = ts.getJSDocCommentsAndTags(node).map(d => typeof d.comment === 'string' ? d.comment : '').filter(Boolean).join(' ');
        const entry = kind === 'function' && (/^(main|bootstrap|createServer|App)$/.test(name) || Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default));
        const record = {
          id: hash(`ts:${filename}:${kind}:${start}`), name, kind, path: filename,
          startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
          endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
          signature, description: jsdoc || `${kind[0].toUpperCase() + kind.slice(1)} declared in ${filename}.`,
          exported, entry, parentId: parentID, language: /\.[cm]?tsx?$/.test(filename) ? 'TypeScript' : 'JavaScript',
          source: full.slice(0, 20000),
        };
        nodes.push(record); declarationNodes.set(node, record);
        edge(parentID, record.id, 'contains', filename, record.startLine);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  function resolveNode(location) {
    let symbol = checker.getSymbolAtLocation(location);
    if (!symbol && ts.isPropertyAccessExpression(location)) symbol = checker.getSymbolAtLocation(location.name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol?.declarations || []) {
      const record = declarationNodes.get(declaration);
      if (record) return record;
    }
  }
  for (const sourceFile of program.getSourceFiles()) {
    if (!virtual.has(sourceFile.fileName)) continue;
    const filename = sourceFile.fileName.slice('/source/'.length);
    function visit(node) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = ts.resolveModuleName(node.moduleSpecifier.text, sourceFile.fileName, options, host).resolvedModule;
        if (resolved && virtual.has(resolved.resolvedFileName)) edge(fileID(filename), fileID(resolved.resolvedFileName.slice(8)), 'imports', filename, line);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        let owner = node.parent;
        while (owner && !declarationNodes.has(owner)) owner = owner.parent;
        const source = declarationNodes.get(owner)?.id || fileID(filename);
        const target = resolveNode(node.expression);
        if (target) edge(source, target.id, 'calls', filename, line);
        else unresolvedCalls++;
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isDeclarationName = parent.name === node && declarationNodes.has(parent);
        const isImport = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
        const callParent = ts.isPropertyAccessExpression(parent) ? parent.parent : parent;
        const isCallTarget = (ts.isCallExpression(callParent) || ts.isNewExpression(callParent)) && (callParent.expression === node || callParent.expression === parent);
        if (!isDeclarationName && !isImport && !isCallTarget) {
          let owner = node.parent;
          while (owner && !declarationNodes.has(owner)) owner = owner.parent;
          const source = declarationNodes.get(owner);
          const target = resolveNode(node);
          if (source && target && source.id !== target.id) edge(source.id, target.id, 'references', filename, line);
        }
      }
      if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)) {
        const source = declarationNodes.get(node.parent.parent);
        const target = resolveNode(node.expression);
        if (source && target) edge(source.id, target.id, node.parent.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends', filename, line);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  const syntaxErrors = program.getSyntacticDiagnostics().length;
  return { nodes, edges, diagnostics: [
    `${unresolvedCalls} external or dynamic call sites are not linked.`,
    ...(syntaxErrors ? [`${syntaxErrors} syntax diagnostics; affected files may have partial coverage.`] : []),
    'TypeScript semantic resolution uses repository-local imports; package dependencies and path aliases are not loaded.',
  ] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 12 * 1024 * 1024) throw new Error('Analysis input limit exceeded');
  }
  const { files } = JSON.parse(input);
  process.stdout.write(JSON.stringify(analyze(files)));
}
