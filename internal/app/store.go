package app

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// FileStore is a single-process development store. The API does not expose its paths or tenant keys.
type FileStore struct {
	mu         sync.Mutex
	dir        string
	key        []byte
	workspaces map[string]*Workspace
}

func NewFileStore(dir string) (*FileStore, error) {
	if err := os.MkdirAll(filepath.Join(dir, "workspaces"), 0700); err != nil {
		return nil, err
	}
	keyPath := filepath.Join(dir, "server.key")
	key, err := os.ReadFile(keyPath)
	if os.IsNotExist(err) {
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		err = os.WriteFile(keyPath, key, 0600)
	}
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("invalid data store encryption key")
	}
	return &FileStore{dir: dir, key: key, workspaces: map[string]*Workspace{}}, nil
}
func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func (s *FileStore) load(id string) (*Workspace, error) {
	if w := s.workspaces[id]; w != nil {
		return w, nil
	}
	w := &Workspace{ID: id, Snapshots: map[string]*Snapshot{}, Conversations: map[string][]Message{}, Imports: map[string]*Import{}}
	raw, err := os.ReadFile(filepath.Join(s.dir, "workspaces", id+".json"))
	if err == nil {
		if err = json.Unmarshal(raw, w); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	for _, job := range w.Imports {
		if job.Status == "running" || job.Status == "queued" {
			job.Status = "failed"
			job.Error = "Import was interrupted by a server restart. Please retry."
		}
	}
	s.workspaces[id] = w
	return w, nil
}
func cloneWorkspace(w *Workspace) *Workspace {
	raw, _ := json.Marshal(w)
	var copy Workspace
	_ = json.Unmarshal(raw, &copy)
	return &copy
}
func (s *FileStore) Read(id string) (*Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, err := s.load(id)
	if err != nil {
		return nil, err
	}
	return cloneWorkspace(w), nil
}
func (s *FileStore) Update(id string, fn func(*Workspace) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.load(id)
	if err != nil {
		return err
	}
	next := cloneWorkspace(current)
	if err = fn(next); err != nil {
		return err
	}
	if err = s.write(filepath.Join("workspaces", id+".json"), next); err != nil {
		return err
	}
	s.workspaces[id] = next
	return nil
}
func (s *FileStore) write(name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, name)
	temp, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(raw)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}
func (s *FileStore) Seal(value string) (string, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(value), nil)), nil
}
func (s *FileStore) Open(value string) (string, error) {
	raw, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	block, _ := aes.NewCipher(s.key)
	gcm, _ := cipher.NewGCM(block)
	if len(raw) < gcm.NonceSize() {
		return "", fmt.Errorf("invalid encrypted credential")
	}
	text, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	return string(text), err
}
