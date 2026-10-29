package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"codetree/internal/analysis"
)

type Config struct {
	Root, DataDir, Origin, SupabaseURL, SupabaseKey   string
	AdminIDs                                          []string
	SecureCookies                                     bool
	GitHubClientID, GitHubClientSecret, GitHubAppSlug string
}
type Server struct {
	config      Config
	store       *FileStore
	sample      *Snapshot
	mux         *http.ServeMux
	client      *http.Client
	modelMu     sync.RWMutex
	models      []Model
	jobs        chan importTask
	cancelMu    sync.Mutex
	cancels     map[string]context.CancelFunc
	oauthMu     sync.Mutex
	oauth       map[string]oauthState
	chatMu      sync.Mutex
	activeChats map[string]bool
}
type oauthState struct {
	Workspace string
	Expires   time.Time
}
type importTask struct {
	Workspace, ID, URL, Branch string
	Context                    context.Context
}
type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string          { return e.Message }
func bad(status int, message string) error { return &apiError{status, message} }

func New(config Config) (*Server, error) {
	store, err := NewFileStore(config.DataDir)
	if err != nil {
		return nil, err
	}
	files, err := analysis.SampleFiles(config.Root)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	graph, err := analysis.Analyze(ctx, config.Root, "atlas-api", files)
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(files)
	digest := sha256.Sum256(raw)
	commit := fmt.Sprintf("%x", digest)[:40]
	sample := &Snapshot{ID: "sample-" + analysis.ID(commit + analysis.Version)[:12], AnalyzerVersion: analysis.Version, Repository: Repository{ID: "atlas-example", Name: "atlas-api", Owner: "examples", Description: "A small commerce API. A real, locally analyzed sample to explore before connecting your repository.", Branch: "main", Commit: commit, Branches: []string{"main"}, Sample: true, IndexedAt: time.Now().UTC()}, Graph: graph, Files: files}
	s := &Server{config: config, store: store, sample: sample, mux: http.NewServeMux(), client: &http.Client{Timeout: 20 * time.Second}, jobs: make(chan importTask, 16), cancels: map[string]context.CancelFunc{}, oauth: map[string]oauthState{}, activeChats: map[string]bool{}}
	if err := s.loadModels(); err != nil {
		return nil, err
	}
	s.routes()
	for i := 0; i < 2; i++ {
		go s.importWorker()
	}
	return s, nil
}
func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]string{"status": "ok", "version": "0.1.0"})
	})
	s.mux.HandleFunc("GET /api/v1/config", func(w http.ResponseWriter, r *http.Request) {
		mode := "local"
		if s.config.SupabaseURL != "" {
			mode = "supabase"
		}
		respond(w, 200, map[string]any{"authMode": mode, "supabaseUrl": s.config.SupabaseURL, "supabaseKey": s.config.SupabaseKey, "githubConfigured": s.config.GitHubClientID != "", "githubAppSlug": s.config.GitHubAppSlug, "storage": "local-file", "version": "0.1.0"})
	})
	s.mux.HandleFunc("GET /api/v1/github/callback", s.githubCallback)
	s.handle("GET /api/v1/session", s.session)
	s.handle("POST /api/v1/session/logout", s.logout)
	s.handle("GET /api/v1/repositories", s.repositories)
	s.handle("POST /api/v1/repositories", s.createImport)
	s.handle("GET /api/v1/imports/{id}", s.getImport)
	s.handle("POST /api/v1/imports/{id}/cancel", s.cancelImport)
	s.handle("GET /api/v1/snapshots/{id}", s.snapshot)
	s.handle("DELETE /api/v1/snapshots/{id}", s.deleteSnapshot)
	s.handle("GET /api/v1/models", s.listModels)
	s.handle("GET /api/v1/conversations", s.conversation)
	s.handle("DELETE /api/v1/conversations", s.clearConversation)
	s.handle("POST /api/v1/chat", s.chat)
	s.handle("GET /api/v1/admin/models", s.adminModels)
	s.handle("POST /api/v1/admin/models", s.saveModel)
	s.handle("DELETE /api/v1/admin/models/{id}", s.deleteModel)
	s.handle("POST /api/v1/admin/models/{id}/test", s.testModel)
	s.handle("POST /api/v1/github/connect", s.githubConnect)
	s.handle("DELETE /api/v1/github/connect", s.githubDisconnect)
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 404, map[string]string{"error": "API endpoint not found"})
	})
	dist := filepath.Join(s.config.Root, "apps/web/dist")
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		path := filepath.Join(dist, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			http.ServeFile(w, r, path)
			return
		}
		if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
			http.Error(w, "Frontend not built. Run npm run dev or npm run build.", 404)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
}
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			origin := r.Header.Get("Origin")
			if origin != "" && origin != s.config.Origin {
				respond(w, 403, map[string]string{"error": "Request origin is not allowed"})
				return
			}
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("request panic", "path", r.URL.Path, "error", recovered)
				respond(w, 500, map[string]string{"error": "Unexpected server error"})
			}
		}()
		s.mux.ServeHTTP(w, r)
	})
}

