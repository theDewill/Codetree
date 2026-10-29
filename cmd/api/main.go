package main

import (
	"codetree/internal/app"
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func main() {
	root, err := os.Getwd()
	if err != nil {
		slog.Error("working directory unavailable", "error", err)
		os.Exit(1)
	}
	root = env("CODETREE_ROOT", root)
	addr := env("CODETREE_ADDR", "127.0.0.1:8090")
	config := app.Config{Root: root, DataDir: env("CODETREE_DATA_DIR", filepath.Join(root, ".data")), Origin: env("CODETREE_ORIGIN", "http://127.0.0.1:5173"), SupabaseURL: strings.TrimRight(os.Getenv("SUPABASE_URL"), "/"), SupabaseKey: os.Getenv("SUPABASE_ANON_KEY"), AdminIDs: strings.Split(os.Getenv("CODETREE_ADMIN_IDS"), ","), SecureCookies: os.Getenv("CODETREE_SECURE_COOKIES") == "true", GitHubClientID: os.Getenv("GITHUB_APP_CLIENT_ID"), GitHubClientSecret: os.Getenv("GITHUB_APP_CLIENT_SECRET"), GitHubAppSlug: os.Getenv("GITHUB_APP_SLUG")}
	if err = app.ValidateConfig(config, addr); err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	server, err := app.New(config)
	if err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
	defer server.Close()
	httpServer := &http.Server{Addr: addr, Handler: server.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16384}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	slog.Info("CodeTree API ready", "url", "http://"+addr, "auth", map[bool]string{true: "supabase", false: "local workspace"}[config.SupabaseURL != ""])
	if err = httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("API stopped", "error", err)
		os.Exit(1)
	}
}
