package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *Server {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Config{Root: root, DataDir: t.TempDir(), Origin: "http://127.0.0.1:5173"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	return server
}
func request(t *testing.T, s *Server, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	if cookie != nil {
		req.AddCookie(cookie)
	}
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, req)
	return response
}
func localSession(t *testing.T, s *Server) (Identity, *http.Cookie) {
	t.Helper()
	response := request(t, s, "GET", "/api/v1/session", nil, nil)
	if response.Code != 200 {
		t.Fatalf("session: %s", response.Body.String())
	}
	var session struct {
		User Identity `json:"user"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	return session.User, response.Result().Cookies()[0]
}

func TestWorkspaceIsolationAndConversationPersistence(t *testing.T) {
	s := testApp(t)
	alice, aliceCookie := localSession(t, s)
	_, bobCookie := localSession(t, s)
	node := s.sample.Graph.Nodes[0]
	for _, candidate := range s.sample.Graph.Nodes {
		if candidate.Entry {
			node = candidate
			break
		}
	}
	response := request(t, s, "POST", "/api/v1/chat", map[string]any{"snapshotId": s.sample.ID, "nodeId": node.ID, "modelId": "local-guide", "message": "Explain this function"}, aliceCookie)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "event: done") {
		t.Fatalf("chat stream: %d %s", response.Code, response.Body.String())
	}
	query := "/api/v1/conversations?snapshotId=" + s.sample.ID + "&nodeId=" + node.ID
	response = request(t, s, "GET", query, nil, bobCookie)
	if strings.TrimSpace(response.Body.String()) != "[]" {
		t.Fatalf("another workspace saw messages: %s", response.Body.String())
	}
	response = request(t, s, "GET", query, nil, aliceCookie)
	var messages []Message
	if json.Unmarshal(response.Body.Bytes(), &messages) != nil || len(messages) != 2 {
		t.Fatalf("history was not saved: %s", response.Body.String())
	}
	other := *s.sample
	other.ID = "alice-only"
	if err := s.store.Update(alice.ID, func(ws *Workspace) error { ws.Snapshots[other.ID] = &other; return nil }); err != nil {
		t.Fatal(err)
	}
	response = request(t, s, "GET", "/api/v1/snapshots/alice-only", nil, bobCookie)
	if response.Code != 404 {
		t.Fatalf("cross-tenant snapshot returned %d", response.Code)
	}
	forged := *aliceCookie
	forged.Value = aliceCookie.Value + "tampered"
	response = request(t, s, "GET", "/api/v1/snapshots/alice-only", nil, &forged)
	if response.Code != 404 {
		t.Fatalf("tampered cookie returned %d", response.Code)
	}
	restored, err := NewFileStore(s.store.dir)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := restored.Read(alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ws.Conversations[s.sample.ID+":"+node.ID]) != 2 {
		t.Fatal("conversation did not survive store reopen")
	}
}

func TestDeveloperCredentialsAreEncryptedAndNeverReturned(t *testing.T) {
	s := testApp(t)
	input := `{"id":"","name":"Test model","provider":"openai-compatible","modelId":"test-model","baseUrl":"https://example.com/v1","keyEnv":"","apiKey":"disposable-test-secret","enabled":false,"contextLimit":8192}`
	req := httptest.NewRequest("POST", "/api/v1/admin/models", strings.NewReader(input))
	response := httptest.NewRecorder()
	if err := s.saveModel(response, req, Identity{ID: "developer", Admin: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(response.Body.String(), "disposable-test-secret") || strings.Contains(response.Body.String(), `"secret"`) {
		t.Fatal("API leaked credential")
	}
	raw, err := os.ReadFile(filepath.Join(s.store.dir, "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("disposable-test-secret")) {
		t.Fatal("plaintext credential was persisted")
	}
	key, err := s.modelKey(s.models[len(s.models)-1])
	if err != nil || key != "disposable-test-secret" {
		t.Fatal("credential round trip failed")
	}
	err = s.adminModels(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil), Identity{Admin: false})
	if failure, ok := err.(*apiError); !ok || failure.Status != 403 {
		t.Fatalf("non-admin access was not denied: %v", err)
	}
}

func TestUntrustedProfileCannotGrantDeveloperAccess(t *testing.T) {
	s := testApp(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer verified-token" {
			http.Error(w, "unauthorized", 401)
			return
		}
		respond(w, 200, map[string]any{"id": "real-user", "email": "user@example.com", "user_metadata": map[string]any{"admin": true, "role": "admin"}})
	}))
	defer provider.Close()
	s.config.SupabaseURL = provider.URL
	s.config.SupabaseKey = "public-test-key"
	req := httptest.NewRequest("GET", "/api/v1/admin/models", nil)
	req.Header.Set("Authorization", "Bearer verified-token")
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, req)
	if response.Code != 403 {
		t.Fatalf("editable metadata granted admin access: %d", response.Code)
	}
	response = request(t, s, "GET", "/api/v1/repositories", nil, nil)
	if response.Code != 401 {
		t.Fatalf("anonymous cloud request returned %d", response.Code)
	}
}

func TestRejectsCrossOriginMutationAndInvalidCodeRange(t *testing.T) {
	s := testApp(t)
	_, cookie := localSession(t, s)
	req := httptest.NewRequest("POST", "/api/v1/repositories", strings.NewReader(`{"url":"https://github.com/a/b"}`))
	req.AddCookie(cookie)
	req.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, req)
	if response.Code != 403 {
		t.Fatalf("cross-origin mutation returned %d", response.Code)
	}
	node := s.sample.Graph.Nodes[1]
	response = request(t, s, "POST", "/api/v1/chat", map[string]any{"snapshotId": s.sample.ID, "nodeId": node.ID, "modelId": "local-guide", "message": "test", "startLine": -1, "endLine": 999999}, cookie)
	if response.Code != 400 {
		t.Fatalf("out-of-range selection returned %d", response.Code)
	}
}

func TestModelEndpointsRejectInternalAddresses(t *testing.T) {
	for _, endpoint := range []string{"http://example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://10.0.0.2/v1", "https://example.com/v1?secret=abc", "https://user:password@example.com/v1"} {
		if validateModel(Model{Name: "model", Provider: "openai-compatible", ModelID: "test", BaseURL: endpoint, ContextLimit: 8192}) == nil {
			t.Errorf("accepted restricted endpoint: %s", endpoint)
		}
	}
}

func TestPrivateSnapshotsRequireAnActiveConnectionAndDailyQuotaIsEnforced(t *testing.T) {
	s := testApp(t)
	user, cookie := localSession(t, s)
	private := *s.sample
	private.ID = "private"
	private.Repository.Private = true
	if err := s.store.Update(user.ID, func(ws *Workspace) error {
		ws.Snapshots[private.ID] = &private
		ws.DailyRequests = map[string]int{time.Now().UTC().Format("2006-01-02"): 100}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	response := request(t, s, "GET", "/api/v1/snapshots/private", nil, cookie)
	if response.Code != 403 {
		t.Fatalf("disconnected private snapshot returned %d", response.Code)
	}
	s.models = append(s.models, Model{ID: "quota-test", Name: "Quota test", Provider: "openai", ModelID: "test", BaseURL: "https://example.com/v1", Enabled: true, ContextLimit: 8192})
	response = request(t, s, "POST", "/api/v1/chat", map[string]any{"snapshotId": s.sample.ID, "nodeId": s.sample.Graph.Nodes[1].ID, "modelId": "quota-test", "message": "Explain"}, cookie)
	if response.Code != 429 {
		t.Fatalf("paid request exceeded quota: %d %s", response.Code, response.Body.String())
	}
}
