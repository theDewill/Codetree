package analysis

import "testing"

func TestGoCallsRespectLocalShadowingAndPackageBoundaries(t *testing.T) {
	graph := analyzeGo([]File{
		{Path: "a/entry.go", Content: "package a\nfunc target() {}\nfunc main() { target(); main() }\nfunc shadowed() { target := func() {}; target() }\nfunc external()"},
		{Path: "b/entry.go", Content: "package b\nfunc target() {}\nfunc main() { target() }"},
	})
	names := map[string]Node{}
	for _, node := range graph.Nodes {
		names[node.Path+":"+node.Name] = node
	}
	main := names["a/entry.go:main"]
	target := names["a/entry.go:target"]
	shadowed := names["a/entry.go:shadowed"]
	foundCall, foundRecursion := false, false
	for _, edge := range graph.Edges {
		if edge.Kind != "calls" {
			continue
		}
		if edge.Source == main.ID && edge.Target == target.ID {
			foundCall = true
		}
		if edge.Source == main.ID && edge.Target == main.ID {
			foundRecursion = true
		}
		if edge.Source == shadowed.ID {
			t.Fatal("local shadowing produced a false package call")
		}
		if edge.Source == main.ID && edge.Target == names["b/entry.go:target"].ID {
			t.Fatal("call crossed a package boundary")
		}
	}
	if !foundCall || !foundRecursion {
		t.Fatalf("missing resolved calls: direct=%v recursion=%v", foundCall, foundRecursion)
	}
}
