package app

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"strings"
	"testing"
)

func TestRepositoryURLValidation(t *testing.T) {
	owner, name, err := parseRepositoryURL("https://github.com/acme/repository.git")
	if err != nil || owner != "acme" || name != "repository" {
		t.Fatalf("valid repo rejected: %v", err)
	}
	for _, raw := range []string{"http://github.com/a/b", "https://github.com.evil.example/a/b", "https://user@github.com/a/b", "https://github.com/a/b/tree/main", "file:///etc/passwd", "https://127.0.0.1/a/b", "https://github.com/a/..", "https://github.com/a/b?redirect=evil"} {
		if _, _, err := parseRepositoryURL(raw); err == nil {
			t.Errorf("accepted URL %s", raw)
		}
	}
}
func archiveBytes(t *testing.T, name, content string, kind byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(gz)
	size := int64(len(content))
	if kind != tar.TypeReg {
		size = 0
	}
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: size, Typeflag: kind, Linkname: "/etc/passwd"}); err != nil {
		t.Fatal(err)
	}
	if size > 0 {
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func TestArchiveSafetyAndLimits(t *testing.T) {
	tests := []struct {
		name, content string
		kind          byte
		want          int
		fail          bool
	}{
		{"root/src/index.ts", "export function main() {}", tar.TypeReg, 1, false},
		{"root/../../escape.ts", "bad", tar.TypeReg, 0, true},
		{"root/link.ts", "", tar.TypeSymlink, 0, false},
		{"root/node_modules/secret.ts", "ignored", tar.TypeReg, 0, false},
		{"root/binary.ts", "a\x00b", tar.TypeReg, 0, false},
		{"root/large.ts", strings.Repeat("a", 257*1024), tar.TypeReg, 0, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			files, err := readArchive(bytes.NewReader(archiveBytes(t, test.name, test.content, test.kind)))
			if (err != nil) != test.fail || err == nil && len(files) != test.want {
				t.Fatalf("files=%d err=%v", len(files), err)
			}
		})
	}
}
