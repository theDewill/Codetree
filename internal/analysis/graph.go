package analysis

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const Version = "0.1.1"

type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type Node struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Path        string `json:"path"`
	StartLine   int    `json:"startLine"`
	EndLine     int    `json:"endLine"`
	Signature   string `json:"signature"`
	Description string `json:"description"`
	Exported    bool   `json:"exported"`
	Entry       bool   `json:"entry"`
	ParentID    string `json:"parentId"`
	Language    string `json:"language"`
	Source      string `json:"source"`
}
type Edge struct {
	ID         string `json:"id"`
	Source     string `json:"source"`
	Target     string `json:"target"`
	Kind       string `json:"kind"`
	Resolution string `json:"resolution"`
	Path       string `json:"path"`
	Line       int    `json:"line"`
}
type Graph struct {
	Nodes       []Node   `json:"nodes"`
	Edges       []Edge   `json:"edges"`
	Diagnostics []string `json:"diagnostics"`
}

func ID(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])[:20]
}

func Language(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go":
		return "Go"
	case ".ts", ".tsx", ".mts", ".cts":
		return "TypeScript"
	case ".js", ".jsx", ".mjs", ".cjs":
		return "JavaScript"
	case ".py":
		return "Python"
	case ".md", ".mdx":
		return "Markdown"
	case ".json":
		return "JSON"
	default:
		return "Text"
	}
}

func Analyze(ctx context.Context, root, name string, files []File) (Graph, error) {
	graph := Graph{Nodes: []Node{}, Edges: []Edge{}, Diagnostics: []string{}}
	rootID := ID("repo:" + name)
	graph.Nodes = append(graph.Nodes, Node{ID: rootID, Name: name, Kind: "repository", Description: "Repository overview. Expand files and select a symbol to explore its source.", Language: "Repository"})
	hasTS := false
	unsupported := 0
	for _, f := range files {
		language := Language(f.Path)
		graph.Nodes = append(graph.Nodes, Node{ID: ID("file:" + f.Path), Name: filepath.Base(f.Path), Kind: "file", Path: f.Path, StartLine: 1, EndLine: strings.Count(f.Content, "\n") + 1, Description: "Source file in " + filepath.Dir(f.Path) + ".", ParentID: rootID, Language: language, Source: truncate(f.Content, 20000)})
		graph.Edges = append(graph.Edges, Edge{ID: ID(rootID + f.Path), Source: rootID, Target: ID("file:" + f.Path), Kind: "contains", Resolution: "resolved"})
		if language == "TypeScript" || language == "JavaScript" {
			hasTS = true
		} else if language != "Go" {
			unsupported++
		}
	}
	if hasTS {
		input, _ := json.Marshal(map[string]any{"files": files})
		nodePath, err := exec.LookPath("node")
		if err != nil {
			return graph, fmt.Errorf("TypeScript analyzer needs Node.js: %w", err)
		}
		command := exec.CommandContext(ctx, nodePath, "--max-old-space-size=384", filepath.Join(root, "services/typescript/analyze.mjs"))
		command.Dir = root
		// Only virtual source arrives on stdin; repository config and inherited service secrets are never loaded.
		command.Env = []string{"PATH=" + filepath.Dir(nodePath), "LANG=C.UTF-8"}
		command.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		output, err := command.Output()
		if err != nil {
			return graph, fmt.Errorf("TypeScript analysis failed; verify Node.js and npm dependencies are installed")
		}
		var result Graph
		if err := json.Unmarshal(output, &result); err != nil {
			return graph, fmt.Errorf("invalid analyzer response: %w", err)
		}
		graph.Nodes = append(graph.Nodes, result.Nodes...)
		graph.Edges = append(graph.Edges, result.Edges...)
		graph.Diagnostics = append(graph.Diagnostics, result.Diagnostics...)
	}
	goGraph := analyzeGo(files)
	graph.Nodes = append(graph.Nodes, goGraph.Nodes...)
	graph.Edges = append(graph.Edges, goGraph.Edges...)
	graph.Diagnostics = append(graph.Diagnostics, goGraph.Diagnostics...)
	if unsupported > 0 {
		graph.Diagnostics = append(graph.Diagnostics, fmt.Sprintf("%d files have file-level coverage only; symbol analysis currently supports Go and JS/TS.", unsupported))
	}
	if len(graph.Nodes) > 2500 {
		return graph, fmt.Errorf("repository exceeds the initial 2,500-node indexing limit; choose a smaller repository")
	}
	return graph, nil
}

