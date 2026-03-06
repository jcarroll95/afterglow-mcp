


---

## Setup

afterglow-mcp requires Node.js 18+ and works with any MCP-compatible AI tool. No API keys, no accounts, no configuration beyond the snippets below.

### Claude Code

One command. Done.

```bash
claude mcp add afterglow -- npx -y afterglow-mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "afterglow": {
      "command": "npx",
      "args": ["-y", "afterglow-mcp"]
    }
  }
}
```

Restart Cursor.

### Claude Desktop

Add to your config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "afterglow": {
      "command": "npx",
      "args": ["-y", "afterglow-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "afterglow": {
      "command": "npx",
      "args": ["-y", "afterglow-mcp"]
    }
  }
}
```

Click Refresh in the Cascade MCP panel.

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your project:

```json
{
  "mcpServers": {
    "afterglow": {
      "command": "npx",
      "args": ["-y", "afterglow-mcp"]
    }
  }
}
```

### JetBrains IDEs (Junie)

Add to `~/.junie/mcp.json` (global) or `.junie/mcp/mcp.json` (project):

```json
{
  "mcpServers": {
    "afterglow": {
      "command": "npx",
      "args": ["-y", "afterglow-mcp"]
    }
  }
}
```

Verify in **Settings → Tools → Junie → MCP Settings**.

### JetBrains IDEs (AI Assistant)

Go to **Settings → Tools → AI Assistant → Model Context Protocol (MCP)**, click **Add**, and paste:

```json
{
  "mcpServers": {
    "afterglow": {
      "command": "npx",
      "args": ["-y", "afterglow-mcp"]
    }
  }
}
```

### Verify It Works

Once connected, ask your AI assistant:

> "Ping the afterglow server"

You should see a confirmation that afterglow-mcp is running.