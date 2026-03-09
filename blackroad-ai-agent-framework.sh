#!/bin/bash
# BlackRoad AI Agent Framework
# Sovereign AI agent orchestration framework

set -e

VERSION="0.1.0"
SCRIPT_NAME=$(basename "$0")
AGENTS_DIR="${BLACKROAD_AGENTS_DIR:-$HOME/.blackroad/agents}"
CONFIG_DIR="${BLACKROAD_CONFIG_DIR:-$HOME/.blackroad}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

print_banner() {
    echo -e "${MAGENTA}BlackRoad AI Agent Framework${NC} v${VERSION}"
    echo "Sovereign AI agent orchestration"
}

print_help() {
    print_banner
    echo ""
    echo "Usage: $SCRIPT_NAME <command> [options]"
    echo ""
    echo "Commands:"
    echo "  init                  Initialize the framework"
    echo "  create <name>         Create a new agent"
    echo "  list                  List all agents"
    echo "  start <name>          Start an agent"
    echo "  stop <name>           Stop an agent"
    echo "  start-swarm           Start all agents"
    echo "  stop-swarm            Stop all agents"
    echo "  status [name]         Show status of agent(s)"
    echo "  version               Show version information"
    echo "  help                  Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  BLACKROAD_AGENTS_DIR  Directory for agent data (default: ~/.blackroad/agents)"
    echo "  BLACKROAD_CONFIG_DIR  Directory for configuration (default: ~/.blackroad)"
    echo ""
    echo "Examples:"
    echo "  $SCRIPT_NAME init"
    echo "  $SCRIPT_NAME create my-agent"
    echo "  $SCRIPT_NAME start-swarm"
}

cmd_init() {
    echo -e "${BLUE}Initializing BlackRoad AI Agent Framework...${NC}"

    if [ -d "$CONFIG_DIR" ]; then
        echo -e "${YELLOW}Configuration directory already exists: $CONFIG_DIR${NC}"
    else
        mkdir -p "$CONFIG_DIR"
        echo -e "${GREEN}Created configuration directory: $CONFIG_DIR${NC}"
    fi

    if [ -d "$AGENTS_DIR" ]; then
        echo -e "${YELLOW}Agents directory already exists: $AGENTS_DIR${NC}"
    else
        mkdir -p "$AGENTS_DIR"
        echo -e "${GREEN}Created agents directory: $AGENTS_DIR${NC}"
    fi

    # Create default configuration if it doesn't exist
    local config_file="$CONFIG_DIR/config.json"
    if [ ! -f "$config_file" ]; then
        cat > "$config_file" << 'EOF'
{
    "version": "0.1.0",
    "default_model": "ollama/llama2",
    "agents_dir": "~/.blackroad/agents",
    "log_level": "info"
}
EOF
        echo -e "${GREEN}Created default configuration: $config_file${NC}"
    fi

    echo -e "${GREEN}Framework initialized successfully!${NC}"
}

cmd_create() {
    local agent_name="$1"

    if [ -z "$agent_name" ]; then
        echo -e "${RED}Error: Agent name required${NC}"
        echo "Usage: $SCRIPT_NAME create <name>"
        exit 1
    fi

    local agent_dir="$AGENTS_DIR/$agent_name"

    if [ -d "$agent_dir" ]; then
        echo -e "${RED}Error: Agent '$agent_name' already exists${NC}"
        exit 1
    fi

    echo -e "${BLUE}Creating agent: $agent_name${NC}"

    mkdir -p "$agent_dir"

    # Create agent configuration
    cat > "$agent_dir/agent.json" << EOF
{
    "name": "$agent_name",
    "created": "$(date -Iseconds)",
    "status": "stopped",
    "model": "ollama/llama2",
    "memory": [],
    "tasks": []
}
EOF

    echo -e "${GREEN}Agent '$agent_name' created successfully!${NC}"
    echo "Agent directory: $agent_dir"
}

