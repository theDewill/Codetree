package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func (s *Server) loadModels() error {
	s.models = []Model{{ID: "local-guide", Name: "Source guide", Provider: "local", ModelID: "structural-guide", Enabled: true, Configured: true, ContextLimit: 16000}}
	raw, err := os.ReadFile(filepath.Join(s.store.dir, "models.json"))
	if err == nil {
		if err = json.Unmarshal(raw, &s.models); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if os.Getenv("CODETREE_MODEL_ID") != "" {
		found := false
		for _, model := range s.models {
			if model.ID == "environment-model" {
				found = true
			}
		}
		if !found {
			name := os.Getenv("CODETREE_MODEL_NAME")
			if name == "" {
				name = os.Getenv("CODETREE_MODEL_ID")
			}
			base := os.Getenv("CODETREE_MODEL_BASE_URL")
			if base == "" {
				base = "https://api.openai.com/v1"
			}
			provider := "openai-compatible"
			if strings.HasPrefix(base, "https://api.openai.com/") {
				provider = "openai"
			}
			s.models = append(s.models, Model{ID: "environment-model", Name: name, Provider: provider, ModelID: os.Getenv("CODETREE_MODEL_ID"), BaseURL: base, KeyEnv: "CODETREE_MODEL_API_KEY", Enabled: true, ContextLimit: 32000})
		}
	}
	return nil
}
func (s *Server) modelKey(model Model) (string, error) {
	if model.Secret != "" {
		return s.store.Open(model.Secret)
	}
	return os.Getenv(model.KeyEnv), nil
}
func (s *Server) publicModel(model Model, admin bool) Model {
	key, _ := s.modelKey(model)
	model.Configured = model.Provider == "local" || key != ""
	model.Secret = ""
	if !admin {
		model.KeyEnv = ""
		model.BaseURL = ""
	}
	return model
}
func (s *Server) listModels(w http.ResponseWriter, r *http.Request, id Identity) error {
	s.modelMu.RLock()
	defer s.modelMu.RUnlock()
	result := []Model{}
	for _, model := range s.models {
		if model.Enabled {
			result = append(result, s.publicModel(model, false))
		}
	}
	respond(w, 200, result)
	return nil
}
func (s *Server) adminModels(w http.ResponseWriter, r *http.Request, id Identity) error {
	if !id.Admin {
		return bad(403, "Developer access is required")
	}
	s.modelMu.RLock()
	defer s.modelMu.RUnlock()
	result := []Model{}
	for _, model := range s.models {
		result = append(result, s.publicModel(model, true))
	}
	respond(w, 200, result)
	return nil
}
func validateModel(model Model) error {
	if strings.TrimSpace(model.Name) == "" || len(model.Name) > 80 || model.ModelID == "" || len(model.ModelID) > 160 {
		return bad(400, "Enter a display name and provider model ID")
	}
	if model.Provider != "openai" && model.Provider != "openai-compatible" {
		return bad(400, "Choose a supported provider adapter")
	}
	parsed, err := url.Parse(model.BaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return bad(400, "Provider URL must be an HTTPS base URL without credentials, query parameters or fragments")
	}
	host := strings.ToLower(parsed.Hostname())
	ip := net.ParseIP(host)
	if host == "localhost" || strings.HasSuffix(host, ".local") || ip != nil && !publicIP(ip) {
		return bad(400, "Provider endpoints must use a public HTTPS address")
	}
	if model.KeyEnv != "" && !regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,80}_API_KEY$`).MatchString(model.KeyEnv) {
		return bad(400, "Environment references must be uppercase names ending in _API_KEY")
	}
	if model.ContextLimit < 4096 || model.ContextLimit > 1000000 {
		return bad(400, "Context limit must be between 4,096 and 1,000,000 tokens")
	}
	return nil
}
func (s *Server) saveModel(w http.ResponseWriter, r *http.Request, id Identity) error {
	if !id.Admin {
		return bad(403, "Developer access is required")
	}
	var input struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Provider     string `json:"provider"`
		ModelID      string `json:"modelId"`
		BaseURL      string `json:"baseUrl"`
		KeyEnv       string `json:"keyEnv"`
		APIKey       string `json:"apiKey"`
		Enabled      bool   `json:"enabled"`
		ContextLimit int    `json:"contextLimit"`
	}
	if err := decode(w, r, &input); err != nil {
		return err
	}
	if input.ID == "local-guide" {
		return bad(400, "The built-in source guide cannot be changed")
	}
	model := Model{ID: input.ID, Name: strings.TrimSpace(input.Name), Provider: input.Provider, ModelID: strings.TrimSpace(input.ModelID), BaseURL: strings.TrimRight(input.BaseURL, "/"), KeyEnv: input.KeyEnv, Enabled: input.Enabled, ContextLimit: input.ContextLimit}
	if err := validateModel(model); err != nil {
		return err
	}
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	previous := append([]Model{}, s.models...)
	found := -1
	for i, existing := range s.models {
		if existing.ID == model.ID && model.ID != "" {
			found = i
			model.Secret = existing.Secret
		}
	}
	if model.ID != "" && found < 0 {
		return bad(404, "Model not found")
	}
	if input.APIKey != "" {
		encrypted, err := s.store.Seal(strings.TrimSpace(input.APIKey))
		if err != nil {
			return err
		}
		model.Secret = encrypted
		model.KeyEnv = ""
	}
	if input.APIKey == "" && input.KeyEnv != "" {
		model.Secret = ""
	}
	if model.Enabled {
		key, err := s.modelKey(model)
		if err != nil || key == "" {
			return bad(400, "An enabled model needs an API key or a configured environment variable")
		}
	}
	if found >= 0 {
		s.models[found] = model
	} else {
		model.ID = randomID()
		s.models = append(s.models, model)
	}
	if err := s.store.write("models.json", s.models); err != nil {
		s.models = previous
		return err
	}
	s.audit(id.ID, "model.saved", model.ID)
	respond(w, 200, s.publicModel(model, true))
	return nil
}
func (s *Server) deleteModel(w http.ResponseWriter, r *http.Request, id Identity) error {
	if !id.Admin {
		return bad(403, "Developer access is required")
	}
	modelID := r.PathValue("id")
	if modelID == "local-guide" {
		return bad(400, "The built-in source guide cannot be deleted")
	}
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	next := []Model{}
	found := false
	for _, model := range s.models {
		if model.ID == modelID {
			found = true
		} else {
			next = append(next, model)
		}
	}
	if !found {
		return bad(404, "Model not found")
	}
	if err := s.store.write("models.json", next); err != nil {
		return err
	}
	s.models = next
	s.audit(id.ID, "model.deleted", modelID)
	respond(w, 200, map[string]bool{"ok": true})
	return nil
}
func (s *Server) getModel(id string) (Model, error) {
	s.modelMu.RLock()
	defer s.modelMu.RUnlock()
	for _, model := range s.models {
		if model.ID == id {
			return model, nil
		}
	}
	return Model{}, bad(404, "Model not found")
}
func (s *Server) testModel(w http.ResponseWriter, r *http.Request, id Identity) error {
	if !id.Admin {
		return bad(403, "Developer access is required")
	}
	model, err := s.getModel(r.PathValue("id"))
	if err != nil {
		return err
	}
	if model.Provider == "local" {
		respond(w, 200, map[string]string{"message": "Source guide is ready. It uses local structural analysis, not an LLM."})
		return nil
	}
	response, err := s.providerRequest(r.Context(), model, []map[string]string{{"role": "user", "content": "Reply with OK."}}, false, 16)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return bad(502, fmt.Sprintf("Provider returned HTTP %d. Check the model ID, API key and endpoint.", response.StatusCode))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 65536))
	respond(w, 200, map[string]string{"message": "Provider connection succeeded."})
	return nil
}
func publicIP(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast()
}
func providerClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 45 * time.Second, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, address := range addresses {
			if !publicIP(address.IP) {
				return nil, fmt.Errorf("provider resolved to a restricted address")
			}
		}
		for _, address := range addresses {
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
			if err == nil {
				return connection, nil
			}
		}
		return nil, fmt.Errorf("provider could not be reached")
	}}
	return &http.Client{Transport: transport, Timeout: 120 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return fmt.Errorf("provider redirects are not allowed")
	}}
}
func (s *Server) providerRequest(ctx context.Context, model Model, messages []map[string]string, stream bool, maxTokens int) (*http.Response, error) {
	if err := validateModel(model); err != nil {
		return nil, err
	}
	key, err := s.modelKey(model)
	if err != nil || key == "" {
		return nil, bad(422, "This model needs a provider API key. Configure it in developer settings.")
	}
	body := map[string]any{"model": model.ModelID, "messages": messages, "stream": stream}
	if model.Provider == "openai" {
		body["max_completion_tokens"] = maxTokens
	} else {
		body["max_tokens"] = maxTokens
	}
	raw, _ := json.Marshal(body)
	request, err := http.NewRequestWithContext(ctx, "POST", model.BaseURL+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	response, err := providerClient().Do(request)
	if err != nil {
		return nil, bad(502, "Could not reach the model provider. Check its endpoint and availability.")
	}
	return response, nil
}
func (s *Server) audit(actor, action, target string) {
	file, err := os.OpenFile(filepath.Join(s.store.dir, "audit.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer file.Close()
	_ = json.NewEncoder(file).Encode(map[string]any{"actor": actor, "action": action, "target": target, "at": time.Now().UTC()})
}
