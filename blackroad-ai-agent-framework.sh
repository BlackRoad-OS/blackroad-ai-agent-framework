#!/bin/bash
# ⬛⬜🛣️ BlackRoad AI Agent Framework CLI
# Self-orchestrating agents with Cloudflare Workers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="7.0.0"
API_BASE="${BLACKROAD_API_BASE:-http://localhost:8787}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Banner
show_banner() {
    echo -e "${MAGENTA}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  ⬛⬜🛣️  BlackRoad AI Agent Framework                         ║"
    echo "║  Self-orchestrating agents • Auto-healing • Repo-syncing    ║"
    echo "║  Version: $VERSION                                            ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# Help
show_help() {
    show_banner
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  dev           Start local development server"
    echo "  deploy        Deploy to Cloudflare Workers"
    echo "  setup         Initialize Cloudflare resources (KV, Queues, R2)"
    echo "  health        Check system health"
    echo "  status        Show agent status"
    echo "  agents        List all agents"
    echo "  jobs          List scheduled jobs"
    echo "  repos         List monitored repositories"
    echo "  sync          Trigger repository sync"
    echo "  cohesion      Get cohesion report"
    echo "  issues        List detected issues"
    echo "  resolve       Trigger resolution scan"
    echo "  logs          Tail worker logs"
    echo "  test          Run tests"
    echo "  help          Show this help"
    echo ""
    echo "Environment Variables:"
    echo "  BLACKROAD_API_BASE    API endpoint (default: http://localhost:8787)"
    echo "  GITHUB_TOKEN          GitHub API token for repo sync"
    echo "  ANTHROPIC_API_KEY     Anthropic API key for AI resolution"
    echo ""
    echo "Examples:"
    echo "  $0 dev                        # Start dev server"
    echo "  $0 sync blackroad-prism       # Sync specific repo"
    echo "  $0 cohesion                   # Get cohesion report"
}

# API helper
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    if [ -n "$data" ]; then
        curl -s -X "$method" "${API_BASE}${endpoint}" \
            -H "Content-Type: application/json" \
            -d "$data"
    else
        curl -s -X "$method" "${API_BASE}${endpoint}"
    fi
}

# Commands
cmd_dev() {
    echo -e "${CYAN}Starting development server...${NC}"
    cd "$SCRIPT_DIR"
    npm run dev
}

cmd_deploy() {
    local env="${1:-production}"
    echo -e "${CYAN}Deploying to Cloudflare Workers (${env})...${NC}"
    cd "$SCRIPT_DIR"

    if [ "$env" = "production" ]; then
        npm run deploy:prod
    elif [ "$env" = "staging" ]; then
        npm run deploy:staging
    else
        npm run deploy
    fi

    echo -e "${GREEN}✓ Deployment complete${NC}"
}

cmd_setup() {
    echo -e "${CYAN}Setting up Cloudflare resources...${NC}"
    cd "$SCRIPT_DIR"

    echo "Creating KV namespaces..."
    npm run kv:setup || true

    echo "Creating Queues..."
    npm run queue:setup || true

    echo "Creating R2 buckets..."
    npm run r2:setup || true

    echo "Running D1 migrations..."
    npm run db:migrate || true

    echo -e "${GREEN}✓ Setup complete${NC}"
}

cmd_health() {
    echo -e "${CYAN}Checking system health...${NC}"
    response=$(api_call GET "/api/health")

    status=$(echo "$response" | jq -r '.data.status // .status // "unknown"')

    if [ "$status" = "healthy" ]; then
        echo -e "${GREEN}✓ System is healthy${NC}"
    elif [ "$status" = "degraded" ]; then
        echo -e "${YELLOW}⚠ System is degraded${NC}"
    else
        echo -e "${RED}✗ System is unhealthy${NC}"
    fi

    echo "$response" | jq '.'
}

cmd_status() {
    echo -e "${CYAN}Getting agent status...${NC}"
    api_call GET "/api/agents/status" | jq '.'
}

cmd_agents() {
    echo -e "${CYAN}Listing agents...${NC}"
    api_call GET "/api/agents" | jq '.'
}

cmd_jobs() {
    echo -e "${CYAN}Listing scheduled jobs...${NC}"
    api_call GET "/api/jobs" | jq '.'
}

cmd_repos() {
    echo -e "${CYAN}Listing monitored repositories...${NC}"
    api_call GET "/api/repos/monitored" | jq '.'
}

cmd_sync() {
    local repo="$1"
    local sync_type="${2:-incremental}"

    if [ -z "$repo" ]; then
        echo -e "${CYAN}Syncing all repositories...${NC}"
        api_call POST "/api/repos/sync-all" "{\"syncType\": \"$sync_type\"}" | jq '.'
    else
        echo -e "${CYAN}Syncing repository: $repo...${NC}"
        api_call POST "/api/repos/sync" "{\"repo\": \"$repo\", \"syncType\": \"$sync_type\"}" | jq '.'
    fi
}

cmd_cohesion() {
    local action="${1:-report}"

    if [ "$action" = "analyze" ]; then
        echo -e "${CYAN}Running cohesion analysis...${NC}"
        api_call POST "/api/cohesion/analyze" | jq '.'
    elif [ "$action" = "scores" ]; then
        echo -e "${CYAN}Getting cohesion scores...${NC}"
        api_call GET "/api/cohesion/scores" | jq '.'
    elif [ "$action" = "drift" ]; then
        echo -e "${CYAN}Getting drift history...${NC}"
        api_call GET "/api/cohesion/drift" | jq '.'
    else
        echo -e "${CYAN}Getting latest cohesion report...${NC}"
        api_call GET "/api/cohesion" | jq '.'
    fi
}

cmd_issues() {
    echo -e "${CYAN}Listing detected issues...${NC}"
    api_call GET "/api/resolution/issues" | jq '.'
}

cmd_resolve() {
    echo -e "${CYAN}Triggering resolution scan...${NC}"
    api_call POST "/api/resolution/scan" | jq '.'
}

cmd_logs() {
    echo -e "${CYAN}Tailing worker logs...${NC}"
    cd "$SCRIPT_DIR"
    npm run tail
}

cmd_test() {
    echo -e "${CYAN}Running tests...${NC}"
    cd "$SCRIPT_DIR"
    npm test
}

# Main
main() {
    local command="${1:-help}"
    shift || true

    case "$command" in
        dev)
            cmd_dev "$@"
            ;;
        deploy)
            cmd_deploy "$@"
            ;;
        setup)
            cmd_setup "$@"
            ;;
        health)
            cmd_health "$@"
            ;;
        status)
            cmd_status "$@"
            ;;
        agents)
            cmd_agents "$@"
            ;;
        jobs)
            cmd_jobs "$@"
            ;;
        repos)
            cmd_repos "$@"
            ;;
        sync)
            cmd_sync "$@"
            ;;
        cohesion)
            cmd_cohesion "$@"
            ;;
        issues)
            cmd_issues "$@"
            ;;
        resolve)
            cmd_resolve "$@"
            ;;
        logs)
            cmd_logs "$@"
            ;;
        test)
            cmd_test "$@"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            echo -e "${RED}Unknown command: $command${NC}"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