type endpoint func(http.ResponseWriter, *http.Request, Identity) error

func (s *Server) handle(pattern string, fn endpoint) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		identity, err := s.identity(w, r)
		if err == nil {
			err = fn(w, r, identity)
		}
		if err != nil {
			var known *apiError
			if errors.As(err, &known) {
				respond(w, known.Status, map[string]string{"error": known.Message})
			} else {
				slog.Error("request failed", "path", r.URL.Path, "error", err)
				respond(w, 500, map[string]string{"error": "The request could not be completed. Check the API log."})
			}
		}
	})
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func decode(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return bad(400, "Invalid request body")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return bad(400, "Expected one JSON request")
	}
	return nil
}
func (s *Server) identity(w http.ResponseWriter, r *http.Request) (Identity, error) {
	if s.config.SupabaseURL != "" {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			return Identity{}, bad(401, "Sign in to continue")
		}
		req, err := http.NewRequestWithContext(r.Context(), "GET", s.config.SupabaseURL+"/auth/v1/user", nil)
		if err != nil {
			return Identity{}, err
		}
		req.Header.Set("Authorization", auth)
		req.Header.Set("apikey", s.config.SupabaseKey)
		response, err := s.client.Do(req)
		if err != nil {
			return Identity{}, bad(503, "Authentication service is unavailable")
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return Identity{}, bad(401, "Your session expired. Please sign in again.")
		}
		var user struct {
			ID, Email string
			Metadata  map[string]any `json:"user_metadata"`
		}
		if err = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&user); err != nil || user.ID == "" {
			return Identity{}, bad(401, "Invalid authentication response")
		}
		admin := false
		for _, id := range s.config.AdminIDs {
			if strings.TrimSpace(id) == user.ID {
				admin = true
			}
		}
		name, _ := user.Metadata["full_name"].(string)
		if name == "" {
			name = strings.Split(user.Email, "@")[0]
		}
		return Identity{ID: analysis.ID("user:" + user.ID), Name: name, Email: user.Email, Admin: admin}, nil
	}
	var id string
	if cookie, err := r.Cookie("codetree_workspace"); err == nil {
		parts := strings.Split(cookie.Value, ".")
		if len(parts) == 2 {
			expected := s.sign(parts[0])
			if hmac.Equal([]byte(expected), []byte(parts[1])) {
				if raw, e := base64.RawURLEncoding.DecodeString(parts[0]); e == nil && len(raw) == 16 {
					id = parts[0]
				}
			}
		}
	}
	if id == "" {
		id = randomID()
		http.SetCookie(w, &http.Cookie{Name: "codetree_workspace", Value: id + "." + s.sign(id), Path: "/", HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: 365 * 24 * 60 * 60})
	}
	return Identity{ID: id, Name: "Local explorer", Admin: true, Local: true}, nil
}
func (s *Server) sign(value string) string {
	mac := hmac.New(sha256.New, s.store.key)
	mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (s *Server) ensureWorkspace(id string) (*Workspace, error) {
	workspace, err := s.store.Read(id)
	if err != nil {
		return nil, err
	}
	if workspace.Snapshots[s.sample.ID] == nil {
		if err = s.store.Update(id, func(w *Workspace) error {
			if w.Snapshots[s.sample.ID] == nil {
				w.Snapshots[s.sample.ID] = s.sample
			}
			return nil
		}); err != nil {
			return nil, err
		}
		return s.store.Read(id)
	}
	return workspace, nil
}
func (s *Server) session(w http.ResponseWriter, r *http.Request, id Identity) error {
	workspace, err := s.ensureWorkspace(id.ID)
	if err != nil {
		return err
	}
	respond(w, 200, map[string]any{"user": id, "workspaceId": id.ID, "githubLogin": workspace.GitHubLogin})
	return nil
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request, id Identity) error {
	http.SetCookie(w, &http.Cookie{Name: "codetree_workspace", Value: "", Path: "/", HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	respond(w, 200, map[string]bool{"ok": true})
	return nil
}
func (s *Server) repositories(w http.ResponseWriter, r *http.Request, id Identity) error {
	workspace, err := s.ensureWorkspace(id.ID)
	if err != nil {
		return err
	}
	result := []map[string]any{}
	for _, snapshot := range workspace.Snapshots {
		result = append(result, map[string]any{"id": snapshot.ID, "repository": snapshot.Repository, "nodeCount": len(snapshot.Graph.Nodes), "edgeCount": len(snapshot.Graph.Edges)})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i]["repository"].(Repository).IndexedAt.After(result[j]["repository"].(Repository).IndexedAt)
	})
	respond(w, 200, result)
	return nil
}
func (s *Server) getSnapshot(workspaceID, snapshotID string) (*Snapshot, error) {
	workspace, err := s.ensureWorkspace(workspaceID)
	if err != nil {
		return nil, err
	}
	snapshot := workspace.Snapshots[snapshotID]
	if snapshot == nil {
		return nil, bad(404, "Snapshot not found in this workspace")
	}
	if snapshot.Repository.Private {
		if workspace.GitHubToken == "" {
			return nil, bad(403, "Reconnect GitHub to access this private snapshot")
		}
		token, tokenErr := s.store.Open(workspace.GitHubToken)
		if tokenErr != nil {
			return nil, bad(403, "Reconnect GitHub to restore repository access")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		response, accessErr := githubRequest(ctx, "/repos/"+snapshot.Repository.Owner+"/"+snapshot.Repository.Name, token)
		if accessErr != nil {
			return nil, bad(403, "GitHub access could not be verified for this private repository. Reconnect or retry.")
		}
		response.Body.Close()
	}
	return snapshot, nil
}

func (s *Server) Close() {
	s.cancelMu.Lock()
	for _, cancel := range s.cancels {
		cancel()
	}
	s.cancelMu.Unlock()
	close(s.jobs)
}
func (s *Server) snapshot(w http.ResponseWriter, r *http.Request, id Identity) error {
	snapshot, err := s.getSnapshot(id.ID, r.PathValue("id"))
	if err != nil {
		return err
	}
	snapshot.Files = nil
	respond(w, 200, snapshot)
	return nil
}
func (s *Server) deleteSnapshot(w http.ResponseWriter, r *http.Request, id Identity) error {
	snapshotID := r.PathValue("id")
	err := s.store.Update(id.ID, func(ws *Workspace) error {
		if ws.Snapshots[snapshotID] == nil {
			return bad(404, "Snapshot not found")
		}
		delete(ws.Snapshots, snapshotID)
		for key := range ws.Conversations {
			if strings.HasPrefix(key, snapshotID+":") {
				delete(ws.Conversations, key)
			}
		}
		return nil
	})
	if err == nil {
		respond(w, 200, map[string]bool{"ok": true})
	}
	return err
}
func findNode(snapshot *Snapshot, id string) (*analysis.Node, error) {
	for i := range snapshot.Graph.Nodes {
		if snapshot.Graph.Nodes[i].ID == id {
			return &snapshot.Graph.Nodes[i], nil
		}
	}
	return nil, bad(404, "Node not found in this snapshot")
}
func (s *Server) conversation(w http.ResponseWriter, r *http.Request, id Identity) error {
	snapshot, err := s.getSnapshot(id.ID, r.URL.Query().Get("snapshotId"))
	if err != nil {
		return err
	}
	nodeID := r.URL.Query().Get("nodeId")
	if _, err = findNode(snapshot, nodeID); err != nil {
		return err
	}
	ws, err := s.store.Read(id.ID)
	if err != nil {
		return err
	}
	messages := ws.Conversations[snapshot.ID+":"+nodeID]
	if messages == nil {
		messages = []Message{}
	}
	respond(w, 200, messages)
	return nil
}
func (s *Server) clearConversation(w http.ResponseWriter, r *http.Request, id Identity) error {
	snapshot, err := s.getSnapshot(id.ID, r.URL.Query().Get("snapshotId"))
	if err != nil {
		return err
	}
	nodeID := r.URL.Query().Get("nodeId")
	if _, err = findNode(snapshot, nodeID); err != nil {
		return err
	}
	key := id.ID + ":" + snapshot.ID + ":" + nodeID
	s.chatMu.Lock()
	busy := s.activeChats[key]
	s.chatMu.Unlock()
	if busy {
		return bad(409, "Stop the current response before clearing this conversation")
	}
	err = s.store.Update(id.ID, func(ws *Workspace) error { delete(ws.Conversations, snapshot.ID+":"+nodeID); return nil })
	if err == nil {
		respond(w, 200, map[string]bool{"ok": true})
	}
	return err
}
func ValidateConfig(config Config, addr string) error {
	if (config.SupabaseURL == "") != (config.SupabaseKey == "") {
		return fmt.Errorf("set both SUPABASE_URL and SUPABASE_ANON_KEY")
	}
	if config.SupabaseURL == "" {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return err
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return fmt.Errorf("local auth mode requires a loopback bind address; configure Supabase before exposing the API")
		}
	}
	origin, err := url.Parse(config.Origin)
	if err != nil || origin.Host == "" || (origin.Scheme != "http" && origin.Scheme != "https") {
		return fmt.Errorf("CODETREE_ORIGIN must be a valid HTTP(S) origin")
	}
	return nil
}