cmd_list() {
    echo -e "${BLUE}Registered Agents:${NC}"

    if [ ! -d "$AGENTS_DIR" ]; then
        echo "  No agents found. Run '$SCRIPT_NAME init' first."
        exit 0
    fi

    local count=0
    for agent_dir in "$AGENTS_DIR"/*/; do
        if [ -d "$agent_dir" ]; then
            local agent_name=$(basename "$agent_dir")
            local status="unknown"
            local config_file="$agent_dir/agent.json"

            if [ -f "$config_file" ] && command -v jq &> /dev/null; then
                status=$(jq -r '.status // "unknown"' "$config_file" 2>/dev/null || echo "unknown")
            fi

            case "$status" in
                running) echo -e "  ${GREEN}●${NC} $agent_name (running)" ;;
                stopped) echo -e "  ${RED}●${NC} $agent_name (stopped)" ;;
                *) echo -e "  ${YELLOW}●${NC} $agent_name ($status)" ;;
            esac
            count=$((count + 1))
        fi
    done

    if [ $count -eq 0 ]; then
        echo "  No agents found."
    else
        echo ""
        echo "Total: $count agent(s)"
    fi
}

cmd_start() {
    local agent_name="$1"

    if [ -z "$agent_name" ]; then
        echo -e "${RED}Error: Agent name required${NC}"
        echo "Usage: $SCRIPT_NAME start <name>"
        exit 1
    fi

    local agent_dir="$AGENTS_DIR/$agent_name"
    local config_file="$agent_dir/agent.json"

    if [ ! -d "$agent_dir" ]; then
        echo -e "${RED}Error: Agent '$agent_name' not found${NC}"
        exit 1
    fi

    echo -e "${BLUE}Starting agent: $agent_name${NC}"

    # Update status in config (requires jq for proper JSON handling)
    if command -v jq &> /dev/null && [ -f "$config_file" ]; then
        local tmp_file=$(mktemp)
        jq '.status = "running"' "$config_file" > "$tmp_file" && mv "$tmp_file" "$config_file"
    fi

    echo -e "${GREEN}Agent '$agent_name' started${NC}"
}

cmd_stop() {
    local agent_name="$1"

    if [ -z "$agent_name" ]; then
        echo -e "${RED}Error: Agent name required${NC}"
        echo "Usage: $SCRIPT_NAME stop <name>"
        exit 1
    fi

    local agent_dir="$AGENTS_DIR/$agent_name"
    local config_file="$agent_dir/agent.json"

    if [ ! -d "$agent_dir" ]; then
        echo -e "${RED}Error: Agent '$agent_name' not found${NC}"
        exit 1
    fi

    echo -e "${BLUE}Stopping agent: $agent_name${NC}"

    if command -v jq &> /dev/null && [ -f "$config_file" ]; then
        local tmp_file=$(mktemp)
        jq '.status = "stopped"' "$config_file" > "$tmp_file" && mv "$tmp_file" "$config_file"
    fi

    echo -e "${GREEN}Agent '$agent_name' stopped${NC}"
}

cmd_start_swarm() {
    echo -e "${BLUE}Starting agent swarm...${NC}"

    if [ ! -d "$AGENTS_DIR" ]; then
        echo -e "${YELLOW}No agents directory found. Run '$SCRIPT_NAME init' first.${NC}"
        exit 1
    fi

    local count=0
    for agent_dir in "$AGENTS_DIR"/*/; do
        if [ -d "$agent_dir" ]; then
            local agent_name=$(basename "$agent_dir")
            cmd_start "$agent_name"
            count=$((count + 1))
        fi
    done

    if [ $count -eq 0 ]; then
        echo -e "${YELLOW}No agents found to start${NC}"
    else
        echo -e "${GREEN}Started $count agent(s)${NC}"
    fi
}

cmd_stop_swarm() {
    echo -e "${BLUE}Stopping agent swarm...${NC}"

    if [ ! -d "$AGENTS_DIR" ]; then
        echo "No agents to stop."
        exit 0
    fi

    local count=0
    for agent_dir in "$AGENTS_DIR"/*/; do
        if [ -d "$agent_dir" ]; then
            local agent_name=$(basename "$agent_dir")
            cmd_stop "$agent_name"
            count=$((count + 1))
        fi
    done

    if [ $count -eq 0 ]; then
        echo "No agents found to stop"
    else
        echo -e "${GREEN}Stopped $count agent(s)${NC}"
    fi
}

cmd_status() {
    local agent_name="$1"

    if [ -n "$agent_name" ]; then
        # Show specific agent status
        local agent_dir="$AGENTS_DIR/$agent_name"
        local config_file="$agent_dir/agent.json"

        if [ ! -d "$agent_dir" ]; then
            echo -e "${RED}Error: Agent '$agent_name' not found${NC}"
            exit 1
        fi

        echo -e "${BLUE}Agent Status: $agent_name${NC}"

        if [ -f "$config_file" ]; then
            if command -v jq &> /dev/null; then
                jq '.' "$config_file"
            else
                cat "$config_file"
            fi
        else
            echo "  No configuration found"
        fi
    else
        # Show overall status
        print_banner
        echo ""
        echo -e "${BLUE}Framework Status${NC}"
        echo "  Config directory: $CONFIG_DIR"
        echo "  Agents directory: $AGENTS_DIR"
        echo ""
        cmd_list
    fi
}

cmd_version() {
    echo "BlackRoad AI Agent Framework v${VERSION}"
}

# Main entry point
main() {
    local command="${1:-}"
    shift 2>/dev/null || true

    case "$command" in
        init)
            cmd_init "$@"
            ;;
        create)
            cmd_create "$@"
            ;;
        list)
            cmd_list "$@"
            ;;
        start)
            cmd_start "$@"
            ;;
        stop)
            cmd_stop "$@"
            ;;
        start-swarm)
            cmd_start_swarm "$@"
            ;;
        stop-swarm)
            cmd_stop_swarm "$@"
            ;;
        status)
            cmd_status "$@"
            ;;
        version|-v|--version)
            cmd_version
            ;;
        help|-h|--help)
            print_help
            ;;
        "")
            print_banner
            echo ""
            echo "Run '$SCRIPT_NAME help' for usage information."
            ;;
        *)
            echo -e "${RED}Error: Unknown command '$command'${NC}"
            echo "Run '$SCRIPT_NAME help' for usage information."
            exit 1
            ;;
    esac
}

main "$@"
