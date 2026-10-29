package app

import (
	"codetree/internal/analysis"
	"time"
)

type Repository struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Owner       string    `json:"owner"`
	URL         string    `json:"url"`
	Description string    `json:"description"`
	Branch      string    `json:"branch"`
	Commit      string    `json:"commit"`
	Branches    []string  `json:"branches"`
	Sample      bool      `json:"sample"`
	Private     bool      `json:"private"`
	IndexedAt   time.Time `json:"indexedAt"`
}
type Snapshot struct {
	ID              string          `json:"id"`
	AnalyzerVersion string          `json:"analyzerVersion"`
	Repository      Repository      `json:"repository"`
	Graph           analysis.Graph  `json:"graph"`
	Files           []analysis.File `json:"files,omitempty"`
}
type Message struct {
	ID        string     `json:"id"`
	Role      string     `json:"role"`
	Content   string     `json:"content"`
	ModelID   string     `json:"modelId,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	Status    string     `json:"status,omitempty"`
	Sources   []Citation `json:"sources,omitempty"`
}
type Citation struct {
	NodeID    string `json:"nodeId"`
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Name      string `json:"name"`
}
type Import struct {
	ID         string    `json:"id"`
	URL        string    `json:"url"`
	Branch     string    `json:"branch"`
	Status     string    `json:"status"`
	Stage      string    `json:"stage"`
	Progress   int       `json:"progress"`
	SnapshotID string    `json:"snapshotId,omitempty"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}
type Workspace struct {
	ID            string               `json:"id"`
	Snapshots     map[string]*Snapshot `json:"snapshots"`
	Conversations map[string][]Message `json:"conversations"`
	Imports       map[string]*Import   `json:"imports"`
	DailyRequests map[string]int       `json:"dailyRequests,omitempty"`
	GitHubToken   string               `json:"githubToken,omitempty"`
	GitHubLogin   string               `json:"githubLogin,omitempty"`
}
type Model struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Provider     string `json:"provider"`
	ModelID      string `json:"modelId"`
	BaseURL      string `json:"baseUrl,omitempty"`
	KeyEnv       string `json:"keyEnv,omitempty"`
	Secret       string `json:"secret,omitempty"`
	Enabled      bool   `json:"enabled"`
	ContextLimit int    `json:"contextLimit"`
	Configured   bool   `json:"configured"`
}
type Identity struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
	Admin bool   `json:"admin"`
	Local bool   `json:"local"`
}