func analyzeGo(files []File) Graph {
	graph := Graph{Nodes: []Node{}, Edges: []Edge{}, Diagnostics: []string{}}
	type parsed struct {
		file         File
		ast          *ast.File
		set          *token.FileSet
		declarations map[*ast.FuncDecl]string
	}
	var parsedFiles []parsed
	// Package-local direct calls are resolved with go/ast binding objects; selector calls remain unresolved.
	symbols := map[string]map[string][]string{}
	for _, f := range files {
		if Language(f.Path) != "Go" {
			continue
		}
		set := token.NewFileSet()
		syntax, err := parser.ParseFile(set, f.Path, f.Content, parser.ParseComments)
		if syntax == nil {
			graph.Diagnostics = append(graph.Diagnostics, "Could not parse "+f.Path)
			continue
		}
		if err != nil {
			graph.Diagnostics = append(graph.Diagnostics, "Partial syntax coverage in "+f.Path)
		}
		packageKey := filepath.Dir(f.Path) + ":" + syntax.Name.Name
		if symbols[packageKey] == nil {
			symbols[packageKey] = map[string][]string{}
		}
		record := parsed{file: f, ast: syntax, set: set, declarations: map[*ast.FuncDecl]string{}}
		add := func(name, kind string, start, end token.Pos, description string, exported, entry bool) string {
			startPos, endPos := set.Position(start), set.Position(end)
			source := f.Content[startPos.Offset:endPos.Offset]
			signature := strings.SplitN(source, "{", 2)[0]
			id := ID(fmt.Sprintf("go:%s:%s:%d", f.Path, kind, startPos.Offset))
			if description == "" {
				description = fmt.Sprintf("%s declared in %s.", strings.Title(kind), f.Path)
			}
			graph.Nodes = append(graph.Nodes, Node{ID: id, Name: name, Kind: kind, Path: f.Path, StartLine: startPos.Line, EndLine: endPos.Line, Signature: truncate(strings.TrimSpace(signature), 300), Description: strings.TrimSpace(description), Exported: exported, Entry: entry, ParentID: ID("file:" + f.Path), Language: "Go", Source: truncate(source, 20000)})
			graph.Edges = append(graph.Edges, Edge{ID: ID("contains:" + id), Source: ID("file:" + f.Path), Target: id, Kind: "contains", Resolution: "resolved", Path: f.Path, Line: startPos.Line})
			return id
		}
		for _, declaration := range syntax.Decls {
			switch d := declaration.(type) {
			case *ast.FuncDecl:
				kind, name := "function", d.Name.Name
				if d.Recv != nil {
					kind = "method"
				}
				id := add(name, kind, d.Pos(), d.End(), d.Doc.Text(), ast.IsExported(name), name == "main" || name == "init")
				record.declarations[d] = id
				if d.Recv == nil {
					symbols[packageKey][name] = append(symbols[packageKey][name], id)
				}
			case *ast.GenDecl:
				for _, spec := range d.Specs {
					switch s := spec.(type) {
					case *ast.TypeSpec:
						kind := "type"
						switch s.Type.(type) {
						case *ast.StructType:
							kind = "class"
						case *ast.InterfaceType:
							kind = "interface"
						}
						add(s.Name.Name, kind, s.Pos(), s.End(), d.Doc.Text(), ast.IsExported(s.Name.Name), false)
					case *ast.ValueSpec:
						for _, name := range s.Names {
							if name.Name != "_" {
								add(name.Name, "constant", s.Pos(), s.End(), d.Doc.Text(), ast.IsExported(name.Name), false)
							}
						}
					}
				}
			}
		}
		parsedFiles = append(parsedFiles, record)
	}
	edgeKeys := map[string]bool{}
	for _, p := range parsedFiles {
		packageKey := filepath.Dir(p.file.Path) + ":" + p.ast.Name.Name
		for declaration, sourceID := range p.declarations {
			if declaration.Body == nil {
				continue
			}
			ast.Inspect(declaration.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				ident, ok := call.Fun.(*ast.Ident)
				if !ok {
					return true
				}
				// A local binding shadows a package function; never guess a target from its name.
				if ident.Obj != nil {
					if _, ok := ident.Obj.Decl.(*ast.FuncDecl); !ok {
						return true
					}
				}
				candidates := symbols[packageKey][ident.Name]
				if len(candidates) != 1 {
					return true
				}
				key := sourceID + ":" + candidates[0]
				if !edgeKeys[key] {
					edgeKeys[key] = true
					graph.Edges = append(graph.Edges, Edge{ID: ID(key), Source: sourceID, Target: candidates[0], Kind: "calls", Resolution: "resolved", Path: p.file.Path, Line: p.set.Position(call.Pos()).Line})
				}
				return true
			})
		}
	}
	if len(parsedFiles) > 0 {
		graph.Diagnostics = append(graph.Diagnostics, "Go coverage includes declarations and unambiguous package-local direct calls. Selector calls, interfaces, build tags and dependency types are not yet resolved.")
	}
	return graph
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	for limit > 0 && (s[limit]&0xc0) == 0x80 {
		limit--
	}
	return s[:limit]
}

func SampleFiles(root string) ([]File, error) {
	var files []File
	dir := filepath.Join(root, "examples/atlas")
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(dir, path)
		files = append(files, File{Path: filepath.ToSlash(relative), Content: string(content)})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, err
}
