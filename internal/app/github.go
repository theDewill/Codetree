package app

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"codetree/internal/analysis"
)

var githubPart = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func parseRepositoryURL(raw string) (string, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", bad(400, "Use a repository URL such as https://github.com/owner/repository")
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 2 {
		return "", "", bad(400, "Paste the repository root URL, without a file or branch path")
	}
	parts[1] = strings.TrimSuffix(parts[1], ".git")
	for _, part := range parts {
		if !githubPart.MatchString(part) || part == "." || part == ".." || len(part) > 100 {
			return "", "", bad(400, "Invalid GitHub owner or repository name")
		}
	}
	return parts[0], parts[1], nil
}
func githubClient() *http.Client {
	return &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 3 || req.URL.Scheme != "https" || (req.URL.Host != "codeload.github.com" && req.URL.Host != "api.github.com") {
			return fmt.Errorf("unexpected GitHub redirect")
		}
		return nil
	}}
}
func githubRequest(ctx context.Context, endpoint, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.github.com"+endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CodeTree/0.1")
	req.Header.Set("Accept", "application/vnd.github+json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := githubClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("GitHub could not be reached; check network access")
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		switch response.StatusCode {
		case 404:
			return nil, fmt.Errorf("Repository or branch not found. For private repositories, connect a GitHub App account with access first.")
		case 401:
			return nil, fmt.Errorf("GitHub authorization expired. Reconnect GitHub from settings.")
		case 403, 429:
			return nil, fmt.Errorf("GitHub denied this request or its rate limit was reached. Connect GitHub or retry later.")
		default:
			return nil, fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
		}
	}
	return response, nil
}
func githubJSON(ctx context.Context, endpoint, token string, result any) error {
	response, err := githubRequest(ctx, endpoint, token)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(result)
}
func (s *Server) importRepository(ctx context.Context, workspaceID, raw, branch string, progress func(int, string)) (*Snapshot, error) {
	owner, name, err := parseRepositoryURL(raw)
	if err != nil {
		return nil, err
	}
	ws, err := s.store.Read(workspaceID)
	if err != nil {
		return nil, err
	}
	token := ""
	if ws.GitHubToken != "" {
		token, err = s.store.Open(ws.GitHubToken)
		if err != nil {
			return nil, fmt.Errorf("Reconnect GitHub to restore repository access")
		}
	}
	progress(12, "Checking repository access")
	var metadata struct {
		Name, Description string
		Owner             struct{ Login string }
		DefaultBranch     string `json:"default_branch"`
		Private           bool
	}
	endpoint := "/repos/" + owner + "/" + name
	if err = githubJSON(ctx, endpoint, token, &metadata); err != nil {
		return nil, err
	}
	if metadata.Private && token == "" {
		return nil, fmt.Errorf("Connect GitHub before importing a private repository")
	}
	if branch == "" {
		branch = metadata.DefaultBranch
	}
	if len(branch) > 200 || strings.ContainsAny(branch, "\x00\r\n") {
		return nil, fmt.Errorf("Invalid branch name")
	}
	var commit struct {
		SHA string `json:"sha"`
	}
	if err = githubJSON(ctx, endpoint+"/commits/"+url.PathEscape(branch), token, &commit); err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^[a-f0-9]{40,64}$`).MatchString(commit.SHA) {
		return nil, fmt.Errorf("GitHub returned an invalid commit identity")
	}
	snapshotID := analysis.ID(owner + "/" + name + ":" + commit.SHA + ":" + branch + ":analyzer-" + analysis.Version)
	if existing := ws.Snapshots[snapshotID]; existing != nil {
		return existing, nil
	}
	branches := []string{branch}
	var list []struct{ Name string }
	if githubJSON(ctx, endpoint+"/branches?per_page=100", token, &list) == nil {
		branches = []string{}
		for _, item := range list {
			branches = append(branches, item.Name)
		}
		if !contains(branches, branch) {
			branches = append(branches, branch)
		}
	}
	progress(28, "Reading source at "+commit.SHA[:7])
	response, err := githubRequest(ctx, endpoint+"/tarball/"+commit.SHA, token)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	files, err := readArchive(response.Body)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("No supported source files were found in this repository")
	}
	progress(58, fmt.Sprintf("Analyzing %d source files", len(files)))
	graph, err := analysis.Analyze(ctx, s.config.Root, name, files)
	if err != nil {
		return nil, err
	}
	progress(90, "Connecting symbols and publishing graph")
	return &Snapshot{ID: snapshotID, AnalyzerVersion: analysis.Version, Repository: Repository{ID: analysis.ID(owner + "/" + name), Name: metadata.Name, Owner: metadata.Owner.Login, URL: "https://github.com/" + owner + "/" + name, Description: metadata.Description, Private: metadata.Private, Branch: branch, Commit: commit.SHA, Branches: branches, IndexedAt: time.Now().UTC()}, Graph: graph, Files: files}, nil
}
func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
func readArchive(reader io.Reader) ([]analysis.File, error) {
	compressed := &io.LimitedReader{R: reader, N: 16*1024*1024 + 1}
	gzipReader, err := gzip.NewReader(compressed)
	if err != nil {
		return nil, fmt.Errorf("GitHub source archive could not be read")
	}
	defer gzipReader.Close()
	uncompressed := &io.LimitedReader{R: gzipReader, N: 32*1024*1024 + 1}
	archive := tar.NewReader(uncompressed)
	files := []analysis.File{}
	total := 0
	entries := 0
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("Source archive is invalid or exceeds the 32 MB archive limit")
		}
		entries++
		if entries > 20000 {
			return nil, fmt.Errorf("Repository exceeds the initial archive entry limit")
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		parts := strings.Split(header.Name, "/")
		if len(parts) < 2 {
			continue
		}
		for _, part := range parts {
			if part == ".." {
				return nil, fmt.Errorf("Source archive contains an unsafe path")
			}
		}
		filename := strings.Join(parts[1:], "/")
		if !includeSource(filename) {
			continue
		}
		if header.Size > 256*1024 {
			return nil, fmt.Errorf("Source file %s exceeds the initial 256 KB file limit", filename)
		}
		if header.Size < 0 || total+int(header.Size) > 4*1024*1024 || len(files) >= 500 {
			return nil, fmt.Errorf("Repository exceeds the initial 500-file / 4 MB source limit. Try a smaller repository.")
		}
		content, err := io.ReadAll(io.LimitReader(archive, 256*1024+1))
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(content) || strings.ContainsRune(string(content), '\x00') {
			continue
		}
		files = append(files, analysis.File{Path: filename, Content: string(content)})
		total += len(content)
	}
	if compressed.N <= 0 || uncompressed.N <= 0 {
		return nil, fmt.Errorf("Repository archive exceeds the initial size limit")
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}
func includeSource(filename string) bool {
	parts := strings.Split(filename, "/")
	for _, part := range parts {
		switch part {
		case "node_modules", "vendor", "dist", "build", ".git", ".next", "coverage", "__pycache__", ".venv", "venv":
			return false
		}
	}
	name := path.Base(filename)
	if strings.HasPrefix(name, ".env") || strings.Contains(name, ".min.") || strings.HasSuffix(name, ".d.ts") || strings.HasSuffix(name, ".lock") || strings.HasSuffix(name, "-lock.json") {
		return false
	}
	switch strings.ToLower(path.Ext(filename)) {
	case ".go", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".md", ".json":
		return true
	}
	return false
}
func (s *Server) createImport(w http.ResponseWriter, r *http.Request, id Identity) error {
	var input struct {
		URL    string `json:"url"`
		Branch string `json:"branch"`
	}
	if err := decode(w, r, &input); err != nil {
		return err
	}
	if _, _, err := parseRepositoryURL(input.URL); err != nil {
		return err
	}
	job := &Import{ID: randomID(), URL: input.URL, Branch: input.Branch, Status: "queued", Stage: "Queued for analysis", Progress: 3, CreatedAt: time.Now().UTC()}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	err := s.store.Update(id.ID, func(ws *Workspace) error {
		active := 0
		for _, existing := range ws.Imports {
			if existing.Status == "queued" || existing.Status == "running" {
				active++
			}
		}
		if active >= 2 {
			return bad(429, "Two imports are already running in this workspace")
		}
		if len(ws.Snapshots) >= 12 {
			return bad(422, "This local workspace has reached its 12-snapshot limit. Remove a snapshot to import another.")
		}
		ws.Imports[job.ID] = job
		return nil
	})
	if err != nil {
		cancel()
		return err
	}
	s.cancelMu.Lock()
	s.cancels[job.ID] = cancel
	s.cancelMu.Unlock()
	select {
	case s.jobs <- importTask{Workspace: id.ID, ID: job.ID, URL: input.URL, Branch: input.Branch, Context: ctx}:
		respond(w, 202, job)
		return nil
	default:
		cancel()
		_ = s.store.Update(id.ID, func(ws *Workspace) error {
			ws.Imports[job.ID].Status = "failed"
			ws.Imports[job.ID].Error = "Import queue is full. Please retry."
			return nil
		})
		return bad(503, "Import queue is full. Please retry shortly.")
	}
}
func (s *Server) importWorker() {
	for task := range s.jobs {
		progress := func(percent int, stage string) {
			_ = s.store.Update(task.Workspace, func(ws *Workspace) error {
				job := ws.Imports[task.ID]
				job.Status = "running"
				job.Progress = percent
				job.Stage = stage
				return nil
			})
		}
		snapshot, err := s.importRepository(task.Context, task.Workspace, task.URL, task.Branch, progress)
		_ = s.store.Update(task.Workspace, func(ws *Workspace) error {
			job := ws.Imports[task.ID]
			if err != nil {
				job.Status = "failed"
				job.Error = err.Error()
				if task.Context.Err() == context.Canceled {
					job.Status = "cancelled"
					job.Error = "Import cancelled"
				}
				return nil
			}
			ws.Snapshots[snapshot.ID] = snapshot
			job.Status = "complete"
			job.Progress = 100
			job.Stage = "Your graph is ready"
			job.SnapshotID = snapshot.ID
			return nil
		})
		s.cancelMu.Lock()
		if cancel := s.cancels[task.ID]; cancel != nil {
			cancel()
		}
		delete(s.cancels, task.ID)
		s.cancelMu.Unlock()
	}
}
func (s *Server) getImport(w http.ResponseWriter, r *http.Request, id Identity) error {
	ws, err := s.store.Read(id.ID)
	if err != nil {
		return err
	}
	job := ws.Imports[r.PathValue("id")]
	if job == nil {
		return bad(404, "Import not found")
	}
	respond(w, 200, job)
	return nil
}
func (s *Server) cancelImport(w http.ResponseWriter, r *http.Request, id Identity) error {
	ws, err := s.store.Read(id.ID)
	if err != nil {
		return err
	}
	job := ws.Imports[r.PathValue("id")]
	if job == nil {
		return bad(404, "Import not found")
	}
	s.cancelMu.Lock()
	if cancel := s.cancels[job.ID]; cancel != nil {
		cancel()
	}
	s.cancelMu.Unlock()
	respond(w, 200, map[string]bool{"ok": true})
	return nil
}
func (s *Server) githubConnect(w http.ResponseWriter, r *http.Request, id Identity) error {
	if s.config.GitHubClientID == "" || s.config.GitHubClientSecret == "" {
		return bad(422, "Configure a GitHub App client ID and secret in the API environment first")
	}
	state := randomID()
	s.oauthMu.Lock()
	for key, value := range s.oauth {
		if time.Now().After(value.Expires) {
			delete(s.oauth, key)
		}
	}
	s.oauth[state] = oauthState{Workspace: id.ID, Expires: time.Now().Add(10 * time.Minute)}
	s.oauthMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "codetree_github_state", Value: state, Path: "/api/v1/github", HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	values := url.Values{"client_id": {s.config.GitHubClientID}, "redirect_uri": {s.config.Origin + "/api/v1/github/callback"}, "state": {state}}
	respond(w, 200, map[string]string{"url": "https://github.com/login/oauth/authorize?" + values.Encode()})
	return nil
}
func (s *Server) githubCallback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	cookie, err := r.Cookie("codetree_github_state")
	if err != nil || cookie.Value != state || state == "" {
		http.Error(w, "GitHub connection state is invalid. Retry from CodeTree.", 400)
		return
	}
	s.oauthMu.Lock()
	pending, ok := s.oauth[state]
	delete(s.oauth, state)
	s.oauthMu.Unlock()
	if !ok || time.Now().After(pending.Expires) {
		http.Error(w, "GitHub connection expired. Retry from CodeTree.", 400)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "codetree_github_state", Value: "", Path: "/api/v1/github", HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	failure := func() { http.Redirect(w, r, s.config.Origin+"/?github=error", http.StatusSeeOther) }
	code := r.URL.Query().Get("code")
	if code == "" {
		failure()
		return
	}
	values := url.Values{"client_id": {s.config.GitHubClientID}, "client_secret": {s.config.GitHubClientSecret}, "code": {code}, "redirect_uri": {s.config.Origin + "/api/v1/github/callback"}}
	req, _ := http.NewRequestWithContext(r.Context(), "POST", "https://github.com/login/oauth/access_token", strings.NewReader(values.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	response, err := s.client.Do(req)
	if err != nil {
		failure()
		return
	}
	defer response.Body.Close()
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&token) != nil || token.AccessToken == "" {
		failure()
		return
	}
	var user struct{ Login string }
	if githubJSON(r.Context(), "/user", token.AccessToken, &user) != nil {
		failure()
		return
	}
	encrypted, err := s.store.Seal(token.AccessToken)
	if err != nil {
		failure()
		return
	}
	if s.store.Update(pending.Workspace, func(ws *Workspace) error { ws.GitHubToken = encrypted; ws.GitHubLogin = user.Login; return nil }) != nil {
		failure()
		return
	}
	http.Redirect(w, r, s.config.Origin+"/?github=connected", http.StatusSeeOther)
}
func (s *Server) githubDisconnect(w http.ResponseWriter, r *http.Request, id Identity) error {
	err := s.store.Update(id.ID, func(ws *Workspace) error { ws.GitHubToken = ""; ws.GitHubLogin = ""; return nil })
	if err == nil {
		respond(w, 200, map[string]bool{"ok": true})
	}
	return err
}
